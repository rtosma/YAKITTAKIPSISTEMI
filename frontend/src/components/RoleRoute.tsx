import React, { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import type { UserRole } from '../context/AppContext';

interface RoleRouteProps {
  /** Bu rotaya girebilecek roller (bkz. utils/permissions.ts ROLE_GROUPS). */
  allow: readonly UserRole[];
  children: ReactNode;
}

/**
 * FE-803 — Rota Seviyesi Rol Koruması.
 *
 * Yetkisiz bir kullanıcı menüde linki görmese bile doğrudan URL yazarak
 * (`/panel/modules`, `/admin/tenants` ...) sayfaya erişmeye çalışırsa /403'e
 * yönlendirilir. Butonların DOM'dan kaldırılmasının rota karşılığıdır.
 *
 * `isAuthenticated` ve `mustChangePassword` kontrolleri de burada toplanır ki
 * her layout aynı guard bloğunu tekrarlamak zorunda kalmasın.
 */
export const RoleRoute: React.FC<RoleRouteProps> = ({ allow, children }) => {
  const { isAuthenticated, currentUser } = useApp();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  if (currentUser?.mustChangePassword) {
    return <Navigate to="/parola-degistir" replace />;
  }
  if (!currentUser || !allow.includes(currentUser.role)) {
    return <Navigate to="/403" replace />;
  }

  return <>{children}</>;
};
