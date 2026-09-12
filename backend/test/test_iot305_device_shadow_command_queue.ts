import mqtt from 'mqtt';
import { execFileSync } from 'child_process';
import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * IOT-305 — Cihaz Shadow ve Uzaktan Komut Kuyruğu (ack/timeout/retry) uçtan
 * uca testi. Gerçek Docker Compose (backend + Redis + EMQX) üzerinden.
 *
 * commandQueueService.ts şu an tek gerçek çağrı noktasına sahip:
 * unauthorizedFlowDetector.ts (FUEL-406), FORCE_CUTOFF'u artık fire-and-forget
 * yerine bu kuyruktan (ack/timeout/retry ile) gönderiyor. Bu yüzden test,
 * AI-501/FUEL-406 testleriyle AYNI black-box yaklaşımını kullanıyor: gerçek
 * bir "cihaz" MQTT istemcisiyle simüle edilip, yetkisiz pompa akışı
 * tetiklenerek komut kuyruğu dolaylı olarak egzersiz ediliyor. Sonuçlar
 * command/v1/{deviceId} üzerinde gözlemlenen gönderim SAYISI (retry) ve
 * Redis'teki `iot:shadow:{deviceId}` / `iot:cmd:{commandId}` kayıtları
 * üzerinden doğrulanıyor — hiçbir iç fonksiyon doğrudan çağrılmıyor.
 *
 * Redis erişimi `docker compose exec redis redis-cli` ÜZERİNDEN yapılır —
 * bu makinede host'un 6379'unda Docker Compose'un Redis'i İLE İLGİSİZ ayrı
 * bir yerel Redis çalışıyor (docker-compose.yml `redis` servisi kasıtlı
 * olarak host portu yayınlamıyor); host'tan doğrudan bir Redis istemcisiyle
 * bağlanmak sessizce YANLIŞ instance'a bağlanıp state okuma/silmeyi no-op
 * yapardı (bkz. test_fuel406_unauthorized_flow.ts'teki aynı düzeltme).
 *
 * Kayıtlı gerçek cihaz: ESP32-PUMP-01 (pompa), comp-camsa/site-gebze.
 */

const API_URL = 'http://localhost:3000/api/v1';
const MQTT_URL = process.env.MQTT_URL_TEST || 'mqtt://localhost:1883';
const MQTT_USERNAME = process.env.MQTT_USERNAME || '';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || '';

const TENANT_ID = 'comp-camsa';
const SITE_ID = 'site-gebze';
const PUMP_DEVICE = 'ESP32-PUMP-01';

// ESM'de __dirname yok; test her zaman backend/ dizininden çalıştırılır.
const REPO_ROOT = `${process.cwd()}/..`;

function redisCli(...args: string[]): string {
  return execFileSync('docker', ['compose', 'exec', '-T', 'redis', 'redis-cli', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8'
  }).trim();
}
function redisDel(...keys: string[]): void {
  if (keys.length) redisCli('DEL', ...keys);
}
function redisGetJson(key: string): any {
  const out = redisCli('GET', key);
  if (!out || out === '(nil)') return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}
function redisZscore(key: string, member: string): string | null {
  const out = redisCli('ZSCORE', key, member);
  return !out || out === '(nil)' ? null : out;
}

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

async function resetState(): Promise<void> {
  redisDel(`dispense:session:${PUMP_DEVICE}`, `unauthorized-flow:cooldown:${PUMP_DEVICE}`, `iot:shadow:${PUMP_DEVICE}`);
}

function pumpTopic(): string {
  return `telemetry/v1/${TENANT_ID}/${SITE_ID}/pump/${PUMP_DEVICE}/data`;
}
function commandTopic(): string {
  return `command/v1/${PUMP_DEVICE}`;
}
function ackTopic(): string {
  return `command/v1/${PUMP_DEVICE}/ack`;
}

async function run() {
  console.log('===========================================================');
  console.log('📮 [IOT-305] CİHAZ SHADOW VE KOMUT KUYRUĞU (ACK/TIMEOUT/RETRY) TESTİ');
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

  await login('admin'); // ön koşul: yığın ayakta ve auth çalışıyor

  const publisher = mqtt.connect(MQTT_URL, { username: MQTT_USERNAME, password: MQTT_PASSWORD, protocolVersion: 5 });
  await new Promise<void>((resolve, reject) => {
    publisher.on('connect', () => resolve());
    publisher.on('error', reject);
  });

  // "Cihaz" simülasyonu: command/v1/{deviceId}'yi dinler, autoAck açıkken
  // (ve ackDelayMs kadar bekledikten sonra) command/v1/{deviceId}/ack yayınlar.
  const device = mqtt.connect(MQTT_URL, { username: MQTT_USERNAME, password: MQTT_PASSWORD, protocolVersion: 5 });
  await new Promise<void>((resolve, reject) => {
    device.on('connect', () => resolve());
    device.on('error', reject);
  });
  await new Promise<void>((resolve, reject) => {
    device.subscribe(commandTopic(), (err) => (err ? reject(err) : resolve()));
  });

  const received: any[] = [];
  let autoAck = false;
  let ackDelayMs = 0;
  device.on('message', (_topic, payload) => {
    const msg = JSON.parse(payload.toString());
    received.push(msg);
    if (autoAck && msg.commandId) {
      const doAck = () =>
        device.publish(ackTopic(), JSON.stringify({ commandId: msg.commandId, status: 'ACK' }), { qos: 1 });
      if (ackDelayMs > 0) setTimeout(doAck, ackDelayMs);
      else doAck();
    }
  });

  function pub(topic: string, body: object): Promise<void> {
    return new Promise((resolve, reject) => {
      publisher.publish(topic, JSON.stringify(body), { qos: 1 }, (err) => (err ? reject(err) : resolve()));
    });
  }

  // --- Test 1: cihaz hemen ack ediyor → tek gönderim, komut ACKED, shadow güncellendi ---
  await resetState();
  received.length = 0;
  autoAck = true;
  ackDelayMs = 0;
  await pub(pumpTopic(), { litersDispensed: 5, flowRate: 12 });
  await sleep(1200); // handleUnauthorizedFlow'un alarm+ack döngüsünü bitirmesi için

  check(
    'Test 1: Komut cihaza yayınlandı (FORCE_CUTOFF)',
    received.some((m) => m.command === 'FORCE_CUTOFF'),
    `alınan: ${JSON.stringify(received)}`
  );
  const cmd1 = received.find((m) => m.command === 'FORCE_CUTOFF');
  check(
    'Test 1b: Cihaz hemen ack ederse → tek gönderim (retry yok)',
    received.filter((m) => m.commandId === cmd1?.commandId).length === 1,
    `gönderim sayısı: ${received.filter((m) => m.commandId === cmd1?.commandId).length}`
  );
  const cmdRecord1 = redisGetJson(`iot:cmd:${cmd1?.commandId}`);
  check(
    'Test 1c: Redis komut kaydı ACKED, attempts=1',
    cmdRecord1?.status === 'ACKED' && cmdRecord1?.attempts === 1,
    `kayıt: ${JSON.stringify(cmdRecord1)}`
  );
  const shadow1 = redisGetJson(`iot:shadow:${PUMP_DEVICE}`) || {};
  check(
    'Test 1d: Cihaz shadow — desired ilk gönderimde, reported ack ile güncellendi',
    shadow1?.desired?.lastCommand === 'FORCE_CUTOFF' && shadow1?.reported?.lastAckedCommand === 'FORCE_CUTOFF',
    `shadow: ${JSON.stringify(shadow1)}`
  );

  // --- Test 2: cihaz ilk denemeyi kaçırıyor → retry sonra ack ---
  // ackDelayMs (5s), ackTimeoutMs (3s) + sweep granülaritesi (1s) payının
  // AÇIKÇA üzerinde olacak şekilde seçildi — aksi halde ack, sweep'in retry'ı
  // fark etmesiyle yarışa girip (her ikisi de ~3-4sn civarında) testi
  // kararsız (flaky) yapabilir: ack retry'dan hemen önce gelirse komut zaten
  // ACKED'e düşer ve retry hiç tetiklenmez (bu, sistemin KENDİSİ için doğru
  // davranış — gereksiz tekrar yayın önlenir — ama test için belirsizdir).
  await resetState();
  received.length = 0;
  autoAck = true;
  ackDelayMs = 5000;
  await pub(pumpTopic(), { litersDispensed: 4, flowRate: 9 });
  await sleep(7000); // 1. deneme (t=0) → timeout(3s) → sweep retry(~3-4s) → ack(t=5s)

  const cmd2 = received.find((m) => m.command === 'FORCE_CUTOFF');
  check(
    'Test 2: İlk deneme ack edilmeyince yeniden yayınlandı (en az 2 gönderim)',
    !!cmd2 && received.filter((m) => m.commandId === cmd2.commandId).length >= 2,
    `gönderim sayısı: ${received.filter((m) => m.commandId === cmd2?.commandId).length}`
  );
  const cmdRecord2 = redisGetJson(`iot:cmd:${cmd2?.commandId}`);
  check(
    'Test 2b: Sonunda ack alındı → status=ACKED (birden fazla denemeyle)',
    cmdRecord2?.status === 'ACKED' && cmdRecord2?.attempts >= 2,
    `kayıt: ${JSON.stringify(cmdRecord2)}`
  );

  // --- Test 3 (negatif): cihaz HİÇ ack etmiyor → tüm denemeler (3) tükenip FAILED ---
  await resetState();
  received.length = 0;
  autoAck = false;
  await pub(pumpTopic(), { litersDispensed: 6, flowRate: 15 });
  // 3 deneme * 3sn ackTimeout + her denemede ~1sn sweep granülaritesi +
  // son FAILED tespiti için bir sweep tick'i daha — bol pay bırakıldı.
  await sleep(15000);

  const cmd3 = received.find((m) => m.command === 'FORCE_CUTOFF');
  check(
    'Test 3: Cihaz hiç ack etmezse → tam olarak maxAttempts (3) kez denendi',
    !!cmd3 && received.filter((m) => m.commandId === cmd3.commandId).length === 3,
    `gönderim sayısı: ${received.filter((m) => m.commandId === cmd3?.commandId).length}`
  );
  const cmdRecord3 = redisGetJson(`iot:cmd:${cmd3?.commandId}`);
  check(
    'Test 3b: Tüm denemeler tükenince status=FAILED',
    cmdRecord3?.status === 'FAILED' && cmdRecord3?.attempts === 3,
    `kayıt: ${JSON.stringify(cmdRecord3)}`
  );
  const pendingScore = redisZscore('iot:cmd:pending', cmd3?.commandId || '');
  check('Test 3c: FAILED komut, bekleyen (pending) ZSET’ten temizlendi', pendingScore === null, `zscore: ${pendingScore}`);

  await resetState();
  publisher.end();
  device.end();

  console.log('===========================================================');
  console.log(`📊 TEST SONUÇLARI: ${passed} / ${total} TEST BAŞARILI`);
  console.log('===========================================================');
  if (passed !== total) process.exit(1);
}

run().catch((err) => {
  console.error('❌ Test çalıştırma hatası:', err);
  process.exit(1);
});
