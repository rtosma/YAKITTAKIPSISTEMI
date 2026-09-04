import crypto from 'crypto';

/**
 * AUTH-204 — şantiye oluşturulurken otomatik üretilen kullanıcı adı ve
 * geçici parola için yardımcı fonksiyonlar.
 */

const TURKISH_CHAR_MAP: Record<string, string> = {
  ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u',
  Ç: 'c', Ğ: 'g', İ: 'i', Ö: 'o', Ş: 's', Ü: 'u'
};

function slugify(input: string): string {
  return input
    .split('')
    .map((ch) => TURKISH_CHAR_MAP[ch] ?? ch)
    .join('')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 32);
}

/**
 * "Gebze Ana Şantiye" -> "gebzeanasantiye-sef" (site slug + "-sef" = şef,
 * SITE_MANAGER rolünü okunabilir şekilde işaret eder). Çakışma durumunda
 * çağıran taraf (bkz. createSiteWithManager) artan bir sayısal sonek ekler.
 */
export function generateReadableUsername(siteName: string): string {
  const slug = slugify(siteName) || 'santiye';
  return `${slug}-sef`;
}

/**
 * Kriptografik olarak güçlü, insan tarafından okunup elle girilebilecek
 * uzunlukta bir geçici parola üretir. base64url kullanılıyor (+/ gibi
 * URL/form-unsafe karakterler yok) — 9 bayt ham entropi, 12 karaktere kodlanır.
 */
export function generateTempPassword(): string {
  return crypto.randomBytes(9).toString('base64url');
}
