import crypto from 'crypto';
import { Client } from 'pg';
import Redis from 'ioredis';

/**
 * FUEL-402.2 — Redlock + rezervasyon ile çapraz şantiye kotasının RFID/
 * donanım-tetiklemeli otomatik ikmal yolunda (authorizeDispenseRequest →
 * dispenseSessionService.createSession) eşzamanlı aşılmadığını doğrular.
 *
 * test_race_tenant_lifecycle_and_quota.ts'in Test 7/8'i AYNI AC'yi zaten
 * `POST /dispense` (MANUEL/operatör yolu, createTransaction) için doğruluyor
 * — o yol zaten Postgres `FOR UPDATE` ile korunuyordu. Bu dosya farklı,
 * o zamana kadar HİÇ korunmayan bir yolu (RFID-tetiklemeli /dispense/
 * request-auth) hedefler: bakiye okuma (Postgres) ile rezervasyon (Redis
 * oturumu) arasındaki boşluk, kotayı ikinci bir SİSTEM (Redis) üzerinden
 * aşabiliyordu — FOR UPDATE bunu KAPATAMAZ, çünkü rezervasyon hiç DB
 * transaction'ının içinde değil.
 *
 * Kurulum: 100 L kotalı bir çapraz şantiye izni; aracın kendi depo
 * kapasitesi (fuel_capacity_liters) BİLEREK 20 L'ye sabitlenmiş — böylece
 * TAM OLARAK 5 eşzamanlı yetkilendirme (5×20=100) kotayı tam doldurmalı,
 * 8 eşzamanlı istekten kalan 3'ü QUOTA_EXHAUSTED almalı. Her istek FARKLI
 * bir donanım cihazından (claim akışıyla üretilmiş, gerçek HMAC secret'lı)
 * gelir — dispenseSessionService'in "aynı pompada eşzamanlı ikinci oturum"
 * kısıtı BAŞKA bir şeyi test ettiğinden burada devre dışı kalmalı.
 */

const API_URL = 'http://localhost:5000/api/v1';
const RUN = Date.now();
const N_DEVICES = 8;
const QUOTA_LITERS = 100;
const VEHICLE_CAPACITY_LITERS = 20; // her başarılı yetkilendirme TAM OLARAK bunu rezerve eder

function pg(): Client {
  return new Client({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database: process.env.POSTGRES_DB || 'yakittakip_db'
  });
}
async function q(sql: string, params: any[] = []): Promise<any[]> {
  const c = pg();
  await c.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}

async function call(method: string, path: string, token: string | undefined, body?: unknown): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function login(username: string): Promise<string> {
  const redis = new Redis({ host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379', 10) });
  const keys = await redis.keys('rl:auth-login:*');
  if (keys.length > 0) await redis.del(...keys);
  redis.disconnect();
  const res = await call('POST', '/auth/login', undefined, { username, password: '123456' });
  if (!res.body.accessToken) throw new Error(`'${username}' girişi başarısız: ${JSON.stringify(res.body)}`);
  return res.body.accessToken;
}

function sign(secret: string, timestamp: string, nonce: string, rawBody: string): string {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${nonce}.${rawBody}`).digest('hex');
}

async function hwPost(deviceId: string, secret: string, path: string, body: object): Promise<{ status: number; body: any }> {
  const rawBody = JSON.stringify(body);
  const timestamp = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Device-ID': deviceId,
      'X-Timestamp': timestamp,
      'X-Nonce': nonce,
      'X-Hardware-Signature': sign(secret, timestamp, nonce, rawBody)
    },
    body: rawBody
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function run() {
  console.log('===========================================================');
  console.log('🔒 [FUEL-402.2] REDLOCK — ÇAPRAZ ŞANTİYE KOTASI EŞZAMANLILIK TESTİ');
  console.log('===========================================================\n');

  let passed = 0;
  let total = 0;
  const check = (name: string, condition: boolean, detail: string) => {
    total++;
    if (condition) {
      console.log(`✅ [PASS] ${name}\n   ${detail}\n`);
      passed++;
    } else {
      console.log(`❌ [FAIL] ${name}\n   ${detail}\n`);
    }
  };

  const plate = `34 QL ${String(RUN).slice(-3)}`;
  const homeSite = 'Gebze Ana Şantiye';
  const targetSite = `RaceTarget-${RUN}`;
  const tankName = `RaceTank-${RUN}`;
  const cardId = `RACE-CARD-${RUN}`;
  const driverName = `Yarış Sürücüsü ${RUN}`;
  const permId = `csp-fuel402-2-${RUN}`;
  const deviceIds: string[] = [];

  const owner = await login('camsa');

  try {
    // --- Ön koşul: araç (home site'ta, KÜÇÜK depo kapasitesiyle), sürücü, tank, izin ---
    await q(
      `INSERT INTO vehicles (id, tenant_id, plate, brand_model, vehicle_type, rfid_tag, site_name, status, fuel_capacity_liters, assigned_driver_name)
       VALUES ($1, 'comp-camsa', $2, 'Test', 'Kamyon', $3, $4, 'AKTİF', $5, $6)`,
      [`veh-fuel402-2-${RUN}`, plate, `RFID-FUEL402-2-${RUN}`, homeSite, VEHICLE_CAPACITY_LITERS, driverName]
    );
    await q(
      `INSERT INTO drivers (id, tenant_id, name, tc_no, rfid_card_id, site_name, status)
       VALUES ($1, 'comp-camsa', $2, '12345678950', $3, $4, 'AKTİF')`,
      [`drv-fuel402-2-${RUN}`, driverName, cardId, homeSite]
    );
    await q(
      `INSERT INTO tanks (id, tenant_id, name, site_name, capacity_liters, current_level_liters, fuel_type)
       VALUES ($1, 'comp-camsa', $2, $3, 10000, 5000, 'Motorin')`,
      [`tank-fuel402-2-${RUN}`, tankName, targetSite]
    );
    await q(
      `INSERT INTO cross_site_permissions (id, tenant_id, vehicle_plate, home_site, target_site, allowed_liters, used_liters, status, expiry_date)
       VALUES ($1, 'comp-camsa', $2, $3, $4, $5, 0, 'AKTİF', CURRENT_DATE + 7)`,
      [permId, plate, homeSite, targetSite, QUOTA_LITERS]
    );

    // --- N_DEVICES bağımsız donanım (her biri claim akışıyla GERÇEK bir
    // HMAC secret'ı alır) — targetSite'ta, hepsi AYNI vehicle+targetSite
    // çapraz şantiye kotasını hedefleyecek. ---
    const devices: { deviceId: string; secret: string }[] = [];
    for (let i = 0; i < N_DEVICES; i++) {
      const deviceName = `FUEL402-2-Pump-${RUN}-${i}`;
      const created = await call('POST', '/devices/claim-codes', owner, { siteName: targetSite, deviceName });
      const code = created.body?.data?.code;
      if (!code) throw new Error(`Ön koşul: claim kodu üretilemedi (${i}): ${JSON.stringify(created.body)}`);
      const deviceId = `FUEL402-2-DEV-${RUN}-${i}`;
      const claimed = await call('POST', '/devices/claim', undefined, { code, deviceId });
      const secret = claimed.body?.data?.secret;
      if (!secret) throw new Error(`Ön koşul: cihaz claim edilemedi (${i}): ${JSON.stringify(claimed.body)}`);
      devices.push({ deviceId, secret });
      deviceIds.push(deviceId);
    }

    // === Test 1: N_DEVICES eşzamanlı /dispense/request-auth, AYNI kota ===
    const results = await Promise.all(
      devices.map((d) => hwPost(d.deviceId, d.secret, '/dispense/request-auth', { rfidCardId: cardId, tankName }))
    );
    const oks = results.filter((r) => r.status === 200);
    const exhausted = results.filter((r) => r.status === 409 && r.body?.details?.error === 'QUOTA_EXHAUSTED');
    const grantedTotal = oks.reduce((sum, r) => sum + Number(r.body?.data?.maxAllowedLiters || 0), 0);
    const expectedOks = Math.floor(QUOTA_LITERS / VEHICLE_CAPACITY_LITERS);

    check(
      `Test 1: ${N_DEVICES} eşzamanlı yetkilendirmede TAM OLARAK ${expectedOks} kabul (${expectedOks}×${VEHICLE_CAPACITY_LITERS}=${QUOTA_LITERS})`,
      oks.length === expectedOks,
      `kabul=${oks.length}, durumlar=[${results.map((r) => r.status).join(', ')}]`
    );
    check(
      'Test 2: Kalanlar QUOTA_EXHAUSTED ile reddedildi',
      exhausted.length === N_DEVICES - expectedOks,
      `reddedilen=${exhausted.length}, beklenen=${N_DEVICES - expectedOks}`
    );
    check(
      `Test 3 (ASIL AC — "kota hiçbir koşulda aşılmamalı"): rezerve edilen toplam (${grantedTotal} L) kotayı (${QUOTA_LITERS} L) AŞMADI`,
      grantedTotal <= QUOTA_LITERS,
      `grantedTotal=${grantedTotal}`
    );

    // === Test 4: her kabul FARKLI bir oturum (deviceId) yarattı — mükerrer/hayalet rezervasyon yok ===
    check(
      'Test 4: Başarılı yanıt sayısı ile oluşturulan benzersiz sessionId sayısı birebir',
      new Set(oks.map((r) => r.body?.data?.sessionId).filter(Boolean)).size === oks.length,
      `benzersiz sessionId=${new Set(oks.map((r) => r.body?.data?.sessionId)).size}, kabul=${oks.length}`
    );

    // === Test 5 (REP-715 — reddedilen denemelerin KALICI izi, cihaz yolu): reddedilen her
    // istek cross_site_denials'a source=DEVICE / QUOTA_EXHAUSTED olarak yazıldı (kabul
    // edilenler YAZILMADI); ret yanıtları yukarıda zaten 409 — kayıt davranışı değiştirmedi. ===
    const denials = await q('SELECT reason, source, target_site, allowed_liters FROM cross_site_denials WHERE vehicle_plate = $1', [plate]);
    check(
      `Test 5 (REP-715 — ret izi): ${N_DEVICES - expectedOks} reddedilen cihaz isteği cross_site_denials'a QUOTA_EXHAUSTED/DEVICE olarak yazıldı, kabul edilenler yazılmadı`,
      denials.length === N_DEVICES - expectedOks && denials.every((d) => d.reason === 'QUOTA_EXHAUSTED' && d.source === 'DEVICE' && d.target_site === targetSite && Number(d.allowed_liters) === QUOTA_LITERS),
      `kayıt=${denials.length}, beklenen=${N_DEVICES - expectedOks}`
    );
  } finally {
    await q('DELETE FROM cross_site_denials WHERE vehicle_plate = $1', [plate]);
    await q('DELETE FROM cross_site_permissions WHERE id = $1', [permId]);
    await q('DELETE FROM tanks WHERE name = $1', [tankName]);
    await q('DELETE FROM vehicles WHERE plate = $1', [plate]);
    await q('DELETE FROM drivers WHERE rfid_card_id = $1', [cardId]);
    if (deviceIds.length > 0) {
      await q('DELETE FROM hardware_devices WHERE device_id = ANY($1)', [deviceIds]);
    }
    await q(`DELETE FROM device_claim_codes WHERE device_name LIKE $1`, [`FUEL402-2-Pump-${RUN}-%`]);
    const redis = new Redis({ host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379', 10) });
    if (deviceIds.length > 0) await redis.del(...deviceIds.map((id) => `dispense:session:${id}`));
    redis.disconnect();
    console.log('🧹 Test fixture verisi temizlendi.\n');
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  if (passed !== total) process.exit(1);
}

run().catch((err) => {
  console.error('🔥 Test çalıştırılırken beklenmeyen hata:', err);
  process.exit(1);
});
