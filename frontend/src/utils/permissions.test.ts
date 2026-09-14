import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTIONS, ActionKey, ROLE_GROUPS, homePathForRole, roleAllowed } from './permissions';

/**
 * TEST_PLAN.md §3.2 — FE-803 yetki matrisi ↔ backend sözleşmesi.
 *
 * permissions.ts "backend'in authorizeRoles(...) çağrılarının BİREBİR FE
 * karşılığı" olduğunu iddia ediyor ama bunu zorlayan hiçbir şey yoktu. İki
 * yönde de kayma gerçek bir hata:
 *  - FE daha GENİŞ → kullanıcı butonu görür, basınca 403 alır.
 *  - FE daha DAR  → yetkili kullanıcı işlemi hiç göremez (sessiz özellik kaybı).
 * Bu projede aynı türden bir FE↔BE sözleşme kayması (pageSize=200 ↔ max 100)
 * tüm ikmal listesini aylarca bozuk bıraktı. Test backend'in routes.ts
 * KAYNAĞINI okur — backend'i çalıştırmadan, CI'da saniyeler içinde.
 */

const ROUTES_PATH = resolve(__dirname, '../../../backend/src/routes/routes.ts');

/** "METHOD /path" → izin verilen roller. Guard'sız uç boş dizi döner. */
function parseBackendRoleGuards(source: string): Map<string, string[]> {
  const constants = new Map<string, string[]>();
  for (const m of source.matchAll(/const ([A-Z0-9_]+_ROLES)\s*(?::[^=]+)?=\s*(?:new Set\()?\[([^\]]*)\]/g)) {
    constants.set(m[1], [...m[2].matchAll(/'([A-Z_]+)'/g)].map((r) => r[1]));
  }
  const guards = new Map<string, string[]>();
  for (const m of source.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'([\s\S]*?)(?:async\s*\(|\(req)/g)) {
    const roles: string[] = [];
    for (const call of m[3].matchAll(/authorizeRoles\(([^)]*)\)/g)) {
      for (const spread of call[1].matchAll(/\.\.\.([A-Z0-9_]+)/g)) {
        const resolved = constants.get(spread[1]);
        if (!resolved) throw new Error(`routes.ts: ${spread[1]} sabiti çözülemedi`);
        roles.push(...resolved);
      }
      roles.push(...[...call[1].matchAll(/'([A-Z_]+)'/g)].map((r) => r[1]));
    }
    guards.set(`${m[1].toUpperCase()} ${m[2]}`, roles);
  }
  return guards;
}

/** Her FE işleminin karşılık geldiği backend uçları (permissions.ts yorumlarıyla aynı). */
const ACTION_ENDPOINTS: Record<ActionKey, string[]> = {
  CREATE_COMPANY: ['POST /companies'],
  TOGGLE_COMPANY_MODULE: ['PATCH /companies/:id'],
  SET_COMPANY_LICENSE: ['PATCH /companies/:id'],
  MANAGE_SITES: ['POST /sites', 'DELETE /sites/:siteName'],
  MANAGE_FLEET: ['vehicles', 'drivers', 'tanks'].flatMap((r) => [`POST /${r}`, `PUT /${r}/:id`, `DELETE /${r}/:id`]),
  MANAGE_CROSS_SITE: ['POST /cross-site-permissions', 'PATCH /cross-site-permissions/:id'],
  DISPENSE_FUEL: ['POST /dispense'],
  MANAGE_HARDWARE: ['GET /hardware-devices', 'POST /hardware-devices', 'POST /hardware-devices/:deviceId/block'],
  VIEW_AUDIT_LOG: ['GET /audit-logs']
};

const ROLE_GROUP_ENDPOINTS: Partial<Record<keyof typeof ROLE_GROUPS, string>> = {
  ADMIN: 'GET /companies',
  SITE_PANEL: 'POST /dispense'
};

const sorted = (roles: readonly string[]) => [...new Set(roles)].sort();

describe('FE-803 yetki matrisi ↔ backend authorizeRoles sözleşmesi', () => {
  const guards = parseBackendRoleGuards(readFileSync(ROUTES_PATH, 'utf8'));

  it('ayrıştırıcı routes.ts\'i gerçekten okuyor (boş eşleşmeyle sahte geçiş yok)', () => {
    expect(guards.size).toBeGreaterThan(100);
    expect(guards.get('GET /vehicles')).toEqual([]);
  });

  for (const [action, endpoints] of Object.entries(ACTION_ENDPOINTS) as [ActionKey, string[]][]) {
    it(`${action} backend'in izin verdiği rollerle birebir aynı`, () => {
      for (const endpoint of endpoints) {
        const backendRoles = guards.get(endpoint);
        expect(backendRoles, `${endpoint} routes.ts'te bulunamadı (rota adı değişti mi?)`).toBeDefined();
        expect(backendRoles!.length, `${endpoint} rol guard'ı olmadan tanımlı`).toBeGreaterThan(0);
        expect(sorted(ACTIONS[action]), `${action} ↔ ${endpoint}`).toEqual(sorted(backendRoles!));
      }
    });
  }

  for (const [group, endpoint] of Object.entries(ROLE_GROUP_ENDPOINTS) as [keyof typeof ROLE_GROUPS, string][]) {
    it(`ROLE_GROUPS.${group} ↔ ${endpoint}`, () => {
      expect(sorted(ROLE_GROUPS[group])).toEqual(sorted(guards.get(endpoint) ?? []));
    });
  }
});

describe('roleAllowed / homePathForRole', () => {
  it('rol yoksa hiçbir işleme izin vermez', () => {
    for (const allowed of Object.values(ACTIONS)) expect(roleAllowed(undefined, allowed)).toBe(false);
  });

  it('listede olmayan rol reddedilir, olan kabul edilir', () => {
    expect(roleAllowed('PUMP_OPERATOR', ACTIONS.MANAGE_FLEET)).toBe(false);
    expect(roleAllowed('SITE_MANAGER', ACTIONS.MANAGE_FLEET)).toBe(true);
    expect(roleAllowed('COMPANY_OWNER', ACTIONS.CREATE_COMPANY)).toBe(false);
  });

  it('her rolün ana sayfası kendi girebildiği rota grubunda (403 → ana sayfa döngüsü yok)', () => {
    const groupOfPath: Record<string, readonly string[]> = {
      '/admin': ROLE_GROUPS.ADMIN,
      '/panel': ROLE_GROUPS.PANEL,
      '/santiye-panel': ROLE_GROUPS.SITE_PANEL
    };
    for (const role of ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER', 'PUMP_OPERATOR'] as const) {
      const home = homePathForRole(role);
      expect(groupOfPath[home], `${role} → ${home}`).toContain(role);
    }
    expect(homePathForRole(undefined)).toBe('/');
  });
});
