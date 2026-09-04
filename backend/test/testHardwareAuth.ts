import crypto from 'crypto';

const API_URL = 'http://localhost:5000/api/v1/telemetry/hardware-data';
const DEVICE_ID = 'ESP32-PUMP-01';
// OPS-1105: sunucunun kendisi de artık bu sırrı kaynak kodundan değil
// HW_SECRET_ESP32_PUMP_01'den okuyor (bkz. hardwareAuthMiddleware.ts) —
// imzaların eşleşmesi için test de AYNI ortam değişkenini okumalı.
const DEVICE_SECRET = process.env.HW_SECRET_ESP32_PUMP_01 || 'secret_gebze_pump_8849';

function generateNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

// AUTH-202.2: nonce artık imzalanan payload'un bir parçası (bkz.
// hardwareAuthMiddleware.ts) — nonce'u imzasız değiştirmek imzayı bozar.
function generateHmacSignature(timestamp: string, nonce: string, rawBody: string, secret: string): string {
  const payloadToSign = `${timestamp}.${nonce}.${rawBody}`;
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
    nonce: string | null,
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
    if (nonce) headers['X-Nonce'] = nonce;
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

  const payload = { pumpId: 'PUMP-01', litersDispensed: 45.2, flowRate: 12.8, vehicleTag: 'TAG-882910' };
  const rawBody = JSON.stringify(payload);

  // TEST 1: Geçerli HMAC-SHA256 İmzası (Doğru ESP32 İmzası)
  const nowTs = Date.now().toString();
  const nonce1 = generateNonce();
  const validSig = generateHmacSignature(nowTs, nonce1, rawBody, DEVICE_SECRET);

  await testCase(
    'Test 1: Geçerli ESP32 HMAC-SHA256 İmzalı Telemetri İsteği',
    payload, nowTs, nonce1, validSig, DEVICE_ID,
    200, null
  );

  // TEST 2: Aynı Nonce'un İkinci Kez Kullanımı (AUTH-202.2 AC: "Aynı nonce
  // ikinci kez kabul edilmemelidir") — Test 1'deki paketin BİREBİR aynısı
  // (geçerli imza dahil) tekrar gönderiliyor; bu klasik bir replay senaryosu.
  await testCase(
    'Test 2: Aynı Nonce İkinci Kez Reddi (Replay Attack)',
    payload, nowTs, nonce1, validSig, DEVICE_ID,
    401, 'NONCE_REUSED'
  );

  // TEST 3: Replay Attack Saldırısı (45 Saniye Eski Zaman Damgası → Clock Drift)
  const oldTs = (Date.now() - 45000).toString(); // 45 seconds ago
  const nonce2 = generateNonce();
  const oldSig = generateHmacSignature(oldTs, nonce2, rawBody, DEVICE_SECRET);

  await testCase(
    'Test 3: Zaman Damgası Penceresi Dışı Reddi (Clock Drift / Replay)',
    payload, oldTs, nonce2, oldSig, DEVICE_ID,
    401, 'REPLAY_ATTACK_DETECTED'
  );

  // TEST 4: Test 3'te reddedilen cihaz KARA LİSTEYE ALINMAMALI — aynı cihazdan
  // taze bir timestamp + yeni bir nonce ile gelen sıradaki paket kabul edilmeli.
  const freshTs = Date.now().toString();
  const nonce3 = generateNonce();
  const freshSig = generateHmacSignature(freshTs, nonce3, rawBody, DEVICE_SECRET);

  await testCase(
    'Test 4: Clock Drift Sonrası Cihaz Kara Listeye Alınmamış (Taze İstek Kabul Edilir)',
    payload, freshTs, nonce3, freshSig, DEVICE_ID,
    200, null
  );

  // TEST 5: Veri Manipülasyonu / Yanlış İmza Saldırısı (Data Tampering)
  const nonce4 = generateNonce();
  const fakeSig = 'a1b2c3d4e5f60011223344556677889900aabbccddeeff001122334455667788';

  await testCase(
    'Test 5: Manipüle Edilmiş Veri / Yanlış Kriptografik İmza Reddi',
    payload, Date.now().toString(), nonce4, fakeSig, DEVICE_ID,
    401, 'INVALID_HARDWARE_SIGNATURE'
  );

  // TEST 6: Eksik Donanım Başlıkları (X-Nonce Bulunmama)
  await testCase(
    'Test 6: Eksik X-Nonce Başlığı Reddi',
    payload, Date.now().toString(), null, 'irrelevant', DEVICE_ID,
    401, 'MISSING_HARDWARE_HEADERS'
  );

  console.log('===========================================================');
  console.log(`📊 TEST SONUÇLARI: ${passedTests} / ${totalTests} TEST BAŞARILI AMACA ULAŞILDI!`);
  console.log('===========================================================');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runHardwareAuthTests();
