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
