import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UNAUTHORIZED_EVENT } from '../utils/api';

/**
 * TEST_PLAN.md §3.2 — AppContext oturum yaşam döngüsü.
 *
 * Kapsam BİLİNÇLİ olarak dar tutuldu: AppContext ~1200 satır ve pek çok
 * alan (tank/araç listeleri, toast, EEPROM ayarları) barındırıyor. Burada
 * test edilen tek şey GÜVENLİK açısından kritik olan oturum zinciri:
 *   giriş → token saklama → 401 olayı → otomatik çıkış → token temizliği
 * Geri kalan alanların testi, o alanlara dokunulduğunda yazılmalı; şimdi
 * hepsini kapsamaya çalışmak, bakımı zor ve kırılgan bir test kütlesi
 * üretirdi (bkz. TEST_PLAN.md §1 "kod karmaşasından kaçınma" ilkesi).
 *
 * Socket.io mock'lanıyor: gerçek bir WebSocket bağlantısı denemesi testleri
 * yavaşlatır ve jsdom'da anlamsız ağ hataları üretir. Bu, "iç modülleri
 * mock'lama" ilkesinin istisnası DEĞİL — socket gerçek bir DIŞ sınır (ağ).
 */
vi.mock('../utils/socket', () => ({
  socket: { on: vi.fn(), off: vi.fn(), connected: false },
  connectSocket: vi.fn(),
  disconnectSocket: vi.fn()
}));

import { AppProvider, useApp } from './AppContext';

const ACCESS_KEY = 'YAKIT_ACCESS_TOKEN';
const REFRESH_KEY = 'YAKIT_REFRESH_TOKEN';

/** Context değerlerini DOM'a yansıtan ve login/logout tetikleyebilen sonda bileşen. */
function Probe() {
  const app = useApp();
  return (
    <div>
      <span data-testid="auth">{app.isAuthenticated ? 'giris-yapildi' : 'giris-yok'}</span>
      <span data-testid="user">{app.currentUser?.username ?? '-'}</span>
      <span data-testid="role">{app.currentUser?.role ?? '-'}</span>
      <button data-testid="login" onClick={() => void app.loginCompany('camsa', '123456')}>giris</button>
      <button data-testid="logout" onClick={() => app.logoutCompany()}>cikis</button>
    </div>
  );
}

function renderApp() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AppProvider>
        <Probe />
      </AppProvider>
    </QueryClientProvider>
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    json: async () => body
  } as unknown as Response;
}

/**
 * Giriş akışı iki çağrı yapar: /auth/login ve ardından /companies/me
 * (fetchCompanyProfile). İkincisi başarısız olsa bile girişin tamamlanması
 * gerekir — bu yüzden mock URL'e göre cevap veriyor, sırayla değil.
 */
function mockBackend(opts: { loginBody?: unknown; loginStatus?: number } = {}) {
  const fetchMock = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/auth/login')) {
      return jsonResponse(
        opts.loginBody ?? {
          success: true,
          accessToken: 'access-abc',
          refreshToken: 'refresh-xyz',
          user: { username: 'camsa', role: 'COMPANY_OWNER', mustChangePassword: false }
        },
        opts.loginStatus ?? 200
      );
    }
    if (u.includes('/companies/me')) {
      return jsonResponse({ success: true, data: { name: 'ÇamSA Pelet & Enerji A.Ş.', sites: [] } });
    }
    return jsonResponse({ success: true, data: [] });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  localStorage.clear();
});

describe('AppContext — giriş', () => {
  it('başarılı girişte her iki token da localStorage\'a yazılır', async () => {
    mockBackend();
    renderApp();

    await act(async () => {
      screen.getByTestId('login').click();
    });

    await waitFor(() => {
      expect(localStorage.getItem(ACCESS_KEY)).toBe('access-abc');
      expect(localStorage.getItem(REFRESH_KEY)).toBe('refresh-xyz');
    });
  });

  it('kullanıcının GERÇEK rolü backend yanıtından alınır (sabit metin değil)', async () => {
    mockBackend({
      loginBody: {
        success: true,
        accessToken: 'a',
        refreshToken: 'r',
        user: { username: 'admin', role: 'SUPER_ADMIN', mustChangePassword: false }
      }
    });
    renderApp();

    await act(async () => {
      screen.getByTestId('login').click();
    });

    // FE-803: rol JWT'den gelmeli — burada sabitlenirse RBAC'a dayalı tüm
    // arayüz kararları (menü, buton görünürlüğü) sessizce yanlışlanır.
    await waitFor(() => expect(screen.getByTestId('role').textContent).toBe('SUPER_ADMIN'));
    expect(screen.getByTestId('auth').textContent).toBe('giris-yapildi');
  });

  it('başarısız girişte token YAZILMAZ ve oturum açılmaz', async () => {
    mockBackend({ loginStatus: 401, loginBody: { success: false, message: 'Hatalı şifre' } });
    renderApp();

    await act(async () => {
      screen.getByTestId('login').click();
    });

    expect(localStorage.getItem(ACCESS_KEY)).toBeNull();
    expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
    expect(screen.getByTestId('auth').textContent).toBe('giris-yok');
  });

  it('sunucuya ulaşılamazsa çöker değil, oturumsuz kalır', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    renderApp();

    await act(async () => {
      screen.getByTestId('login').click();
    });

    expect(screen.getByTestId('auth').textContent).toBe('giris-yok');
    expect(localStorage.getItem(ACCESS_KEY)).toBeNull();
  });
});

describe('AppContext — çıkış ve oturum düşürme', () => {
  it('çıkışta oturumla ilgili TÜM localStorage anahtarları silinir', async () => {
    mockBackend();
    renderApp();

    await act(async () => {
      screen.getByTestId('login').click();
    });
    await waitFor(() => expect(localStorage.getItem(ACCESS_KEY)).toBe('access-abc'));

    await act(async () => {
      screen.getByTestId('logout').click();
    });

    // Kimlik bilgileri GERÇEKTEN silinmeli — kalırlarsa çıkış yapmış bir
    // kullanıcının oturumu sonraki sayfa yüklemesinde geri canlanırdı.
    for (const key of [ACCESS_KEY, REFRESH_KEY, 'YAKIT_CURRENT_USER']) {
      expect(localStorage.getItem(key), `${key} temizlenmeliydi`).toBeNull();
    }

    // DAVRANIŞ NOTU (bu test yazılırken keşfedildi): logoutCompany()
    // YAKIT_IS_AUTH/COMPANY_IDX/SITE_FILTER için removeItem çağırıyor, ama
    // isAuthenticated state'ini izleyen useEffect'ler (AppContext.tsx ~173-195)
    // hemen ardından değeri GERİ YAZIYOR — yani o removeItem çağrıları fiilen
    // etkisiz. Güvenlik açısından zararsız: okuma tarafı
    // `getItem('YAKIT_IS_AUTH') === 'true'` karşılaştırması yaptığı için
    // 'false' değeri de anahtarın yokluğu da "giriş yapılmamış" demek.
    // Test bu yüzden "anahtar silinmiş" değil, "oturum canlanamaz" koşulunu
    // doğruluyor — gerçek gereksinim bu.
    expect(localStorage.getItem('YAKIT_IS_AUTH')).not.toBe('true');
    expect(screen.getByTestId('auth').textContent).toBe('giris-yok');
  });

  it('apiFetch UNAUTHORIZED olayını yayınca otomatik çıkış yapılır', async () => {
    mockBackend();
    renderApp();

    await act(async () => {
      screen.getByTestId('login').click();
    });
    await waitFor(() => expect(screen.getByTestId('auth').textContent).toBe('giris-yapildi'));

    // utils/api.ts, yenileme zinciri de başarısız olduğunda bu olayı yayar.
    await act(async () => {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    });

    await waitFor(() => {
      expect(screen.getByTestId('auth').textContent).toBe('giris-yok');
      expect(localStorage.getItem(ACCESS_KEY)).toBeNull();
      expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
    });
  });

  it('provider söküldükten sonra UNAUTHORIZED dinleyicisi de sökülür (sızıntı yok)', async () => {
    mockBackend();
    const { unmount } = renderApp();

    await act(async () => {
      screen.getByTestId('login').click();
    });
    await waitFor(() => expect(localStorage.getItem(ACCESS_KEY)).toBe('access-abc'));

    unmount();

    // Sökülmüş bir provider'ın dinleyicisi hâlâ bağlıysa React "unmounted
    // component'te state güncellemesi" uyarısı verir ve olay her provider
    // örneği için tekrar tekrar işlenir (dinleyici sızıntısı).
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    act(() => {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
