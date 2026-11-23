import { Client } from 'pg';
import Redis from 'ioredis';
import {
  MOCK_INTEGRATOR_FORCE_FAIL_PLATE,
  MOCK_INTEGRATOR_PENDING_STATUS_PLATE,
  MOCK_INTEGRATOR_REJECT_STATUS_PLATE
} from '../src/compliance/integratorAdapter';

/**
 * COMP-602.2 (#128) — Opossum devre kesici (hand-rolled, Redis'te GLOBAL
 * durum), exponential backoff, GİB durum yoklaması.
 *
 * Bilinçli sapma: ticket "opossum + BullMQ + @nestjs/schedule" öneriyor — bu
 * yığında hiçbiri yok; COMP-602.1'in AYNI düz setInterval süpürücüsüne
 * (index.ts) entegre, elle yazılmış bir durum makinesi (CLOSED/OPEN/HALF_OPEN).
 *
 * Devre kesici GLOBAL'dir (tüm tenant'lar arasında paylaşılan tek entegratör
 * bağlantısını temsil eder) — bu yüzden bu test dosyası kendi başına
 * çalıştığında bile Redis'teki 'despatch:integrator:circuit' anahtarını hem
 * başlangıçta hem bitişte temizler (COMP-602.1'in testinin de yaptığı gibi,
 * aynı gerekçeyle: bu değer test dosyaları arasında SIZABİLİR).
 */

const API_URL = 'http://localhost:5000/api/v1';
const RUN = Date.now();
const CIRCUIT_KEY = 'despatch:integrator:circuit';

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
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TX_IDS = Array.from({ length: 13 }, (_, i) => `c6022-tx-${RUN}-${i}`);

async function cleanup(): Promise<void> {
  await q("DELETE FROM audit_logs WHERE tenant_id='comp-camsa' AND action LIKE 'DESPATCH_ADVICE_TRANSMISSION_%' AND created_at > NOW() - INTERVAL '30 minutes'");
  await q('DELETE FROM despatch_advice_transmissions WHERE transaction_id = ANY($1::text[])', [TX_IDS]);
  await q('DELETE FROM despatch_advice_documents WHERE transaction_id = ANY($1::text[])', [TX_IDS]);
  await q('DELETE FROM transactions WHERE id = ANY($1::text[])', [TX_IDS]);
  await q(`DELETE FROM alarm_events WHERE tenant_id='comp-camsa' AND alarm_id IN (SELECT id FROM alarms WHERE tenant_id='comp-camsa' AND alarm_key='despatch-integrator-circuit-open')`);
  await q(`DELETE FROM alarms WHERE tenant_id='comp-camsa' AND alarm_key='despatch-integrator-circuit-open'`);
  await redis.del(CIRCUIT_KEY);
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [COMP-602.2] DEVRE KESİCİ + EXPONENTIAL BACKOFF + GİB YOKLAMA');
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
    for (let i = 0; i < 13; i++) await ins(TX_IDS[i], `C6022-V-${i}-${RUN.toString().slice(-4)}`);
    await c.end();
  }

  try {
    const owner = await login('camsa'); // COMPANY_OWNER
    const siteMgr = await login('gebze-santiye'); // SITE_MANAGER
    const pumpOp = await login('pompa-op-01'); // PUMP_OPERATOR

    // === Test 1: devre başlangıçta CLOSED ===
    const status0 = await call('GET', '/despatch-advice-transmissions/circuit-status', { token: owner });
    check('Test 1: Devre başlangıçta CLOSED (consecutiveFailures=0)',
      status0.status === 200 && status0.body.data.state === 'CLOSED' && status0.body.data.consecutiveFailures === 0,
      `body=${JSON.stringify(status0.body)}`);

    // === Test 2 (ASIL AC — 5 ardışık hata → devre açılmalı): 5 farklı belge, hepsi sentinel (fail) plakayla kuyruğa alınır ===
    for (let i = 0; i < 5; i++) {
      await q(`UPDATE transactions SET vehicle_plate = $1 WHERE id = $2`, [MOCK_INTEGRATOR_FORCE_FAIL_PLATE, TX_IDS[i]]);
      const r = await call('POST', `/transactions/${TX_IDS[i]}/e-irsaliye/transmit`, { token: owner, body: {} });
      if (r.status !== 200) throw new Error(`enqueue ${i} başarısız: ${JSON.stringify(r.body)}`);
    }
    const sweep1 = await call('POST', '/despatch-advice-transmissions/sweep', { token: owner });
    const status1 = await call('GET', '/despatch-advice-transmissions/circuit-status', { token: owner });
    check(
      "Test 2 (ASIL AC): 5 ardışık GLOBAL entegratör hatası (5 farklı belge, TEK sweep çağrısı) → devre OPEN, consecutiveFailures=5",
      sweep1.status === 200 && sweep1.body.data.processed === 5 && sweep1.body.data.requeued === 5 &&
        status1.body.data.state === 'OPEN' && status1.body.data.consecutiveFailures === 5 && !!status1.body.data.nextRetryAt,
      `sweep=${JSON.stringify(sweep1.body.data)}, circuit=${JSON.stringify(status1.body.data)}`
    );
    // Bu 5 belge işini yaptı (devreyi açtı) ama MAX_ATTEMPTS=5'e ulaşıp kalıcı
    // FAILED olmadıkları için (yalnızca 1 deneme, non-terminal) QUEUED+backoff'lu
    // kalıp DAHA SONRAKİ (ilgisiz) bir sweep çağrısında (backoff süresi dolunca)
    // TEKRAR seçilip SESSİZCE yeni hatalar üretebilir ve devreyi BEKLENMEDİK bir
    // anda yeniden açabilirdi (canlı yakalandı) — işleri bitince hemen silinirler.
    await q('DELETE FROM despatch_advice_transmissions WHERE transaction_id = ANY($1::text[])', [TX_IDS.slice(0, 5)]);

    // === Test 3 (ASIL AC — sistem kilitlenmemeli): devre AÇIKKEN yeni bir belge YİNE kuyruğa alınabilir ===
    const enqueueWhileOpen = await call('POST', `/transactions/${TX_IDS[5]}/e-irsaliye/transmit`, { token: owner, body: {} });
    check(
      'Test 3 (ASIL AC — sistem kilitlenmemeli): devre açıkken YENİ belge üretimi/kuyruğa alma ETKİLENMEZ (200 QUEUED)',
      enqueueWhileOpen.status === 200 && enqueueWhileOpen.body.data.status === 'QUEUED',
      `status=${enqueueWhileOpen.status}, body=${JSON.stringify(enqueueWhileOpen.body)}`
    );

    // === Test 4 (ASIL AC — gönderim ertelenir): devre açıkken sweep, o belgeyi DENEMEDEN döner ===
    const sweep2 = await call('POST', '/despatch-advice-transmissions/sweep', { token: owner });
    const stillQueued = (await q('SELECT status FROM despatch_advice_transmissions WHERE transaction_id = $1', [TX_IDS[5]]))[0];
    check(
      'Test 4 (ASIL AC — yalnızca gönderim ertelenir): devre açıkken sweep hiçbir satırı denemez (circuitOpen:true, processed:0), belge QUEUED kalır',
      sweep2.status === 200 && sweep2.body.data.circuitOpen === true && sweep2.body.data.processed === 0 && stillQueued.status === 'QUEUED',
      `sweep=${JSON.stringify(sweep2.body.data)}, belgeDurumu=${stillQueued.status}`
    );

    // === Test 5 (ASIL AC — yönetici bildirimi + panelde görünür uyarı): alarm oluşur, tekrarında DEDUP olur ===
    await call('POST', '/despatch-advice-transmissions/sweep', { token: owner }); // 2. kez — aynı alarm event_count artmalı
    const alarmRows = await q(`SELECT id, event_count FROM alarms WHERE tenant_id='comp-camsa' AND alarm_key='despatch-integrator-circuit-open'`);
    check(
      'Test 5 (ASIL AC — yönetici bildirimi/panel uyarısı): DESPATCH_INTEGRATOR_CIRCUIT_OPEN alarmı TEK satır, tekrarlarda event_count artar (spam olmaz)',
      alarmRows.length === 1 && Number(alarmRows[0].event_count) >= 2,
      `alarm satır sayısı=${alarmRows.length}, event_count=${alarmRows[0]?.event_count}`
    );

    // === Test 6 (ASIL AC — devre kapandığında bekleyenler sırayla gönderilir): yarı-açık pencereyi simüle et (Redis'i doğrudan ilerlet) ===
    const rawBefore = await redis.get(CIRCUIT_KEY);
    const stateBefore = JSON.parse(rawBefore!);
    await redis.set(CIRCUIT_KEY, JSON.stringify({ ...stateBefore, nextRetryAt: new Date(Date.now() - 1000).toISOString() }));
    const sweep3 = await call('POST', '/despatch-advice-transmissions/sweep', { token: owner });
    const status3 = await call('GET', '/despatch-advice-transmissions/circuit-status', { token: owner });
    const tx5Row = (await q('SELECT status FROM despatch_advice_transmissions WHERE transaction_id = $1', [TX_IDS[5]]))[0];
    check(
      'Test 6 (ASIL AC): yarı-açık pencerede TEK deneme yapılır, başarılı olunca devre CLOSED\'a döner ve o belge SENT olur',
      sweep3.status === 200 && sweep3.body.data.circuitOpen === false && sweep3.body.data.processed === 1 && sweep3.body.data.sent === 1 &&
        status3.body.data.state === 'CLOSED' && status3.body.data.consecutiveFailures === 0 && tx5Row.status === 'SENT',
      `sweep=${JSON.stringify(sweep3.body.data)}, circuit=${JSON.stringify(status3.body.data)}, tx5=${tx5Row.status}`
    );

    // === Test 7 (ASIL AC — devre kapanınca bekleyenler SIRAYLA/TAM BATCH gönderilir): 2 yeni normal belge, TEK sweep'te ikisi de gider ===
    await call('POST', `/transactions/${TX_IDS[6]}/e-irsaliye/transmit`, { token: owner, body: {} });
    await call('POST', `/transactions/${TX_IDS[7]}/e-irsaliye/transmit`, { token: owner, body: {} });
    const sweep4 = await call('POST', '/despatch-advice-transmissions/sweep', { token: owner });
    check(
      'Test 7: Devre CLOSED\'a döndükten sonra normal (tam batch) süpürme davranışı geri gelir — 2 belge TEK çağrıda gönderilir',
      sweep4.status === 200 && sweep4.body.data.processed === 2 && sweep4.body.data.sent === 2,
      `sweep=${JSON.stringify(sweep4.body.data)}`
    );
    // tx5/6/7'nin işi bitti (devre/batch davranışını doğruladılar) — GİB durum
    // yoklaması testinin (Test 9/10) SENT-ama-yoklanmamış aday kümesini
    // öngörülebilir tutmak için silinirler (aksi halde poll1 bunları da
    // sayıp checked/finalized toplamlarını şişirir — canlı yakalandı).
    await q('DELETE FROM despatch_advice_transmissions WHERE transaction_id = ANY($1::text[])', [[TX_IDS[5], TX_IDS[6], TX_IDS[7]]]);

    // === Test 8 (ASIL AC — exponential backoff): başarısız bir belge next_retry_at ile geleceğe atılır, hemen tekrar denenmez ===
    await q(`UPDATE transactions SET vehicle_plate = $1 WHERE id = $2`, [MOCK_INTEGRATOR_FORCE_FAIL_PLATE, TX_IDS[8]]);
    await call('POST', `/transactions/${TX_IDS[8]}/e-irsaliye/transmit`, { token: owner, body: {} });
    await call('POST', '/despatch-advice-transmissions/sweep', { token: owner }); // 1. başarısız deneme
    const backoff1 = (await q('SELECT attempt_count, next_retry_at FROM despatch_advice_transmissions WHERE transaction_id = $1', [TX_IDS[8]]))[0];
    const expectedNextRetry = Date.now() + 2000; // BACKOFF_BASE_SECONDS=2, attempt=1 → 2*2^0=2sn
    const actualDelayMs = new Date(backoff1.next_retry_at).getTime() - Date.now();
    const sweepImmediate = await call('POST', '/despatch-advice-transmissions/sweep', { token: owner });
    const stillAttempt1 = (await q('SELECT attempt_count FROM despatch_advice_transmissions WHERE transaction_id = $1', [TX_IDS[8]]))[0];
    check(
      'Test 8a (ASIL AC — exponential backoff): 1. hatadan sonra next_retry_at ≈ +2 sn ileride; HEMEN tekrar sweep bu satırı SEÇMEZ (attempt_count değişmez)',
      backoff1.attempt_count === 1 && actualDelayMs > 500 && actualDelayMs < 3500 &&
        sweepImmediate.body.data.processed === 0 && stillAttempt1.attempt_count === 1,
      `attempt=${backoff1.attempt_count}, kalanGecikme=${actualDelayMs}ms, hemenSweepProcessed=${sweepImmediate.body.data?.processed}, sonraki attempt=${stillAttempt1.attempt_count}`
    );
    await sleep(Math.max(0, actualDelayMs) + 300);
    await call('POST', '/despatch-advice-transmissions/sweep', { token: owner }); // 2. başarısız deneme — backoff süresi geçince artık seçilebilir
    const backoff2 = (await q('SELECT attempt_count, next_retry_at FROM despatch_advice_transmissions WHERE transaction_id = $1', [TX_IDS[8]]))[0];
    const delay2Ms = new Date(backoff2.next_retry_at).getTime() - Date.now();
    check(
      'Test 8b (ASIL AC): backoff süresi geçince satır TEKRAR denenir (attempt_count=2), bir SONRAKİ gecikme İKİYE KATLANIR (≈+4 sn)',
      backoff2.attempt_count === 2 && delay2Ms > 2500 && delay2Ms < 5500,
      `attempt=${backoff2.attempt_count}, kalanGecikme=${delay2Ms}ms`
    );

    // === Test 9 (ASIL AC — GİB durum kodları belge kaydına işlenmelidir): normal + PENDING + REJECT senaryoları ===
    await q(`UPDATE transactions SET vehicle_plate = 'C6022-OK' WHERE id = $1`, [TX_IDS[9]]);
    await q(`UPDATE transactions SET vehicle_plate = $1 WHERE id = $2`, [MOCK_INTEGRATOR_PENDING_STATUS_PLATE, TX_IDS[10]]);
    await q(`UPDATE transactions SET vehicle_plate = $1 WHERE id = $2`, [MOCK_INTEGRATOR_REJECT_STATUS_PLATE, TX_IDS[11]]);
    await call('POST', `/transactions/${TX_IDS[9]}/e-irsaliye/transmit`, { token: owner, body: {} });
    await call('POST', `/transactions/${TX_IDS[10]}/e-irsaliye/transmit`, { token: owner, body: {} });
    await call('POST', `/transactions/${TX_IDS[11]}/e-irsaliye/transmit`, { token: owner, body: {} });
    await call('POST', '/despatch-advice-transmissions/sweep', { token: owner }); // 3'ü de SENT olur

    const poll1 = await call('POST', '/despatch-advice-transmissions/status-poll', { token: owner });
    const rowOk = (await q('SELECT gib_status_code, gib_status_description, gib_status_checked_at FROM despatch_advice_transmissions WHERE transaction_id = $1', [TX_IDS[9]]))[0];
    const rowPending = (await q('SELECT gib_status_code FROM despatch_advice_transmissions WHERE transaction_id = $1', [TX_IDS[10]]))[0];
    const rowReject = (await q('SELECT gib_status_code FROM despatch_advice_transmissions WHERE transaction_id = $1', [TX_IDS[11]]))[0];
    check(
      "Test 9 (ASIL AC — GİB durum kodları belge kaydına işlenmelidir): normal→1200 (nihai), PENDING→1000 (nihai DEĞİL), REJECT→1300 (nihai)",
      poll1.status === 200 && poll1.body.data.checked === 3 && poll1.body.data.finalized === 2 &&
        rowOk.gib_status_code === '1200' && !!rowOk.gib_status_description && !!rowOk.gib_status_checked_at &&
        rowPending.gib_status_code === '1000' && rowReject.gib_status_code === '1300',
      `poll=${JSON.stringify(poll1.body.data)}, ok=${rowOk?.gib_status_code}, pending=${rowPending?.gib_status_code}, reject=${rowReject?.gib_status_code}`
    );

    // === Test 10: ikinci yoklama turu — yalnızca hâlâ PENDING olan satır tekrar sorgulanır ===
    const poll2 = await call('POST', '/despatch-advice-transmissions/status-poll', { token: owner });
    check(
      'Test 10: İkinci yoklama turunda YALNIZCA nihai olmayan (1000) satır tekrar sorgulanır, nihai olanlar bir daha SORGULANMAZ',
      poll2.status === 200 && poll2.body.data.checked === 1 && poll2.body.data.finalized === 0,
      `poll2=${JSON.stringify(poll2.body.data)}`
    );

    // === Test 11: GET /despatch-advice-transmissions/:id rotası circuit-status ile ÇAKIŞMAZ (route sıralaması regresyonu) ===
    const idRouteCheck = await call('GET', `/despatch-advice-transmissions/${(await q('SELECT id FROM despatch_advice_transmissions WHERE transaction_id = $1', [TX_IDS[9]]))[0].id}`, { token: owner });
    check(
      "Test 11 (regresyon — route sıralaması): GET /despatch-advice-transmissions/:id, 'circuit-status' sabit yoluyla ÇAKIŞMADAN normal çalışır",
      idRouteCheck.status === 200 && idRouteCheck.body.data.transactionId === TX_IDS[9],
      `status=${idRouteCheck.status}, transactionId=${idRouteCheck.body.data?.transactionId}`
    );

    // === Test 12: RBAC — PUMP_OPERATOR/SITE_MANAGER circuit-status/status-poll'a erişemez ===
    const rbac1 = await call('GET', '/despatch-advice-transmissions/circuit-status', { token: pumpOp });
    const rbac2 = await call('POST', '/despatch-advice-transmissions/status-poll', { token: siteMgr });
    const rbac3 = await call('GET', '/despatch-advice-transmissions/circuit-status', {});
    check(
      'Test 12: RBAC — PUMP_OPERATOR circuit-status göremez (403), SITE_MANAGER status-poll tetikleyemez (403), tokensiz → 401',
      rbac1.status === 403 && rbac2.status === 403 && rbac3.status === 401,
      `pumpOp=${rbac1.status}, siteMgr=${rbac2.status}, tokensiz=${rbac3.status}`
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
