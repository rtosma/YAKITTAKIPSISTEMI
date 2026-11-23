import { Client } from 'pg';
import Redis from 'ioredis';
import fs from 'fs';
import path from 'path';
import { PURGEABLE_CLASSES, PROTECTED_TABLES, MANAGED_TABLES, MASTER_TABLES, classifyTable } from '../src/retention/retentionCatalog';
import { runRetentionPurge, decryptRetentionArchive } from '../src/services/retentionService';

/**
 * ARCH-107 (#123) — veri saklama politikası + arşivleyerek parti parti purge.
 *
 * CANLI HTTP (politika/RBAC/elle çalıştırma) + gerçek PG (fixture, purge). Purge senaryoları
 * BU TESTE ÖZEL iki geçici tenant'ta (ret107-t1/t2) çalışır — gerçek firmaların verisine dokunulmaz;
 * politika API testleri comp-camsa üzerinde yalnızca ayar yazar/geri alır. Fixture hesapları elle yapılmıştır.
 */

const API_URL = 'http://localhost:5000/api/v1';
const T1 = 'ret107-t1';
const T2 = 'ret107-t2';
const CAMSA = 'comp-camsa';
const LOCK_KEY = 'arch107-retention-purge';

const redis = new Redis({ host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379', 10) });
function pg(): Client {
  return new Client({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database: process.env.POSTGRES_DB || 'yakittakip_db'
  });
}
async function q(sql: string, params: any[] = []): Promise<any[]> {
  const c = pg(); await c.connect(); try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}
async function call(method: string, p: string, opts: { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
  if (p === '/auth/login') { const k = await redis.keys('rl:auth-login:*'); if (k.length) await redis.del(...k); }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${API_URL}${p}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function login(u: string): Promise<string> {
  const r = await call('POST', '/auth/login', { body: { username: u, password: '123456' } });
  if (!r.body.accessToken) throw new Error(`login ${u}: ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
}

const started = new Date();

async function cleanup(): Promise<void> {
  await q('DROP TRIGGER IF EXISTS ret107_fail_archive ON retention_archives');
  await q('DROP FUNCTION IF EXISTS ret107_fail_archive_fn()');
  await q('DELETE FROM companies WHERE id IN ($1, $2)', [T1, T2]); // CASCADE: fixture + arşivler + ayarlar + audit
  await q('DELETE FROM tenant_retention_settings WHERE tenant_id = $1', [CAMSA]);
  await q("DELETE FROM audit_logs WHERE tenant_id = $1 AND action = 'RETENTION_POLICY_UPDATED' AND created_at >= $2", [CAMSA, started]);
}

async function seed(): Promise<void> {
  for (const [id, tax] of [[T1, 'RET107-1'], [T2, 'RET107-2']]) {
    await q(`INSERT INTO companies (id, name, tax_number) VALUES ($1, $2, $3)`, [id, `ARCH-107 test ${id}`, tax]);
  }
  const ago = (d: number) => `NOW() - INTERVAL '${d} days'`;
  const sql: string[] = [];
  // Bildirimler (varsayılan 180 gün): 3 eski-teslim (silinir), eski-bekleyen + eski-başarısız (KORUNUR), 100 gün + 10 gün (korunur).
  for (const [id, st, d] of [['n-old-1', 'GÖNDERILDI', 400], ['n-old-2', 'GÖNDERILDI', 401], ['n-old-3', 'GÖNDERILDI', 402], ['n-old-pending', 'BEKLIYOR', 400], ['n-old-failed', 'BAŞARISIZ', 400], ['n-100d', 'GÖNDERILDI', 100], ['n-10d', 'GÖNDERILDI', 10]] as const) {
    sql.push(`INSERT INTO notifications (id, tenant_id, event_type, title, body, status, created_at) VALUES ('ret107-${id}', '${T1}', 'TEST', 'başlık', 'gövde', '${st}', ${ago(d)})`);
  }
  // Alarmlar (varsayılan 730): eski-çözülmüş (silinir), eski-AÇIK (korunur), 100 gün önce çözülmüş (korunur).
  sql.push(`INSERT INTO alarms (id, tenant_id, alarm_key, category, title, status, resolved_at, created_at) VALUES ('ret107-a-res-old', '${T1}', 'ret107-k1', 'TEST', 'a1', 'RESOLVED', ${ago(800)}, ${ago(900)})`);
  sql.push(`INSERT INTO alarms (id, tenant_id, alarm_key, category, title, status, created_at) VALUES ('ret107-a-open-old', '${T1}', 'ret107-k2', 'TEST', 'a2', 'OPEN', ${ago(800)})`);
  sql.push(`INSERT INTO alarms (id, tenant_id, alarm_key, category, title, status, resolved_at, created_at) VALUES ('ret107-a-res-100', '${T1}', 'ret107-k3', 'TEST', 'a3', 'RESOLVED', ${ago(100)}, ${ago(150)})`);
  // Alarm olayları (365): AÇIK alarmın 500 günlük olayı KORUNUR; çözülmüşün 500 günlüğü, yetim olay silinir; 100 günlük korunur.
  for (const [id, alarm, d] of [['e-open-500', 'ret107-a-open-old', 500], ['e-res-old-500', 'ret107-a-res-old', 500], ['e-orphan-500', 'ret107-a-gone', 500], ['e-res100-100', 'ret107-a-res-100', 100], ['e-res100-500', 'ret107-a-res-100', 500]] as const) {
    sql.push(`INSERT INTO alarm_events (id, tenant_id, alarm_id, occurred_at) VALUES ('ret107-${id}', '${T1}', '${alarm}', ${ago(d)})`);
  }
  // Denetim günlüğü (1825): 2 eski silinir, 1000 günlük korunur.
  for (const [id, d] of [['au-2000a', 2000], ['au-2000b', 2001], ['au-1000', 1000]] as const) {
    sql.push(`INSERT INTO audit_logs (id, tenant_id, action, created_at) VALUES ('ret107-${id}', '${T1}', 'RET107_FIXTURE', ${ago(d)})`);
  }
  // Cihaz varlık olayları: tenant ayarı 90 gün → 100 ve 400 günlük silinir, 80 günlük korunur.
  for (const [id, d] of [['d-100', 100], ['d-80', 80], ['d-400', 400]] as const) {
    sql.push(`INSERT INTO device_presence_events (id, tenant_id, device_id, status, occurred_at) VALUES ('ret107-${id}', '${T1}', 'DEV-RET107', 'OFFLINE', ${ago(d)})`);
  }
  sql.push(`INSERT INTO tenant_retention_settings (tenant_id, data_class, retention_days) VALUES ('${T1}', 'DEVICE_PRESENCE', 90)`);
  // Sürücü skoru (730): 800 gün silinir, 100 gün korunur.
  for (const [id, d] of [['s-800', 800], ['s-100', 100]] as const) {
    sql.push(`INSERT INTO driver_behavior_scores (id, tenant_id, driver_name, period_days, transaction_count, score, computed_at) VALUES ('ret107-${id}', '${T1}', 'Test Sürücü', 30, 5, 80, ${ago(d)})`);
  }
  // Rapor teslimi (365): file_data ARŞİVE ALINMAZ.
  sql.push(`INSERT INTO report_schedules (id, tenant_id, report_id, period_type, recipient_user_ids, created_by, next_run_at) VALUES ('ret107-sch', '${T1}', 'rep-711', 'DAILY', '{}', 'x', NOW())`);
  sql.push(`INSERT INTO report_deliveries (id, tenant_id, schedule_id, period_key, status, file_data, created_at) VALUES ('ret107-rd-old', '${T1}', 'ret107-sch', '2025-01', 'GÖNDERILDI', '\\x0102030405', ${ago(400)})`);
  // MALİ KAYITLAR (asla silinmez): 12 yıllık + 400 günlük ikmal, eski fire kaydı.
  sql.push(`INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, amount_liters, created_at) VALUES ('ret107-tx-12y', '${T1}', 'S', 'PLT-1', 100, ${ago(12 * 365)})`);
  sql.push(`INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, amount_liters, created_at) VALUES ('ret107-tx-400d', '${T1}', 'S', 'PLT-2', 50, ${ago(400)})`);
  sql.push(`INSERT INTO fire_records (id, tenant_id, tank_id, tank_name, site_name, record_date, quantity_liters, variance_direction, classification, created_by, created_at)
            VALUES ('ret107-fire', '${T1}', 't', 'T', 'S', '2015-01-01', 5, 'KAYIP', 'FIRE', 'x', ${ago(3000)})`);
  // T2: çapraz alım red kayıtları (365) + bildirimler (tenant ayarı 5 gün — API tabanının ALTINDA, doğrudan SQL ile).
  for (const id of ['c-1', 'c-2', 'c-3']) {
    sql.push(`INSERT INTO cross_site_denials (id, tenant_id, vehicle_plate, target_site, reason, source, occurred_at) VALUES ('ret107-${id}', '${T2}', 'P', 'S', 'NO_SITE_PERMISSION', 'DEVICE', ${ago(400)})`);
  }
  sql.push(`INSERT INTO notifications (id, tenant_id, event_type, title, body, status, created_at) VALUES ('ret107-2-n-20d', '${T2}', 'TEST', 't', 'b', 'GÖNDERILDI', ${ago(20)})`);
  sql.push(`INSERT INTO notifications (id, tenant_id, event_type, title, body, status, created_at) VALUES ('ret107-2-n-40d', '${T2}', 'TEST', 't', 'b', 'GÖNDERILDI', ${ago(40)})`);
  sql.push(`INSERT INTO tenant_retention_settings (tenant_id, data_class, retention_days) VALUES ('${T2}', 'NOTIFICATION', 5)`);
  const c = pg(); await c.connect();
  try { for (const s of sql) await c.query(s); } finally { await c.end(); }
}

const ids = async (table: string, tenant: string, like = 'ret107-%'): Promise<string[]> =>
  (await q(`SELECT id FROM ${table} WHERE tenant_id = $1 AND id LIKE $2 ORDER BY id`, [tenant, like])).map((r) => r.id);

async function run() {
  console.log('===========================================================');
  console.log('🧪 [ARCH-107] VERİ SAKLAMA (RETENTION) POLİTİKASI + PURGE');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };

  await cleanup();
  try {
    // ── 1. Katalog: şemadaki HER tablo tam olarak bir sınıfta (unutulan tablo CI'ı kırar) ──────────────────────────
    const schema = fs.readFileSync(path.join(process.cwd(), 'src/db/schema.sql'), 'utf8');
    const tables = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\);/g)].map((m) => ({ name: m[1], body: m[2] }));
    const unclassified = tables.filter((t) => classifyTable(t.name) === null).map((t) => t.name);
    const catalogNames = [...PURGEABLE_CLASSES.map((c) => c.table), ...Object.keys(PROTECTED_TABLES), ...Object.keys(MANAGED_TABLES), ...MASTER_TABLES];
    const stale = catalogNames.filter((n) => !tables.some((t) => t.name === n));
    const dupes = catalogNames.filter((n, i) => catalogNames.indexOf(n) !== i);
    const badCols = PURGEABLE_CLASSES.filter((c) => !new RegExp(`\\b${c.timestampColumn}\\b`).test(tables.find((t) => t.name === c.table)?.body ?? '')).map((c) => c.dataClass);
    check(`Katalog: schema.sql'deki ${tables.length} tablonun HEPSİ sınıflandırılmış (PURGEABLE ${PURGEABLE_CLASSES.length} / PROTECTED ${Object.keys(PROTECTED_TABLES).length} / MANAGED / MASTER); katalogda olmayan tablo, iki sınıflı tablo ve var olmayan zaman sütunu YOK`,
      unclassified.length === 0 && stale.length === 0 && dupes.length === 0 && badCols.length === 0, `sınıflandırılmamış=[${unclassified}], bayat=[${stale}], çift=[${dupes}], kötü sütun=[${badCols}]`);
    check('Katalog (AC: mali kayıt asla silinmez): transactions, e-İrsaliye, fire, kalibrasyon, alım irsaliyesi vb. PROTECTED; hiçbir PURGEABLE tablo PROTECTED değil; her PURGEABLE sınıf için taban ≤ varsayılan ≤ 3650',
      ['transactions', 'despatch_advice_documents', 'despatch_advice_transmissions', 'fuel_intake_receipts', 'fire_records', 'calibration_commands', 'stock_reconciliations', 'platform_audit_log'].every((t) => t in PROTECTED_TABLES) &&
        PURGEABLE_CLASSES.every((c) => !(c.table in PROTECTED_TABLES) && c.minDays <= c.defaultDays && c.defaultDays <= 3650) && PROTECTED_TABLES.transactions.minYears === 10, '');
    const indexTs = fs.readFileSync(path.join(process.cwd(), 'src/index.ts'), 'utf8');
    check('Zamanlanmış iş: index.ts günlük retention süpürücüsünü kurar (runRetentionPurge) ve kapanışta temizler',
      /runRetentionPurge\(\)/.test(indexTs) && /RETENTION_PURGE_SWEEP_MS = 24 \* 60 \* 60 \* 1000/.test(indexTs) && /clearInterval\(retentionPurgeSweepInterval\)/.test(indexTs), '');

    // ── 2. Politika API: yetki, doğrulama, denetim ─────────────────────────────────────────────────────────────────
    const owner = await login('camsa');
    const admin = await login('admin');
    const op = await login('pompa-op-01');
    const noAuth = await call('GET', '/retention/policies');
    const opGet = await call('GET', '/retention/policies', { token: op });
    const opRun = await call('POST', '/admin/retention/run', { token: owner, body: { dryRun: true } });
    check('RBAC: kimliksiz → 401; PUMP_OPERATOR → 403; COMPANY_OWNER elle purge çalıştıramaz (yalnızca SUPER_ADMIN) → 403',
      noAuth.status === 401 && opGet.status === 403 && opRun.status === 403, `${noAuth.status}/${opGet.status}/${opRun.status}`);

    const g = await call('GET', '/retention/policies', { token: owner });
    const notif = g.body.data?.purgeable?.find((p: any) => p.dataClass === 'NOTIFICATION');
    check('GET /retention/policies: her PURGEABLE sınıf için varsayılan/taban/etkin süre (varsayılan = etkin, özelleştirilmemiş); mali tablolar korumalı listede; harici sınıflar (ham telemetri, sistem logu) belgeli',
      g.status === 200 && g.body.data.purgeable.length === PURGEABLE_CLASSES.length && notif?.defaultDays === 180 && notif?.minDays === 30 && notif?.effectiveDays === 180 && notif?.customized === false &&
        g.body.data.protected.some((p: any) => p.table === 'transactions' && p.minYears === 10) && g.body.data.external.some((e: any) => e.dataClass === 'RAW_TELEMETRY') && g.body.data.external.some((e: any) => e.dataClass === 'SYSTEM_LOG'),
      JSON.stringify(notif));

    const p45 = await call('PATCH', '/retention/policies/NOTIFICATION', { token: owner, body: { retentionDays: 45 } });
    const g2 = await call('GET', '/retention/policies', { token: owner });
    const audit1 = await q(`SELECT before_value, after_value FROM audit_logs WHERE tenant_id = $1 AND action = 'RETENTION_POLICY_UPDATED' AND target_id = 'NOTIFICATION' AND created_at >= $2`, [CAMSA, started]);
    check('PATCH: tenant saklama süresi ayarlanır (AC: yapılandırılabilir) → etkin 45, özelleştirilmiş; değişiklik audit log\'a önceki/sonraki değerle yazılır',
      p45.status === 200 && p45.body.data.effectiveDays === 45 && p45.body.data.customized === true && g2.body.data.purgeable.find((p: any) => p.dataClass === 'NOTIFICATION').effectiveDays === 45 &&
        audit1.length === 1 && audit1[0].before_value.retentionDays === null && audit1[0].after_value.retentionDays === 45, JSON.stringify(audit1));
    const cases: Array<[string, number | string | null, number]> = [['NOTIFICATION', 10, 400], ['NOTIFICATION', 4000, 400], ['NOTIFICATION', 45.5, 400], ['NOTIFICATION', 'x', 400], ['AUDIT_LOG', 100, 400], ['transactions', 30, 400], ['TRANSACTION', 30, 400], ['NOPE', 30, 404]];
    const rs: number[] = [];
    for (const [cls, days] of cases) rs.push((await call('PATCH', `/retention/policies/${cls}`, { token: owner, body: { retentionDays: days } })).status);
    const protectedMsg = (await call('PATCH', '/retention/policies/transactions', { token: owner, body: { retentionDays: 30 } })).body.message as string;
    check('Doğrulama: taban altı (10<30, audit 100<730), 3650 üstü, ondalık, sayı-olmayan → 400; MALİ KAYIT (transactions/TRANSACTION) için ayar reddedilir (400, "otomatik silinmez"); bilinmeyen sınıf → 404',
      JSON.stringify(rs) === JSON.stringify(cases.map((c) => c[2])) && /otomatik silinmez/.test(protectedMsg), `${rs} — ${protectedMsg}`);
    const reset = await call('PATCH', '/retention/policies/NOTIFICATION', { token: owner, body: { retentionDays: null } });
    check('PATCH null: özelleştirme kaldırılır → varsayılan (180) geri gelir', reset.status === 200 && reset.body.data.effectiveDays === 180 && reset.body.data.customized === false, JSON.stringify(reset.body.data));

    // ── 3. Purge (T1) ──────────────────────────────────────────────────────────────────────────────────────────────
    await seed();
    const beforeCounts = {
      notif: (await ids('notifications', T1)).length, alarms: (await ids('alarms', T1)).length, events: (await ids('alarm_events', T1)).length,
      audit: (await ids('audit_logs', T1)).length, presence: (await ids('device_presence_events', T1)).length, scores: (await ids('driver_behavior_scores', T1)).length
    };
    check('Fixture: T1 (notif 7, alarm 3, olay 5, audit 3, varlık 3, skor 2)', JSON.stringify(Object.values(beforeCounts)) === JSON.stringify([7, 3, 5, 3, 3, 2]), JSON.stringify(beforeCounts));

    // dry-run: HTTP (SUPER_ADMIN) — hiçbir şey silinmez, arşiv/audit yazılmaz.
    const dry = await call('POST', '/admin/retention/run', { token: admin, body: { dryRun: true, tenantId: T1 } });
    const dryMap = Object.fromEntries((dry.body.data?.results ?? []).map((r: any) => [r.dataClass, r.rows]));
    const afterDry = { archives: (await q('SELECT COUNT(*)::int n FROM retention_archives WHERE tenant_id = $1', [T1]))[0].n, notif: (await ids('notifications', T1)).length, purgeAudits: (await q(`SELECT COUNT(*)::int n FROM audit_logs WHERE tenant_id = $1 AND action = 'RETENTION_PURGE'`, [T1]))[0].n };
    check('dryRun (SUPER_ADMIN, HTTP): silinecek satırlar HESAPLANIR — AUDIT_LOG 2, NOTIFICATION 3 (bekleyen/başarısız hariç), ALARM 1 (açık hariç), ALARM_EVENT 3 (açık alarmın olayı hariç), DEVICE_PRESENCE 2 (tenant ayarı 90 gün), DRIVER_SCORE 1, REPORT_DELIVERY 1 — ama hiçbir satır silinmez, arşiv/audit yazılmaz',
      dry.status === 200 && dry.body.data.dryRun === true && JSON.stringify(dryMap) === JSON.stringify({ AUDIT_LOG: 2, NOTIFICATION: 3, ALARM: 1, ALARM_EVENT: 3, DEVICE_PRESENCE: 2, REPORT_DELIVERY: 1, DRIVER_SCORE: 1 }) &&
        afterDry.archives === 0 && afterDry.notif === 7 && afterDry.purgeAudits === 0, `${JSON.stringify(dryMap)} ${JSON.stringify(afterDry)}`);

    // Gerçek çalıştırma: küçük parti (2) — birden çok parti + her partiye bir arşiv.
    const real = await call('POST', '/admin/retention/run', { token: admin, body: { tenantId: T1, batchSize: 2 } });
    const rmap: Record<string, any> = Object.fromEntries((real.body.data?.results ?? []).map((r: any) => [r.dataClass, r]));
    const batchInfo = Object.fromEntries(Object.entries(rmap).map(([k, v]: [string, any]) => [k, `${v.rows}/${v.batches}/${v.archives}`]));
    check('Purge (parti=2): silinen satır/parti/arşiv — AUDIT_LOG 2/1/1, NOTIFICATION 3/2/2, ALARM 1/1/1, ALARM_EVENT 3/2/2, DEVICE_PRESENCE 2/1/1, REPORT_DELIVERY 1/1/1, DRIVER_SCORE 1/1/1; iptal yok',
      real.status === 200 && JSON.stringify(batchInfo) === JSON.stringify({ AUDIT_LOG: '2/1/1', NOTIFICATION: '3/2/2', ALARM: '1/1/1', ALARM_EVENT: '3/2/2', DEVICE_PRESENCE: '2/1/1', REPORT_DELIVERY: '1/1/1', DRIVER_SCORE: '1/1/1' }) && real.body.data.results.every((r: any) => !r.cancelled), JSON.stringify(batchInfo));
    check('Kalan veri: koruma koşulları çalıştı — bekleyen/başarısız bildirim, AÇIK alarm ve olayı, süresi dolmamış kayıtlar durur',
      JSON.stringify(await ids('notifications', T1)) === JSON.stringify(['ret107-n-100d', 'ret107-n-10d', 'ret107-n-old-failed', 'ret107-n-old-pending']) &&
        JSON.stringify(await ids('alarms', T1)) === JSON.stringify(['ret107-a-open-old', 'ret107-a-res-100']) &&
        JSON.stringify(await ids('alarm_events', T1)) === JSON.stringify(['ret107-e-open-500', 'ret107-e-res100-100']) &&
        JSON.stringify(await ids('audit_logs', T1, 'ret107-au-%')) === JSON.stringify(['ret107-au-1000']) &&
        JSON.stringify(await ids('device_presence_events', T1)) === JSON.stringify(['ret107-d-80']) &&
        JSON.stringify(await ids('driver_behavior_scores', T1)) === JSON.stringify(['ret107-s-100']) && (await ids('report_deliveries', T1)).length === 0,
      JSON.stringify({ n: await ids('notifications', T1), a: await ids('alarms', T1), e: await ids('alarm_events', T1) }));

    // AC: arşiv ZORUNLU — her parti için şifreli arşiv, silinen satırların TAMAMINI içerir, bütünlük doğrulanır.
    const archives = await q('SELECT * FROM retention_archives WHERE tenant_id = $1 ORDER BY created_at, id', [T1]);
    const byClass = (cls: string) => archives.filter((a) => a.data_class === cls);
    const decoded = (a: any) => decryptRetentionArchive(a.file_data, a.sha256);
    const notifIds = byClass('NOTIFICATION').flatMap((a) => decoded(a).rows.map((r: any) => r.id)).sort();
    const notifBatches = byClass('NOTIFICATION').map((a) => a.row_count).sort();
    const rdArchive = byClass('REPORT_DELIVERY').map(decoded)[0];
    const auArchiveIds = byClass('AUDIT_LOG').flatMap((a) => decoded(a).rows.map((r: any) => r.id)).sort();
    const h = decoded(byClass('ALARM')[0]).header;
    check('Arşiv (AC: purge öncesi zorunlu): 9 arşiv (parti başına bir); NOTIFICATION arşivleri silinen 3 satırın TAMAMINI (id + içerik) taşır (2+1 satırlık partiler); AUDIT_LOG 2 satır; başlık (sınıf/tablo/tenant/eşik/süre) doğru; sha256 doğrulanır',
      archives.length === 9 && JSON.stringify(notifIds) === JSON.stringify(['ret107-n-old-1', 'ret107-n-old-2', 'ret107-n-old-3']) && JSON.stringify(notifBatches) === JSON.stringify([1, 2]) &&
        JSON.stringify(auArchiveIds) === JSON.stringify(['ret107-au-2000a', 'ret107-au-2000b']) && h.dataClass === 'ALARM' && h.table === 'alarms' && h.tenantId === T1 && h.retentionDays === 730 && h.rowCount === 1 &&
        decoded(byClass('NOTIFICATION')[0]).rows[0].title === 'başlık', `arşiv=${archives.length}, notif=${notifIds}`);
    check('Arşiv: ağır/yeniden üretilebilir sütun (report_deliveries.file_data) arşive ALINMAZ; diğer sütunlar (status, period_key) alınır',
      !!rdArchive && rdArchive.rows.length === 1 && !('file_data' in rdArchive.rows[0]) && rdArchive.rows[0].status === 'GÖNDERILDI' && rdArchive.rows[0].period_key === '2025-01', JSON.stringify(rdArchive?.rows[0]).slice(0, 200));
    const raw: Buffer = byClass('NOTIFICATION')[0].file_data;
    const tampered = Buffer.from(raw); tampered[tampered.length - 1] ^= 0x01;
    let tamperErr = ''; try { decryptRetentionArchive(tampered); } catch (e: any) { tamperErr = e.message; }
    let shaErr = ''; try { decryptRetentionArchive(raw, '0'.repeat(64)); } catch (e: any) { shaErr = e.message; }
    check('Arşiv güvenliği: içerik AES-256-GCM ile şifreli (düz gzip/JSON değil, satır içeriği görünmez); tek bit değişikliği açılışı reddeder; yanlış sha256 reddedilir',
      !(raw[0] === 0x1f && raw[1] === 0x8b) && !raw.toString('latin1').includes('başlık') && !raw.toString('latin1').includes('ret107-n-old') && tamperErr !== '' && /bütünlük/.test(shaErr), `tamper="${tamperErr.slice(0, 40)}" sha="${shaErr.slice(0, 40)}"`);

    // AC: silme kaydı audit log'a yazılır (her parti bir kayıt, arşivle eşleşir).
    const purgeAudits = await q(`SELECT target_id, target_type, after_value FROM audit_logs WHERE tenant_id = $1 AND action = 'RETENTION_PURGE' ORDER BY created_at`, [T1]);
    const archiveIds = new Set(archives.map((a) => a.id));
    const auditRows = purgeAudits.reduce((s, a) => s + a.after_value.rowCount, 0);
    check('Audit (AC): her parti için RETENTION_PURGE kaydı (9) — hedef=sınıf, satır sayısı, eşik, arşiv id\'si; arşivlerle bire bir eşleşir; toplam 13 satır (2+3+1+3+2+1+1)',
      purgeAudits.length === 9 && purgeAudits.every((a) => archiveIds.has(a.after_value.archiveId)) && new Set(purgeAudits.map((a) => a.after_value.archiveId)).size === 9 && auditRows === 13,
      `${purgeAudits.length} kayıt, toplam satır=${auditRows}`);

    // ── 4. Mali kayıt koruması: yıl 2100'de bile ─────────────────────────────────────────────────────────────────────
    const far = await runRetentionPurge({ tenantId: T1, now: new Date('2100-01-01T00:00:00Z'), batchSize: 50 });
    const farClasses = far.results.map((r) => r.dataClass).sort();
    check('AC (mali kayıtlar HİÇBİR koşulda silinmez): now=2100 ile purge — süresi dolan her şey gider ama 12 yıllık + 400 günlük ikmal (transactions) ve eski fire kaydı DURUR; hiçbir sonuç PROTECTED tabloya ait değil',
      JSON.stringify(await ids('transactions', T1)) === JSON.stringify(['ret107-tx-12y', 'ret107-tx-400d']) && JSON.stringify(await ids('fire_records', T1)) === JSON.stringify(['ret107-fire']) &&
        far.results.every((r) => PURGEABLE_CLASSES.some((c) => c.dataClass === r.dataClass)) && farClasses.includes('NOTIFICATION') && farClasses.includes('ALARM'), `sonuç sınıfları=${farClasses}`);
    check('Koruma koşulları 2100\'de de geçerli: bekleyen/başarısız bildirim ve AÇIK alarm + olayı silinmez (yaş değil DURUM belirler); geri kalan eskiler gider',
      JSON.stringify(await ids('notifications', T1)) === JSON.stringify(['ret107-n-old-failed', 'ret107-n-old-pending']) && JSON.stringify(await ids('alarms', T1)) === JSON.stringify(['ret107-a-open-old']) &&
        JSON.stringify(await ids('alarm_events', T1)) === JSON.stringify(['ret107-e-open-500']), '');

    // ── 5. Arşiv başarısızsa purge İPTAL (T2) ────────────────────────────────────────────────────────────────────────
    await q(`CREATE FUNCTION ret107_fail_archive_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id = '${T2}' THEN RAISE EXCEPTION 'ret107 arşiv yazılamadı'; END IF; RETURN NEW; END $$`);
    await q('CREATE TRIGGER ret107_fail_archive BEFORE INSERT ON retention_archives FOR EACH ROW EXECUTE FUNCTION ret107_fail_archive_fn()');
    // Önce: başka bir örnek turu tutuyorsa (advisory lock) bu örnek atlar.
    const holder = pg(); await holder.connect();
    await holder.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_KEY]);
    const locked = await runRetentionPurge({ tenantId: T2 });
    await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]); await holder.end();
    check('Çoklu replika: tur kilidi başka örnekte tutuluyorsa bu örnek ATLAR (skippedLocked, hiçbir satır işlenmez); kilit bırakılınca çalışır',
      locked.skippedLocked === true && locked.results.length === 0 && (await ids('cross_site_denials', T2)).length === 3, '');
    const failed = await runRetentionPurge({ tenantId: T2, batchSize: 2 });
    const fSummary = Object.fromEntries(failed.results.map((r) => [r.dataClass, { rows: r.rows, cancelled: !!r.cancelled }]));
    const t2Archives = (await q('SELECT COUNT(*)::int n FROM retention_archives WHERE tenant_id = $1', [T2]))[0].n;
    const t2PurgeAudit = (await q(`SELECT COUNT(*)::int n FROM audit_logs WHERE tenant_id = $1 AND action = 'RETENTION_PURGE'`, [T2]))[0].n;
    check('AC (arşiv üretilemezse purge iptal): arşiv yazımı hata verince silme GERİ ALINIR — 3 red kaydı + 40 günlük bildirim yerinde, arşiv/RETENTION_PURGE audit satırı yok; sonuçta iptal sebebi raporlanır',
      failed.results.length >= 1 && failed.results.every((r) => r.cancelled && r.rows === 0 && /arşiv yazılamadı/.test(r.cancelled)) && (await ids('cross_site_denials', T2)).length === 3 &&
        (await ids('notifications', T2)).length === 2 && t2Archives === 0 && t2PurgeAudit === 0, JSON.stringify(fSummary));
    await q('DROP TRIGGER ret107_fail_archive ON retention_archives');
    const ok = await runRetentionPurge({ tenantId: T2, batchSize: 2 });
    check('Hata giderilince aynı satırlar bir sonraki turda arşivlenip silinir (kalıcı kayıp/atlanma yok): 3 red kaydı → 2 parti/2 arşiv',
      (await ids('cross_site_denials', T2)).length === 0 && ok.results.find((r) => r.dataClass === 'CROSS_SITE_DENIAL')?.batches === 2 && ok.results.find((r) => r.dataClass === 'CROSS_SITE_DENIAL')?.archives === 2, JSON.stringify(ok.results.map((r) => [r.dataClass, r.rows, r.batches])));
    check('Taban koruması: tenant ayarı tabanın altında (5 gün, API dışı SQL ile) yazılmış olsa da purge tabanı (30 gün) uygular — 20 günlük bildirim KALIR, 40 günlük gider',
      JSON.stringify(await ids('notifications', T2)) === JSON.stringify(['ret107-2-n-20d']) && ok.results.find((r) => r.dataClass === 'NOTIFICATION')?.retentionDays === 30, '');

    // ── 6. İzolasyon: T2 çalıştırması T1'e, T1 çalıştırması T2'ye dokunmaz; arşivler tenant'a ait ─────────────────────
    const listApi = await call('GET', '/retention/archives', { token: owner });
    check('Arşiv listesi API: yalnızca çağıran tenant\'ın arşivleri (T1/T2 arşivleri comp-camsa\'da GÖRÜNMEZ), dosya içeriği DÖNMEZ',
      listApi.status === 200 && Array.isArray(listApi.body.data) && listApi.body.data.every((a: any) => !archiveIds.has(a.id) && !('file_data' in a)), `camsa arşiv=${listApi.body.data?.length}`);
  } finally {
    await cleanup();
    await redis.quit();
  }
  console.log('===========================================================');
  console.log(`📊 SONUÇ: ${passed} / ${total} TEST BAŞARILI`);
  console.log('===========================================================');
  process.exit(passed === total ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
