import crypto from 'crypto';
import mqtt from 'mqtt';
import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * IOT-307 (#110) — NTP/RTC saat senkronu ve saat sapması tespiti.
 *
 * KAPSAM UYARLAMASI: ticket "NestJS + MQTT yanıt topic'i + IOT-305 komut kuyruğu + FW-1312" öneriyor.
 * Bu kod tabanında NestJS yok (Express); FW-1312 (cihazın RTC donanımı) bu depoda yok. Komut
 * kuyruğu IOT-305'in ZATEN kurduğu `command/v1/{deviceId}` MQTT kanalıdır (mqttService.publishCommand
 * — FORCE_CUTOFF ile AYNI mekanizma), ikinci bir kuyruk İCAT EDİLMEDİ.
 *
 * Üç ayrı cihaz kullanılır (izolasyon — Redis sayaç/cooldown'ları cihaz başına anahtarlanır,
 * testler birbirinin sayacını bozmasın): DEVICE_A (kalıcı orta sapma, WARNING), DEVICE_B (küçük
 * sapma, yan etkisiz), DEVICE_C (kalıcı büyük sapma, CRITICAL). Ayrıca ESP32-PUMP-01 (tohum) ile
 * gerçek bir ikmal döngüsü (device_reported_at/server_received_at) ve tohum olmayan taze bir
 * cihazla offline sync-batch (geçmiş tarihli kayıt) test edilir.
 *
 * CI NOTU: bu dosya `auth-integration-test` işinde (yalnızca gerçek Postgres+Redis; test_fuel401/
 * test_fuel410 ile AYNI ortam) koşar — o iş gerçek bir EMQX'e HİÇ bağlanmaz (`MQTT_URL=__CI_SKIP__`).
 * `mqttService.publishCommand()` bu durumda güvenle no-op'tur (bağlı değilken sessizce loglar) —
 * drift KAYDI, KALICI ALARM ve yanıt alanları (serverTime, device_reported_at/server_received_at)
 * bundan ETKİLENMEZ ve HER ortamda tam doğrulanır. Yalnızca T3 (TIME_SYNC komutunun GERÇEKTEN MQTT'ye
 * yayınlandığının gözlemi) gerçek bir broker ister — `MQTT_URL_TEST` tanımlıysa (yerelde/host'ta,
 * `docker compose` ayaktayken) o KANIT da doğrulanır, yoksa `atlandı` olarak işaretlenip pas/kırık
 * sayısına KATILMAZ (test_iot301_mqtt_resilience.ts'in host-only yaklaşımıyla AYNI ruh, ama burada
 * geri kalan 12 doğrulama için CI'ı hiç feda etmiyoruz).
 */

const API_URL = 'http://localhost:5000/api/v1';
const MQTT_URL = process.env.MQTT_URL_TEST || 'mqtt://localhost:1883';
const MQTT_USERNAME = process.env.MQTT_USERNAME || '';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || '';
const TENANT = 'comp-camsa';
const SITE = 'Gebze Ana Şantiye';
const RUN = Date.now();

function pg(): Client {
  return new Client({
    host: process.env.POSTGRES_HOST || 'localhost', port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres', password: process.env.POSTGRES_PASSWORD || 'postgres', database: process.env.POSTGRES_DB || 'yakittakip_db'
  });
}
async function q(sql: string, params: any[] = []): Promise<any[]> {
  const c = pg(); await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}
async function call(method: string, path: string, opts: { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
  if (path === '/auth/login') await resetLoginRateLimit();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${API_URL}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function login(username: string): Promise<string> {
  const r = await call('POST', '/auth/login', { body: { username, password: '123456' } });
  if (!r.body.accessToken) throw new Error(`'${username}' girişi başarısız: ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
}

/** driftSeconds > 0 → cihaz saati GERİDE (X-Timestamp geçmişte); < 0 → cihaz İLERİDE. */
function hwHeaders(secret: string, deviceId: string, rawBody: string, driftSeconds: number): Record<string, string> {
  const timestamp = (Date.now() - driftSeconds * 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${nonce}.${rawBody}`).digest('hex');
  return { 'Content-Type': 'application/json', 'X-Device-ID': deviceId, 'X-Timestamp': timestamp, 'X-Nonce': nonce, 'X-Hardware-Signature': signature };
}
async function hwGet(deviceId: string, secret: string, path: string, driftSeconds: number): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API_URL}${path}`, { method: 'GET', headers: hwHeaders(secret, deviceId, '{}', driftSeconds) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function hwPost(deviceId: string, secret: string, path: string, body: object, driftSeconds = 0): Promise<{ status: number; body: any }> {
  const raw = JSON.stringify(body);
  const res = await fetch(`${API_URL}${path}`, { method: 'POST', headers: hwHeaders(secret, deviceId, raw, driftSeconds), body: raw });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function registerDevice(token: string, deviceId: string): Promise<string> {
  const r = await call('POST', '/hardware-devices', { token, body: { deviceId, name: `IOT-307 test ${deviceId}`, siteName: SITE } });
  if (r.status !== 200) throw new Error(`cihaz kaydı başarısız (${deviceId}): ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data.secret as string;
}

/**
 * command/v1/{deviceId} kanalını dinler, gelen komutları biriktirir. Gerçek bir broker yoksa (CI'nın
 * `auth-integration-test` işi gibi — bkz. dosya başı CI NOTU) 2 sn içinde bağlanamayıp `null` döner;
 * çağıran bunu "bu kanıt bu ortamda doğrulanamaz" olarak ele alır, testi KIRMAZ.
 */
async function subscribeCommands(deviceId: string): Promise<{ messages: any[]; close: () => Promise<void> } | null> {
  const client = mqtt.connect(MQTT_URL, { username: MQTT_USERNAME, password: MQTT_PASSWORD, protocolVersion: 5, connectTimeout: 2000, reconnectPeriod: 0 });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MQTT bağlantı zaman aşımı')), 2000);
      client.on('connect', () => { clearTimeout(timer); resolve(); });
      client.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
  } catch {
    client.end(true);
    return null;
  }
  const messages: any[] = [];
  await new Promise<void>((resolve, reject) => client.subscribe(`command/v1/${deviceId}`, { qos: 1 }, (err) => (err ? reject(err) : resolve())));
  client.on('message', (_topic, payload) => { try { messages.push(JSON.parse(payload.toString())); } catch { /* yut */ } });
  return { messages, close: () => new Promise((r) => client.end(false, {}, () => r())) };
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function run() {
  console.log('===========================================================');
  console.log('⏱️  [IOT-307] SAAT SENKRONU VE SAPMA TESPİTİ TESTİ');
  console.log('===========================================================\n');
  let passed = 0; let total = 0; let skipped = 0;
  const check = (name: string, ok: boolean, detail: string) => { total++; if (ok) { passed++; console.log(`✅ [PASS] ${name}\n   ${detail}\n`); } else console.log(`❌ [FAIL] ${name}\n   ${detail}\n`); };
  const checkOrSkip = (name: string, mqttAvailable: boolean, ok: boolean, detail: string) => {
    if (!mqttAvailable) { skipped++; console.log(`⏭️  [ATLANDI] ${name} (gerçek MQTT broker yok — MQTT_URL_TEST tanımlayıp tekrar çalıştırın)\n`); return; }
    check(name, ok, detail);
  };

  const owner = await login('camsa');
  const deviceIds = { a: `IOT307-A-${RUN}`, b: `IOT307-B-${RUN}`, c: `IOT307-C-${RUN}`, sync: `IOT307-SYNC-${RUN}`, dispense: `IOT307-DISP-${RUN}` };
  const secrets: Record<string, string> = {};
  for (const [k, id] of Object.entries(deviceIds)) secrets[k] = await registerDevice(owner, id);

  const txIds: string[] = [];
  const cleanup = async () => {
    await q(`DELETE FROM transactions WHERE tenant_id = $1 AND (device_id = ANY($2) OR id = ANY($3))`, [TENANT, Object.values(deviceIds), txIds]);
    await q(`DELETE FROM alarms WHERE tenant_id = $1 AND alarm_key = ANY($2)`, [TENANT, Object.values(deviceIds).map((id) => `DEVICE_CLOCK_DRIFT:${id}`)]);
    await q(`DELETE FROM hardware_devices WHERE device_id = ANY($1)`, [Object.values(deviceIds)]);
    await q(`UPDATE vehicles SET assigned_driver_name = NULL WHERE id = 'veh-1'`);
  };

  try {
    // === T1 (küçük sapma — yan etkisiz): eşiğin (5sn) ALTINDA sapma kaydedilir ama komut/alarm YOK ===
    const cmdB = await subscribeCommands(deviceIds.b);
    const small = await hwGet(deviceIds.b, secrets.b, '/telemetry/fail-open-policy', 2);
    await sleep(700);
    const devB = (await q(`SELECT last_clock_drift_ms, last_clock_drift_at FROM hardware_devices WHERE device_id = $1`, [deviceIds.b]))[0];
    check(
      'T1: 2 sn sapma (5 sn eşiğinin ALTINDA) — istek kabul edilir, last_clock_drift_ms işaretli (+) ~2000 ms olarak kaydedilir, last_clock_drift_at dolar',
      small.status === 200 && Math.abs(Number(devB?.last_clock_drift_ms) - 2000) < 400 && !!devB?.last_clock_drift_at,
      `status=${small.status} drift=${devB?.last_clock_drift_ms} at=${!!devB?.last_clock_drift_at}`
    );
    checkOrSkip(
      'T1b: eşiğin ALTINDAKİ sapmada TIME_SYNC komutu YAYINLANMAZ', !!cmdB,
      cmdB?.messages.length === 0, `komut=${cmdB?.messages.length}`
    );
    await cmdB?.close();

    // === T2+T3 (AC1 — eşik aşımı → senkron komutu, cooldown'lu): 10 sn sapma × 4 hızlı istek ===
    const cmdA = await subscribeCommands(deviceIds.a);
    const drift10 = [];
    for (let i = 0; i < 4; i++) drift10.push(await hwGet(deviceIds.a, secrets.a, '/telemetry/fail-open-policy', 10));
    await sleep(700);
    const devA = (await q(`SELECT last_clock_drift_ms FROM hardware_devices WHERE device_id = $1`, [deviceIds.a]))[0];
    check(
      'T2 (AC1): 10 sn sapma (5-30 sn arası) — 4 istek de KABUL edilir (200, henüz 30 sn sınırı değil), last_clock_drift_ms ~10000',
      drift10.every((r) => r.status === 200) && Math.abs(Number(devA?.last_clock_drift_ms) - 10000) < 400,
      `statuses=${drift10.map((r) => r.status)} drift=${devA?.last_clock_drift_ms}`
    );
    checkOrSkip(
      'T3 (AC1, MQTT kanıtı): aynı cihaza 60 sn içinde TEKRAR TEKRAR TIME_SYNC komutu BASILMAZ — 4 istekte TAM OLARAK 1 komut yayınlanır ve serverTime/driftMs içerir', !!cmdA,
      cmdA?.messages.length === 1 && cmdA?.messages[0]?.command === 'TIME_SYNC' && typeof cmdA?.messages[0]?.serverTime === 'string' && Math.abs(cmdA!.messages[0]?.driftMs - 10000) < 400,
      `komutlar=${JSON.stringify(cmdA?.messages)}`
    );
    await cmdA?.close();

    // === T4 (AC3 — kalıcı sapma alarmı): 3+ tekrar sonrası alarm; 4. istekte İKİNCİ alarm/event YOK ===
    const alarmA = (await q(`SELECT category, severity, status, event_count, site_name, subject_id FROM alarms WHERE tenant_id = $1 AND alarm_key = $2`, [TENANT, `DEVICE_CLOCK_DRIFT:${deviceIds.a}`]))[0];
    check(
      'T4 (AC3): "kalıcı" sapma (kısa pencerede 3+ tekrar) bir alarm yükseltir — kategori DEVICE_CLOCK_DRIFT, WARNING (10 sn < 15 sn kritik eşiği), OPEN, tek bir event (alarm-cooldown 4. isteği bastırdı)',
      alarmA?.category === 'DEVICE_CLOCK_DRIFT' && alarmA?.severity === 'WARNING' && alarmA?.status === 'OPEN' && Number(alarmA?.event_count) === 1 && alarmA?.subject_id === deviceIds.a && alarmA?.site_name === SITE,
      `alarm=${JSON.stringify(alarmA)}`
    );

    // === T5 (kritik sapma): 20 sn (>15 sn eşiği) × 3 tekrar → CRITICAL ===
    for (let i = 0; i < 3; i++) await hwGet(deviceIds.c, secrets.c, '/telemetry/fail-open-policy', 20);
    const alarmC = (await q(`SELECT severity FROM alarms WHERE tenant_id = $1 AND alarm_key = $2`, [TENANT, `DEVICE_CLOCK_DRIFT:${deviceIds.c}`]))[0];
    check('T5: 20 sn kalıcı sapma (15 sn CRITICAL eşiğinin üstünde) → alarm CRITICAL şiddetinde', alarmC?.severity === 'CRITICAL', `severity=${alarmC?.severity}`);

    // === T6 (regresyon — AUTH-202.2 değişmedi): 40 sn sapma hâlâ 401 CLOCK_DRIFT ile reddedilir ===
    const rejected = await hwGet(deviceIds.b, secrets.b, '/telemetry/fail-open-policy', 40);
    check('T6 (regresyon): 40 sn sapma (30 sn sert sınırın üstünde) hâlâ 401 REPLAY_ATTACK_DETECTED ile reddedilir — IOT-307 bu sınırı GEVŞETMEDİ', rejected.status === 401 && rejected.body?.error === 'REPLAY_ATTACK_DETECTED', `status=${rejected.status} body=${JSON.stringify(rejected.body)}`);

    // === T7 (AC1 — heartbeat yanıtı): gerçek bir ikmal döngüsünde heartbeat YANITI serverTime taşır ===
    await q(`UPDATE vehicles SET assigned_driver_name = 'Ahmet Yılmaz' WHERE id = 'veh-1'`);
    await q(`DELETE FROM transactions WHERE idempotency_key LIKE 'iot307-%'`);
    const tankBefore = Number((await q(`SELECT current_level_liters FROM tanks WHERE id = 'tank-gebze-1'`))[0].current_level_liters);

    const beforeAuth = Date.now();
    const auth = await hwPost(deviceIds.dispense, secrets.dispense, '/dispense/request-auth', { rfidCardId: 'CARD-881201', tankName: 'Gebze Ana Tank (T-1)' });
    const sessionId = auth.body?.data?.sessionId;
    const hb = await hwPost(deviceIds.dispense, secrets.dispense, '/dispense/heartbeat', { sessionId, totalizerLiters: 3000, flowRateLpm: 20 });
    check(
      'T7 (AC1): /dispense/heartbeat yanıtı HER ZAMAN serverTime taşır (ISO, "şimdi"ye yakın) — sürekli komut beklemeden pasif senkron karşılaştırması',
      hb.status === 200 && hb.body?.command === 'CONTINUE' && typeof hb.body?.serverTime === 'string' && Math.abs(new Date(hb.body.serverTime).getTime() - Date.now()) < 5000 && new Date(hb.body.serverTime).getTime() >= beforeAuth,
      `status=${hb.status} serverTime=${hb.body?.serverTime}`
    );

    // === T8 (AC2 — online ikmal): finalize kaydı hem cihaz zamanını (device_reported_at ≈ X-Timestamp) hem sunucu alış zamanını (server_received_at ≈ şimdi) taşır ===
    const idem1 = `iot307-${RUN}-online`;
    // Kasıtlı 8 sn'lik sapma: device_reported_at = Date.now() gibi bir REGRESYONU yakalayabilmek için
    // finalize'ın KENDİ X-Timestamp'i, "şimdi"den ölçülebilir biçimde FARKLI olmalı (5-30 sn arası, kabul edilir).
    const FINALIZE_DRIFT_SECONDS = 8;
    const finXTimestampMs = Date.now() - FINALIZE_DRIFT_SECONDS * 1000;
    const fin = await hwPost(deviceIds.dispense, secrets.dispense, '/dispense/finalize', { sessionId, endTotalizerLiters: 3050, reportedLiters: 50, idempotencyKey: idem1 }, FINALIZE_DRIFT_SECONDS);
    if (fin.body?.data?.id) txIds.push(fin.body.data.id);
    const row1 = (await q(`SELECT device_reported_at, server_received_at, created_at FROM transactions WHERE idempotency_key = $1`, [idem1]))[0];
    check(
      'T8 (AC2, online): finalize kaydında device_reported_at, isteğin KENDİ X-Timestamp\'ine (8 sn geride) eşittir — "şimdi"ye (Date.now()) DEĞİL; server_received_at ayrıca DOLU ve şimdiye yakın — ikisi ölçülebilir biçimde FARKLI, adli inceleme için ayrı',
      fin.status === 200 && !!row1?.device_reported_at && !!row1?.server_received_at &&
        Math.abs(new Date(row1.device_reported_at).getTime() - finXTimestampMs) < 1500 &&
        Math.abs(new Date(row1.device_reported_at).getTime() - Date.now()) > 5000 &&
        Math.abs(new Date(row1.server_received_at).getTime() - Date.now()) < 5000,
      `device_reported_at=${row1?.device_reported_at} (beklenen ~${new Date(finXTimestampMs).toISOString()}) server_received_at=${row1?.server_received_at} şimdi=${new Date().toISOString()}`
    );

    // === T9 (AC2 — offline sync): geçmiş tarihli (3 gün önce) kayıt — device_reported_at ESKİ, server_received_at YENİ (created_at da eski, ama server_received_at ile KARIŞTIRILAMAZ) ===
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const syncBeforeMs = Date.now();
    const sync = await hwPost(deviceIds.sync, secrets.sync, '/telemetry/sync-batch', {
      records: [{ localSequenceId: 1, deviceTimestamp: threeDaysAgo, siteName: SITE, vehiclePlate: '34 CTP 82', tankName: 'Gebze Ana Tank (T-1)', amountLiters: 5, flowRateLpm: 20 }]
    });
    const row2 = (await q(`SELECT id, created_at, device_reported_at, server_received_at FROM transactions WHERE device_id = $1 AND local_sequence_id = 1`, [deviceIds.sync]))[0];
    if (row2?.id) txIds.push(row2.id);
    check(
      'T9 (AC2, offline — ASIL fark burada): 3 gün önceki bir kayıt senkronlandığında created_at VE device_reported_at cihazın (ESKİ) zamanını taşır, ama server_received_at "şimdi"dir — created_at\'a bakan biri "ne zaman olduğunu", server_received_at\'a bakan biri "ne zaman öğrendiğimizi" görür',
      sync.status === 200 && !!row2 &&
        Math.abs(new Date(row2.created_at).getTime() - new Date(threeDaysAgo).getTime()) < 2000 &&
        Math.abs(new Date(row2.device_reported_at).getTime() - new Date(threeDaysAgo).getTime()) < 2000 &&
        Math.abs(new Date(row2.server_received_at).getTime() - syncBeforeMs) < 5000 &&
        (new Date(row2.server_received_at).getTime() - new Date(row2.created_at).getTime()) > 2.9 * 24 * 60 * 60 * 1000,
      `created_at=${row2?.created_at} device_reported_at=${row2?.device_reported_at} server_received_at=${row2?.server_received_at}`
    );

    // === T10 (AC2 — cihaz yok): manuel/operatör ikmalinde device_reported_at NULL kalır (server_received_at yine dolar) ===
    const manual = await call('POST', '/dispense', {
      token: owner,
      body: { siteName: SITE, vehiclePlate: '34 CTP 82', driverName: 'Ahmet Yılmaz', tankName: 'Gebze Ana Tank (T-1)', amountLiters: 3 }
    });
    if (manual.body?.data?.id) txIds.push(manual.body.data.id);
    const row3 = manual.body?.data?.id ? (await q(`SELECT device_reported_at, server_received_at FROM transactions WHERE id = $1`, [manual.body.data.id]))[0] : null;
    check(
      'T10 (AC2, cihaz yok): manuel/operatör ikmalinde device_reported_at NULL\'dur (sessizce "şimdi" SAYILMAZ) — server_received_at yine otomatik dolar',
      manual.status === 200 && row3 && row3.device_reported_at === null && !!row3.server_received_at,
      `status=${manual.status} device_reported_at=${row3?.device_reported_at} server_received_at=${row3?.server_received_at}`
    );

    const finalTank = Number((await q(`SELECT current_level_liters FROM tanks WHERE id = 'tank-gebze-1'`))[0].current_level_liters);
    check('Kontrol: tank stoku üç ikmalin (50+5+3=58 L) TAMAMI kadar düştü — yeni sütunlar iş mantığına dokunmadı', Math.abs(tankBefore - finalTank - 58) < 0.01, `önce=${tankBefore} sonra=${finalTank}`);

    // === T11 (rapor): REP-711 hem JSON hem CSV'de iki yeni sütunu tutarlı taşır ===
    const repJson = await call('GET', `/reports/rep-711?vehiclePlate=${encodeURIComponent('34 CTP 82')}&pageSize=100`, { token: owner });
    const jsonRow = (repJson.body?.data ?? []).find((r: any) => r.id === fin.body?.data?.id);
    const csvRes = await fetch(`${API_URL}/reports/rep-711/export?format=csv&vehiclePlate=${encodeURIComponent('34 CTP 82')}`, { headers: { Authorization: `Bearer ${owner}` } });
    const csvText = await csvRes.text();
    const csvHasCols = /Cihaz Zamanı/.test(csvText) && /Sunucu Alış Zamanı/.test(csvText);
    check(
      'T11: rep-711 JSON\'da device_reported_at/server_received_at alanları, CSV export\'ta "Cihaz Zamanı"/"Sunucu Alış Zamanı" başlıklı sütunlar olarak görünür (aynı alanlar, tutarlı)',
      repJson.status === 200 && jsonRow && 'device_reported_at' in jsonRow && 'server_received_at' in jsonRow && csvRes.status === 200 && csvHasCols,
      `jsonRow anahtarları=${jsonRow ? Object.keys(jsonRow).filter((k) => /reported|received/.test(k)) : 'BULUNAMADI'} csvBaşlık=${csvHasCols}`
    );

    // === T12 (panel görünürlüğü): GET /hardware-devices son sapmayı taşır ===
    const devices = await call('GET', '/hardware-devices', { token: owner });
    const devRow = (devices.body?.data ?? []).find((d: any) => d.device_id === deviceIds.a);
    check('T12: GET /hardware-devices, ölçülen son sapmayı (last_clock_drift_ms/_at) döner — cihaz sağlığı panelinde (FE-806) görünür kılınabilir', devices.status === 200 && !!devRow && Math.abs(Number(devRow.last_clock_drift_ms) - 10000) < 400 && !!devRow.last_clock_drift_at, `devRow=${JSON.stringify(devRow)}`);
  } finally {
    await cleanup();
  }

  console.log(`\nSONUÇ: ${passed}/${total} test geçti.${skipped > 0 ? ` (${skipped} MQTT kanıtı atlandı — gerçek broker yok)` : ''}`);
  process.exit(passed === total && total >= 12 ? 0 : 1);
}
run().catch((e) => { console.error('Beklenmeyen hata:', e); process.exit(1); });
