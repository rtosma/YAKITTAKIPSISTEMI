import { PoolClient } from 'pg';
import { getTenantStore } from '../context/tenantContext';
import { generateId } from './id';

/**
 * AUTH-203 — append-only denetim izi.
 *
 * NestJS `@Audited()` dekoratörü/interceptor'ı (ticket'ın "Teknik Yığın"ı)
 * bu kod tabanında yok — Express kullanılıyor. Bunun yerine kritik
 * operasyonların KENDİ transaction'ı içinde açıkça çağrılan düz bir
 * fonksiyon: "audit kaydı yazılamazsa işlem başarısız sayılır" AC'si,
 * çağıranın withTenant() ile açtığı AYNI transaction client'ını burada da
 * kullanmasıyla otomatik sağlanıyor — INSERT başarısız olursa transaction'ın
 * tamamı (kritik operasyon dahil) rollback olur, ayrı bir hata yönetimine
 * gerek yok.
 */

export interface AuditLogEntry {
  action: string;
  targetType?: string;
  targetId?: string;
  beforeValue?: Record<string, unknown>;
  afterValue?: Record<string, unknown>;
}

// Parola/secret/token/hash gibi alanlar denetim kaydında ASLA ham
// saklanmaz — yalnızca bir alanın DEĞİŞTİĞİ bilgisi anlamlıdır, değeri değil.
const SENSITIVE_FIELD_PATTERN = /pass|secret|token|hash|pepper/i;

function maskSensitiveFields(obj?: Record<string, unknown>): Record<string, unknown> | null {
  if (!obj) return null;
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    masked[key] = SENSITIVE_FIELD_PATTERN.test(key) ? '***MASKED***' : value;
  }
  return masked;
}

/**
 * Bir kritik işlemin AYNI transaction'ı içinde (çağıranın withTenant()'tan
 * aldığı `client` ile) çağrılmalıdır. tenantId/userId/traceId/ipAddress
 * ayrıca parametre olarak geçilmez — AsyncLocalStorage tenant context'inden
 * (bkz. authMiddleware.ts'in doldurduğu alanlar) otomatik okunur.
 */
export async function writeAuditLog(client: PoolClient, entry: AuditLogEntry): Promise<void> {
  const store = getTenantStore();
  if (!store?.tenantId) {
    throw new Error('AUDIT_LOG_MISSING_TENANT_CONTEXT: denetim kaydı tenant context olmadan yazılamaz.');
  }

  await client.query(
    `INSERT INTO audit_logs
       (id, tenant_id, user_id, trace_id, ip_address, action, target_type, target_id, before_value, after_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)`,
    [
      generateId('audit'),
      store.tenantId,
      store.userId ?? null,
      store.traceId ?? null,
      store.ipAddress ?? null,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      JSON.stringify(maskSensitiveFields(entry.beforeValue)),
      JSON.stringify(maskSensitiveFields(entry.afterValue))
    ]
  );
}
