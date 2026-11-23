import type { UserRole } from '../context/AppContext';

/**
 * FE-803 — Rol Bazlı Yetki Matrisi (TEK doğruluk kaynağı).
 *
 * Buradaki listeler backend'in `authorizeRoles(...)` çağrılarının birebir
 * FE karşılığıdır (bkz. backend/src/routes/routes.ts). Bir rota veya buton
 * gösterilmeden ÖNCE bu matrise bakılır:
 *  - Yetkisiz butonlar DOM'a hiç basılmaz (disabled edilmez — tamamen kaldırılır).
 *  - Yetkisiz rotaya doğrudan URL ile gidilirse /403'e yönlenir (RoleRoute).
 *
 * Backend hâlâ tek gerçek güvenlik sınırıdır (her uç JWT rolünü ayrıca
 * doğrular); bu matris yalnızca kullanıcının hiç yapamayacağı bir işlemi
 * görüp denememesi (ve 403 almaması) içindir.
 */

/** Panel/rota seviyesi rol grupları. */
export const ROLE_GROUPS = {
  /** `/login` → `/panel` (firma yönetim paneli). */
  PANEL: ['SUPER_ADMIN', 'COMPANY_OWNER'] as UserRole[],
  /** `/santiye-login` → `/santiye-panel` (saha operatör paneli). POST /dispense yetkisiyle aynı küme. */
  SITE_PANEL: ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER', 'PUMP_OPERATOR'] as UserRole[],
  /** `/admin` (Süper Admin paneli). GET /companies, GET /devices, PATCH /companies/:id. */
  ADMIN: ['SUPER_ADMIN'] as UserRole[],
} as const;

/** İşlem (buton) seviyesi yetkiler — anahtar = kavramsal işlem, değer = backend'in izin verdiği roller. */
export const ACTIONS = {
  /** POST /companies */
  CREATE_COMPANY: ['SUPER_ADMIN'] as UserRole[],
  /** PATCH /companies/:id — modül aç/kapa */
  TOGGLE_COMPANY_MODULE: ['SUPER_ADMIN'] as UserRole[],
  /** PATCH /companies/:id — lisans durumu (AKTİF/ASKIDA/DENEME) */
  SET_COMPANY_LICENSE: ['SUPER_ADMIN'] as UserRole[],
  /** POST/DELETE /sites */
  MANAGE_SITES: ['SUPER_ADMIN', 'COMPANY_OWNER'] as UserRole[],
  /** POST/PUT/DELETE /vehicles | /drivers | /tanks */
  MANAGE_FLEET: ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'] as UserRole[],
  /** POST/PATCH /cross-site-permissions */
  MANAGE_CROSS_SITE: ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'] as UserRole[],
  /** POST /dispense — "Pompayı Başlat & İkmal Et" */
  DISPENSE_FUEL: ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER', 'PUMP_OPERATOR'] as UserRole[],
  /** hardware-devices/* (HARDWARE_DEVICE_MANAGER_ROLES) */
  MANAGE_HARDWARE: ['SUPER_ADMIN', 'COMPANY_OWNER'] as UserRole[],
  /** GET /audit-logs */
  VIEW_AUDIT_LOG: ['SUPER_ADMIN', 'COMPANY_OWNER'] as UserRole[],
} as const;

export type ActionKey = keyof typeof ACTIONS;

/** `role` verilen listede mi? (rol yoksa her zaman false). */
export function roleAllowed(role: UserRole | undefined, allowed: readonly UserRole[]): boolean {
  return !!role && allowed.includes(role);
}

/**
 * Bir rolün "ana sayfası" — yanlış panele düşen ya da 403 alan kullanıcıyı
 * anlamlı bir yere geri göndermek için (yönlendirme döngüsünü önler).
 */
export function homePathForRole(role: UserRole | undefined): string {
  switch (role) {
    case 'SUPER_ADMIN':
      return '/admin';
    case 'COMPANY_OWNER':
      return '/panel';
    case 'SITE_MANAGER':
    case 'PUMP_OPERATOR':
      return '/santiye-panel';
    default:
      return '/';
  }
}
