import crypto from 'crypto';
import Redis from 'ioredis';
import { Client } from 'pg';

/**
 * FUEL-410 / FW-1310 — GET /telemetry/rfid-whitelist: cihazın sunucuya erişemediğinde
 * çevrimdışı yetki verebileceği kartlar. Liste, çevrimiçi yetkilendirmenin
 * (authorizeDispenseRequest) kurallarıyla BİREBİR aynı süzülmeli; aksi halde çevrimdışı
 * cihaz, çevrimiçi reddedilecek bir karta yakıt verir.
 */

const API_URL = 'http://localhost:5000/api/v1';
const DEVICE_ID = 'ESP32-PUMP-01'; // comp-camsa, "Gebze Ana Şantiye"
const DEVICE_SECRET = process.env.HW_SECRET_ESP32_PUMP_01 || 'secret_gebze_pump_8849';
const SITE = 'Gebze Ana Şantiye';
const PERM_ID = 'fuel410-wl-perm';
const BL_ID = 'fuel410-wl-bl';

async function hwGet(path: string, signed = true): Promise<{ status: number; body: any }> {
  const timestamp = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = crypto.createHmac('sha256', DEVICE_SECRET).update(`${timestamp}.${nonce}.{}`).digest('hex');
  const headers: Record<string, string> = signed
    ? { 'X-Device-ID': DEVICE_ID, 'X-Timestamp': timestamp, 'X-Nonce': nonce, 'X-Hardware-Signature': signature }
    : {};
  const res = await fetch(`${API_URL}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function run() {
  console.log('===========================================================');
  console.log('📋 [FUEL-410 / FW-1310] CİHAZ RFID WHITELIST TESTİ');
  console.log('===========================================================\n');

  let passed = 0;
  let total = 0;
  function check(name: string, condition: boolean, detail: string) {
    total++;
    if (condition) {
      console.log(`✅ [PASS] ${name}\n   ${detail}\n`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${name}\n   ${detail}\n`);
    }
  }

  const db = new Client({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database: process.env.POSTGRES_DB || 'yakittakip_db'
  });
  await db.connect();
  const redis = new Redis({ host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379', 10) });
  const modulesBefore = (await db.query(`SELECT modules FROM companies WHERE id = 'comp-camsa'`)).rows[0].modules;

  // Kurulum — her kural için bir kart:
  //   881201 Ahmet  (SAHADA) → veh-1 Gebze, AKTİF                 → LİSTEDE
  //   881202 Mehmet (SAHADA) → veh-2 Gebze, ama kart kara listede  → YOK
  //   881203 Hasan  (SAHADA) → veh-3 Orman, çapraz izin yok        → YOK
  //   881204 İbrahim(SAHADA) → veh-4 Silivri, Gebze'ye çapraz izin → LİSTEDE (modül açıkken)
  //   881205 Caner  (İZİNLİ) → veh-5 Silivri                        → YOK
  const assign = [['veh-1', 'Ahmet Yılmaz'], ['veh-2', 'Mehmet Demir'], ['veh-3', 'Hasan Kaya'],
    ['veh-4', 'Ibrahim Çelik'], ['veh-5', 'Caner Şahin']];
  try {
    for (const [id, name] of assign) await db.query('UPDATE vehicles SET assigned_driver_name = $2 WHERE id = $1', [id, name]);
    await db.query(
      `INSERT INTO cross_site_permissions (id, tenant_id, vehicle_plate, driver_name, home_site, target_site, allowed_liters, used_liters, expiry_date, status)
       VALUES ($1, 'comp-camsa', '41 KCL 05', 'Ibrahim Çelik', 'Silivri Tesisleri', $2, 500, 0, CURRENT_DATE + 1, 'AKTİF')`,
      [PERM_ID, SITE]);
    await db.query(
      `INSERT INTO rfid_card_blacklist (id, tenant_id, card_uid, status, reason, reported_by)
       VALUES ($1, 'comp-camsa', 'CARD-881202', 'LOST', 'FUEL-410 testi', 'test')`, [BL_ID]);
    await redis.del('rfid:denylist:comp-camsa').catch(() => undefined);

    // === Test 1: imzasız istek reddedilir ===
    const unsigned = await hwGet('/telemetry/rfid-whitelist', false);
    check('Test 1: İmzasız istek reddedilir (yalnızca HMAC\'li cihaz çekebilir)', unsigned.status === 401,
      `status=${unsigned.status}`);

    // === Test 2: çevrimiçi kurallarla aynı süzgeç ===
    const r = await hwGet('/telemetry/rfid-whitelist');
    const entries: Array<{ cardUid: string; vehiclePlate: string; driverName: string }> = r.body?.data?.entries ?? [];
    const byCard = new Map(entries.map((e) => [e.cardUid, e]));
    check('Test 2a: Şantiyenin aktif sürücüsünün kartı listede, araç plakasıyla',
      r.status === 200 && byCard.get('CARD-881201')?.vehiclePlate === '34 CTP 82' && byCard.get('CARD-881201')?.driverName === 'Ahmet Yılmaz',
      JSON.stringify(byCard.get('CARD-881201')));
    check('Test 2b: Kara listedeki kart listede YOK (denylist çevrimdışı da geçerli)', !byCard.has('CARD-881202'),
      `kartlar=${[...byCard.keys()].join(',')}`);
    check('Test 2c: Başka şantiyenin, çapraz izni olmayan aracı listede YOK', !byCard.has('CARD-881203'),
      `kartlar=${[...byCard.keys()].join(',')}`);
    check('Test 2d: Geçerli çapraz şantiye izni olan araç listede', byCard.get('CARD-881204')?.vehiclePlate === '41 KCL 05',
      JSON.stringify(byCard.get('CARD-881204')));
    check('Test 2e: Aktif olmayan (İZİNLİ) sürücünün kartı listede YOK', !byCard.has('CARD-881205'),
      `kartlar=${[...byCard.keys()].join(',')}`);
    check('Test 2f: Yanıtta sürüm, üretim zamanı ve cihazın şantiyesi var (sync-batch kaydı için)',
      typeof r.body?.data?.version === 'string' && r.body.data.version.length > 0 &&
        !Number.isNaN(Date.parse(r.body?.data?.generatedAt)) && r.body?.data?.siteName === SITE,
      `version=${r.body?.data?.version}, generatedAt=${r.body?.data?.generatedAt}, siteName=${r.body?.data?.siteName}`);

    // === Test 3: sürüm yalnızca liste değişince değişir ===
    const again = await hwGet('/telemetry/rfid-whitelist');
    await db.query('UPDATE vehicles SET status = $2 WHERE id = $1', ['veh-1', 'BAKIMDA']);
    const changed = await hwGet('/telemetry/rfid-whitelist');
    await db.query('UPDATE vehicles SET status = $2 WHERE id = $1', ['veh-1', 'AKTİF']);
    const changedCards = (changed.body?.data?.entries ?? []).map((e: any) => e.cardUid);
    check('Test 3: Sürüm aynı listede sabit; araç bakıma alınınca kart düşer ve sürüm değişir',
      again.body?.data?.version === r.body?.data?.version && !changedCards.includes('CARD-881201') &&
        changed.body?.data?.version !== r.body?.data?.version,
      `v1=${r.body?.data?.version}, v2=${again.body?.data?.version}, bakımda=${changed.body?.data?.version} [${changedCards.join(',')}]`);

    // === Test 3b: sayfalama — cihaz tamponu küçük; sayfalar birleşince tam liste, sürüm her sayfada aynı ===
    const p1 = await hwGet('/telemetry/rfid-whitelist?limit=1');
    const p2 = await hwGet(`/telemetry/rfid-whitelist?limit=1&after=${encodeURIComponent(p1.body?.data?.nextCursor ?? '')}`);
    const pageCards = [...(p1.body?.data?.entries ?? []), ...(p2.body?.data?.entries ?? [])].map((e: any) => e.cardUid);
    check('Test 3b: Sayfalama (limit/after) tam listeyi verir; son sayfada nextCursor null; sürüm ve toplam her sayfada aynı',
      p1.body?.data?.entries?.length === 1 && p1.body?.data?.nextCursor === 'CARD-881201' &&
        p2.body?.data?.nextCursor === null && pageCards.join(',') === 'CARD-881201,CARD-881204' &&
        p1.body?.data?.version === r.body?.data?.version && p2.body?.data?.version === r.body?.data?.version &&
        p1.body?.data?.totalCount === 2 && p2.body?.data?.totalCount === 2,
      `sayfa1=${JSON.stringify(p1.body?.data?.entries?.map((e: any) => e.cardUid))} next=${p1.body?.data?.nextCursor}, ` +
        `sayfa2=${JSON.stringify(p2.body?.data?.entries?.map((e: any) => e.cardUid))} next=${p2.body?.data?.nextCursor}`);

    // === Test 4: çapraz şantiye modülü kapalıysa çapraz izinli kart da düşer (çevrimiçi MODULE_DISABLED ile aynı) ===
    await db.query(`UPDATE companies SET modules = modules || '{"crossSiteAuth": false}'::jsonb WHERE id = 'comp-camsa'`);
    const noCross = await hwGet('/telemetry/rfid-whitelist');
    const noCrossCards = (noCross.body?.data?.entries ?? []).map((e: any) => e.cardUid);
    check('Test 4: crossSiteAuth modülü kapalıyken çapraz şantiye kartı listede YOK, yerel kart duruyor',
      noCross.status === 200 && !noCrossCards.includes('CARD-881204') && noCrossCards.includes('CARD-881201'),
      `kartlar=${noCrossCards.join(',')}`);
  } finally {
    await db.query(`UPDATE companies SET modules = $1 WHERE id = 'comp-camsa'`, [modulesBefore]);
    await db.query('DELETE FROM cross_site_permissions WHERE id = $1', [PERM_ID]);
    await db.query('DELETE FROM rfid_card_blacklist WHERE id = $1', [BL_ID]);
    await redis.del('rfid:denylist:comp-camsa').catch(() => undefined);
    for (const [id] of assign) await db.query('UPDATE vehicles SET assigned_driver_name = NULL WHERE id = $1', [id]);
    await db.query(`UPDATE vehicles SET status = 'AKTİF' WHERE id = 'veh-1'`);
    redis.disconnect();
    await db.end();
  }

  console.log('===========================================================');
  console.log(`📊 TEST SONUÇLARI: ${passed} / ${total} TEST BAŞARILI`);
  console.log('===========================================================');
  if (passed !== total) process.exit(1);
}

run().catch((err) => {
  console.error('💥 Test çalıştırılamadı:', err);
  process.exit(1);
});
