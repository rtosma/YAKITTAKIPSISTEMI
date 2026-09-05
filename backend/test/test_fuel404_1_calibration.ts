import crypto from 'crypto';
import { Client } from 'pg';
import Redis from 'ioredis';

/**
 * FUEL-404.1 — K-Factor Uzaktan Kalibrasyon: Komut, Ack, Geri Alma, Geçmiş.
 */

const API_URL = 'http://localhost:5000/api/v1';
const DEVICE_ID = 'ESP32-PUMP-01';
const DEVICE_SECRET = process.env.HW_SECRET_ESP32_PUMP_01 || 'secret_gebze_pump_8849';

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

function sign(secret: string, timestamp: string, nonce: string, rawBody: string): string {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${nonce}.${rawBody}`).digest('hex');
}

async function hwCall(path: string, body: object): Promise<{ status: number; body: any }> {
  const rawBody = JSON.stringify(body);
  const timestamp = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = sign(DEVICE_SECRET, timestamp, nonce, rawBody);
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Device-ID': DEVICE_ID,
      'X-Timestamp': timestamp,
      'X-Nonce': nonce,
      'X-Hardware-Signature': signature
    },
    body: rawBody
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, body: data };
}

async function run() {
  console.log('===========================================================');
  console.log('🔧 [FUEL-404.1] K-FACTOR UZAKTAN KALİBRASYON TESTİ');
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
  const pumpToken = await login('pompa-op-01'); // PUMP_OPERATOR — yetkisiz olmalı
  await db.query(`UPDATE hardware_devices SET k_factor = 450.0000 WHERE device_id = $1`, [DEVICE_ID]);

  try {
    // === Test 1: PUMP_OPERATOR kalibrasyon isteyemez ===
    const unauthorized = await call('POST', `/devices/${DEVICE_ID}/calibration`, {
      token: pumpToken,
      body: { newKFactor: 460, reason: 'Test — yetkisiz deneme' }
    });
    check(
      'Test 1: PUMP_OPERATOR kalibrasyon isteyemez (403)',
      unauthorized.status === 403,
      `status=${unauthorized.status}`
    );

    // === Test 2: Küçük bir değişiklik (%2) — ikinci onay istemeden doğrudan gönderilir ===
    const smallChange = await call('POST', `/devices/${DEVICE_ID}/calibration`, {
      token: camsaToken,
      body: { newKFactor: 459, reason: 'Küçük sapma düzeltmesi' } // 450->459 = %2
    });
    check(
      "Test 2: %20'nin altındaki değişiklik ikinci onay istemeden 'BEKLIYOR' (cihaza gönderildi) durumuna geçer",
      smallChange.status === 200 && smallChange.body.data.status === 'BEKLIYOR' && smallChange.body.data.requires_second_approval === false,
      `body=${JSON.stringify(smallChange.body)}`
    );
    const smallCommandId = smallChange.body.data.id;
    check(
      "Test 2b: sent_at gerçekten dolduruldu (MQTT'ye gönderildiği işaretlendi)",
      !!smallChange.body.data && (await db.query(`SELECT sent_at FROM calibration_commands WHERE id = $1`, [smallCommandId])).rows[0].sent_at !== null,
      `commandId=${smallCommandId}`
    );

    // === Test 3: Cihaz ACK gönderir — appliedKFactor uygulanır ===
    const ack = await hwCall('/telemetry/calibration-ack', { commandId: smallCommandId, status: 'ACK', appliedKFactor: 459 });
    check(
      'Test 3: Cihaz ACK gönderince komut ONAYLANDI durumuna geçer',
      ack.status === 200 && ack.body.data.status === 'ONAYLANDI',
      `body=${JSON.stringify(ack.body)}`
    );
    const deviceAfterAck = await db.query(`SELECT k_factor FROM hardware_devices WHERE device_id = $1`, [DEVICE_ID]);
    check(
      "Test 3b: hardware_devices.k_factor GERÇEKTEN 459'a güncellendi (ack sonrası)",
      Number(deviceAfterAck.rows[0].k_factor) === 459,
      `k_factor=${deviceAfterAck.rows[0].k_factor}`
    );

    // === Test 4: Aynı komuta İKİNCİ kez ack gönderilemez (zaten ONAYLANDI) ===
    const doubleAck = await hwCall('/telemetry/calibration-ack', { commandId: smallCommandId, status: 'ACK', appliedKFactor: 459 });
    check(
      'Test 4: Zaten onaylanmış bir komuta tekrar ack gönderilemez (404)',
      doubleAck.status === 404 && doubleAck.body?.details?.error === 'CALIBRATION_COMMAND_NOT_FOUND',
      `status=${doubleAck.status}, body=${JSON.stringify(doubleAck.body)}`
    );

    // === Test 5: BÜYÜK bir değişiklik (%30) — ikinci onay istemeli, cihaza HENÜZ gönderilmemeli ===
    const bigChange = await call('POST', `/devices/${DEVICE_ID}/calibration`, {
      token: camsaToken,
      body: { newKFactor: 596.7, reason: 'Büyük sapma — yanlış K-factor şüphesi' } // 459 -> 596.7 = %30
    });
    check(
      "Test 5: %20'yi aşan değişiklik 'IKINCI_ONAY_BEKLIYOR' durumunda kalır, cihaza gönderilmez",
      bigChange.status === 200 && bigChange.body.data.status === 'IKINCI_ONAY_BEKLIYOR' && bigChange.body.data.requires_second_approval === true,
      `body=${JSON.stringify(bigChange.body)}`
    );
    const bigCommandId = bigChange.body.data.id;
    const notSentYet = await db.query(`SELECT sent_at, k_factor FROM calibration_commands cc JOIN hardware_devices hd ON hd.device_id = cc.device_id WHERE cc.id = $1`, [bigCommandId]);
    check(
      'Test 5b: sent_at hâlâ NULL (cihaza gönderilmedi) ve hardware_devices.k_factor DEĞİŞMEDİ',
      notSentYet.rows[0].sent_at === null && Number(notSentYet.rows[0].k_factor) === 459,
      `row=${JSON.stringify(notSentYet.rows[0])}`
    );

    // === Test 6: İkinci onay verilir — ŞİMDİ cihaza gönderilir ===
    const approve = await call('POST', `/devices/${DEVICE_ID}/calibration/${bigCommandId}/approve`, { token: camsaToken });
    check(
      "Test 6: İkinci onay sonrası komut 'BEKLIYOR'ya geçer (cihaza gönderildi)",
      approve.status === 200 && approve.body.data.status === 'BEKLIYOR' && !!approve.body.data.approved_by,
      `body=${JSON.stringify(approve.body)}`
    );

    // === Test 7: Cihaz bu sefer NACK gönderir (örn. donanımsal sınır) ===
    const nack = await hwCall('/telemetry/calibration-ack', { commandId: bigCommandId, status: 'NACK', reason: 'K-factor donanım sınırının dışında' });
    check(
      'Test 7: Cihaz NACK gönderince komut REDDEDILDI durumuna geçer, k_factor DEĞİŞMEZ',
      nack.status === 200 && nack.body.data.status === 'REDDEDILDI',
      `body=${JSON.stringify(nack.body)}`
    );
    const deviceAfterNack = await db.query(`SELECT k_factor FROM hardware_devices WHERE device_id = $1`, [DEVICE_ID]);
    check(
      'Test 7b: NACK sonrası k_factor hâlâ 459 (değişmedi)',
      Number(deviceAfterNack.rows[0].k_factor) === 459,
      `k_factor=${deviceAfterNack.rows[0].k_factor}`
    );

    // === Test 8: Geçmiş — tüm komutlar (kabul/ret/onay bekleyen) sırayla listelenir ===
    const history = await call('GET', `/devices/${DEVICE_ID}/calibration-history`, { token: camsaToken });
    const historyIds = history.body.data.map((h: any) => h.id);
    check(
      'Test 8: Kalibrasyon geçmişi tüm komutları (ONAYLANDI + REDDEDILDI) içeriyor',
      history.status === 200 && historyIds.includes(smallCommandId) && historyIds.includes(bigCommandId),
      `toplam kayıt=${history.body.totalCount}`
    );

    // === Test 9: Geri alma — bir önceki ONAYLANDI değere (450) döner ===
    const rollback = await call('POST', `/devices/${DEVICE_ID}/calibration/rollback`, { token: camsaToken });
    check(
      'Test 9: Geri alma komutu bir önceki ONAYLANDI değere (450) döner, is_rollback=true',
      rollback.status === 200 && Number(rollback.body.data.new_k_factor) === 450 && rollback.body.data.is_rollback === true && rollback.body.data.status === 'BEKLIYOR',
      `body=${JSON.stringify(rollback.body)}`
    );
    const rollbackAck = await hwCall('/telemetry/calibration-ack', { commandId: rollback.body.data.id, status: 'ACK', appliedKFactor: 450 });
    const deviceAfterRollback = await db.query(`SELECT k_factor FROM hardware_devices WHERE device_id = $1`, [DEVICE_ID]);
    check(
      'Test 9b: Geri alma ack sonrası k_factor gerçekten 450\'ye döndü',
      rollbackAck.status === 200 && Number(deviceAfterRollback.rows[0].k_factor) === 450,
      `k_factor=${deviceAfterRollback.rows[0].k_factor}`
    );

    // === Test 10: Kalibrasyon geçmişi HİÇBİR ZAMAN silinmedi (tüm satırlar hâlâ mevcut) ===
    const finalHistory = await call('GET', `/devices/${DEVICE_ID}/calibration-history`, { token: camsaToken });
    check(
      'Test 10: Tüm geçmiş kayıtları (append-only) korunuyor',
      finalHistory.body.totalCount >= 3, // küçük değişiklik + büyük değişiklik + geri alma
      `toplam kayıt=${finalHistory.body.totalCount}`
    );

    // === Test 10b: DB SEVİYESİNDE de silinemez — app_user rolüyle DELETE/
    // TRUNCATE reddedilmeli (status UPDATE'i ise meşru olduğu için serbest
    // bırakılmalı, audit_logs'un tam kilidinden FARKLI olarak). ===
    const rawClient = new Client({
      host: process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      user: process.env.POSTGRES_USER || 'postgres',
      password: process.env.POSTGRES_PASSWORD || 'postgres',
      database: process.env.POSTGRES_DB || 'yakittakip_db'
    });
    await rawClient.connect();
    async function attemptDeleteAsAppUser(sql: string): Promise<{ rejected: boolean; message: string }> {
      try {
        await rawClient.query('BEGIN');
        await rawClient.query('SET LOCAL ROLE app_user;');
        await rawClient.query(sql);
        return { rejected: false, message: '(hata fırlatılmadı — BEKLENMEYEN)' };
      } catch (err: any) {
        return { rejected: /permission denied/i.test(err.message), message: err.message };
      } finally {
        await rawClient.query('ROLLBACK').catch(() => {});
      }
    }
    const deleteAttempt = await attemptDeleteAsAppUser(`DELETE FROM calibration_commands WHERE id = '${smallCommandId}'`);
    check('Test 10b: app_user rolüyle DELETE veritabanı seviyesinde reddedilir', deleteAttempt.rejected, deleteAttempt.message);
    const truncateAttempt = await attemptDeleteAsAppUser('TRUNCATE calibration_commands');
    check('Test 10c: app_user rolüyle TRUNCATE veritabanı seviyesinde reddedilir', truncateAttempt.rejected, truncateAttempt.message);
    await rawClient.end();

    // === Test 11: Geçersiz commandId ile ack (404) ===
    const invalidAck = await hwCall('/telemetry/calibration-ack', { commandId: 'nonexistent-id', status: 'ACK', appliedKFactor: 999 });
    check(
      'Test 11: Var olmayan bir commandId ile ack reddedilir (404)',
      invalidAck.status === 404,
      `status=${invalidAck.status}`
    );
  } finally {
    await db.query(`UPDATE hardware_devices SET k_factor = NULL WHERE device_id = $1`, [DEVICE_ID]);
    await db.query(`DELETE FROM calibration_commands WHERE device_id = $1`, [DEVICE_ID]);
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
