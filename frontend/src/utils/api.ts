export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1';

/**
 * Fired on `window` whenever an authenticated request comes back 401 —
 * i.e. the access token expired or was invalidated server-side. AppContext
 * listens for this (see its useEffect) and logs the user out so the app's
 * existing route guards (isAuthenticated checks in each layout) redirect to
 * a login screen, instead of the user silently seeing failed-request toasts
 * forever with no way back in.
 */
export const UNAUTHORIZED_EVENT = 'yakit:unauthorized';

/**
 * Custom fetch wrapper that automatically attaches JWT tokens
 * and handles basic JSON parsing/error throwing.
 */
export async function apiFetch(endpoint: string, options: RequestInit = {}) {
  const token = localStorage.getItem('YAKIT_ACCESS_TOKEN');

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    cache: 'no-store', // Always fetch fresh data, ignore browser cache
    ...options,
    headers,
  });

  // Only treat this as a "session expired" event if we actually believed we
  // were authenticated (a token was sent). A 401 with no token is a normal,
  // expected rejection (e.g. a guard-less call before login) — not a reason
  // to log anyone out.
  if (response.status === 401 && token) {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  }

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const errorMsg = data?.message || response.statusText || 'Bilinmeyen API Hatası';
    throw new Error(errorMsg);
  }

  return data;
}
