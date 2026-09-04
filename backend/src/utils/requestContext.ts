import { Request } from 'express';
import { getTenantStore } from '../context/tenantContext';

/**
 * `errorHandler.ts` ve `loggerMiddleware.ts` aynı "traceId yoksa header'dan,
 * o da yoksa 'N/A'" ve "AsyncLocalStorage store'da tenant/user yoksa
 * header'dan, o da yoksa 'N/A'" fallback zincirlerini birbirinden bağımsız
 * olarak tekrar tekrar yazıyordu — bu iki yardımcı o tekrarı tekilleştirir.
 */
export function getTraceId(req: Request): string {
  return req.traceId || (req.headers['x-trace-id'] as string) || 'N/A';
}

export function getLoggingTenantContext(req: Request): { tenantId: string; userId: string } {
  const store = getTenantStore();
  return {
    tenantId: store?.tenantId || (req.headers['x-tenant-id'] as string) || 'N/A',
    userId: store?.userId || (req.headers['x-user-id'] as string) || 'N/A'
  };
}
