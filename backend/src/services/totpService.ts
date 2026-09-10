import crypto from 'crypto';

/**
 * AUTH-207 — RFC 6238 TOTP + kurtarma kodları.
 *
 * Bilinçli sapma: ticket "otplib + qrcode" öneriyor. TOTP tek bir HMAC-SHA1
 * hesabı (RFC 6238) — bir kütüphane gerektirmez; qrcode üretimi de sunucuda
 * gereksiz: standart `otpauth://` URI döndürülür, istemci QR'ı kendisi çizer
 * (Google Authenticator / 1Password / Authy hepsi bu URI'yi okur). Kurtarma
 * kodları argon2 ile hash'lenir (utils/password.ts, parola ile aynı KDF).
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Geçersiz base32 karakteri.');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 20 baytlık (160 bit) rastgele bir TOTP sırrı, base32 kodlanmış. */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  // 64-bit big-endian sayaç (JS number 2^53'e kadar güvenli — 30 sn'lik
  // adımlarla ~9 milyon yıl yeter).
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/** Belirtilen an için (varsayılan: şimdi) TOTP kodu. */
export function totpAt(secretBase32: string, atMs: number = Date.now()): string {
  return hotp(base32Decode(secretBase32), Math.floor(atMs / 1000 / TOTP_STEP_SECONDS));
}

/**
 * Kodu ±`window` zaman adımı toleransıyla doğrular (Kritik Not: "±1 zaman
 * penceresi tolerans tanınmalıdır"). Sabit-zamanlı karşılaştırma.
 */
export function verifyTotp(secretBase32: string, code: string, window = 1): boolean {
  const normalized = (code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(normalized)) return false;
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
  for (let i = -window; i <= window; i++) {
    const candidate = hotp(secret, counter + i);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(normalized))) return true;
  }
  return false;
}

/** `otpauth://totp/Issuer:account?secret=...&issuer=Issuer` — QR için standart. */
export function buildOtpauthUri(secretBase32: string, accountLabel: string, issuer = 'Yakittakip'): string {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS)
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** N adet, `XXXX-XXXX` biçiminde okunur kurtarma kodu (düz metin — bir kez gösterilir). */
export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(4).toString('hex').toUpperCase(); // 8 hex
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }
  return codes;
}

/** Kurtarma kodunu normalize eder (tire/boşluk/harf büyüklüğü toleransı). */
export function normalizeRecoveryCode(code: string): string {
  return (code || '').toUpperCase().replace(/[^0-9A-F]/g, '');
}
