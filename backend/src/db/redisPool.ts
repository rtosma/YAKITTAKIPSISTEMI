import Redis from 'ioredis';
import { config } from '../config/env';
import { logger } from '../utils/logger';

/**
 * RES-905 — Kısmi Altyapı Arızası Davranış Matrisi (DOC-1203'ün önerdiği
 * "bağımlılık matrisi" dokümanının kod-içi karşılığı; ayrı bir doküman
 * servisi/dosyası bu proje genelinde kullanılan bir kalıp DEĞİL — bilgi
 * kaynağıyla aynı yerde, kodla birlikte güncel kalması için burada tutulur).
 *
 * Bağımlılık | Etkilenen alan                          | Kesintide davranış
 * -----------|------------------------------------------|--------------------------------------------
 * Redis      | cache-aside (cacheGetJson/Set/Del)        | FAIL-OPEN: null/no-op, DB'ye düşer (yukarıda)
 * Redis      | isSessionDenied (tokenService.ts)         | FAIL-OPEN: erken uzaktan-çıkış kontrolü atlanır,
 *            |                                            | access token kendi 15dk süresiyle sınırlı kalır
 * Redis      | checkLockout/recordFailedLogin            | FAIL-OPEN: kullanıcı-adı bazlı brute-force kilidi
 *            | (accountLockoutService.ts)                | geçici devre dışı — Argon2id + IP rate limit sürer
 * Redis      | loginRateLimiter ve diğer 6 RedisStore     | FAIL-OPEN (passOnStoreError:true): limitleme
 *            | limiter (rateLimitMiddleware.ts)          | geçici devre dışı, uç ÇALIŞMAYA devam eder
 * Redis      | hardwareAuthMiddleware nonce/replay kontrolü| FAIL-CLOSED (bilinçli): kimlik doğrulama/replay
 *            |                                            | koruması ASLA atlanmaz, 503 (retry edilebilir) döner
 * Redis      | device presence (setDeviceState/getDeviceState)| FAIL-OPEN: hata halinde OFFLINE varsayılır
 * Postgres   | getCompanyLicenseSnapshot (authMiddleware) | FAIL-ÖNCEKİ DAVRANIŞ DÜZELTİLDİ: artık next(err) ile
 *            |                                            | temiz 500/503 döner, YANLIŞLIKLA "oturum sona erdi"
 *            |                                            | (401) DÖNMEZ — bkz. authMiddleware.ts RES-905 notu
 * Postgres   | genel sorgu hataları (routes.ts)          | FAIL-CLOSED: next(error) → globalErrorHandler → temiz
 *            |                                            | 500 (stack trace sızdırmaz, süreç ÇÖKMEZ — pool.on('error')
 *            |                                            | zaten kayıtlı, bkz. postgresPool.ts)
 * MQTT       | broker erişilemez (mqttClient.ts)         | Elle yönetilen üstel backoff (1sn→30sn) ile
 *            |                                            | otomatik yeniden bağlanma; cihaz tarafı ise IOT-303.1
 *            |                                            | (POST /telemetry/sync-batch) ile ÇEVRİMDIŞI BİRİKTİRİP
 *            |                                            | HTTP üzerinden toplu senkronize eder — bağımsız bir
 *            |                                            | "HTTP fallback" endpoint'i AYRICA icat edilmedi, zaten
 *            |                                            | var olan idempotent batch-sync ucu bu ihtiyacı karşılıyor
 * Tümü       | /health/ready (readinessService.ts, RES-906)| Her bağımlılık ayrı ayrı raporlanır (postgres/redis/mqtt),
 *            |                                            | MQTT yapılandırılmamışsa skipped:true — liveness bu
 *            |                                            | kontrolleri KASITLI içermez (restart fırtınası riski)
 *
 * Genel ilke: bir kontrolün ATLANMASI güvenlik ihlaline yol açıyorsa (kimlik
 * doğrulama, replay koruması) FAIL-CLOSED + ayırt edilebilir 503; aksi halde
 * (throttling, ikincil brute-force katmanı, cache) FAIL-OPEN — tek bir
 * bağımlılığın geçici arızası uygulamanın TAMAMINI değil, yalnızca o katmanın
 * sağladığı EK korumayı geçici olarak düşürmeli.
 */

// IOT-301.2 AC: "Cihaz bağlantısı koptuğunda 10 saniye içinde OFFLINE olarak
// işaretlenmelidir." LWT/status mesajı normalde bunu neredeyse anında yapar,
// ama broker keepalive'ı gecikirse ya da bir mesaj kaybolursa diye bu TTL bir
// GÜVENCE ağıdır: ONLINE durumu yalnızca bu süre kadar "kanıtsız" kalabilir,
// sonra anahtar kendiliğinden düşer ve getDeviceState zaten var olan
// "anahtar yok → OFFLINE" varsayılanına geri döner.
const DEVICE_PRESENCE_TTL_SECONDS = 10;

class RedisManager {
  public client: Redis;

  constructor() {
    this.client = new Redis({
      host: config.REDIS_HOST,
      port: config.REDIS_PORT,
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      // RES-905: ioredis'in varsayılanı maxRetriesPerRequest=20 — bağlantı
      // koptuğunda kuyruğa alınan (enableOfflineQueue varsayılan true) her
      // komut, retryStrategy'nin üstel gecikmesiyle 20 KEZ denenip ancak
      // ONDAN SONRA reddedilir; toplamda saniyeler (worst-case ~20sn) süren
      // bir ASILI KALMA anlamına gelir. Bu, dosyanın başındaki davranış
      // matrisinde tanımlanan TÜM fail-open/fail-closed kararlarını
      // (isSessionDenied, checkLockout, rate limiter, nonce kontrolü) işe
      // yaramaz kılar — kod doğru olsa bile istek saniyelerce asılı kalırdı.
      // 2 ile bir komut birkaç yüz ms içinde vazgeçer; bağlantının kendisini
      // yeniden kurma çabası (retryStrategy) BAĞIMSIZ olarak arka planda
      // sınırsız denemeye devam eder, yalnızca TEKİL komutların bekleme
      // süresi kısaltılıyor.
      maxRetriesPerRequest: 2,
      // RES-905: yukarıdaki maxRetriesPerRequest TEK BAŞINA yeterli değil —
      // ioredis'in connectTimeout varsayılanı 10sn'dir ve her yeniden
      // bağlanma DENEMESİ bu süre kadar bekleyebilir (Docker bridge ağında
      // durdurulmuş bir konteynerin portu her zaman ANINDA ECONNREFUSED
      // vermez, bazı durumlarda paketler sessizce düşer ve TCP SYN kendi
      // zaman aşımına kadar bekler) — canlı testte (RES-905 test dosyası)
      // maxRetriesPerRequest=2 + varsayılan 10sn connectTimeout kombinasyonu
      // bir isteğin ~30sn ASILI KALMASINA (nginx gateway timeout'una kadar)
      // yol açtığı GÖZLEMLENDİ. 1sn'ye düşürülünce aynı senaryo saniyeler
      // içinde (asıl deneme + 2 yeniden deneme) temiz biçimde başarısız oluyor.
      connectTimeout: 1000,
      // RES-905: connectTimeout YALNIZCA yeni bağlantı KURMA aşamasını
      // sınırlar — halihazırda "connecting"/"reconnecting" durumundaki bir
      // bağlantı üzerinde bekleyen bir KOMUT için ayrı bir üst sınır değildir.
      // Canlı testte connectTimeout=1000 + maxRetriesPerRequest=2'ye rağmen
      // tek bir isteğin hâlâ ~17sn sürdüğü GÖZLEMLENDİ (retryAttempts sayacı
      // yalnızca her (maxRetriesPerRequest+1)'inci denemede kuyruğu boşaltıyor
      // — bkz. ioredis event_handler.js — bu yüzden gerçek bekleme, tek bir
      // ayarın sandığı kadar öngörülebilir değil). commandTimeout, bağlantı
      // durumundan BAĞIMSIZ olarak TEK BİR komutun bekleyebileceği MUTLAK
      // tavanı koyar — asıl "asılı kalmama" garantisini bu sağlıyor.
      commandTimeout: 1000,
    });

    this.client.on('connect', () => {
      logger.info('🔗 [Redis] Bağlantı sağlandı.');
    });

    this.client.on('error', (err) => {
      logger.error({ err }, '🚨 [Redis] Bağlantı hatası!');
    });
  }

  /**
   * Cihazın durumunu Redis'e kaydeder. ONLINE bir TTL ile (her yeni veri/status
   * mesajında yenilenir) yazılır — cihaz susarsa anahtar kendiliğinden düşer.
   * OFFLINE için ayrıca bir değer saklamaya gerek yok: anahtarın YOKLUĞU zaten
   * "OFFLINE" anlamına geliyor (bkz. getDeviceState) — bu yüzden LWT/status
   * OFFLINE mesajı geldiğinde anahtar silinir.
   *
   * Dönüş değeri: bu çağrı GERÇEK bir durum GEÇİŞİ mi (önceki ≠ yeni) —
   * mqttClient.ts yalnızca gerçek geçişlerde canlı bir Socket.io olayı
   * yayınlar, her tek telemetri paketinde değil (IOT-301.2 AC: "Cihaz durumu
   * DEĞİŞİMİ canlı olarak arayüze yansımalıdır").
   */
  public async setDeviceState(deviceId: string, state: 'ONLINE' | 'OFFLINE'): Promise<boolean> {
    const key = `device:${deviceId}:state`;
    try {
      const previous = await this.getDeviceState(deviceId);
      if (state === 'ONLINE') {
        await this.client.set(key, 'ONLINE', 'EX', DEVICE_PRESENCE_TTL_SECONDS);
      } else {
        await this.client.del(key);
      }
      const changed = previous !== state;
      if (changed) {
        logger.info({ deviceId, previous, state }, `🔌 [IoT] Cihaz durum GEÇİŞİ: ${previous} → ${state}`);
      }
      return changed;
    } catch (err) {
      logger.error({ err, deviceId }, '🚨 [IoT] Cihaz durumu Redis\'e yazılamadı.');
      return false;
    }
  }

  /**
   * Cihazın son bilinen durumunu okur. Cihaz hiç MQTT verisi/LWT mesajı
   * göndermemişse (örn. henüz hiç bağlanmamış donanım) anahtar hiç yoktur —
   * bu durumda OFFLINE varsayılır (gerçek durumu yansıtır, "hayali ONLINE"
   * göstermek yerine).
   */
  public async getDeviceState(deviceId: string): Promise<'ONLINE' | 'OFFLINE'> {
    try {
      const state = await this.client.get(`device:${deviceId}:state`);
      return state === 'ONLINE' ? 'ONLINE' : 'OFFLINE';
    } catch (err) {
      logger.error({ err, deviceId }, '🚨 [IoT] Cihaz durumu Redis\'ten okunamadı.');
      return 'OFFLINE';
    }
  }

  /**
   * FUEL-403.1 — genel amaçlı JSON cache yardımcıları (cache-aside deseni).
   * `redisPool.client`'a doğrudan erişmek yerine tipli + hatası yutulan
   * (cache erişilemezse null/no-op → çağıran DB'ye düşer, istek DÜŞMEZ)
   * bir sarmalayıcı. Her key MUTLAKA TTL ile yazılır.
   */
  public async cacheGetJson<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (err) {
      logger.warn({ err, key }, '⚠️ [Redis] cache okuma hatası — DB fallback.');
      return null;
    }
  }

  public async cacheSetJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      logger.warn({ err, key }, '⚠️ [Redis] cache yazma hatası — atlandı.');
    }
  }

  public async cacheDel(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (err) {
      logger.warn({ err, key }, '⚠️ [Redis] cache invalidasyon hatası.');
    }
  }

  /**
   * Bağlantıyı güvenli bir şekilde kapatır
   */
  public async close(): Promise<void> {
    await this.client.quit();
    logger.info('🔌 [Redis] Bağlantı kapatıldı.');
  }
}

// Singleton instance
export const redisPool = new RedisManager();
