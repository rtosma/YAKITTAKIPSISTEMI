import crypto from 'crypto';
import { Client } from 'pg';
import Redis from 'ioredis';

/**
 * FUEL-404.2 — Kalibrasyon test alımı sihirbazı (referans kap ile sapma hesabı).
 */

const API_URL = 'http://localhost:5000/api/v1';
const DEVICE_ID = 'ESP32-PUMP-01';
const DEVICE_SECRET = process.env.HW_SECRET_ESP32_PUMP_01 || 'secret_gebze_pump_8849';

async function hwAckCalibration(commandId: string, appliedKFactor: number): Promise<{ status: number; body: any }> {
  const body = JSON.stringify({ commandId, status: 'ACK', appliedKFactor });
  const timestamp = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = crypto.createHmac('sha256', DEVICE_SECRET).update(`${timestamp}.${nonce}.${body}`).digest('hex');
  const res = await fetch(`${API_URL}/telemetry/calibration-ack`, {
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

async function run() {
  console.log('===========================================================');
  console.log('🧪 [FUEL-404.2] KALİBRASYON TEST ALIMI SİHİRBAZI TESTİ');
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
  const tankBefore = await db.query(`SELECT current_level_liters FROM tanks WHERE id = 'tank-gebze-1'`);
  const levelBefore = Number(tankBefore.rows[0].current_level_liters);

  try {
    // === Test 1: hiç kalibre edilmemiş (k_factor NULL) bir cihazda test alımı reddedilir ===
    await db.query(`UPDATE hardware_devices SET k_factor = NULL WHERE device_id = $1`, [DEVICE_ID]);
    const noBaseline = await call('POST', `/devices/${DEVICE_ID}/test-intake`, {
      token: camsaToken,
      body: { tankName: 'Gebze Ana Tank (T-1)', siteName: 'Gebze Ana Şantiye', referenceVolumeLiters: 20, measuredLiters: 20 }
    });
    check(
      "Test 1: k_factor'ü hiç ayarlanmamış cihazda test alımı reddedilir (NO_BASELINE_K_FACTOR)",
      noBaseline.status === 409 && noBaseline.body?.details?.error === 'NO_BASELINE_K_FACTOR',
      `status=${noBaseline.status}, body=${JSON.stringify(noBaseline.body)}`
    );

    await db.query(`UPDATE hardware_devices SET k_factor = 450.0000 WHERE device_id = $1`, [DEVICE_ID]);

    // === Test 2: 20L referans kaba karşı cihaz 21L ölçtü — %5 sapma, K-factor önerisi doğru hesaplanmalı ===
    const intake1 = await call('POST', `/devices/${DEVICE_ID}/test-intake`, {
      token: camsaToken,
      body: { tankName: 'Gebze Ana Tank (T-1)', siteName: 'Gebze Ana Şantiye', referenceVolumeLiters: 20, measuredLiters: 21, ambientTemperatureCelsius: 24.5 }
    });
    // deviationRatio = |21-20|/20 = 0.05 ; proposedKFactor = 450 * (21/20) = 472.5
    check(
      'Test 2: Sapma yüzdesi (%5) ve önerilen K-factor (472.5) doğru hesaplanıyor',
      intake1.status === 200 &&
        Math.abs(Number(intake1.body.data.deviation_ratio) - 0.05) < 0.0001 &&
        Math.abs(Number(intake1.body.data.proposed_k_factor) - 472.5) < 0.01,
      `body=${JSON.stringify(intake1.body)}`
    );
    check(
      'Test 2b: Tek ölçüme dayandığı (basedOnSingleMeasurement) doğru işaretleniyor',
      intake1.body.basedOnSingleMeasurement === true && Math.abs(intake1.body.recommendedKFactor - 472.5) < 0.01,
      `basedOnSingleMeasurement=${intake1.body.basedOnSingleMeasurement}, recommendedKFactor=${intake1.body.recommendedKFactor}`
    );

    // === Test 3: Test alımı transactions'a HİÇ yazılmadı (faturalandırılmadı) ama tankı düşürdü ===
    const txCount = await db.query(`SELECT COUNT(*)::int AS c FROM transactions WHERE tank_name = 'Gebze Ana Tank (T-1)' AND created_at > NOW() - INTERVAL '1 minute'`);
    check(
      'Test 3: Test alımı transactions tablosuna HİÇ yazmadı (normal ikmal olarak faturalandırılmadı)',
      txCount.rows[0].c === 0,
      `son 1 dakikadaki transactions sayısı=${txCount.rows[0].c}`
    );
    const tankAfterIntake1 = await db.query(`SELECT current_level_liters FROM tanks WHERE id = 'tank-gebze-1'`);
    check(
      'Test 3b: Tank seviyesi GERÇEKTEN 21L düştü (stoktan düşme AC\'si)',
      Math.abs(levelBefore - Number(tankAfterIntake1.rows[0].current_level_liters) - 21) < 0.01,
      `önce=${levelBefore}, sonra=${tankAfterIntake1.rows[0].current_level_liters}`
    );

    // === Test 4: İKİNCİ bir test alımı — artık 2 ölçümün ortalaması önerilir ===
    const intake2 = await call('POST', `/devices/${DEVICE_ID}/test-intake`, {
      token: camsaToken,
      body: { tankName: 'Gebze Ana Tank (T-1)', siteName: 'Gebze Ana Şantiye', referenceVolumeLiters: 20, measuredLiters: 20.6 }
    });
    // ikinci ölçüm proposedKFactor = 450 * (20.6/20) = 463.5 ; ortalama (472.5+463.5)/2 = 468
    check(
      "Test 4: İkinci ölçümden sonra basedOnSingleMeasurement=false, ortalama öneri hesaplanıyor",
      intake2.status === 200 && intake2.body.basedOnSingleMeasurement === false && Math.abs(intake2.body.recommendedKFactor - 468) < 0.01,
      `body.recommendedKFactor=${intake2.body.recommendedKFactor}, basedOnSingleMeasurement=${intake2.body.basedOnSingleMeasurement}`
    );

    // === Test 5: Bu cihazın önerilen K-factor'üyle gerçek bir kalibrasyon isteği açılır, ack alınır ===
    const calibRequest = await call('POST', `/devices/${DEVICE_ID}/calibration`, {
      token: camsaToken,
      body: { newKFactor: 468, reason: 'FUEL-404.2 test alımlarının ortalamasına göre düzeltme' }
    });
    check('Test 5 ön koşul: kalibrasyon isteği oluşturuldu', calibRequest.status === 200, JSON.stringify(calibRequest.body));

    // Doğrulama alımı yalnızca GERÇEKTEN uygulanmış (ONAYLANDI) bir komutu
    // işaret edebilir — cihaz önce ack göndermeli.
    const ackResult = await hwAckCalibration(calibRequest.body.data.id, 468);
    check('Test 5b ön koşul: cihaz kalibrasyonu ack\'ledi', ackResult.status === 200 && ackResult.body.data.status === 'ONAYLANDI', JSON.stringify(ackResult.body));

    // === Test 5c: Henüz ONAYLANMAMIŞ bir komutu doğrulamaya çalışmak reddedilir ===
    const secondCalibRequest = await call('POST', `/devices/${DEVICE_ID}/calibration`, {
      token: camsaToken,
      body: { newKFactor: 469, reason: 'Test 5c için ikinci komut' }
    });
    const prematureVerification = await call('POST', `/devices/${DEVICE_ID}/test-intake`, {
      token: camsaToken,
      body: {
        tankName: 'Gebze Ana Tank (T-1)', siteName: 'Gebze Ana Şantiye',
        referenceVolumeLiters: 20, measuredLiters: 20.01,
        verifiesCalibrationCommandId: secondCalibRequest.body.data.id
      }
    });
    check(
      'Test 5c: Henüz ack almamış (BEKLIYOR) bir komutu "doğrulamaya" çalışmak reddedilir (CALIBRATION_NOT_YET_ACKED)',
      prematureVerification.status === 409 && prematureVerification.body?.details?.error === 'CALIBRATION_NOT_YET_ACKED',
      `status=${prematureVerification.status}, body=${JSON.stringify(prematureVerification.body)}`
    );

    // === Test 6: Doğrulama alımı — verifiesCalibrationCommandId ile işaretlenmiş yeni bir test alımı ===
    const verificationIntake = await call('POST', `/devices/${DEVICE_ID}/test-intake`, {
      token: camsaToken,
      body: {
        tankName: 'Gebze Ana Tank (T-1)', siteName: 'Gebze Ana Şantiye',
        referenceVolumeLiters: 20, measuredLiters: 20.02,
        verifiesCalibrationCommandId: calibRequest.body.data.id
      }
    });
    check(
      'Test 6: Doğrulama alımı verifies_calibration_command_id ile kaydediliyor',
      verificationIntake.status === 200 && verificationIntake.body.data.verifies_calibration_command_id === calibRequest.body.data.id,
      `body=${JSON.stringify(verificationIntake.body.data)}`
    );

    // === Test 7: Doğrulama alımı audit_logs'a CALIBRATION_VERIFICATION_PASS_RECORDED olarak yazıldı ===
    const auditRow = await db.query(
      `SELECT action, after_value FROM audit_logs WHERE action = 'CALIBRATION_VERIFICATION_PASS_RECORDED' AND target_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [DEVICE_ID]
    );
    check(
      "Test 7: Doğrulama alımı 'CALIBRATION_VERIFICATION_PASS_RECORDED' olarak audit_logs'a (kalibrasyon geçmişine) yazıldı",
      auditRow.rows.length > 0 && auditRow.rows[0].after_value?.verifiesCalibrationCommandId === calibRequest.body.data.id,
      `row=${JSON.stringify(auditRow.rows[0])}`
    );

    // === Test 8: Normal (doğrulama olmayan) bir test alımı CALIBRATION_TEST_INTAKE_RECORDED olarak yazılır ===
    const normalAuditRow = await db.query(
      `SELECT action FROM audit_logs WHERE action = 'CALIBRATION_TEST_INTAKE_RECORDED' AND target_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [DEVICE_ID]
    );
    check(
      "Test 8: Normal test alımı 'CALIBRATION_TEST_INTAKE_RECORDED' olarak ayrı sınıflandırılıyor",
      normalAuditRow.rows.length > 0,
      `bulundu=${normalAuditRow.rows.length > 0}`
    );

    // === Test 9: GET /devices/:id/test-intakes tüm alımları listeliyor ===
    const list = await call('GET', `/devices/${DEVICE_ID}/test-intakes`, { token: camsaToken });
    check(
      'Test 9: Test alımları geçmişi en az 3 kayıt (2 normal + 1 doğrulama) içeriyor',
      list.status === 200 && list.body.totalCount >= 3,
      `toplam=${list.body.totalCount}`
    );

    // === Test 10: Var olmayan bir cihaz için test alımı 404 ===
    const noDevice = await call('POST', `/devices/NONEXISTENT-DEVICE/test-intake`, {
      token: camsaToken,
      body: { tankName: 'Gebze Ana Tank (T-1)', siteName: 'Gebze Ana Şantiye', referenceVolumeLiters: 20, measuredLiters: 20 }
    });
    check('Test 10: Var olmayan cihaz için test alımı 404 döner', noDevice.status === 404, `status=${noDevice.status}`);
  } finally {
    await db.query(`DELETE FROM calibration_test_intakes WHERE device_id = $1`, [DEVICE_ID]);
    await db.query(`DELETE FROM calibration_commands WHERE device_id = $1`, [DEVICE_ID]);
    await db.query(`UPDATE hardware_devices SET k_factor = NULL WHERE device_id = $1`, [DEVICE_ID]);
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
