import { Client } from 'pg';
import Redis from 'ioredis';
import { MockGibIntegrator, MOCK_INTEGRATOR_FORCE_FAIL_PLATE } from '../src/compliance/integratorAdapter'; // saf — config yüklemez

/**
 * COMP-602.1 — e-İrsaliye entegratör adaptör arayüzü (SOAP/REST yerine burada
 * MockGibIntegrator), iletim kuyruğu (BullMQ yerine setInterval süpürücüsü —
 * bkz. index.ts) ve imzalanmış çıktının kalıcı saklanması
 * (S3 yerine despatch_advice_transmissions.xml_snapshot).
 *
 * Kullanılan hazır veriler (COMP-605 testiyle AYNI tenant/şantiye/tank/şoför):
 *   tenant   : comp-camsa (VKN 2381092831)
 *   şantiye  : Gebze Ana Şantiye
 *   tank     : Gebze Ana Tank (T-1)  → fuel_type Motorin (Euro Diesel)
 *   şoför    : Ahmet Yılmaz (TC 10928374821)
 *   1234567890 — GEÇERLİ ama mükellef OLMAYAN VKN (KAĞIT süreç, COMP-605 testinden)
 */

const API_URL = 'http://localhost:5000/api/v1';
const VKN_NONOBLIG = '1234567890';
const DESPATCH_TRANSMISSION_MAX_ATTEMPTS = 5; // tenantDb.ts ile AYNI sabit

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
async function q(sql: string, params: any[] = []): Promise<any[]> {
  const c = pg(); await c.connect(); const r = await c.query(sql, params); await c.end(); return r.rows;
}

const TX_IDS = ['comp602-tx-1', 'comp602-tx-2', 'comp602-tx-3'];

async function cleanup(): Promise<void> {
  await q("DELETE FROM audit_logs WHERE tenant_id='comp-camsa' AND action LIKE 'DESPATCH_ADVICE_TRANSMISSION_%' AND created_at > NOW() - INTERVAL '30 minutes'");
  await q('DELETE FROM despatch_advice_transmissions WHERE transaction_id = ANY($1::text[])', [TX_IDS]);
  await q('DELETE FROM despatch_advice_documents WHERE transaction_id = ANY($1::text[])', [TX_IDS]);
  await q('DELETE FROM transactions WHERE id = ANY($1::text[])', [TX_IDS]);
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [COMP-602.1] ENTEGRATÖR ADAPTÖRÜ + İLETİM KUYRUĞU + ARŞİV');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };

  await cleanup();
  {
    const c = pg(); await c.connect();
    const ins = (id: string, plate: string) => c.query(
      `INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, driver_name, tank_name, amount_liters, created_at)
       VALUES ($1,'comp-camsa','Gebze Ana Şantiye',$2,'Ahmet Yılmaz','Gebze Ana Tank (T-1)',80,'2026-09-01T09:00:00.000Z')`, [id, plate]
    );
    await ins(TX_IDS[0], 'COMP602-VEH-1');
    await ins(TX_IDS[1], MOCK_INTEGRATOR_FORCE_FAIL_PLATE);
    await ins(TX_IDS[2], 'COMP602-VEH-3');
    await c.end();
  }

  try {
    // ── Test 1: saf adaptör (unit) ────────────────────────────────
    const mock = new MockGibIntegrator();
    const okRes = await mock.send({ xml: '<x/>', documentNumber: 'IRS20260000000001', ettn: 'e1', vehiclePlate: '34ABC34' });
    const failRes = await mock.send({ xml: '<x/>', documentNumber: 'IRS20260000000002', ettn: 'e2', vehiclePlate: MOCK_INTEGRATOR_FORCE_FAIL_PLATE });
    const emptyRes = await mock.send({ xml: '', documentNumber: 'IRS20260000000003', ettn: 'e3', vehiclePlate: '34ABC34' });
    check('Test 1: MockGibIntegrator — normal plaka başarılı, sentinel plaka + boş XML reddedilir',
      okRes.success && !!okRes.providerReference && !failRes.success && !!failRes.errorMessage && !emptyRes.success,
      `ok=${okRes.success}, fail=${failRes.success}, empty=${emptyRes.success}`);

    const owner = await login('camsa'); // COMPANY_OWNER
    const siteMgr = await login('gebze-santiye'); // SITE_MANAGER
    const pumpOp = await login('pompa-op-01'); // PUMP_OPERATOR

    // ── Test 2: kuyruğa alma ──────────────────────────────────────
    const r2 = await call('POST', `/transactions/${TX_IDS[0]}/e-irsaliye/transmit`, { token: owner, body: {} });
    const dbRow2 = (await q('SELECT * FROM despatch_advice_transmissions WHERE transaction_id = $1', [TX_IDS[0]]))[0];
    check('Test 2: POST .../e-irsaliye/transmit → 200 QUEUED, xml_snapshot kalıcı yazılır',
      r2.status === 200 && r2.body.data.status === 'QUEUED' && !!dbRow2 && dbRow2.xml_snapshot.includes('DespatchAdvice') && dbRow2.provider === 'MOCK_GIB',
      `status=${r2.status}, apiStatus=${r2.body.data?.status}, xmlLen=${dbRow2?.xml_snapshot?.length}, provider=${dbRow2?.provider}`);

    // ── Test 3: idempotent yeniden kuyruğa alma ────────────────────
    const r3 = await call('POST', `/transactions/${TX_IDS[0]}/e-irsaliye/transmit`, { token: owner, body: {} });
    const countAfter = (await q('SELECT COUNT(*)::int AS c FROM despatch_advice_transmissions WHERE transaction_id = $1', [TX_IDS[0]]))[0].c;
    check('Test 3: aynı belge için tekrar çağrı → AYNI kuyruk satırı döner, YENİDEN eklenmez',
      r3.status === 200 && r3.body.data.id === r2.body.data.id && countAfter === 1,
      `id eşleşti=${r3.body.data.id === r2.body.data.id}, satır sayısı=${countAfter}`);

    // ── Test 4: liste + tekil sorgu ─────────────────────────────────
    const r4list = await call('GET', '/despatch-advice-transmissions?status=QUEUED', { token: owner });
    const r4get = await call('GET', `/despatch-advice-transmissions/${r2.body.data.id}`, { token: owner });
    check('Test 4: GET liste (status=QUEUED) satırı içerir; GET tekil AYNI kaydı döner',
      r4list.status === 200 && r4list.body.data.some((t: any) => t.id === r2.body.data.id) &&
      r4get.status === 200 && r4get.body.data.documentNumber === r2.body.data.documentNumber,
      `listede=${r4list.body.data?.some((t: any) => t.id === r2.body.data.id)}, tekil belge no=${r4get.body.data?.documentNumber}`);

    // ── Test 5: manuel süpürme → başarılı gönderim (SENT) ───────────
    const r5 = await call('POST', '/despatch-advice-transmissions/sweep', { token: owner });
    const sentRow = (await q('SELECT * FROM despatch_advice_transmissions WHERE id = $1', [r2.body.data.id]))[0];
    const auditSent = await q(
      "SELECT COUNT(*)::int AS c FROM audit_logs WHERE tenant_id='comp-camsa' AND action='DESPATCH_ADVICE_TRANSMISSION_SENT' AND target_id=$1",
      [r2.body.data.id]
    );
    check('Test 5: POST .../sweep → kuyruktaki satır entegratöre gönderilir, SENT olur, audit yazılır',
      r5.status === 200 && r5.body.data.processed >= 1 && sentRow.status === 'SENT' && !!sentRow.provider_reference && !!sentRow.sent_at && auditSent[0].c >= 1,
      `processed=${r5.body.data?.processed}, status=${sentRow?.status}, ref=${sentRow?.provider_reference}, audit=${auditSent[0].c}`);

    // ── Test 6: entegratör reddi → tekrar QUEUE'ya döner (bounded retry) ──
    const r6enq = await call('POST', `/transactions/${TX_IDS[1]}/e-irsaliye/transmit`, { token: owner, body: {} });
    await call('POST', '/despatch-advice-transmissions/sweep', { token: owner });
    const requeuedRow = (await q('SELECT * FROM despatch_advice_transmissions WHERE id = $1', [r6enq.body.data.id]))[0];
    check('Test 6: entegratör reddi (sentinel plaka) → status QUEUED\'a döner, attempt_count=1, last_error dolu',
      r6enq.status === 200 && requeuedRow.status === 'QUEUED' && requeuedRow.attempt_count === 1 && !!requeuedRow.last_error,
      `status=${requeuedRow?.status}, attempt=${requeuedRow?.attempt_count}, err=${requeuedRow?.last_error}`);

    // ── Test 7: MAX_ATTEMPTS aşılınca kalıcı FAILED ──────────────────
    for (let i = 0; i < DESPATCH_TRANSMISSION_MAX_ATTEMPTS - 1; i++) {
      await call('POST', '/despatch-advice-transmissions/sweep', { token: owner });
    }
    const failedRow = (await q('SELECT * FROM despatch_advice_transmissions WHERE id = $1', [r6enq.body.data.id]))[0];
    const auditFailed = await q(
      "SELECT COUNT(*)::int AS c FROM audit_logs WHERE tenant_id='comp-camsa' AND action='DESPATCH_ADVICE_TRANSMISSION_FAILED' AND target_id=$1",
      [r6enq.body.data.id]
    );
    check(`Test 7: ${DESPATCH_TRANSMISSION_MAX_ATTEMPTS} deneme aşılınca → kalıcı FAILED, audit yazılır`,
      failedRow.status === 'FAILED' && failedRow.attempt_count === DESPATCH_TRANSMISSION_MAX_ATTEMPTS && auditFailed[0].c === 1,
      `status=${failedRow?.status}, attempt=${failedRow?.attempt_count}, audit=${auditFailed[0].c}`);

    // ── Test 8: KAĞIT süreç alıcısı → elektronik iletim kuyruğuna alınamaz ──
    const r8 = await call('POST', `/transactions/${TX_IDS[2]}/e-irsaliye/transmit`, { token: owner, body: { recipientTaxId: VKN_NONOBLIG } });
    const r8count = (await q('SELECT COUNT(*)::int AS c FROM despatch_advice_transmissions WHERE transaction_id = $1', [TX_IDS[2]]))[0].c;
    check('Test 8: KAĞIT süreç (mükellef olmayan alıcı) → 409 RECIPIENT_NOT_EINVOICE_OBLIGATED, kuyruğa hiç eklenmez',
      r8.status === 409 && r8.body.details?.error === 'RECIPIENT_NOT_EINVOICE_OBLIGATED' && r8count === 0,
      `status=${r8.status}, err=${r8.body.details?.error}, satır=${r8count}`);

    // ── Test 9: Zod validasyonu ──────────────────────────────────────
    const r9body = await call('POST', `/transactions/${TX_IDS[2]}/e-irsaliye/transmit`, { token: owner, body: { recipientTaxId: '123' } });
    const r9query = await call('GET', '/despatch-advice-transmissions?status=YANLIS', { token: owner });
    check('Test 9: Zod — geçersiz recipientTaxId (body) / geçersiz status (query) → 400',
      r9body.status === 400 && r9query.status === 400,
      `body=${r9body.status}, query=${r9query.status}`);

    // ── Test 10: RBAC matrisi ─────────────────────────────────────────
    const r10a = await call('POST', `/transactions/${TX_IDS[2]}/e-irsaliye/transmit`, { token: pumpOp, body: {} });
    const r10b = await call('GET', '/despatch-advice-transmissions', { token: pumpOp });
    const r10c = await call('POST', '/despatch-advice-transmissions/sweep', { token: siteMgr });
    const r10d = await call('GET', '/despatch-advice-transmissions', {});
    check('Test 10: RBAC — PUMP_OPERATOR transmit/list → 403, SITE_MANAGER sweep → 403, tokensiz → 401',
      r10a.status === 403 && r10b.status === 403 && r10c.status === 403 && r10d.status === 401,
      `transmit=${r10a.status}, list=${r10b.status}, sweep=${r10c.status}, tokensiz=${r10d.status}`);

    // ── Test 11: 404 ──────────────────────────────────────────────────
    const r11 = await call('GET', '/despatch-advice-transmissions/nonexistent-id-xyz', { token: owner });
    check('Test 11: olmayan iletim kaydı → 404', r11.status === 404, `status=${r11.status}`);

    // ── Test 12: audit_logs genel doğrulama ────────────────────────────
    const auditAll = await q(
      "SELECT action, COUNT(*)::int AS c FROM audit_logs WHERE tenant_id='comp-camsa' AND action LIKE 'DESPATCH_ADVICE_TRANSMISSION_%' AND created_at > NOW() - INTERVAL '10 minutes' GROUP BY action"
    );
    const byAction: Record<string, number> = {}; for (const r of auditAll) byAction[r.action] = r.c;
    check('Test 12: audit_logs — QUEUED (≥2), SENT (≥1), FAILED (=1) yazıldı',
      (byAction['DESPATCH_ADVICE_TRANSMISSION_QUEUED'] ?? 0) >= 2 &&
      (byAction['DESPATCH_ADVICE_TRANSMISSION_SENT'] ?? 0) >= 1 &&
      (byAction['DESPATCH_ADVICE_TRANSMISSION_FAILED'] ?? 0) === 1,
      JSON.stringify(byAction));

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
