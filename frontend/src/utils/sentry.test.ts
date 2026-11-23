import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from './api';
import { getLastApiTraceId, isValidTcNo, scrubBreadcrumb, scrubEvent, scrubText, setLastApiTraceId, SENTRY_TUNNEL_URL, TRACE_ID_HEADER } from './sentry';

/**
 * RES-907 (#192) — tarayıcı tarafı: kişisel veri temizliği (AC: olay gövdesinde kişisel veri yok) ve trace_id korelasyonu.
 * Asıl (yetkili) temizlik sunucu tünelindedir — backend/test/test_res907_sentry.ts; burası ilk katmandır.
 */
const TC = '10000000146';

describe('scrubText', () => {
  it('geçerli TCKN, telefon, e-posta, JWT ve Bearer maskelenir; rastgele 11 haneli sayı ve zaman damgası dokunulmaz', () => {
    // Sahte (test) JWT — gerçek bir sır değil. gitleaks:allow
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJhYmMifQ.SflKxwRJSMeKKF2QT4fw'; // gitleaks:allow
    const out = scrubText(`tc ${TC} tel 0532 111 22 33 mail a@b.co ${jwt} Authorization: Bearer abcdefghijklmnop1234 ref 12345678901 ts 2026-09-21T08:18:24.665Z`);
    expect(out).toBe('tc [TCKN] tel [TEL] mail [EMAIL] [JWT] Authorization: Bearer [TOKEN] ref 12345678901 ts 2026-09-21T08:18:24.665Z');
    expect(isValidTcNo(TC)).toBe(true);
    expect(isValidTcNo('12345678901')).toBe(false);
  });
});

describe('scrubEvent', () => {
  const base = () => ({
    message: `Sürücü ${TC} kaydedilemedi`,
    user: { id: 'usr-1', email: 'a@b.co', username: 'ahmet', ip_address: '1.2.3.4' },
    request: { method: 'POST', url: `https://x.test/drivers?tc=${TC}&token=abc#frag`, headers: { Authorization: 'Bearer abcdefghijklmnop1234', Cookie: 's=1', 'User-Agent': 'UA', 'X-Trace-ID': 'aaaaaaaa-1111' }, data: { tcNo: TC }, cookies: { s: '1' }, query_string: `tc=${TC}` },
    exception: { values: [{ type: 'Error', value: `hata tel 05321112233`, stacktrace: { frames: [{ filename: 'a.js', vars: { tcNo: TC } }] } }] },
    breadcrumbs: [{ category: 'fetch', data: { url: `/api/v1/drivers?tc=${TC}`, request_body: `{"tcNo":"${TC}"}`, status_code: 500 } }, { category: 'ui.input', message: `input ${TC}` }],
    extra: { phone: '05321112233', note: `not ${TC}` },
    tags: { trace_id: 'ok-trace-1234', bad: 'x' }
  });

  it('PII/token alanları temizlenir: kullanıcı yalnız id, URL sorgusuz, başlık beyaz liste, gövde/çerez yok, stack vars yok, breadcrumb gövdesi yok', () => {
    const out: any = scrubEvent(base());
    const text = JSON.stringify(out);
    for (const secret of [TC, '05321112233', 'a@b.co', 'ahmet', '1.2.3.4', 'abcdefghijklmnop1234', 's=1']) expect(text).not.toContain(secret);
    expect(out.user).toEqual({ id: 'usr-1' });
    expect(out.request.url).toBe('https://x.test/drivers');
    expect(Object.keys(out.request.headers).sort()).toEqual(['User-Agent', 'X-Trace-ID']);
    expect(out.request.data).toBeUndefined();
    expect(out.exception.values[0].stacktrace.frames[0].vars).toBeUndefined();
    expect(out.breadcrumbs[0].data.url).toBe('/api/v1/drivers');
    expect(out.breadcrumbs[0].data.request_body).toBeUndefined();
    expect(out.breadcrumbs[0].data.status_code).toBe(500);
    expect(out.breadcrumbs[1].message).toBeUndefined();
    expect(out.message).toBe('Sürücü [TCKN] kaydedilemedi');
  });

  it('trace_id etiketi yalnızca güvenli biçimdeyse kalır; en son API trace id\'si eklenir', () => {
    setLastApiTraceId('last-trace-0001');
    const good: any = scrubEvent(base());
    expect(good.tags.trace_id).toBe('ok-trace-1234');
    expect(good.tags.last_api_trace_id).toBe('last-trace-0001');
    const bad: any = scrubEvent({ ...base(), tags: { trace_id: '<script>alert(1)</script>' } });
    expect(bad.tags.trace_id).toBeUndefined();
  });

  it('kullanıcıda id yoksa user tamamen atılır; breadcrumb temizleyici tek başına da çalışır', () => {
    expect((scrubEvent({ user: { email: 'a@b.co' } }) as any).user).toBeUndefined();
    const b: any = scrubBreadcrumb({ category: 'navigation', data: { to: `/x?tc=${TC}`, from: '/y' } });
    expect(b.data.to).toBe('/x');
  });
});

describe('apiFetch trace_id korelasyonu', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('her istek X-Trace-ID gönderir; başarısız yanıtta hata sunucunun traceId\'sini taşır', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: '', json: async () => ({ message: 'Sunucu hatası', traceId: 'server-trace-9999' }), headers: { get: () => null } });
    vi.stubGlobal('fetch', fetchMock);
    let caught: any;
    await apiFetch('/vehicles').catch((e) => { caught = e; });
    const sent = (fetchMock.mock.calls[0][1] as any).headers[TRACE_ID_HEADER];
    expect(sent).toMatch(/^[A-Za-z0-9._-]{8,64}$/);
    expect(caught.traceId).toBe('server-trace-9999');
    expect(caught.status).toBe(500);
    expect(getLastApiTraceId()).toBe('server-trace-9999');
  });

  it('istek trace id\'si iki çağrıda farklıdır; sunucu başlığı varsa öncelik başlığındır', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}), headers: { get: () => null } })
      .mockResolvedValueOnce({ ok: false, status: 400, statusText: '', json: async () => ({ message: 'x' }), headers: { get: (h: string) => (h === TRACE_ID_HEADER ? 'hdr-trace-00001' : null) } });
    vi.stubGlobal('fetch', fetchMock);
    await apiFetch('/a');
    let caught: any;
    await apiFetch('/b').catch((e) => { caught = e; });
    expect((fetchMock.mock.calls[0][1] as any).headers[TRACE_ID_HEADER]).not.toBe((fetchMock.mock.calls[1][1] as any).headers[TRACE_ID_HEADER]);
    expect(caught.traceId).toBe('hdr-trace-00001');
  });

  it('tünel yolu same-origin (CSP connect-src self ile uyumlu)', () => {
    expect(SENTRY_TUNNEL_URL).toBe('/api/v1/monitoring/sentry-tunnel');
  });
});
