import Redis from 'ioredis';
import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * TEST_PLAN.md §5 — reverse proxy arkasında IP bazlı rate limit doğruluğu.
 *
 * BULGU (iki ayrı konteynerle canlı kanıtlandı): backend'de `trust proxy`
 * ayarı yoktu. Tüm tarayıcı trafiği nginx'ten geçtiği için Express her isteği
 * nginx'in IP'sinden gelmiş sayıyordu → login rate limiter platform genelinde
 * TEK kova. 172.18.0.8'deki bir saldırgan kimlik bilgisi olmadan 10 istek attı,
 * 172.18.0.7'deki meşru kullanıcı doğru şifreyle 429 aldı: 15 dakikada 10
 * istekle HERKESİN girişi kilitlenebiliyordu.
 *
 * Bu test CI'da da çalışır: orada nginx yok, ama `trust proxy = 1` ile
 * backend'e gönderilen X-Forwarded-For başlığı, nginx'in
 * `$proxy_add_x_forwarded_for` ile listeye eklediği gerçek istemci IP'sini
 * birebir simüle eder (Express listenin SON girdisini alır).
 *
 * Belgelenmiş IP'ler RFC 5737 TEST-NET-2 (198.51.100.0/24) — gerçek bir
 * adresle çakışmaz.
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';
const ATTACKER = '198.51.100.10';
const VICTIM = '198.51.100.20';
const LOGIN_LIMIT = 10; // rateLimitMiddleware.ts loginRateLimiter

async function login(forwardedFor: string, username: string, password: string): Promise<number> {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': forwardedFor },
    body: JSON.stringify({ username, password })
  });
  await res.text();
  return res.status;
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [TEST_PLAN §5] PROXY ARKASINDA KİŞİ BAŞI LOGIN RATE LIMIT');
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

  const redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10)
  });

  try {
    await resetLoginRateLimit();

    // ── 1) Saldırgan kendi kovasını doldurur ────────────────────────────
    const attackerStatuses: number[] = [];
    for (let i = 0; i < LOGIN_LIMIT; i++) {
      // Var olmayan kullanıcı adları: hesap kilidi (AUTH-209) gerçek bir
      // kullanıcıyı etkilemesin; IP limiti yine de sayar.
      attackerStatuses.push(await login(ATTACKER, `rl-saldirgan-${Date.now()}-${i}`, 'yanlis-sifre'));
    }
    const attackerBlocked = await login(ATTACKER, `rl-saldirgan-${Date.now()}-x`, 'yanlis-sifre');
    check(
      `Test 1: Saldırgan IP'si ${LOGIN_LIMIT} denemeden sonra 429 alır (limit çalışıyor)`,
      attackerBlocked === 429 && !attackerStatuses.includes(429),
      `ilk ${LOGIN_LIMIT}: [${attackerStatuses.join(', ')}], ${LOGIN_LIMIT + 1}. istek: ${attackerBlocked}`
    );

    // ── 2) ANA BULGU: başka bir istemci ETKİLENMEZ ──────────────────────
    const victim = await login(VICTIM, 'kusak', '123456');
    check(
      'Test 2 (ANA BULGU): FARKLI IP\'deki meşru kullanıcı saldırgan yüzünden kilitlenMEZ',
      victim === 200,
      `mağdur (${VICTIM}) doğru şifreyle giriş: HTTP ${victim} — önceden 429 alıyordu (tüm trafik nginx IP'sine yazılıyordu)`
    );

    // ── 3) Kova anahtarı gerçekten istemci IP'si mi? ────────────────────
    const keys = await redis.keys('rl:auth-login:*');
    check(
      'Test 3: Rate limit kovası istemcinin GERÇEK IP\'siyle anahtarlanıyor (proxy/soket IP\'siyle değil)',
      keys.some((k) => k.endsWith(ATTACKER)) && keys.some((k) => k.endsWith(VICTIM)),
      `anahtarlar: ${keys.join(', ')}`
    );

    // ── 4) Sahtecilik direnci ───────────────────────────────────────────
    // Saldırgan nginx üzerinden kendi X-Forwarded-For'unu yollarsa nginx
    // gerçek adresi listenin SONUNA ekler: "sahte, gerçek". trust proxy=1
    // yalnızca son girdiyi kullandığı için sahte girdi kilidi AŞAMAMALI.
    const spoofed = await login(`203.0.113.77, ${ATTACKER}`, `rl-saldirgan-${Date.now()}-s`, 'yanlis-sifre');
    check(
      'Test 4: Saldırgan başlığa sahte IP eklese de ("sahte, gerçek") kilit KALKMAZ',
      spoofed === 429,
      `X-Forwarded-For: "203.0.113.77, ${ATTACKER}" → HTTP ${spoofed}`
    );
    const spoofKey = (await redis.keys('rl:auth-login:*')).some((k) => k.endsWith('203.0.113.77'));
    check(
      'Test 5: Sahte (soldaki) IP için ayrı bir kova OLUŞMADI',
      !spoofKey,
      `203.0.113.77 kovası var mı: ${spoofKey}`
    );
  } finally {
    await resetLoginRateLimit();
    await redis.quit();
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  if (passed !== total) process.exit(1);
}

run().catch(async (err) => {
  console.error('🔥 Test çalıştırılırken beklenmeyen hata:', err);
  await resetLoginRateLimit().catch(() => {});
  process.exit(1);
});
