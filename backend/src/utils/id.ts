/**
 * `tenantDb.ts`/`adminDb.ts`'te 8 ayrı yerde tekrarlanan `'<prefix>-' + Date.now()`
 * kalıbını tekilleştirir. Üretim ortamında gerçek bir UUID/ULID'ye geçmek
 * istenirse tek değişiklik noktası burası olur (bkz. tenantDb.ts'teki
 * "In production, use UUID or better ID generation" yorumu).
 */
export function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}`;
}
