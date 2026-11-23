import crypto from 'crypto';
import { withTenant } from '../db/withTenant';
import { getTenantId } from '../context/tenantContext';
// BİLİNÇLİ: reportRegistry.ts'ten DEĞİL, barrel'den ('../reports') import
// edilir — barrel'in side-effect import'ları (definitions/*) rapor
// kataloğunu DOLDURUR. Doğrudan reportRegistry.ts'ten import etmek, bu
// dosyayı routes.ts'i HİÇ yüklemeyen bir süreçte (ör. bu ticket'ın test
// dosyası, tenantDb.ts'i doğrudan import eden NOTIF-1601 testleriyle AYNI
// desen) BOŞ bir katalogla baş başa bırakırdı — canlıda bunu YAKALAYAN
// gerçek bir test hatası bu ticket'ın kendi entegrasyon testinde bulundu.
import { getReportDefinition } from '../reports';
import { streamReportExport } from '../reports/reportEngine';
import { ReportDefinition } from '../reports/reportTypes';
import { sendEmail, deriveHtmlFromText } from '../notifications/emailChannel';
import { UserRole } from '../services/tokenService';
import { generateId } from '../utils/id';
import { writeAuditLog } from '../utils/auditLog';
import { NotFoundError, BadRequestError, ForbiddenError } from '../utils/errors';
import { logger } from '../utils/logger';
import { CreateReportScheduleDTO, UpdateReportScheduleDTO } from '../schemas/reportScheduleSchema';

/**
 * REP-705 (#167) — zamanlanmış rapor gönderimi (cron → e-posta).
 *
 * TEKNİK YIĞIN SAPMASI: ticket "BullMQ repeatable job" öneriyor — bu kod
 * tabanında yok (bkz. ARCH-102, henüz kurulmadı). REP-702/AI-507/NOTIF-1601
 * ile AYNI desen: index.ts'teki düz saatlik `setInterval` süpürücüsü, bu
 * dosyadaki `runReportScheduleSweepForCurrentTenant()`'ı her tenant için
 * çağırır.
 *
 * "Zamanlamalar tenant saat dilimine göre çalışmalıdır" Teknik Notu: bu kod
 * tabanında HİÇBİR YERDE gerçek bir IANA tz veritabanı/kütüphanesi yok —
 * index.ts'teki kota sıfırlama süpürücüsünün "Dönem sınırları Europe/Istanbul
 * (sabit UTC+3)" varsayımıyla AYNI sadeleştirme burada da uygulanıyor
 * (bkz. computeNextRunAt).
 *
 * FORMAT SAPMASI: yalnızca CSV desteklenir (bkz. reportScheduleSchema.ts
 * başındaki not) — REP-701/703'ün Excel/PDF exportları Buffer DEĞİL,
 * Response'a pipe ediyor; e-posta eki için bir Buffer üretici gerekir, bu
 * bu ticket'ın (Efor: S) kapsamı dışında bırakıldı.
 */

const MAX_DELIVERY_ATTEMPTS = 3;
// AC: "10MB üzeri raporlar ek yerine bağlantı olarak gönderilmelidir."
const LARGE_REPORT_THRESHOLD_BYTES = 10 * 1024 * 1024;
// REP-702'nin presigned arşiv linkiyle AYNI süre (tenantArchiveService.ts).
const DOWNLOAD_LINK_TTL_HOURS = 72;
const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000;

export type ReportSchedulePeriod = 'DAILY' | 'WEEKLY' | 'MONTHLY';

/**
 * AC: "Zamanlanan rapor belirlenen periyotta üretilip gönderilmelidir."
 * Tüm hesap "Europe/Istanbul sabit UTC+3" varsayımıyla, gerçek UTC zaman
 * damgasına geri çevrilerek yapılır (bkz. dosya başı notu) — DB'de HER ZAMAN
 * gerçek UTC saklanır, yalnızca "sırası geldi mi" kararı bu ofsetle alınır.
 * Süpürücü gecikirse (ör. bir kesinti sonrası) atlanan dönem GERİYE
 * DOLDURULMAZ — bir sonraki uygun zamana geçilir (çoğu zamanlama sisteminin
 * varsayılan davranışı).
 */
export function computeNextRunAt(
  periodType: ReportSchedulePeriod,
  sendHourLocal: number,
  dayOfWeek: number | null | undefined,
  dayOfMonth: number | null | undefined,
  fromDate: Date = new Date()
): Date {
  const localNow = new Date(fromDate.getTime() + ISTANBUL_OFFSET_MS);
  const candidate = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(), sendHourLocal, 0, 0, 0));

  if (periodType === 'DAILY') {
    if (candidate.getTime() <= localNow.getTime()) candidate.setUTCDate(candidate.getUTCDate() + 1);
  } else if (periodType === 'WEEKLY') {
    const targetDow = dayOfWeek ?? 1;
    const diff = (targetDow - candidate.getUTCDay() + 7) % 7;
    candidate.setUTCDate(candidate.getUTCDate() + diff);
    if (candidate.getTime() <= localNow.getTime()) candidate.setUTCDate(candidate.getUTCDate() + 7);
  } else {
    const targetDom = Math.min(Math.max(dayOfMonth ?? 1, 1), 28);
    candidate.setUTCDate(targetDom);
    if (candidate.getTime() <= localNow.getTime()) candidate.setUTCMonth(candidate.getUTCMonth() + 1, targetDom);
  }

  return new Date(candidate.getTime() - ISTANBUL_OFFSET_MS);
}

async function validateRecipients(client: any, recipientUserIds: string[]): Promise<void> {
  const users = await client.query(`SELECT id, email FROM users WHERE id = ANY($1)`, [recipientUserIds]);
  const foundIds = new Set(users.rows.map((r: any) => r.id));
  const missing = recipientUserIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    throw new BadRequestError('Bazı alıcı kullanıcılar bulunamadı.', { error: 'RECIPIENT_NOT_FOUND', missing });
  }
  const noEmail = users.rows.filter((r: any) => !r.email).map((r: any) => r.id);
  if (noEmail.length > 0) {
    throw new BadRequestError('Bazı alıcı kullanıcıların kayıtlı e-posta adresi yok.', { error: 'RECIPIENT_NO_EMAIL', noEmail });
  }
}

export interface ReportScheduleRecord {
  id: string;
  report_id: string;
  filters: Record<string, string>;
  format: string;
  period_type: ReportSchedulePeriod;
  send_hour_local: number;
  day_of_week: number | null;
  day_of_month: number | null;
  recipient_user_ids: string[];
  skip_if_empty: boolean;
  site_scope: string | null;
  enabled: boolean;
  created_by: string;
  next_run_at: string;
  created_at: string;
  updated_at: string;
}

export async function createReportSchedule(
  input: CreateReportScheduleDTO,
  createdByUserId: string,
  createdByRole: UserRole,
  siteScope: string | undefined
): Promise<ReportScheduleRecord> {
  const def = getReportDefinition(input.reportId);
  if (!def) throw new NotFoundError('Rapor bulunamadı.', { error: 'REPORT_NOT_FOUND' });
  if (!def.allowedRoles.includes(createdByRole)) {
    throw new ForbiddenError('Bu raporu zamanlama yetkiniz yok.', { error: 'REPORT_FORBIDDEN' });
  }

  return withTenant(async (client, tenantId) => {
    await validateRecipients(client, input.recipientUserIds);

    const nextRunAt = computeNextRunAt(input.periodType, input.sendHourLocal, input.dayOfWeek, input.dayOfMonth);
    const id = generateId('repsched');
    const res = await client.query(
      `INSERT INTO report_schedules
         (id, tenant_id, report_id, filters, format, period_type, send_hour_local, day_of_week, day_of_month, recipient_user_ids, skip_if_empty, site_scope, enabled, created_by, next_run_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,TRUE,$13,$14) RETURNING *`,
      [
        id, tenantId, input.reportId, JSON.stringify(input.filters ?? {}), input.format, input.periodType,
        input.sendHourLocal, input.dayOfWeek ?? null, input.dayOfMonth ?? null, input.recipientUserIds,
        input.skipIfEmpty, siteScope ?? null, createdByUserId, nextRunAt
      ]
    );
    await writeAuditLog(client, { action: 'REPORT_SCHEDULE_CREATED', targetType: 'report_schedule', targetId: id, afterValue: { reportId: input.reportId, periodType: input.periodType } });
    return res.rows[0];
  });
}

export async function listReportSchedulesForCurrentTenant(): Promise<ReportScheduleRecord[]> {
  return withTenant(async (client) => {
    const res = await client.query(`SELECT * FROM report_schedules ORDER BY created_at DESC`);
    return res.rows;
  });
}

export async function getReportSchedule(id: string): Promise<ReportScheduleRecord> {
  return withTenant(async (client) => {
    const res = await client.query(`SELECT * FROM report_schedules WHERE id = $1`, [id]);
    if (res.rows.length === 0) throw new NotFoundError('Zamanlama bulunamadı.');
    return res.rows[0];
  });
}

export async function updateReportSchedule(id: string, patch: UpdateReportScheduleDTO): Promise<ReportScheduleRecord> {
  return withTenant(async (client) => {
    const cur = await client.query(`SELECT * FROM report_schedules WHERE id = $1`, [id]);
    if (cur.rows.length === 0) throw new NotFoundError('Zamanlama bulunamadı.');
    const before = cur.rows[0];

    if (patch.recipientUserIds) {
      await validateRecipients(client, patch.recipientUserIds);
    }

    const sendHourLocal = patch.sendHourLocal ?? before.send_hour_local;
    const dayOfWeek = patch.dayOfWeek !== undefined ? patch.dayOfWeek : before.day_of_week;
    const dayOfMonth = patch.dayOfMonth !== undefined ? patch.dayOfMonth : before.day_of_month;
    // Zamanlama parametreleri (saat/gün) değiştiyse next_run_at YENİDEN hesaplanır — aksi halde ESKİ (zaten doğru) değeri korunur.
    const scheduleChanged = patch.sendHourLocal !== undefined || patch.dayOfWeek !== undefined || patch.dayOfMonth !== undefined;
    const nextRunAt = scheduleChanged ? computeNextRunAt(before.period_type, sendHourLocal, dayOfWeek, dayOfMonth) : before.next_run_at;

    const res = await client.query(
      `UPDATE report_schedules SET
         filters = COALESCE($2, filters),
         send_hour_local = $3,
         day_of_week = $4,
         day_of_month = $5,
         recipient_user_ids = COALESCE($6, recipient_user_ids),
         skip_if_empty = COALESCE($7, skip_if_empty),
         enabled = COALESCE($8, enabled),
         next_run_at = $9,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING *`,
      [
        id, patch.filters ? JSON.stringify(patch.filters) : null, sendHourLocal, dayOfWeek, dayOfMonth,
        patch.recipientUserIds ?? null, patch.skipIfEmpty ?? null, patch.enabled ?? null, nextRunAt
      ]
    );
    await writeAuditLog(client, {
      action: 'REPORT_SCHEDULE_UPDATED',
      targetType: 'report_schedule',
      targetId: id,
      beforeValue: { enabled: before.enabled },
      afterValue: { enabled: res.rows[0].enabled }
    });
    return res.rows[0];
  });
}

export async function deleteReportSchedule(id: string): Promise<void> {
  return withTenant(async (client) => {
    const res = await client.query(`DELETE FROM report_schedules WHERE id = $1`, [id]);
    if (res.rowCount === 0) throw new NotFoundError('Zamanlama bulunamadı.');
  });
}

export interface ReportDeliveryRecord {
  id: string;
  status: string;
  attempts: number;
  row_count: number | null;
  delivery_mode: string | null;
  file_size_bytes: number | null;
  expires_at: string | null;
  last_error: string | null;
  sent_at: string | null;
  created_at: string;
}

export async function listReportDeliveriesForSchedule(scheduleId: string): Promise<ReportDeliveryRecord[]> {
  return withTenant(async (client) => {
    const sched = await client.query(`SELECT id FROM report_schedules WHERE id = $1`, [scheduleId]);
    if (sched.rows.length === 0) throw new NotFoundError('Zamanlama bulunamadı.');
    const res = await client.query(
      `SELECT id, status, attempts, row_count, delivery_mode, file_size_bytes, expires_at, last_error, sent_at, created_at
         FROM report_deliveries WHERE schedule_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [scheduleId]
    );
    return res.rows;
  });
}

/**
 * `buildReportCsvBuffer` (csvExport.ts, REP-703/702'de zaten kullanılıyor)
 * yalnızca `Buffer` döner — satır sayısını (AC: "boş rapor" kontrolü için
 * gerekli) DIŞARIYA vermez. O fonksiyonun dönüş tipini değiştirmek
 * tenantArchiveService.ts'in (REP-702) ONA bağımlılığını kırardı; bunun
 * yerine burada KENDİ küçük (satır sayacı EKLENMİŞ) kopyası tutulur —
 * REP-703'ün escape/format mantığıyla AYNI, tek fark rowCount'un da
 * döndürülmesi.
 */
function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function buildScheduledReportCsv(
  def: ReportDefinition,
  filters: Record<string, unknown>,
  siteScope: string | undefined
): Promise<{ buffer: Buffer; rowCount: number }> {
  const lines: string[] = [def.columns.map((c) => csvEscape(c.header)).join(',')];
  let rowCount = 0;
  await streamReportExport(def, filters, siteScope, (rows) => {
    for (const row of rows) {
      lines.push(def.columns.map((c) => csvEscape(c.format ? c.format(row[c.key]) : row[c.key])).join(','));
      rowCount++;
    }
  });
  return { buffer: Buffer.from('﻿' + lines.join('\r\n') + '\r\n', 'utf-8'), rowCount };
}

/**
 * index.ts'teki saatlik süpürücü çağırır (AI-507/NOTIF-1601/REP-702 ile AYNI
 * `runWithTenant({tenantId}, ...)` deseni). AC eşlemesi:
 *  - "Zamanlanan rapor belirlenen periyotta üretilip gönderilmelidir" →
 *    `next_run_at <= NOW()` olan her zamanlama için rapor üretilip gönderilir.
 *  - "Gönderim hataları kayıt altına alınıp yeniden denenmelidir" →
 *    `report_deliveries` (notifications.status/attempts İLE AYNI desen);
 *    `UNIQUE(schedule_id, period_key)` AYNI dönem için TEKRAR bir satır
 *    YARATMAZ — süpürücü VAR OLAN (BEKLIYOR/BAŞARISIZ) satırı yeniden dener.
 *    `next_run_at`, teslim TERMİNAL (GÖNDERILDI/KALICI_BAŞARISIZ/ATLANDI_BOŞ)
 *    olana kadar İLERLEMEZ — bu, retry'ın "aynı dönemi tekrar dener" AC'sini
 *    doğal olarak sağlar (NOTIF-1606'nın "iptal için ayrı bir job yok" ile
 *    AYNI ruh: burada da "retry için ayrı bir kuyruk yok").
 *  - "10MB üzeri raporlar bağlantı olarak gönderilmelidir" → aşağıda.
 *  - "Boş rapor durumunda gönderim yapılmaması seçeneği" → `skip_if_empty`.
 */
export async function runReportScheduleSweepForCurrentTenant(): Promise<{ processed: number; sent: number; failed: number; skippedEmpty: number }> {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('runReportScheduleSweepForCurrentTenant: ambient tenant context yok.');

  const due = await withTenant(async (client) => {
    const res = await client.query(`SELECT * FROM report_schedules WHERE enabled = TRUE AND next_run_at <= NOW()`);
    return res.rows;
  });

  let sent = 0;
  let failed = 0;
  let skippedEmpty = 0;

  for (const schedule of due) {
    const periodKey = new Date(schedule.next_run_at).toISOString();

    const delivery = await withTenant(async (client, tid) => {
      const ins = await client.query(
        `INSERT INTO report_deliveries (id, tenant_id, schedule_id, period_key) VALUES ($1,$2,$3,$4)
         ON CONFLICT (schedule_id, period_key) DO NOTHING RETURNING *`,
        [generateId('repdel'), tid, schedule.id, periodKey]
      );
      if (ins.rows.length > 0) return ins.rows[0];
      const existing = await client.query(`SELECT * FROM report_deliveries WHERE schedule_id = $1 AND period_key = $2`, [schedule.id, periodKey]);
      return existing.rows[0];
    });

    if (['GÖNDERILDI', 'KALICI_BAŞARISIZ', 'ATLANDI_BOŞ'].includes(delivery.status)) {
      await advanceSchedule(schedule);
      continue;
    }
    if (delivery.attempts >= MAX_DELIVERY_ATTEMPTS) {
      await withTenant((client) => client.query(`UPDATE report_deliveries SET status = 'KALICI_BAŞARISIZ' WHERE id = $1`, [delivery.id]));
      await advanceSchedule(schedule);
      failed++;
      continue;
    }

    try {
      const def = getReportDefinition(schedule.report_id);
      if (!def) throw new Error(`REP-705: rapor tanımı bulunamadı: ${schedule.report_id}`);

      const { buffer, rowCount } = await buildScheduledReportCsv(def, schedule.filters, schedule.site_scope ?? undefined);

      if (rowCount === 0 && schedule.skip_if_empty) {
        await withTenant((client) => client.query(`UPDATE report_deliveries SET status = 'ATLANDI_BOŞ', row_count = 0 WHERE id = $1`, [delivery.id]));
        await advanceSchedule(schedule);
        skippedEmpty++;
        continue;
      }

      const recipients = await withTenant(async (client) => {
        const r = await client.query(`SELECT id, email FROM users WHERE id = ANY($1) AND email IS NOT NULL`, [schedule.recipient_user_ids]);
        return r.rows as Array<{ id: string; email: string }>;
      });

      const filenameDate = periodKey.slice(0, 10);
      const filename = `${schedule.report_id}-${filenameDate}.csv`;

      if (buffer.length > LARGE_REPORT_THRESHOLD_BYTES) {
        const token = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const expiresAt = new Date(Date.now() + DOWNLOAD_LINK_TTL_HOURS * 60 * 60 * 1000);
        await withTenant((client) =>
          client.query(
            `UPDATE report_deliveries SET file_data = $2, file_size_bytes = $3, download_token_hash = $4, expires_at = $5, delivery_mode = 'LINK' WHERE id = $1`,
            [delivery.id, buffer, buffer.length, tokenHash, expiresAt]
          )
        );
        const downloadUrl = `/api/v1/report-deliveries/${delivery.id}/download/${token}`;
        const body = `${def.title} raporu hazır (${rowCount} satır). Dosya 10MB sınırını aştığı için ek olarak gönderilemedi. İndirme bağlantısı (${DOWNLOAD_LINK_TTL_HOURS} saat geçerli): ${downloadUrl}`;
        for (const r of recipients) {
          await sendEmail({ to: r.email, subject: `Zamanlanmış Rapor: ${def.title}`, text: body, html: deriveHtmlFromText(body) });
        }
      } else {
        const body = `${def.title} raporu ekte (${rowCount} satır).`;
        for (const r of recipients) {
          await sendEmail({ to: r.email, subject: `Zamanlanmış Rapor: ${def.title}`, text: body, html: deriveHtmlFromText(body), attachments: [{ filename, content: buffer, contentType: 'text/csv' }] });
        }
        await withTenant((client) => client.query(`UPDATE report_deliveries SET delivery_mode = 'ATTACHMENT' WHERE id = $1`, [delivery.id]));
      }

      await withTenant((client) => client.query(`UPDATE report_deliveries SET status = 'GÖNDERILDI', row_count = $2, sent_at = NOW() WHERE id = $1`, [delivery.id, rowCount]));
      await advanceSchedule(schedule);
      sent++;
    } catch (err) {
      await withTenant((client) =>
        client.query(`UPDATE report_deliveries SET status = 'BAŞARISIZ', attempts = attempts + 1, last_error = $2 WHERE id = $1`, [delivery.id, (err as Error).message])
      );
      logger.error({ err, scheduleId: schedule.id, deliveryId: delivery.id }, '🚨 [REP-705] Zamanlanmış rapor gönderimi başarısız, yeniden denenecek.');
      failed++;
    }
  }

  return { processed: due.length, sent, failed, skippedEmpty };
}

async function advanceSchedule(schedule: any): Promise<void> {
  const next = computeNextRunAt(schedule.period_type, schedule.send_hour_local, schedule.day_of_week, schedule.day_of_month);
  await withTenant((client) => client.query(`UPDATE report_schedules SET next_run_at = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [schedule.id, next]));
}

export interface ReportDeliveryDownloadPayload {
  fileData: Buffer;
  fileName: string;
}

/**
 * REP-702'nin `verifyAndConsumeArchiveDownload`'ıyla (tenantArchiveService.ts)
 * BİREBİR AYNI desen: presigned (JWT'siz) indirme, sha256 hash + sabit
 * zamanlı karşılaştırma, süre/durum kontrolü.
 */
export async function verifyAndConsumeReportDeliveryDownload(deliveryId: string, token: string): Promise<ReportDeliveryDownloadPayload> {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  return withTenant(async (client) => {
    const result = await client.query(`SELECT id, file_data, expires_at, download_token_hash FROM report_deliveries WHERE id = $1`, [deliveryId]);
    if (result.rows.length === 0) {
      throw new NotFoundError('Geçersiz veya süresi dolmuş indirme bağlantısı.');
    }
    const row = result.rows[0];

    const expectedHash = Buffer.from(row.download_token_hash ?? '', 'hex');
    const suppliedHash = Buffer.from(tokenHash, 'hex');
    const hashesMatch = expectedHash.length === suppliedHash.length && crypto.timingSafeEqual(expectedHash, suppliedHash);
    if (!hashesMatch || !row.expires_at || new Date(row.expires_at) < new Date()) {
      throw new NotFoundError('Geçersiz veya süresi dolmuş indirme bağlantısı.');
    }
    if (!row.file_data) {
      throw new BadRequestError('Rapor dosyası bulunamadı.');
    }

    await writeAuditLog(client, { action: 'REPORT_DELIVERY_DOWNLOADED', targetType: 'report_delivery', targetId: deliveryId });
    return { fileData: row.file_data as Buffer, fileName: `rapor-${deliveryId}.csv` };
  });
}
