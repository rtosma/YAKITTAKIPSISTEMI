import Redis from 'ioredis';
import { logger } from '../utils/logger';

class RedisManager {
  public client: Redis;

  constructor() {
    this.client = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
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
   * Cihazın durumunu Redis'e kaydeder
   */
  public async setDeviceState(deviceId: string, state: 'ONLINE' | 'OFFLINE'): Promise<void> {
    try {
      await this.client.set(`device:${deviceId}:state`, state);
      logger.info({ deviceId, state }, `🔌 [IoT] Cihaz durumu güncellendi: ${state}`);
    } catch (err) {
      logger.error({ err, deviceId }, '🚨 [IoT] Cihaz durumu Redis\'e yazılamadı.');
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
   * Bağlantıyı güvenli bir şekilde kapatır
   */
  public async close(): Promise<void> {
    await this.client.quit();
    logger.info('🔌 [Redis] Bağlantı kapatıldı.');
  }
}

// Singleton instance
export const redisPool = new RedisManager();
