import crypto from 'crypto';
import { Client } from 'pg';
import { io as socketIoClient, Socket } from 'socket.io-client';
import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * TEST_PLAN.md / GitHub #78 [FLEET-1402] — RFID tag eşleştirme, değiştirme
 * ve geçmişi.
 *
 * Bu ticket'ın açılışında `replaceRfidCard` (AUTH-210) ve kara liste akışı
 * ZATEN kurulu bulundu — burada test edilen, GERÇEKTEN eklenen üç parça:
 *  1. AC: "Bir UID aynı anda yalnızca bir araçla eşleşebilmelidir." Önceden
 *     BU KONTROL HİÇ YOKTU — ne createVehicle/updateVehicle'da (assertPlate
 *     Available'ın plaka için yaptığının rfid_tag karşılığı), ne
 *     replaceRfidCard'ın hedef UID'i başka bir araçta olsa bile blind
 *     UPDATE'inde. Üçü de artık DUPLICATE_RFID_TAG (409) ile reddediyor.
 *  2. AC: "Etiket geçmişi denetim için saklanmalıdır." Düz "Düzenle"
 *     formundan (replaceRfidCard akışından GEÇMEDEN) yapılan bir rfid_tag
 *     değişikliği önceden HİÇ audit'lenmiyordu — artık updateVehicle
 *     VEHICLE_RFID_TAG_CHANGED yazıyor (yalnızca GERÇEK değişiklikte, aynı
 *     değer yeniden gönderilirse DEĞİL).
 *  3. AC: "Eşleşmemiş kart okutulduğunda uyarı... panele anlık düşmelidir."
 *     Önceden yalnızca CİHAZA (pompaya) bir 403 dönüyordu — panelde açık
 *     bir yöneticinin ekranına HİÇBİR ŞEY yansımıyordu. Artık
 *     authorizeDispenseRequest CARD_UNKNOWN'da AYRICA bir Socket.io
 *     'rfid:unmatched' olayı yayınlıyor (flow:unauthorized/FUEL-406 ile
 *     AYNI desen).
 *
 * "Hızlı tanımlama akışı" (frontend RfidUnmatchedAlerts.tsx) bu dosyanın
 * kapsamı DIŞINDA — o YENİ bir backend ucu İCAT ETMEDİ, VAR OLAN
 * updateVehicle/updateDriver'ı çağırıyor; o ikisinin doğruluğu zaten bu
 * dosyada VE test_fleet1401_vehicle_lifecycle.ts'te ayrıca test ediliyor.
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';
const DEVICE_ID = 'ESP32-PUMP-01';
const DEVICE_SECRET = process.env.HW_SECRET_ESP32_PUMP_01 || 'secret_gebze_pump_8849';
const SITE_TANK = 'Gebze Ana Tank (T-1)';
const RUN = Date.now();

function pg(): Client {
  return new Client({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database: process.env.POSTGRES_DB || 'yakittakip_db'
  });
}

async function login(username: string): Promise<string> {
  await resetLoginRateLimit();
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: '123456' })
  });
  const body = await res.json();
  if (!body.accessToken) throw new Error(`'${username}' girişi başarısız: ${JSON.stringify(body)}`);
  return body.accessToken;
}

async function api(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function sign(ts: string, nonce: string, raw: string): string {
  return crypto.createHmac('sha256', DEVICE_SECRET).update(`${ts}.${nonce}.${raw}`).digest('hex');
}
async function hwPost(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const raw = JSON.stringify(body);
  const ts = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-ID': DEVICE_ID, 'X-Timestamp': ts, 'X-Nonce': nonce, 'X-Hardware-Signature': sign(ts, nonce, raw) },
    body: raw
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [TEST_PLAN / GitHub #78] FLEET-1402 RFID EŞLEŞTİRME');
  console.log('===========================================================\n');
  let passed = 0;
  let total = 0;
  const check = (name: string, condition: boolean, detail: string) => {
    total++;
    console.log(`${condition ? '✅ [PASS]' : '❌ [FAIL]'} ${name}\n   ${detail}\n`);
    if (condition) passed++;
  };

  const db = pg();
  await db.connect();
  const vehicleIds: string[] = [];
  const blacklistUids: string[] = [];
  let socket: Socket | undefined;

  try {
    const owner = await login('camsa'); // COMPANY_OWNER, comp-camsa

    const tagA = `TAG-1402-A-${RUN}`;
    const tagB = `TAG-1402-B-${RUN}`;
    const tagD = `TAG-1402-D-${RUN}`;

    // --- AC: "Bir UID aynı anda yalnızca bir araçla eşleşebilmelidir." ----
    const vehA = await api('POST', '/vehicles', owner, {
      plate: `34 RFA ${String(RUN).slice(-4)}`, brandModel: 'RFID Testi A', rfidTag: tagA, fuelCapacityLiters: 300, siteName: 'Gebze Ana Şantiye'
    });
    check('Test 1: A aracı benzersiz UID ile oluşturulur', vehA.status === 200, `status=${vehA.status}, body=${JSON.stringify(vehA.body)}`);
    const vehicleAId: string = vehA.body?.data?.id;
    if (vehicleAId) vehicleIds.push(vehicleAId);

    const vehDup = await api('POST', '/vehicles', owner, {
      plate: `34 RFX ${String(RUN).slice(-4)}`, brandModel: 'RFID Kopya Testi', rfidTag: tagA, fuelCapacityLiters: 300, siteName: 'Gebze Ana Şantiye'
    });
    check(
      'Test 2: AYNI UID ile İKİNCİ araç oluşturma 409 DUPLICATE_RFID_TAG ile reddedilir',
      vehDup.status === 409 && vehDup.body?.details?.error === 'DUPLICATE_RFID_TAG',
      `status=${vehDup.status}, body=${JSON.stringify(vehDup.body)}`
    );

    const vehB = await api('POST', '/vehicles', owner, {
      plate: `34 RFB ${String(RUN).slice(-4)}`, brandModel: 'RFID Testi B', rfidTag: tagB, fuelCapacityLiters: 300, siteName: 'Gebze Ana Şantiye'
    });
    const vehicleBId: string = vehB.body?.data?.id;
    if (vehicleBId) vehicleIds.push(vehicleBId);
    check('Test 3: B aracı FARKLI bir UID ile sorunsuz oluşturulur', vehB.status === 200, `status=${vehB.status}`);

    const updateDup = await api('PUT', `/vehicles/${vehicleBId}`, owner, { rfidTag: tagA });
    check(
      'Test 4: GÜNCELLEME ile B\'nin UID\'sini A\'nınkiyle ÇAKIŞTIRMAK 409 ile reddedilir',
      updateDup.status === 409 && updateDup.body?.details?.error === 'DUPLICATE_RFID_TAG',
      `status=${updateDup.status}, body=${JSON.stringify(updateDup.body)}`
    );

    // --- AC: "Etiket geçmişi denetim için saklanmalıdır." ------------------
    const tagC = `TAG-1402-C-${RUN}`;
    const updateReal = await api('PUT', `/vehicles/${vehicleBId}`, owner, { rfidTag: tagC });
    check('Test 5: B\'nin UID\'sini GERÇEKTEN değiştirmek kabul edilir', updateReal.status === 200 && updateReal.body?.data?.rfid_tag === tagC, `status=${updateReal.status}`);

    const auditAfterChange = await db.query(
      `SELECT before_value, after_value FROM audit_logs WHERE action = 'VEHICLE_RFID_TAG_CHANGED' AND target_id = $1`,
      [vehicleBId]
    );
    check(
      'Test 6: Etiket değişimi audit_logs\'a yazılır (öncesi/sonrası UID\'lerle)',
      auditAfterChange.rows.length === 1 && auditAfterChange.rows[0].before_value?.rfidTag === tagB && auditAfterChange.rows[0].after_value?.rfidTag === tagC,
      `satırlar=${JSON.stringify(auditAfterChange.rows)}`
    );

    const updateNoop = await api('PUT', `/vehicles/${vehicleBId}`, owner, { rfidTag: tagC });
    const auditAfterNoop = await db.query(`SELECT id FROM audit_logs WHERE action = 'VEHICLE_RFID_TAG_CHANGED' AND target_id = $1`, [vehicleBId]);
    check(
      'Test 7: AYNI UID ile tekrar güncelleme YENİ bir audit satırı YAZMAZ (hâlâ 1 satır)',
      updateNoop.status === 200 && auditAfterNoop.rows.length === 1,
      `satır sayısı=${auditAfterNoop.rows.length}`
    );

    // --- replaceRfidCard'ın YENİ tekillik kontrolü ------------------------
    // Bu noktada: A → tagA, B → tagC (tagB serbest).
    const replaceOk = await api('POST', '/rfid-cards/replace', owner, { oldCardUid: tagA, newCardUid: tagB });
    blacklistUids.push(tagA);
    check(
      'Test 8: SERBEST bir UID\'e değiştirme kabul edilir (A: tagA → tagB)',
      replaceOk.status === 200 && replaceOk.body?.data?.movedVehicles === 1,
      `status=${replaceOk.status}, body=${JSON.stringify(replaceOk.body)}`
    );

    const vehD = await api('POST', '/vehicles', owner, {
      plate: `34 RFD ${String(RUN).slice(-4)}`, brandModel: 'RFID Testi D', rfidTag: tagD, fuelCapacityLiters: 300, siteName: 'Gebze Ana Şantiye'
    });
    if (vehD.body?.data?.id) vehicleIds.push(vehD.body.data.id);

    // A şu an tagB'yi taşıyor; tagD ise D'ye ait — tagB'yi tagD'ye
    // "değiştirmek" istemek D ile ÇAKIŞMALI.
    const replaceConflict = await api('POST', '/rfid-cards/replace', owner, { oldCardUid: tagB, newCardUid: tagD });
    check(
      'Test 9: replaceRfidCard, hedef UID BAŞKA bir araca aitse 409 DUPLICATE_RFID_TAG ile REDDEDER — canlı yakalanan bug, düzeltildi',
      replaceConflict.status === 409 && replaceConflict.body?.details?.error === 'DUPLICATE_RFID_TAG',
      `status=${replaceConflict.status}, body=${JSON.stringify(replaceConflict.body)}`
    );

    // --- AC: "Eşleşmemiş kart okutulduğunda uyarı... panele anlık düşmelidir." ---
    socket = socketIoClient(API_URL.replace('/api/v1', ''), {
      path: '/socket.io',
      auth: { token: owner },
      transports: ['websocket']
    });
    await new Promise<void>((resolve, reject) => {
      socket!.on('connect', () => resolve());
      socket!.on('connect_error', reject);
    });
    const unmatchedAlerts: any[] = [];
    socket.on('rfid:unmatched', (payload) => unmatchedAlerts.push(payload));

    const unknownCardUid = `UNKNOWN-CARD-${RUN}`;
    const requestAuthRes = await hwPost('/dispense/request-auth', { rfidCardId: unknownCardUid, tankName: SITE_TANK });
    check(
      'Test 10: Sisteme kayıtlı olmayan kartla request-auth 403 CARD_UNKNOWN döner (mevcut davranış, regresyon yok)',
      requestAuthRes.status === 403 && requestAuthRes.body?.details?.error === 'CARD_UNKNOWN',
      `status=${requestAuthRes.status}, body=${JSON.stringify(requestAuthRes.body)}`
    );

    await sleep(800);
    const matchingAlert = unmatchedAlerts.find((a) => a.cardUid === unknownCardUid);
    check(
      'Test 11: Panel Socket.io üzerinden \'rfid:unmatched\' olayını ANLIK alır — önceden HİÇ yayınlanmıyordu',
      !!matchingAlert && matchingAlert.siteName === 'Gebze Ana Şantiye' && matchingAlert.deviceId === DEVICE_ID,
      `alınanlar=${JSON.stringify(unmatchedAlerts)}`
    );
  } finally {
    if (socket) socket.disconnect();
    for (const vId of vehicleIds) {
      await db.query('DELETE FROM audit_logs WHERE action = $1 AND target_id = $2', ['VEHICLE_RFID_TAG_CHANGED', vId]);
      await db.query('DELETE FROM vehicles WHERE id = $1', [vId]);
    }
    for (const uid of blacklistUids) {
      await db.query(`DELETE FROM rfid_card_blacklist WHERE card_uid = $1`, [uid]);
    }
    await db.end();
    await resetLoginRateLimit();
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => {
  console.error('🔥 Test çalıştırılırken beklenmeyen hata:', err);
  process.exit(1);
});
