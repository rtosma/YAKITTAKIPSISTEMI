import Redis from 'ioredis';

/**
 * AUTH-209 — Hesap bazlı brute-force kilitleme entegrasyon testi.
 *
 * DİKKAT: bu test 'kusak' kullanıcısını KASITLI olarak kilitler (Test 2).
 * Bu yüzden 'kusak' bu dosya dışında hiçbir CI test dosyasında
 * kullanılmamalıdır — test_auth201.ts 'camsa' ve 'pompa-op-01' kullanıyor,
 * testHardwareAuth.ts hiç HTTP login yapmıyor, dolayısıyla çakışma yok.
 * 'camsa' burada yalnızca TEK bir yanlış şifre denemesi için kullanılıyor
 * (izolasyon testi) — 5 eşiğinin çok altında, test_auth201.ts'nin kendi tek
 * yanlış-şifre testiyle birlikte bile toplamda 2, hâlâ güvenli.
 *
 * Bu test, ayrı bir katman olan IP-bazlı `loginRateLimiter`'ı (10 istek/15dk)
 * KASITLI olarak devre dışı bırakır (her denemeden önce Redis'teki ilgili
 * anahtarları temizleyerek) — burada test edilen hesap bazlı kilitleme,
 * IP limitinden bağımsız ikinci bir katman ve bu testin tek başına attığı
 * ~12 istek IP limitini aşıp asıl test edilen davranışı maskeleyebilir.
 * IP-bazlı limitleme kendi başına zaten var olan, ayrı bir mekanizma.
 */

const API_URL = 'http://localhost:5000/api/v1/auth/login';
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10)
});

async function resetIpLoginRateLimit(): Promise<void> {
  const keys = await redis.keys('rl:auth-login:*');
  if (keys.length > 0) await redis.del(...keys);
}

async function resetAccountLockout(username: string): Promise<void> {
  await redis.del(`login-fail:${username}`, `login-lock:${username}`, `login-lock-strikes:${username}`);
}

async function login(username: string, password: string): Promise<{ status: number; body: any }> {
  await resetIpLoginRateLimit();
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  return { status: res.status, body: await res.json() };
}

async function runAccountLockoutTests() {
  console.log('===========================================================');
  console.log('🔒 [AUTH-209] HESAP BAZLI BRUTE-FORCE KİLİTLEME TESTİ');
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

  // --- TEST 1: var olmayan bir kullanıcı adı da 5 denemeden sonra kilitlenir
  // (enumeration koruması: "kilitli" yanıtı yalnızca gerçek hesaplarda
  // görülmemeli, aksi halde hangi kullanıcı adlarının var olduğu sızar) ---
  const ghostUser = `auth209-ghost-${Date.now()}`;
  await resetAccountLockout(ghostUser);
  let lastGhostResult: { status: number; body: any } | null = null;
  for (let i = 0; i < 5; i++) {
    lastGhostResult = await login(ghostUser, 'yanlis-sifre');
  }
  check(
    'Test 1: Var olmayan kullanıcı adı da 5. denemede kilitlenir (enumeration koruması)',
    lastGhostResult!.status === 423 && lastGhostResult!.body.error === 'ACCOUNT_LOCKED',
    `HTTP ${lastGhostResult!.status}, error=${lastGhostResult!.body.error}`
  );

  // --- TEST 2: gerçek bir hesap ('kusak') 5 yanlış denemeden sonra
  // kilitlenir VE kilitliyken DOĞRU şifre bile reddedilir ---
  await resetAccountLockout('kusak');
  let lastRealResult: { status: number; body: any } | null = null;
  for (let i = 0; i < 5; i++) {
    lastRealResult = await login('kusak', 'yanlis-sifre');
  }
  check(
    "Test 2a: 'kusak' hesabı 5. yanlış denemede kilitlenir",
    lastRealResult!.status === 423 && lastRealResult!.body.error === 'ACCOUNT_LOCKED',
    `HTTP ${lastRealResult!.status}, error=${lastRealResult!.body.error}`
  );

  const correctPasswordWhileLocked = await login('kusak', '123456');
  check(
    'Test 2b: Kilitliyken DOĞRU şifre bile reddedilir',
    correctPasswordWhileLocked.status === 423 && correctPasswordWhileLocked.body.error === 'ACCOUNT_LOCKED',
    `HTTP ${correctPasswordWhileLocked.status}, error=${correctPasswordWhileLocked.body.error}`
  );

  // --- TEST 3: 'kusak' kilitliyken, AYNI kaynaktan (aynı IP — bu test
  // sürecinin kendisi) farklı bir kullanıcı ('camsa') etkilenmemeli. AC:
  // "Aynı şantiye IP'sindeki farklı kullanıcılar birbirini kilitlememelidir." ---
  const otherUserAttempt = await login('camsa', 'yanlis-sifre-tek-deneme');
  check(
    "Test 3: 'kusak' kilitliyken 'camsa' etkilenmez (hesap bazlı izolasyon)",
    otherUserAttempt.status === 401 && otherUserAttempt.body.error === 'INVALID_CREDENTIALS',
    `HTTP ${otherUserAttempt.status}, error=${otherUserAttempt.body.error} (423 DEĞİL — kilitlenmemiş)`
  );

  // Test sonrası temizlik — 'kusak' bu testten sonra gerçekten kilitli
  // kalmasın (aynı job içinde başka bir şey ona giriş yapmaya çalışırsa diye).
  await resetAccountLockout('kusak');
  await resetAccountLockout(ghostUser);
  await resetIpLoginRateLimit();
  redis.disconnect();

  console.log('===========================================================');
  console.log(`📊 TEST SONUÇLARI: ${passed} / ${total} TEST BAŞARILI`);
  console.log('===========================================================');

  if (passed !== total) {
    process.exit(1);
  }
}

runAccountLockoutTests();
