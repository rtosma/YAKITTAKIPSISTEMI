import { Client } from 'pg';
import Redis from 'ioredis';

/**
 * IOT-308 — cihaz sağlık skoru, sürüm envanteri, online SLA takibi.
 *
 * CANLI HTTP + doğrudan PG/Redis (src import YOK — test_ai506 ile AYNI
 * desen). Kobay cihazlar (tenant comp-camsa, şantiye 'Silivri Tesisleri'):
 *  - IOT308-TEST-A: tek ("ONLINE") presence olayı, hiç geçiş YOK — skor=100
 *    olmalı (bu, minSamples eşiğinin "az geçiş = İYİ" düzeltmesini test eder).
 *  - IOT308-TEST-B: HİÇ presence olayı YOK — skor üretilMEMELİ.
 *  - IOT308-TEST-C: 3 OFFLINE geçişi + Redis telemetri hata sayaçları + zayıf
 *    RSSI + saat sapması — skor kritik eşiğin (50) altına düşmeli, alarm.
 * Test SONUNDA (finally) tüm satırlar + cihazlar + alarmlar + audit + Redis
 * sayaçları temizlenir.
 */

const API_URL = 'http://localhost:5000/api/v1';
const SITE = 'Silivri Tesisleri';
const DEVICE_A = 'IOT308-TEST-A';
const DEVICE_B = 'IOT308-TEST-B';
const DEVICE_C = 'IOT308-TEST-C';

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
  console.log('🧪 [IOT-308] CİHAZ SAĞLIK SKORU / SÜRÜM ENVANTERİ / ONLINE SLA');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };

  // ── Setup ────────────────────────────────────────────────────────────
  {
    const c = pg(); await c.connect();
    await c.query("DELETE FROM device_health_scores WHERE device_id LIKE 'IOT308-TEST-%'");
    await c.query("DELETE FROM device_presence_events WHERE device_id LIKE 'IOT308-TEST-%'");
    await c.query("DELETE FROM hardware_devices WHERE device_id LIKE 'IOT308-TEST-%'");
    await c.end();
  }
  for (const id of [DEVICE_A, DEVICE_B, DEVICE_C]) {
    await redis.del(`device:${id}:health:total`, `device:${id}:health:error`);
  }

  try {
    const owner = await login('camsa');            // COMPANY_OWNER
    const siteMgr = await login('silivri-santiye'); // SITE_MANAGER

    // Cihazları GERÇEK provisioning endpoint'i üzerinden oluştur.
    for (const [id, name] of [[DEVICE_A, 'Test Cihaz A'], [DEVICE_B, 'Test Cihaz B'], [DEVICE_C, 'Test Cihaz C']] as const) {
      const r = await call('POST', '/hardware-devices', { token: owner, body: { deviceId: id, name, siteName: SITE } });
      if (r.status !== 200) throw new Error(`Cihaz oluşturulamadı ${id}: ${JSON.stringify(r.body)}`);
    }

    // Cihaz A: TEK ("ONLINE") presence olayı, hiç geçiş yok — 1 saat önce bağlandı.
    await q(
      `INSERT INTO device_presence_events (id, tenant_id, device_id, site_name, status, occurred_at)
       VALUES ('iot308-pe-a-1','comp-camsa',$1,$2,'ONLINE', NOW() - INTERVAL '3600 seconds')`,
      [DEVICE_A, SITE]
    );

    // Cihaz B: HİÇ presence olayı yok (setup'ta zaten temizlendi).

    // Cihaz C: 6 geçiş (3 OFFLINE), son durum OFFLINE (şu an çevrimdışı).
    const evC = (idx: number, status: string, secondsAgo: number) => q(
      `INSERT INTO device_presence_events (id, tenant_id, device_id, site_name, status, occurred_at)
       VALUES ($1,'comp-camsa',$2,$3,$4, NOW() - INTERVAL '${secondsAgo} seconds')`,
      [`iot308-pe-c-${idx}`, DEVICE_C, SITE, status]
    );
    await evC(1, 'ONLINE', 3600);
    await evC(2, 'OFFLINE', 3000);
    await evC(3, 'ONLINE', 2400);
    await evC(4, 'OFFLINE', 1800);
    await evC(5, 'ONLINE', 1200);
    await evC(6, 'OFFLINE', 600);
    // Redis telemetri sayaçları: 20 denemenin 8'i reddedilmiş (paket hatası).
    await redis.set(`device:${DEVICE_C}:health:total`, '20');
    await redis.set(`device:${DEVICE_C}:health:error`, '8');
    // Zayıf RSSI + saat sapması (eşiğin üstünde) — nokta-zamanlı ceza girdileri.
    await q(`UPDATE hardware_devices SET last_reported_rssi = -110, last_clock_drift_ms = 400000 WHERE device_id = $1`, [DEVICE_C]);
    // Firmware envanteri testi için ayrıca A'ya bir sürüm yaz.
    await q(`UPDATE hardware_devices SET firmware_version = '1.4.2' WHERE device_id = $1`, [DEVICE_A]);

    // ── Test 1: Cihaz B (hiç presence yok) → skor ÜRETİLMEZ ────────
    const r1 = await call('POST', '/hardware-devices/health-scores/compute', { token: owner, body: { deviceId: DEVICE_B } });
    check('Test 1: presence verisi hiç olmayan cihaz → skippedInsufficientData=1, scoredDevices=0',
      r1.status === 200 && r1.body.data?.skippedInsufficientData === 1 && r1.body.data?.scoredDevices === 0,
      JSON.stringify(r1.body.data));

    // ── Test 2: Cihaz A (tek ONLINE olayı, hiç geçiş yok) → skor=100 ──
    // Bu, "az geçiş = İYİ, yetersiz veri DEĞİL" düzeltmesinin doğrudan testi
    // — minSamples varsayılanı (1) bu cihazı ATLAMAMALI.
    const r2 = await call('POST', '/hardware-devices/health-scores/compute', { token: owner, body: { deviceId: DEVICE_A } });
    const scoreA = r2.body.data?.scores?.[0];
    check('Test 2: tek presence olayı (hiç OFFLINE geçişi yok) → skor=100, sample_count=1 (atlanmadı)',
      r2.status === 200 && scoreA?.score === 100 && scoreA?.sample_count === 1 &&
      Number(scoreA?.offline_ratio_pct) === 0,
      JSON.stringify(scoreA));

    // ── Test 3: Cihaz C (3 OFFLINE geçişi + hata + zayıf sinyal + saat sapması) ──
    const r3 = await call('POST', '/hardware-devices/health-scores/compute', { token: owner, body: { deviceId: DEVICE_C } });
    const scoreC = r3.body.data?.scores?.[0];
    // offline≈%50 (3600sn pencerede 1800sn OFFLINE), 3 geçiş, telemetryError=8/20=%40,
    // zayıf sinyal + saat sapması ceza bayrakları AKTİF.
    check('Test 3: Cihaz C — offline≈%50, 3 OFFLINE geçişi, telemetryError=%40, sinyal/saat ceza bayrakları aktif',
      r3.status === 200 && Math.abs(Number(scoreC?.offline_ratio_pct) - 50) <= 2 &&
      scoreC?.detail?.offlineTransitionCount === 3 &&
      Number(scoreC?.telemetry_error_ratio_pct) === 40 &&
      Number(scoreC?.signal_battery_penalty_pct) === 100 && Number(scoreC?.clock_drift_penalty_pct) === 100,
      JSON.stringify(scoreC));

    check('Test 4: Cihaz C — skor, girdilerden bağımsız yeniden hesapladığımız formülle EŞLEŞİYOR',
      r3.status === 200 && (() => {
        const offlineRatio = Number(scoreC.offline_ratio_pct) / 100;
        const packetLossRatio = Math.min(1, scoreC.detail.offlineTransitionCount / 10);
        const telemetryErrorRatio = Number(scoreC.telemetry_error_ratio_pct) / 100;
        const signalBattery = Number(scoreC.signal_battery_penalty_pct) / 100;
        const clockDrift = Number(scoreC.clock_drift_penalty_pct) / 100;
        const malus = offlineRatio * 30 + packetLossRatio * 15 + telemetryErrorRatio * 25 + signalBattery * 15 + clockDrift * 15;
        const expected = Math.max(0, Math.min(100, Math.round(100 - malus)));
        return scoreC.score === expected;
      })(),
      `score=${scoreC?.score}`);

    // ── Test 5: skor kritik eşiğin (50) altında → AI-507 alarmı ────
    const alarmRows = await q("SELECT * FROM alarms WHERE tenant_id='comp-camsa' AND alarm_key = $1", [`DEVICE_HEALTH_SCORE_LOW:${DEVICE_C}`]);
    check('Test 5: Cihaz C skoru <50 → DEVICE_HEALTH_SCORE_LOW alarmı üretildi',
      (scoreC?.score ?? 100) < 50 && r3.body.data?.alarmsRaised === 1 &&
      alarmRows.length === 1 && alarmRows[0].category === 'DEVICE_HEALTH_SCORE_LOW' && alarmRows[0].subject_id === DEVICE_C,
      `score=${scoreC?.score}, alarmsRaised=${r3.body.data?.alarmsRaised}, alarmRows=${alarmRows.length}`);

    // ── Test 6: "skor geçmişi" — ikinci hesaplama YENİ bir satır ekler ──
    // Redis sayaçları bir önceki turda SIFIRLANDI — hata oranı artık 0
    // olacağından skor bu turda YÜKSELMELİ (append-only'yi ayrıca kanıtlar).
    const r6 = await call('POST', '/hardware-devices/health-scores/compute', { token: owner, body: { deviceId: DEVICE_C } });
    const scoreC2 = r6.body.data?.scores?.[0];
    const historyC = (await call('GET', `/hardware-devices/${DEVICE_C}/health-score/history`, { token: owner })).body.data;
    check('Test 6: Redis sayaçları sıfırlandığı için 2. hesaplamada skor YÜKSELİR; geçmişte 2 satır, en yeni ilk sırada',
      r6.status === 200 && (scoreC2?.score ?? 0) > (scoreC?.score ?? 100) &&
      Array.isArray(historyC) && historyC.length >= 2 && historyC[0].score === scoreC2?.score,
      `ilkSkor=${scoreC?.score}, ikinciSkor=${scoreC2?.score}, geçmiş=${historyC?.length}`);

    // ── Test 7: EN GÜNCEL liste — DISTINCT ON gerçekten en yeni satırı döndürür ──
    const latestList = (await call('GET', '/hardware-devices/health-scores', { token: owner })).body.data;
    const latestC = (latestList || []).find((r: any) => r.device_id === DEVICE_C);
    check('Test 7: GET /hardware-devices/health-scores — Cihaz C için EN GÜNCEL (2.) skor görünüyor',
      latestC?.score === scoreC2?.score,
      `latest=${latestC?.score}, ikinciHesap=${scoreC2?.score}`);

    // ── Test 8: minScore/maxScore filtresi ──────────────────────────
    const filteredHigh = (await call('GET', '/hardware-devices/health-scores?minScore=95', { token: owner })).body.data;
    check('Test 8: ?minScore=95 → Cihaz A\'yı İÇERİR (skor=100)',
      (filteredHigh || []).some((r: any) => r.device_id === DEVICE_A),
      `hasA=${(filteredHigh || []).some((r: any) => r.device_id === DEVICE_A)}`);

    // ── Test 9: online SLA — aynı presence verisinden, sağlık skorundan AYRI ──
    const slaC = (await call('GET', `/hardware-devices/${DEVICE_C}/online-sla?months=1`, { token: owner })).body.data;
    check('Test 9: online-sla — Cihaz C için insufficientData=false, onlineRatioPct 100 - offline_ratio_pct\'e YAKIN',
      slaC?.insufficientData === false && slaC?.onlineRatioPct !== null &&
      Math.abs((100 - slaC.onlineRatioPct) - Number(scoreC.offline_ratio_pct)) <= 5,
      JSON.stringify(slaC));

    // ── Test 10: firmware envanteri ──────────────────────────────
    const inventory = (await call('GET', '/hardware-devices/firmware-inventory', { token: owner })).body.data;
    const invA = (inventory || []).find((r: any) => r.device_id === DEVICE_A);
    check('Test 10: firmware-inventory — Cihaz A için firmware_version=1.4.2 görünüyor',
      invA?.firmware_version === '1.4.2', JSON.stringify(invA));

    // ── Test 11: Zod ─────────────────────────────────────────────
    const z1 = await call('POST', '/hardware-devices/health-scores/compute', { token: owner, body: { periodDays: 0 } });
    const z2 = await call('POST', '/hardware-devices/health-scores/compute', { token: owner, body: { minSamples: 0 } });
    check('Test 11: Zod — periodDays=0 / minSamples=0 → 400',
      z1.status === 400 && z2.status === 400, `periodDays=${z1.status}, minSamples=${z2.status}`);

    // ── Test 12: RBAC ──────────────────────────────────────────
    const r12a = await call('POST', '/hardware-devices/health-scores/compute', { token: siteMgr, body: {} }); // SITE_MANAGER hesaplayamaz
    const r12b = await call('GET', '/hardware-devices/health-scores');                                        // tokensiz
    const r12c = await call('GET', '/hardware-devices/health-scores', { token: siteMgr });                    // SITE_MANAGER okuyabilir
    check('Test 12: RBAC — SITE_MANAGER compute → 403, tokensiz list → 401, SITE_MANAGER list GET → 200',
      r12a.status === 403 && r12b.status === 401 && r12c.status === 200,
      `compute=${r12a.status}, tokensiz=${r12b.status}, listGet=${r12c.status}`);

    // ── Test 13: audit log ─────────────────────────────────────
    const auditRows = await q(
      `SELECT count(*)::int AS n FROM audit_logs
        WHERE tenant_id='comp-camsa' AND action='DEVICE_HEALTH_SCORE_COMPUTED'
          AND created_at > NOW() - INTERVAL '5 minutes'`
    );
    check('Test 13: audit_logs — DEVICE_HEALTH_SCORE_COMPUTED yazıldı',
      auditRows[0].n >= 1, `n=${auditRows[0].n}`);

  } finally {
    const c = pg();
    await c.connect();
    await c.query("DELETE FROM audit_logs WHERE tenant_id='comp-camsa' AND created_at > NOW() - INTERVAL '15 minutes' AND action='DEVICE_HEALTH_SCORE_COMPUTED'");
    await c.query("DELETE FROM alarm_events WHERE alarm_id IN (SELECT id FROM alarms WHERE tenant_id='comp-camsa' AND alarm_key LIKE 'DEVICE_HEALTH_SCORE_LOW:IOT308-TEST-%')");
    await c.query("DELETE FROM alarms WHERE tenant_id='comp-camsa' AND alarm_key LIKE 'DEVICE_HEALTH_SCORE_LOW:IOT308-TEST-%'");
    await c.query("DELETE FROM device_health_scores WHERE device_id LIKE 'IOT308-TEST-%'");
    await c.query("DELETE FROM device_presence_events WHERE device_id LIKE 'IOT308-TEST-%'");
    await c.query("DELETE FROM hardware_devices WHERE device_id LIKE 'IOT308-TEST-%'");
    await c.end();
    for (const id of [DEVICE_A, DEVICE_B, DEVICE_C]) {
      await redis.del(`device:${id}:health:total`, `device:${id}:health:error`, `device:${id}:state`);
    }
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  await redis.quit();
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => { console.error('💥', err); process.exit(1); });
