import crypto from 'crypto';
import { redisPool } from '../db/redisPool';
import { hashPassword } from '../utils/password';
import { logger } from '../utils/logger';
import { BadRequestError } from '../utils/errors';
import { findUserForPasswordReset, updateUserPasswordHash } from '../db/adminDb';
import { revokeAllUserTokens } from './tokenService';
import { clearFailedLogins } from './accountLockoutService';

/**
 * AUTH-206 — "şifremi unuttum" akışı.
 *
 * Teknik yığın: node:crypto + ioredis TTL + argon2 (ticket'ın önerdiği gibi).
 *
 * Bilinçli sapma: ticket "bildirim modülü ile e-posta/SMS" diyor — bu kod
 * tabanında bir bildirim modülü YOK ve `users` tablosunda e-posta/telefon
 * alanı da yok (bkz. schema.sql). Bu yüzden token ÜRETİLİR ve HASH'İ Redis'e
 * TTL ile yazılır; gerçek iletim #159 (e-posta kanalı) tamamlanınca eklenir.
 * O zamana kadar üretim-DIŞI ortamlarda token, forgot-password yanıtında
 * `devResetToken` olarak döner (routes.ts) — üretimde ASLA dönmez.
 *
 * Güvenlik değişmezleri:
 *  - Token ham HALİYLE saklanmaz — yalnızca SHA-256 hash'i Redis anahtarıdır.
 *  - 30 dakika TTL (AC 1).
 *  - TEK KULLANIMLIK: kullanılır kullanılmaz `GETDEL` ile atomik silinir —
 *    eşzamanlı ikinci kullanım başarısız olur (AC 1).
 *  - forgot-password her durumda AYNI yanıtı verir; kullanıcının var olup
 *    olmadığı sızdırılmaz (AC 2 — çağıran route'ta).
 *  - Sıfırlama sonrası kullanıcının TÜM oturumları (refresh token'ları)
 *    iptal edilir (AC 3).
 */

const RESET_TTL_SECONDS = 30 * 60;
const tokenKey = (tokenHash: string) => `pwreset:token:${tokenHash}`;
const userPointerKey = (userId: string) => `pwreset:user:${userId}`;

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

interface ResetTokenPayload {
  userId: string;
  username: string;
  createdAt: string;
}

/**
 * Kullanıcı varsa yeni bir sıfırlama token'ı üretir ve hash'ini TTL ile
 * saklar; önceki (kullanılmamış) token'ı geçersiz kılar. Kullanıcı yoksa
 * `null` döner — çağıran yine de jenerik başarı yanıtı vermelidir.
 */
export async function requestPasswordReset(username: string): Promise<string | null> {
  const user = await findUserForPasswordReset(username);
  if (!user) {
    // Kullanıcı numaralandırmasını (enumeration) zamanlamayla bile açık
    // etmemek için burada da bir Argon2 maliyeti kadar bekleyen sahte bir iş
    // yapmıyoruz — token üretimi (randomBytes + sha256 + Redis) zaten
    // sub-milisaniye; asıl koruma sabit yanıt + rate limit.
    logger.info({ username }, 'ℹ️ [AUTH-206] Var olmayan kullanıcı için şifre sıfırlama talebi (sessizce yok sayıldı).');
    return null;
  }

  const token = crypto.randomBytes(32).toString('hex'); // 64 hex karakter
  const tokenHash = sha256Hex(token);
  const payload: ResetTokenPayload = { userId: user.id, username: user.username, createdAt: new Date().toISOString() };

  // Önceki token'ı geçersiz kıl (bir kullanıcının aynı anda birden fazla
  // aktif sıfırlama token'ı olmasın).
  const prevHash = await redisPool.cacheGetJson<string>(userPointerKey(user.id));
  if (prevHash) await redisPool.cacheDel(tokenKey(prevHash));

  await redisPool.cacheSetJson(tokenKey(tokenHash), payload, RESET_TTL_SECONDS);
  await redisPool.cacheSetJson(userPointerKey(user.id), tokenHash, RESET_TTL_SECONDS);

  logger.info({ userId: user.id }, '🔑 [AUTH-206] Şifre sıfırlama token\'ı üretildi (30 dk).');
  return token;
}

/**
 * Token'ı TEK KULLANIMLIK olarak tüketir (atomik GETDEL). Geçerliyse
 * `{ userId, username }` döner; geçersiz/süresi dolmuş/zaten kullanılmışsa
 * `null`.
 */
async function consumeResetToken(token: string): Promise<ResetTokenPayload | null> {
  const key = tokenKey(sha256Hex(token));
  let raw: string | null;
  try {
    // ioredis: GETDEL (Redis ≥ 6.2 — compose redis:7-alpine). Atomik:
    // "oku ve sil" tek komut → yarış durumu yok.
    raw = await (redisPool.client as unknown as { getdel(k: string): Promise<string | null> }).getdel(key);
  } catch {
    // GETDEL yoksa (çok eski Redis) güvenli fallback — atomik değil ama
    // pratikte bu ortamda erişilmez.
    raw = await redisPool.client.get(key);
    if (raw) await redisPool.client.del(key);
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ResetTokenPayload;
  } catch {
    return null;
  }
}

/**
 * Token + yeni parola ile sıfırlamayı tamamlar:
 *  1. token'ı tüket (tek kullanımlık),
 *  2. yeni parolayı Argon2id ile hash'leyip yaz (geçici-parola bayraklarını temizle),
 *  3. kullanıcının TÜM refresh token'larını iptal et (AC 3),
 *  4. hesap kilitleme sayaçlarını temizle (kullanıcı kontrolü kanıtladı),
 *  5. kullanıcı işaretçisini sil.
 * Token geçersizse BadRequestError (jenerik mesaj — sızıntı yok).
 */
export async function finalizePasswordReset(token: string, newPassword: string): Promise<void> {
  const payload = await consumeResetToken(token);
  if (!payload) {
    throw new BadRequestError('Geçersiz veya süresi dolmuş şifre sıfırlama bağlantısı. Lütfen yeni bir talep oluşturun.');
  }

  const passwordHash = await hashPassword(newPassword);
  await updateUserPasswordHash(payload.userId, passwordHash);
  await revokeAllUserTokens(payload.userId);
  await clearFailedLogins(payload.username);
  await redisPool.cacheDel(userPointerKey(payload.userId));

  logger.warn({ userId: payload.userId }, '🔐 [AUTH-206] Parola sıfırlandı — tüm oturumlar iptal edildi.');
}
