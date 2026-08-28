import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, JwtUserPayload, UserRole } from '../services/tokenService';
import { tenantStorage, TenantStore } from '../context/tenantContext';

export interface AuthenticatedRequest extends Request {
  user?: JwtUserPayload;
}

/**
 * Express Middleware to authenticate JWT Access Token
 * Also initializes the request-scoped AsyncLocalStorage tenant context
 */
export function authenticateJWT(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: 'UNAUTHORIZED',
      message: 'Erişim engellendi. Geçerli bir Authorization Bearer token gereklidir.'
    });
  }

  const token = authHeader.substring(7);

  try {
    const userPayload = verifyAccessToken(token);
    req.user = userPayload;

    const store: TenantStore = {
      tenantId: userPayload.tenantId,
      userId: userPayload.userId
    };

    // Run within request-scoped tenant context for RLS isolation
    tenantStorage.run(store, () => next());
  } catch (err: any) {
    return res.status(401).json({
      success: false,
      error: 'INVALID_TOKEN',
      message: 'Oturum süreniz doldu veya geçersiz token. Lütfen tekrar giriş yapınız.'
    });
  }
}

/**
 * Role-Based Access Control (RBAC) Guard
 */
export function authorizeRoles(...allowedRoles: UserRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'UNAUTHORIZED',
        message: 'Kullanıcı kimliği doğrulanamadı.'
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: 'FORBIDDEN',
        message: `Yetkisiz erişim. Bu işlemi gerçekleştirme yetkiniz bulunmamaktadır. (Gerekli Rol: ${allowedRoles.join(', ')})`
      });
    }

    next();
  };
}
