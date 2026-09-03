import rateLimit from 'express-rate-limit';
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
