import crypto from 'crypto';
import { Client } from 'pg';
import Redis from 'ioredis';

/**
 * FUEL-410 — Hibrit fail-open politika motoru.
 */

const API_URL = 'http://localhost:5000/api/v1';
const DEVICE_ID = 'ESP32-PUMP-01';
const DEVICE_SECRET = process.env.HW_SECRET_ESP32_PUMP_01 || 'secret_gebze_pump_8849';
const SITE_NAME = 'Gebze Ana Şantiye';

const redis = new Redis({ host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379', 10) });

async function resetIpLoginRateLimit(): Promise<void> {
  const keys = await redis.keys('rl:auth-login:*');
  if (keys.length > 0) await redis.del(...keys);
}

async function call(method: string, path: string, opts: { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
  if (path === '/auth/login') await resetIpLoginRateLimit();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function login(username: string): Promise<string> {
  const res = await call('POST', '/auth/login', { body: { username, password: '123456' } });
  if (!res.body.accessToken) throw new Error(`Ön koşul: ${username} ile giriş başarısız: ${JSON.stringify(res.body)}`);
  return res.body.accessToken;
}

function sign(timestamp: string, nonce: string, rawBody: string): string {
  return crypto.createHmac('sha256', DEVICE_SECRET).update(`${timestamp}.${nonce}.${rawBody}`).digest('hex');
}

async function hwGet(path: string): Promise<{ status: number; body: any }> {
  // hardwareAuthMiddleware, gövdesiz bir istekte req.rawBody hiç dolmadığından
  // (express.json yalnızca gerçek bir JSON gövdesi varsa 'verify' callback'ini
  // tetikler) req.body'nin varsayılanı olan {}'i imzalıyor — bkz.
  // hardwareAuthMiddleware.ts: `(req as any).rawBody || Buffer.from(JSON.stringify(req.body || {}))`.
  const rawBody = '{}';
  const timestamp = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = sign(timestamp, nonce, rawBody);
  const res = await fetch(`${API_URL}${path}`, {
    method: 'GET',
    headers: {
      'X-Device-ID': DEVICE_ID,
      'X-Timestamp': timestamp,
      'X-Nonce': nonce,
      'X-Hardware-Signature': signature
    }
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, body: data };
}

async function hwSyncBatch(records: object[]): Promise<{ status: number; body: any }> {
  const body = JSON.stringify({ records });
  const timestamp = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = sign(timestamp, nonce, body);
  const res = await fetch(`${API_URL}/telemetry/sync-batch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Device-ID': DEVICE_ID,
      'X-Timestamp': timestamp,
      'X-Nonce': nonce,
      'X-Hardware-Signature': signature
    },
    body
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, body: data };
}

async function run() {
  console.log('===========================================================');
  console.log('🛡️  [FUEL-410] HİBRİT FAIL-OPEN POLİTİKA MOTORU TESTİ');
  console.log('===========================================================\n');

  let passed = 0;
  let total = 0;
  function check(name: string, condition: boolean, detail: string) {
    total++;
    if (condition) {
      console.log(`✅ [PASS] ${name}`);
      console.log(`   ${detail}\n`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${name}`);
      console.error(`   ${detail}\n`);
    }
  }

  const db = new Client({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database: process.env.POSTGRES_DB || 'yakittakip_db'
  });
  await db.connect();

  const camsaToken = await login('camsa');
  const pumpToken = await login('pompa-op-01');
  const baseSeq = Date.now();
  const tankBefore = await db.query(`SELECT current_level_liters FROM tanks WHERE id = 'tank-gebze-1'`);
  const levelBefore = Number(tankBefore.rows[0].current_level_liters);

  try {
    // === Test 1: PUMP_OPERATOR politika tanımlayamaz ===
    const unauthorized = await call('POST', '/policies/fail-open', {
      token: pumpToken,
      body: { offlineDispenseAllowed: true, maxLitersPerVehicle: 100, maxDailyDispensesPerVehicle: 1, whitelistFreshnessHours: 12, failClose: false }
    });
    check('Test 1: PUMP_OPERATOR fail-open politikası tanımlayamaz (403)', unauthorized.status === 403, `status=${unauthorized.status}`);

    // === Test 2: Hiç politika tanımlanmamışken cihaz sistem varsayılanını çeker ===
    const defaultPolicy = await hwGet('/telemetry/fail-open-policy');
    check(
      'Test 2: Politika hiç tanımlanmamışken sistem varsayılanı (200L/1 alım/24sa) dönüyor',
      defaultPolicy.status === 200 && Number(defaultPolicy.body.data.max_liters_per_vehicle) === 200 &&
        defaultPolicy.body.data.max_daily_dispenses_per_vehicle === 1 && defaultPolicy.body.data.offline_dispense_allowed === true,
      `body=${JSON.stringify(defaultPolicy.body)}`
    );

    // === Test 3: Şantiye bazında özel bir politika tanımlanır (10L/gün limiti) ===
    const setPolicy = await call('POST', '/policies/fail-open', {
      token: camsaToken,
      body: { siteName: SITE_NAME, offlineDispenseAllowed: true, maxLitersPerVehicle: 10, maxDailyDispensesPerVehicle: 1, whitelistFreshnessHours: 12, failClose: false }
    });
    check(
      'Test 3: Şantiye bazında özel bir politika (10L üst sınır) tanımlanabiliyor',
      setPolicy.status === 200 && Number(setPolicy.body.data.max_liters_per_vehicle) === 10,
      `body=${JSON.stringify(setPolicy.body)}`
    );
    const policyId = setPolicy.body.data.id;

    // === Test 4: Cihaz artık ŞANTİYEYE ÖZEL politikayı çekiyor (tenant genelini değil) ===
    const fetchedPolicy = await hwGet('/telemetry/fail-open-policy');
    check(
      'Test 4: Cihaz artık şantiyeye özel politikayı (id eşleşen) çekiyor',
      fetchedPolicy.status === 200 && fetchedPolicy.body.data.id === policyId,
      `body=${JSON.stringify(fetchedPolicy.body)}`
    );

    // === Test 5: Dağıtım durumu artık bu cihaz için GÜNCEL gösteriyor (az önce çekti) ===
    const deploymentStatus = await call('GET', '/policies/fail-open/deployment-status', { token: camsaToken });
    const thisDeviceStatus = deploymentStatus.body.data.find((d: any) => d.deviceId === DEVICE_ID);
    check(
      "Test 5: Cihaz politikayı çektikten sonra dağıtım durumu 'GÜNCEL' gösteriyor",
      deploymentStatus.status === 200 && thisDeviceStatus?.status === 'GÜNCEL' && thisDeviceStatus?.effectivePolicyId === policyId,
      `row=${JSON.stringify(thisDeviceStatus)}`
    );

    // === Test 6: YENİ bir politika tanımlanınca (henüz çekilmedi) durum 'DAĞITIM_BEKLIYOR'a döner ===
    const newPolicy = await call('POST', '/policies/fail-open', {
      token: camsaToken,
      body: { siteName: SITE_NAME, offlineDispenseAllowed: true, maxLitersPerVehicle: 15, maxDailyDispensesPerVehicle: 1, whitelistFreshnessHours: 12, failClose: false }
    });
    const deploymentStatus2 = await call('GET', '/policies/fail-open/deployment-status', { token: camsaToken });
    const thisDeviceStatus2 = deploymentStatus2.body.data.find((d: any) => d.deviceId === DEVICE_ID);
    check(
      "Test 6: Yeni politika tanımlanınca (cihaz henüz çekmedi) durum 'DAĞITIM_BEKLIYOR' oluyor",
      thisDeviceStatus2?.status === 'DAĞITIM_BEKLIYOR' && thisDeviceStatus2?.effectivePolicyId === newPolicy.body.data.id,
      `row=${JSON.stringify(thisDeviceStatus2)}`
    );

    // === Test 7: 15L üst sınırı aşan bir çevrimdışı kayıt kabul edilir AMA politika ihlali olarak işaretlenir ===
    const seq1 = baseSeq + 1;
    const overLimitRecord = await hwSyncBatch([{
      localSequenceId: seq1,
      deviceTimestamp: new Date(Date.now() - 60_000).toISOString(),
      siteName: SITE_NAME,
      vehiclePlate: '34 CTP 82',
      tankName: 'Gebze Ana Tank (T-1)',
      amountLiters: 25, // policy limiti (15L) üstünde
      flowRateLpm: 20
    }]);
    check(
      "Test 7: Politika limitini (15L) aşan çevrimdışı kayıt YİNE DE kabul edilir (fuel zaten dispense edildi)",
      overLimitRecord.status === 200 && overLimitRecord.body.results[0].status === 'ACCEPTED',
      `body=${JSON.stringify(overLimitRecord.body)}`
    );
    const violationLog = await db.query(
      `SELECT after_value FROM audit_logs WHERE action = 'OFFLINE_DISPENSE_POLICY_VIOLATION' AND target_id = '34 CTP 82' ORDER BY created_at DESC LIMIT 1`
    );
    check(
      "Test 7b: Aşım 'OFFLINE_DISPENSE_POLICY_VIOLATION' olarak audit_logs'a yazıldı (MAX_LITERS_PER_VEHICLE_EXCEEDED)",
      violationLog.rows.length > 0 && violationLog.rows[0].after_value?.violations?.includes('MAX_LITERS_PER_VEHICLE_EXCEEDED'),
      `row=${JSON.stringify(violationLog.rows[0])}`
    );

    // === Test 8: Tam fail-close politikası tanımlanır — sonraki çevrimdışı kayıt FAIL_CLOSE_VIOLATED olarak işaretlenir ===
    await call('POST', '/policies/fail-open', {
      token: camsaToken,
      body: { siteName: SITE_NAME, offlineDispenseAllowed: false, maxLitersPerVehicle: 200, maxDailyDispensesPerVehicle: 5, whitelistFreshnessHours: 12, failClose: true }
    });
    const seq2 = baseSeq + 2;
    await hwSyncBatch([{
      localSequenceId: seq2,
      deviceTimestamp: new Date(Date.now() - 30_000).toISOString(),
      siteName: SITE_NAME,
      vehiclePlate: '34 CTP 82',
      tankName: 'Gebze Ana Tank (T-1)',
      amountLiters: 5,
      flowRateLpm: 20
    }]);
    const failCloseLog = await db.query(
      `SELECT after_value FROM audit_logs WHERE action = 'OFFLINE_DISPENSE_POLICY_VIOLATION' AND target_id = '34 CTP 82' ORDER BY created_at DESC LIMIT 1`
    );
    check(
      "Test 8: Tam fail-close politikasında gelen bir çevrimdışı kayıt FAIL_CLOSE_VIOLATED olarak işaretleniyor",
      failCloseLog.rows.length > 0 && failCloseLog.rows[0].after_value?.violations?.includes('FAIL_CLOSE_VIOLATED'),
      `row=${JSON.stringify(failCloseLog.rows[0])}`
    );

    // === Test 9: Günlük limiti 1 olan bir politikada AYNI güne ait İKİNCİ
    // alım MAX_DAILY_DISPENSES_EXCEEDED olarak işaretlenir (başka bir araç
    // kullanılıyor — '34 BKT 19' — Test 7/8'deki '34 CTP 82'nin GÜNLÜK
    // sayacını etkilememesi için). ===
    await call('POST', '/policies/fail-open', {
      token: camsaToken,
      body: { siteName: SITE_NAME, offlineDispenseAllowed: true, maxLitersPerVehicle: 200, maxDailyDispensesPerVehicle: 1, whitelistFreshnessHours: 12, failClose: false }
    });
    const seq3 = baseSeq + 3;
    const seq4 = baseSeq + 4;
    await hwSyncBatch([{
      localSequenceId: seq3,
      deviceTimestamp: new Date(Date.now() - 20_000).toISOString(),
      siteName: SITE_NAME, vehiclePlate: '34 BKT 19', tankName: 'Gebze Ana Tank (T-1)', amountLiters: 5, flowRateLpm: 20
    }]);
    await hwSyncBatch([{
      localSequenceId: seq4,
      deviceTimestamp: new Date(Date.now() - 10_000).toISOString(),
      siteName: SITE_NAME, vehiclePlate: '34 BKT 19', tankName: 'Gebze Ana Tank (T-1)', amountLiters: 5, flowRateLpm: 20
    }]);
    const dailyLog = await db.query(
      `SELECT after_value FROM audit_logs WHERE action = 'OFFLINE_DISPENSE_POLICY_VIOLATION' AND target_id = '34 BKT 19' AND after_value->>'localSequenceId' = $1`,
      [String(seq4)]
    );
    check(
      "Test 9: Günlük limiti (1) aşan İKİNCİ alım MAX_DAILY_DISPENSES_EXCEEDED olarak işaretleniyor (ilki işaretlenmiyor)",
      dailyLog.rows.length > 0 && dailyLog.rows[0].after_value?.violations?.includes('MAX_DAILY_DISPENSES_EXCEEDED'),
      `row=${JSON.stringify(dailyLog.rows[0])}`
    );

    // === Test 10: GET /policies/fail-open geçmiş TÜM versiyonları listeler ===
    const history = await call('GET', '/policies/fail-open', { token: camsaToken });
    check(
      'Test 10: Politika geçmişi en az 3 versiyon (10L, 15L, fail-close) içeriyor',
      history.status === 200 && history.body.totalCount >= 3,
      `toplam=${history.body.totalCount}`
    );
  } finally {
    await db.query(`DELETE FROM transactions WHERE device_id = $1 AND local_sequence_id >= $2`, [DEVICE_ID, baseSeq]);
    await db.query(`DELETE FROM fail_open_policies WHERE site_name = $1`, [SITE_NAME]);
    await db.query(`UPDATE hardware_devices SET last_fail_open_policy_id = NULL WHERE device_id = $1`, [DEVICE_ID]);
    await db.query(`UPDATE tanks SET current_level_liters = $1, status = 'GÜVENLİ' WHERE id = 'tank-gebze-1'`, [levelBefore]);
    await resetIpLoginRateLimit();
    redis.disconnect();
    await db.end();
  }

  console.log('===========================================================');
  console.log(`📊 TEST SONUÇLARI: ${passed} / ${total} TEST BAŞARILI`);
  console.log('===========================================================');
  if (passed !== total) process.exit(1);
}

run().catch((err) => {
  console.error('💥 Test çalıştırılamadı:', err);
  process.exit(1);
});
