import { useApp } from '../context/AppContext';
import { ACTIONS, ActionKey, ROLE_GROUPS, roleAllowed } from '../utils/permissions';
import type { UserRole } from '../context/AppContext';

/**
 * FE-803 — bileşenlerin "bu butonu göster mi?" kararını verdiği kanca.
 *
 *   const { can } = usePermissions();
 *   {can('MANAGE_SITES') && <button>Yeni Şantiye</button>}
 *
 * Karar HER ZAMAN currentUser.role (backend'in JWT'de imzaladığı gerçek rol)
 * üzerinden verilir — asla isManagerMode gibi bir görüntü bayrağına göre değil.
 */
export function usePermissions() {
  const { currentUser } = useApp();
  const role: UserRole | undefined = currentUser?.role;

  return {
    role,
    /** İşlem (buton) yetkisi. */
    can: (action: ActionKey): boolean => roleAllowed(role, ACTIONS[action]),
    /** Rota/panel grubu yetkisi. */
    canAccess: (group: keyof typeof ROLE_GROUPS): boolean => roleAllowed(role, ROLE_GROUPS[group]),
  };
}
