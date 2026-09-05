/**
 * RES-902 AC — "Hassas alanlar loglarda redakte edilmelidir." Pino'nun
 * yerleşik `redact` seçeneği yalnızca SABİT, önceden bilinen path'leri
 * (örn. `req.body.password`) destekliyor — bu projede istek gövdesi
 * endpoint'e göre çok farklı şekiller alıyor (login: password, hardware
 * provisioning: deviceId/secret yok ama rotate-secret yanıtı secret
 * DÖNDÜRÜYOR, sync-batch: iç içe records dizisi...). Bu yüzden auditLog.ts'in
 * DB denetim izi için kullandığı AYNI "anahtar adına göre maskele" deseninin
 * bağımsız bir kopyası — errorHandler.ts'in globalErrorHandler'ı beklenmeyen
 * bir 500'de `req.body`'yi olduğu gibi loglamadan ÖNCE bunu çağırır.
 */
const SENSITIVE_KEY_PATTERN = /pass|secret|token|hash|pepper/i;

export function redactSensitiveFields(value: unknown, depth = 0): unknown {
  // Döngüsel/aşırı derin nesnelere karşı güvenlik — bu derinlikten sonra
  // olduğu gibi bırakılır (redaksiyon amacı zaten üst seviye alanlar).
  if (depth > 5) return value;

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveFields(item, depth + 1));
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEY_PATTERN.test(key) ? '***MASKED***' : redactSensitiveFields(v, depth + 1);
    }
    return result;
  }

  return value;
}
