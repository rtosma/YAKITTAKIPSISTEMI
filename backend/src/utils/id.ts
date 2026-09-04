import crypto from 'crypto';

/**
 * `tenantDb.ts`/`adminDb.ts`'te tekrarlanan `'<prefix>-' + Date.now()`
 * kalıbını tekilleştirir. Üretim ortamında gerçek bir UUID/ULID'ye geçmek
 * istenirse tek değişiklik noktası burası olur (bkz. tenantDb.ts'teki
 * "In production, use UUID or better ID generation" yorumu).
 *
 * Yalnızca `Date.now()` YETERSİZ: milisaniye çözünürlüğü var, ve
 * writeAuditLog() gibi aynı işlem içinde art arda birden fazla kayıt
 * yazan bir çağrı (bkz. createSiteWithManager — SITE_CREATED +
 * USER_PROVISIONED) aynı milisaniyede iki kez çağrılabiliyor, bu da AYNI
 * ID'yi (ve dolayısıyla bir PRIMARY KEY çakışmasını) üretiyordu — bu canlı
 * olarak AUTH-203 testinde yakalandı. Rastgele bir sonek bu riski ortadan
 * kaldırır.
 */
export function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}
