import crypto from 'crypto';
import { execSync } from 'node:child_process';

/**
 * RES-905 — "Graceful degradation (Redis/MQTT/DB kısmi arıza senaryoları)".
 *
 * Ticket'ın önerdiği yığın (Prometheus sayaçları, ayrı bir "circuit breaker"
 * kütüphanesi, bağımsız bir HTTP-fallback servisi) bu kod tabanında kurulu
 * değil ve BİLİNÇLİ olarak eklenmedi — mevcut altyapı zaten ticket'ın asıl
 * istediği davranışın büyük kısmını karşılıyordu, gerçek boşluklar şunlardı
 * (bu commit'in kapsamı):
 *
 *  1. authMiddleware.ts: token doğrulaması BAŞARILI olduktan SONRAKİ bir
 *     adımda (lisans sorgusu, Postgres) oluşan geçici bir hata, kullanıcıya
 *     YANLIŞLIKLA "oturumunuz sona erdi" (401) olarak dönüyordu.
 *  2. accountLockoutService.ts: Redis erişilemezse TÜM /auth/login ucu
 *     (yeni oturum açmak isteyen HERKES) etkileniyordu — artık isSessionDenied
 *     ile AYNI fail-open deseni uygulanıyor.
 *  3. rateLimitMiddleware.ts: express-rate-limit'in varsayılanı
 *     (passOnStoreError=false) bir Redis kesintisinde ilgili UCUN TAMAMINI
 *     500'e düşürüyordu (login/refresh/hardware/lorawan/parola-sıfırlama).
 *  4. hardwareAuthMiddleware.ts: nonce/replay koruması KASITLI olarak
 *     fail-closed kalıyor (Redis yoksa replay koruması atlanamaz) ama artık
 *     opak bir 500 yerine ayırt edilebilir bir 503 dönüyor.
 *  5. redisPool.ts: maxRetriesPerRequest'in varsayılanı (20), connectTimeout'un
 *     varsayılanı (10sn) ve commandTimeout'un HİÇ ayarlanmamış olması bir
 *     kesintide bir isteğin saniyeler (canlı testte GÖZLEMLENEN: ~30sn, nginx
 *     gateway timeout'una kadar) ASILI KALMASINA yol açıyordu — üçü de
 *     sıkılaştırıldı (bkz. dosyadaki RES-905 notları).
 *
 * IOT-303.1 (sync-batch, çevrimdışı toplu senkronizasyon) ve MQTT'nin kendi
 * üstel backoff'u (mqttClient.ts) zaten "MQTT kısmi arıza" AC'sini
 * karşılıyordu, burada TEKRAR icat edilmedi.
 *
 * Bu test GERÇEKTEN paylaşılan `yakittakip_redis` konteynerini kısa süreliğine
 * DURDURUP tekrar BAŞLATIR (host'tan `docker stop/start`) — bu KASITLI ve
 * testin doğruladığı senaryonun ta kendisi, bir yan etki değil. Kesinti
 * penceresi birkaç saniyeyle sınırlıdır ve try/finally ile HER KOŞULDA
 * yeniden başlatılır. BİLİNÇLİ SAPMA: test_iot301_mqtt_resilience.ts'teki AYNI
 * gerekçeyle (Docker container yaşam döngüsü kontrolü CI'ın job modelinin
 * dışında — CI'daki `auth-integration-test` işi docker-compose DEĞİL, GH
 * Actions `services:` konteynerleri kullanıyor, `yakittakip_redis` adında bir
 * konteyner CI'da YOK) bu test CI'a EKLENMEDİ, yalnızca yerel geliştirme
 * ortamında manuel/isteğe bağlı bir doğrulama testi olarak kalıyor.
 *
 * BILL-1701/ARCH-108 testleriyle AYNI nedenle bu test de
 * host'tan (nginx üzerinden, `localhost:3000`) çalıştırılmalıdır — `docker`
 * komutlarına erişim gerektirir, `docker run --network container:backend`
 * İÇİNDEN çalıştırılamaz.
 */

const API_URL = process.env.API_URL || 'http://localhost:3000/api/v1';
const REDIS_CONTAINER = 'yakittakip_redis';
const DEVICE_ID = 'ESP32-PUMP-01';
const DEVICE_SECRET = process.env.HW_SECRET_ESP32_PUMP_01 || 'secret_gebze_pump_8849';

function resetLoginRl(): void {
  try {
    execSync(
      "docker exec yakittakip_redis redis-cli --scan --pattern 'rl:auth-login:*' | xargs -r docker exec -i yakittakip_redis redis-cli DEL",
      { stdio: 'ignore' }
    );
  } catch {
    // Redis zaten durdurulmuşsa bu komut da başarısız olur — beklenen, testi durdurmaz.
  }
}

async function call(method: string, path: string, opts: { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
  if (path === '/auth/login') resetLoginRl();
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

async function login(username: string): Promise<{ status: number; token: string | null; body: any }> {
  const r = await call('POST', '/auth/login', { body: { username, password: '123456' } });
  return { status: r.status, token: r.body.accessToken ?? null, body: r.body };
}

function signHardware(timestamp: string, nonce: string, rawBody: string): string {
  return crypto.createHmac('sha256', DEVICE_SECRET).update(`${timestamp}.${nonce}.${rawBody}`).digest('hex');
}

/** Boş `records` dizisiyle çağırır — hardwareAuthMiddleware'i GEÇERSE (nonce kabul edilirse)
 * her zaman 400 (Zod min(1)) döner; middleware'in kendisi reddederse 401/503 döner. Bu sayede
 * gerçek bir tank/vehicle fixture'ına ihtiyaç duymadan yalnızca AUTH KATMANI izole test edilir. */
async function hardwareSyncBatchEmpty(nonceOverride?: string): Promise<{ status: number; body: any; nonce: string; durationMs: number }> {
  const body = JSON.stringify({ records: [] });
  const timestamp = Date.now().toString();
  const nonce = nonceOverride || crypto.randomBytes(16).toString('hex');
  const signature = signHardware(timestamp, nonce, body);
  const startedAt = Date.now();
  const res = await fetch(`${API_URL}/telemetry/sync-batch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Device-ID': DEVICE_ID,
      'X-Timestamp': timestamp,
      'X-Nonce': nonce,
      'X-Hardware-Signature': signature
    },
    body
  });
  const durationMs = Date.now() - startedAt;
  const data = await res.json().catch(() => ({}));
  return { status: res.status, body: data, nonce, durationMs };
}

function stopRedis(): void {
  execSync(`docker stop ${REDIS_CONTAINER}`, { stdio: 'ignore' });
}
function startRedis(): void {
  execSync(`docker start ${REDIS_CONTAINER}`, { stdio: 'ignore' });
}

async function waitForRedisReady(maxWaitMs = 20000): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    try {
      const res = await fetch(`${API_URL}/health/ready`);
      const body = await res.json().catch(() => ({}));
      const redisDep = (body.dependencies || []).find((d: any) => d.name === 'redis');
      if (redisDep?.ok) return true;
    } catch {
      // backend henüz yanıt vermiyor olabilir — beklemeye devam
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [RES-905] KISMİ ALTYAPI ARIZASI — GRACEFUL DEGRADATION TESTİ');
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

  try {
    // ── Redis SAĞLIKLIYKEN referans (regresyon) davranışı ─────────────
    const baseline = await login('admin');
    check('Test 1: Redis sağlıklıyken normal giriş çalışır', baseline.status === 200 && !!baseline.token, `status=${baseline.status}`);
    const preOutageToken = baseline.token!;

    const meBefore = await call('GET', '/companies/me', { token: preOutageToken });
    check('Test 2: Redis sağlıklıyken yetkili istek çalışır', meBefore.status === 200, `status=${meBefore.status}`);

    const hwBefore = await hardwareSyncBatchEmpty();
    check(
      'Test 3: Redis sağlıklıyken donanım nonce kontrolü geçer (400=doğrulama katmanına ulaştı)',
      hwBefore.status === 400,
      `status=${hwBefore.status}, body=${JSON.stringify(hwBefore.body)}`
    );

    // ── REDİS KESİNTİSİ BAŞLIYOR ───────────────────────────────────────
    console.log('🔌 [RES-905] Redis konteyneri kasıtlı olarak durduruluyor (simüle edilen kısmi arıza)...\n');
    stopRedis();
    // ioredis'in bağlantı kaybını fark etmesi için kısa bir bekleme.
    await new Promise((r) => setTimeout(r, 1500));

    const outageNonce = crypto.randomBytes(16).toString('hex');

    // Var olmayan bir kullanıcı adı checkLockout/recordFailedLogin'e (Redis)
    // hiç ulaşmadan (kullanıcı DB'de bulunamadığı için) erken 401 dönebilir —
    // bu yüzden BURADA gerçek/geçerli kimlik bilgileri kullanılıyor: akış
    // Argon2id doğrulamasını geçip generateRefreshToken'a (Redis'e YAZMASI
    // ZORUNLU — iptal edilebilir bir oturum kurmadan giriş TAMAMLANAMAZ,
    // bu KASITLI fail-closed bir sınır) kadar ilerlesin.
    const loginDuringOutage = await login('admin');
    check(
      'Test 4: Kesinti sırasında YENİ giriş (geçerli şifreyle) temiz biçimde 500 döner — asılı kalmaz, "yanlış şifre" YALANI söylemez',
      loginDuringOutage.status === 500,
      `status=${loginDuringOutage.status}, error=${loginDuringOutage.body?.error}`
    );

    const meDuringOutage = await call('GET', '/companies/me', { token: preOutageToken });
    check(
      'Test 5 (ANA BULGU): kesinti ÖNCESİ alınmış geçerli token, kesinti SIRASINDA hâlâ çalışır (yanlışlıkla 401 SESSION_REVOKED/INVALID_TOKEN dönmez)',
      meDuringOutage.status === 200,
      `status=${meDuringOutage.status}, body=${JSON.stringify(meDuringOutage.body)}`
    );

    const hwDuringOutage = await hardwareSyncBatchEmpty(outageNonce);
    check(
      'Test 6: kesinti sırasında donanım nonce kontrolü BİLİNÇLİ olarak fail-closed kalır ama ayırt edilebilir 503 döner (opak 500 değil)',
      hwDuringOutage.status === 503 && hwDuringOutage.body?.error === 'ServiceUnavailableError',
      `status=${hwDuringOutage.status}, body=${JSON.stringify(hwDuringOutage.body)}`
    );

    check(
      'Test 7: maxRetriesPerRequest düşürüldüğü için kesinti sırasındaki istekler saniyeler içinde yanıt verir (asılı kalmaz)',
      hwDuringOutage.durationMs < 5000,
      `hardwareSyncBatch süresi=${hwDuringOutage.durationMs}ms`
    );

    // ── REDİS KESİNTİSİ SONA ERİYOR ────────────────────────────────────
    console.log('🔌 [RES-905] Redis konteyneri yeniden başlatılıyor...\n');
    startRedis();
    const recovered = await waitForRedisReady();
    check('Test 8: Redis yeniden başladıktan sonra /health/ready redis.ok=true raporlar', recovered, `recovered=${recovered}`);

    // health/ready 3sn'lik bir sonuç önbelleği tutuyor (READINESS_CACHE_MS) —
    // bağlantının backend tarafında da tamamen stabilize olması için küçük bir pay.
    await new Promise((r) => setTimeout(r, 1000));

    const loginAfterRecovery = await login('admin');
    check('Test 9: kurtarma sonrası normal giriş tekrar çalışır', loginAfterRecovery.status === 200 && !!loginAfterRecovery.token, `status=${loginAfterRecovery.status}`);

    // Kesinti sırasında Redis'e hiç YAZILAMAYAN nonce, kurtarma sonrası
    // "hiç kullanılmamış" gibi davranmalı (fail-closed, veri KAYBI değil).
    const hwReplayFresh = await hardwareSyncBatchEmpty(outageNonce);
    check(
      'Test 10: kesinti sırasında reddedilen nonce, Redis\'e HİÇ yazılmadığından kurtarma sonrası TAZE kabul edilir',
      hwReplayFresh.status === 400,
      `status=${hwReplayFresh.status}, body=${JSON.stringify(hwReplayFresh.body)}`
    );

    const hwReplayReused = await hardwareSyncBatchEmpty(outageNonce);
    check(
      'Test 11: AYNI nonce ikinci kez gönderilince replay koruması normal şekilde devrede (401 NONCE_REUSED)',
      hwReplayReused.status === 401 && hwReplayReused.body?.error === 'NONCE_REUSED',
      `status=${hwReplayReused.status}, body=${JSON.stringify(hwReplayReused.body)}`
    );
  } finally {
    // Redis'in test sonunda AÇIK kaldığından emin ol — bir assertion ortada
    // patlasa bile paylaşımlı geliştirme ortamı bozuk bırakılmamalı.
    try {
      startRedis();
      await waitForRedisReady();
    } catch {
      // konteyner zaten çalışıyorsa `docker start` no-op'tur, hata görmezden gelinir
    }
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');

  if (passed !== total) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('🔥 Test çalıştırılırken beklenmeyen hata:', err);
  try {
    startRedis();
  } catch {
    // yut — süreç zaten hata koduyla çıkıyor
  }
  process.exit(1);
});
