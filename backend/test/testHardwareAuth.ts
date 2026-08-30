import crypto from 'crypto';

const API_URL = 'http://localhost:5000/api/v1/telemetry/hardware-data';
const DEVICE_ID = 'ESP32-PUMP-01';
const DEVICE_SECRET = 'secret_gebze_pump_8849';

function generateHmacSignature(timestamp: string, rawBody: string, secret: string): string {
  const payloadToSign = `${timestamp}.${rawBody}`;
  return crypto.createHmac('sha256', secret).update(payloadToSign).digest('hex');
}

async function runHardwareAuthTests() {
  console.log('===========================================================');
  console.log('🔒 [AUTH-202] DONANIM HMAC-SHA256 ENTIGRASYON TESTLERİ');
  console.log('===========================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  // Helper tester
  async function testCase(
    testName: string,
    payload: object,
    timestamp: string,
    signature: string | null,
    deviceId: string | null,
    expectedStatus: number,
    expectedErrorSubstring: string | null
  ) {
    totalTests++;
    const rawBody = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    if (deviceId) headers['X-Device-ID'] = deviceId;
    if (timestamp) headers['X-Timestamp'] = timestamp;
    if (signature) headers['X-Hardware-Signature'] = signature;

    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers,
        body: rawBody
      });

      const data = await res.json();
      const statusMatch = res.status === expectedStatus;
      const errorMatch = expectedErrorSubstring ? (data.error === expectedErrorSubstring || data.message?.includes(expectedErrorSubstring)) : data.success === true;

      if (statusMatch && errorMatch) {
        console.log(`✅ [PASS] ${testName}`);
        console.log(`   HTTP ${res.status} | Yanıt: ${data.message || data.error}\n`);
        passedTests++;
      } else {
        console.error(`❌ [FAIL] ${testName}`);
        console.error(`   Beklenen Status: ${expectedStatus}, Alınan: ${res.status}`);
        console.error(`   Beklenen Hata Kodu: ${expectedErrorSubstring}`);
        console.error(`   Gelen Yanıt:`, JSON.stringify(data), '\n');
      }
    } catch (err: any) {
      console.error(`❌ [ERROR] ${testName}: Sunucu erişim hatası`, err.message);
    }
  }

  // TEST 1: Geçerli HMAC-SHA256 İmzası (Doğru ESP32 İmzası)
  const validPayload = { pumpId: 'PUMP-01', litersDispensed: 45.2, flowRate: 12.8, vehicleTag: 'TAG-882910' };
  const validRawBody = JSON.stringify(validPayload);
  const nowTs = Date.now().toString();
  const validSig = generateHmacSignature(nowTs, validRawBody, DEVICE_SECRET);

  await testCase(
    'Test 1: Geçerli ESP32 HMAC-SHA256 İmzalı Telemetri İsteği',
    validPayload,
    nowTs,
    validSig,
    DEVICE_ID,
    200,
    null
  );

  // TEST 2: Replay Attack Saldırısı (45 Saniye Eski Zaman Damgası)
  const oldTs = (Date.now() - 45000).toString(); // 45 seconds ago
  const oldSig = generateHmacSignature(oldTs, validRawBody, DEVICE_SECRET);

  await testCase(
    'Test 2: Replay Attack Engelleme (45 Saniyelik Eski Zaman Damgası)',
    validPayload,
    oldTs,
    oldSig,
    DEVICE_ID,
    401,
    'REPLAY_ATTACK_DETECTED'
  );

  // TEST 3: Veri Manipülasyonu / Yanlış İmza Saldırısı (Data Tampering)
  const fakeSig = 'a1b2c3d4e5f60011223344556677889900aabbccddeeff001122334455667788';

  await testCase(
    'Test 3: Manipüle Edilmiş Veri / Yanlış Kriptografik İmza Reddi',
    validPayload,
    nowTs,
    fakeSig,
    DEVICE_ID,
    401,
    'INVALID_HARDWARE_SIGNATURE'
  );

  // TEST 4: Eksik Donanım Başlıkları (Header Bulunmama)
  await testCase(
    'Test 4: Eksik Donanım Başlıkları Reddi',
    validPayload,
    nowTs,
    null, // Missing signature header
    DEVICE_ID,
    401,
    'MISSING_HARDWARE_HEADERS'
  );

  console.log('===========================================================');
  console.log(`📊 TEST SONUÇLARI: ${passedTests} / ${totalTests} TEST BAŞARILI AMACA ULAŞILDI!`);
  console.log('===========================================================');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runHardwareAuthTests();
