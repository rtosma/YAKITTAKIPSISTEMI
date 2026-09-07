import dotenv from 'dotenv';
import crypto from 'crypto';

/**
 * Central environment loader and validator.
 *
 * This module MUST be the first thing the process evaluates. index.ts used to
 * call dotenv.config() in its body, but ES module imports are hoisted and
 * evaluated before that body runs - so every module that read process.env at
 * load time (tokenService, postgresPool, redisPool, mqttClient) silently saw an
 * unloaded environment and fell back to its defaults. A .env file simply never
 * applied in local development; it only looked like it worked under Docker,
 * where compose injects real environment variables.
 *
 * Loading dotenv here, and exporting the values other modules need, makes the
 * ordering a dependency of the module graph instead of a convention someone has
 * to remember.
 */
dotenv.config();

export const NODE_ENV = process.env.NODE_ENV || 'development';
export const IS_PRODUCTION = NODE_ENV === 'production';

/**
 * HS256 keys shorter than this are brute-forceable offline. jsonwebtoken itself
 * accepts any non-empty string without complaint, so the floor has to be ours.
 */
const MIN_SECRET_LENGTH = 32;

function fail(message: string): never {
  // Thrown during module evaluation, before registerProcessExceptionHandlers()
  // runs - so Node prints it and exits non-zero instead of the handler (which
  // does not call process.exit) swallowing it and leaving a half-started server.
  throw new Error(
    `\n\n[YAPILANDIRMA HATASI] ${message}\n` +
      `Sunucu güvenli bir şekilde başlatılamadığı için durduruldu.\n` +
      `Yeni bir sır üretmek için: openssl rand -base64 48\n`
  );
}

/**
 * Resolve a signing secret.
 *
 * Production: the variable is mandatory. There is deliberately no fallback -
 * a hard-coded default that reaches production means anyone who can read the
 * repository can mint a token for any tenant and role, which also defeats the
 * RLS tenant isolation (authMiddleware feeds the token's tenantId straight into
 * the RLS session context).
 *
 * Non-production: generate a random secret per boot and say so loudly. This
 * keeps `npm run dev`, `tsx src/index.ts` and CI working with no configuration
 * while leaving no usable secret in the repository. Rotating per boot costs
 * nothing here: refreshTokenStore is an in-process Map, so a restart already
 * invalidates every session.
 */
function resolveSecret(name: 'JWT_SECRET' | 'JWT_REFRESH_SECRET'): string {
  const raw = process.env[name]?.trim();

  if (raw) {
    if (raw.length < MIN_SECRET_LENGTH) {
      fail(`${name} en az ${MIN_SECRET_LENGTH} karakter olmalıdır (şu an ${raw.length}).`);
    }
    return raw;
  }

  if (IS_PRODUCTION) {
    fail(`${name} tanımlı değil. Üretimde bu değişken zorunludur.`);
  }

  const generated = crypto.randomBytes(48).toString('base64url');
  logStartupWarning(name);
  return generated;
}

function logStartupWarning(name: string): void {
  // console on purpose: this has to be readable by a developer scanning the
  // terminal, and it fires before the pino logger is meaningfully configured.
  console.warn(
    `[UYARI] ${name} tanımlı değil; bu açılış için rastgele bir sır üretildi. ` +
      `Süreç yeniden başladığında tüm oturumlar geçersiz olur. ` +
      `Üretimde bu değişken zorunludur.`
  );
}

export const JWT_SECRET = resolveSecret('JWT_SECRET');
export const JWT_REFRESH_SECRET = resolveSecret('JWT_REFRESH_SECRET');

/**
 * Distinct keys are required, not cosmetic. With one shared key a refresh token
 * verifies as an access token: authenticateJWT would accept it and populate the
 * RLS tenant context from it, handing the bearer every JWT-only endpoint
 * (/vehicles, /drivers, /tanks, /sites, /auth/me) without ever logging in.
 */
if (JWT_SECRET === JWT_REFRESH_SECRET) {
  fail('JWT_SECRET ve JWT_REFRESH_SECRET aynı değere sahip olamaz.');
}
