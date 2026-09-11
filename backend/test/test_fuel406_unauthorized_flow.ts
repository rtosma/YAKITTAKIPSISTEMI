import mqtt from 'mqtt';
import { io as socketIoClient, Socket } from 'socket.io-client';
import Redis from 'ioredis';

/**
 * FUEL-406 — Kartsız/Yetkisiz Akış Alarmı ve Acil Kesme uçtan uca testi.
 * Gerçek Docker Compose (backend + Redis + EMQX) üzerinden,
 * test_ai501_theft_detection.ts ile AYNI desen (MQTT publish + Socket.io
 * dinleyici + admin login), artı komut topic'ini dinleyen ikinci bir MQTT
 * istemcisi (FORCE_CUTOFF yayınını doğrulamak için).
 *
 * Kapsanan davranış:
 *  - Aktif RFID oturumu (dispense:session:{deviceId}, AUTHORIZED/PUMPING)
 *    OLMADAN pompa akış bildirirse → CRITICAL alarm + command/v1/{deviceId}
 *    üzerinden FORCE_CUTOFF yayınlanır.
 *  - Aktif oturum VARKEN aynı akış → alarm/kesme YOK.
 *  - Cooldown: aynı cihaz için hemen tekrar eden yetkisiz akış ikinci bir
 *    alarm/kesme üretmez.
 *
 * Kayıtlı gerçek cihaz kullanılır: ESP32-PUMP-01 (pompa), comp-camsa.
 */

const API_URL = 'http://localhost:3000/api/v1';
const MQTT_URL = process.env.MQTT_URL_TEST || 'mqtt://localhost:1883';
const MQTT_USERNAME = process.env.MQTT_USERNAME || '';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || '';

const TENANT_ID = 'comp-camsa';
const SITE_ID = 'site-gebze';
const PUMP_DEVICE = 'ESP32-PUMP-01';

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10)
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function resetState(): Promise<void> {
  await redis.del(`dispense:session:${PUMP_DEVICE}`, `unauthorized-flow:cooldown:${PUMP_DEVICE}`);
}

function pumpTopic(): string {
  return `telemetry/v1/${TENANT_ID}/${SITE_ID}/pump/${PUMP_DEVICE}/data`;
}
function commandTopic(): string {
  return `command/v1/${PUMP_DEVICE}`;
}

async function run() {
  console.log('===========================================================');
  console.log('🚫 [FUEL-406] KARTSIZ/YETKİSİZ AKIŞ ALARMI VE ACİL KESME TESTİ');
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

  const commandSub = mqtt.connect(MQTT_URL, { username: MQTT_USERNAME, password: MQTT_PASSWORD, protocolVersion: 5 });
  const commands: any[] = [];
  await new Promise<void>((resolve, reject) => {
    commandSub.on('connect', () => {
      commandSub.subscribe(commandTopic(), (err) => (err ? reject(err) : resolve()));
    });
    commandSub.on('error', reject);
  });
  commandSub.on('message', (_topic, payload) => {
    commands.push(JSON.parse(payload.toString()));
  });

  const socket: Socket = socketIoClient('http://localhost:3000', {
    path: '/socket.io',
    auth: { token: adminToken },
    transports: ['websocket']
  });
  await new Promise<void>((resolve, reject) => {
    socket.on('connect', () => resolve());
    socket.on('connect_error', reject);
  });

  const flowAlerts: any[] = [];
  socket.on('flow:unauthorized', (payload) => flowAlerts.push(payload));

  function pub(topic: string, body: object): Promise<void> {
    return new Promise((resolve, reject) => {
      publisher.publish(topic, JSON.stringify(body), { qos: 1 }, (err) => (err ? reject(err) : resolve()));
    });
  }

  // --- Test 1: aktif oturum YOK + pompa akış bildiriyor → alarm + FORCE_CUTOFF ---
  await resetState();
  flowAlerts.length = 0;
  commands.length = 0;
  await pub(pumpTopic(), { litersDispensed: 5, flowRate: 12 });
  await sleep(1500);

  check(
    'Test 1: Aktif RFID oturumu yokken akış → flow:unauthorized yayınlandı',
    flowAlerts.length === 1 && flowAlerts[0].deviceId === PUMP_DEVICE,
    `alınan: ${JSON.stringify(flowAlerts)}`
  );
  const cutoff = commands.find((c) => c.command === 'FORCE_CUTOFF');
  check(
    'Test 1b: command/v1/ESP32-PUMP-01 üzerinden FORCE_CUTOFF yayınlandı',
    !!cutoff && cutoff.reason === 'UNAUTHORIZED_FLOW',
    `alınan komutlar: ${JSON.stringify(commands)}`
  );

  // --- Test 2 (negatif): aktif oturum VAR + aynı akış → alarm/kesme YOK ---
  await resetState();
  flowAlerts.length = 0;
  commands.length = 0;
  await redis.set(
    `dispense:session:${PUMP_DEVICE}`,
    JSON.stringify({ state: 'PUMPING', deviceId: PUMP_DEVICE, tenantId: TENANT_ID }),
    'EX',
    300
  );
  await pub(pumpTopic(), { litersDispensed: 5, flowRate: 12 });
  await sleep(1500);

  check(
    'Test 2: Aktif RFID oturumu (PUMPING) varken aynı akış → hiç alarm/kesme üretilmedi',
    flowAlerts.length === 0 && commands.length === 0,
    `flowAlerts: ${flowAlerts.length}, commands: ${commands.length}`
  );

  // --- Test 3: Cooldown — yetkisiz akış hemen tekrarlanınca ikinci alarm/kesme çıkmaz ---
  await resetState();
  flowAlerts.length = 0;
  commands.length = 0;
  await pub(pumpTopic(), { litersDispensed: 3, flowRate: 10 });
  await sleep(1500);
  flowAlerts.length = 0;
  commands.length = 0;
  await pub(pumpTopic(), { litersDispensed: 3, flowRate: 10 });
  await sleep(1500);

  check(
    'Test 3: Cooldown penceresinde ikinci yetkisiz akış paketi yeni alarm/kesme üretmedi',
    flowAlerts.length === 0 && commands.length === 0,
    `flowAlerts: ${flowAlerts.length}, commands: ${commands.length}`
  );

  await resetState();
  publisher.end();
  commandSub.end();
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
