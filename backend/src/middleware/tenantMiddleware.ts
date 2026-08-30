import { Request, Response, NextFunction } from 'express';
import { tenantStorage, TenantStore } from '../context/tenantContext';

/**
 * TenantContextService Middleware
 * Extracts X-Tenant-ID and optional X-User-ID headers, wrapping the request
 * execution inside Node.js AsyncLocalStorage.
 */
export class TenantContextService {
  public static middleware(options: { requireTenant?: boolean } = { requireTenant: true }) {
    return (req: Request, res: Response, next: NextFunction): void => {
      const tenantId = (req.headers['x-tenant-id'] as string) || (req.query.tenantId as string);
      const userId = (req.headers['x-user-id'] as string) || undefined;

      if (!tenantId && options.requireTenant !== false) {
        res.status(400).json({
          success: false,
          error: 'MISSING_TENANT_ID',
          message: 'X-Tenant-ID header veya tenantId query parametresi zorunludur.'
        });
        return;
      }

      const store: TenantStore = {
        tenantId: tenantId || 'SYSTEM_GUEST',
        userId
      };

      // Wrap subsequent middleware / route handler in AsyncLocalStorage context
      tenantStorage.run(store, () => {
        next();
      });
    };
  }
}
