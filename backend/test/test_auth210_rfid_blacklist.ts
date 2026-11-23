import crypto from 'crypto';
import { Client } from 'pg';
import Redis from 'ioredis';

/**
 * AUTH-210 — RFID kart kayıp/blokaj ve kara liste (denylist) akışı.
 *
 * Kobay kart: 'CARD-881201' (seed'de drv-1 / Ahmet Yılmaz). Test SONUNDA
 * comp-camsa'nın tüm kara liste satırları ve Ahmet'in kart uid'i seed
 * değerine geri döndürülür (finally).
 */

const API_URL = 'http://localhost:5000/api/v1';
const DEVICE_ID = 'ESP32-PUMP-01';
const DEVICE_SECRET = process.env.HW_SECRET_ESP32_PUMP_01 || 'secret_gebze_pump_8849';
const CARD = 'CARD-881201';
const SITE_TANK = 'Gebze Ana Tank (T-1)';

const redis = new Redis({ host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379', 10) });

function pg(): Client {
  return new Client({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database: process.env.POSTGRES_DB || 'yakittakip_db'
  });
}

async function resetLoginRl(): Promise<void> {
  const keys = await redis.keys('rl:auth-login:*');
  if (keys.length) await redis.del(...keys);
}
async function call(method: string, path: string, opts: { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
  if (path === '/auth/login') await resetLoginRl();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${API_URL}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function login(username: string): Promise<string> {
  const r = await call('POST', '/auth/login', { body: { username, password: '123456' } });
  if (!r.body.accessToken) throw new Error(`login ${username}: ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
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
async function hwGet(path: string): Promise<{ status: number; body: any }> {
  const raw = '{}';
  const ts = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const res = await fetch(`${API_URL}${path}`, {
    method: 'GET',
    headers: { 'X-Device-ID': DEVICE_ID, 'X-Timestamp': ts, 'X-Nonce': nonce, 'X-Hardware-Signature': sign(ts, nonce, raw) }
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function requestAuth(cardUid: string): Promise<{ status: number; error?: string }> {
  const r = await hwPost('/dispense/request-auth', { rfidCardId: cardUid, tankName: SITE_TANK });
  return { status: r.status, error: r.body?.details?.error ?? r.body?.error };
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [AUTH-210] RFID KART KARA LİSTE (DENYLIST) TESTİ');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };

  try {
    const owner = await login('camsa');

    // Test 1: kartı kara listeye al (LOST)
    const r1 = await call('POST', `/rfid-cards/${CARD}/block`, { token: owner, body: { status: 'LOST', reason: 'Sürücü kartını kaybetti' } });
    check('Test 1: RFID kartı kara listeye alınıyor (LOST) → 201', r1.status === 201 && r1.body.data?.status === 'LOST', `status=${r1.status}, data.status=${r1.body.data?.status}`);

    // Test 2: denylist listesinde görünüyor
    const r2 = await call('GET', '/rfid-cards/denylist', { token: owner });
    check('Test 2: GET /rfid-cards/denylist kartı gösteriyor',
      r2.status === 200 && (r2.body.data || []).some((x: any) => x.card_uid === CARD && x.status === 'LOST'),
      `totalCount=${r2.body.totalCount}`);

    // Test 3: ikmal yetkilendirmesi — DENYLIST WHITELIST'TEN ÖNCE → RFID_CARD_BLOCKED
    const r3 = await requestAuth(CARD);
    check('Test 3: kara listedeki kartla request-auth → RFID_CARD_BLOCKED (whitelist\'ten ÖNCE)',
      r3.status === 403 && r3.error === 'RFID_CARD_BLOCKED', `status=${r3.status}, error=${r3.error}`);

    // Test 4: unblock → kart denylist kapısını geçiyor (artık farklı bir kod / RFID_CARD_BLOCKED DEĞİL)
    const r4u = await call('POST', `/rfid-cards/${CARD}/unblock`, { token: owner });
    const r4 = await requestAuth(CARD);
    check('Test 4: unblock sonrası kart denylist kapısını geçiyor (RFID_CARD_BLOCKED değil)',
      r4u.status === 200 && r4.error !== 'RFID_CARD_BLOCKED',
      `unblock=${r4u.status}, request-auth error=${r4.error}`);

    // Test 5: kara listede olmayan kartı unblock → 404
    const r5 = await call('POST', `/rfid-cards/BILINMEYEN-KART-XYZ/unblock`, { token: owner });
    check('Test 5: listede olmayan kartı unblock → 404', r5.status === 404, `status=${r5.status}`);

    // Test 6: kart değiştirme — eski REPLACED + sürücü kaydı yeni uid'e taşınıyor
    const NEW_CARD = 'CARD-REPLACED-999';
    const r6 = await call('POST', '/rfid-cards/replace', { token: owner, body: { oldCardUid: CARD, newCardUid: NEW_CARD } });
    const r6dl = await call('GET', '/rfid-cards/denylist', { token: owner });
    const oldRow = (r6dl.body.data || []).find((x: any) => x.card_uid === CARD);
    const r6old = await requestAuth(CARD);       // eski kart artık REPLACED → reddedilir
    const r6new = await requestAuth(NEW_CARD);   // yeni kart denylist'i geçer
    check('Test 6: kart değiştirme — eski REPLACED+reddedilir, sürücü kaydı yeni uid\'e taşınır, yeni kart geçerli',
      r6.status === 200 && r6.body.data?.movedDrivers === 1 &&
      oldRow?.status === 'REPLACED' && oldRow?.replaced_by_card_uid === NEW_CARD &&
      r6old.error === 'RFID_CARD_BLOCKED' && r6new.error !== 'RFID_CARD_BLOCKED',
      `replace=${r6.status}/moved=${r6.body.data?.movedDrivers}, oldRow=${oldRow?.status}/${oldRow?.replaced_by_card_uid}, eski kart=${r6old.error}, yeni kart=${r6new.error}`);

    // Test 7: yeni kartın kendisi kara listedeyse replace → 409
    await call('POST', `/rfid-cards/CARD-BLK-1/block`, { token: owner, body: { status: 'BLOCKED' } });
    const r7 = await call('POST', '/rfid-cards/replace', { token: owner, body: { oldCardUid: NEW_CARD, newCardUid: 'CARD-BLK-1' } });
    check('Test 7: yeni kart zaten kara listedeyse replace → 409 NEW_CARD_BLOCKED',
      r7.status === 409 && r7.body.details?.error === 'NEW_CARD_BLOCKED', `status=${r7.status}, err=${r7.body.details?.error}`);

    // Test 8: cihaz denylist'i çekiyor (HMAC)
    const r8 = await hwGet('/telemetry/rfid-denylist');
    check('Test 8: cihaz GET /telemetry/rfid-denylist ile listeyi çekiyor (sürüm + uid\'ler)',
      r8.status === 200 && typeof r8.body.data?.version === 'string' &&
      Array.isArray(r8.body.data?.deniedCardUids) && r8.body.data.deniedCardUids.includes('CARD-BLK-1'),
      `status=${r8.status}, version=${r8.body.data?.version}, count=${r8.body.data?.deniedCardUids?.length}`);

    // Test 9: deployment-status — çekişten sonra GÜNCEL; sonra yeni blok → DAĞITIM_BEKLIYOR
    const r9a = await call('GET', '/rfid-cards/denylist-deployment-status', { token: owner });
    const pumpBefore = (r9a.body.data || []).find((x: any) => x.deviceId === DEVICE_ID);
    await call('POST', `/rfid-cards/CARD-BLK-2/block`, { token: owner, body: { status: 'BLOCKED' } });
    const r9b = await call('GET', '/rfid-cards/denylist-deployment-status', { token: owner });
    const pumpAfter = (r9b.body.data || []).find((x: any) => x.deviceId === DEVICE_ID);
    check('Test 9: deployment-status — çekiş sonrası GÜNCEL, yeni blok sonrası DAĞITIM_BEKLIYOR (AC 3)',
      pumpBefore?.status === 'GÜNCEL' && pumpAfter?.status === 'DAĞITIM_BEKLIYOR' && r9b.body.staleCount >= 1,
      `önce=${pumpBefore?.status}, sonra=${pumpAfter?.status}, staleCount=${r9b.body.staleCount}`);

    // Test 10: Zod — geçersiz status / aynı old=new
    const r10a = await call('POST', `/rfid-cards/${CARD}/block`, { token: owner, body: { status: 'FROZEN' } });
    const r10b = await call('POST', '/rfid-cards/replace', { token: owner, body: { oldCardUid: 'X', newCardUid: 'X' } });
    check('Test 10: Zod — status FROZEN & old==new → 400',
      r10a.status === 400 && r10a.body.error === 'VALIDATION_ERROR' && r10b.status === 400 && r10b.body.error === 'VALIDATION_ERROR',
      `blok=${r10a.status}, replace=${r10b.status}`);

    // Test 11: token olmadan yönetim ucu → 401
    const r11 = await call('GET', '/rfid-cards/denylist');
    check('Test 11: token olmadan /rfid-cards/denylist → 401', r11.status === 401, `status=${r11.status}`);

  } finally {
    const c = pg();
    await c.connect();
    await c.query("DELETE FROM rfid_card_blacklist WHERE tenant_id = 'comp-camsa'");
    await c.query("UPDATE drivers SET rfid_card_id = $1 WHERE id = 'drv-1'", [CARD]);
    await c.query("UPDATE vehicles SET rfid_tag = $1 WHERE rfid_tag = $2", ['TAG-882910', 'CARD-REPLACED-999']);
    await c.end();
    try { const ks = await redis.keys('rfid:denylist:*'); if (ks.length) await redis.del(...ks); } catch { /* */ }
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  await redis.quit();
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => { console.error('💥', err); process.exit(1); });
