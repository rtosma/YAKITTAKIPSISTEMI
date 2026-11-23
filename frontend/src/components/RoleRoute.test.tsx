import { render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserRole } from '../context/AppContext';
import { ROLE_GROUPS } from '../utils/permissions';

/**
 * TEST_PLAN.md §3.2 — FE-803 rota koruması.
 *
 * AppContext mock'lanıyor: RoleRoute yalnızca `isAuthenticated` ve
 * `currentUser` okur; gerçek provider'ı kurmak (socket, react-query, 1200
 * satırlık state) bu kararı test etmeye bir şey katmaz. Oturum zincirinin
 * kendisi AppContext.test.tsx'te gerçek provider ile test ediliyor.
 */
const appState: { isAuthenticated: boolean; currentUser: { role: UserRole; mustChangePassword?: boolean } | null } = {
  isAuthenticated: false,
  currentUser: null
};
vi.mock('../context/AppContext', () => ({ useApp: () => appState }));

import { RoleRoute } from './RoleRoute';

function renderAt(path: string, allow: readonly UserRole[]) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<div>LOGIN</div>} />
        <Route path="/403" element={<div>FORBIDDEN</div>} />
        <Route path="/parola-degistir" element={<div>PAROLA</div>} />
        <Route path="/korunan" element={<RoleRoute allow={allow}><div>GIZLI-ICERIK</div></RoleRoute>} />
      </Routes>
    </MemoryRouter>
  );
}

const ALL_ROLES: UserRole[] = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER', 'PUMP_OPERATOR'];

describe('RoleRoute', () => {
  beforeEach(() => {
    appState.isAuthenticated = false;
    appState.currentUser = null;
  });

  it('oturum yoksa korunan içerik render EDİLMEZ, /login\'e gider', () => {
    renderAt('/korunan', ROLE_GROUPS.ADMIN);
    expect(screen.getByText('LOGIN')).toBeInTheDocument();
    expect(screen.queryByText('GIZLI-ICERIK')).not.toBeInTheDocument();
  });

  it('isAuthenticated=true ama currentUser yoksa (bozuk localStorage) içerik gösterilmez', () => {
    appState.isAuthenticated = true;
    renderAt('/korunan', ROLE_GROUPS.PANEL);
    expect(screen.getByText('FORBIDDEN')).toBeInTheDocument();
    expect(screen.queryByText('GIZLI-ICERIK')).not.toBeInTheDocument();
  });

  it('parola değişikliği zorunluysa YETKİLİ rol bile içeriğe erişemez', () => {
    appState.isAuthenticated = true;
    appState.currentUser = { role: 'SUPER_ADMIN', mustChangePassword: true };
    renderAt('/korunan', ROLE_GROUPS.ADMIN);
    expect(screen.getByText('PAROLA')).toBeInTheDocument();
    expect(screen.queryByText('GIZLI-ICERIK')).not.toBeInTheDocument();
  });

  for (const [group, allowed] of Object.entries(ROLE_GROUPS)) {
    for (const role of ALL_ROLES) {
      const permitted = allowed.includes(role);
      it(`${group}: ${role} → ${permitted ? 'içerik' : '/403'}`, () => {
        appState.isAuthenticated = true;
        appState.currentUser = { role };
        renderAt('/korunan', allowed);
        expect(screen.queryByText('GIZLI-ICERIK') !== null).toBe(permitted);
        expect(screen.queryByText('FORBIDDEN') !== null).toBe(!permitted);
      });
    }
  }
});
