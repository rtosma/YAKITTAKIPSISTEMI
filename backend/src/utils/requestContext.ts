import { Request } from 'express';
import { getTenantStore } from '../context/tenantContext';

/**
 * `errorHandler.ts` ve `loggerMiddleware.ts` aynı "traceId yoksa header'dan,
 * o da yoksa 'N/A'" ve "tenant/user bağlamı" zincirlerini birbirinden bağımsız
 * olarak tekrar tekrar yazıyordu — bu iki yardımcı o tekrarı tekilleştirir.
 */
export function getTraceId(req: Request): string {
  return req.traceId || (req.headers['x-trace-id'] as string) || 'N/A';
}

/**
 * tenant/user YALNIZCA doğrulanmış JWT'den gelen AsyncLocalStorage store'dan
 * alınır. Önceden store yoksa (kimliksiz istekler: login, refresh, parola
 * sıfırlama) `X-Tenant-ID`/`X-User-ID` başlıklarına düşülüyordu — istemci
 * bir brute-force denemesini başka bir firma/kullanıcı adına LOGLATABİLİYORDU
 * (canlı doğrulandı). Kimliksiz istek için doğru değer "bilinmiyor"dur.
 */
export function getLoggingTenantContext(): { tenantId: string; userId: string } {
  const store = getTenantStore();
  return {
    tenantId: store?.tenantId || 'N/A',
    userId: store?.userId || 'N/A'
  };
}
