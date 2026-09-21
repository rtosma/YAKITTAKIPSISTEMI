import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { pool } from '../db/postgresPool';
import { generateId } from '../utils/id';
import { BadRequestError, ConflictError, NotFoundError } from '../utils/errors';
import { logger } from '../utils/logger';
import { ANONYMIZABLE_CLASSES } from '../retention/retentionCatalog';
import { loadOverrides } from './retentionService';
import { NAME_REFERENCE_COLUMNS, TEXT_REFERENCE_COLUMNS } from '../privacy/piiInventory';

/**
 * COMP-606 (#132) — veri sahibi başvurusu (erişim/silme) akışı + kişisel veri anonimleştirme.
 *
 * Ham `pool` (yönetim bağlantısı) kullanır ve check-no-raw-pool-query allowlist'indedir — retentionService.ts ile AYNI
 * gerekçe: anonimleştirme birçok tabloyu (mali `transactions` dahil) ve tüm tenant'ları kapsayan bir bakım turudur; uygulama
 * rolünün (app_user) transactions'ta UPDATE'i olabilir ama tenant-dışı/toplu bakım için yönetim bağlantısı gerekir.
 * Tüm SQL tablo/sütun adları piiInventory.ts'teki SABİT listelerden gelir; dış girdi yalnızca değer parametresidir.
 *
 * MALİ BÜTÜNLÜK: ikmal kaydının değişmezlik mührü (hash_signature) `id|tenant|plaka|litre|anahtar` üzerindendir — şoför adı
 * mühre GİRMEZ; bu yüzden ad değişimi mührü bozmaz. Tutar, plaka, tarih, tank, maliyet DEĞİŞMEZ (testte hesaplanır).
 *
 * AD ÇAKIŞMASI: şoför adı diğer tablolarda FK'siz metindir. Aynı adı taşıyan BAŞKA bir kişi (sürücü/personel) varsa metin
 * sütunları YENİDEN YAZILMAZ (yanlış kişinin kaydı bozulmasın / yanlış kişinin verisi ifşa olmasın) — sonuçta
 * `nameBasedDataSkipped: true` raporlanır ve elle inceleme gerekir.
 */

export type SubjectType = 'DRIVER' | 'PERSONNEL';
export const DSR_RESPONSE_DAYS = 30; // KVKK m.13 — başvuru en geç 30 gün içinde sonuçlandırılır.
const EXPORT_RECORD_CAP = 1000;

interface SubjectRows {
  driver: any | null;
  personnel: any[];
  names: string[];
  primaryId: string;
}

function sha(value: string, len: number): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, len);
}

async function loadSubject(db: Pick<PoolClient, 'query'>, tenantId: string, subjectType: SubjectType, subjectId: string, forUpdate = false): Promise<SubjectRows> {
  const lock = forUpdate ? ' FOR UPDATE' : '';
  let driver: any | null = null;
  let personnel: any[] = [];
  if (subjectType === 'DRIVER') {
    const d = await db.query(`SELECT * FROM drivers WHERE tenant_id = $1 AND id = $2${lock}`, [tenantId, subjectId]);
    driver = d.rows[0] ?? null;
    if (!driver) throw new NotFoundError('Şoför bulunamadı.');
    personnel = (await db.query(`SELECT * FROM personnel WHERE tenant_id = $1 AND driver_id = $2${lock}`, [tenantId, subjectId])).rows;
  } else {
    const p = await db.query(`SELECT * FROM personnel WHERE tenant_id = $1 AND id = $2${lock}`, [tenantId, subjectId]);
    if (p.rows.length === 0) throw new NotFoundError('Personel bulunamadı.');
    personnel = p.rows;
    if (p.rows[0].driver_id) driver = (await db.query(`SELECT * FROM drivers WHERE tenant_id = $1 AND id = $2${lock}`, [tenantId, p.rows[0].driver_id])).rows[0] ?? null;
  }
  const names = [...new Set([driver?.name, ...personnel.map((p) => p.full_name)].filter((n): n is string => !!n && !n.startsWith('Anonim ')))];
  return { driver, personnel, names, primaryId: driver?.id ?? personnel[0].id };
}

/** Aynı adı taşıyan, konuya AİT OLMAYAN ve henüz anonimleştirilmemiş başka bir sürücü/personel var mı? */
async function nameCollides(db: Pick<PoolClient, 'query'>, tenantId: string, s: SubjectRows, scopeRecords: { driverIds: string[]; personnelIds: string[] }): Promise<boolean> {
  if (s.names.length === 0) return false;
  const lowered = s.names.map((n) => n.trim().toLowerCase());
  const d = await db.query(
    `SELECT 1 FROM drivers WHERE tenant_id = $1 AND anonymized_at IS NULL AND lower(trim(name)) = ANY($2::text[]) AND NOT (id = ANY($3::text[])) LIMIT 1`,
    [tenantId, lowered, scopeRecords.driverIds]);
  if (d.rows.length > 0) return true;
  const p = await db.query(
    `SELECT 1 FROM personnel WHERE tenant_id = $1 AND anonymized_at IS NULL AND lower(trim(full_name)) = ANY($2::text[]) AND NOT (id = ANY($3::text[])) LIMIT 1`,
    [tenantId, lowered, scopeRecords.personnelIds]);
  return p.rows.length > 0;
}

// ---------------------------------------------------------------------------------------------------------------
// ANONİMLEŞTİRME
// ---------------------------------------------------------------------------------------------------------------

export interface AnonymizationResult {
  subjectType: SubjectType;
  subjectId: string;
  scope: 'PERSON' | 'RECORD';
  alias: string;
  driverAnonymized: boolean;
  personnelAnonymized: number;
  referenceRowsUpdated: Record<string, number>;
  nameBasedDataSkipped: boolean;
}

/**
 * scope 'PERSON' (silme başvurusu): sürücü + ona bağlı personel kayıtları birlikte. scope 'RECORD' (süre dolumu): yalnızca
 * süresi dolan kaydın türü — ör. sürücü süresi dolunca 10 yıl saklanan personel özlük kaydına dokunulmaz.
 */
async function anonymizeInTx(client: PoolClient, tenantId: string, subjectType: SubjectType, subjectId: string, scope: 'PERSON' | 'RECORD', ctx: { actorUserId: string | null; requestId: string | null; trigger: 'REQUEST' | 'RETENTION' }): Promise<AnonymizationResult> {
  const s = await loadSubject(client, tenantId, subjectType, subjectId, true);
  const doDriver = !!s.driver && !s.driver.anonymized_at && (scope === 'PERSON' || subjectType === 'DRIVER');
  const persons = s.personnel.filter((p) => !p.anonymized_at && (scope === 'PERSON' || subjectType === 'PERSONNEL'));
  if (!doDriver && persons.length === 0) throw new ConflictError('Bu kişinin kişisel verisi zaten anonimleştirilmiş.');

  const alias = `Anonim ${s.driver ? 'Sürücü' : 'Personel'} ${sha(`${tenantId}|${s.primaryId}`, 8)}`;
  const skipNames = await nameCollides(client, tenantId, s, { driverIds: s.driver ? [s.driver.id] : [], personnelIds: s.personnel.map((p) => p.id) });
  const updated: Record<string, number> = {};

  if (!skipNames && s.names.length > 0) {
    for (const ref of NAME_REFERENCE_COLUMNS) {
      const r = await client.query(
        `UPDATE ${ref.table} SET ${ref.column} = ${ref.mode === 'NULL' ? 'NULL' : '$3'} WHERE tenant_id = $1 AND ${ref.column} = ANY($2::text[])`,
        ref.mode === 'NULL' ? [tenantId, s.names] : [tenantId, s.names, alias]);
      if (r.rowCount) updated[`${ref.table}.${ref.column}`] = r.rowCount;
    }
    for (const name of s.names) {
      for (const t of TEXT_REFERENCE_COLUMNS) {
        for (const col of t.columns) {
          const r = await client.query(`UPDATE ${t.table} SET ${col} = replace(${col}, $2::text, $3::text) WHERE tenant_id = $1 AND position($2::text in ${col}) > 0`, [tenantId, name, alias]);
          if (r.rowCount) updated[`${t.table}.${col}`] = (updated[`${t.table}.${col}`] ?? 0) + r.rowCount;
        }
      }
      const a = await client.query(`UPDATE alarms SET subject_id = $3 WHERE tenant_id = $1 AND subject_type = 'DRIVER' AND subject_id = $2`, [tenantId, name, alias]);
      if (a.rowCount) updated['alarms.subject_id'] = a.rowCount;
    }
  }

  if (doDriver) {
    // tc_no NOT NULL/11 karakter: benzersiz olmayan, geçersiz (TCKN sağlama toplamına uymayan) yer tutucu. Kart no benzersiz yer tutucu (kart kullanılamaz).
    await client.query(
      `UPDATE drivers SET name = $3, tc_no = $4, phone = NULL, license_type = NULL, rfid_card_id = $5, status = 'PASİF', anonymized_at = CURRENT_TIMESTAMP WHERE tenant_id = $1 AND id = $2`,
      [tenantId, s.driver.id, alias, `ANON-${sha(s.driver.id, 6)}`, `ANON-${sha(`${tenantId}|${s.driver.id}|card`, 16)}`]);
  }
  for (const p of persons) {
    await client.query(`UPDATE personnel SET full_name = $3, tc_no = NULL, anonymized_at = CURRENT_TIMESTAMP WHERE tenant_id = $1 AND id = $2`, [tenantId, p.id, alias]);
    // İzin gerekçesi serbest metindir (sağlık vb. özel nitelikli veri içerebilir) → silinir; tarih/tür/gün sayısı (özlük/bordro) kalır.
    await client.query(`UPDATE leave_requests SET reason = NULL WHERE tenant_id = $1 AND personnel_id = $2`, [tenantId, p.id]);
  }

  const result: AnonymizationResult = {
    subjectType, subjectId, scope, alias, driverAnonymized: doDriver, personnelAnonymized: persons.length, referenceRowsUpdated: updated, nameBasedDataSkipped: skipNames && s.names.length > 0
  };
  // Denetim kaydı kişisel veri İÇERMEZ (ad/TCKN yok; yalnızca kayıt id'si + sayımlar).
  await client.query(
    `INSERT INTO audit_logs (id, tenant_id, user_id, action, target_type, target_id, after_value) VALUES ($1, $2, $3, 'PERSONAL_DATA_ANONYMIZED', $4, $5, $6::jsonb)`,
    [generateId('audit'), tenantId, ctx.actorUserId, subjectType, subjectId, JSON.stringify({ trigger: ctx.trigger, requestId: ctx.requestId, scope, driverAnonymized: doDriver, personnelAnonymized: persons.length, referenceRowsUpdated: updated, nameBasedDataSkipped: result.nameBasedDataSkipped })]
  );
  return result;
}

async function inTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export interface ExpiredAnonymizationResult { tenantId: string; dataClass: string; retentionDays: number; cutoff: string; candidates: number; anonymized: number; failed: number; }

/** Saklama süresi (tenant ayarı; taban uygulanır) dolan aktif-olmayan kayıtları anonimleştirir. Aktif kayıtlar asla dolmaz. */
export async function anonymizeExpiredSubjects(options: { tenantId?: string; dryRun?: boolean; now?: Date } = {}): Promise<ExpiredAnonymizationResult[]> {
  const now = options.now ?? new Date();
  const tenantIds: string[] = options.tenantId ? [options.tenantId] : (await pool.query('SELECT id FROM companies')).rows.map((r) => r.id as string);
  const results: ExpiredAnonymizationResult[] = [];
  for (const tenantId of tenantIds) {
    const overrides = await loadOverrides(tenantId);
    for (const spec of ANONYMIZABLE_CLASSES) {
      const days = Math.max(overrides.get(spec.dataClass) ?? spec.defaultDays, spec.minDays);
      const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      const isDriver = spec.dataClass === 'DRIVER_PII';
      const cand = await pool.query(
        `SELECT id FROM ${spec.table} WHERE tenant_id = $1 AND anonymized_at IS NULL AND deactivated_at IS NOT NULL AND deactivated_at < $2 ORDER BY deactivated_at, id`,
        [tenantId, cutoff]);
      if (cand.rows.length === 0) continue;
      const res: ExpiredAnonymizationResult = { tenantId, dataClass: spec.dataClass, retentionDays: days, cutoff: cutoff.toISOString(), candidates: cand.rows.length, anonymized: 0, failed: 0 };
      if (!options.dryRun) {
        for (const row of cand.rows) {
          try {
            await inTx((c) => anonymizeInTx(c, tenantId, isDriver ? 'DRIVER' : 'PERSONNEL', row.id, 'RECORD', { actorUserId: null, requestId: null, trigger: 'RETENTION' }));
            res.anonymized++;
          } catch (err) {
            res.failed++;
            logger.error({ err, tenantId, subjectId: row.id, dataClass: spec.dataClass }, '🚨 [COMP-606] Süresi dolan kişisel veri anonimleştirilemedi (kayıt korundu).');
          }
        }
      }
      results.push(res);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------------------------------------------
// VERİ SAHİBİ BAŞVURULARI
// ---------------------------------------------------------------------------------------------------------------

export interface DataSubjectRequest {
  id: string; requestType: 'ACCESS' | 'ERASURE'; subjectType: SubjectType; subjectId: string; requesterNote: string | null;
  status: 'RECEIVED' | 'COMPLETED' | 'REJECTED'; receivedAt: string; dueAt: string; completedAt: string | null;
  overdue: boolean; daysLeft: number | null; rejectReason: string | null; result: unknown;
}

function mapRequest(r: any): DataSubjectRequest {
  const due = new Date(r.due_at).getTime();
  const open = r.status === 'RECEIVED';
  return {
    id: r.id, requestType: r.request_type, subjectType: r.subject_type, subjectId: r.subject_id, requesterNote: r.requester_note,
    status: r.status, receivedAt: new Date(r.received_at).toISOString(), dueAt: new Date(r.due_at).toISOString(),
    completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
    overdue: open && due < Date.now(), daysLeft: open ? Math.ceil((due - Date.now()) / 86400000) : null, rejectReason: r.reject_reason, result: r.result
  };
}

export async function createDataSubjectRequest(tenantId: string, actorUserId: string, input: { requestType: 'ACCESS' | 'ERASURE'; subjectType: SubjectType; subjectId: string; note?: string }): Promise<DataSubjectRequest> {
  return inTx(async (c) => {
    await loadSubject(c, tenantId, input.subjectType, input.subjectId); // 404 (başka tenant'ın kaydı görünmez)
    const open = await c.query(`SELECT 1 FROM data_subject_requests WHERE tenant_id = $1 AND subject_type = $2 AND subject_id = $3 AND request_type = $4 AND status = 'RECEIVED'`, [tenantId, input.subjectType, input.subjectId, input.requestType]);
    if (open.rows.length > 0) throw new ConflictError('Bu kişi için aynı türde açık bir başvuru zaten var.');
    const id = generateId('dsr');
    const r = await c.query(
      `INSERT INTO data_subject_requests (id, tenant_id, request_type, subject_type, subject_id, requester_note, received_by, due_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP + ($8 || ' days')::interval) RETURNING *`,
      [id, tenantId, input.requestType, input.subjectType, input.subjectId, input.note ?? null, actorUserId, String(DSR_RESPONSE_DAYS)]);
    await c.query(`INSERT INTO audit_logs (id, tenant_id, user_id, action, target_type, target_id, after_value) VALUES ($1, $2, $3, 'DSR_RECEIVED', 'data_subject_request', $4, $5::jsonb)`,
      [generateId('audit'), tenantId, actorUserId, id, JSON.stringify({ requestType: input.requestType, subjectType: input.subjectType, subjectId: input.subjectId })]);
    return mapRequest(r.rows[0]);
  });
}

export async function listDataSubjectRequests(tenantId: string): Promise<DataSubjectRequest[]> {
  const r = await pool.query('SELECT * FROM data_subject_requests WHERE tenant_id = $1 ORDER BY received_at DESC, id DESC LIMIT 500', [tenantId]);
  return r.rows.map(mapRequest);
}

async function loadOpenRequest(c: PoolClient, tenantId: string, id: string, type: 'ACCESS' | 'ERASURE'): Promise<any> {
  const r = await c.query('SELECT * FROM data_subject_requests WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, id]);
  if (r.rows.length === 0) throw new NotFoundError('Başvuru bulunamadı.');
  const req = r.rows[0];
  if (req.request_type !== type) throw new BadRequestError(`Bu başvuru bir ${req.request_type} başvurusudur; bu işlem ${type} içindir.`);
  if (req.status !== 'RECEIVED') throw new ConflictError(`Başvuru zaten sonuçlanmış (${req.status}).`);
  return req;
}

export async function rejectDataSubjectRequest(tenantId: string, actorUserId: string, id: string, reason: string): Promise<DataSubjectRequest> {
  return inTx(async (c) => {
    const r = await c.query('SELECT * FROM data_subject_requests WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, id]);
    if (r.rows.length === 0) throw new NotFoundError('Başvuru bulunamadı.');
    if (r.rows[0].status !== 'RECEIVED') throw new ConflictError(`Başvuru zaten sonuçlanmış (${r.rows[0].status}).`);
    const u = await c.query(`UPDATE data_subject_requests SET status = 'REJECTED', reject_reason = $3, handled_by = $4, completed_at = CURRENT_TIMESTAMP WHERE tenant_id = $1 AND id = $2 RETURNING *`, [tenantId, id, reason, actorUserId]);
    await c.query(`INSERT INTO audit_logs (id, tenant_id, user_id, action, target_type, target_id, after_value) VALUES ($1, $2, $3, 'DSR_REJECTED', 'data_subject_request', $4, $5::jsonb)`,
      [generateId('audit'), tenantId, actorUserId, id, JSON.stringify({ reasonLength: reason.length })]);
    return mapRequest(u.rows[0]);
  });
}

export interface SubjectExport {
  subject: { type: SubjectType; id: string };
  generatedAt: string;
  driver: Record<string, unknown> | null;
  personnel: Array<Record<string, unknown>>;
  leaveRequests: Array<Record<string, unknown>>;
  /** Ad tabanlı bölümler (ikmal, skor, yetki...). Ad çakışması varsa BAŞKA kişinin verisi ifşa olmasın diye boş + bayrak. */
  nameBasedDataWithheld: boolean;
  transactions: { count: number; totalLiters: number; firstAt: string | null; lastAt: string | null; records: Array<Record<string, unknown>>; truncated: boolean } | null;
  behaviorScores: Array<Record<string, unknown>> | null;
  crossSitePermissions: Array<Record<string, unknown>> | null;
  counts: { manualDispenseRequests: number | null; anomalyFlags: number | null; assignedVehicles: string[] | null; auditTrailEntries: number };
}

const stripTenant = (row: any): Record<string, unknown> => { const { tenant_id, ...rest } = row; return rest; };

/** ERİŞİM hakkı: kişinin sistemdeki verisinin dökümü. Başvuru kapatılır; döküm SAKLANMAZ (yalnızca bu yanıtta). */
export async function fulfillAccessRequest(tenantId: string, actorUserId: string, requestId: string): Promise<{ request: DataSubjectRequest; export: SubjectExport }> {
  return inTx(async (c) => {
    const req = await loadOpenRequest(c, tenantId, requestId, 'ACCESS');
    const s = await loadSubject(c, tenantId, req.subject_type, req.subject_id);
    const collide = await nameCollides(c, tenantId, s, { driverIds: s.driver ? [s.driver.id] : [], personnelIds: s.personnel.map((p) => p.id) });
    const personnelIds = s.personnel.map((p) => p.id);
    const leaves = personnelIds.length ? (await c.query('SELECT * FROM leave_requests WHERE tenant_id = $1 AND personnel_id = ANY($2::text[]) ORDER BY start_date', [tenantId, personnelIds])).rows.map(stripTenant) : [];
    const audit = await c.query('SELECT COUNT(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND target_id = ANY($2::text[])', [tenantId, [s.primaryId, ...personnelIds]]);

    let tx: SubjectExport['transactions'] = null, scores: SubjectExport['behaviorScores'] = null, perms: SubjectExport['crossSitePermissions'] = null;
    let manual: number | null = null, flags: number | null = null, vehicles: string[] | null = null;
    if (!collide && s.names.length > 0) {
      const agg = await c.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_liters), 0)::float8 AS total, MIN(created_at) AS first_at, MAX(created_at) AS last_at FROM transactions WHERE tenant_id = $1 AND driver_name = ANY($2::text[])`, [tenantId, s.names]);
      const recs = await c.query(`SELECT id, created_at, site_name, vehicle_plate, tank_name, amount_liters, type FROM transactions WHERE tenant_id = $1 AND driver_name = ANY($2::text[]) ORDER BY created_at, id LIMIT $3`, [tenantId, s.names, EXPORT_RECORD_CAP]);
      tx = { count: agg.rows[0].n, totalLiters: agg.rows[0].total, firstAt: agg.rows[0].first_at ? new Date(agg.rows[0].first_at).toISOString() : null, lastAt: agg.rows[0].last_at ? new Date(agg.rows[0].last_at).toISOString() : null, records: recs.rows, truncated: agg.rows[0].n > EXPORT_RECORD_CAP };
      scores = (await c.query('SELECT * FROM driver_behavior_scores WHERE tenant_id = $1 AND driver_name = ANY($2::text[]) ORDER BY computed_at DESC LIMIT $3', [tenantId, s.names, EXPORT_RECORD_CAP])).rows.map(stripTenant);
      perms = (await c.query('SELECT * FROM cross_site_permissions WHERE tenant_id = $1 AND driver_name = ANY($2::text[])', [tenantId, s.names])).rows.map(stripTenant);
      manual = (await c.query('SELECT COUNT(*)::int AS n FROM manual_dispense_requests WHERE tenant_id = $1 AND driver_name = ANY($2::text[])', [tenantId, s.names])).rows[0].n;
      flags = (await c.query('SELECT COUNT(*)::int AS n FROM transaction_anomaly_flags WHERE tenant_id = $1 AND driver_name = ANY($2::text[])', [tenantId, s.names])).rows[0].n;
      vehicles = (await c.query('SELECT plate FROM vehicles WHERE tenant_id = $1 AND assigned_driver_name = ANY($2::text[]) ORDER BY plate', [tenantId, s.names])).rows.map((r) => r.plate);
    }
    const bundle: SubjectExport = {
      subject: { type: req.subject_type, id: req.subject_id }, generatedAt: new Date().toISOString(),
      driver: s.driver ? stripTenant(s.driver) : null, personnel: s.personnel.map(stripTenant), leaveRequests: leaves,
      nameBasedDataWithheld: collide, transactions: tx, behaviorScores: scores, crossSitePermissions: perms,
      counts: { manualDispenseRequests: manual, anomalyFlags: flags, assignedVehicles: vehicles, auditTrailEntries: audit.rows[0].n }
    };
    const summary = { transactions: tx?.count ?? null, personnel: s.personnel.length, leaveRequests: leaves.length, nameBasedDataWithheld: collide };
    const u = await c.query(`UPDATE data_subject_requests SET status = 'COMPLETED', handled_by = $3, completed_at = CURRENT_TIMESTAMP, result = $4::jsonb WHERE tenant_id = $1 AND id = $2 RETURNING *`, [tenantId, requestId, actorUserId, JSON.stringify(summary)]);
    await c.query(`INSERT INTO audit_logs (id, tenant_id, user_id, action, target_type, target_id, after_value) VALUES ($1, $2, $3, 'DSR_ACCESS_FULFILLED', 'data_subject_request', $4, $5::jsonb)`,
      [generateId('audit'), tenantId, actorUserId, requestId, JSON.stringify(summary)]);
    return { request: mapRequest(u.rows[0]), export: bundle };
  });
}

/** SİLME hakkı: kişisel alanlar anonimleştirilir; yasal saklama gereği mali kayıtlar takma adla KALIR (yanıtta belirtilir). */
export async function fulfillErasureRequest(tenantId: string, actorUserId: string, requestId: string): Promise<{ request: DataSubjectRequest; result: AnonymizationResult; retained: string[]; coldArchiveNotice: { archives: number; latestDeletion: string | null } }> {
  return inTx(async (c) => {
    const req = await loadOpenRequest(c, tenantId, requestId, 'ERASURE');
    const result = await anonymizeInTx(c, tenantId, req.subject_type, req.subject_id, 'PERSON', { actorUserId, requestId, trigger: 'REQUEST' });
    const retained = ['transactions (mali kayıt: tutar/plaka/tarih/mühür korunur, şoför adı takma ad)', 'audit_logs (denetim izi; kişisel veri içermez)', 'e-İrsaliye (yasal saklama; yeniden üretimde anonim veri)'];
    const cold = await c.query(`SELECT COUNT(*)::int AS n, MIN(created_at) AS oldest FROM retention_archives WHERE tenant_id = $1 AND data_class IN ('DRIVER_SCORE', 'AUDIT_LOG', 'NOTIFICATION', 'ALARM', 'ALARM_EVENT')`, [tenantId]);
    const overrides = await loadOverrides(tenantId, c);
    const coldDays = overrides.get('COLD_ARCHIVE') ?? 1825;
    const notice = { archives: cold.rows[0].n, latestDeletion: cold.rows[0].oldest ? new Date(new Date(cold.rows[0].oldest).getTime() + coldDays * 86400000).toISOString() : null };
    const summary = { ...result, retained };
    const u = await c.query(`UPDATE data_subject_requests SET status = 'COMPLETED', handled_by = $3, completed_at = CURRENT_TIMESTAMP, result = $4::jsonb WHERE tenant_id = $1 AND id = $2 RETURNING *`, [tenantId, requestId, actorUserId, JSON.stringify(summary)]);
    return { request: mapRequest(u.rows[0]), result, retained, coldArchiveNotice: notice };
  });
}
