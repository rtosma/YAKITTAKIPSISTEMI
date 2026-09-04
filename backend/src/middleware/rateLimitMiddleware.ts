import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { Request, Response } from 'express';
import { redisPool } from '../db/redisPool';

/**
 * RES-901/AUTH-201 hardening: `/auth/login` had NO rate limiting at all —
 * an attacker could brute-force Argon2id-hashed passwords with unlimited
 * requests. Backed by Redis (not an in-memory Map) so the limit is shared
 * across every backend instance behind a load balancer and survives restarts,
 * for the same reason the refresh-token store was moved to Redis.
 *
 * Keyed by IP address: 10 attempts per 15-minute window is generous enough
 * for a genuine user who mistypes a password a few times, while making
 * brute-forcing an Argon2id hash impractical over the network.
 */
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 dakika
  limit: 10,
  standardHeaders: true, // RateLimit-* yanıt başlıkları
  legacyHeaders: false,
  store: new RedisStore({
    prefix: 'rl:auth-login:',
    sendCommand: (...args: string[]) => (redisPool.client.call as (...a: string[]) => Promise<any>)(...args)
  }),
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      success: false,
      error: 'TOO_MANY_REQUESTS',
      message: 'Çok fazla başarısız giriş denemesi. Lütfen 15 dakika sonra tekrar deneyin.'
    });
  }
});

/**
 * AUTH-209 — `/auth/refresh` login ile aynı IP-bazlı istismar riskini taşır
 * (rate limitsiz bir uç, brute-force veya kaynak tüketim saldırısı için
 * açık kapı) ama login'den daha sık meşru kullanım görür (her erişim
 * token'ı süresi dolduğunda tetiklenir) — bu yüzden limiti daha gevşek.
 */
export const refreshRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({
    prefix: 'rl:auth-refresh:',
    sendCommand: (...args: string[]) => (redisPool.client.call as (...a: string[]) => Promise<any>)(...args)
  }),
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      success: false,
      error: 'TOO_MANY_REQUESTS',
      message: 'Çok fazla token yenileme denemesi. Lütfen bir süre sonra tekrar deneyin.'
    });
  }
});

/**
 * AUTH-209 — "Cihaz uçları için ayrı, daha yüksek limitler (telemetri
 * saniyede yüzlerce istek üretir)". Login'deki gibi IP bazlı DEĞİL, cihaz
 * kimliği bazlı: sahadaki cihazlar genelde tek bir 4G IP'si arkasında
 * kümelenir (bkz. loginRateLimiter'ın aynı sorunu), IP bazlı bir limit tüm
 * şantiyenin telemetrisini birbirine karıştırıp tek limite tıkardı. Cihaz
 * kimliği henüz hardwareAuthMiddleware tarafından doğrulanmamış olabilir —
 * buradaki amaç kimlik doğrulaması değil, iddia edilen kimlik başına adil
 * bir üst sınır koymak (hardwareAuthMiddleware zaten ayrıca HMAC + nonce ile
 * gerçek doğrulamayı yapıyor).
 */
export const hardwareRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 dakika
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  // req.ip fallback'i IPv6 için ipKeyGenerator() helper'ından GEÇMELİ —
  // aksi halde bir IPv6 adresinin /64 bloğundaki farklı istemciler
  // (aynı kullanıcının farklı IPv6 adresleri) ayrı ayrı limit kazanıp
  // limiti fiilen bypass edebilir (bkz. ERR_ERL_KEY_GEN_IPV6).
  keyGenerator: (req: Request) => (req.headers['x-device-id'] as string) || ipKeyGenerator(req.ip || 'unknown-device'),
  store: new RedisStore({
    prefix: 'rl:hardware:',
    sendCommand: (...args: string[]) => (redisPool.client.call as (...a: string[]) => Promise<any>)(...args)
  }),
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      success: false,
      error: 'TOO_MANY_REQUESTS',
      message: 'Cihaz için istek limiti aşıldı. Lütfen bir süre sonra tekrar deneyin.'
    });
  }
});
