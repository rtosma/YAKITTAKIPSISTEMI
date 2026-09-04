import { redisPool } from '../db/redisPool';
import { logger } from '../utils/logger';

/**
 * AUTH-209 — hesap bazlı brute-force kilitleme.
 *
 * `loginRateLimiter` (rateLimitMiddleware.ts) yalnızca IP bazlıdır ve
 * ticket'ın kendi notunun işaret ettiği gibi tek başına yanlış: bir
 * şantiye genelde tek bir 4G IP'si arkasındadır, IP bazlı limit orada
 * çalışan HERKESİ kilitler. Bu modül tamamen KULLANICI ADI bazlı, IP'den
 * bağımsız ikinci bir katman ekler — aynı IP'deki farklı kullanıcılar
 * birbirini asla kilitlemez, çünkü sayaçlar yalnızca username ile anahtarlanır.
 *
 * Var olmayan bir kullanıcı adı da GERÇEK bir hesap gibi sayaçlanır/kilitlenir
 * (routes.ts'teki auth/login handler'ı buna dikkat eder) — aksi halde
 * "kilitli" ile "yanlış şifre" yanıtları arasındaki fark, hangi kullanıcı
 * adlarının gerçekten var olduğunu sızdırırdı.
 */

const MAX_FAILED_ATTEMPTS = 5;
// Ardışık sayılan başarısız denemeler için pencere — bu süre içinde 5. hataya
// ulaşılmazsa sayaç kendiliğinden sıfırlanır (Redis TTL ile).
const FAILURE_WINDOW_SECONDS = 15 * 60;
const BASE_LOCKOUT_SECONDS = 15 * 60;
// Üstel artış sınırsız büyümesin diye bir tavan (aksi halde bir saldırgan
// meşru kullanıcıyı kasıtlı olarak günlerce kilitli tutabilir).
const MAX_LOCKOUT_SECONDS = 4 * 60 * 60;
// Kaç kez üst üste kilitlendiğini (strike) hatırlama penceresi — üstel süre
// bu pencere içindeki kilitlenme sayısına göre büyür.
const STRIKES_TTL_SECONDS = 24 * 60 * 60;

function failKey(username: string): string {
  return `login-fail:${username}`;
}
function lockKey(username: string): string {
  return `login-lock:${username}`;
}
function strikesKey(username: string): string {
  return `login-lock-strikes:${username}`;
}

export interface LockoutStatus {
  locked: boolean;
  remainingSeconds?: number;
}

/** Girişten ÖNCE çağrılır — hesap kilitliyse Argon2'nin CPU maliyetine hiç girmeden 423 döndürülebilir. */
export async function checkLockout(username: string): Promise<LockoutStatus> {
  const ttl = await redisPool.client.ttl(lockKey(username));
  if (ttl > 0) {
    return { locked: true, remainingSeconds: ttl };
  }
  return { locked: false };
}

/**
 * Başarısız bir giriş denemesinden sonra çağrılır. Eşiğe (5) ulaşılırsa
 * hesabı üstel artan bir süreyle (15dk → 30dk → 1sa → ... → 4sa tavan)
 * kilitler ve alarm seviyesinde loglar.
 */
export async function recordFailedLogin(username: string): Promise<LockoutStatus> {
  const key = failKey(username);
  const count = await redisPool.client.incr(key);
  if (count === 1) {
    await redisPool.client.expire(key, FAILURE_WINDOW_SECONDS);
  }

  if (count < MAX_FAILED_ATTEMPTS) {
    return { locked: false };
  }

  const strikes = await redisPool.client.incr(strikesKey(username));
  if (strikes === 1) {
    await redisPool.client.expire(strikesKey(username), STRIKES_TTL_SECONDS);
  }
  const durationSeconds = Math.min(BASE_LOCKOUT_SECONDS * 2 ** (strikes - 1), MAX_LOCKOUT_SECONDS);

  await redisPool.client.set(lockKey(username), '1', 'EX', durationSeconds);
  await redisPool.client.del(key); // kilit süresi korumayı üstlendiği için sayaca artık gerek yok

  logger.error(
    { username, strikes, durationSeconds },
    `🚨 [AUTH-209] ALARM: '${username}' hesabı ${MAX_FAILED_ATTEMPTS} ardışık hatalı denemeden sonra ${durationSeconds}sn kilitlendi (${strikes}. kilitlenme).`
  );

  return { locked: true, remainingSeconds: durationSeconds };
}

/** Başarılı bir girişten sonra çağrılır — birikmiş başarısız deneme sayacını temizler. */
export async function clearFailedLogins(username: string): Promise<void> {
  await redisPool.client.del(failKey(username));
}
