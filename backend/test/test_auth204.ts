import Redis from 'ioredis';

/**
 * AUTH-204 — Şantiye oluştururken otomatik kullanıcı/parola üretimi ve
 * ilk girişte zorunlu parola değiştirme akışı, uçtan uca entegrasyon testi.
 *
 * DİKKAT: 'camsa' (COMPANY_OWNER) ile yeni bir şantiye oluşturur — bu
 * paylaşılan bir fixture hesap ama yalnızca TEK bir başarılı login (mevcut
 * şifreyle) kullanır, AUTH-209'un 5 deneme eşiğinin çok altında; diğer test
 * dosyalarıyla (test_auth201.ts, test_auth209.ts) çakışmaz.
 *
 * Bu test 6 kez /auth/login çağırıyor — IP-bazlı loginRateLimiter'ın (10/15dk,
 * bkz. test_auth209.ts'teki aynı gerekçe) diğer test dosyalarıyla birlikte
 * aynı pencereye sığmayabileceğinden, her login'den önce ilgili Redis
 * anahtarları temizleniyor.
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

interface CurlResult {
  status: number;
  body: any;
}

async function call(method: string, path: string, opts: { token?: string; body?: any } = {}): Promise<CurlResult> {
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

async function runAuth204Tests() {
  console.log('===========================================================');
  console.log('🔐 [AUTH-204] ŞANTİYE PROVISIONING + ZORUNLU PAROLA DEĞİŞTİRME');
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

  // 0. Firma sahibi olarak giriş
  const ownerLogin = await call('POST', '/auth/login', { body: { username: 'camsa', password: '123456' } });
  if (ownerLogin.status !== 200) {
    console.error('❌ Ön koşul: camsa ile giriş başarısız, test durduruluyor.', ownerLogin.body);
    process.exit(1);
  }
  const ownerToken = ownerLogin.body.accessToken;

  // 1. Şantiye + yönetici hesabı TEK istekte oluşturuluyor
  const siteName = `AUTH-204 Test Sahası ${Date.now()}`;
  const createRes = await call('POST', '/sites', { token: ownerToken, body: { siteName } });
  check(
    'Test 1: Şantiye + SITE_MANAGER kullanıcısı tek istekte oluşturulur',
    createRes.status === 200 && !!createRes.body?.data?.manager?.username && !!createRes.body?.data?.manager?.temporaryPassword,
    `HTTP ${createRes.status}, username=${createRes.body?.data?.manager?.username}`
  );
  const { username, temporaryPassword } = createRes.body.data.manager;

  // 2. Geçici parolayla giriş -> mustChangePassword: true
  const tempLogin = await call('POST', '/auth/login', { body: { username, password: temporaryPassword } });
  check(
    'Test 2: Geçici parolayla giriş başarılı, mustChangePassword=true döner',
    tempLogin.status === 200 && tempLogin.body?.user?.mustChangePassword === true,
    `HTTP ${tempLogin.status}, mustChangePassword=${tempLogin.body?.user?.mustChangePassword}`
  );
  const tempToken = tempLogin.body.accessToken;

  // 3. Parola değiştirmeden başka bir uca erişim -> 403 PASSWORD_CHANGE_REQUIRED
  const blockedRes = await call('GET', '/vehicles', { token: tempToken });
  check(
    'Test 3: Parola değiştirmeden korunan bir uca erişim 403 ile reddedilir',
    blockedRes.status === 403 && blockedRes.body?.error === 'PASSWORD_CHANGE_REQUIRED',
    `HTTP ${blockedRes.status}, error=${blockedRes.body?.error}`
  );

  // 4. Logout, gate'in izin verdiği bir istisna olarak hâlâ çalışmalı
  const logoutRes = await call('POST', '/auth/logout', { token: tempToken, body: {} });
  check(
    "Test 4: /auth/logout, mustChangePassword=true iken de allowlist'te olduğu için çalışır",
    logoutRes.status === 200,
    `HTTP ${logoutRes.status}`
  );

  // 5. Yanlış mevcut parolayla değiştirme denemesi -> 401
  const wrongCurrentRes = await call('POST', '/auth/change-password', {
    token: tempToken,
    body: { currentPassword: 'kesinlikle-yanlis', newPassword: 'YeniGucluParola123' }
  });
  check(
    'Test 5: Yanlış mevcut parolayla değiştirme denemesi reddedilir',
    wrongCurrentRes.status === 401,
    `HTTP ${wrongCurrentRes.status}`
  );

  // 6. Doğru mevcut parolayla değiştirme -> başarılı, taze token döner
  const changeRes = await call('POST', '/auth/change-password', {
    token: tempToken,
    body: { currentPassword: temporaryPassword, newPassword: 'YeniGucluParola123' }
  });
  check(
    'Test 6: Doğru mevcut parolayla değiştirme başarılı, yeni token döner',
    changeRes.status === 200 && !!changeRes.body?.accessToken,
    `HTTP ${changeRes.status}`
  );
  const newToken = changeRes.body.accessToken;

  // 7. Yeni token artık korunan uca erişebilir (kapı kalkmış)
  const unlockedRes = await call('GET', '/vehicles', { token: newToken });
  check(
    'Test 7: Parola değiştikten sonra korunan uca erişim serbest',
    unlockedRes.status === 200,
    `HTTP ${unlockedRes.status}`
  );

  // 8. Yeniden login: mustChangePassword artık kalıcı olarak false
  const reLoginRes = await call('POST', '/auth/login', { body: { username, password: 'YeniGucluParola123' } });
  check(
    'Test 8: Yeni parolayla giriş mustChangePassword=false döner (kalıcı)',
    reLoginRes.status === 200 && reLoginRes.body?.user?.mustChangePassword === false,
    `HTTP ${reLoginRes.status}, mustChangePassword=${reLoginRes.body?.user?.mustChangePassword}`
  );

  // 9. Eski geçici parola artık geçersiz
  const oldPwRes = await call('POST', '/auth/login', { body: { username, password: temporaryPassword } });
  check(
    'Test 9: Eski geçici parola artık kabul edilmez',
    oldPwRes.status === 401,
    `HTTP ${oldPwRes.status}`
  );

  await resetIpLoginRateLimit();
  redis.disconnect();

  console.log('===========================================================');
  console.log(`📊 TEST SONUÇLARI: ${passed} / ${total} TEST BAŞARILI`);
  console.log('===========================================================');

  if (passed !== total) {
    process.exit(1);
  }
}

runAuth204Tests();
