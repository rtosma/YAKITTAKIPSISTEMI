import Redis from 'ioredis';
import { encodeTankUplinkHex } from '../src/iot/lorawanDecoder';

/**
 * IOT-302.1 — POST /api/v1/lorawan/uplink (ChirpStack/TTN webhook).
 *
 * Decoder + CorruptedPayloadException izolasyonu IOT-302'de (test_iot302_
 * lorawan_decoder.ts, 24/24) birim test edildi; burada webhook KATMANI test
 * edilir: token doğrulaması, zarf normalizasyonu (düz + ChirpStack v4),
 * model bazlı decoder seçimi (endianness), bozuk paketin hattı durdurmadan
 * izole edilmesi, telemetri hattına aktarım (presence ONLINE).
 */

const API_URL = 'http://localhost:5000/api/v1';
const DEVICE_ID = 'ESP32-TANK-01'; // seed'de kayıtlı bir tank cihazı
const TOKEN = process.env.LORAWAN_WEBHOOK_TOKEN || '';

const redis = new Redis({ host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379', 10) });

async function resetIpLoginRateLimit(): Promise<void> {
  const keys = await redis.keys('rl:auth-login:*');
  if (keys.length > 0) await redis.del(...keys);
}

async function login(username: string): Promise<string> {
  await resetIpLoginRateLimit();
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: '123456' })
  });
  const body = await res.json();
  if (!body.accessToken) throw new Error(`Ön koşul: ${username} giriş başarısız: ${JSON.stringify(body)}`);
  return body.accessToken;
}

async function uplink(body: unknown, token: string | null = TOKEN): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_URL}/lorawan/uplink`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function deviceStatus(adminToken: string, deviceCode: string): Promise<string | undefined> {
  const res = await fetch(`${API_URL}/devices`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const body = await res.json();
  return (body.data || []).find((d: any) => d.deviceCode === deviceCode)?.status;
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [IOT-302.1] LORAWAN UPLINK WEBHOOK TESTİ');
  console.log('===========================================================\n');

  if (!TOKEN) {
    console.error('💥 LORAWAN_WEBHOOK_TOKEN test ortamında tanımlı değil — test çalıştırılamıyor.');
    process.exit(1);
  }

  let passed = 0;
  let total = 0;
  function check(name: string, cond: boolean, detail: string) {
    total++;
    if (cond) { console.log(`✅ [PASS] ${name}\n   ${detail}\n`); passed++; }
    else { console.log(`❌ [FAIL] ${name}\n   ${detail}\n`); }
  }

  const adminToken = await login('admin');

  // Bilinen bir uplink — BE (GENERIC-TANK-V1) düzeni.
  const hexBE = encodeTankUplinkHex({ distanceMm: 1234, temperatureC: 21.5, batteryVoltage: 3.65, uplinkCounter: 42 });

  // --- Test 1: token yok → 401 ---
  const r1 = await uplink({ deviceId: DEVICE_ID, payload: hexBE }, null);
  check('Test 1: token olmadan 401', r1.status === 401 && r1.body.error === 'UNAUTHORIZED', `status=${r1.status}, err=${r1.body.error}`);

  // --- Test 2: yanlış token → 401 ---
  const r2 = await uplink({ deviceId: DEVICE_ID, payload: hexBE }, 'kesinlikle-yanlis-bir-token-1234567890');
  check('Test 2: yanlış token 401', r2.status === 401, `status=${r2.status}`);

  // --- Test 3: geçerli token + geçerli hex → 202 accepted, doğru fiziksel değerler ---
  const r3 = await uplink({ deviceId: DEVICE_ID, payload: hexBE, rssi: -71, snr: 9.25 });
  const d3 = r3.body.decoded;
  check(
    'Test 3: geçerli uplink 202 accepted + doğru çözüm (mesafe/sıcaklık/batarya/rssi)',
    r3.status === 202 && r3.body.accepted === true &&
      d3?.distanceMm === 1234 && d3?.temperatureC === 21.5 &&
      Math.abs(d3?.batteryVoltage - 3.65) < 0.001 && d3?.rssi === -71 && d3?.snr === 9.25 &&
      r3.body.resolvedModel === 'GENERIC-TANK-V1',
    `status=${r3.status}, decoded=${JSON.stringify(d3)}`
  );

  // --- Test 4: uplink sonrası cihaz presence ONLINE ---
  const st4 = await deviceStatus(adminToken, DEVICE_ID);
  check('Test 4: uplink telemetri hattına aktarıldı → cihaz ONLINE', st4 === 'ONLINE', `status=${st4}`);

  // --- Test 5: base64 payload da çözülüyor ---
  const b64 = Buffer.from(hexBE, 'hex').toString('base64');
  const r5 = await uplink({ deviceId: DEVICE_ID, payload: b64, payloadEncoding: 'base64' });
  check(
    'Test 5: base64 payload çözülüyor (hex ile aynı sonuç)',
    r5.status === 202 && r5.body.accepted === true && r5.body.decoded?.distanceMm === 1234,
    `accepted=${r5.body.accepted}, distanceMm=${r5.body.decoded?.distanceMm}`
  );

  // --- Test 6: bozuk paket İZOLE ediliyor, hat DURMUYOR ---
  const truncated = hexBE.slice(0, 20); // 10 bayt — 15 bekleniyor
  const r6a = await uplink({ deviceId: DEVICE_ID, payload: truncated });
  const r6b = await uplink({ deviceId: DEVICE_ID, payload: hexBE }); // hemen ardından geçerli
  check(
    'Test 6: bozuk paket 202 accepted:false CORRUPTED_PAYLOAD — ve sonraki geçerli paket hâlâ işleniyor',
    r6a.status === 202 && r6a.body.accepted === false && r6a.body.reason === 'CORRUPTED_PAYLOAD' &&
      r6b.status === 202 && r6b.body.accepted === true,
    `bozuk: accepted=${r6a.body.accepted} reason=${r6a.body.reason} | sonraki: accepted=${r6b.body.accepted}`
  );

  // --- Test 7: kayıtsız cihaz → 202 accepted:false DEVICE_NOT_REGISTERED ---
  const r7 = await uplink({ deviceId: 'HAYALET-CIHAZ-999', payload: hexBE });
  check(
    'Test 7: kayıtsız cihaz reddediliyor (accepted:false), 5xx DEĞİL',
    r7.status === 202 && r7.body.accepted === false && r7.body.reason === 'DEVICE_NOT_REGISTERED',
    `status=${r7.status}, reason=${r7.body.reason}`
  );

  // --- Test 8: Zod — deviceId eksik → 400 ---
  const r8 = await uplink({ payload: hexBE });
  check('Test 8: deviceId eksik → 400 VALIDATION_ERROR', r8.status === 400 && r8.body.error === 'VALIDATION_ERROR', `status=${r8.status}, err=${r8.body.error}`);

  // --- Test 9: model bazlı decoder — ACME-ULTRASONIC-LE (little-endian) ---
  const hexLE = encodeTankUplinkHex({ distanceMm: 8000, temperatureC: -5.25, batteryVoltage: 3.7, uplinkCounter: 100, byteOrder: 'LE' });
  const r9le = await uplink({ deviceId: DEVICE_ID, payload: hexLE, model: 'ACME-ULTRASONIC-LE' });
  const r9be = await uplink({ deviceId: DEVICE_ID, payload: hexLE }); // AYNI baytlar, varsayılan BE decoder
  check(
    'Test 9: LE modeli doğru çözüyor; aynı baytlar varsayılan (BE) decoder\'da FARKLI/bozuk çıkıyor',
    r9le.status === 202 && r9le.body.accepted === true &&
      r9le.body.decoded?.distanceMm === 8000 && r9le.body.decoded?.temperatureC === -5.25 &&
      r9le.body.resolvedModel === 'ACME-ULTRASONIC-LE' &&
      // BE yorumu ya farklı bir sayı verir ya da mantıksızlıktan izole edilir — her iki durumda da 8000 DEĞİL
      !(r9be.body.accepted === true && r9be.body.decoded?.distanceMm === 8000),
    `LE: ${JSON.stringify(r9le.body.decoded)} | BE aynı baytlar: accepted=${r9be.body.accepted} dist=${r9be.body.decoded?.distanceMm}`
  );

  // --- Test 10: rssi/snr yoksa decoded'da 0 DEĞİL, hiç yok (undefined) ---
  const r10 = await uplink({ deviceId: DEVICE_ID, payload: hexBE });
  check(
    'Test 10: rssi/snr gelmezse decoded\'da alan HİÇ yok (0 değil — IOT-308 sağlık skoru için kritik)',
    r10.body.accepted === true && r10.body.decoded?.rssi === undefined && r10.body.decoded?.snr === undefined,
    `rssi=${JSON.stringify(r10.body.decoded?.rssi)}, snr=${JSON.stringify(r10.body.decoded?.snr)}`
  );

  // --- Test 11: ChirpStack v4 zarfı (nested deviceInfo + data base64 + rxInfo) normalize ediliyor ---
  const chirpStackBody = {
    deviceInfo: { deviceName: DEVICE_ID, devEui: '0011223344556677', deviceProfileName: 'generic-tank' },
    fPort: 2,
    fCnt: 77,
    data: Buffer.from(hexBE, 'hex').toString('base64'),
    rxInfo: [{ gatewayId: 'gw-eu-01', rssi: -95, snr: 7.5 }],
    time: new Date().toISOString()
  };
  const r11 = await uplink(chirpStackBody);
  check(
    'Test 11: ChirpStack v4 zarfı normalize edilip çözülüyor (deviceName→deviceId, data base64, rxInfo→rssi/snr)',
    r11.status === 202 && r11.body.accepted === true &&
      r11.body.decoded?.distanceMm === 1234 && r11.body.decoded?.rssi === -95 && r11.body.decoded?.snr === 7.5,
    `accepted=${r11.body.accepted}, decoded=${JSON.stringify(r11.body.decoded)}`
  );

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');

  await redis.quit();
  if (passed !== total) process.exit(1);
}

run().catch((err) => {
  console.error('💥 Test çalıştırma hatası:', err);
  process.exit(1);
});
