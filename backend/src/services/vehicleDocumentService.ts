import crypto from 'crypto';
import { PoolClient } from 'pg';
import { withTenant } from '../db/withTenant';
import { writeAuditLog } from '../utils/auditLog';
import { addVehicleComplianceDeadline } from '../db/tenantDb';
import { generateId } from '../utils/id';
import { NotFoundError, BadRequestError } from '../utils/errors';
import { logger } from '../utils/logger';

/**
 * FLEET-1409 — Araç Doküman/Ruhsat Arşivi ve Son Kullanma Uyarıları.
 *
 * Ticket "presigned URL + obje depolama" öneriyor — bu ortamda S3/obje
 * deposu yok (COMP-602.1'deki aynı boşluk). Dosya doğrudan Postgres'te
 * BYTEA olarak saklanıyor; 10MB sınırı burada (base64 decode SONRASI,
 * gerçek bayt uzunluğu üzerinden) uygulanıyor.
 *
 * "presigned URL ile indirilebilmelidir" AC'si REP-702'nin (tenant_archives)
 * AYNI deseniyle karşılanıyor: `generateVehicleDocumentDownloadLink` ham bir
 * token üretir, yalnızca SHA-256 hash'ini saklar (passwordResetService.ts'teki
 * "token ham saklanmaz" ilkesiyle aynı); `GET /vehicle-documents/:id/download/:token`
 * (routes.ts) JWT GEREKTİRMEZ — gerçek bir "bağlantıyı bilen indirir" presigned
 * link semantiği. Süre: 24 saat (REP-702'nin 72 saatinden KISA — belgeler
 * kişisel/ticari veri, tek seferlik paylaşım amaçlı daha dar bir pencere
 * tercih edildi). Tek aktif token/belge; JWT'li `/content` ucu (önizleme,
 * uygulama İÇİNDEN erişim için) AYRICA duruyor, kaldırılmadı.
 *
 * "FLEET-1408 ile koordineli" AC'si: document_type FLEET-1408'in izlediği
 * üç türden (MUAYENE/EGZOZ/SİGORTA) birine karşılık geliyorsa VE bir
 * expiryDate verilmişse, tenantDb.ts'teki (FLEET-1408, IMPORT-ONLY —
 * düzenlenmiyor) `addVehicleComplianceDeadline` ÇAĞRILIR — böylece FLEET-1408'in
 * ZATEN VAR OLAN süpürücüsü/alarmı bu belgeyi otomatik yakalar, ayrı bir
 * alarm mekanizması KURULMAZ (tek doğruluk kaynağı: vehicle_compliance_deadlines).
 */

export type VehicleDocumentType = 'RUHSAT' | 'MUAYENE_RAPORU' | 'EGZOZ_RAPORU' | 'SIGORTA_POLICESI' | 'DIGER';

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

const COMPLIANCE_DEADLINE_TYPE_MAP: Partial<Record<VehicleDocumentType, string>> = {
  MUAYENE_RAPORU: 'MUAYENE',
  EGZOZ_RAPORU: 'EGZOZ',
  SIGORTA_POLICESI: 'SİGORTA'
};

export interface VehicleDocumentMeta {
  id: string;
  vehicleId: string;
  vehiclePlate: string;
  documentType: VehicleDocumentType;
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
  expiryDate: string | null;
  uploadedBy: string;
  uploadedAt: string;
  isCurrent: boolean;
  daysUntilExpiry: number | null;
  isExpired: boolean;
  isExpiringSoon: boolean; // <= 30 gün
}

export interface VehicleDocumentContent {
  fileName: string;
  mimeType: string;
  fileContent: Buffer;
}

function computeExpiryStatus(expiryDate: string | null): { daysUntilExpiry: number | null; isExpired: boolean; isExpiringSoon: boolean } {
  if (!expiryDate) return { daysUntilExpiry: null, isExpired: false, isExpiringSoon: false };
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const expiry = new Date(`${expiryDate}T00:00:00.000Z`).getTime();
  const daysUntilExpiry = Math.round((expiry - todayUtc) / (24 * 60 * 60 * 1000));
  return { daysUntilExpiry, isExpired: daysUntilExpiry < 0, isExpiringSoon: daysUntilExpiry >= 0 && daysUntilExpiry <= 30 };
}

function mapMetaRow(row: any, isCurrent: boolean): VehicleDocumentMeta {
  const expiryDate = row.expiry_date instanceof Date ? row.expiry_date.toISOString().slice(0, 10) : row.expiry_date;
  return {
    id: row.id,
    vehicleId: row.vehicle_id,
    vehiclePlate: row.vehicle_plate,
    documentType: row.document_type,
    fileName: row.file_name,
    mimeType: row.mime_type,
    fileSizeBytes: row.file_size_bytes,
    expiryDate,
    uploadedBy: row.uploaded_by,
    uploadedAt: row.uploaded_at,
    isCurrent,
    ...computeExpiryStatus(expiryDate)
  };
}

export async function uploadVehicleDocument(
  vehicleId: string,
  data: {
    documentType: VehicleDocumentType;
    fileName: string;
    mimeType: string;
    fileContentBase64: string;
    expiryDate?: string;
  },
  byUserId: string
): Promise<VehicleDocumentMeta> {
  let fileBuffer: Buffer;
  try {
    fileBuffer = Buffer.from(data.fileContentBase64, 'base64');
  } catch {
    throw new BadRequestError('fileContentBase64 geçerli bir base64 dizesi değil.');
  }
  if (fileBuffer.length === 0) throw new BadRequestError('Dosya içeriği boş olamaz.');
  if (fileBuffer.length > MAX_FILE_SIZE_BYTES) {
    throw new BadRequestError(`Dosya boyutu 10MB sınırını aşıyor (${(fileBuffer.length / 1024 / 1024).toFixed(2)}MB).`);
  }

  const meta = await withTenant(async (client: PoolClient, tenantId: string) => {
    const vRes = await client.query('SELECT id, plate FROM vehicles WHERE id = $1', [vehicleId]);
    if (vRes.rows.length === 0) throw new NotFoundError('Araç bulunamadı.', { error: 'VEHICLE_NOT_FOUND' });
    const plate = vRes.rows[0].plate;

    const id = generateId('vdoc');
    const inserted = await client.query(
      `INSERT INTO vehicle_documents
         (id, tenant_id, vehicle_id, vehicle_plate, document_type, file_name, mime_type, file_size_bytes, file_content, expiry_date, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, vehicle_id, vehicle_plate, document_type, file_name, mime_type, file_size_bytes, expiry_date, uploaded_by, uploaded_at`,
      [id, tenantId, vehicleId, plate, data.documentType, data.fileName, data.mimeType, fileBuffer.length, fileBuffer, data.expiryDate ?? null, byUserId]
    );

    await writeAuditLog(client, {
      action: 'VEHICLE_DOCUMENT_UPLOADED',
      targetType: 'vehicle_document',
      targetId: id,
      afterValue: { vehicleId, documentType: data.documentType, fileName: data.fileName, expiryDate: data.expiryDate ?? null }
    });

    return mapMetaRow(inserted.rows[0], true);
  });

  // FLEET-1408 entegrasyonu — ayrı bir withTenant() DIŞINDA, aynı ambient
  // tenant context'i üzerinden (authenticateJWT'nin kurduğu) çağrılıyor;
  // addVehicleComplianceDeadline kendi withTenant()'ını zaten açıyor.
  const deadlineType = COMPLIANCE_DEADLINE_TYPE_MAP[data.documentType];
  if (deadlineType && data.expiryDate) {
    try {
      await addVehicleComplianceDeadline(
        vehicleId,
        { deadlineType, issuedAt: new Date().toISOString().slice(0, 10), dueDate: data.expiryDate, note: `Belge: ${data.fileName}` },
        byUserId
      );
    } catch (err) {
      // Belge YÜKLENDİ — FLEET-1408 entegrasyonunun başarısız olması
      // yüklemeyi GERİ ALMAMALI, yalnızca loglanır.
      logger.warn({ err, vehicleId, documentType: data.documentType }, '⚠️ [FLEET-1409] Uyum takvimi (FLEET-1408) güncellenemedi.');
    }
  }

  return meta;
}

export async function getVehicleDocuments(vehicleId: string): Promise<VehicleDocumentMeta[]> {
  return withTenant(async (client, tenantId) => {
    const vRes = await client.query('SELECT id FROM vehicles WHERE id = $1', [vehicleId]);
    if (vRes.rows.length === 0) throw new NotFoundError('Araç bulunamadı.', { error: 'VEHICLE_NOT_FOUND' });

    const res = await client.query(
      `SELECT id, vehicle_id, vehicle_plate, document_type, file_name, mime_type, file_size_bytes, expiry_date, uploaded_by, uploaded_at
         FROM vehicle_documents WHERE tenant_id = $1 AND vehicle_id = $2 ORDER BY document_type ASC, uploaded_at DESC`,
      [tenantId, vehicleId]
    );

    const latestSeenPerType = new Set<string>();
    return res.rows.map((row) => {
      const isCurrent = !latestSeenPerType.has(row.document_type);
      latestSeenPerType.add(row.document_type);
      return mapMetaRow(row, isCurrent);
    });
  });
}

/** İndirme/önizleme — audit_logs'a VEHICLE_DOCUMENT_DOWNLOADED olarak yazar (AC: "indirme audit'i"). */
export async function getVehicleDocumentContent(documentId: string, byUserId: string): Promise<VehicleDocumentContent> {
  return withTenant(async (client, tenantId) => {
    const res = await client.query(
      'SELECT vehicle_id, file_name, mime_type, file_content FROM vehicle_documents WHERE tenant_id = $1 AND id = $2',
      [tenantId, documentId]
    );
    if (res.rows.length === 0) throw new NotFoundError('Belge bulunamadı.');
    const row = res.rows[0];

    await writeAuditLog(client, {
      action: 'VEHICLE_DOCUMENT_DOWNLOADED',
      targetType: 'vehicle_document',
      targetId: documentId,
      afterValue: { vehicleId: row.vehicle_id, byUserId }
    });

    return { fileName: row.file_name, mimeType: row.mime_type, fileContent: row.file_content };
  });
}

const DOWNLOAD_LINK_TTL_HOURS = 24;

export interface VehicleDocumentDownloadLink {
  documentId: string;
  token: string;
  expiresAt: string;
}

/**
 * AC: "Belgeler ... presigned URL ile indirilebilmelidir." Token durumu
 * `vehicle_documents`'a DEĞİL, AYRI bir tabloya (vehicle_document_download_links)
 * yazılır — vehicle_documents DB seviyesinde immutable'dır (REVOKE UPDATE,
 * bkz. schema.sql yorumu); ilk sürüm buna yanlışlıkla UPDATE atmaya çalışıp
 * canlı "permission denied" ile yakalandı. Yeni bir bağlantı istemek ESKİ
 * token'ı ANINDA geçersiz kılar (ON CONFLICT DO UPDATE — tek aktif token).
 * Ham token yalnızca DÖNÜŞ DEĞERİNDE bulunur.
 */
export async function generateVehicleDocumentDownloadLink(documentId: string, byUserId: string): Promise<VehicleDocumentDownloadLink> {
  return withTenant(async (client, tenantId) => {
    const docRes = await client.query('SELECT vehicle_id FROM vehicle_documents WHERE tenant_id = $1 AND id = $2', [tenantId, documentId]);
    if (docRes.rows.length === 0) throw new NotFoundError('Belge bulunamadı.');

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + DOWNLOAD_LINK_TTL_HOURS * 60 * 60 * 1000);

    await client.query(
      `INSERT INTO vehicle_document_download_links (document_id, tenant_id, download_token_hash, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (document_id) DO UPDATE SET download_token_hash = EXCLUDED.download_token_hash, expires_at = EXCLUDED.expires_at, created_at = CURRENT_TIMESTAMP`,
      [documentId, tenantId, tokenHash, expiresAt]
    );

    await writeAuditLog(client, {
      action: 'VEHICLE_DOCUMENT_DOWNLOAD_LINK_CREATED',
      targetType: 'vehicle_document',
      targetId: documentId,
      afterValue: { vehicleId: docRes.rows[0].vehicle_id, byUserId, expiresAt: expiresAt.toISOString() }
    });

    return { documentId, token, expiresAt: expiresAt.toISOString() };
  });
}

/**
 * Presigned indirme doğrulaması — routes.ts'in pre-auth login/refresh
 * deseniyle AYNI gerekçeyle (JWT henüz yok) önce ham bir sorguyla tenant
 * öğrenilir (routes.ts, check-no-raw-pool-query.mjs allowlist'inde), SONRA
 * bu fonksiyon `runWithTenant` içinde çağrılır — token hash + süre kontrolü
 * ve audit yazımı RLS altında yapılır (REP-702'nin verifyAndConsumeArchiveDownload'ıyla
 * BİREBİR aynı desen).
 */
export async function verifyAndConsumeVehicleDocumentDownload(documentId: string, token: string): Promise<VehicleDocumentContent> {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  return withTenant(async (client) => {
    const result = await client.query(
      `SELECT d.vehicle_id, d.file_name, d.mime_type, d.file_content, l.download_token_hash, l.expires_at
       FROM vehicle_documents d
       LEFT JOIN vehicle_document_download_links l ON l.document_id = d.id
       WHERE d.id = $1`,
      [documentId]
    );
    if (result.rows.length === 0) throw new NotFoundError('Geçersiz veya süresi dolmuş indirme bağlantısı.');
    const row = result.rows[0];

    const expectedHash = row.download_token_hash ? Buffer.from(row.download_token_hash, 'hex') : null;
    const suppliedHash = Buffer.from(tokenHash, 'hex');
    const hashesMatch = !!expectedHash && expectedHash.length === suppliedHash.length && crypto.timingSafeEqual(expectedHash, suppliedHash);
    if (!hashesMatch || !row.expires_at || new Date(row.expires_at) < new Date()) {
      throw new NotFoundError('Geçersiz veya süresi dolmuş indirme bağlantısı.');
    }

    await writeAuditLog(client, {
      action: 'VEHICLE_DOCUMENT_DOWNLOADED',
      targetType: 'vehicle_document',
      targetId: documentId,
      afterValue: { vehicleId: row.vehicle_id, via: 'presigned-link' }
    });

    return { fileName: row.file_name, mimeType: row.mime_type, fileContent: row.file_content };
  });
}
