import { Client } from 'pg';
import Redis from 'ioredis';

/**
 * COMP-603 — e-İrsaliye red/iptal senaryosu + yeniden gönderim (düzeltme).
 * COMP-602.1 (iletim kuyruğu) üzerine kurulur: bir belge SENT olduktan sonra
 * alıcı reddedebilir VEYA ihraç eden iptal edebilir; her iki durumda da
 * "düzeltilip" YENİ bir belge numarasıyla yeniden gönderilebilir.
 *
 * Kullanılan hazır veriler (COMP-605/COMP-602.1 testleriyle AYNI tenant):
 *   tenant  : comp-camsa | şantiye: Gebze Ana Şantiye
 *   tank    : Gebze Ana Tank (T-1) | şoför: Ahmet Yılmaz (TC 10928374821)
 */

const API_URL = 'http://localhost:5000/api/v1';

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
async function transmitAndSend(txId: string, token: string): Promise<void> {
  await call('POST', `/transactions/${txId}/e-irsaliye/transmit`, { token, body: {} });
  await call('POST', '/despatch-advice-transmissions/sweep', { token });
}

const TX_IDS = ['comp603-tx-1', 'comp603-tx-2', 'comp603-tx-3', 'comp603-tx-4', 'comp603-tx-5', 'comp603-tx-6'];

async function cleanup(): Promise<void> {
  await q("DELETE FROM audit_logs WHERE tenant_id='comp-camsa' AND action LIKE 'DESPATCH_ADVICE_%' AND created_at > NOW() - INTERVAL '30 minutes'");
  await q(
    `DELETE FROM despatch_advice_documents_status WHERE despatch_advice_document_id IN
       (SELECT id FROM despatch_advice_documents WHERE transaction_id = ANY($1::text[]))`,
    [TX_IDS]
  );
  await q('DELETE FROM despatch_advice_transmissions WHERE transaction_id = ANY($1::text[])', [TX_IDS]);
  await q('DELETE FROM despatch_advice_documents WHERE transaction_id = ANY($1::text[])', [TX_IDS]);
  await q('DELETE FROM transactions WHERE id = ANY($1::text[])', [TX_IDS]);
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [COMP-603] e-İRSALİYE RED/İPTAL + YENİDEN GÖNDERİM');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };

  await cleanup();
  {
    const c = pg(); await c.connect();
    const ins = (id: string, plate: string) => c.query(
      `INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, driver_name, tank_name, amount_liters, created_at)
       VALUES ($1,'comp-camsa','Gebze Ana Şantiye',$2,'Ahmet Yılmaz','Gebze Ana Tank (T-1)',60,'2026-09-01T09:00:00.000Z')`, [id, plate]
    );
    for (let i = 0; i < TX_IDS.length; i++) await ins(TX_IDS[i], `COMP603-VEH-${i + 1}`);
    await c.end();
  }

  try {
    const owner = await login('camsa'); // COMPANY_OWNER
    const siteMgr = await login('gebze-santiye'); // SITE_MANAGER
    const pumpOp = await login('pompa-op-01'); // PUMP_OPERATOR

    // ── Test 1: gönderim + durum ISSUED ────────────────────────────
    await transmitAndSend(TX_IDS[0], owner);
    const s1 = await call('GET', `/transactions/${TX_IDS[0]}/e-irsaliye/status`, { token: owner });
    check('Test 1: transmit+sweep → SENT; GET status → ISSUED',
      s1.status === 200 && s1.body.data.status === 'ISSUED' && !!s1.body.data.documentNumber,
      `status=${s1.status}, disposition=${s1.body.data?.status}, docNo=${s1.body.data?.documentNumber}`);
    const doc1Number = s1.body.data.documentNumber;

    // ── Test 2: red kaydı ────────────────────────────────────────────
    const r2 = await call('POST', `/transactions/${TX_IDS[0]}/e-irsaliye/reject`, { token: owner, body: { reason: 'Miktar sevk irsaliyesiyle uyuşmuyor.' } });
    check('Test 2: POST .../reject → 200 REJECTED, reason kaydedilir',
      r2.status === 200 && r2.body.data.status === 'REJECTED' && r2.body.data.rejectReason === 'Miktar sevk irsaliyesiyle uyuşmuyor.',
      `status=${r2.status}, disposition=${r2.body.data?.status}, reason=${r2.body.data?.rejectReason}`);

    // ── Test 3: aynı belge tekrar reddedilemez ────────────────────────
    const r3 = await call('POST', `/transactions/${TX_IDS[0]}/e-irsaliye/reject`, { token: owner, body: { reason: 'İkinci red denemesi.' } });
    check('Test 3: zaten REJECTED belge tekrar reddedilemez → 409',
      r3.status === 409 && r3.body.details?.error === 'INVALID_STATUS_TRANSITION',
      `status=${r3.status}, err=${r3.body.details?.error}`);

    // ── Test 4: düzeltip yeniden gönder — YENİ belge no ────────────────
    const r4 = await call('POST', `/transactions/${TX_IDS[0]}/e-irsaliye/resubmit`, { token: owner });
    const oldStatusRow = (await q('SELECT * FROM despatch_advice_documents_status WHERE despatch_advice_document_id = $1', [r4.body.data?.previousDocumentId]))[0];
    check('Test 4: resubmit → YENİ belge no farklı, eski belge SUPERSEDED işaretlenir',
      r4.status === 200 && r4.body.data.newDocumentNumber !== doc1Number && r4.body.data.previousDocumentNumber === doc1Number &&
      oldStatusRow?.status === 'SUPERSEDED' && oldStatusRow?.superseded_by_document_id === r4.body.data.newDocumentId,
      `yeni=${r4.body.data?.newDocumentNumber}, eski=${r4.body.data?.previousDocumentNumber}, eskiDurum=${oldStatusRow?.status}`);

    // ── Test 5: yeni (düzeltilmiş) belge tekrar gönderilebilir ─────────
    const s5before = await call('GET', `/transactions/${TX_IDS[0]}/e-irsaliye/status`, { token: owner });
    await transmitAndSend(TX_IDS[0], owner);
    const dtxRow = (await q(
      'SELECT * FROM despatch_advice_transmissions WHERE tenant_id=$1 AND despatch_advice_document_id=$2',
      ['comp-camsa', s5before.body.data.despatchAdviceDocumentId]
    ))[0];
    check('Test 5: GET status → yeni belge ISSUED; yeni belge de SENT olabilir (aktif belge doğru çözülüyor)',
      s5before.body.data.status === 'ISSUED' && s5before.body.data.documentNumber === r4.body.data.newDocumentNumber &&
      dtxRow?.status === 'SENT',
      `öncekiDurum=${s5before.body.data?.status}, yeniDtxDurum=${dtxRow?.status}`);

    // ── Test 6: ISSUED durumdaki belge yeniden gönderilemez ────────────
    const r6 = await call('POST', `/transactions/${TX_IDS[0]}/e-irsaliye/resubmit`, { token: owner });
    check('Test 6: ISSUED (henüz reddedilmemiş/iptal edilmemiş) belge yeniden gönderilemez → 409',
      r6.status === 409 && r6.body.details?.error === 'INVALID_STATUS_TRANSITION',
      `status=${r6.status}, err=${r6.body.details?.error}`);

    // ── Test 7: iptal akışı — sertifika üretimi ────────────────────────
    await transmitAndSend(TX_IDS[1], owner);
    const r7 = await call('POST', `/transactions/${TX_IDS[1]}/e-irsaliye/cancel`, { token: owner, body: { reason: 'Sevkiyat müşteri talebiyle iptal edildi.' } });
    check('Test 7: POST .../cancel → 200 CANCELLED, sertifika referansı üretilir',
      r7.status === 200 && r7.body.data.status === 'CANCELLED' && !!r7.body.data.cancellationCertificateRef && r7.body.data.cancellationCertificateRef.startsWith('IPTAL-'),
      `status=${r7.status}, disposition=${r7.body.data?.status}, cert=${r7.body.data?.cancellationCertificateRef}`);

    // ── Test 8: aynı belge tekrar iptal edilemez ───────────────────────
    const r8 = await call('POST', `/transactions/${TX_IDS[1]}/e-irsaliye/cancel`, { token: owner, body: { reason: 'İkinci iptal denemesi.' } });
    check('Test 8: zaten CANCELLED belge tekrar iptal edilemez → 409',
      r8.status === 409 && r8.body.details?.error === 'INVALID_STATUS_TRANSITION',
      `status=${r8.status}, err=${r8.body.details?.error}`);

    // ── Test 9: CANCELLED belge de yeniden gönderilebilir ──────────────
    const r9 = await call('POST', `/transactions/${TX_IDS[1]}/e-irsaliye/resubmit`, { token: owner });
    check('Test 9: CANCELLED belge → resubmit ile YENİ belge no alınabilir',
      r9.status === 200 && !!r9.body.data.newDocumentNumber && r9.body.data.newDocumentNumber !== r9.body.data.previousDocumentNumber,
      `yeni=${r9.body.data?.newDocumentNumber}, eski=${r9.body.data?.previousDocumentNumber}`);

    // ── Test 10: henüz GÖNDERİLMEMİŞ (SENT değil) belge reddedilemez ──
    await call('POST', `/transactions/${TX_IDS[2]}/e-irsaliye/transmit`, { token: owner, body: {} }); // sweep YOK — hâlâ QUEUED
    const r10 = await call('POST', `/transactions/${TX_IDS[2]}/e-irsaliye/reject`, { token: owner, body: { reason: 'Henüz gönderilmedi ama red deneniyor.' } });
    check('Test 10: SENT olmayan belge reddedilemez → 400 NOT_YET_TRANSMITTED',
      r10.status === 400 && r10.body.details?.error === 'NOT_YET_TRANSMITTED',
      `status=${r10.status}, err=${r10.body.details?.error}`);

    // ── Test 11: yasal iptal süresi aşılmışsa iptal reddedilir ─────────
    await transmitAndSend(TX_IDS[3], owner);
    await q("UPDATE despatch_advice_documents SET created_at = NOW() - INTERVAL '80 hours' WHERE transaction_id = $1", [TX_IDS[3]]);
    const r11 = await call('POST', `/transactions/${TX_IDS[3]}/e-irsaliye/cancel`, { token: owner, body: { reason: 'Süresi geçmiş iptal denemesi.' } });
    check('Test 11: 72 saatlik iptal penceresi aşılmışsa → 400 CANCELLATION_WINDOW_EXPIRED',
      r11.status === 400 && r11.body.details?.error === 'CANCELLATION_WINDOW_EXPIRED',
      `status=${r11.status}, err=${r11.body.details?.error}`);

    // ── Test 12: RBAC matrisi ────────────────────────────────────────
    await transmitAndSend(TX_IDS[4], owner);
    const r12a = await call('GET', `/transactions/${TX_IDS[4]}/e-irsaliye/status`, { token: pumpOp });
    const r12b = await call('POST', `/transactions/${TX_IDS[4]}/e-irsaliye/reject`, { token: pumpOp, body: { reason: 'PUMP_OPERATOR denemesi.' } });
    const r12c = await call('POST', `/transactions/${TX_IDS[4]}/e-irsaliye/cancel`, { token: siteMgr, body: { reason: 'SITE_MANAGER iptal denemesi.' } });
    const r12d = await call('GET', `/transactions/${TX_IDS[4]}/e-irsaliye/status`, {});
    check('Test 12: RBAC — PUMP_OPERATOR status/reject → 403, SITE_MANAGER cancel → 403, tokensiz → 401',
      r12a.status === 403 && r12b.status === 403 && r12c.status === 403 && r12d.status === 401,
      `status=${r12a.status}, reject=${r12b.status}, cancel=${r12c.status}, tokensiz=${r12d.status}`);

    // ── Test 13: hiç e-İrsaliye üretilmemiş ikmal → 404 ────────────────
    const r13a = await call('GET', `/transactions/${TX_IDS[5]}/e-irsaliye/status`, { token: owner });
    const r13b = await call('POST', `/transactions/${TX_IDS[5]}/e-irsaliye/reject`, { token: owner, body: { reason: 'Belge hiç üretilmedi.' } });
    check('Test 13: e-İrsaliye hiç üretilmemiş ikmal → status/reject 404',
      r13a.status === 404 && r13b.status === 404,
      `status=${r13a.status}, reject=${r13b.status}`);

    // ── Test 14: Zod — kısa gerekçe reddedilir ─────────────────────────
    const r14a = await call('POST', `/transactions/${TX_IDS[4]}/e-irsaliye/reject`, { token: owner, body: { reason: 'kısa' } });
    const r14b = await call('POST', `/transactions/${TX_IDS[4]}/e-irsaliye/cancel`, { token: owner, body: { reason: 'kısa' } });
    check('Test 14: Zod — 5 karakterden kısa gerekçe → 400', r14a.status === 400 && r14b.status === 400, `reject=${r14a.status}, cancel=${r14b.status}`);

    // ── Test 15: audit_logs doğrulaması ────────────────────────────────
    const auditAll = await q(
      "SELECT action, COUNT(*)::int AS c FROM audit_logs WHERE tenant_id='comp-camsa' AND action LIKE 'DESPATCH_ADVICE_%' AND created_at > NOW() - INTERVAL '10 minutes' AND action NOT LIKE 'DESPATCH_ADVICE_TRANSMISSION%' GROUP BY action"
    );
    const byAction: Record<string, number> = {}; for (const r of auditAll) byAction[r.action] = r.c;
    check('Test 15: audit_logs — REJECTED (≥1), CANCELLED (≥1), RESUBMITTED (≥2) yazıldı',
      (byAction['DESPATCH_ADVICE_REJECTED'] ?? 0) >= 1 &&
      (byAction['DESPATCH_ADVICE_CANCELLED'] ?? 0) >= 1 &&
      (byAction['DESPATCH_ADVICE_RESUBMITTED'] ?? 0) >= 2,
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
