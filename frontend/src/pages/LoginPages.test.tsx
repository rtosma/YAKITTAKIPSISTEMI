import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TEST_PLAN.md §3.2 — giriş sayfaları.
 *
 * 1) Kimlik bilgisi sızıntısı: formlar önceden 'camsa'/'gebze-santiye' +
 *    '123456' ile DOLU geliyordu ve mock/index.ts tüm demo hesapların
 *    kullanıcı adı + parolasını prod bundle'ına gömüyordu (seed'deki gerçek
 *    hesaplarla birebir aynı). Bundle tarafı scripts/check-frontend-bundle.mjs
 *    ile, form tarafı burada korunuyor.
 * 2) Hook sırası: `if (isAuthenticated) return <Navigate/>` useState'lerden
 *    ÖNCEydi — isAuthenticated false→true olduğunda React "Rendered fewer
 *    hooks than expected" fırlatıyordu (eski kodla kanıtlandı). Canlıda
 *    navigate() çoğu zaman yeniden render'dan önce koştuğu için zamanlamaya
 *    bağlı gizli bir çökmeydi.
 */
const appState = { isAuthenticated: false, loginCompany: vi.fn(), loginSiteOperator: vi.fn() };
vi.mock('../context/AppContext', () => ({ useApp: () => appState }));

import { LoginPage } from './LoginPage';
import { SiteLoginPage } from './SiteLoginPage';

const PAGES = [
  { name: 'LoginPage', Page: LoginPage, target: '/panel', usernamePlaceholder: 'Firma Adı' },
  { name: 'SiteLoginPage', Page: SiteLoginPage, target: '/santiye-panel', usernamePlaceholder: 'Şantiye Adı' }
];

describe.each(PAGES)('$name', ({ Page, target, usernamePlaceholder }) => {
  const tree = () => (
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<Page />} />
        <Route path={target} element={<div>HEDEF-PANEL</div>} />
        <Route path="/parola-unuttum" element={<div>UNUTTUM-EKRANI</div>} />
      </Routes>
    </MemoryRouter>
  );

  beforeEach(() => {
    appState.isAuthenticated = false;
  });

  it('kullanıcı adı ve parola alanları BOŞ gelir (önceden doldurulmuş kimlik bilgisi yok)', () => {
    const { container } = render(tree());
    expect(screen.getByPlaceholderText(usernamePlaceholder)).toHaveValue('');
    expect(container.querySelector('input[type="password"]')).toHaveValue('');
  });

  it('oturum açılınca (isAuthenticated false→true) çökmeden panele yönlendirir', () => {
    const { rerender } = render(tree());
    appState.isAuthenticated = true;
    expect(() => rerender(tree())).not.toThrow();
    expect(screen.getByText('HEDEF-PANEL')).toBeInTheDocument();
  });

  // FE-804
  it('"Parolamı Unuttum" bağlantısı /parola-unuttum\'a götürür', () => {
    render(tree());
    fireEvent.click(screen.getByRole('button', { name: /Parolamı Unuttum/i }));
    expect(screen.getByText('UNUTTUM-EKRANI')).toBeInTheDocument();
  });
});

// FE-804 — yalnızca LoginPage: ResetPasswordPage başarıda buraya
// /login?reset=success ile yönlendiriyor; backend parola sıfırlanınca TÜM
// oturumları düşürdüğü için burada otomatik giriş YOK — yalnızca bir bilgi
// kutusu bekleniyor, isAuthenticated hâlâ false olmalı.
describe('LoginPage — parola sıfırlama sonrası bilgi kutusu', () => {
  beforeEach(() => {
    appState.isAuthenticated = false;
  });

  it('?reset=success ile açılınca başarı mesajı gösterilir', () => {
    render(
      <MemoryRouter initialEntries={['/?reset=success']}>
        <Routes>
          <Route path="/" element={<LoginPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByText(/Parolanız güncellendi/i)).toBeInTheDocument();
  });

  it('reset parametresi YOKSA başarı mesajı gösterilmez', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<LoginPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.queryByText(/Parolanız güncellendi/i)).not.toBeInTheDocument();
  });
});
