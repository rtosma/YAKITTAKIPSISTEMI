import mqtt from 'mqtt';
import { io as socketIoClient, Socket } from 'socket.io-client';
import Redis from 'ioredis';
import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * IOT-301.3 — MQTT telemetri payload doğrulaması/ayrıştırması artık ayrı bir
 * worker thread'de çalışıyor (bkz. backend/src/iot/payloadValidationPool.ts).
 * Bu test, davranışın (worker'a taşınmadan ÖNCEKİYLE birebir aynı) DIŞARIDAN
 * gözlemlenebilir sonucunu doğrular:
 *  - geçerli JSON/LoRaWAN payload'ları hâlâ işleniyor (ONLINE + Socket.io yayını),
 *  - geçersiz şekilli JSON (nesne değil), bozuk JSON ve bozuk LoRaWAN paketleri
 *    İZOLE ediliyor (cihaz durumu değişmiyor, telemetryData olayı üretilmiyor),
 *  - bir cihazdan gelen kötü paket, AYNI ANDA başka bir cihazın geçerli
 *    paketini etkilemiyor (worker havuzu paylaşılıyor ama izolasyon bozulmuyor).
 */

const API_URL = 'http://localhost:5000/api/v1';
const MQTT_URL = process.env.MQTT_URL_TEST || 'mqtt://localhost:1883';
const MQTT_USERNAME = process.env.MQTT_USERNAME || '';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || '';

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10)
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function login(username: string): Promise<string> {
  await resetLoginRateLimit();
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: '123456' })
  });
  const data = await res.json();
  if (!data.accessToken) throw new Error(`Ön koşul: ${username} ile giriş başarısız`);
  return data.accessToken;
}

/** GENERIC-TANK-V1 (BE) — 15 bayt geçerli bir uplink çerçevesi kurar. */
function buildValidLoRaWANFrame(): Buffer {
  const buf = Buffer.alloc(15);
  buf.writeUInt8(1, 0); // protocolVersion
  buf.writeUInt8(1, 1); // messageType = TANK_LEVEL
  buf.writeUInt16BE(1234, 2); // distanceMm
  buf.writeInt16BE(2150, 4); // temperatureCentiC (21.50°C)
  buf.writeFloatLE(3.65, 6); // batteryVoltage
  buf.writeUInt8(0, 10); // statusFlags
  buf.writeUInt32BE(42, 11); // uplinkCounter
  return buf;
}

async function run() {
  console.log('===========================================================');
  console.log('🧵 [IOT-301.3] WORKER THREAD PAYLOAD DOĞRULAMA TESTİ');
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

  const telemetryEvents: any[] = [];
  socket.on('telemetry:data', (payload) => telemetryEvents.push(payload));

  // ESP32-TANK-01 zaten hardware_devices'ta comp-camsa'ya kayıtlı — IOT-304
  // kaydı deviceType'a bakmaz (topic'ten gelir), bu yüzden aynı cihaz kimliği
  // 'lorawan' deviceType'ıyla da kullanılabilir.
  const deviceId = 'ESP32-TANK-01';
  const loraTopic = `telemetry/v1/comp-camsa/site-gebze/lorawan/${deviceId}/data`;
  const jsonTopic = `telemetry/v1/comp-camsa/site-gebze/tank/${deviceId}/data`;

  // --- Test 1: geçerli LoRaWAN binary payload → worker'da decode edilip işleniyor ---
  await redis.del(`device:${deviceId}:state`);
  telemetryEvents.length = 0;
  publisher.publish(loraTopic, buildValidLoRaWANFrame().toString('hex'), { qos: 1 });
  await sleep(1200);
  const stateAfterValidLoRa = await redis.get(`device:${deviceId}:state`);
  const validLoraEvent = telemetryEvents.find((e) => e.deviceId === deviceId && e.data?.distanceMm === 1234);
  check(
    "Test 1: Geçerli LoRaWAN payload'ı worker thread'de decode edilip ONLINE + telemetryData üretiyor",
    stateAfterValidLoRa === 'ONLINE' && !!validLoraEvent,
    `state=${stateAfterValidLoRa}, decoded=${JSON.stringify(validLoraEvent?.data)}`
  );

  // --- Test 2: bozuk (eksik bayt) LoRaWAN payload → izole ediliyor ---
  await redis.del(`device:${deviceId}:state`);
  telemetryEvents.length = 0;
  publisher.publish(loraTopic, Buffer.alloc(5).toString('hex'), { qos: 1 }); // 5 bayt, 15 bekleniyor
  await sleep(1200);
  const stateAfterCorruptLoRa = await redis.get(`device:${deviceId}:state`);
  check(
    'Test 2: Bozuk (eksik baytlı) LoRaWAN payload izole ediliyor — cihaz durumu değişmiyor, telemetryData üretilmiyor',
    stateAfterCorruptLoRa === null && telemetryEvents.length === 0,
    `state=${stateAfterCorruptLoRa}, telemetryEvents=${telemetryEvents.length}`
  );

  // --- Test 3: standart telemetri — geçerli JSON NESNESİ değil (dizi) → INVALID_SHAPE ile izole ---
  await redis.del(`device:${deviceId}:state`);
  telemetryEvents.length = 0;
  publisher.publish(jsonTopic, JSON.stringify([1, 2, 3]), { qos: 1 });
  await sleep(1200);
  const stateAfterArrayPayload = await redis.get(`device:${deviceId}:state`);
  check(
    "Test 3: Geçerli JSON ama NESNE olmayan payload (dizi) INVALID_SHAPE ile izole ediliyor",
    stateAfterArrayPayload === null && telemetryEvents.length === 0,
    `state=${stateAfterArrayPayload}, telemetryEvents=${telemetryEvents.length}`
  );

  // --- Test 4: tamamen bozuk JSON (parse hatası) → izole ---
  await redis.del(`device:${deviceId}:state`);
  telemetryEvents.length = 0;
  publisher.publish(jsonTopic, '{bozuk-json-degil::', { qos: 1 });
  await sleep(1200);
  const stateAfterBadJson = await redis.get(`device:${deviceId}:state`);
  check(
    'Test 4: Ayrıştırılamayan (bozuk) JSON payload izole ediliyor',
    stateAfterBadJson === null && telemetryEvents.length === 0,
    `state=${stateAfterBadJson}, telemetryEvents=${telemetryEvents.length}`
  );

  // --- Test 5: kötü paketten HEMEN sonra AYNI cihazın geçerli paketi hâlâ işleniyor
  // (worker havuzu paylaşılıyor — bir isteğin reddi havuzu bozmuyor/tıkamıyor) ---
  await redis.del(`device:${deviceId}:state`);
  telemetryEvents.length = 0;
  publisher.publish(jsonTopic, '{bozuk-json-degil::', { qos: 1 });
  publisher.publish(jsonTopic, JSON.stringify({ levelLiters: 555 }), { qos: 1 });
  await sleep(1200);
  const stateAfterRecovery = await redis.get(`device:${deviceId}:state`);
  const recoveryEvent = telemetryEvents.find((e) => e.deviceId === deviceId && e.data?.levelLiters === 555);
  check(
    'Test 5: Bozuk paketten sonra AYNI cihazın geçerli paketi hâlâ işleniyor (havuz tıkanmıyor)',
    stateAfterRecovery === 'ONLINE' && !!recoveryEvent,
    `state=${stateAfterRecovery}, recoveryEvent=${JSON.stringify(recoveryEvent?.data)}`
  );

  publisher.end();
  socket.disconnect();
  await redis.del(`device:${deviceId}:state`);
  redis.disconnect();

  console.log('===========================================================');
  console.log(`📊 TEST SONUÇLARI: ${passed} / ${total} TEST BAŞARILI`);
  console.log('===========================================================');
  if (passed !== total) process.exit(1);
}

run();
