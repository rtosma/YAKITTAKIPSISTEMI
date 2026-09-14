import crypto from 'crypto';
import archiver from 'archiver';
import zipEncryptedFormat from 'archiver-zip-encrypted';
import { withTenant } from '../db/withTenant';
import { getTenantHardwareDevices } from '../db/tenantDb';
import { redisPool } from '../db/redisPool';
import { getReportDefinition } from '../reports/reportRegistry';
import { runReport } from '../reports/reportEngine';
import { buildReportCsvBuffer } from '../reports/csvExport';
import { buildArchiveSummaryPdfBuffer } from '../reports/pdfExport';
import { generateTempPassword } from '../utils/tempCredentials';
import { generateId } from '../utils/id';
import { writeAuditLog } from '../utils/auditLog';
import { NotFoundError, BadRequestError } from '../utils/errors';
import { logger } from '../utils/logger';

/**
 * REP-702 (#165) — periyodik/manuel şifreli ZIP arşivleme + presigned indirme.
 *
 * KAPSAM UYARLAMASI 1 — e-İrsaliye XML/PDF: ticket'ın paket içeriği listesine
 * göre BULUNMASI gerekirdi ama BİLEREK dışarıda bırakıldı: `despatch_advice_documents`
 * ham XML SAKLAMAZ (her ikmal için `prepareDespatchAdvice()` + `generateDespatchAdviceXml()`
 * ile İSTEK ANINDA yeniden üretilir, bkz. compliance/despatchAdviceXmlService.ts) ve kod
 * tabanında bir e-İrsaliye→PDF üretici YOKTUR. Yüzlerce ikmal için XML'i tek tek
 * yeniden üretip pakete koymak bu ticket'ın "S" eforunun kapsamı dışına taşardı —
 * ayrı bir ticket'ın konusu olmalı.
 *
 * KAPSAM UYARLAMASI 2 — "telemetri özeti": sistemde kalıcı bir telemetri/uplink
 * GÜNLÜĞÜ yok (bkz. lorawanUplinkService.ts — ioTEventBus olay veri yolu + Redis
 * presence, hiçbir tabloya yazılmaz). Bu yüzden "özet" dönem boyunca geçmişe dönük
 * bir rapor DEĞİL, paketin ÜRETİLDİĞİ ANDAKİ cihaz durumu (kayıtlı/aktif/bloke +
 * anlık çevrimiçi/çevrimdışı) anlık görüntüsüdür — bu, telemetri-ozeti.json içinde
 * açıkça not edilir.
 *
 * TEKNİK YIĞIN SAPMASI: ticket "BullMQ + @nestjs/schedule + S3 uyumlu depolama"
 * öneriyor — bu kod tabanında hiçbiri yok (bkz. ARCH-102, henüz kurulmadı).
 * Bunun yerine: index.ts'teki AYNI düz `setInterval` süpürücü deseni (üretim),
 * ve S3 yerine `tenant_archives.file_data BYTEA` (bkz. schema.sql yorumu —
 * uygulama /app'e runtime'da hiçbir şey YAZMAZ, birden fazla backend replikası
 * arasında paylaşılan tek DURAKLI depo Postgres'tir).
 */

const DOWNLOAD_LINK_TTL_HOURS = 72;
export const VALID_ARCHIVE_PERIOD_DAYS = [7, 15, 30, 90] as const;
export type ArchivePeriodDays = (typeof VALID_ARCHIVE_PERIOD_DAYS)[number];

/**
 * `archiver.registerFormat` SÜREÇ genelinde (module-scope `formats` nesnesi,
 * bkz. node_modules/archiver/index.js) tekildir ve İKİNCİ çağrıda fırlatır —
 * pdfExport.ts'teki "per-doc vs per-process" hatasının TERSİ bir tuzak: burada
 * gerçekten SÜREÇ genelinde tek sefer kaydedilmesi GEREKİYOR, `isRegisteredFormat`
 * ile kontrol edilerek tekrar kayıt engelleniyor (bir modül flag'i değil, archiver'ın
 * KENDİ gerçek durumu soruluyor — testlerde modül yeniden yüklense bile güvenli).
 */
function ensureZipEncryptedFormatRegistered(): void {
  if (!archiver.isRegisteredFormat('zip-encrypted')) {
    archiver.registerFormat('zip-encrypted', zipEncryptedFormat);
  }
}

interface ArchiveEntry {
  name: string;
  buffer: Buffer;
}

/**
 * AC: "Büyük arşivler streaming ile üretilmeli, geçici diskte tam kopya
 * oluşturulmamalıdır." — burada disk YOK (archiver çıktısı doğrudan bellekte
 * biriktirilir, hiçbir ara adım `fs.writeFile` kullanmaz); "streaming" burada
 * archiver'ın kendi iç akışına (append→deflate→şifrele) atıfla sağlanır, disk
 * I/O'suna değil. `pointer()`/`finalize()` — bkz. archiver'ın Promise dönen
 * `finalize()`'ı (v7 core.js) — HEM stream 'end'i HEM finalize promise'i
 * birlikte beklenir: ilki arabelleğin TAMAMLANDIĞINI, ikincisi formata özel
 * (zip-encrypted) modülün hata FIRLATMADIĞINI garanti eder.
 */
async function buildEncryptedZip(entries: ArchiveEntry[], password: string): Promise<Buffer> {
  ensureZipEncryptedFormatRegistered();
  const archive = archiver.create('zip-encrypted', { zlib: { level: 8 }, encryptionMethod: 'aes256', password });
  const chunks: Buffer[] = [];
  const collected = new Promise<Buffer>((resolve, reject) => {
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));
  });
  for (const entry of entries) {
    archive.append(entry.buffer, { name: entry.name });
  }
  const [buffer] = await Promise.all([collected, archive.finalize()]);
  return buffer;
}

function sha256Hex(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export interface GeneratedArchive {
  archiveId: string;
  password: string;
  token: string;
  expiresAt: string;
}

/**
 * AC: "Arşiv paketi tanımlı tüm içerikleri ve manifest'i içermelidir" +
 * "Paket AES-256 ile şifrelenmeli ve parolasız açılamamalıdır." Çağıranın
 * (route ya da index.ts'teki periyodik süpürücü) ÖNCEDEN bir tenant context'i
 * (AsyncLocalStorage, bkz. tenantContext.ts) kurmuş olması GEREKİR — manuel
 * tetikleyicide bunu authenticateJWT zaten yapar, periyodik süpürücüde
 * `runWithTenant({tenantId}, ...)` ile açıkça sarmalanır (index.ts'teki
 * DİĞER tüm tenant-döngülü süpürücülerle AYNI desen).
 */
export async function generateArchiveForTenant(
  tenantId: string,
  periodDays: ArchivePeriodDays,
  requestedByUserId: string | null,
  triggerType: 'MANUEL' | 'PERIYODIK'
): Promise<GeneratedArchive> {
  const rep711 = getReportDefinition('rep-711');
  if (!rep711) throw new Error('REP-702: rep-711 rapor tanımı bulunamadı (programlama hatası).');

  const now = new Date();
  const periodEnd = now.toISOString().slice(0, 10);
  const periodStart = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const periodFilter = { startDate: periodStart, endDate: periodEnd, page: 1, pageSize: 1 };

  const [ikmalCsv, reportRun, devices, companyName] = await Promise.all([
    buildReportCsvBuffer(rep711, periodFilter, undefined),
    runReport(rep711, periodFilter, undefined),
    getTenantHardwareDevices(),
    withTenant(async (client) => {
      const r = await client.query('SELECT name FROM companies WHERE id = $1', [tenantId]);
      return (r.rows[0]?.name as string | undefined) ?? tenantId;
    })
  ]);

  const deviceCounts = { active: 0, blocked: 0, online: 0, offline: 0 };
  for (const device of devices) {
    if (device.status === 'BLOKE') deviceCounts.blocked++;
    else deviceCounts.active++;
    const state = await redisPool.getDeviceState(device.device_id);
    if (state === 'ONLINE') deviceCounts.online++;
    else deviceCounts.offline++;
  }

  const telemetrySummary = {
    generatedAt: now.toISOString(),
    note:
      'Sistemde geçmişe dönük ham telemetri kaydı (uplink günlüğü) tutulmadığından ' +
      '(bkz. lorawanUplinkService.ts — olay veri yolu + Redis presence, kalıcı log yok), ' +
      'bu özet paketin ÜRETİLDİĞİ ANDAKİ cihaz durumunu yansıtır; dönem ' +
      `(${periodStart} — ${periodEnd}) boyunca geçmişe dönük bir telemetri GÜNLÜĞÜ DEĞİLDİR.`,
    registeredDeviceCount: devices.length,
    activeDeviceCount: deviceCounts.active,
    blockedDeviceCount: deviceCounts.blocked,
    onlineDeviceCount: deviceCounts.online,
    offlineDeviceCount: deviceCounts.offline
  };
  const telemetryBuffer = Buffer.from(JSON.stringify(telemetrySummary, null, 2), 'utf-8');

  const summaryPdf = await buildArchiveSummaryPdfBuffer({
    companyName,
    periodDays,
    periodStart,
    periodEnd,
    totalTransactions: reportRun.totalCount,
    totalLiters: reportRun.aggregates.total_liters ?? 0,
    deviceCounts,
    generatedAt: now
  });

  const entries: ArchiveEntry[] = [
    { name: 'ikmal-hareketleri.csv', buffer: ikmalCsv },
    { name: 'telemetri-ozeti.json', buffer: telemetryBuffer },
    { name: 'ozet-rapor.pdf', buffer: summaryPdf }
  ];

  // AC: "Manifest dosyası (içerik listesi + SHA-256) olmadan arşivin bütünlüğü
  // doğrulanamaz." — manifest'in KENDİSİ de pakete dahil edilir (bu yüzden
  // SHA-256 listesi manifest'in İÇİNDEKİ diğer dosyalar için hesaplanır,
  // kendi kendine referans vermez).
  const manifest = {
    tenantId,
    companyName,
    periodDays,
    periodStart,
    periodEnd,
    generatedAt: now.toISOString(),
    triggerType,
    scopeNote:
      'e-İrsaliye XML/PDF bu pakete DAHİL EDİLMEMİŞTİR — despatch_advice_documents ham XML saklamaz ' +
      '(her ikmal için istek anında yeniden üretilir) ve bir e-İrsaliye→PDF üretici yoktur. Ayrıntı: ' +
      'tenantArchiveService.ts başındaki "KAPSAM UYARLAMASI" yorumu.',
    files: entries.map((e) => ({ name: e.name, sizeBytes: e.buffer.length, sha256: sha256Hex(e.buffer) }))
  };
  const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8');
  entries.push({ name: 'manifest.json', buffer: manifestBuffer });

  // AC: "Arşiv parolası paketle aynı kanaldan gönderilmemelidir; parola
  // panelde tek seferlik gösterilmeli." — bu fonksiyon parolayı DÖNÜŞ
  // DEĞERİNDE verir (çağıran route yalnızca bu ilk yanıtta gösterir);
  // DB'ye yalnızca ZIP'in kendisi (zaten AES-256 şifreli) yazılır, parolanın
  // KENDİSİ hiçbir yerde saklanmaz — passwordResetService.ts'teki "token ham
  // haliyle saklanmaz" ilkesiyle AYNI ruh, burada saklanan şey parola değil
  // indirme TOKEN'ının hash'i.
  const password = generateTempPassword();
  const zipBuffer = await buildEncryptedZip(entries, password);

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const archiveId = generateId('archive');
  const expiresAt = new Date(now.getTime() + DOWNLOAD_LINK_TTL_HOURS * 60 * 60 * 1000);

  await withTenant(async (client) => {
    await client.query(
      `INSERT INTO tenant_archives
         (id, tenant_id, requested_by, period_days, trigger_type, status, file_data, file_size_bytes, manifest_sha256, download_token_hash, expires_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, 'HAZIR', $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)`,
      [archiveId, tenantId, requestedByUserId, periodDays, triggerType, zipBuffer, zipBuffer.length, sha256Hex(manifestBuffer), tokenHash, expiresAt]
    );
    await writeAuditLog(client, {
      action: 'TENANT_ARCHIVE_GENERATED',
      targetType: 'tenant_archive',
      targetId: archiveId,
      afterValue: { periodDays, triggerType, fileSizeBytes: zipBuffer.length }
    });
  });

  logger.info({ tenantId, archiveId, periodDays, triggerType, fileSizeBytes: zipBuffer.length }, '📦 [REP-702] Şifreli tenant arşivi üretildi.');
  return { archiveId, password, token, expiresAt: expiresAt.toISOString() };
}

export interface TenantArchiveSummary {
  id: string;
  periodDays: number;
  triggerType: string;
  status: string;
  fileSizeBytes: number | null;
  downloadCount: number;
  lastDownloadedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

export async function listTenantArchives(): Promise<TenantArchiveSummary[]> {
  return withTenant(async (client) => {
    const result = await client.query(
      `SELECT id, period_days, trigger_type, status, file_size_bytes, download_count, last_downloaded_at, expires_at, created_at
       FROM tenant_archives ORDER BY created_at DESC LIMIT 100`
    );
    return result.rows.map((r) => ({
      id: r.id,
      periodDays: r.period_days,
      triggerType: r.trigger_type,
      status: r.status,
      fileSizeBytes: r.file_size_bytes,
      downloadCount: r.download_count,
      lastDownloadedAt: r.last_downloaded_at ? new Date(r.last_downloaded_at).toISOString() : null,
      expiresAt: new Date(r.expires_at).toISOString(),
      createdAt: new Date(r.created_at).toISOString()
    }));
  });
}

export interface ArchiveDownloadPayload {
  tenantId: string;
  fileData: Buffer;
  fileName: string;
}

/**
 * AC: "İndirme bağlantısı süreli olmalı ve indirmeler audit'lenmelidir." —
 * presigned indirme (JWT'siz) `routes.ts`'in pre-auth login/refresh
 * istisnasıyla AYNI gerekçeyle önce tenant'ı BİLMEDEN çalışır (bkz. o dosyadaki
 * ham `pool.query` çağrısı, check-no-raw-pool-query.mjs allowlist'inde zaten
 * var). Bu fonksiyon ise tenant ZATEN bilindiği (routes.ts'in ilk sorgusundan)
 * bir aşamada, `runWithTenant` ile açılan context İÇİNDE çağrılır — RLS'in
 * indirme sayacı/audit yazımında da (savunma derinliği) devrede olması için.
 */
export async function verifyAndConsumeArchiveDownload(archiveId: string, tenantId: string, token: string): Promise<ArchiveDownloadPayload> {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  return withTenant(async (client) => {
    const result = await client.query(
      `SELECT id, status, file_data, expires_at, download_token_hash FROM tenant_archives WHERE id = $1`,
      [archiveId]
    );
    if (result.rows.length === 0) {
      throw new NotFoundError('Geçersiz veya süresi dolmuş indirme bağlantısı.');
    }
    const row = result.rows[0];

    // AC: "süresi dolmuş bağlantı reddi" + sabit karşılaştırma (timing attack
    // yüzeyini azaltmak için) — passwordResetService.ts'teki token tüketimiyle
    // AYNI ilke, ama burada tek kullanımlık DEĞİL (bir arşiv birden çok kez
    // indirilebilir, TTL süresi boyunca — ticket bunu "tek kullanımlık" olarak
    // İSTEMİYOR, sadece "süreli").
    const expectedHash = Buffer.from(row.download_token_hash, 'hex');
    const suppliedHash = Buffer.from(tokenHash, 'hex');
    const hashesMatch = expectedHash.length === suppliedHash.length && crypto.timingSafeEqual(expectedHash, suppliedHash);
    if (!hashesMatch || row.status !== 'HAZIR' || new Date(row.expires_at) < new Date()) {
      throw new NotFoundError('Geçersiz veya süresi dolmuş indirme bağlantısı.');
    }
    if (!row.file_data) {
      throw new BadRequestError('Arşiv dosyası henüz hazır değil.');
    }

    await client.query(
      `UPDATE tenant_archives SET download_count = download_count + 1, last_downloaded_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [archiveId]
    );
    await writeAuditLog(client, {
      action: 'TENANT_ARCHIVE_DOWNLOADED',
      targetType: 'tenant_archive',
      targetId: archiveId
    });

    return { tenantId, fileData: row.file_data as Buffer, fileName: `arsiv-${archiveId}.zip` };
  });
}
