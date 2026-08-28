import jwt from 'jsonwebtoken';
import crypto from 'crypto';

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
 * Rotate Refresh Token with Single-Use Enforcement & Theft Reuse Detection
 */
export async function rotateRefreshToken(oldRefreshToken: string, userPayload: JwtUserPayload): Promise<{ accessToken: string; refreshToken: string }> {
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

  // Mark current token as used and revoked (single-use constraint)
  tokenRecord.used = true;
  tokenRecord.isRevoked = true;

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
