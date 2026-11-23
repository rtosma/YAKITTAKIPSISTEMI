import zlib from 'zlib';
import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { pool } from '../db/postgresPool';
import { generateId } from '../utils/id';
import { encryptTenantExport, decryptTenantExport } from '../utils/tenantExportCrypto';
import { BadRequestError, NotFoundError } from '../utils/errors';
import { logger } from '../utils/logger';
import {
  PURGEABLE_CLASSES, PROTECTED_TABLES, EXTERNAL_CLASSES, MAX_RETENTION_DAYS, ANONYMIZABLE_CLASSES, COLD_ARCHIVE_CLASS, getConfigurableSpec, type PurgeableSpec
} from '../retention/retentionCatalog';

/**
 * ARCH-107 (#123) — veri saklama politikası + arşivleyerek parti parti purge.
 *
 * Bu dosya ham `pool` (yönetim/superuser bağlantısı) kullanır ve check-no-raw-pool-query allowlist'indedir —
 * adminDb.ts/readinessService.ts ile AYNI gerekçe: iş TÜM tenant'lara bakan sistem genelinde bir bakım
 * turudur, ve `audit_logs` üzerinde uygulama rolünün DELETE yetkisi KASITLI olarak yoktur (AUTH-203); silmeyi
 * yalnızca bu yönetim bağlantısı yapabilir. Her SQL, retentionCatalog.ts'teki SABİT tablo/sütun adlarından
 * üretilir — dış girdi (dataClass) yalnızca katalogda anahtar olarak aranır, SQL'e ASLA girmez.
 *
 * GÜVENCELER:
 *  1. Mali kayıtlar: PURGEABLE katalog dışındaki hiçbir tabloya bu dosyadaki SQL erişemez (PROTECTED tablolar
 *     için ne ayar ne silme yolu vardır).
 *  2. Arşiv zorunluluğu: her parti için arşiv satırı INSERT'i ve silme AYNI transaction'dadır — arşiv yazılamazsa
 *     (anahtar/DB hatası) silme geri alınır ve o sınıfın purge'ü İPTAL edilir; arşivsiz silinmiş satır oluşamaz.
 *  3. Parti parti: her transaction en çok `batchSize` satır siler (kilit süresi kısa); `FOR UPDATE SKIP LOCKED`.
 *  4. Çoklu replika: tur, pg advisory lock ile tek örnekte çalışır.
 */

export const DEFAULT_PURGE_BATCH_SIZE = 1000;
const DEFAULT_MAX_BATCHES_PER_CLASS = 200;
const ADVISORY_LOCK_KEY = 'arch107-retention-purge';

export interface EffectivePolicy {
  dataClass: string;
  label: string;
  table: string;
  defaultDays: number;
  minDays: number;
  effectiveDays: number;
  customized: boolean;
  rationale: string;
}

export interface RetentionPolicyView {
  purgeable: EffectivePolicy[];
  /** COMP-606: süresi dolunca anonimleştirilen kişisel veri sınıfları + soğuk arşiv ömrü. */
  personalData: Array<EffectivePolicy & { kind: string }>;
  protected: Array<{ table: string; minYears: number; reason: string }>;
  external: typeof EXTERNAL_CLASSES;
  maxDays: number;
}

export async function loadOverrides(tenantId: string, db: Pick<PoolClient, 'query'> = pool): Promise<Map<string, number>> {
  const r = await db.query('SELECT data_class, retention_days FROM tenant_retention_settings WHERE tenant_id = $1', [tenantId]);
  return new Map(r.rows.map((row) => [row.data_class as string, Number(row.retention_days)]));
}

export async function getRetentionPolicies(tenantId: string): Promise<RetentionPolicyView> {
  const overrides = await loadOverrides(tenantId);
  return {
    purgeable: PURGEABLE_CLASSES.map((c) => ({
      dataClass: c.dataClass, label: c.label, table: c.table, defaultDays: c.defaultDays, minDays: c.minDays,
      effectiveDays: overrides.get(c.dataClass) ?? c.defaultDays, customized: overrides.has(c.dataClass), rationale: c.rationale
    })),
    personalData: [...ANONYMIZABLE_CLASSES, COLD_ARCHIVE_CLASS].map((c) => ({
      dataClass: c.dataClass, kind: c.kind, label: c.label, table: c.table, defaultDays: c.defaultDays, minDays: c.minDays,
      effectiveDays: overrides.get(c.dataClass) ?? c.defaultDays, customized: overrides.has(c.dataClass), rationale: c.rationale
    })),
    protected: Object.entries(PROTECTED_TABLES).map(([table, v]) => ({ table, ...v })),
    external: EXTERNAL_CLASSES,
    maxDays: MAX_RETENTION_DAYS
  };
}

/** `null` → tenant özelleştirmesini kaldırır (varsayılana döner). */
export async function setRetentionDays(tenantId: string, dataClass: string, retentionDays: number | null, actorUserId: string): Promise<EffectivePolicy> {
  const spec = getConfigurableSpec(dataClass);
  if (!spec) {
    const isProtected = Object.keys(PROTECTED_TABLES).includes(dataClass.toLowerCase()) || /^transactions?$/i.test(dataClass);
    if (isProtected) {
      throw new BadRequestError('Mali/mevzuat kaydı otomatik silinmez ve saklama süresi ayarlanamaz (ARCH-107: mali kayıtlar hiçbir koşulda purge edilmez).');
    }
    throw new NotFoundError(`Bilinmeyen veri sınıfı: ${dataClass}`);
  }
  if (retentionDays !== null) {
    if (!Number.isInteger(retentionDays) || retentionDays < spec.minDays || retentionDays > MAX_RETENTION_DAYS) {
      throw new BadRequestError(`${spec.dataClass} için saklama süresi ${spec.minDays}–${MAX_RETENTION_DAYS} gün arasında olmalıdır (taban: ${spec.minDays} gün).`);
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = (await loadOverrides(tenantId, client)).get(spec.dataClass) ?? null;
    if (retentionDays === null) {
      await client.query('DELETE FROM tenant_retention_settings WHERE tenant_id = $1 AND data_class = $2', [tenantId, spec.dataClass]);
    } else {
      await client.query(
        `INSERT INTO tenant_retention_settings (tenant_id, data_class, retention_days, updated_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, data_class) DO UPDATE SET retention_days = EXCLUDED.retention_days, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`,
        [tenantId, spec.dataClass, retentionDays, actorUserId]
      );
    }
    await client.query(
      `INSERT INTO audit_logs (id, tenant_id, user_id, action, target_type, target_id, before_value, after_value) VALUES ($1, $2, $3, 'RETENTION_POLICY_UPDATED', 'retention_policy', $4, $5::jsonb, $6::jsonb)`,
      [generateId('audit'), tenantId, actorUserId, spec.dataClass, JSON.stringify({ retentionDays: before }), JSON.stringify({ retentionDays })]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  const view = await getRetentionPolicies(tenantId);
  return [...view.purgeable, ...view.personalData].find((p) => p.dataClass === spec.dataClass)!;
}

// ---------------------------------------------------------------------------------------------------------------
// Arşiv biçimi: { header, rows } JSON → gzip → base64 → AES-256-GCM (ARCH-108'in TENANT_EXPORT_ENCRYPTION_KEY'i).
// ---------------------------------------------------------------------------------------------------------------

export interface RetentionArchiveContent {
  header: { dataClass: string; table: string; tenantId: string; cutoff: string; retentionDays: number; rowCount: number; createdAt: string };
  rows: Array<Record<string, unknown>>;
}

function packArchive(content: RetentionArchiveContent): { encrypted: Buffer; sha256: string } {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(content), 'utf8'), { level: 9 });
  return { encrypted: encryptTenantExport(gz.toString('base64')), sha256: crypto.createHash('sha256').update(gz).digest('hex') };
}

/** Yönetici araçları/testler için — bir soğuk arşivi açar ve bütünlüğünü (sha256) doğrular. */
export function decryptRetentionArchive(encrypted: Buffer, expectedSha256?: string): RetentionArchiveContent {
  const gz = Buffer.from(decryptTenantExport(encrypted), 'base64');
  if (expectedSha256 && crypto.createHash('sha256').update(gz).digest('hex') !== expectedSha256) {
    throw new Error('Retention arşivi bütünlük (sha256) doğrulaması başarısız.');
  }
  return JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
}

export interface RetentionArchiveSummary {
  id: string; dataClass: string; cutoffAt: string; retentionDays: number; rowCount: number;
  oldestAt: string | null; newestAt: string | null; fileSizeBytes: number; createdAt: string;
}

export async function listRetentionArchives(tenantId: string, limit = 100): Promise<RetentionArchiveSummary[]> {
  const r = await pool.query(
    `SELECT id, data_class, cutoff_at, retention_days, row_count, oldest_at, newest_at, file_size_bytes, created_at
     FROM retention_archives WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`, [tenantId, limit]);
  return r.rows.map((row) => ({
    id: row.id, dataClass: row.data_class, cutoffAt: new Date(row.cutoff_at).toISOString(), retentionDays: row.retention_days, rowCount: row.row_count,
    oldestAt: row.oldest_at ? new Date(row.oldest_at).toISOString() : null, newestAt: row.newest_at ? new Date(row.newest_at).toISOString() : null,
    fileSizeBytes: Number(row.file_size_bytes), createdAt: new Date(row.created_at).toISOString()
  }));
}

// ---------------------------------------------------------------------------------------------------------------
// Purge
// ---------------------------------------------------------------------------------------------------------------

export interface PurgeClassResult {
  tenantId: string;
  dataClass: string;
  retentionDays: number;
  cutoff: string;
  /** dryRun: silinecek satır sayısı; gerçek çalıştırma: silinen satır sayısı. */
  rows: number;
  archives: number;
  batches: number;
  /** Arşiv/silme başarısızsa: sebep — o sınıfın purge'ü İPTAL edildi (bu partide hiçbir satır silinmedi). */
  cancelled?: string;
}

export interface RetentionRunOptions {
  tenantId?: string;
  dryRun?: boolean;
  batchSize?: number;
  maxBatchesPerClass?: number;
  now?: Date;
}

export interface RetentionRunResult {
  dryRun: boolean;
  skippedLocked: boolean;
  results: PurgeClassResult[];
}

function eligibleWhere(spec: PurgeableSpec): string {
  return `t.tenant_id = $1 AND t.${spec.timestampColumn} < $2${spec.predicate ? ` AND (${spec.predicate})` : ''}`;
}

async function purgeOneBatch(spec: PurgeableSpec, tenantId: string, cutoff: Date, retentionDays: number, batchSize: number): Promise<{ deleted: number; archiveId: string | null }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const excludes = `{${spec.archiveExcludeColumns.join(',')}}`;
    const sel = await client.query(
      `SELECT t.id AS id, t.${spec.timestampColumn} AS ts, (to_jsonb(t) - $4::text[]) AS row
       FROM ${spec.table} t WHERE ${eligibleWhere(spec)}
       ORDER BY t.${spec.timestampColumn}, t.id LIMIT $3 FOR UPDATE OF t SKIP LOCKED`,
      [tenantId, cutoff, batchSize, excludes]
    );
    if (sel.rows.length === 0) {
      await client.query('ROLLBACK');
      return { deleted: 0, archiveId: null };
    }
    const now = new Date();
    const { encrypted, sha256 } = packArchive({
      header: { dataClass: spec.dataClass, table: spec.table, tenantId, cutoff: cutoff.toISOString(), retentionDays, rowCount: sel.rows.length, createdAt: now.toISOString() },
      rows: sel.rows.map((r) => r.row)
    });
    const archiveId = generateId('retarc');
    // AC: arşiv ÖNCE — ve AYNI transaction'da: bu INSERT patlarsa aşağıdaki DELETE hiç çalışmaz / geri alınır.
    await client.query(
      `INSERT INTO retention_archives (id, tenant_id, data_class, cutoff_at, retention_days, row_count, oldest_at, newest_at, file_data, file_size_bytes, sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [archiveId, tenantId, spec.dataClass, cutoff, retentionDays, sel.rows.length, sel.rows[0].ts, sel.rows[sel.rows.length - 1].ts, encrypted, encrypted.length, sha256]
    );
    const ids = sel.rows.map((r) => r.id as string);
    const del = await client.query(`DELETE FROM ${spec.table} t WHERE t.tenant_id = $1 AND t.id = ANY($2::text[])`, [tenantId, ids]);
    if (del.rowCount !== ids.length) throw new Error(`Silinen satır sayısı (${del.rowCount}) arşivlenenle (${ids.length}) uyuşmuyor — iptal.`);
    // AC: "silme kaydının audit log'a yazılması" — silinen satırların KENDİSİ arşivde, burada yalnızca özet.
    await client.query(
      `INSERT INTO audit_logs (id, tenant_id, user_id, action, target_type, target_id, after_value) VALUES ($1, $2, NULL, 'RETENTION_PURGE', $3, $4, $5::jsonb)`,
      [generateId('audit'), tenantId, spec.dataClass, archiveId, JSON.stringify({ rowCount: ids.length, cutoff: cutoff.toISOString(), retentionDays, archiveId, table: spec.table })]
    );
    await client.query('COMMIT');
    return { deleted: ids.length, archiveId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function runRetentionPurge(options: RetentionRunOptions = {}): Promise<RetentionRunResult> {
  const dryRun = options.dryRun ?? false;
  const batchSize = Math.max(1, Math.min(options.batchSize ?? DEFAULT_PURGE_BATCH_SIZE, 10000));
  const maxBatches = options.maxBatchesPerClass ?? DEFAULT_MAX_BATCHES_PER_CLASS;
  const now = options.now ?? new Date();

  const lockClient = await pool.connect();
  try {
    const lock = await lockClient.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [ADVISORY_LOCK_KEY]);
    if (!lock.rows[0].locked) return { dryRun, skippedLocked: true, results: [] };

    const tenantIds: string[] = options.tenantId
      ? [options.tenantId]
      : (await pool.query('SELECT id FROM companies')).rows.map((r) => r.id as string);
    const results: PurgeClassResult[] = [];

    for (const tenantId of tenantIds) {
      const overrides = await loadOverrides(tenantId);
      for (const spec of PURGEABLE_CLASSES) {
        const retentionDays = overrides.get(spec.dataClass) ?? spec.defaultDays;
        // Taban: ayar sonradan (ör. katalog güncellemesiyle) tabanın altında kalmış olsa bile purge tabanı aşmaz.
        const effectiveDays = Math.max(retentionDays, spec.minDays);
        const cutoff = new Date(now.getTime() - effectiveDays * 24 * 60 * 60 * 1000);
        const result: PurgeClassResult = { tenantId, dataClass: spec.dataClass, retentionDays: effectiveDays, cutoff: cutoff.toISOString(), rows: 0, archives: 0, batches: 0 };

        if (dryRun) {
          const c = await pool.query(`SELECT COUNT(*)::int AS n FROM ${spec.table} t WHERE ${eligibleWhere(spec)}`, [tenantId, cutoff]);
          result.rows = c.rows[0].n;
          if (result.rows > 0) results.push(result);
          continue;
        }
        try {
          for (let i = 0; i < maxBatches; i++) {
            const { deleted, archiveId } = await purgeOneBatch(spec, tenantId, cutoff, effectiveDays, batchSize);
            if (deleted === 0) break;
            result.rows += deleted;
            result.batches++;
            if (archiveId) result.archives++;
            if (deleted < batchSize) break;
          }
        } catch (err: any) {
          // Arşiv/silme başarısız → BU parti geri alındı (satır silinmedi); sınıf iptal, diğer sınıflar/tenant'lar sürer.
          result.cancelled = String(err?.message ?? err);
          logger.error({ err, tenantId, dataClass: spec.dataClass }, '🚨 [ARCH-107] Purge iptal edildi (arşiv/silme hatası; satırlar korundu).');
        }
        if (result.rows > 0 || result.cancelled) results.push(result);
      }
    }
    return { dryRun, skippedLocked: false, results };
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    lockClient.release();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// COMP-606: soğuk arşivlerin ömrü. Arşivin arşivi tutulmaz (kişisel veri içerdiği için amaç dışı çoğaltma olur);
// silme yalnızca audit log'a özet olarak yazılır. Her silme tek transaction'da audit ile birlikte yapılır.
// ---------------------------------------------------------------------------------------------------------------

export interface ColdArchivePurgeResult { tenantId: string; retentionDays: number; cutoff: string; archives: number; rows: number; }

export async function purgeColdArchives(options: { tenantId?: string; dryRun?: boolean; now?: Date } = {}): Promise<ColdArchivePurgeResult[]> {
  const now = options.now ?? new Date();
  const tenantIds: string[] = options.tenantId ? [options.tenantId] : (await pool.query('SELECT id FROM companies')).rows.map((r) => r.id as string);
  const out: ColdArchivePurgeResult[] = [];
  for (const tenantId of tenantIds) {
    const days = Math.max((await loadOverrides(tenantId)).get(COLD_ARCHIVE_CLASS.dataClass) ?? COLD_ARCHIVE_CLASS.defaultDays, COLD_ARCHIVE_CLASS.minDays);
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query('SELECT id, data_class, row_count FROM retention_archives WHERE tenant_id = $1 AND created_at < $2 FOR UPDATE', [tenantId, cutoff]);
      if (found.rows.length === 0 || options.dryRun) {
        await client.query('ROLLBACK');
        if (found.rows.length > 0) out.push({ tenantId, retentionDays: days, cutoff: cutoff.toISOString(), archives: found.rows.length, rows: found.rows.reduce((s, r) => s + Number(r.row_count), 0) });
        continue;
      }
      await client.query('DELETE FROM retention_archives WHERE tenant_id = $1 AND id = ANY($2::text[])', [tenantId, found.rows.map((r) => r.id)]);
      const rows = found.rows.reduce((s, r) => s + Number(r.row_count), 0);
      await client.query(
        `INSERT INTO audit_logs (id, tenant_id, user_id, action, target_type, target_id, after_value) VALUES ($1, $2, NULL, 'RETENTION_COLD_ARCHIVE_PURGE', 'retention_archives', $3, $4::jsonb)`,
        [generateId('audit'), tenantId, COLD_ARCHIVE_CLASS.dataClass, JSON.stringify({ archives: found.rows.length, rows, cutoff: cutoff.toISOString(), retentionDays: days, dataClasses: [...new Set(found.rows.map((r) => r.data_class))] })]
      );
      await client.query('COMMIT');
      out.push({ tenantId, retentionDays: days, cutoff: cutoff.toISOString(), archives: found.rows.length, rows });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      logger.error({ err, tenantId }, '🚨 [COMP-606] Soğuk arşiv temizliği başarısız (arşivler korundu).');
    } finally {
      client.release();
    }
  }
  return out;
}
