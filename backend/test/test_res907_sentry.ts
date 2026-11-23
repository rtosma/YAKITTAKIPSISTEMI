import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { config } from '../src/config/env';
import { traceMiddleware } from '../src/middleware/loggerMiddleware';
import { globalErrorHandler, notFoundHandler } from '../src/middleware/errorHandler';
import { AppError, BadRequestError, ServiceUnavailableError } from '../src/utils/errors';
import { initSentry, closeSentry, flushSentry, isSentryEnabled, captureServerError } from '../src/observability/sentry';
import { createSentryTunnelHandlers, parseEnvelope, serializeEnvelope, parseDsn } from '../src/observability/sentryTunnel';
import { scrubSentryEvent } from '../src/observability/sentryScrub';
import { scrubString } from '../src/privacy/piiScrub';

/**
 * RES-907 (#192) — Sentry: backend olayı + tarayıcı tüneli + trace_id korelasyonu + kişisel veri temizliği.
 * GERÇEK @sentry/node SDK'sı, yerel bir SAHTE Sentry alıcısına (HTTP) gönderir; gerçek errorHandler/traceMiddleware/tünel
 * yönlendiricisi bir test express uygulamasında çalışır. Canlı Sentry'ye HİÇBİR şey gitmez. Sayılar elle hesaplanmıştır.
 */

const TC = '10000000146';
const PHONE = '05321112233';
const EMAIL = 'ahmet.yilmaz@firma.com.tr';
// Sahte (test) JWT — gerçek bir sır değil; JWT maskeleme kuralını sınamak için. gitleaks:allow
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJhYmMxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36P'; // gitleaks:allow
const COOKIE = 'refresh=cookie-secret-value-777';
const BEARER = 'Bearer abcdefghijklmnop1234567890';
const PUBKEY = 'pubkey123';

interface Received { url: string; headers: http.IncomingHttpHeaders; body: Buffer; }
const received: Received[] = [];

function startSentryMock(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(n: number, timeoutMs = 4000): Promise<void> {
  const t0 = Date.now();
  while (received.length < n && Date.now() - t0 < timeoutMs) await sleep(25);
}
/** Sentry SDK'sının gönderdiği zarflardaki `event` öğeleri. */
function eventsOf(r: Received): any[] {
  return parseEnvelope(r.body).items.filter((i) => i.header.type === 'event').map((i) => JSON.parse(i.payload.toString('utf8')));
}

function startApp(tunnelDeps: Parameters<typeof createSentryTunnelHandlers>[0]): Promise<{ server: http.Server; base: string }> {
  const app = express();
  app.use(traceMiddleware);
  app.get('/boom', (_req, _res, next) => next(new Error(`DB failure for tc ${TC} phone ${PHONE} mail ${EMAIL} token ${JWT} auth ${BEARER}`)));
  app.get('/appfail', (_req, _res, next) => next(new BadRequestError(`Geçersiz tc ${TC}`)));
  app.get('/op500', (_req, _res, next) => next(new AppError('operasyonel 500', 500, true)));
  app.get('/unavailable', (_req, _res, next) => next(new ServiceUnavailableError('AI yok')));
  app.post('/tunnel', ...createSentryTunnelHandlers(tunnelDeps));
  app.use(notFoundHandler);
  app.use(globalErrorHandler);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [RES-907] SENTRY — BACKEND OLAYI, TARAYICI TÜNELİ, TRACE_ID KORELASYONU, PII TEMİZLİĞİ');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };

  const mock = await startSentryMock();
  const DSN = `http://${PUBKEY}@127.0.0.1:${mock.port}/1`;
  const app = await startApp({ getDsn: () => DSN });
  const appOff = await startApp({ getDsn: () => undefined });
  const appDown = await startApp({ getDsn: () => DSN, forward: async () => { throw new Error('upstream down'); } });
  const get = (p: string, headers: Record<string, string> = {}) => fetch(`${app.base}${p}`, { headers });
  const post = (base: string, body: Buffer | string, headers: Record<string, string> = { 'Content-Type': 'text/plain;charset=UTF-8' }) => fetch(`${base}/tunnel`, { method: 'POST', headers, body: body as any });

  try {
    // ── 1. Sürüm/ortam/etiket + PII: backend olayı ───────────────────────────────────────────────────────────────────
    check('Kapalı varsayılan: DSN yoksa initSentry false, isSentryEnabled false, captureServerError no-op (olay id yok)',
      initSentry({ dsn: undefined as any }) === (!!config.SENTRY_DSN) && (config.SENTRY_DSN ? true : !isSentryEnabled() && captureServerError(new Error('x'), {}) === undefined), `DSN tanımlı mı=${!!config.SENTRY_DSN}`);
    await closeSentry();
    check('initSentry(DSN) etkinleşir', initSentry({ dsn: DSN, environment: 'test-env' }) === true && isSentryEnabled(), '');

    const r1 = await get('/boom', { 'X-Trace-ID': 'front-trace-0001', Authorization: BEARER, Cookie: COOKIE });
    const b1: any = await r1.json();
    await flushSentry(3000); await waitFor(1);
    const ev1 = received[0] ? eventsOf(received[0])[0] : undefined;
    const raw1 = received[0] ? received[0].body.toString('utf8') : '';
    check('Backend olayı (AC: trace_id eşleşmesi): 500 yanıtındaki traceId (istemcinin gönderdiği X-Trace-ID korunur) = Sentry olayının `trace_id` etiketi = yanıt başlığı; olay yerel alıcıya ulaştı',
      r1.status === 500 && b1.traceId === 'front-trace-0001' && r1.headers.get('x-trace-id') === 'front-trace-0001' && ev1?.tags?.trace_id === 'front-trace-0001' && ev1?.tags?.service === 'yakittakip-backend', `trace=${ev1?.tags?.trace_id}, olay=${received.length}`);
    check('Sürüm etiketleme (AC): olay `release` = APP_VERSION (imajdan gelen sürüm, /health `version` ile aynı kaynak), `environment` = yapılandırılan ortam',
      ev1?.release === config.APP_VERSION && ev1?.environment === 'test-env', `release=${ev1?.release} (APP_VERSION=${config.APP_VERSION}), env=${ev1?.environment}`);
    const leaks = [TC, PHONE, EMAIL, JWT, 'abcdefghijklmnop1234567890', 'cookie-secret-value-777'].filter((s) => raw1.includes(s));
    check('Kişisel veri (AC): olay gövdesinde TCKN, telefon, e-posta, JWT, Bearer ve çerez YOK — hata mesajı yerinde maskeli ([TCKN]/[TEL]/[EMAIL]/[JWT]); istek başlıkları/çerezi olaya hiç girmez',
      leaks.length === 0 && /\[TCKN\]/.test(raw1) && /\[TEL\]/.test(raw1) && /\[EMAIL\]/.test(raw1) && /\[JWT\]/.test(raw1) && !/cookie/i.test(JSON.stringify(ev1?.request ?? {})), `sızan=[${leaks}] mesaj=${ev1?.exception?.values?.[0]?.value?.slice(0, 120)}`);

    // ── 2. Hangi hatalar raporlanır ───────────────────────────────────────────────────────────────────────────────────
    const before = received.length;
    await get('/appfail'); await get('/unavailable'); await get('/nowhere');
    await flushSentry(1500); await sleep(300);
    check('Gürültü yok: 4xx (BadRequest, 404) ve beklenen 503 (ServiceUnavailable) Sentry\'ye GİTMEZ', received.length === before, `öncesi=${before}, sonrası=${received.length}`);
    await get('/op500', { 'X-Trace-ID': 'front-trace-0500' });
    await flushSentry(3000); await waitFor(before + 1);
    const evOp = received[before] ? eventsOf(received[before])[0] : undefined;
    check('Operasyonel 500 (AppError 500) raporlanır ve trace_id etiketi taşır', received.length === before + 1 && evOp?.tags?.trace_id === 'front-trace-0500', '');

    // ── 3. Örnekleme (maliyet kontrolü) ve kapatma ───────────────────────────────────────────────────────────────────
    await closeSentry();
    initSentry({ dsn: DSN, sampleRate: 0 });
    const n0 = received.length;
    for (let i = 0; i < 3; i++) await get('/boom');
    await flushSentry(1500); await sleep(300);
    // SDK, elenen olayları `client_report` zarfıyla (yalnızca sayaç) bildirir — olay (event) öğesi değil; yalnızca EVENT sayılır.
    const sampled = received.slice(n0).flatMap(eventsOf);
    check('Örnekleme (AC: maliyet): SENTRY_ERROR_SAMPLE_RATE=0 → 3 hata isteği, 0 olay (event) gönderilir', sampled.length === 0, `gönderilen olay=${sampled.length}, zarf=${received.length - n0}`);
    await closeSentry();
    check('Kapatınca captureServerError no-op', captureServerError(new Error('x'), { traceId: 'abcdefgh' }) === undefined, '');

    // ── 4. Tarayıcı tüneli ────────────────────────────────────────────────────────────────────────────────────────────
    const browserEvent = {
      event_id: 'a'.repeat(32), platform: 'javascript', release: 'v-test', environment: 'production',
      message: `Kaydedilemedi: tc ${TC} tel ${PHONE}`,
      user: { id: 'usr-7', email: EMAIL, username: 'ahmet', ip_address: '{{auto}}' },
      request: { method: 'POST', url: `https://panel.firma.com/drivers?tc=${TC}&token=${JWT}#x`, headers: { Authorization: BEARER, Cookie: COOKIE, 'User-Agent': 'UA/1.0' }, data: { tcNo: TC }, cookies: { c: COOKIE } },
      exception: { values: [{ type: 'Error', value: `mail ${EMAIL}`, stacktrace: { frames: [{ filename: 'app.js', lineno: 1, vars: { tcNo: TC } }] } }] },
      breadcrumbs: [{ category: 'fetch', data: { url: `/api/v1/drivers?tc=${TC}`, request_body: `{"tcNo":"${TC}"}`, status_code: 500 } }],
      extra: { phone: PHONE, note: `bilgi ${TC}` },
      tags: { trace_id: 'front-trace-0002', app: 'yakittakip-frontend', 'evil': '<b>' }
    };
    const dsnHeader = DSN;
    const envelope = (dsn: string | undefined, items: Array<{ header: any; payload: Buffer }>) => serializeEnvelope({ ...(dsn ? { dsn } : {}), event_id: 'a'.repeat(32), sent_at: new Date().toISOString() }, items);
    const items = [
      { header: { type: 'event' }, payload: Buffer.from(JSON.stringify(browserEvent)) },
      { header: { type: 'attachment', filename: 'ekran.png' }, payload: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0a, 0x1a, 0x0a, 0x0a, 0x00]) },
      { header: { type: 'replay_event' }, payload: Buffer.from(JSON.stringify({ replay: TC })) },
      { header: { type: 'client_report' }, payload: Buffer.from(JSON.stringify({ discarded_events: [{ reason: 'sample_rate', category: 'error', quantity: 2 }] })) }
    ];
    received.length = 0;
    const t1 = await post(app.base, envelope(dsnHeader, items));
    await waitFor(1);
    const fwd = received[0];
    const parsed = fwd ? parseEnvelope(fwd.body) : undefined;
    const fwdEvent = parsed ? JSON.parse(parsed.items.find((i) => i.header.type === 'event')!.payload.toString('utf8')) : undefined;
    const fwdText = fwd ? fwd.body.toString('utf8') : '';
    const fwdLeaks = [TC, PHONE, EMAIL, JWT, 'abcdefghijklmnop1234567890', 'cookie-secret-value-777', 'ahmet', 'ekran.png', '{{auto}}'].filter((s) => fwdText.includes(s));
    check('Tünel (AC: olay gövdesinde PII yok): tarayıcı olayı SUNUCUDA yeniden temizlenir — TCKN/telefon/e-posta/JWT/Bearer/çerez/kullanıcı adı/IP/istek gövdesi/URL sorgusu/stack vars/breadcrumb gövdesi ileri GİTMEZ; kullanıcı yalnızca id',
      t1.status === 200 && received.length === 1 && fwdLeaks.length === 0 && fwdEvent.user?.id === 'usr-7' && Object.keys(fwdEvent.user).length === 1 && fwdEvent.request.url === 'https://panel.firma.com/drivers' && fwdEvent.request.data === undefined &&
        fwdEvent.exception.values[0].stacktrace.frames[0].vars === undefined && fwdEvent.breadcrumbs[0].data.url === '/api/v1/drivers' && fwdEvent.breadcrumbs[0].data.request_body === undefined && fwdEvent.message === 'Kaydedilemedi: tc [TCKN] tel [TEL]', `sızan=[${fwdLeaks}] durum=${t1.status}`);
    check('Tünel: yalnızca event + client_report iletilir; attachment ve replay (kişisel veri taşıyabilir) ATILIR; zarf yeniden serileştirilir (her öğenin length\'i gerçek yük uzunluğuna eşit); başlıktaki dsn sunucunun DSN\'i; Sentry ingest URL\'i doğru anahtar/proje ile',
      parsed?.items.map((i) => i.header.type).join() === 'event,client_report' && parsed!.items.every((i) => JSON.parse(i.payload.toString()) !== undefined) && parsed!.header.dsn === DSN &&
        fwd.url === `/api/1/envelope/?sentry_key=${PUBKEY}&sentry_version=7` && String(fwd.headers['content-type']).includes('x-sentry-envelope') && fwd.headers['x-forwarded-for'] === undefined, `öğeler=${parsed?.items.map((i) => i.header.type)}, url=${fwd?.url}`);
    check('Tünel: etiket enjeksiyonu engellenir — geçerli trace_id (front-trace-0002) kalır, bozuk biçimli etiket (<b>) düşer; ekstra etiketler korunur',
      fwdEvent.tags.trace_id === 'front-trace-0002' && fwdEvent.tags.app === 'yakittakip-frontend', JSON.stringify(fwdEvent.tags));
    const badTag = envelope(dsnHeader, [{ header: { type: 'event' }, payload: Buffer.from(JSON.stringify({ ...browserEvent, tags: { trace_id: '<script>x</script>' } })) }]);
    received.length = 0; await post(app.base, badTag); await waitFor(1);
    check('Tünel: güvensiz trace_id değeri olaydan SİLİNİR', eventsOf(received[0])[0].tags.trace_id === undefined, '');

    // güvenlik: açık röle olmamalı
    received.length = 0;
    const other = (d: string) => post(app.base, envelope(d, [items[0]]));
    const s1 = await other(`http://otherkey@127.0.0.1:${mock.port}/1`);
    const s2 = await other(`http://${PUBKEY}@127.0.0.1:${mock.port}/2`);
    const s3 = await other(`http://${PUBKEY}@evil.example.com/1`);
    const s4 = await post(app.base, envelope(undefined, [items[0]]));
    const s5 = await post(app.base, 'bu bir zarf değil');
    const s6 = await post(app.base, '', { 'Content-Type': 'text/plain' });
    const s7 = await post(app.base, Buffer.alloc(300 * 1024, 0x41));
    await sleep(200);
    check('Açık röle YOK: başka anahtar/proje/host\'a ait DSN → 403; DSN\'siz zarf → 400; çöp gövde → 400; boş gövde → 400; 256 KB üstü → 413 — hiçbiri ileri iletilmez',
      [s1.status, s2.status, s3.status, s4.status, s5.status, s6.status, s7.status].join() === '403,403,403,400,400,400,413' && received.length === 0, `${[s1.status, s2.status, s3.status, s4.status, s5.status, s6.status, s7.status]} iletilen=${received.length}`);
    const off = await post(appOff.base, envelope(dsnHeader, [items[0]]));
    check('DSN yapılandırılmamışsa tünel 204 döner (sessiz, hata fırtınası yok) ve hiçbir şey iletilmez', off.status === 204 && received.length === 0, `${off.status}`);
    const down = await post(appDown.base, envelope(dsnHeader, [items[0]]));
    check('Sentry erişilemezse tarayıcıya 200 döner (istemci retry fırtınası yok; sunucu loguna uyarı)', down.status === 200, `${down.status}`);

    // ── 5. Uçtan uca trace_id korelasyonu: tarayıcı + sunucu olayı AYNI trace_id ─────────────────────────────────────
    await closeSentry();
    initSentry({ dsn: DSN });
    received.length = 0;
    const TRACE = 'e2e-trace-4242abcd';
    const apiCall = await get('/boom', { 'X-Trace-ID': TRACE });          // tarayıcının yaptığı API çağrısı (X-Trace-ID gönderir) → 500
    const shown: any = await apiCall.json();
    await flushSentry(3000);
    const browserSide = envelope(dsnHeader, [{ header: { type: 'event' }, payload: Buffer.from(JSON.stringify({ event_id: 'b'.repeat(32), platform: 'javascript', message: 'API POST /boom → 500', tags: { trace_id: shown.traceId, app: 'yakittakip-frontend' } })) }]);
    await post(app.base, browserSide);
    await waitFor(2);
    const evts = received.flatMap(eventsOf);
    const svc = new Set(evts.map((e) => e.tags?.service ?? e.tags?.app));
    check('Korelasyon (AC): aynı API hatası için tarayıcı olayı (app=yakittakip-frontend) ve sunucu olayı (service=yakittakip-backend) AYNI trace_id\'yi taşır — Sentry\'de tek etiketle eşleşir',
      evts.length === 2 && evts.every((e) => e.tags.trace_id === TRACE) && svc.has('yakittakip-frontend') && svc.has('yakittakip-backend') && shown.traceId === TRACE, `olay=${evts.length}, servisler=${[...svc]}`);
    await closeSentry();

    // ── 6. Saf temizleyici ve ayrıştırıcı ───────────────────────────────────────────────────────────────────────────
    const s = scrubSentryEvent({ user: { email: EMAIL }, tags: { trace_id: 'kısa' } } as any) as any;
    check('scrubSentryEvent: id\'siz kullanıcı tamamen atılır; çok kısa/bozuk trace_id düşer', s.user === undefined && s.tags.trace_id === undefined, JSON.stringify(s));
    const p = parseDsn('https://abc@o123.ingest.sentry.io/456'); const p2 = parseDsn('https://abc@sentry.firma.com/prefix/9');
    check('parseDsn: SaaS ve self-hosted (yol önekli) DSN doğru ayrıştırılır; geçersiz DSN null', p?.publicKey === 'abc' && p?.projectId === '456' && p?.origin === 'https://o123.ingest.sentry.io' && p2?.pathPrefix === '/prefix' && p2?.projectId === '9' && parseDsn('geçersiz') === null, JSON.stringify(p2));
    check('Log temizleyici: JWT ve Bearer token metinleri loglarda da maskelenir (RES-907 ek kural)', scrubString(`x ${JWT} y ${BEARER}`) === 'x [JWT] y Bearer [TOKEN]', scrubString(`x ${JWT} y ${BEARER}`));

    // ── 7. Canlı backend'de tünel kablolaması ─────────────────────────────────────────────────────────────────────────
    const live = await fetch('http://localhost:5000/api/v1/monitoring/sentry-tunnel', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: envelope(dsnHeader, [items[0]]) as any });
    const liveEmpty = await fetch('http://localhost:5000/api/v1/monitoring/sentry-tunnel', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '' });
    check('Canlı backend: tünel kimliksiz erişilebilir, IP limitli (RateLimit-Limit: 120); DSN yapılandırılmamış ortamda 204, boş gövde 400',
      (live.status === 204 || live.status === 403 || live.status === 200) && live.headers.get('ratelimit-limit') === '120' && liveEmpty.status === 400, `canlı=${live.status}, limit=${live.headers.get('ratelimit-limit')}, boş=${liveEmpty.status}`);
    void dsnHeader;
  } finally {
    await closeSentry();
    for (const s of [app.server, appOff.server, appDown.server, mock.server]) s.close();
  }
  console.log('===========================================================');
  console.log(`📊 SONUÇ: ${passed} / ${total} TEST BAŞARILI`);
  console.log('===========================================================');
  process.exit(passed === total ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
