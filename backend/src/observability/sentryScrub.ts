import { scrubValue, scrubString } from '../privacy/piiScrub';

/**
 * RES-907 (#192) — Sentry'ye giden olayların kişisel veri/token temizliği (COMP-606 ile aynı kural motoru: privacy/piiScrub.ts).
 * "Sentry'ye giden veride kişisel veri bulunmamalıdır; `beforeSend` ile temizlik zorunludur." Hem backend SDK'sının `beforeSend`'i
 * hem de tarayıcı olaylarının geçtiği sunucu tüneli (sentryTunnel.ts) BU fonksiyonu çağırır — tarayıcıdaki temizlik yalnızca
 * "iyi niyetli" ilk katmandır, sunucu tarafı yetkili katmandır (ele geçirilmiş/eski bir istemci bile PII sızdıramaz).
 *
 * Kurallar (beyaz liste yaklaşımı — bilinmeyen alan varsayılan olarak temizlenen değer kuralına tabidir):
 *  - request: yalnızca method + URL (query/fragment ATILIR — `?tc=...` gibi sızıntılar) + güvenli birkaç başlık; gövde, çerez, query_string atılır.
 *  - user: yalnızca `id` (sahte-adlı kimlik); e-posta, kullanıcı adı, IP atılır.
 *  - exception/mesaj/breadcrumb metinleri: TCKN, telefon, e-posta, JWT, Bearer → maske; anahtar tabanlı ([PII]) alanlar.
 *  - stack frame `vars` (yerel değişkenler) atılır.
 *  - `trace_id` etiketi yalnızca güvenli biçimde ([A-Za-z0-9._-]{8,64}) kalır — istemciden gelen etiket enjeksiyonu engellenir.
 */
const SAFE_HEADERS = new Set(['user-agent', 'content-type', 'accept', 'accept-language', 'x-trace-id']);
export const TRACE_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

export function stripUrlQuery(url: unknown): unknown {
  if (typeof url !== 'string') return url;
  return scrubString(url.replace(/[?#].*$/, ''));
}

function cleanBreadcrumb(b: any): any {
  if (!b || typeof b !== 'object') return b;
  const out: any = { ...b };
  if (out.data && typeof out.data === 'object') {
    const d: any = { ...out.data };
    if ('url' in d) d.url = stripUrlQuery(d.url);
    if ('to' in d) d.to = stripUrlQuery(d.to);
    if ('from' in d) d.from = stripUrlQuery(d.from);
    delete d.request_body; delete d.response_body; delete d.body; delete d.input;
    out.data = d;
  }
  // Kullanıcı girdisi breadcrumb'ları (tıklanan/yazılan alan içeriği) mesajında kişisel veri taşıyabilir.
  if (out.category === 'ui.input') delete out.message;
  return out;
}

export function scrubSentryBreadcrumb<T>(breadcrumb: T): T {
  return scrubValue(cleanBreadcrumb(breadcrumb)) as T;
}

export function scrubSentryEvent<T extends Record<string, any>>(event: T): T {
  const e: any = { ...event };

  if (e.request && typeof e.request === 'object') {
    const headers: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e.request.headers ?? {})) if (SAFE_HEADERS.has(k.toLowerCase())) headers[k] = v;
    e.request = { method: e.request.method, url: stripUrlQuery(e.request.url), headers };
  }
  if (e.user && typeof e.user === 'object') e.user = e.user.id != null ? { id: String(e.user.id) } : undefined;
  if (Array.isArray(e.breadcrumbs)) e.breadcrumbs = e.breadcrumbs.map(cleanBreadcrumb);
  else if (e.breadcrumbs?.values) e.breadcrumbs = { ...e.breadcrumbs, values: e.breadcrumbs.values.map(cleanBreadcrumb) };
  for (const ex of e.exception?.values ?? []) {
    for (const f of ex.stacktrace?.frames ?? []) delete f.vars;
  }
  delete e.server_name_ip;

  const scrubbed: any = scrubValue(e);
  if (scrubbed.tags && typeof scrubbed.tags === 'object') {
    const t = scrubbed.tags.trace_id;
    if (t !== undefined && !(typeof t === 'string' && TRACE_ID_PATTERN.test(t))) delete scrubbed.tags.trace_id;
  }
  if (scrubbed.user === undefined) delete scrubbed.user;
  return scrubbed as T;
}
