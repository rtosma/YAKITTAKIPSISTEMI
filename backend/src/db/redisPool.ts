import Redis from 'ioredis';
import { config } from '../config/env';
import { logger } from '../utils/logger';

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
