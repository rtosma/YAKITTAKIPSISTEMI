import crypto from 'crypto';
import Redis from 'ioredis';
import { Client } from 'pg';

/**
 * AUTH-202.3 — Cihaz secret üretimi, saklanması ve rotasyonu.
 *
 * Kapsanan AC'ler: her cihazın benzersiz secret'ı olmalı ve düz metin
 * saklanmamalı (provisioning yanıtındaki secret'ın DB'de şifreli olduğu ayrı
 * bir Postgres sorgusuyla doğrulanır), rotasyon sırasında saha kesintisi
 * yaşanmamalı (eski+yeni secret birlikte geçerli), bloke edilen cihaz anında
 * reddedilmeli. Ayrıca: cross-tenant izolasyon (RLS) ve deviceId çakışması.
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

function signHmacRequest(deviceId: string, secret: string, body: object) {
  const rawBody = JSON.stringify(body);
  const timestamp = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${nonce}.${rawBody}`).digest('hex');
  return {
    headers: {
      'Content-Type': 'application/json',
      'X-Device-ID': deviceId,
      'X-Timestamp': timestamp,
      'X-Nonce': nonce,
      'X-Hardware-Signature': signature
    },
    rawBody
  };
}

async function hwCall(deviceId: string, secret: string, body: object = { ping: true }): Promise<{ status: number; body: any }> {
  const { headers, rawBody } = signHmacRequest(deviceId, secret, body);
  const res = await fetch(`${API_URL}/telemetry/hardware-data`, { method: 'POST', headers, body: rawBody });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, body: data };
}

async function run() {
  console.log('===========================================================');
  console.log('🔐 [AUTH-202.3] CİHAZ SECRET ÜRETİMİ, ROTASYONU, BLOKE TESTİ');
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
  const kusakToken = await login('kusak');
  const deviceId = `TEST-DEVICE-${Date.now()}`;

  try {
    // === Test 1: Provisioning — yeni cihaz, secret tek seferlik döner ===
    const create = await call('POST', '/hardware-devices', {
      token: camsaToken,
      body: { deviceId, name: 'Test Cihazı', siteName: 'Gebze Ana Şantiye' }
    });
    const secret: string = create.body?.data?.secret;
    check(
      'Test 1: Provisioning başarılı, 256-bit (64 hex karakter) secret tek seferlik döner',
      create.status === 200 && typeof secret === 'string' && /^[0-9a-f]{64}$/.test(secret),
      `status=${create.status}, secret uzunluk=${secret?.length}, body=${JSON.stringify(create.body)}`
    );

    // === Test 2: Aynı deviceId ile tekrar provisioning → DEVICE_ID_TAKEN ===
    const dup = await call('POST', '/hardware-devices', {
      token: camsaToken,
      body: { deviceId, name: 'Tekrar', siteName: 'Gebze Ana Şantiye' }
    });
    check(
      'Test 2: Aynı deviceId ile tekrar provisioning reddedilir (DEVICE_ID_TAKEN)',
      dup.status === 409 && dup.body?.details?.error === 'DEVICE_ID_TAKEN',
      `status=${dup.status}, body=${JSON.stringify(dup.body)}`
    );

    // === Test 3: GET /hardware-devices listede secret YOK ===
    const list = await call('GET', '/hardware-devices', { token: camsaToken });
    const listed = list.body?.data?.find((d: any) => d.device_id === deviceId);
    check(
      'Test 3: Cihaz listesinde secret/encrypted_secret alanı hiç yok',
      list.status === 200 && !!listed && listed.secret === undefined && listed.encrypted_secret === undefined,
      `status=${list.status}, listed=${JSON.stringify(listed)}`
    );

    // === Test 4: Üretilen secret ile gerçek bir HMAC isteği kabul edilir ===
    const firstAuth = await hwCall(deviceId, secret);
    check(
      'Test 4: Provisioning ile üretilen secret gerçek bir HMAC isteğini doğrular',
      firstAuth.status === 200 && firstAuth.body?.success === true,
      `status=${firstAuth.status}, body=${JSON.stringify(firstAuth.body)}`
    );

    // === Test 5: Başka bir tenant (kusak), camsa'nın cihazını rotate/block edemez (RLS → 404) ===
    const crossTenantRotate = await call('POST', `/hardware-devices/${deviceId}/rotate-secret`, { token: kusakToken });
    check(
      "Test 5: Farklı tenant'ın (kusak) cihazı bulunamaz (RLS izolasyonu, DEVICE_NOT_FOUND)",
      crossTenantRotate.status === 404 && crossTenantRotate.body?.details?.error === 'DEVICE_NOT_FOUND',
      `status=${crossTenantRotate.status}, body=${JSON.stringify(crossTenantRotate.body)}`
    );

    // === Test 6: Rotasyon — yeni secret üretilir ===
    const rotate = await call('POST', `/hardware-devices/${deviceId}/rotate-secret`, { token: camsaToken });
    const newSecret: string = rotate.body?.data?.secret;
    check(
      'Test 6: Rotasyon başarılı, YENİ bir secret üretildi (eskisinden farklı)',
      rotate.status === 200 && typeof newSecret === 'string' && newSecret !== secret,
      `status=${rotate.status}, eskiSecret=${secret?.slice(0, 8)}..., yeniSecret=${newSecret?.slice(0, 8)}...`
    );

    // === Test 7: Rotasyon sonrası ESKİ secret HÂLÂ kabul edilir (24sn geçiş penceresi) ===
    const oldStillWorks = await hwCall(deviceId, secret);
    check(
      'Test 7: Rotasyon sonrası ESKİ secret hâlâ kabul edilir (AC: saha kesintisi yaşanmamalı)',
      oldStillWorks.status === 200,
      `status=${oldStillWorks.status}, body=${JSON.stringify(oldStillWorks.body)}`
    );

    // === Test 8: Rotasyon sonrası YENİ secret de kabul edilir ===
    const newWorks = await hwCall(deviceId, newSecret);
    check(
      'Test 8: Rotasyon sonrası YENİ secret de kabul edilir',
      newWorks.status === 200,
      `status=${newWorks.status}, body=${JSON.stringify(newWorks.body)}`
    );

    // === Test 9: Bloke etme — sonrasında GEÇERLİ secret bile reddedilir ===
    const block = await call('POST', `/hardware-devices/${deviceId}/block`, { token: camsaToken });
    const blockedAttempt = await hwCall(deviceId, newSecret);
    check(
      'Test 9: Bloke edilen cihaz, doğru secret ile bile anında reddedilir (403 DEVICE_BLOCKED)',
      block.status === 200 && blockedAttempt.status === 403 && blockedAttempt.body?.error === 'DEVICE_BLOCKED',
      `block.status=${block.status}, sonraki istek status=${blockedAttempt.status}, body=${JSON.stringify(blockedAttempt.body)}`
    );

    // === Test 10: Bloku kaldırma — cihaz tekrar çalışır ===
    const unblock = await call('POST', `/hardware-devices/${deviceId}/unblock`, { token: camsaToken });
    const afterUnblock = await hwCall(deviceId, newSecret);
    check(
      'Test 10: Bloku kaldırılan cihaz tekrar kabul edilir',
      unblock.status === 200 && afterUnblock.status === 200,
      `unblock.status=${unblock.status}, sonraki istek status=${afterUnblock.status}`
    );

    // === Test 11: DB satırında secret DÜZ METİN olarak yok (AC: "düz metin
    // olarak hiçbir yerde saklanmamalıdır") ===
    const db = new Client({
      host: process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      user: process.env.POSTGRES_USER || 'postgres',
      password: process.env.POSTGRES_PASSWORD || 'postgres',
      database: process.env.POSTGRES_DB || 'yakittakip_db'
    });
    await db.connect();
    const row = await db.query('SELECT encrypted_secret, encrypted_secret_previous FROM hardware_devices WHERE device_id = $1', [deviceId]);
    await db.end();
    const encryptedCurrent: string = row.rows[0]?.encrypted_secret ?? '';
    check(
      'Test 11: DB\'deki encrypted_secret ne eski ne yeni plaintext secret\'a eşit (gerçekten şifreli)',
      encryptedCurrent.length > 0 && encryptedCurrent !== secret && encryptedCurrent !== newSecret && !encryptedCurrent.includes(newSecret),
      `encrypted_secret uzunluk=${encryptedCurrent.length} (base64, plaintext hex 64 karakter olurdu)`
    );
  } finally {
    // Temizlik: test cihazını kalıcı olarak bloke bırakmayalım (unblock zaten
    // yapıldı), silme endpoint'i yok — deviceId benzersiz (Date.now()) olduğu
    // için sonraki koşularla çakışmaz.
    redis.disconnect();
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
