import Redis from 'ioredis';
import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * TEST_PLAN.md §7 — Redis bellek baskısı (noeviction + maxmemory dolu).
 *
 * Bu durumda Redis OKUMALARI yanıtlar, YAZMALARI "OOM command not allowed"
 * ile reddeder. Tatbikatta ölçülen önceki davranış: yanlış parolayla 12
 * denemenin 12'si 401 (hesap kilidi VE IP rate limit sessizce devre dışı),
 * doğru parola 500 → saldırgana sınırsız deneme + "500 = doğru parola" kâhini.
 * Beklenen: /auth/login parola doğrulamadan 503 döner; doğru/yanlış parola
 * AYIRT EDİLEMEZ; mevcut oturumlar (okuma yolu) çalışmaya devam eder; bellek
 * açılınca her şey normale döner.
 *
 * Redis'i gerçekten doldurmak yerine maxmemory kullanılan belleğin altına
 * çekilir (aynı OOM yanıtı); finally'de ÖNCEKİ değere geri alınır.
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';
const PROBE_USER = `oom-probe-${Date.now()}`;
const redis = new Redis({ host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379', 10) });

async function login(username: string, password: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.99' },
    body: JSON.stringify({ username, password })
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [TEST_PLAN §7] REDIS BELLEK BASKISI — GİRİŞ KORUMALARI');
  console.log('===========================================================\n');
  let passed = 0;
  let total = 0;
  const check = (name: string, condition: boolean, detail: string) => {
    total++;
    console.log(`${condition ? '✅ [PASS]' : '❌ [FAIL]'} ${name}\n   ${detail}\n`);
    if (condition) passed++;
  };

  const originalMaxmemory = ((await redis.config('GET', 'maxmemory')) as string[])[1];
  const originalPolicy = ((await redis.config('GET', 'maxmemory-policy')) as string[])[1];
  const clearProbe = () => redis.del(`login-fail:${PROBE_USER}`, `login-lock:${PROBE_USER}`, `login-lock-strikes:${PROBE_USER}`);

  await resetLoginRateLimit();
  const session = await login('camsa', '123456');
  if (!session.body.accessToken) throw new Error(`ön koşul girişi başarısız: ${JSON.stringify(session.body)}`);

  try {
    await redis.config('SET', 'maxmemory-policy', 'noeviction');
    const used = Number(/used_memory:(\d+)/.exec(await redis.info('memory'))![1]);
    await redis.config('SET', 'maxmemory', String(Math.floor(used / 2)));
    const writeRefused = await redis.set('oom-test-probe', '1').then(() => false, (e) => /OOM/.test(String(e)));
    check('Ön koşul: Redis yazmayı OOM ile reddediyor, okuma çalışıyor', writeRefused && (await redis.ping()) === 'PONG',
      `maxmemory=${Math.floor(used / 2)} < used=${used}`);

    const wrong = [];
    for (let i = 0; i < 7; i++) wrong.push(await login(PROBE_USER, 'yanlis-parola'));
    check('Test 1: bellek doluyken yanlış parola 401 DEĞİL 503 (kilit/limit düşmüşken sınırsız deneme YOK)',
      wrong.every((r) => r.status === 503 && r.body.details?.error === 'AUTH_STORE_UNAVAILABLE'),
      `statüler=${wrong.map((r) => r.status).join(',')}`);

    const correct = await login('camsa', '123456');
    const wrongOnce = await login('camsa', 'yanlis-parola');
    check('Test 2: doğru ve yanlış parola AYIRT EDİLEMEZ (aynı durum + aynı gövde → parola kâhini yok)',
      correct.status === 503 && wrongOnce.status === 503 && JSON.stringify(correct.body.details) === JSON.stringify(wrongOnce.body.details),
      `doğru=${correct.status}, yanlış=${wrongOnce.status}`);

    const me = await fetch(`${API_URL}/auth/me`, { headers: { Authorization: `Bearer ${session.body.accessToken}` } });
    check('Test 3: mevcut oturum (yalnızca okuma gerektiren yol) çalışmaya devam eder', me.status === 200, `GET /auth/me=${me.status}`);
  } finally {
    await redis.config('SET', 'maxmemory', originalMaxmemory);
    await redis.config('SET', 'maxmemory-policy', originalPolicy);
  }

  await clearProbe();
  await resetLoginRateLimit();
  const after = [];
  for (let i = 0; i < 5; i++) after.push((await login(PROBE_USER, 'yanlis-parola')).status);
  check('Test 4: bellek açılınca koruma geri gelir (4×401, 5. denemede 423 kilit)',
    after.slice(0, 4).every((s) => s === 401) && after[4] === 423, `statüler=${after.join(',')}`);
  const recovered = await login('camsa', '123456');
  check('Test 5: bellek açılınca geçerli giriş 200', recovered.status === 200 && !!recovered.body.accessToken, `status=${recovered.status}`);

  await clearProbe();
  await resetLoginRateLimit();
  await redis.quit();
  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  process.exit(passed === total ? 0 : 1);
}

run().catch(async (err) => {
  console.error('🔥 Test çalıştırılırken beklenmeyen hata:', err);
  process.exit(1);
});
