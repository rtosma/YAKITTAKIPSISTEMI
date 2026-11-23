import mqtt from 'mqtt';
import { io as socketIoClient, Socket } from 'socket.io-client';
import Redis from 'ioredis';
import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * AI-501 — Pompa Debisi vs. Tank Ultrasonik Düşüş Korelasyonu (Hırsızlık Motoru)
 * uçtan uca testi. Gerçek Docker Compose (backend + Redis + EMQX) üzerinden,
 * test_iot301_mqtt_resilience.ts ile AYNI desen (MQTT publish + Socket.io
 * dinleyici + admin login).
 *
 * Kapsanan Kabul Kriterleri:
 *  - #115: Pompa çalışmıyorken 10 dk'da 5 L'den fazla düşüş → STATIC_THEFT_DETECTED
 *  - #116: Pompa akışı ile tank düşüşü ±%1.5 toleransı aşarsa → METER_CALIBRATION_TAMPER
 *  - Negatif: pompa akışı ile tank düşüşü tolerans içindeyse alarm ÜRETİLMEZ
 *
 * Kayıtlı gerçek cihazlar kullanılır (mqttClient.ts IOT-304'ten sonra
 * hardware_devices'ta olmayan device_id'lerin verisini işlemeden atıyor):
 * ESP32-TANK-01 (tank) + ESP32-PUMP-01 (pompa), ikisi de comp-camsa.
 */

const API_URL = 'http://localhost:5000/api/v1';
const MQTT_URL = process.env.MQTT_URL_TEST || 'mqtt://localhost:1883';
const MQTT_USERNAME = process.env.MQTT_USERNAME || '';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || '';

const TENANT_ID = 'comp-camsa';
const SITE_ID = 'site-gebze';
const TANK_DEVICE = 'ESP32-TANK-01';
const PUMP_DEVICE = 'ESP32-PUMP-01';

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10)
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function login(username: string): Promise<string> {
  await resetLoginRateLimit(); // TEST_PLAN §0.3 — paket içi 429 kırılmalarını önler
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: '123456' })
  });
  const data = await res.json();
  if (!data.accessToken) throw new Error(`Ön koşul: ${username} ile giriş başarısız`);
  return data.accessToken;
}

/** AI-501 motorunun bu şantiye için Redis'te tuttuğu tüm durumu temizler. */
async function resetTheftState(): Promise<void> {
  await redis.del(
    `theft:tank:${TENANT_ID}:${SITE_ID}:${TANK_DEVICE}`,
    `theft:pumpflow:${TENANT_ID}:${SITE_ID}`,
    `theft:cooldown:${TENANT_ID}:${SITE_ID}:STATIC_THEFT_DETECTED`,
    `theft:cooldown:${TENANT_ID}:${SITE_ID}:METER_CALIBRATION_TAMPER`,
    `theft:alerts:${TENANT_ID}`
  );
}

function tankTopic(): string {
  return `telemetry/v1/${TENANT_ID}/${SITE_ID}/tank/${TANK_DEVICE}/data`;
}
function pumpTopic(): string {
  return `telemetry/v1/${TENANT_ID}/${SITE_ID}/pump/${PUMP_DEVICE}/data`;
}

async function run() {
  console.log('===========================================================');
  console.log('🕵️  [AI-501] HIRSIZLIK TESPİT MOTORU (DEBİ ↔ TANK SEVİYE) TESTİ');
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

  const adminToken = await login('admin');

  const publisher = mqtt.connect(MQTT_URL, { username: MQTT_USERNAME, password: MQTT_PASSWORD, protocolVersion: 5 });
  await new Promise<void>((resolve, reject) => {
    publisher.on('connect', () => resolve());
    publisher.on('error', reject);
  });

  const socket: Socket = socketIoClient('http://localhost:5000', {
    path: '/socket.io',
    auth: { token: adminToken },
    transports: ['websocket']
  });
  await new Promise<void>((resolve, reject) => {
    socket.on('connect', () => resolve());
    socket.on('connect_error', reject);
  });

  const alerts: any[] = [];
  socket.on('theft:alert', (payload) => alerts.push(payload));

  function pub(topic: string, body: object): Promise<void> {
    return new Promise((resolve, reject) => {
      publisher.publish(topic, JSON.stringify(body), { qos: 1 }, (err) => (err ? reject(err) : resolve()));
    });
  }
  function lastAlertOfType(type: string): any {
    return [...alerts].reverse().find((a) => a.type === type);
  }

  // --- Test 1: STATIC_THEFT_DETECTED — pompa hiç çalışmadan tank 12 L düşüyor ---
  await resetTheftState();
  alerts.length = 0;
  await pub(tankTopic(), { levelLiters: 10000 });
  await sleep(600);
  await pub(tankTopic(), { levelLiters: 9988 }); // 12 L düşüş, eşik 5 L
  await sleep(1500);

  const staticAlert = lastAlertOfType('STATIC_THEFT_DETECTED');
  check(
    'Test 1: Pompa kapalıyken >5 L düşüş → STATIC_THEFT_DETECTED yayınlandı',
    !!staticAlert && staticAlert.siteId === SITE_ID && staticAlert.levelDropLiters >= 11.9,
    `alınan: ${JSON.stringify(staticAlert)}`
  );

  // --- Test 2: METER_CALIBRATION_TAMPER — pompa 100 L verdi ama tank 150 L düştü ---
  await resetTheftState();
  alerts.length = 0;
  await pub(tankTopic(), { levelLiters: 8000 });
  await sleep(400);
  await pub(pumpTopic(), { litersDispensed: 100, flowRate: 45 });
  await sleep(400);
  await pub(tankTopic(), { levelLiters: 7850 }); // 150 L düşüş vs 100 L pompa → %50 sapma
  await sleep(1500);

  const tamperAlert = lastAlertOfType('METER_CALIBRATION_TAMPER');
  check(
    'Test 2: Pompa 100 L / tank 150 L düşüş (%50 sapma > %1.5) → METER_CALIBRATION_TAMPER',
    !!tamperAlert && tamperAlert.pumpTotalLiters === 100 && tamperAlert.tankLevelDropLiters === 150 && tamperAlert.discrepancyPct >= 49,
    `alınan: ${JSON.stringify(tamperAlert)}`
  );
  check(
    'Test 2b: Bu senaryoda STATIC_THEFT_DETECTED YANLIŞ pozitif üretilmedi (pompa aktifti)',
    !lastAlertOfType('STATIC_THEFT_DETECTED'),
    `static alarm sayısı: ${alerts.filter((a) => a.type === 'STATIC_THEFT_DETECTED').length}`
  );

  // --- Test 3 (negatif): pompa 50 L / tank ~50.4 L düşüş (%0.8 sapma, tolerans içi) → alarm YOK ---
  await resetTheftState();
  alerts.length = 0;
  await pub(tankTopic(), { levelLiters: 6000 });
  await sleep(400);
  await pub(pumpTopic(), { litersDispensed: 50, flowRate: 30 });
  await sleep(400);
  await pub(tankTopic(), { levelLiters: 5949.6 }); // 50.4 L düşüş, sapma ~%0.8 < %1.5
  await sleep(1500);

  check(
    'Test 3: Debi ile tank düşüşü tolerans içinde (%0.8) → hiç hırsızlık alarmı üretilmedi',
    alerts.length === 0,
    `üretilen alarm sayısı: ${alerts.length} — ${JSON.stringify(alerts)}`
  );

  // --- Test 4: Redis son-alarm tamponu (theft:alerts:{tenantId}) yazılıyor ---
  await resetTheftState();
  alerts.length = 0;
  await pub(tankTopic(), { levelLiters: 12000 });
  await sleep(400);
  await pub(tankTopic(), { levelLiters: 11985 }); // 15 L düşüş, pompa yok
  await sleep(1500);

  const buffered = await redis.lrange(`theft:alerts:${TENANT_ID}`, 0, -1);
  const parsed = buffered.map((b) => JSON.parse(b));
  check(
    'Test 4: Alarm, kiracı başına Redis son-alarm tamponuna (theft:alerts) da yazıldı',
    parsed.some((a) => a.type === 'STATIC_THEFT_DETECTED' && a.siteId === SITE_ID),
    `tampon içeriği: ${JSON.stringify(parsed)}`
  );

  // --- Test 5: Cooldown — aynı senaryo hemen tekrarlanınca ikinci alarm çıkmaz ---
  alerts.length = 0;
  await pub(tankTopic(), { levelLiters: 11970 }); // 15 L daha düşüş, hâlâ pompa yok
  await sleep(1500);
  check(
    'Test 5: Cooldown penceresinde aynı şantiye/tür için ikinci STATIC alarm bastırıldı',
    alerts.filter((a) => a.type === 'STATIC_THEFT_DETECTED').length === 0,
    `cooldown sonrası yeni static alarm: ${alerts.filter((a) => a.type === 'STATIC_THEFT_DETECTED').length}`
  );

  await resetTheftState();
  publisher.end();
  socket.disconnect();
  redis.disconnect();

  console.log('===========================================================');
  console.log(`📊 TEST SONUÇLARI: ${passed} / ${total} TEST BAŞARILI`);
  console.log('===========================================================');
  if (passed !== total) process.exit(1);
}

run().catch((err) => {
  console.error('❌ Test çalıştırma hatası:', err);
  process.exit(1);
});
