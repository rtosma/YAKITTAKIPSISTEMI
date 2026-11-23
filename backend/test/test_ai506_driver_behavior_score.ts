import { Client } from 'pg';
import Redis from 'ioredis';

/**
 * AI-506 — şoför davranış skorlama motoru.
 *
 * CANLI HTTP + doğrudan PG (src import YOK — test_ai504/test_fleet1403 ile
 * AYNI desen). Kobay şoförler (tenant comp-camsa, şantiye 'Silivri
 * Tesisleri'):
 *  - AI506 Şoför A: 10 işlem, HER girdi türünden en az bir tane (kötü skor —
 *    alarm eşiğinin ALTINA düşürecek şekilde tasarlandı).
 *  - AI506 Şoför B: 3 işlem — minTransactions (5) eşiğinin ALTINDA, skor
 *    HİÇ üretilmemeli.
 *  - AI506 Şoför C: 6 işlem, tamamen "temiz" — skor 100 olmalı.
 * Test SONUNDA (finally) tüm satırlar + üretilen skorlar/alarmlar/audit
 * kayıtları temizlenir.
 */

const API_URL = 'http://localhost:5000/api/v1';
const SITE = 'Silivri Tesisleri';
const DRIVER_A = 'AI506 Şoför A';
const DRIVER_B = 'AI506 Şoför B';
const DRIVER_C = 'AI506 Şoför C';

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
  const keys = await redis.keys('rl:auth-login:*');
  if (keys.length) await redis.del(...keys);
}
async function call(method: string, path: string, opts: { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
  if (path === '/auth/login') await resetLoginRl();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${API_URL}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function login(username: string): Promise<string> {
  const r = await call('POST', '/auth/login', { body: { username, password: '123456' } });
  if (!r.body.accessToken) throw new Error(`login ${username}: ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
}
async function q(sql: string, params: any[] = []): Promise<any[]> {
  const c = pg(); await c.connect();
  const r = await c.query(sql, params);
  await c.end();
  return r.rows;
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [AI-506] ŞOFÖR DAVRANIŞ SKORLAMA MOTORU');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };

  // ── Setup: temiz başla + kontrollü ikmalleri/talepleri ekle ─────────
  {
    const c = pg(); await c.connect();
    await c.query("DELETE FROM driver_behavior_scores WHERE driver_name LIKE 'AI506 Şoför %'");
    await c.query("DELETE FROM transaction_anomaly_flags WHERE transaction_id LIKE 'ai506-tx-%'");
    await c.query("DELETE FROM manual_dispense_requests WHERE id LIKE 'ai506-mdr-%'");
    await c.query("DELETE FROM transactions WHERE id LIKE 'ai506-tx-%'");

    const ins = (id: string, driver: string, liters: number, extra: { verification_status?: string; rfid_auth?: boolean } = {}) => c.query(
      `INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, driver_name, amount_liters, verification_status, rfid_auth, created_at)
       VALUES ($1,'comp-camsa',$2,'AI506-TEST',$3,$4,$5,$6, NOW() - INTERVAL '2 days')`,
      [id, SITE, driver, liters, extra.verification_status ?? 'DOĞRULANDI', extra.rfid_auth ?? true]
    );

    // Şoför A — 10 işlem: liters dizisi [78,79,80,81,82,79,80,81,80,300] →
    // tek net aykırı değer (300), z-score ≈ 3.0 (kendi ortalama/sapmasına göre).
    const literA = [78, 79, 80, 81, 82, 79, 80, 81, 80, 300];
    for (let i = 0; i < literA.length; i++) {
      await ins(`ai506-tx-a-${i}`, DRIVER_A, literA[i], {
        // 3 işlem DOĞRULAMA_BEKLIYOR (anormal sonlanan), 4 işlem rfid_auth=false (manuel).
        verification_status: i < 3 ? 'DOĞRULAMA_BEKLIYOR' : 'DOĞRULANDI',
        rfid_auth: i >= 6 ? false : true // son 4'ü (index 6,7,8,9) manuel
      });
    }
    // 2 reddedilen/iptal manuel ikmal talebi (transactions'a hiç düşmez).
    await c.query(
      `INSERT INTO manual_dispense_requests
         (id, tenant_id, site_name, vehicle_plate, driver_name, tank_id, tank_name, liters, dispensed_at, reason, status, requested_by, created_at)
       VALUES
         ('ai506-mdr-a-1', 'comp-camsa', $1, 'AI506-TEST', $2, 'tank-1', 'Test Tank', 50, NOW(), 'test', 'İPTAL', 'usr-silivri-mgr', NOW()),
         ('ai506-mdr-a-2', 'comp-camsa', $1, 'AI506-TEST', $2, 'tank-1', 'Test Tank', 50, NOW(), 'test', 'REDDEDİLDİ', 'usr-silivri-mgr', NOW())`,
      [SITE, DRIVER_A]
    );
    // AI-504 bayrakları: 3 MESAI_DISI + 2 KISA_ARALIK_MUKERRER (farklı işlemler üzerinde).
    const flag = (txId: string, type: string) => c.query(
      `INSERT INTO transaction_anomaly_flags (id, tenant_id, transaction_id, anomaly_type, site_name, vehicle_plate, driver_name, transaction_at, amount_liters, detail)
       VALUES ($1,'comp-camsa',$2,$3,$4,'AI506-TEST',$5,NOW(),80,'{}'::jsonb)`,
      [`ai506-flag-${txId}-${type}`, txId, type, SITE, DRIVER_A]
    );
    await flag('ai506-tx-a-0', 'MESAI_DISI');
    // ai506-tx-a-0 KASITLI olarak İKİ farklı anomaly_type'a sahip (aynı
    // işlem hem mesai dışı hem kısa aralıklı mükerrer) — flag tablosuna
    // doğrudan LEFT JOIN yapan eski (hatalı) sürüm bunu fan-out ile
    // transaction_count'a İKİ KEZ sayardı (10 değil 11 çıkardı); Test 3/5
    // bunu yakalar.
    await flag('ai506-tx-a-0', 'KISA_ARALIK_MUKERRER');
    await flag('ai506-tx-a-1', 'MESAI_DISI');
    await flag('ai506-tx-a-2', 'MESAI_DISI');
    await flag('ai506-tx-a-3', 'KISA_ARALIK_MUKERRER');
    await flag('ai506-tx-a-4', 'KISA_ARALIK_MUKERRER');

    // Şoför B — minTransactions (varsayılan 5) eşiğinin ALTINDA (3 işlem).
    for (let i = 0; i < 3; i++) await ins(`ai506-tx-b-${i}`, DRIVER_B, 80);

    // Şoför C — 6 işlem, tamamen temiz (aynı miktar, DOĞRULANDI, rfid_auth=true, bayraksız).
    for (let i = 0; i < 6; i++) await ins(`ai506-tx-c-${i}`, DRIVER_C, 80);

    await c.end();
  }

  try {
    const owner = await login('camsa');            // COMPANY_OWNER
    const siteMgr = await login('silivri-santiye'); // SITE_MANAGER

    // ── Test 1: Şoför B (eşiğin altında) → skor ÜRETİLMEZ ───────────
    const r1 = await call('POST', '/drivers/behavior-scores/compute', { token: owner, body: { driverName: DRIVER_B } });
    check('Test 1: minTransactions (5) altındaki şoför (3 işlem) → skippedInsufficientData=1, scoredDrivers=0',
      r1.status === 200 && r1.body.data?.skippedInsufficientData === 1 && r1.body.data?.scoredDrivers === 0 && r1.body.data?.scores.length === 0,
      JSON.stringify(r1.body.data));

    // ── Test 2: Şoför C (tamamen temiz) → skor = 100 ────────────────
    const r2 = await call('POST', '/drivers/behavior-scores/compute', { token: owner, body: { driverName: DRIVER_C } });
    const scoreC = r2.body.data?.scores?.[0];
    // NOT: bu POST /compute yanıtı, bellekteki hesaplama sonucunu DÖNER (DB'den
    // yeniden OKUNMAZ) — sayısal alanlar gerçek JS number'ı (0), pg'nin
    // NUMERIC kolonları için döndürdüğü STRING ('0.00') değil (bkz. Test 8/9'un
    // GET uçları — onlar DB'den okur, orada string gelir).
    check('Test 2: temiz şoför (6 işlem, bayraksız/rfid_auth=true/DOĞRULANDI) → skor=100',
      r2.status === 200 && scoreC?.score === 100 && scoreC?.transaction_count === 6 &&
      scoreC?.offhours_ratio_pct === 0 && scoreC?.manual_entry_ratio_pct === 0,
      JSON.stringify(scoreC));

    // ── Test 3: Şoför A (kötü davranış) → skor <50, tüm girdiler doğru sayılmış ──
    const r3 = await call('POST', '/drivers/behavior-scores/compute', { token: owner, body: { driverName: DRIVER_A } });
    const scoreA = r3.body.data?.scores?.[0];
    // offhours=3/10=30% (tx0,1,2), rapidRepeat=3/10=30% (tx0[İKİNCİ bayrağı],3,4),
    // deviation=1/10=10% (yalnız 300L aykırı), cancelled=(3+2)/(10+2)=41.67%,
    // manualEntry=4/10=40%.
    // malus = 30*0.25+30*0.20+10*0.20+41.67*0.20+40*0.15 = 7.5+6+2+8.33+6 = 29.83 → skor≈70.
    // NOT: bu, alarm eşiğinin (50) ÜSTÜNDE — kasıtlı: alarm AYRI, DAHA kötü
    // bir senaryoyla (Test 6) tetiklenir.
    // transaction_count=10 (11 DEĞİL) — tx0'ın İKİ bayrağı (fan-out testi) fark
    // etmez, çünkü flag sayımı ARTIK ayrı bir agregasyon sorgusunda (bkz. Test 5).
    check('Test 3: Şoför A — transaction_count=10 (fan-out YOK), offhours=3, rapidRepeat=3, deviation/cancelled/manual sayıları doğru',
      r3.status === 200 && scoreA?.transaction_count === 10 &&
      Number(scoreA?.offhours_ratio_pct) === 30 && Number(scoreA?.rapid_repeat_ratio_pct) === 30 &&
      scoreA?.detail?.deviationCount === 1 && scoreA?.detail?.pendingVerificationCount === 3 &&
      scoreA?.detail?.rejectedRequestCount === 2 && scoreA?.detail?.manualCount === 4,
      JSON.stringify(scoreA));

    check('Test 4: Şoför A — skor, girdilerden bağımsız yeniden hesapladığımız formülle EŞLEŞİYOR',
      r3.status === 200 && (() => {
        const malus = 30 * 0.25 + 30 * 0.20 + 10 * 0.20 + (5 / 12 * 100) * 0.20 + 40 * 0.15;
        const expected = Math.round(100 - malus);
        return scoreA?.score === expected;
      })(),
      `score=${scoreA?.score}`);

    // ── Test 5: fan-out KORUMASI — dual-flag'li tx0 sayıldığı halde total=10 ─
    check('Test 5: detail.offhoursCount=3 + detail.rapidRepeatCount=3 (tx0 HER İKİSİNDE de sayılır) AMA transaction_count HÂLÂ 10',
      scoreA?.detail?.offhoursCount === 3 && scoreA?.detail?.rapidRepeatCount === 3 && scoreA?.transaction_count === 10,
      `offhours=${scoreA?.detail?.offhoursCount}, rapidRepeat=${scoreA?.detail?.rapidRepeatCount}, total=${scoreA?.transaction_count}`);

    // ── Test 6: kritik eşiğin altına düşen bir şoför için AI-507 alarmı ────
    // Şoför A'nın TÜM işlemlerini kötüleştirip yeniden hesapla → skor <50 → alarm.
    await q("UPDATE transactions SET verification_status='DOĞRULAMA_BEKLIYOR', rfid_auth=false WHERE id LIKE 'ai506-tx-a-%'");
    for (const txId of ['ai506-tx-a-5', 'ai506-tx-a-6', 'ai506-tx-a-7', 'ai506-tx-a-8', 'ai506-tx-a-9']) {
      await q(
        `INSERT INTO transaction_anomaly_flags (id, tenant_id, transaction_id, anomaly_type, site_name, vehicle_plate, driver_name, transaction_at, amount_liters, detail)
         VALUES ($1,'comp-camsa',$2,'MESAI_DISI',$3,'AI506-TEST',$4,NOW(),80,'{}'::jsonb)
         ON CONFLICT (transaction_id, anomaly_type) DO NOTHING`,
        [`ai506-flag-${txId}-MESAI_DISI`, txId, SITE, DRIVER_A]
      );
    }
    const r6 = await call('POST', '/drivers/behavior-scores/compute', { token: owner, body: { driverName: DRIVER_A } });
    const scoreA2 = r6.body.data?.scores?.[0];
    const alarmRows = await q("SELECT * FROM alarms WHERE tenant_id='comp-camsa' AND alarm_key = $1", [`DRIVER_BEHAVIOR_SCORE_LOW:${DRIVER_A}`]);
    check('Test 6: skor kritik eşiğin (50) altına düşünce AI-507 alarmı (DRIVER_BEHAVIOR_SCORE_LOW) üretilir',
      r6.status === 200 && (scoreA2?.score ?? 100) < 50 && r6.body.data?.alarmsRaised === 1 &&
      alarmRows.length === 1 && alarmRows[0].category === 'DRIVER_BEHAVIOR_SCORE_LOW' && alarmRows[0].subject_id === DRIVER_A,
      `score=${scoreA2?.score}, alarmsRaised=${r6.body.data?.alarmsRaised}, alarmRows=${alarmRows.length}`);

    // ── Test 7: "skor geçmişi" — append-only, aynı şoför için İKİ satır var ──
    const historyA = (await call('GET', `/drivers/${encodeURIComponent(DRIVER_A)}/behavior-scores/history`, { token: owner })).body.data;
    check('Test 7: Şoför A için skor geçmişinde EN AZ 2 satır (append-only, UPDATE yok), en yeni İLK sırada',
      Array.isArray(historyA) && historyA.length >= 2 && historyA[0].score === scoreA2?.score &&
      new Date(historyA[0].computed_at).getTime() >= new Date(historyA[1].computed_at).getTime(),
      `count=${historyA?.length}, ilkSkor=${historyA?.[0]?.score}`);

    // ── Test 8: EN GÜNCEL liste — DISTINCT ON gerçekten EN YENİ satırı döndürüyor ──
    // (Test 3'teki İYİ skor (~72) DEĞİL, Test 6'daki KÖTÜ skor (<50) görünmeli —
    // DISTINCT ON + WHERE score<X filtresi CTE'DEN ÖNCE uygulansaydı bu testin
    // kırılması gerekirdi.)
    const latestList = (await call('GET', '/drivers/behavior-scores', { token: owner })).body.data;
    const latestA = (latestList || []).find((r: any) => r.driver_name === DRIVER_A);
    check('Test 8: GET /drivers/behavior-scores — Şoför A için EN GÜNCEL (kötü) skor görünüyor, eski (iyi) skor DEĞİL',
      latestA?.score === scoreA2?.score && latestA?.score !== scoreA?.score,
      `latest=${latestA?.score}, ilkHesap=${scoreA?.score}, sonHesap=${scoreA2?.score}`);

    // ── Test 9: minScore/maxScore filtresi doğru satırı bulur/hariç tutar ──
    const filteredLow = (await call('GET', '/drivers/behavior-scores?maxScore=49', { token: owner })).body.data;
    const filteredHigh = (await call('GET', '/drivers/behavior-scores?minScore=90', { token: owner })).body.data;
    check('Test 9: ?maxScore=49 → Şoför A\'yı İÇERİR, ?minScore=90 → Şoför A\'yı HARİÇ TUTAR (ama Şoför C\'yi içerir)',
      (filteredLow || []).some((r: any) => r.driver_name === DRIVER_A) &&
      !(filteredHigh || []).some((r: any) => r.driver_name === DRIVER_A) &&
      (filteredHigh || []).some((r: any) => r.driver_name === DRIVER_C),
      `low.hasA=${(filteredLow || []).some((r: any) => r.driver_name === DRIVER_A)}, high.hasA=${(filteredHigh || []).some((r: any) => r.driver_name === DRIVER_A)}`);

    // ── Test 10: Zod ─────────────────────────────────────────────
    const z1 = await call('POST', '/drivers/behavior-scores/compute', { token: owner, body: { periodDays: 0 } });
    const z2 = await call('POST', '/drivers/behavior-scores/compute', { token: owner, body: { minTransactions: 0 } });
    check('Test 10: Zod — periodDays=0 / minTransactions=0 → 400',
      z1.status === 400 && z2.status === 400, `periodDays=${z1.status}, minTransactions=${z2.status}`);

    // ── Test 11: RBAC ──────────────────────────────────────────
    const r11a = await call('POST', '/drivers/behavior-scores/compute', { token: siteMgr, body: {} }); // SITE_MANAGER hesaplayamaz
    const r11b = await call('GET', '/drivers/behavior-scores');                                        // tokensiz
    const r11c = await call('GET', '/drivers/behavior-scores', { token: siteMgr });                     // SITE_MANAGER okuyabilir
    check('Test 11: RBAC — SITE_MANAGER compute → 403, tokensiz list → 401, SITE_MANAGER list GET → 200',
      r11a.status === 403 && r11b.status === 401 && r11c.status === 200,
      `compute=${r11a.status}, tokensiz=${r11b.status}, listGet=${r11c.status}`);

    // ── Test 12: audit log ─────────────────────────────────────
    const auditRows = await q(
      `SELECT count(*)::int AS n FROM audit_logs
        WHERE tenant_id='comp-camsa' AND action='DRIVER_BEHAVIOR_SCORE_COMPUTED'
          AND created_at > NOW() - INTERVAL '5 minutes'`
    );
    check('Test 12: audit_logs — DRIVER_BEHAVIOR_SCORE_COMPUTED yazıldı',
      auditRows[0].n >= 1, `n=${auditRows[0].n}`);

  } finally {
    const c = pg();
    await c.connect();
    await c.query("DELETE FROM audit_logs WHERE tenant_id='comp-camsa' AND created_at > NOW() - INTERVAL '15 minutes' AND action='DRIVER_BEHAVIOR_SCORE_COMPUTED'");
    await c.query("DELETE FROM alarm_events WHERE alarm_id IN (SELECT id FROM alarms WHERE tenant_id='comp-camsa' AND alarm_key LIKE 'DRIVER_BEHAVIOR_SCORE_LOW:AI506%')");
    await c.query("DELETE FROM alarms WHERE tenant_id='comp-camsa' AND alarm_key LIKE 'DRIVER_BEHAVIOR_SCORE_LOW:AI506%'");
    await c.query("DELETE FROM driver_behavior_scores WHERE driver_name LIKE 'AI506 Şoför %'");
    await c.query("DELETE FROM transaction_anomaly_flags WHERE transaction_id LIKE 'ai506-tx-%'");
    await c.query("DELETE FROM manual_dispense_requests WHERE id LIKE 'ai506-mdr-%'");
    await c.query("DELETE FROM transactions WHERE id LIKE 'ai506-tx-%'");
    await c.end();
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  await redis.quit();
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => { console.error('💥', err); process.exit(1); });
