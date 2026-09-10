import Redis from 'ioredis';
import { Client } from 'pg';
import { requestPasswordReset } from '../src/services/passwordResetService';

/**
 * AUTH-206 — şifremi unuttum / şifre sıfırlama akışı.
 *
 * Not: çalışan backend NODE_ENV=production (docker-compose) olduğundan
 * forgot-password yanıtı `devResetToken` DÖNDÜRMEZ (sızıntı koruması). Gerçek
 * token'ı almak için `requestPasswordReset` doğrudan import edilip çağrılır
 * (test_ai502/test_comp601 ile aynı desen); geri kalan her şey (reset,
 * login eski/yeni, refresh iptali, tek kullanımlık, rate limit, Zod) canlı
 * HTTP ile doğrulanır.
 *
 * Kobay kullanıcı: orman-santiye (SITE_MANAGER). Test SONUNDA parola hash'i
 * seed değerine (finally) geri yazılır ki diğer testler '123456' ile giriş
 * yapmaya devam edebilsin.
 */

const API_URL = 'http://localhost:5000/api/v1';
const USER = 'orman-santiye';
const NEW_PW = 'YeniGucluSifre_2026';
// '123456' düz metninin seed'deki Argon2id hash'i (seed_mock_data.sql).
const SEED_HASH_123456 = '$argon2id$v=19$m=65536,p=1,t=3$08Vstd8iW8mXbMgeAz8jbA$zca8rRtma2jMjEfCh9tonOGuV3lnBq3DMN6bUHCw+BU';

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

async function clearRateLimits(): Promise<void> {
  const patterns = ['rl:auth-login:*', 'rl:pwreset-min:*', 'rl:pwreset-hour:*', 'rl:pwreset-submit:*'];
  for (const p of patterns) {
    const keys = await redis.keys(p);
    if (keys.length) await redis.del(...keys);
  }
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function login(username: string, password: string): Promise<{ status: number; body: any }> {
  await clearRateLimits();
  return call('POST', '/auth/login', { username, password });
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [AUTH-206] ŞİFRE SIFIRLAMA AKIŞI TESTİ');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => {
    total++;
    if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; }
    else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); }
  };

  const GENERIC_MSG = 'Eğer bu kullanıcı adı sistemde kayıtlıysa, şifre sıfırlama talimatları ilgili kanaldan iletilmiştir.';

  try {
    // Test 1: forgot-password — var olan kullanıcı → 200 + jenerik mesaj
    await clearRateLimits();
    const r1 = await call('POST', '/auth/forgot-password', { username: USER });
    check('Test 1: forgot-password (var olan kullanıcı) → 200 + jenerik mesaj',
      r1.status === 200 && r1.body.message === GENERIC_MSG && r1.body.devResetToken === undefined,
      `status=${r1.status}, msg eşleşiyor=${r1.body.message === GENERIC_MSG}, devToken sızmadı=${r1.body.devResetToken === undefined}`);

    // Test 2: forgot-password — VAR OLMAYAN kullanıcı → AYNI yanıt (AC 2)
    await clearRateLimits();
    const r2 = await call('POST', '/auth/forgot-password', { username: `hayalet-kullanici-${Date.now()}` });
    check('Test 2: forgot-password (var olmayan kullanıcı) → AYNI 200 + jenerik mesaj (enumeration koruması)',
      r2.status === 200 && r2.body.message === GENERIC_MSG && r2.body.devResetToken === undefined,
      `status=${r2.status}, msg=${JSON.stringify(r2.body.message)}`);

    // --- Sıfırlama öncesi bir oturum aç (AC 3 doğrulaması için) ---
    const preLogin = await login(USER, '123456');
    const refreshToken: string | undefined = preLogin.body.refreshToken;
    check('Ön koşul: eski parolayla giriş + refreshToken alındı', preLogin.status === 200 && !!refreshToken, `status=${preLogin.status}`);

    // --- Gerçek token'ı doğrudan servisten al (prod modda yanıtta dönmüyor) ---
    await clearRateLimits();
    const token = await requestPasswordReset(USER);
    check('Ön koşul: requestPasswordReset 64-hex token üretti', !!token && /^[0-9a-f]{64}$/.test(token || ''), `token uzunluk=${token?.length}`);

    // Test 3: reset-password — geçerli token + yeni parola → 200
    const r3 = await call('POST', '/auth/reset-password', { token, newPassword: NEW_PW });
    check('Test 3: reset-password geçerli token → 200', r3.status === 200 && r3.body.success === true, `status=${r3.status}, body=${JSON.stringify(r3.body)}`);

    // Test 4: AYNI token tekrar → 400 (TEK KULLANIMLIK — AC 1)
    const r4 = await call('POST', '/auth/reset-password', { token, newPassword: 'BaskaBirSifre_9' });
    check('Test 4: aynı token ikinci kez → 400 (tek kullanımlık)', r4.status === 400, `status=${r4.status}, msg=${r4.body.message}`);

    // Test 5: eski parolayla giriş artık BAŞARISIZ
    const r5 = await login(USER, '123456');
    check('Test 5: eski parolayla giriş 401', r5.status === 401, `status=${r5.status}`);

    // Test 6: yeni parolayla giriş BAŞARILI
    const r6 = await login(USER, NEW_PW);
    check('Test 6: yeni parolayla giriş 200', r6.status === 200 && !!r6.body.accessToken, `status=${r6.status}`);

    // Test 7: sıfırlama öncesi alınan refreshToken artık GEÇERSİZ (AC 3 — tüm oturumlar iptal)
    const r7 = await call('POST', '/auth/refresh', { refreshToken });
    check('Test 7: sıfırlama öncesi oturum (refreshToken) iptal edildi → 401', r7.status === 401, `status=${r7.status}, err=${r7.body.error}`);

    // Test 8: geçersiz/uydurma token → jenerik 400 (sızıntı yok)
    const r8 = await call('POST', '/auth/reset-password', { token: 'a'.repeat(64), newPassword: NEW_PW });
    check('Test 8: uydurma token → 400 jenerik', r8.status === 400, `status=${r8.status}`);

    // Test 9: Zod — kısa parola / hatalı token biçimi → 400 VALIDATION_ERROR
    const r9a = await call('POST', '/auth/reset-password', { token: 'a'.repeat(64), newPassword: 'kisa' });
    const r9b = await call('POST', '/auth/reset-password', { token: 'abc', newPassword: NEW_PW });
    check('Test 9: Zod doğrulama — kısa parola & hatalı token biçimi → 400',
      r9a.status === 400 && r9a.body.error === 'VALIDATION_ERROR' && r9b.status === 400 && r9b.body.error === 'VALIDATION_ERROR',
      `kısa parola=${r9a.status}/${r9a.body.error}, kısa token=${r9b.status}/${r9b.body.error}`);

    // Test 10: rate limit — kullanıcı başına dakikada 1 (AC)
    await clearRateLimits();
    const rl1 = await call('POST', '/auth/forgot-password', { username: USER });
    const rl2 = await call('POST', '/auth/forgot-password', { username: USER });
    check('Test 10: forgot-password kullanıcı başına 1/dk — 2. çağrı 429',
      rl1.status === 200 && rl2.status === 429 && rl2.body.error === 'TOO_MANY_REQUESTS',
      `1.=${rl1.status}, 2.=${rl2.status}/${rl2.body.error}`);

  } finally {
    // Parolayı seed değerine geri yaz — başka testler '123456' ile giriyor.
    const client = pg();
    await client.connect();
    await client.query(
      `UPDATE users SET password_hash = $2, must_change_password = FALSE, temp_password_expires_at = NULL WHERE username = $1`,
      [USER, SEED_HASH_123456]
    );
    await client.end();
    await clearRateLimits();
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  await redis.quit();
  // passwordResetService import'u kalıcı bir Redis bağlantısı (redisPool
  // singleton) açar; event loop'u canlı tutar. Testin sonucu belliyken
  // süreci açıkça sonlandır (aksi halde CI adımı asılı kalır).
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => { console.error('💥', err); process.exit(1); });
