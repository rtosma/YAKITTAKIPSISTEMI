/**
 * COMP-606 (#132) — log ve dış-servis çıktılarında kişisel veri temizleyici.
 *
 * "Loglara TC kimlik no ve telefon yazılmamalıdır; bu, en sık yapılan KVKK ihlalidir." Geliştirici disiplinine
 * güvenilmez: her log satırı buradan geçer (logger.ts `hooks.logMethod`). İki katman:
 *  1. ANAHTAR tabanlı: değeri kişisel veri olan alan adları (tcNo, phone, email, password...) → '[PII]' (derinlikten bağımsız).
 *  2. DEĞER tabanlı: herhangi bir metnin içinde geçen TC Kimlik No (11 hane + resmi sağlama toplamı — rastgele 11 haneli
 *     sayılar yanlış pozitif olmasın), Türkiye telefon numarası ve e-posta adresi maskelenir (hata mesajı, SQL parametresi,
 *     serbest metin, stack trace).
 * Kullanıcı adı ve ad-soyad alanları takma adlaştırılır (kısa özet): korelasyon (aynı kişi) korunur, kimlik açığa çıkmaz.
 */
import crypto from 'crypto';

const PII_KEY = /^(tc_?no|tckn|tc_?kimlik(_?no)?|national_?id|phone|telefon|gsm|mobile|email|e_?mail|password|passwd|new_?password|temp_?password|token|secret|authorization|proxy-authorization|cookie|set-cookie|(access|refresh|id)_?token|api_?key|x-api-key|jwt|x-hardware-signature|x-device-secret|signature)$/i;
const PSEUDONYM_KEY = /^(username|user_?name|driver_?name|full_?name|assigned_?driver_?name|owner_?name)$/i;

/** Resmî TCKN doğrulaması: 11 hane, ilk hane ≠ 0, 10. ve 11. hane sağlama toplamları. */
export function isValidTcNo(s: string): boolean {
  if (!/^[1-9]\d{10}$/.test(s)) return false;
  const d = s.split('').map(Number);
  const tenth = (((d[0] + d[2] + d[4] + d[6] + d[8]) * 7) - (d[1] + d[3] + d[5] + d[7])) % 10;
  const eleventh = d.slice(0, 10).reduce((a, b) => a + b, 0) % 10;
  return d[9] === ((tenth + 10) % 10) && d[10] === eleventh;
}

// +90 5xx xxx xx xx | 0 5xx xxx xx xx | 5xx xxx xx xx (boşluk/tire/nokta/parantez serbest)
const PHONE_RE = /(?<![\d])(?:\+?90[\s.-]?|0[\s.-]?)?\(?5\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}(?![\d])/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// RES-907: JWT (üç parça, base64url) ve `Bearer <token>` — hata metinlerine/URL'lere sızan oturum belirteçleri.
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+\/=-]{12,}/gi;
const TC_RE = /(?<![\d])[1-9]\d{10}(?![\d])/g;

export function pseudonym(value: string): string {
  return `pii:${crypto.createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
}

/** Bir metnin içindeki TCKN/telefon/e-posta'yı maskeler. */
export function scrubString(input: string): string {
  if (input.length < 7) return input;
  return input
    .replace(JWT_RE, '[JWT]')
    .replace(BEARER_RE, 'Bearer [TOKEN]')
    .replace(EMAIL_RE, '[EMAIL]')
    .replace(TC_RE, (m) => (isValidTcNo(m) ? '[TCKN]' : m))
    .replace(PHONE_RE, '[TEL]');
}

const MAX_DEPTH = 6;

export function scrubValue(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[Truncated]';
  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  if (value instanceof Error) {
    // Hata TÜRÜNÜ koru (pino err serileştiricisi constructor adını `type` yapar) — yalnızca metinleri temizle.
    const clone = Object.create(Object.getPrototypeOf(value)) as Error;
    Object.defineProperty(clone, 'message', { value: scrubString(value.message), enumerable: false, writable: true, configurable: true });
    if (value.stack) Object.defineProperty(clone, 'stack', { value: scrubString(value.stack), enumerable: false, writable: true, configurable: true });
    for (const [k, v] of Object.entries(value)) (clone as any)[k] = scrubKeyed(k, v, depth, seen);
    return clone;
  }
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubKeyed(k, v, depth, seen);
  return out;
}

function scrubKeyed(key: string, v: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (v === null || v === undefined) return v;
  if (PII_KEY.test(key)) return '[PII]';
  if (PSEUDONYM_KEY.test(key) && typeof v === 'string') return pseudonym(v);
  return scrubValue(v, depth + 1, seen);
}

/** pino `hooks.logMethod` — her log çağrısının argümanlarını (nesne + mesaj) temizler. */
export function scrubLogArgs(args: unknown[]): unknown[] {
  return args.map((a) => scrubValue(a));
}
