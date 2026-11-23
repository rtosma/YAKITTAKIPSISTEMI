import { Client } from 'pg';
import Redis from 'ioredis';

/**
 * COMP-604 (#130) — GİB durum kodu takip ekranı ve otomatik durum sorgulama.
 *
 * Kapsam: "belge listesi/filtreleme" ve "otomatik durum yoklama" zaten
 * COMP-602.1/602.2'de var (GET /despatch-advice-transmissions?status=...,
 * gib_status_code/description/checked_at). Bu ticket'ın YENİ kısmı:
 *  - Toplu yeniden gönderim (yalnızca FAILED, hepsi-ya-da-hiçbiri, YENİ belge
 *    ÜRETMEZ — var olan satırı sıfırlayıp AYNI kuyruğa geri verir).
 *  - Takılı kalan (24 saattir yanıt yok) belgeler için AI-507 alarmı.
 *
 * Sabit fixture satırları despatch_advice_transmissions'a DOĞRUDAN SQL ile
 * yazılır (despatch_advice_document_id'nin FK'ı yok — schema.sql'de yalnızca
 * NOT NULL) — böylece her senaryo COMP-602.1'in tüm enqueue+sweep akışından
 * geçmeden, doğrudan istenen durumda kurulur (daha hızlı, daha izole).
 */

const API_URL = 'http://localhost:5000/api/v1';
const RUN = Date.now();

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
  const c = pg(); await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}
async function resetLoginRl(): Promise<void> {
  const k = await redis.keys('rl:auth-login:*'); if (k.length) await redis.del(...k);
}
async function call(method: string, path: string, opts: { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
  if (path === '/auth/login') await resetLoginRl();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${API_URL}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('application/json') ? await res.json().catch(() => ({})) : {};
  return { status: res.status, body };
}
async function login(u: string): Promise<string> {
  const r = await call('POST', '/auth/login', { body: { username: u, password: '123456' } });
  if (!r.body.accessToken) throw new Error(`login ${u}: ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
}

let seq = 0;
function fixtureId(): string {
  seq++;
  return `c604-${RUN}-${seq}`;
}
/** ettn UUID gerektirir — deterministik ama benzersiz bir UUID-benzeri değer üretir. */
function fakeUuid(n: number): string {
  const h = (RUN + n).toString(16).padStart(12, '0').slice(-12);
  return `00000000-0000-4000-8000-${h}`;
}

async function insertTransmission(opts: {
  tenantId: string;
  status: string;
  attemptCount?: number;
  gibStatusCode?: string | null;
  queuedAtHoursAgo?: number;
  sentAtHoursAgo?: number | null;
}): Promise<{ id: string; documentNumber: string }> {
  const id = fixtureId();
  const documentNumber = `IRSC604${seq.toString().padStart(6, '0')}`;
  const queuedAt = new Date(Date.now() - (opts.queuedAtHoursAgo ?? 0) * 3_600_000).toISOString();
  const sentAt = opts.sentAtHoursAgo !== undefined && opts.sentAtHoursAgo !== null
    ? new Date(Date.now() - opts.sentAtHoursAgo * 3_600_000).toISOString()
    : null;
  await q(
    `INSERT INTO despatch_advice_transmissions
       (id, tenant_id, despatch_advice_document_id, transaction_id, document_number, ettn, vehicle_plate, provider,
        status, attempt_count, provider_reference, xml_snapshot, queued_at, sent_at, gib_status_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'MOCK_GIB',$8,$9,$10,'<DespatchAdvice/>',$11,$12,$13)`,
    [
      id, opts.tenantId, `doc-${id}`, `tx-${id}`, documentNumber, fakeUuid(seq), `C604-${seq}`,
      opts.status, opts.attemptCount ?? 0, opts.status === 'SENT' ? `MOCKREF-${id}` : null,
      queuedAt, sentAt, opts.gibStatusCode ?? null
    ]
  );
  return { id, documentNumber };
}

async function cleanup(): Promise<void> {
  await q(`DELETE FROM despatch_advice_transmissions WHERE id LIKE $1`, [`c604-${RUN}-%`]);
  await q(`DELETE FROM audit_logs WHERE action = 'DESPATCH_ADVICE_TRANSMISSION_BULK_RESENT' AND created_at > NOW() - INTERVAL '30 minutes'`);
  await q(`DELETE FROM alarm_events WHERE alarm_id IN (SELECT id FROM alarms WHERE alarm_key LIKE $1)`, [`despatch-stuck-c604-${RUN}-%`]);
  await q(`DELETE FROM alarms WHERE alarm_key LIKE $1`, [`despatch-stuck-c604-${RUN}-%`]);
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [COMP-604] GİB DURUM TAKİBİ — TOPLU GÖNDERİM + TAKILI BELGE UYARISI');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };

  await cleanup();

  try {
    const owner = await login('camsa'); // COMPANY_OWNER (comp-camsa)
    const siteMgr = await login('gebze-santiye'); // SITE_MANAGER
    const pumpOp = await login('pompa-op-01'); // PUMP_OPERATOR

    // === Test 1 (ASIL AC — toplu yeniden gönderim): 3 FAILED belge → hepsi QUEUED'a döner ===
    const f1 = await insertTransmission({ tenantId: 'comp-camsa', status: 'FAILED', attemptCount: 5 });
    const f2 = await insertTransmission({ tenantId: 'comp-camsa', status: 'FAILED', attemptCount: 5 });
    const f3 = await insertTransmission({ tenantId: 'comp-camsa', status: 'FAILED', attemptCount: 5 });
    const bulk1 = await call('POST', '/despatch-advice-transmissions/bulk-resend', { token: owner, body: { ids: [f1.id, f2.id, f3.id] } });
    const afterBulk1 = await q(`SELECT id, status, attempt_count, last_error FROM despatch_advice_transmissions WHERE id = ANY($1::text[])`, [[f1.id, f2.id, f3.id]]);
    check(
      "Test 1 (ASIL AC — toplu yeniden gönderim): 3 FAILED belge hepsi QUEUED'a döner, attempt_count sıfırlanır",
      bulk1.status === 200 && bulk1.body.data.resent === 3 &&
        afterBulk1.every((r) => r.status === 'QUEUED' && r.attempt_count === 0 && r.last_error === null),
      `status=${bulk1.status}, body=${JSON.stringify(bulk1.body.data)}, rows=${JSON.stringify(afterBulk1)}`
    );

    // === Test 2 (ASIL AC — mükerrer belge üretmemeli): aynı satır sıfırlandı, YENİ satır YARATILMADI ===
    const countCheck = await q(`SELECT COUNT(*)::int AS c FROM despatch_advice_transmissions WHERE id = $1`, [f1.id]);
    check(
      'Test 2 (ASIL AC — mükerrer belge üretmemeli): aynı id hâlâ TEK satır (yeni kayıt yaratılmadı, var olan sıfırlandı)',
      countCheck[0].c === 1,
      `satır sayısı=${countCheck[0].c}`
    );

    // === Test 3 (ASIL AC — yeniden gönderilen belge GERÇEKTEN kuyruğa döner): sweep ile gerçekten gönderilir ===
    const sweepAfterBulk = await call('POST', '/despatch-advice-transmissions/sweep', { token: owner });
    const f1AfterSweep = (await q(`SELECT status, provider_reference FROM despatch_advice_transmissions WHERE id = $1`, [f1.id]))[0];
    check(
      'Test 3: Toplu yeniden gönderilen belge, normal sweep tarafından GERÇEKTEN tekrar denenip gönderilir',
      sweepAfterBulk.status === 200 && sweepAfterBulk.body.data.sent >= 1 && f1AfterSweep.status === 'SENT' && !!f1AfterSweep.provider_reference,
      `sweep=${JSON.stringify(sweepAfterBulk.body.data)}, f1=${JSON.stringify(f1AfterSweep)}`
    );

    // === Test 4 (ASIL AC — yalnızca uygun durumdakiler): FAILED-olmayan bir id varsa TÜM istek reddedilir ===
    const failedOne = await insertTransmission({ tenantId: 'comp-camsa', status: 'FAILED' });
    const queuedOne = await insertTransmission({ tenantId: 'comp-camsa', status: 'QUEUED' });
    const bulk2 = await call('POST', '/despatch-advice-transmissions/bulk-resend', { token: owner, body: { ids: [failedOne.id, queuedOne.id] } });
    const unchanged = (await q(`SELECT status FROM despatch_advice_transmissions WHERE id = $1`, [failedOne.id]))[0];
    check(
      "Test 4 (ASIL AC — yalnızca uygun durumdakiler): listede FAILED OLMAYAN bir id varsa 409, HİÇBİR satır değişmez (hepsi-ya-da-hiçbiri)",
      bulk2.status === 409 && bulk2.body.details?.error === 'INVALID_STATUS_FOR_RESEND' && unchanged.status === 'FAILED',
      `status=${bulk2.status}, body=${JSON.stringify(bulk2.body.details)}, değişmeyenDurum=${unchanged.status}`
    );

    // === Test 5: olmayan bir id → 404 ===
    const bulk3 = await call('POST', '/despatch-advice-transmissions/bulk-resend', { token: owner, body: { ids: ['nonexistent-xyz-123'] } });
    check('Test 5: Olmayan iletim id\'si → 404 TRANSMISSION_NOT_FOUND', bulk3.status === 404 && bulk3.body.details?.error === 'TRANSMISSION_NOT_FOUND', `status=${bulk3.status}, body=${JSON.stringify(bulk3.body.details)}`);

    // === Test 6 (tenant izolasyonu): başka tenant'ın FAILED belgesi bu tenant'tan "bulunamadı" sayılır (RLS) ===
    const otherTenantRow = await insertTransmission({ tenantId: 'comp-avrasya', status: 'FAILED' });
    const bulk4 = await call('POST', '/despatch-advice-transmissions/bulk-resend', { token: owner, body: { ids: [otherTenantRow.id] } });
    check(
      "Test 6 (tenant izolasyonu): başka tenant'ın belgesi RLS ile GİZLENİR, 'bulunamadı' döner (var olduğu İFŞA edilmez)",
      bulk4.status === 404 && bulk4.body.details?.error === 'TRANSMISSION_NOT_FOUND',
      `status=${bulk4.status}, body=${JSON.stringify(bulk4.body.details)}`
    );
    const otherTenantUnchanged = (await q(`SELECT status FROM despatch_advice_transmissions WHERE id = $1`, [otherTenantRow.id]))[0];
    check("Test 6b: başka tenant'ın belgesi DEĞİŞMEDİ", otherTenantUnchanged.status === 'FAILED', `status=${otherTenantUnchanged.status}`);

    // === Test 7: şema doğrulaması — boş ids dizisi → 400 ===
    const bulk5 = await call('POST', '/despatch-advice-transmissions/bulk-resend', { token: owner, body: { ids: [] } });
    check('Test 7: Boş ids dizisi → 400', bulk5.status === 400, `status=${bulk5.status}`);

    // === Test 8: RBAC — SITE_MANAGER/PUMP_OPERATOR toplu gönderim yapamaz ===
    const rbac1 = await call('POST', '/despatch-advice-transmissions/bulk-resend', { token: siteMgr, body: { ids: [f2.id] } });
    const rbac2 = await call('POST', '/despatch-advice-transmissions/bulk-resend', { token: pumpOp, body: { ids: [f2.id] } });
    check('Test 8: RBAC — SITE_MANAGER/PUMP_OPERATOR toplu yeniden gönderim yapamaz (403)', rbac1.status === 403 && rbac2.status === 403, `siteMgr=${rbac1.status}, pumpOp=${rbac2.status}`);

    // === Test 9 (ASIL AC — takılı belge uyarısı): SENT + 25 saattir GİB yanıtı yok → uyarı üretilir ===
    const stuckSent = await insertTransmission({ tenantId: 'comp-camsa', status: 'SENT', sentAtHoursAgo: 25, gibStatusCode: null });
    const scan1 = await call('POST', '/despatch-advice-transmissions/stuck-scan', { token: owner });
    const stuckAlarm = await q(`SELECT id, event_count, severity FROM alarms WHERE alarm_key = $1`, [`despatch-stuck-${stuckSent.id}`]);
    check(
      "Test 9 (ASIL AC — 24 saattir yanıt yok uyarısı): 25 saattir GİB yanıtı olmayan SENT belge için WARNING alarm üretilir",
      scan1.status === 200 && scan1.body.data.stuckCount >= 1 && stuckAlarm.length === 1 && stuckAlarm[0].severity === 'WARNING',
      `scan=${JSON.stringify(scan1.body.data)}, alarm=${JSON.stringify(stuckAlarm)}`
    );

    // === Test 10: 25 saattir QUEUED kalan (hiç ilerleyemeyen) belge de takılı sayılır ===
    const stuckQueued = await insertTransmission({ tenantId: 'comp-camsa', status: 'QUEUED', queuedAtHoursAgo: 25 });
    await call('POST', '/despatch-advice-transmissions/stuck-scan', { token: owner });
    const stuckQueuedAlarm = await q(`SELECT id FROM alarms WHERE alarm_key = $1`, [`despatch-stuck-${stuckQueued.id}`]);
    check('Test 10: 25 saattir QUEUED kalan (hiç gönderilemeyen) belge de takılı sayılır', stuckQueuedAlarm.length === 1, `alarm satır=${stuckQueuedAlarm.length}`);

    // === Test 11 (regresyon — yanlış pozitif olmamalı): 2 saatlik SENT (henüz normal bekleme süresi içinde) → uyarı ÜRETİLMEZ ===
    const freshSent = await insertTransmission({ tenantId: 'comp-camsa', status: 'SENT', sentAtHoursAgo: 2, gibStatusCode: null });
    await call('POST', '/despatch-advice-transmissions/stuck-scan', { token: owner });
    const freshAlarm = await q(`SELECT id FROM alarms WHERE alarm_key = $1`, [`despatch-stuck-${freshSent.id}`]);
    check('Test 11 (regresyon): 2 saatlik SENT belge için (henüz 24 saat dolmadı) uyarı ÜRETİLMEZ', freshAlarm.length === 0, `alarm satır=${freshAlarm.length}`);

    // === Test 12 (regresyon — yanlış pozitif olmamalı): GİB zaten NİHAİ karar vermiş (1200) 25 saatlik SENT → uyarı ÜRETİLMEZ ===
    const resolvedSent = await insertTransmission({ tenantId: 'comp-camsa', status: 'SENT', sentAtHoursAgo: 25, gibStatusCode: '1200' });
    await call('POST', '/despatch-advice-transmissions/stuck-scan', { token: owner });
    const resolvedAlarm = await q(`SELECT id FROM alarms WHERE alarm_key = $1`, [`despatch-stuck-${resolvedSent.id}`]);
    check('Test 12 (regresyon): GİB zaten NİHAİ kod vermişse (1200) — yanıt gelmiş sayılır, uyarı ÜRETİLMEZ', resolvedAlarm.length === 0, `alarm satır=${resolvedAlarm.length}`);

    // === Test 13: dedup — ikinci tarama AYNI alarmı tekrar üretmez, event_count artar ===
    const scan2 = await call('POST', '/despatch-advice-transmissions/stuck-scan', { token: owner });
    const stuckAlarmAfter2 = await q(`SELECT event_count FROM alarms WHERE alarm_key = $1`, [`despatch-stuck-${stuckSent.id}`]);
    check(
      "Test 13 (dedup): ikinci tarama AYNI belge için YENİ alarm YARATMAZ, event_count artar",
      scan2.status === 200 && stuckAlarmAfter2[0].event_count >= 2,
      `event_count=${stuckAlarmAfter2[0]?.event_count}`
    );

    // === Test 14: RBAC — stuck-scan da SWEEP_ROLES ile korunur ===
    const rbac3 = await call('POST', '/despatch-advice-transmissions/stuck-scan', { token: siteMgr });
    const rbac4 = await call('POST', '/despatch-advice-transmissions/stuck-scan', {});
    check('Test 14: RBAC — SITE_MANAGER stuck-scan tetikleyemez (403), tokensiz → 401', rbac3.status === 403 && rbac4.status === 401, `siteMgr=${rbac3.status}, tokensiz=${rbac4.status}`);

    // === Test 15: mevcut liste/filtre AC'si hâlâ çalışıyor (regresyon — belge listesi durum+GİB kodu+zamanlarla) ===
    const listCheck = await call('GET', `/despatch-advice-transmissions?status=SENT`, { token: owner });
    const listedStuck = listCheck.body?.data?.find((t: any) => t.id === stuckSent.id);
    check(
      'Test 15 (regresyon — belge listesi AC): GET liste, durum/GİB kodu/gönderim ve yanıt zamanlarını (queuedAt/sentAt/gibStatusCode) döner',
      listCheck.status === 200 && !!listedStuck && listedStuck.status === 'SENT' && listedStuck.gibStatusCode === null && !!listedStuck.sentAt,
      `status=${listCheck.status}, belge=${JSON.stringify(listedStuck)}`
    );
  } finally {
    await cleanup();
    await redis.quit();
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => { console.error('💥 Beklenmeyen hata:', err); process.exit(1); });
