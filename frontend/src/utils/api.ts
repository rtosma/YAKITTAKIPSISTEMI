export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1';

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

  // Handle 401 Unauthorized (can add automatic refresh token logic here in the future)
  if (response.status === 401) {
    // Attempt token refresh or logout
    console.warn('API returned 401 Unauthorized.');
    // To keep it simple, we let the UI handle logout or token expiry notification
  }

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const errorMsg = data?.message || response.statusText || 'Bilinmeyen API Hatası';
    throw new Error(errorMsg);
  }

  return data;
}
