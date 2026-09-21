import * as Sentry from '@sentry/react';

/**
 * RES-907 (#192) — tarayıcı hata izleme.
 *
 *  - DSN yoksa (VITE_SENTRY_DSN boş) HİÇBİR şey başlatılmaz (no-op).
 *  - Olaylar Sentry'ye DOĞRUDAN değil, same-origin TÜNELDEN gider (`/api/v1/monitoring/sentry-tunnel`): CSP `connect-src 'self'`
 *    korunur, reklam engelleyiciler kesmez ve olaylar sunucuda YENİDEN temizlenir (backend/src/observability/sentryTunnel.ts —
 *    asıl güvence orasıdır; buradaki temizlik ilk katmandır).
 *  - trace_id: her API çağrısı `X-Trace-ID` gönderir (backend bunu korur, loglara ve hata yanıtına yazar). API hatası olduğunda
 *    olay `trace_id` etiketiyle gider; backend'in aynı istek için gönderdiği olay AYNI etiketi taşır → Sentry'de eşleşir.
 *    Pencere hataları (window.onerror) `last_api_trace_id` etiketini taşır (en son API isteği).
 *  - Örnekleme: hata olayları VITE_SENTRY_SAMPLE_RATE (varsayılan 1); performans izi ve oturum tekrarı (replay — ekran görüntüsü =
 *    kişisel veri) KAPALI.
 *  - Sürüm: VITE_APP_VERSION (deploy betiği APP_VERSION'ı build-arg olarak geçirir; backend `release` ile aynı değer).
 */
// Source map testi (scripts/test-res907.mjs --build): derlenmiş pakette bu dizgenin konumu, .map ile bu dosya/satıra geri çözülür.
export const SOURCEMAP_PROBE = 'res907-sourcemap-probe';

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) || '/api/v1';
export const SENTRY_TUNNEL_URL = `${API_BASE}/monitoring/sentry-tunnel`;
export const TRACE_ID_HEADER = 'X-Trace-ID';
export const TRACE_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

let lastApiTraceId: string | undefined;
let initialized = false;

export function newTraceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function setLastApiTraceId(id: string | undefined): void {
  lastApiTraceId = id && TRACE_ID_PATTERN.test(id) ? id : undefined;
}
export function getLastApiTraceId(): string | undefined {
  return lastApiTraceId;
}

// ── Kişisel veri temizliği (backend/src/privacy/piiScrub.ts + observability/sentryScrub.ts ile AYNI kurallar; sunucu tünelinde yeniden uygulanır) ──
const PII_KEY = /^(tc_?no|tckn|tc_?kimlik(_?no)?|phone|telefon|gsm|mobile|email|e_?mail|password|passwd|token|secret|authorization|cookie|set-cookie|(access|refresh|id)_?token|api_?key|jwt|signature)$/i;
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const TC_RE = /(?<![\d])[1-9]\d{10}(?![\d])/g;
const PHONE_RE = /(?<![\d])(?:\+?90[\s.-]?|0[\s.-]?)?\(?5\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}(?![\d])/g;
const SAFE_HEADERS = new Set(['user-agent', 'content-type', 'accept', 'accept-language', 'x-trace-id']);

export function isValidTcNo(s: string): boolean {
  if (!/^[1-9]\d{10}$/.test(s)) return false;
  const d = s.split('').map(Number);
  const tenth = (((d[0] + d[2] + d[4] + d[6] + d[8]) * 7) - (d[1] + d[3] + d[5] + d[7])) % 10;
  return d[9] === (tenth + 10) % 10 && d[10] === d.slice(0, 10).reduce((a, b) => a + b, 0) % 10;
}

export function scrubText(input: string): string {
  if (input.length < 7) return input;
  return input
    .replace(JWT_RE, '[JWT]')
    .replace(BEARER_RE, 'Bearer [TOKEN]')
    .replace(EMAIL_RE, '[EMAIL]')
    .replace(TC_RE, (m) => (isValidTcNo(m) ? '[TCKN]' : m))
    .replace(PHONE_RE, '[TEL]');
}

function scrubDeep(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 8) return '[Truncated]';
  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = PII_KEY.test(k) && v != null ? '[PII]' : scrubDeep(v, depth + 1, seen);
  return out;
}

export function stripUrlQuery(url: unknown): unknown {
  return typeof url === 'string' ? scrubText(url.replace(/[?#].*$/, '')) : url;
}

function cleanBreadcrumb(b: any): any {
  if (!b || typeof b !== 'object') return b;
  const out: any = { ...b };
  if (out.data && typeof out.data === 'object') {
    const d: any = { ...out.data };
    for (const k of ['url', 'to', 'from']) if (k in d) d[k] = stripUrlQuery(d[k]);
    delete d.request_body; delete d.response_body; delete d.body; delete d.input;
    out.data = d;
  }
  if (out.category === 'ui.input') delete out.message;
  return out;
}

export function scrubBreadcrumb<T>(b: T): T {
  return scrubDeep(cleanBreadcrumb(b)) as T;
}

export function scrubEvent<T extends Record<string, any>>(event: T): T {
  const e: any = { ...event };
  if (e.request && typeof e.request === 'object') {
    const headers: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e.request.headers ?? {})) if (SAFE_HEADERS.has(k.toLowerCase())) headers[k] = v;
    e.request = { method: e.request.method, url: stripUrlQuery(e.request.url), headers };
  }
  if (e.user && typeof e.user === 'object') e.user = e.user.id != null ? { id: String(e.user.id) } : undefined;
  if (Array.isArray(e.breadcrumbs)) e.breadcrumbs = e.breadcrumbs.map(cleanBreadcrumb);
  for (const ex of e.exception?.values ?? []) for (const f of ex.stacktrace?.frames ?? []) delete f.vars;
  const out: any = scrubDeep(e);
  out.tags = { ...(out.tags ?? {}) };
  if (lastApiTraceId && !out.tags.last_api_trace_id) out.tags.last_api_trace_id = lastApiTraceId;
  for (const key of ['trace_id', 'last_api_trace_id']) {
    if (out.tags[key] !== undefined && !(typeof out.tags[key] === 'string' && TRACE_ID_PATTERN.test(out.tags[key]))) delete out.tags[key];
  }
  if (out.user === undefined) delete out.user;
  return out as T;
}

export function initSentry(): boolean {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (initialized || !dsn) return false;
  const rate = Number(import.meta.env.VITE_SENTRY_SAMPLE_RATE ?? 1);
  Sentry.init({
    dsn,
    tunnel: SENTRY_TUNNEL_URL,
    release: (import.meta.env.VITE_APP_VERSION as string | undefined) || 'dev',
    environment: import.meta.env.MODE,
    sampleRate: Number.isFinite(rate) ? Math.min(Math.max(rate, 0), 1) : 1,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    maxBreadcrumbs: 30,
    // `sourcemap_probe` etiketi: derleme testi (scripts/test-res907.mjs --build) bu sabitin pakette KALDIĞINI (tree-shake edilmediğini) ve .map ile geri çözüldüğünü doğrular.
    initialScope: { tags: { app: 'yakittakip-frontend', sourcemap_probe: SOURCEMAP_PROBE } },
    // Konsol/DOM/XHR breadcrumb'ları kullanıcı girdisi/log metni taşıyabilir → kapalı; fetch/history yalnızca URL (sorgusuz) + durum.
    integrations: (defaults) => [
      ...defaults.filter((i) => i.name !== 'Breadcrumbs'),
      Sentry.breadcrumbsIntegration({ console: false, dom: false, xhr: false, fetch: true, history: true, sentry: true })
    ],
    ignoreErrors: ['ResizeObserver loop limit exceeded', 'ResizeObserver loop completed with undelivered notifications.'],
    denyUrls: [/^chrome-extension:\/\//i, /^moz-extension:\/\//i],
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (b) => scrubBreadcrumb(b)
  });
  initialized = true;
  return true;
}

/** Bir API çağrısı sunucu hatası/ağ hatasıyla bittiğinde çağrılır: `trace_id` etiketiyle raporlar (backend'in aynı istek için gönderdiği olayla eşleşir). */
export function reportApiFailure(info: { traceId: string; endpoint: string; method: string; status?: number; message: string }): void {
  if (!initialized) return;
  Sentry.withScope((scope) => {
    scope.setTag('trace_id', info.traceId);
    scope.setTag('api_status', info.status !== undefined ? String(info.status) : 'network');
    scope.setContext('api', { endpoint: stripUrlQuery(info.endpoint), method: info.method });
    Sentry.captureException(new Error(`API ${info.method} ${String(stripUrlQuery(info.endpoint))} → ${info.status ?? 'ağ hatası'}: ${info.message}`));
  });
}

export const SentryErrorBoundary = Sentry.ErrorBoundary;
