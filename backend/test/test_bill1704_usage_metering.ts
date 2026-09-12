import mqtt from 'mqtt';
import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * BILL-1704 — Kullanım Ölçümü (Metering) ve Faturalama Verisi uçtan uca
 * testi. Gerçek Docker Compose (backend + Postgres + Redis + EMQX)
 * üzerinden.
 *
 * Kapsanan davranış:
 *  - active_device_count / device_days doğru hesaplanıyor (BLOKE olmayan
 *    cihaz sayısı × dönemdeki gün sayısı).
 *  - telemetry_packet_count — mqttClient.ts'teki Redis sayacı gerçek bir
 *    MQTT telemetri paketiyle artıyor ve compute-now'a doğru yansıyor.
 *  - Kayıt APPEND-ONLY: aynı dönem için ikinci compute-now çağrısı no-op
 *    (data: null), var olan kaydı DEĞİŞTİRMİYOR.
 *  - GET /usage-metering geçmişte doğru kaydı gösteriyor.
 *
 * Not: tek kullanımlık test firması, mevcut seed firmalarına dokunulmaz.
 */

const API_URL = 'http://localhost:3000/api/v1';
const MQTT_URL = process.env.MQTT_URL_TEST || 'mqtt://localhost:1883';
const MQTT_USERNAME = process.env.MQTT_USERNAME || '';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || '';

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
  if (!data.accessToken) throw new Error(`Ön koşul: ${username} ile giriş başarısız — ${JSON.stringify(data)}`);
  return data.accessToken;
}

async function api(method: string, path: string, token: string, body?: object): Promise<{ status: number; data: any }> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function daysInMonth(periodLabel: string): number {
  const [year, month] = periodLabel.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

async function run() {
  console.log('===========================================================');
  console.log('📊 [BILL-1704] KULLANIM ÖLÇÜMÜ (METERING) VE FATURALAMA VERİSİ TESTİ');
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

  const companyName = `bill1704t${Date.now()}`;
  const createRes = await api('POST', '/companies', adminToken, { name: companyName, package: 'KURUMSAL' });
  const companyId = createRes.data.data?.id;
  const siteId = createRes.data.data?.sites?.[0]?.id;
  const siteName = createRes.data.data?.sites?.[0]?.name;
  check('Ön koşul: Test firması oluşturuldu', createRes.status === 200 && !!companyId && !!siteId, `yanıt: ${JSON.stringify(createRes.data)}`);

  const ownerToken = await login(companyName);

  // --- İki cihaz kaydet (active_device_count/device_days için) ---
  const devicePrefix = `BILL1704-DEV-${Date.now()}`;
  const dev1Res = await api('POST', '/hardware-devices', ownerToken, { deviceId: `${devicePrefix}-1`, name: 'Tank 1', siteName });
  const dev2Res = await api('POST', '/hardware-devices', ownerToken, { deviceId: `${devicePrefix}-2`, name: 'Tank 2', siteName });
  check(
    'Ön koşul: 2 cihaz kaydedildi',
    dev1Res.status === 200 && dev2Res.status === 200,
    `dev1: ${dev1Res.status}, dev2: ${dev2Res.status}`
  );

  // --- Gerçek bir MQTT telemetri paketi yayınla (telemetry_packet_count sayacı için) ---
  const publisher = mqtt.connect(MQTT_URL, { username: MQTT_USERNAME, password: MQTT_PASSWORD, protocolVersion: 5 });
  await new Promise<void>((resolve, reject) => {
    publisher.on('connect', () => resolve());
    publisher.on('error', reject);
  });
  const topic = `telemetry/v1/${companyId}/${siteId}/tank/${devicePrefix}-1/data`;
  await new Promise<void>((resolve, reject) => {
    publisher.publish(topic, JSON.stringify({ levelLiters: 5000 }), { qos: 1 }, (err) => (err ? reject(err) : resolve()));
  });
  await sleep(800);
  publisher.end();

  const currentPeriod = new Date().toISOString().slice(0, 7);

  // --- Test 1: compute-now (cari ay) → doğru cihaz sayısı/gün + telemetri sayacı ---
  const computeRes = await api('POST', '/usage-metering/compute-now', ownerToken, { periodLabel: currentPeriod });
  check(
    'Test 1: compute-now başarılı, activeDeviceCount=2 ve deviceDays doğru hesaplandı',
    computeRes.status === 200 &&
      computeRes.data.data?.activeDeviceCount === 2 &&
      computeRes.data.data?.deviceDays === 2 * daysInMonth(currentPeriod) &&
      computeRes.data.data?.periodLabel === currentPeriod,
    `yanıt: ${JSON.stringify(computeRes.data)}`
  );
  check(
    'Test 1b: telemetry_packet_count gerçek MQTT paketini yakaladı (>= 1)',
    computeRes.data.data?.telemetryPacketCount >= 1,
    `telemetryPacketCount: ${computeRes.data.data?.telemetryPacketCount}`
  );

  // --- Test 2: aynı dönem için ikinci çağrı → no-op (append-only) ---
  const computeAgainRes = await api('POST', '/usage-metering/compute-now', ownerToken, { periodLabel: currentPeriod });
  check(
    'Test 2: Aynı dönem tekrar hesaplanınca no-op (append-only, data: null)',
    computeAgainRes.status === 200 && computeAgainRes.data.data === null,
    `yanıt: ${JSON.stringify(computeAgainRes.data)}`
  );

  // --- Test 3: GET /usage-metering geçmişte doğru kaydı gösteriyor ---
  const historyRes = await api('GET', '/usage-metering', ownerToken);
  const record = (historyRes.data.data || []).find((r: any) => r.periodLabel === currentPeriod);
  check(
    'Test 3: GET /usage-metering geçmişinde bu dönemin kaydı var ve activeDeviceCount tutarlı',
    historyRes.status === 200 && !!record && record.activeDeviceCount === 2,
    `bulunan kayıt: ${JSON.stringify(record)}`
  );

  // --- Test 4: SUPER_ADMIN olmayan başka bir tenant'ın kullanıcısı bu firmanın verisini GÖREMEZ (RLS) ---
  // (Bu, ayrı bir seed kullanıcıyla RLS'i dolaylı doğrular — admin token KENDİ tenant'ını görür.)
  const adminHistoryRes = await api('GET', '/usage-metering', adminToken);
  const adminSeesOtherTenantRecord = (adminHistoryRes.data.data || []).some((r: any) => r.tenantId === companyId);
  check(
    'Test 4: SUPER_ADMIN kendi (comp-camsa) usage-metering geçmişini görür, TEST FİRMASININ kaydını GÖRMEZ (RLS)',
    adminHistoryRes.status === 200 && !adminSeesOtherTenantRecord,
    `admin'in gördüğü tenant\'lar: ${JSON.stringify([...new Set((adminHistoryRes.data.data || []).map((r: any) => r.tenantId))])}`
  );

  console.log('===========================================================');
  console.log(`📊 TEST SONUÇLARI: ${passed} / ${total} TEST BAŞARILI`);
  console.log('===========================================================');
  if (passed !== total) process.exit(1);
}

run().catch((err) => {
  console.error('❌ Test çalıştırma hatası:', err);
  process.exit(1);
});
