import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { findAuthUserById } from '../db/userRepository';

const JWT_SECRET = process.env.JWT_SECRET || 'yakittakip_jwt_access_secret_key_2026_super_secure';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'yakittakip_jwt_refresh_secret_key_2026_super_secure';

export type UserRole = 'SUPER_ADMIN' | 'COMPANY_OWNER' | 'SITE_MANAGER' | 'PUMP_OPERATOR' | 'DRIVER';

export interface JwtUserPayload {
  userId: string;
  tenantId: string;
  username: string;
  role: UserRole;
  siteName?: string;
}

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  tenantId: string;
  token: string;
  used: boolean;
  isRevoked: boolean;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Token Rotation & Reuse Detection Store
 * In production this persists to PostgreSQL refresh_tokens or Redis
 */
const refreshTokenStore = new Map<string, RefreshTokenRecord>();

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
      siteName: user.siteName
    },
    JWT_SECRET,
    { expiresIn: '15m' }
  );
}

/**
 * Generate a 7-day single-use JWT Refresh Token and register in rotation store
 */
export function generateRefreshToken(userId: string, tenantId: string): string {
  const tokenId = crypto.randomUUID();
  const token = jwt.sign(
    { jti: tokenId, userId, tenantId },
    JWT_REFRESH_SECRET,
    { expiresIn: '7d' }
  );

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  refreshTokenStore.set(tokenId, {
    id: tokenId,
    userId,
    tenantId,
    token,
    used: false,
    isRevoked: false,
    createdAt: new Date(),
    expiresAt
  });

  return token;
}

/**
 * Atomically consume a refresh token: verify the signature, look the record up,
 * run theft detection, and burn it. Single-use enforcement depends on this
 * entire body running inside ONE synchronous event loop turn.
 *
 * !!! DO NOT MAKE THIS FUNCTION async AND DO NOT ADD await INSIDE IT !!!
 * An await between the reuse check and the used/isRevoked assignment would let
 * two concurrent requests carrying the same token both pass the check, which
 * silently disables single-use rotation AND theft detection. Keeping it a plain
 * (non-async) function turns that mistake into a compile error.
 *
 * Not exported: routes must go through rotateRefreshToken() so the
 * consume-then-load-then-issue ordering can never be reassembled incorrectly.
 *
 * NOTE: this guarantee holds only because refreshTokenStore is an in-process
 * Map and Node is single threaded. Once the store moves to Postgres/Redis, or
 * more than one replica runs, single-use must become an atomic CAS instead
 * (e.g. UPDATE ... SET used = true WHERE id = $1 AND used = false RETURNING *).
 */
function consumeRefreshToken(oldRefreshToken: string): RefreshTokenRecord {
  let decoded: any;
  try {
    decoded = jwt.verify(oldRefreshToken, JWT_REFRESH_SECRET);
  } catch (err) {
    throw new Error('INVALID_REFRESH_TOKEN: Geçersiz veya süresi dolmuş refresh token.');
  }

  const tokenId = decoded.jti;
  const tokenRecord = refreshTokenStore.get(tokenId);

  // Theft Detection: Token is not in store OR token has ALREADY been used/revoked
  if (!tokenRecord || tokenRecord.used || tokenRecord.isRevoked) {
    // Revoke ALL active sessions for this user immediately!
    revokeAllUserTokens(decoded.userId);
    throw new Error('TOKEN_REUSE_DETECTED: Şüpheli çoklu token kullanımı tespit edildi! Tüm aktif oturumlarınız güvenlik nedeniyle kapatıldı.');
  }

  // Defence in depth: the signed claims must agree with the server-written
  // store record. Unreachable today (the claims are signed and the record is
  // written by us); only a corrupted store or a leaked JWT_REFRESH_SECRET can
  // trigger it - in both cases killing every session beats minting a token.
  // Both identities are revoked: we do not know which one is the victim.
  if (decoded.userId !== tokenRecord.userId || decoded.tenantId !== tokenRecord.tenantId) {
    revokeAllUserTokens(tokenRecord.userId);
    if (decoded.userId && decoded.userId !== tokenRecord.userId) {
      revokeAllUserTokens(decoded.userId);
    }
    throw new Error('TOKEN_REUSE_DETECTED: Şüpheli çoklu token kullanımı tespit edildi! Tüm aktif oturumlarınız güvenlik nedeniyle kapatıldı.');
  }

  // Mark current token as used and revoked (single-use constraint)
  tokenRecord.used = true;
  tokenRecord.isRevoked = true;

  return tokenRecord;
}

/**
 * Rotate Refresh Token with Single-Use Enforcement & Theft Reuse Detection.
 *
 * The identity carried by the new access token is derived exclusively from
 * (a) the refresh token's own server-side store record and (b) a fresh `users`
 * row read keyed by that record. It is never taken from the caller - which is
 * why this function takes no payload argument: a caller cannot assert who it is.
 *
 * Reading the row on every rotation is also what makes demotion work: a user
 * downgraded from COMPANY_OWNER to DRIVER stops receiving COMPANY_OWNER access
 * tokens within one access-token lifetime (15 min) instead of never.
 */
export async function rotateRefreshToken(
  oldRefreshToken: string
): Promise<{ accessToken: string; refreshToken: string }> {
  // Step 1 - synchronous, atomic burn. Nothing may be awaited before this returns.
  const tokenRecord = consumeRefreshToken(oldRefreshToken);

  // Step 2 - the first await is only allowed HERE, after the token is consumed.
  const dbUser = await findAuthUserById(tokenRecord.userId, tokenRecord.tenantId);

  if (!dbUser) {
    // User deleted, or userId/tenantId no longer consistent. The token is
    // already burned on purpose: fail closed, never restore `used` - doing so
    // would reopen the check-then-act race. Generic message: naming the reason
    // would leak user existence.
    revokeAllUserTokens(tokenRecord.userId);
    throw new Error('INVALID_REFRESH_TOKEN: Oturumunuz geçersiz. Lütfen tekrar giriş yapınız.');
  }

  const userPayload: JwtUserPayload = {
    userId: dbUser.id,
    tenantId: dbUser.tenant_id,
    username: dbUser.username,
    role: dbUser.role as UserRole,
    siteName: dbUser.site_name || undefined
  };

  // Issue new Access Token (15 min) and new Refresh Token (7 days)
  const newAccessToken = generateAccessToken(userPayload);
  const newRefreshToken = generateRefreshToken(userPayload.userId, userPayload.tenantId);

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
      siteName: decoded.siteName
    };
  } catch (err) {
    throw new Error('UNAUTHORIZED: Geçersiz veya süresi dolmuş access token.');
  }
}

/**
 * Revoke a single refresh token (Logout)
 */
export function revokeRefreshToken(token: string): void {
  try {
    const decoded = jwt.verify(token, JWT_REFRESH_SECRET) as any;
    const tokenRecord = refreshTokenStore.get(decoded.jti);
    if (tokenRecord) {
      tokenRecord.isRevoked = true;
    }
  } catch (err) {
    // Token already expired or invalid
  }
}

/**
 * Revoke all tokens for a user (Used in Token Reuse Detection / Account Lock)
 */
export function revokeAllUserTokens(userId: string): void {
  for (const record of refreshTokenStore.values()) {
    if (record.userId === userId) {
      record.isRevoked = true;
      record.used = true;
    }
  }
}

/**
 * Get active tokens count (For debug/tests)
 */
export function getActiveTokensCount(): number {
  let count = 0;
  for (const record of refreshTokenStore.values()) {
    if (!record.isRevoked && !record.used) count++;
  }
  return count;
}
