import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, isSessionDenied, JwtUserPayload, UserRole } from '../services/tokenService';
import { tenantStorage, TenantStore } from '../context/tenantContext';
import { getCompanyLicenseSnapshot } from '../db/adminDb';

export interface AuthenticatedRequest extends Request {
  user?: JwtUserPayload;
}

// AUTH-204 AC: "İlk girişte parola değiştirmeden başka hiçbir işlem
// yapılamamalıdır." mustChangePassword=true iken bu iki uç dışında HER ŞEY
// 403 alır — değiştirme ucunun kendisi (aksi halde kullanıcı asla
// değiştiremez) ve logout (kullanıcının oturumdan çıkabilmesi her zaman
// bir çıkış kapısı olmalı).
const PASSWORD_CHANGE_GATE_ALLOWLIST = new Set(['/auth/change-password', '/auth/logout']);

// BILL-1701: firmanın lisansı askıya alınmış (ASKIDA) ya da süresi geçmişse
// (license_expiry < bugün) kilitli tenant'ın kullanıcıları HALA kendi
// durumunu görüp çıkış yapabilmeli — PASSWORD_CHANGE_GATE_ALLOWLIST ile
// AYNI gerekçe, üstüne `/companies/me` (durumu görmek) ve `/auth/me` eklendi.
const LICENSE_GATE_ALLOWLIST = new Set(['/auth/logout', '/auth/me', '/companies/me']);

/**
 * Express Middleware to authenticate JWT Access Token
 * Also initializes the request-scoped AsyncLocalStorage tenant context
 */
export async function authenticateJWT(req: AuthenticatedRequest, res: Response, next: NextFunction) {
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

    // AUTH-208: uzaktan kapatılan bir oturumun access token'ı 15 dk daha
    // geçerli kalmasın — deny-list'te ise hemen reddet.
    if (userPayload.sid && (await isSessionDenied(userPayload.sid))) {
      return res.status(401).json({
        success: false,
        error: 'SESSION_REVOKED',
        message: 'Bu oturum uzaktan sonlandırıldı. Lütfen tekrar giriş yapınız.'
      });
    }

    if (userPayload.mustChangePassword && !PASSWORD_CHANGE_GATE_ALLOWLIST.has(req.path)) {
      return res.status(403).json({
        success: false,
        error: 'PASSWORD_CHANGE_REQUIRED',
        message: 'İlk girişte parolanızı değiştirmeniz zorunludur. Devam etmeden önce parolanızı güncelleyin.'
      });
    }

    // BILL-1701: SUPER_ADMIN platform operatörüdür, herhangi bir tek tenant'ın
    // lisansına bağlı DEĞİLDİR (billing'i YÖNETEN taraf kilitlenmemeli) — bkz.
    // adminDb.ts başındaki not: `companies` RLS'siz, bu kontrol app_user
    // transaction'ı AÇILMADAN (tenantStorage.run'dan ÖNCE) çalışır.
    if (userPayload.role !== 'SUPER_ADMIN' && !LICENSE_GATE_ALLOWLIST.has(req.path)) {
      const license = await getCompanyLicenseSnapshot(userPayload.tenantId);
      if (license) {
        const isSuspended = license.licenseStatus === 'ASKIDA';
        const isExpired = !isSuspended && !!license.licenseExpiry && license.licenseExpiry < new Date().toISOString().slice(0, 10);
        if (isSuspended || isExpired) {
          return res.status(402).json({
            success: false,
            error: isSuspended ? 'LICENSE_SUSPENDED' : 'LICENSE_EXPIRED',
            message: isSuspended
              ? 'Firmanızın lisansı askıya alınmıştır. Lütfen yöneticinizle iletişime geçin.'
              : `Firmanızın lisans süresi ${license.licenseExpiry} tarihinde dolmuştur. Lütfen aboneliğinizi yenileyin.`
          });
        }
      }
    }

    const store: TenantStore = {
      tenantId: userPayload.tenantId,
      userId: userPayload.userId,
      traceId: req.traceId,
      ipAddress: req.ip
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
