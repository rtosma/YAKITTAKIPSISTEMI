export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1';

/**
 * Fired on `window` whenever a request comes back 401 AND the refresh
 * attempt below also failed (or there was no refresh token) — i.e. the
 * session is genuinely over. AppContext listens for this (see its
 * useEffect) and logs the user out so the app's existing route guards
 * (isAuthenticated checks in each layout) redirect to a login screen.
 */
export const UNAUTHORIZED_EVENT = 'yakit:unauthorized';

/**
 * Fired once, right after a background token refresh (401 → silent retry)
 * succeeds — AppContext listens and updates its stored tokens/currentUser
 * so a later apiFetch call (or a page reload) doesn't use the stale pair.
 */
export const TOKENS_REFRESHED_EVENT = 'yakit:tokens-refreshed';

/**
 * FE-804 AC: "Token yenileme kullanıcıya görünmeden gerçekleşmelidir."
 * Önceden bir 401 doğrudan UNAUTHORIZED_EVENT'i tetikleyip kullanıcıyı
 * anında çıkışa zorluyordu — 15 dakikalık access token'ın süresi her
 * dolduğunda (7 günlük refresh token hâlâ geçerliyken bile) kullanıcı
 * yeniden giriş yapmak zorunda kalıyordu. Artık önce refresh token ile
 * sessizce yeni bir access token alınmaya çalışılır; yalnızca BU da
 * başarısız olursa (refresh token da geçersiz/süresi dolmuş) oturum
 * gerçekten düşürülür.
 *
 * Eşzamanlı birden fazla istek aynı anda 401 alırsa (örn. sayfa açılışında
 * paralel fetch'ler) hepsi AYNI tek refresh çağrısını paylaşır — her biri
 * kendi refresh isteğini atıp token'ı birbirinin üzerine yazmaz.
 */
let inFlightRefresh: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  if (inFlightRefresh) return inFlightRefresh;

  inFlightRefresh = (async () => {
    const refreshToken = localStorage.getItem('YAKIT_REFRESH_TOKEN');
    if (!refreshToken) return null;

    try {
      const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.accessToken) return null;

      localStorage.setItem('YAKIT_ACCESS_TOKEN', data.accessToken);
      localStorage.setItem('YAKIT_REFRESH_TOKEN', data.refreshToken);
      window.dispatchEvent(new CustomEvent(TOKENS_REFRESHED_EVENT));
      return data.accessToken as string;
    } catch {
      return null;
    }
  })();

  try {
    return await inFlightRefresh;
  } finally {
    inFlightRefresh = null;
  }
}

/**
 * Custom fetch wrapper that automatically attaches JWT tokens
 * and handles basic JSON parsing/error throwing.
 */
export async function apiFetch(endpoint: string, options: RequestInit = {}) {
  const doFetch = async (accessToken: string | null) => {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...options.headers,
    };
    if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

    return fetch(`${API_BASE_URL}${endpoint}`, {
      cache: 'no-store', // Always fetch fresh data, ignore browser cache
      ...options,
      headers,
    });
  };

  const token = localStorage.getItem('YAKIT_ACCESS_TOKEN');
  let response = await doFetch(token);

  // Yalnızca "bir token GÖNDERDİYSEK ve yine de 401 aldıysak" sessiz
  // yenilemeyi dene — token'sız bir 401 (örn. giriş öncesi bir çağrı)
  // normal/beklenen bir ret, oturumla ilgisi yok.
  if (response.status === 401 && token) {
    const newToken = await refreshAccessToken();
    if (newToken) {
      response = await doFetch(newToken);
    } else {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    }
  }

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const errorMsg = data?.message || response.statusText || 'Bilinmeyen API Hatası';
    throw new Error(errorMsg);
  }

  return data;
}
