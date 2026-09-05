import mqtt from 'mqtt';
import { io as socketIoClient, Socket } from 'socket.io-client';
import Redis from 'ioredis';

/**
 * IOT-301.1/IOT-301.2 — MQTT bağlantı sağlamlığı + cihaz presence testi.
 *
 * Kapsanmayan (manuel doğrulandı, otomatik CI testine dahil edilmedi):
 * exponential backoff. EMQX container'ını gerçekten durdurup/başlatıp
 * büyüyen gecikmeleri (1sn→2sn→4sn...) log'da ölçmek gerekiyor — bu CI'da
 * güvenilir şekilde otomatikleştirmek (Docker container yaşam döngüsü
 * kontrolü test sürecinin dışında) ayrı bir altyapı gerektiriyor. Manuel
 * doğrulama: `docker stop yakittakip_emqx`, log'da artan gecikmelerin
 * göründüğü, `docker start yakittakip_emqx` sonrası bağlantının ve
 * abonelik/telemetri akışının kendiliğinden toparlandığı gözlemlendi.
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

async function call(method: string, path: string, token?: string): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${path}`, { method, headers });
  return res.json().catch(() => ({}));
}

async function login(username: string): Promise<string> {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: '123456' })
  });
  const data = await res.json();
  if (!data.accessToken) throw new Error(`Ön koşul: ${username} ile giriş başarısız`);
  return data.accessToken;
}

async function run() {
  console.log('===========================================================');
  console.log('📡 [IOT-301] MQTT BAĞLANTI SAĞLAMLIĞI + CİHAZ PRESENCE TESTİ');
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

  // --- Test 1 + 2: MQTT data mesajı → ONLINE + canlı Socket.io yayını ---
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

  let receivedStatusEvent: any = null;
  socket.on('device:status', (payload) => {
    if (payload.deviceId === 'ESP32-PUMP-01') receivedStatusEvent = payload;
  });

  publisher.publish(
    'telemetry/v1/comp-camsa/site-gebze/pump/ESP32-PUMP-01/data',
    JSON.stringify({ pumpId: 'PUMP-01', litersDispensed: 12.3, flowRate: 8.1 }),
    { qos: 1 }
  );

  await sleep(1500);

  const devicesAfterData = await call('GET', '/devices', adminToken);
  const pumpStatus = devicesAfterData.data?.find((d: any) => d.deviceCode === 'ESP32-PUMP-01')?.status;
  check('Test 1: MQTT data mesajı sonrası GET /devices ESP32-PUMP-01 → ONLINE', pumpStatus === 'ONLINE', `status=${pumpStatus}`);
  check(
    "Test 2: Gerçek ONLINE geçişi Socket.io'dan canlı yayınlandı (device:status)",
    receivedStatusEvent?.status === 'ONLINE',
    `alınan olay: ${JSON.stringify(receivedStatusEvent)}`
  );

  // --- Test 3: TTL süresi doluyor (10sn) — 11sn boyunca hiç mesaj
  // gönderilmeyip GET /devices'ın kendiliğinden OFFLINE'a dönmesi bekleniyor. ---
  console.log('   ⏳ TTL süresinin dolması bekleniyor (~11sn, IOT-301.2 AC: "10 saniye içinde OFFLINE")...\n');
  await sleep(11_000);
  const devicesAfterTtl = await call('GET', '/devices', adminToken);
  const pumpStatusAfterTtl = devicesAfterTtl.data?.find((d: any) => d.deviceCode === 'ESP32-PUMP-01')?.status;
  check(
    "Test 3: 11sn veri gelmeyince presence TTL'i düşüp durum OFFLINE'a dönüyor",
    pumpStatusAfterTtl === 'OFFLINE',
    `status=${pumpStatusAfterTtl}`
  );

  // --- Test 4: Paylaşımlı abonelik ($share) — aynı gruba rakip bir
  // "ikinci backend replikası" abone olur; TEK bir mesaj yayınlanır ve
  // YALNIZCA birinin (gerçek backend YA DA rakip istemci, ikisi BİRDEN
  // değil) aldığı doğrulanır. Kayıtlı GERÇEK bir cihaz kullanılıyor
  // (ESP32-TANK-01) — IOT-304'ten sonra mqttClient.ts artık hardware_devices
  // tablosunda kayıtlı OLMAYAN device_id'lerin verisini işlemeden atıyor,
  // uydurma bir "TEST-SHARE-*" kimliği artık backend tarafında hiç
  // işlenmeyeceğinden backendProcessed'i her zaman false yapıp testi
  // anlamsız kılardı. ---
  const testDeviceId = 'ESP32-TANK-01';
  let competitorReceivedCount = 0;
  const competitor = mqtt.connect(MQTT_URL, { username: MQTT_USERNAME, password: MQTT_PASSWORD, protocolVersion: 5 });
  await new Promise<void>((resolve, reject) => {
    competitor.on('connect', () => resolve());
    competitor.on('error', reject);
  });
  await new Promise<void>((resolve, reject) => {
    competitor.subscribe('$share/yakittakip-backend/telemetry/v1/+/+/+/+/data', { qos: 1 }, (err) => (err ? reject(err) : resolve()));
  });
  competitor.on('message', (topic) => {
    if (topic.includes(testDeviceId)) competitorReceivedCount++;
  });

  await redis.del(`device:${testDeviceId}:state`); // temiz başlangıç
  publisher.publish(
    `telemetry/v1/comp-camsa/site-gebze/pump/${testDeviceId}/data`,
    JSON.stringify({ pumpId: 'PUMP-TEST', litersDispensed: 1, flowRate: 1 }),
    { qos: 1 }
  );
  await sleep(1500);

  const backendProcessed = (await redis.get(`device:${testDeviceId}:state`)) === 'ONLINE';
  const totalDeliveries = competitorReceivedCount + (backendProcessed ? 1 : 0);
  check(
    "Test 4: Paylaşımlı abonelik ($share) — mesaj TAM OLARAK bir alıcıya gider (gerçek backend XOR rakip), ikisine BİRDEN değil",
    totalDeliveries === 1,
    `backend işledi=${backendProcessed}, rakip aldı=${competitorReceivedCount} kez (toplam teslim=${totalDeliveries})`
  );

  publisher.end();
  competitor.end();
  socket.disconnect();
  await redis.del(`device:${testDeviceId}:state`);
  redis.disconnect();

  console.log('===========================================================');
  console.log(`📊 TEST SONUÇLARI: ${passed} / ${total} TEST BAŞARILI`);
  console.log('===========================================================');
  if (passed !== total) process.exit(1);
}

run();
