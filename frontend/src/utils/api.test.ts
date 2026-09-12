import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_BASE_URL, apiFetch, TOKENS_REFRESHED_EVENT, UNAUTHORIZED_EVENT } from './api';

/**
 * TEST_PLAN.md §3.2 — `utils/api.ts` (401 → sessiz yenileme → oturum düşürme).
 *
 * Bu dosya frontend'in GÜVENLİK açısından en kritik parçası:
 *   - Access/refresh token'ları localStorage'a yazan tek yer burası.
 *   - Bir oturumun ne zaman "gerçekten bitti" sayılacağına burası karar
 *     veriyor (UNAUTHORIZED_EVENT → AppContext logout → route guard'lar).
 *   - Hatalı bir "sessiz yenileme" mantığı iki yönde de kötü: çok agresifse
 *     kullanıcı sürekli atılır, çok gevşekse süresi dolmuş bir oturum
 *     yaşamaya devam eder.
 *
 * Bu yüzden testler "mutlu yol"la yetinmiyor; yenileme zincirinin BAŞARISIZ
 * olduğu her yolu (refresh token yok / sunucu reddetti / ağ koptu / yanıt
 * eksik) ve eşzamanlı 401'lerin tek bir yenilemeyi paylaştığını da kapsıyor.
 */

const ACCESS_KEY = 'YAKIT_ACCESS_TOKEN';
const REFRESH_KEY = 'YAKIT_REFRESH_TOKEN';

function makeResponse(opts: { status?: number; body?: unknown; statusText?: string }): Response {
  const status = opts.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: opts.statusText ?? '',
    json: async () => opts.body ?? {}
  } as unknown as Response;
}

/** Sıradaki her fetch çağrısına, verilen yanıtları SIRAYLA döndürür. */
function queueFetch(...responses: Array<{ status?: number; body?: unknown; statusText?: string }>) {
  const fetchMock = vi.fn();
  for (const r of responses) fetchMock.mockResolvedValueOnce(makeResponse(r));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Bir window olayını dinler; test bitiminde otomatik sökülür. */
const listeners: Array<{ name: string; fn: EventListener }> = [];
function captureEvent(name: string) {
  const spy = vi.fn();
  window.addEventListener(name, spy);
  listeners.push({ name, fn: spy });
  return spy;
}
afterEach(() => {
  for (const l of listeners) window.removeEventListener(l.name, l.fn);
  listeners.length = 0;
});

describe('apiFetch — istek oluşturma', () => {
  it('token yokken Authorization başlığı EKLEMEZ', async () => {
    const fetchMock = queueFetch({ body: { ok: true } });

    await apiFetch('/sites');

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers.Authorization).toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE_URL}/sites`);
  });

  it('token varken Bearer başlığını ekler', async () => {
    localStorage.setItem(ACCESS_KEY, 'access-123');
    const fetchMock = queueFetch({ body: { ok: true } });

    await apiFetch('/sites');

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer access-123');
  });

  it("tarayıcı önbelleğini devre dışı bırakır (cache: 'no-store')", async () => {
    const fetchMock = queueFetch({ body: {} });

    await apiFetch('/sites');

    expect(fetchMock.mock.calls[0][1].cache).toBe('no-store');
  });

  it('çağıranın verdiği başlıkları korur ve Content-Type ile birleştirir', async () => {
    const fetchMock = queueFetch({ body: {} });

    await apiFetch('/sites', { method: 'POST', headers: { 'X-Custom': 'abc' } });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['X-Custom']).toBe('abc');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.method).toBe('POST');
  });

  it('başarılı yanıtın gövdesini döndürür', async () => {
    queueFetch({ body: { success: true, data: [1, 2, 3] } });

    await expect(apiFetch('/sites')).resolves.toEqual({ success: true, data: [1, 2, 3] });
  });
});

describe('apiFetch — hata yüzeyi', () => {
  it('hata yanıtında sunucunun `message` alanını fırlatır', async () => {
    queueFetch({ status: 400, body: { message: 'Girdi doğrulama hatası' } });

    await expect(apiFetch('/vehicles')).rejects.toThrow('Girdi doğrulama hatası');
  });

  it('`message` yoksa statusText\'e düşer', async () => {
    queueFetch({ status: 500, body: {}, statusText: 'Internal Server Error' });

    await expect(apiFetch('/vehicles')).rejects.toThrow('Internal Server Error');
  });

  it('token GÖNDERİLMEDİYSE 401 oturumu düşürmez (giriş öncesi çağrılar)', async () => {
    const unauthorized = captureEvent(UNAUTHORIZED_EVENT);
    const fetchMock = queueFetch({ status: 401, body: { message: 'Yetkisiz' } });

    await expect(apiFetch('/auth/me')).rejects.toThrow('Yetkisiz');

    // Yenileme DENENMEMELİ: tek bir istek atılmış olmalı.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(unauthorized).not.toHaveBeenCalled();
  });
});

describe('apiFetch — 401 sonrası sessiz token yenileme', () => {
  it('yenileme başarılıysa isteği YENİ token ile tekrarlar ve sonucu döndürür', async () => {
    localStorage.setItem(ACCESS_KEY, 'eski-access');
    localStorage.setItem(REFRESH_KEY, 'refresh-1');

    const fetchMock = queueFetch(
      { status: 401, body: { message: 'Süresi doldu' } },                        // 1: asıl istek
      { status: 200, body: { accessToken: 'yeni-access', refreshToken: 'refresh-2' } }, // 2: /auth/refresh
      { status: 200, body: { success: true, data: 'gizli' } }                    // 3: tekrar denenen istek
    );

    await expect(apiFetch('/sites')).resolves.toEqual({ success: true, data: 'gizli' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Yenileme çağrısı doğru uca gitmiş mi?
    expect(fetchMock.mock.calls[1][0]).toBe(`${API_BASE_URL}/auth/refresh`);
    // Tekrar denenen istek ESKİ değil YENİ token'ı taşımalı.
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe('Bearer yeni-access');
  });

  it('yenileme başarılıysa her İKİ token\'ı da localStorage\'da günceller', async () => {
    localStorage.setItem(ACCESS_KEY, 'eski-access');
    localStorage.setItem(REFRESH_KEY, 'refresh-1');
    queueFetch(
      { status: 401, body: {} },
      { status: 200, body: { accessToken: 'yeni-access', refreshToken: 'refresh-2' } },
      { status: 200, body: { ok: true } }
    );

    await apiFetch('/sites');

    expect(localStorage.getItem(ACCESS_KEY)).toBe('yeni-access');
    // Refresh token ROTASYONU: backend tek kullanımlık refresh token veriyor,
    // yenisi saklanmazsa bir sonraki yenileme "token reuse" sayılıp TÜM
    // oturumları iptal ettirir (bkz. AUTH-201 reuse detection).
    expect(localStorage.getItem(REFRESH_KEY)).toBe('refresh-2');
  });

  it('yenileme başarılıysa TOKENS_REFRESHED olayını yayar', async () => {
    localStorage.setItem(ACCESS_KEY, 'eski');
    localStorage.setItem(REFRESH_KEY, 'r1');
    const refreshed = captureEvent(TOKENS_REFRESHED_EVENT);
    queueFetch(
      { status: 401, body: {} },
      { status: 200, body: { accessToken: 'yeni', refreshToken: 'r2' } },
      { status: 200, body: {} }
    );

    await apiFetch('/sites');

    expect(refreshed).toHaveBeenCalledTimes(1);
  });

  it('refresh token YOKSA yenileme isteği atmadan oturumu düşürür', async () => {
    localStorage.setItem(ACCESS_KEY, 'access-var');
    // REFRESH_KEY bilinçli olarak yok
    const unauthorized = captureEvent(UNAUTHORIZED_EVENT);
    const fetchMock = queueFetch({ status: 401, body: { message: 'Yetkisiz' } });

    await expect(apiFetch('/sites')).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1); // /auth/refresh ÇAĞRILMADI
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it('sunucu yenilemeyi reddederse (401) oturumu düşürür', async () => {
    localStorage.setItem(ACCESS_KEY, 'eski');
    localStorage.setItem(REFRESH_KEY, 'gecersiz-refresh');
    const unauthorized = captureEvent(UNAUTHORIZED_EVENT);
    const fetchMock = queueFetch(
      { status: 401, body: {} },
      { status: 401, body: { message: 'INVALID_REFRESH_TOKEN' } }
    );

    await expect(apiFetch('/sites')).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(2); // tekrar deneme YOK
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it('yenileme sırasında AĞ KOPARSA oturumu düşürür (patlamaz)', async () => {
    localStorage.setItem(ACCESS_KEY, 'eski');
    localStorage.setItem(REFRESH_KEY, 'r1');
    const unauthorized = captureEvent(UNAUTHORIZED_EVENT);

    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(makeResponse({ status: 401, body: {} }));
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiFetch('/sites')).rejects.toThrow();

    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it('yenileme yanıtı accessToken içermiyorsa başarısız sayar (sessizce geçmez)', async () => {
    localStorage.setItem(ACCESS_KEY, 'eski');
    localStorage.setItem(REFRESH_KEY, 'r1');
    const unauthorized = captureEvent(UNAUTHORIZED_EVENT);
    queueFetch(
      { status: 401, body: {} },
      { status: 200, body: { success: true } } // 200 ama token YOK
    );

    await expect(apiFetch('/sites')).rejects.toThrow();

    expect(unauthorized).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(ACCESS_KEY)).toBe('eski'); // üzerine yazılmamalı
  });

  it('başarısız yenileme sonrası eski token localStorage\'da BOZULMADAN kalır', async () => {
    localStorage.setItem(ACCESS_KEY, 'eski-access');
    localStorage.setItem(REFRESH_KEY, 'eski-refresh');
    queueFetch({ status: 401, body: {} }, { status: 401, body: {} });

    await expect(apiFetch('/sites')).rejects.toThrow();

    // Temizleme sorumluluğu AppContext'in logout'una ait; api.ts yarım
    // bırakılmış bir duruma (örn. access silinmiş, refresh durmuş) yol açmamalı.
    expect(localStorage.getItem(ACCESS_KEY)).toBe('eski-access');
    expect(localStorage.getItem(REFRESH_KEY)).toBe('eski-refresh');
  });
});

describe('apiFetch — eşzamanlılık', () => {
  it('aynı anda 401 alan İKİ istek TEK bir yenileme çağrısını paylaşır', async () => {
    localStorage.setItem(ACCESS_KEY, 'eski');
    localStorage.setItem(REFRESH_KEY, 'r1');

    let refreshCallCount = 0;
    const fetchMock = vi.fn(async (url: string, init: any) => {
      if (url.endsWith('/auth/refresh')) {
        refreshCallCount++;
        // Gerçekçi gecikme: iki isteğin de "uçuşta" çakışmasını sağlar.
        await new Promise((r) => setTimeout(r, 10));
        return makeResponse({ status: 200, body: { accessToken: 'yeni', refreshToken: 'r2' } });
      }
      // Yenilenmiş token ile gelen istek başarılı, eski token 401.
      if (init?.headers?.Authorization === 'Bearer yeni') {
        return makeResponse({ status: 200, body: { ok: true } });
      }
      return makeResponse({ status: 401, body: {} });
    });
    vi.stubGlobal('fetch', fetchMock);

    const [a, b] = await Promise.all([apiFetch('/sites'), apiFetch('/vehicles')]);

    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    // KRİTİK: iki ayrı yenileme, refresh token rotasyonu nedeniyle
    // ikincisini "token reuse" durumuna düşürüp tüm oturumları iptal ettirirdi.
    expect(refreshCallCount).toBe(1);
  });
});
