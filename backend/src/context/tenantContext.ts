import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantStore {
  tenantId: string;
  userId?: string;
  // AUTH-203: audit_logs kayıtlarının trace_id/ip_address alanları için —
  // authMiddleware.ts store'u kurarken doldurur (bkz. utils/auditLog.ts).
  traceId?: string;
  ipAddress?: string;
}

/**
 * Node.js AsyncLocalStorage instance for request-bound Tenant Context.
 * Ensures tenantId is isolated across async event loop iterations.
 */
export const tenantStorage = new AsyncLocalStorage<TenantStore>();

/**
 * Get current request's tenant store.
 */
export function getTenantStore(): TenantStore | undefined {
  return tenantStorage.getStore();
}

/**
 * Helper to retrieve current tenantId directly.
 */
export function getTenantId(): string | undefined {
  return tenantStorage.getStore()?.tenantId;
}

/**
 * Execute callback within a specific tenant context store.
 */
export function runWithTenant<T>(store: TenantStore, callback: () => T): T {
  return tenantStorage.run(store, callback);
}
