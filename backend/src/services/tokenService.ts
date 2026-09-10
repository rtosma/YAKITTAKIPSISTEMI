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
  // AUTH-208: bu access token'ın ait olduğu oturum (refresh token ailesi)
  // kimliği. authenticateJWT, uzaktan kapatılan oturumların access
  // token'larını `denied_session:{sid}` deny-list'iyle 15 dk boyunca da
  // reddedebilsin diye taşınır.
  sid?: string;
}

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  tenantId: string;
  used: boolean;
  isRevoked: boolean;
  createdAt: string;
  expiresAt: string;
  // AUTH-208: oturum = refresh token AİLESİ. Ailenin ilk token'ının jti'si;
  // rotasyonda değişmez, böylece "aktif oturum listesi" her login için TEK
  // satır gösterir (her rotasyon için ayrı satır değil).
  sessionId?: string;
  userAgent?: string;
  ipAddress?: string;
  deviceLabel?: string;
  lastUsedAt?: string;
}

export interface ActiveSessionInfo {
  sessionId: string;
  deviceLabel: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastUsedAt: string;
}

/**
 * AUTH-208 — kaba ama bağımlılıksız User-Agent → okunur cihaz etiketi
 * ("Chrome · Windows", "Safari · iOS", "curl", ...). ua-parser-js (ticket'ın
 * önerdiği) tüm bir tarayıcı/OS veritabanı taşır; oturum listesinde tek
 * gereken kullanıcının cihazını tanıyabilmesi, o yüzden hafif bir eşleme.
 */
export function deviceLabelFromUA(ua: string | null | undefined): string {
  if (!ua || !ua.trim()) return 'Bilinmeyen cihaz';
  const s = ua.toLowerCase();
  const browser =
    s.includes('edg/') ? 'Edge' :
    s.includes('opr/') || s.includes('opera') ? 'Opera' :
    s.includes('firefox') ? 'Firefox' :
    s.includes('chrome') && !s.includes('chromium') ? 'Chrome' :
    s.includes('chromium') ? 'Chromium' :
    s.includes('safari') ? 'Safari' :
    s.includes('curl') ? 'curl' :
    s.includes('postman') ? 'Postman' :
    s.includes('okhttp') ? 'Android uygulaması' :
    s.includes('node') || s.includes('undici') || s.includes('axios') ? 'Sunucu/istemci' :
    null;
  const os =
    s.includes('windows') ? 'Windows' :
    s.includes('iphone') || s.includes('ipad') || s.includes('ios') ? 'iOS' :
    s.includes('android') ? 'Android' :
    s.includes('mac os') || s.includes('macintosh') ? 'macOS' :
    s.includes('linux') ? 'Linux' :
    null;
  if (browser && os) return `${browser} · ${os}`;
  if (browser) return browser;
  if (os) return os;
  return ua.length > 40 ? `${ua.slice(0, 40)}…` : ua;
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
// AUTH-208: uzaktan kapatılan bir oturumun HÂLÂ geçerli olabilecek access
// token'ı (en fazla 15 dk ömürlü) için deny-list TTL'i — access token
// ömrüne eşit, dolduğunda zaten token da geçersiz.
const SESSION_DENYLIST_TTL_SECONDS = 15 * 60;

function refreshTokenKey(jti: string): string {
  return `refresh_token:${jti}`;
}

function userTokenIndexKey(userId: string): string {
  return `refresh_tokens_by_user:${userId}`;
}

function deniedSessionKey(sid: string): string {
  return `denied_session:${sid}`;
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
      mustChangePassword: user.mustChangePassword ?? false,
      ...(user.sid ? { sid: user.sid } : {})
    },
    JWT_SECRET,
    { expiresIn: '15m' }
  );
}

export interface GeneratedRefreshToken {
  token: string;
  jti: string;
  sessionId: string;
}

/**
 * Generate a 7-day single-use JWT Refresh Token and register it in Redis.
 *
 * AUTH-208: `meta.sessionId` verilirse token o oturum AİLESİNE katılır
 * (rotasyon) — verilmezse yeni bir aile başlatır (login). Cihaz/IP bilgisi
 * "aktif oturum listesi" için kaydedilir.
 */
export async function generateRefreshToken(
  userId: string,
  tenantId: string,
  meta?: { userAgent?: string | null; ipAddress?: string | null; sessionId?: string; createdAt?: string; deviceLabel?: string }
): Promise<GeneratedRefreshToken> {
  const tokenId = crypto.randomUUID();
  const token = jwt.sign(
    { jti: tokenId, userId, tenantId },
    JWT_REFRESH_SECRET,
    { expiresIn: '7d' }
  );

  const now = new Date();
  const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000);
  const sessionId = meta?.sessionId ?? tokenId;
  const createdAt = meta?.createdAt ?? now.toISOString();

  const record: RefreshTokenRecord = {
    id: tokenId,
    userId,
    tenantId,
    used: false,
    isRevoked: false,
    createdAt,
    expiresAt: expiresAt.toISOString(),
    sessionId,
    userAgent: meta?.userAgent ?? undefined,
    ipAddress: meta?.ipAddress ?? undefined,
    deviceLabel: meta?.deviceLabel ?? deviceLabelFromUA(meta?.userAgent),
    lastUsedAt: now.toISOString()
  };

  const multi = redisPool.client.multi();
  multi.set(refreshTokenKey(tokenId), JSON.stringify(record), 'EX', REFRESH_TOKEN_TTL_SECONDS);
  multi.sadd(userTokenIndexKey(userId), tokenId);
  multi.expire(userTokenIndexKey(userId), USER_INDEX_TTL_SECONDS);
  await multi.exec();

  return { token, jti: tokenId, sessionId };
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
  fetchUserPayload: (userId: string, tenantId: string) => Promise<JwtUserPayload | null>,
  meta?: { userAgent?: string | null; ipAddress?: string | null }
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

  // Theft Detection: token kaybolmuş (süresi dolmuş/hiç olmamış) VEYA daha önce
  // KULLANILMIŞ (harcanmış bir token'ın tekrar oynatılması) → gerçek şüphe:
  // kullanıcının TÜM oturumları kapatılır.
  if (!tokenRecord || tokenRecord.used) {
    await revokeAllUserTokens(decoded.userId);
    throw new Error('TOKEN_REUSE_DETECTED: Şüpheli çoklu token kullanımı tespit edildi! Tüm aktif oturumlarınız güvenlik nedeniyle kapatıldı.');
  }

  // AUTH-208: token harcanmamış ama AÇIKÇA iptal edilmiş (uzaktan oturum
  // kapatma veya logout) → bu bir hırsızlık göstergesi DEĞİL; yalnızca BU
  // oturum reddedilir, kullanıcının diğer oturumları etkilenmez.
  if (tokenRecord.isRevoked) {
    throw new Error('SESSION_REVOKED: Bu oturum sonlandırıldı. Lütfen tekrar giriş yapınız.');
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

  // AUTH-208: yeni refresh token AYNI oturuma (aileye) katılır — sessionId,
  // ilk oluşturulma anı ve cihaz etiketi korunur; yalnızca lastUsedAt/IP
  // güncellenir. Böylece "aktif oturum listesi" login başına tek satır kalır.
  const newRefresh = await generateRefreshToken(userPayload.userId, userPayload.tenantId, {
    sessionId: tokenRecord.sessionId ?? tokenId,
    createdAt: tokenRecord.createdAt,
    deviceLabel: tokenRecord.deviceLabel ?? deviceLabelFromUA(tokenRecord.userAgent),
    userAgent: tokenRecord.userAgent ?? meta?.userAgent ?? null,
    ipAddress: meta?.ipAddress ?? tokenRecord.ipAddress ?? null
  });

  // Access token'a oturum kimliğini (sid) göm — deny-list kontrolü için.
  const newAccessToken = generateAccessToken({ ...userPayload, sid: newRefresh.sessionId });

  return {
    accessToken: newAccessToken,
    refreshToken: newRefresh.token
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
      mustChangePassword: decoded.mustChangePassword ?? false,
      sid: decoded.sid
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

// ============================================================================
// AUTH-208: AKTİF OTURUM/CİHAZ LİSTESİ + UZAKTAN OTURUM KAPATMA
// ============================================================================

/** AUTH-208 — access token deny-list kontrolü (authenticateJWT çağırır). */
export async function isSessionDenied(sid: string): Promise<boolean> {
  if (!sid) return false;
  try {
    return (await redisPool.client.exists(deniedSessionKey(sid))) === 1;
  } catch {
    // Redis erişilemezse fail-open: access token zaten 15 dk sonra kendiliğinden
    // düşer; her isteği Redis'e bağımlı kılıp tüm API'yi kilitlemeyiz.
    return false;
  }
}

/** Bir kullanıcının canlı (iptal/kullanılmamış) refresh token'larını okur. */
async function loadLiveRecords(userId: string): Promise<RefreshTokenRecord[]> {
  const ids = await redisPool.client.smembers(userTokenIndexKey(userId));
  if (ids.length === 0) return [];
  const raws = await redisPool.client.mget(...ids.map(refreshTokenKey));
  const live: RefreshTokenRecord[] = [];
  const staleIds: string[] = [];
  raws.forEach((raw, i) => {
    if (!raw) { staleIds.push(ids[i]); return; }
    const rec: RefreshTokenRecord = JSON.parse(raw);
    if (rec.isRevoked || rec.used) return;
    live.push(rec);
  });
  // Doğal olarak süresi dolmuş jti'leri indeks setinden temizle (best-effort).
  if (staleIds.length > 0) redisPool.client.srem(userTokenIndexKey(userId), ...staleIds).catch(() => {});
  return live;
}

/**
 * AUTH-208 — kullanıcının aktif oturumları (refresh token ailesi başına bir
 * satır). `currentSid` verilirse o oturum `current: true` işaretlenir.
 */
export async function listUserSessions(
  userId: string,
  currentSid?: string
): Promise<Array<ActiveSessionInfo & { current: boolean }>> {
  const live = await loadLiveRecords(userId);
  // Aile (sessionId) başına EN GÜNCEL kaydı tut.
  const bySession = new Map<string, RefreshTokenRecord>();
  for (const rec of live) {
    const sid = rec.sessionId ?? rec.id;
    const existing = bySession.get(sid);
    if (!existing || (rec.lastUsedAt ?? rec.createdAt) > (existing.lastUsedAt ?? existing.createdAt)) {
      bySession.set(sid, rec);
    }
  }
  return [...bySession.entries()]
    .map(([sid, rec]) => ({
      sessionId: sid,
      deviceLabel: rec.deviceLabel ?? deviceLabelFromUA(rec.userAgent),
      userAgent: rec.userAgent ?? null,
      ipAddress: rec.ipAddress ?? null,
      createdAt: rec.createdAt,
      lastUsedAt: rec.lastUsedAt ?? rec.createdAt,
      current: !!currentSid && sid === currentSid
    }))
    .sort((a, b) => (a.lastUsedAt < b.lastUsedAt ? 1 : -1));
}

/**
 * AUTH-208 — tek bir oturumu (refresh token ailesinin TÜM jti'leri) iptal
 * eder ve `denied_session:{sessionId}` deny-list'ine ekler (uzaktan
 * kapatılan oturumun HÂLÂ geçerli access token'ı da 15 dk boyunca reddedilir).
 * Döndürdüğü sayı 0 ise böyle bir oturum yoktu (çağıran 404 döner).
 */
export async function revokeSession(userId: string, sessionId: string): Promise<number> {
  const ids = await redisPool.client.smembers(userTokenIndexKey(userId));
  if (ids.length === 0) return 0;
  const raws = await redisPool.client.mget(...ids.map(refreshTokenKey));

  const multi = redisPool.client.multi();
  let matched = 0;
  raws.forEach((raw, i) => {
    if (!raw) return;
    const rec: RefreshTokenRecord = JSON.parse(raw);
    if ((rec.sessionId ?? rec.id) !== sessionId) return;
    matched++;
    if (rec.isRevoked) return; // zaten iptal — deny-list yine de tazelensin
    // NOT: `used` KASITLI olarak set EDİLMİYOR — böylece bu token'la yapılan
    // bir refresh denemesi "harcanmış token tekrar oynatıldı" (hırsızlık →
    // tüm oturumları kapat) yerine yalnızca "bu oturum sonlandırıldı" olarak
    // ele alınır (bkz. rotateRefreshToken). Uzaktan bir oturumu kapatmak,
    // o istemci nazikçe yeniden denediğinde DİĞER oturumları düşürmemeli.
    rec.isRevoked = true;
    multi.set(refreshTokenKey(ids[i]), JSON.stringify(rec), 'KEEPTTL');
  });
  if (matched === 0) return 0;
  multi.set(deniedSessionKey(sessionId), '1', 'EX', SESSION_DENYLIST_TTL_SECONDS);
  await multi.exec();
  return matched;
}

/**
 * AUTH-208 — "Diğer tüm oturumları kapat": `keepSessionId` DIŞINDAKİ her
 * oturumu iptal eder. Kapatılan oturum sayısını döndürür.
 */
export async function revokeOtherSessions(userId: string, keepSessionId: string): Promise<number> {
  const live = await loadLiveRecords(userId);
  const otherSids = new Set<string>();
  for (const rec of live) {
    const sid = rec.sessionId ?? rec.id;
    if (sid !== keepSessionId) otherSids.add(sid);
  }
  for (const sid of otherSids) await revokeSession(userId, sid);
  return otherSids.size;
}
