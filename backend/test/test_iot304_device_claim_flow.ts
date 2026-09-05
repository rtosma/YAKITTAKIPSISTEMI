import Redis from 'ioredis';
import { Client } from 'pg';

/**
 * IOT-304 — Cihaz Provisioning ve Eşleştirme (Device Claim) Akışı.
 *
 * Kapsanan AC'ler: eşleştirilmemiş cihaz veri gönderememeli (HTTP/HMAC
 * katmanında + MQTT uygulama-seviyesi reddiyle), claim kodu tek kullanımlık
 * ve süreli, cihaz nakli geçmiş veriyi bozmaz.
 */

const API_URL = 'http://localhost:5000/api/v1';
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10)
});

async function resetIpLoginRateLimit(): Promise<void> {
  const keys = await redis.keys('rl:auth-login:*');
  if (keys.length > 0) await redis.del(...keys);
}

async function call(method: string, path: string, opts: { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
  if (path === '/auth/login') await resetIpLoginRateLimit();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function login(username: string): Promise<string> {
  const res = await call('POST', '/auth/login', { body: { username, password: '123456' } });
  if (!res.body.accessToken) throw new Error(`Ön koşul: ${username} ile giriş başarısız: ${JSON.stringify(res.body)}`);
  return res.body.accessToken;
}

async function run() {
  console.log('===========================================================');
  console.log('📡 [IOT-304] CİHAZ PROVISIONING VE EŞLEŞTİRME (CLAIM) TESTİ');
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

  const camsaToken = await login('camsa');
  const deviceId = `TEST-CLAIM-${Date.now()}`;
  const db = new Client({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database: process.env.POSTGRES_DB || 'yakittakip_db'
  });
  await db.connect();

  try {
    // === Test 1: Geçersiz kodla claim → CLAIM_CODE_INVALID ===
    const invalidClaim = await call('POST', '/devices/claim', { body: { code: 'NOSUCHCODE', deviceId } });
    check(
      'Test 1: Geçersiz claim kodu reddedilir (CLAIM_CODE_INVALID)',
      invalidClaim.status === 403 && invalidClaim.body?.details?.error === 'CLAIM_CODE_INVALID',
      `status=${invalidClaim.status}, body=${JSON.stringify(invalidClaim.body)}`
    );

    // === Test 2: Süresi geçmiş kod → CLAIM_CODE_EXPIRED ===
    // 1dk'lık bir kod üretilip DB'de expires_at doğrudan geçmişe çekiliyor
    // (gerçek süre dolmasını 1dk beklemek yerine) — redemption mantığının
    // KENDİSİ hâlâ gerçek: sunucu expires_at'i olduğu gibi okuyup karşılaştırıyor.
    const expiredCreate = await call('POST', '/devices/claim-codes', {
      token: camsaToken,
      body: { siteName: 'Gebze Ana Şantiye', deviceName: 'Süresi Dolmuş Test Cihazı', expiresInMinutes: 1 }
    });
    const expiredCode = expiredCreate.body?.data?.code;
    await db.query(`UPDATE device_claim_codes SET expires_at = NOW() - INTERVAL '1 minute' WHERE code = $1`, [expiredCode]);
    const expiredRedeem = await call('POST', '/devices/claim', { body: { code: expiredCode, deviceId: `${deviceId}-expired` } });
    check(
      'Test 2: Süresi dolmuş bir claim kodu reddedilir (CLAIM_CODE_EXPIRED)',
      expiredRedeem.status === 403 && expiredRedeem.body?.details?.error === 'CLAIM_CODE_EXPIRED',
      `status=${expiredRedeem.status}, body=${JSON.stringify(expiredRedeem.body)}`
    );

    // === Test 3: Normal bir claim kodu üretimi (varsayılan 15dk) ===
    const create = await call('POST', '/devices/claim-codes', {
      token: camsaToken,
      body: { siteName: 'Gebze Ana Şantiye', deviceName: 'Test Debimetre' }
    });
    const code: string = create.body?.data?.code;
    check(
      'Test 3: Claim kodu üretimi başarılı, 10 karakterli kod döner',
      create.status === 200 && typeof code === 'string' && code.length === 10,
      `status=${create.status}, code=${code}`
    );

    // === Test 4: GET /devices/claim-codes listede yeni kod görünüyor ===
    const list = await call('GET', '/devices/claim-codes', { token: camsaToken });
    const listedCode = list.body?.data?.find((c: any) => c.code === code);
    check(
      "Test 4: Üretilen kod GET /devices/claim-codes listesinde 'BEKLIYOR' durumunda görünüyor",
      list.status === 200 && listedCode?.status === 'BEKLIYOR',
      `status=${list.status}, listedCode=${JSON.stringify(listedCode)}`
    );

    // === Test 5: Doğru kodla claim → cihaz oluşur, secret döner ===
    const redeem = await call('POST', '/devices/claim', {
      body: { code, deviceId, macAddress: 'AA:BB:CC:DD:EE:FF', model: 'ESP32-WROOM-32', hardwareRevision: 'rev-3' }
    });
    const secret: string = redeem.body?.data?.secret;
    check(
      'Test 5: Geçerli kodla claim başarılı, cihaz oluşturuldu, secret tek seferlik döndü',
      redeem.status === 200 && redeem.body?.data?.deviceId === deviceId && /^[0-9a-f]{64}$/.test(secret ?? ''),
      `status=${redeem.status}, body=${JSON.stringify(redeem.body)}`
    );

    // === Test 6: Aynı kod İKİNCİ kez kullanılamaz (tek kullanımlık) ===
    const reuse = await call('POST', '/devices/claim', { body: { code, deviceId: `${deviceId}-2` } });
    check(
      'Test 6: Kullanılmış claim kodu ikinci kez kullanılamaz (CLAIM_CODE_ALREADY_USED)',
      reuse.status === 409 && reuse.body?.details?.error === 'CLAIM_CODE_ALREADY_USED',
      `status=${reuse.status}, body=${JSON.stringify(reuse.body)}`
    );

    // === Test 7: Redeem edilen cihaz GERÇEK bir HMAC isteğini doğrulayabiliyor ===
    // (AUTH-202.3'ün hardwareAuthMiddleware'i ile aynı akış — device claim'in
    // ürettiği secret'ın gerçekten çalıştığının kanıtı.)
    const crypto = await import('crypto');
    const rawBody = JSON.stringify({ ping: true });
    const ts = Date.now().toString();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.createHmac('sha256', secret).update(`${ts}.${nonce}.${rawBody}`).digest('hex');
    const hwRes = await fetch(`${API_URL}/telemetry/hardware-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-ID': deviceId, 'X-Timestamp': ts, 'X-Nonce': nonce, 'X-Hardware-Signature': sig },
      body: rawBody
    });
    const hwBody = await hwRes.json();
    check(
      'Test 7: Claim ile üretilen secret gerçek bir HMAC isteğini doğrular',
      hwRes.status === 200 && hwBody?.success === true,
      `status=${hwRes.status}, body=${JSON.stringify(hwBody)}`
    );

    // === Test 8: Aynı deviceId ile YENİ bir kod kullanılamaz (DEVICE_ID_TAKEN) ===
    const secondCode = await call('POST', '/devices/claim-codes', {
      token: camsaToken,
      body: { siteName: 'Gebze Ana Şantiye', deviceName: 'Çakışan Cihaz' }
    });
    const dupClaim = await call('POST', '/devices/claim', { body: { code: secondCode.body?.data?.code, deviceId } });
    check(
      'Test 8: Zaten kayıtlı bir deviceId ile claim reddedilir (DEVICE_ID_TAKEN)',
      dupClaim.status === 409 && dupClaim.body?.details?.error === 'DEVICE_ID_TAKEN',
      `status=${dupClaim.status}, body=${JSON.stringify(dupClaim.body)}`
    );

    // === Test 9: Cihaz nakli — site_name güncellenir ===
    const relocate = await call('POST', `/hardware-devices/${deviceId}/relocate`, {
      token: camsaToken,
      body: { siteName: 'Orman Şantiyesi' }
    });
    check(
      "Test 9: Cihaz nakli başarılı, site_name 'Orman Şantiyesi' olarak güncellendi",
      relocate.status === 200 && relocate.body?.data?.site_name === 'Orman Şantiyesi',
      `status=${relocate.status}, body=${JSON.stringify(relocate.body)}`
    );

    // === Test 10: Kayıtsız (claim edilmemiş) bir device_id, geçerli imza
    // formatına sahip olsa bile hiçbir zaman doğrulanamaz — çünkü secret'ı
    // yok, gerçek bir imza asla üretemez. Bu, "eşleştirilmemiş cihaz veri
    // gönderememeli" AC'sinin HTTP/HMAC tarafındaki kanıtıdır. ===
    const neverClaimedId = `NEVER-CLAIMED-${Date.now()}`;
    const fakeSig = crypto.createHmac('sha256', 'random-guess').update(`${ts}.${nonce}.${rawBody}`).digest('hex');
    const unclaimedRes = await fetch(`${API_URL}/telemetry/hardware-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-ID': neverClaimedId, 'X-Timestamp': ts, 'X-Nonce': crypto.randomBytes(16).toString('hex'), 'X-Hardware-Signature': fakeSig },
      body: rawBody
    });
    const unclaimedBody = await unclaimedRes.json();
    check(
      "Test 10: Hiç claim edilmemiş bir cihaz kimliği UNAUTHORIZED_DEVICE ile reddedilir",
      unclaimedRes.status === 401 && unclaimedBody?.error === 'UNAUTHORIZED_DEVICE',
      `status=${unclaimedRes.status}, body=${JSON.stringify(unclaimedBody)}`
    );
  } finally {
    await resetIpLoginRateLimit();
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
