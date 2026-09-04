import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../config/env';
import { redisPool } from '../db/redisPool';

/**
 * SECURITY: no hardcoded fallback. A default secret baked into source control
 * means anyone who reads the repo can forge valid access/refresh tokens for
 * any tenant/role. ARCH-110'dan önce bu dosya kendi requireSecret() fail-fast
 * kontrolünü yapıyordu; artık bu doğrulama tek bir yerde, config/env.ts'te
 * (Zod şeması) — burası yalnızca doğrulanmış değeri okuyor. (Yine de
 * `./bootstrap.ts`'in process entry point olması gerekir ki `.env`,
 * config/env.ts değerlendirilmeden önce yüklensin — bkz. bootstrap.ts.)
 */
const JWT_SECRET = config.JWT_SECRET;
const JWT_REFRESH_SECRET = config.JWT_REFRESH_SECRET;

export type UserRole = 'SUPER_ADMIN' | 'COMPANY_OWNER' | 'SITE_MANAGER' | 'PUMP_OPERATOR' | 'DRIVER';

export interface JwtUserPayload {
  userId: string;
  tenantId: string;
  username: string;
  role: UserRole;
  siteName?: string;
  // AUTH-204: true iken authenticateJWT, /auth/change-password dışındaki
  // TÜM istekleri 403 PASSWORD_CHANGE_REQUIRED ile reddeder (bkz.
  // middleware/authMiddleware.ts). Parola değiştirilince yeniden login/
  // token rotasyonuyla false olarak yeniden basılır.
  mustChangePassword?: boolean;
}

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  tenantId: string;
  used: boolean;
  isRevoked: boolean;
  createdAt: string;
  expiresAt: string;
}

/**
 * Token Rotation & Reuse Detection Store — Redis-backed (survives restarts,
 * shared across all backend instances behind a load balancer).
 *
 * Previously this was a process-local `Map`, which meant every restart
 * silently logged everyone out, and — worse — with more than one backend
 * instance running (the "zero-downtime rolling update" the roadmap calls
 * for), a token rotated on instance A would not exist on instance B, so a
 * legitimate refresh could be misdiagnosed as token theft.
 *
 * `refresh_token:{jti}` → JSON RefreshTokenRecord, TTL = REFRESH_TOKEN_TTL_SECONDS
 *   (Redis expires it automatically — no manual cleanup job needed).
 * `refresh_tokens_by_user:{userId}` → Set of jti's issued to that user, used
 *   only to support "revoke every session" on reuse detection / logout-all.
 */
const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days — matches the JWT's own expiresIn
const USER_INDEX_TTL_SECONDS = 30 * 24 * 60 * 60; // sliding window, comfortably outlives any single token

function refreshTokenKey(jti: string): string {
  return `refresh_token:${jti}`;
}

function userTokenIndexKey(userId: string): string {
  return `refresh_tokens_by_user:${userId}`;
}

/**
 * Generate a 15-minute JWT Access Token
 */
export function generateAccessToken(user: JwtUserPayload): string {
  return jwt.sign(
    {
      userId: user.userId,
      tenantId: user.tenantId,
      username: user.username,
      role: user.role,
      siteName: user.siteName,
      mustChangePassword: user.mustChangePassword ?? false
    },
    JWT_SECRET,
    { expiresIn: '15m' }
  );
}

/**
 * Generate a 7-day single-use JWT Refresh Token and register it in Redis
 */
export async function generateRefreshToken(userId: string, tenantId: string): Promise<string> {
  const tokenId = crypto.randomUUID();
  const token = jwt.sign(
    { jti: tokenId, userId, tenantId },
    JWT_REFRESH_SECRET,
    { expiresIn: '7d' }
  );

  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000);

  const record: RefreshTokenRecord = {
    id: tokenId,
    userId,
    tenantId,
    used: false,
    isRevoked: false,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString()
  };

  const multi = redisPool.client.multi();
  multi.set(refreshTokenKey(tokenId), JSON.stringify(record), 'EX', REFRESH_TOKEN_TTL_SECONDS);
  multi.sadd(userTokenIndexKey(userId), tokenId);
  multi.expire(userTokenIndexKey(userId), USER_INDEX_TTL_SECONDS);
  await multi.exec();

  return token;
}

/**
 * Rotate Refresh Token with Single-Use Enforcement & Theft Reuse Detection
 *
 * SECURITY: the caller MUST NOT be able to dictate whose identity the new tokens
 * carry. `fetchUserPayload` is invoked with the userId/tenantId embedded in the
 * (cryptographically verified) old refresh token record and must resolve the
 * CURRENT identity from the database — never accept a payload from the request.
 */
export async function rotateRefreshToken(
  oldRefreshToken: string,
  fetchUserPayload: (userId: string, tenantId: string) => Promise<JwtUserPayload | null>
): Promise<{ accessToken: string; refreshToken: string }> {
  let decoded: any;
  try {
    decoded = jwt.verify(oldRefreshToken, JWT_REFRESH_SECRET);
  } catch (err) {
    throw new Error('INVALID_REFRESH_TOKEN: Geçersiz veya süresi dolmuş refresh token.');
  }

  const tokenId = decoded.jti;
  const raw = await redisPool.client.get(refreshTokenKey(tokenId));
  const tokenRecord: RefreshTokenRecord | null = raw ? JSON.parse(raw) : null;

  // Theft Detection: Token is not in store (expired/never existed) OR already used/revoked
  if (!tokenRecord || tokenRecord.used || tokenRecord.isRevoked) {
    // Revoke ALL active sessions for this user immediately!
    await revokeAllUserTokens(decoded.userId);
    throw new Error('TOKEN_REUSE_DETECTED: Şüpheli çoklu token kullanımı tespit edildi! Tüm aktif oturumlarınız güvenlik nedeniyle kapatıldı.');
  }

  // Mark current token as used and revoked (single-use constraint).
  // KEEPTTL preserves the key's remaining expiry instead of resetting it.
  tokenRecord.used = true;
  tokenRecord.isRevoked = true;
  await redisPool.client.set(refreshTokenKey(tokenId), JSON.stringify(tokenRecord), 'KEEPTTL');

  // Re-resolve the REAL, current identity from the database using the token
  // record's own userId/tenantId — never trust a caller-supplied payload.
  const userPayload = await fetchUserPayload(tokenRecord.userId, tokenRecord.tenantId);
  if (!userPayload) {
    throw new Error('INVALID_REFRESH_TOKEN: Kullanıcı artık mevcut değil veya devre dışı bırakılmış.');
  }

  // Issue new Access Token (15 min) and new Refresh Token (7 days)
  const newAccessToken = generateAccessToken(userPayload);
  const newRefreshToken = await generateRefreshToken(userPayload.userId, userPayload.tenantId);

  return {
    accessToken: newAccessToken,
    refreshToken: newRefreshToken
  };
}

/**
 * Verify Access Token
 */
export function verifyAccessToken(token: string): JwtUserPayload {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    return {
      userId: decoded.userId,
      tenantId: decoded.tenantId,
      username: decoded.username,
      role: decoded.role,
      siteName: decoded.siteName,
      mustChangePassword: decoded.mustChangePassword ?? false
    };
  } catch (err) {
    throw new Error('UNAUTHORIZED: Geçersiz veya süresi dolmuş access token.');
  }
}

/**
 * Revoke a single refresh token (Logout)
 */
export async function revokeRefreshToken(token: string): Promise<void> {
  try {
    const decoded = jwt.verify(token, JWT_REFRESH_SECRET) as any;
    const key = refreshTokenKey(decoded.jti);
    const raw = await redisPool.client.get(key);
    if (raw) {
      const record: RefreshTokenRecord = JSON.parse(raw);
      record.isRevoked = true;
      await redisPool.client.set(key, JSON.stringify(record), 'KEEPTTL');
    }
  } catch (err) {
    // Token already expired or invalid — nothing to revoke
  }
}

/**
 * Revoke all tokens for a user (Used in Token Reuse Detection / Account Lock)
 */
export async function revokeAllUserTokens(userId: string): Promise<void> {
  const indexKey = userTokenIndexKey(userId);
  const tokenIds = await redisPool.client.smembers(indexKey);
  if (tokenIds.length === 0) return;

  const keys = tokenIds.map(refreshTokenKey);
  const rawRecords = await redisPool.client.mget(...keys);

  const multi = redisPool.client.multi();
  rawRecords.forEach((raw, idx) => {
    if (!raw) return; // already expired naturally — nothing to revoke
    const record: RefreshTokenRecord = JSON.parse(raw);
    record.isRevoked = true;
    record.used = true;
    multi.set(keys[idx], JSON.stringify(record), 'KEEPTTL');
  });
  await multi.exec();
}
