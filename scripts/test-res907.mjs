#!/usr/bin/env node
// ==============================================================================
// RES-907 (#192) — Sentry entegrasyonu statik/sözleşme testleri (sıfır npm bağımlılığı).
//   node scripts/test-res907.mjs           statik sözleşme (docker gerekmez)
//   node scripts/test-res907.mjs --build   + frontend paketini DERLER: source map üretimi, `sourceMappingURL` yokluğu ve
//                                          bir konumun .map ile ORİJİNAL kaynak dosya/satırına geri çözülmesi (AC: okunabilir stack)
// Davranış testleri: backend/test/test_res907_sentry.ts (SDK→sahte alıcı, tünel, korelasyon, PII) ve frontend/src/utils/sentry.test.ts.
// ==============================================================================
import { readFileSync, readdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = process.argv.includes('--build');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
let passed = 0;
let total = 0;
const check = (name, ok, detail = '') => {
  total++;
  if (ok) passed++;
  console.log(`${ok ? '✅ [PASS]' : '❌ [FAIL]'} ${name}${detail ? `\n   ${detail}` : ''}`);
};

// ── Yapılandırma ─────────────────────────────────────────────────────────────
const env = read('backend/src/config/env.ts');
const compose = read('docker-compose.yml');
const beEx = read('backend/.env.example');
check('Yapılandırma: SENTRY_DSN (opsiyonel, boş = kapalı), hata/trace örnekleme oranları (0–1; trace varsayılan 0) ve ortam env şemasında; .env.example + iki dağıtım şablonu + compose geçişi tutarlı',
  /SENTRY_DSN: z\.string\(\)\.url/.test(env) && /SENTRY_ERROR_SAMPLE_RATE: z\.coerce\.number\(\)\.min\(0\)\.max\(1\)\.default\(1\)/.test(env) && /SENTRY_TRACES_SAMPLE_RATE: z\.coerce\.number\(\)\.min\(0\)\.max\(1\)\.default\(0\)/.test(env) &&
    /'SENTRY_DSN'/.test(env.slice(env.indexOf('OPTIONAL_KEYS_EMPTY_MEANS_UNSET'))) && ['backend/.env.example', 'deploy/env/staging.env.example', 'deploy/env/production.env.example'].every((f) => /^SENTRY_DSN=$/m.test(read(f)) && /^SENTRY_TRACES_SAMPLE_RATE=0$/m.test(read(f))) &&
    /SENTRY_DSN: \$\{SENTRY_DSN:-\}/.test(compose) && beEx.includes('same-origin tünelden'), '');

// ── Backend ──────────────────────────────────────────────────────────────────
const sentry = read('backend/src/observability/sentry.ts');
check('Backend SDK: yalnızca hata izleme — varsayılan entegrasyonlar/OpenTelemetry KAPALI (defaultIntegrations:false, skipOpenTelemetrySetup), sendDefaultPii:false, beforeSend/beforeBreadcrumb PII temizler, release = APP_VERSION',
  /defaultIntegrations: false/.test(sentry) && /skipOpenTelemetrySetup: true/.test(sentry) && /sendDefaultPii: false/.test(sentry) && /beforeSend: \(event\) => scrubSentryEvent\(event\)/.test(sentry) && /beforeBreadcrumb/.test(sentry) && /release: overrides\.release \?\? config\.APP_VERSION/.test(sentry), '');
const eh = read('backend/src/middleware/errorHandler.ts');
check('Hata işleyici: beklenmeyen hata ve AppError 5xx (503 HARİÇ) captureServerError ile traceId etiketli gönderilir; 4xx ve beklenen 503 gönderilmez; yakalanmamış istisna/reddedilmiş promise de',
  (eh.match(/captureServerError\(/g) ?? []).length >= 4 && /statusCode !== 503\) captureServerError/.test(eh) && /captureServerError\(error, \{\}\)/.test(eh), '');
const idx = read('backend/src/index.ts');
check('Sunucu kablolaması: tünel yolu kimliksiz + IP limitli ve ana yönlendiriciden ÖNCE; başlangıçta initSentry(), kapanışta flushSentry',
  idx.indexOf("app.post('/api/v1/monitoring/sentry-tunnel', sentryTunnelRateLimiter") > 0 && idx.indexOf("app.post('/api/v1/monitoring/sentry-tunnel'") < idx.indexOf("app.use('/api/v1', routes)") && /\ninitSentry\(\);/.test(idx) && /await flushSentry\(2000\)/.test(idx), '');
const tun = read('backend/src/observability/sentryTunnel.ts');
check('Tünel: DSN anahtar+proje+host doğrulaması (açık röle yok), 256 KB sınır, yalnızca event/transaction/session/client_report iletilir (attachment/replay atılır), olaylar sunucuda scrubSentryEvent ile temizlenir',
  /claimed\.publicKey !== target\.publicKey/.test(tun) && /MAX_ENVELOPE_BYTES = 256 \* 1024/.test(tun) && /new Set\(\['event', 'transaction', 'session', 'sessions', 'client_report'\]\)/.test(tun) && /scrubSentryEvent\(JSON\.parse/.test(tun), '');

// ── Frontend ─────────────────────────────────────────────────────────────────
const main = read('frontend/src/main.tsx');
const api = read('frontend/src/utils/api.ts');
const fs = read('frontend/src/utils/sentry.ts');
check('Frontend: DSN yoksa no-op init, render hata sınırı, tünel same-origin, tracing/replay KAPALI (tracesSampleRate 0, replay entegrasyonu yok), konsol/DOM/XHR breadcrumb kapalı, beforeSend temizler, release = VITE_APP_VERSION; her API çağrısı X-Trace-ID gönderir ve 5xx/ağ hatasını trace_id ile raporlar',
  /initSentry\(\);/.test(main) && /SentryErrorBoundary/.test(main) && /if \(initialized \|\| !dsn\) return false/.test(fs) && /tunnel: SENTRY_TUNNEL_URL/.test(fs) && /tracesSampleRate: 0/.test(fs) && !/replayIntegration/.test(fs) && /console: false, dom: false, xhr: false/.test(fs) &&
    /beforeSend: \(event\) => scrubEvent\(event\)/.test(fs) && /VITE_APP_VERSION/.test(fs) && /\[TRACE_ID_HEADER\]: traceId/.test(api) && /reportApiFailure\(/.test(api), '');

// ── Source map ve derleme ────────────────────────────────────────────────────
const vite = read('frontend/vite.config.ts');
const docker = read('frontend/Dockerfile');
const nginx = read('frontend/nginx.conf');
check('Source map politikası: vite `sourcemap: hidden`; Sentry eklentisi yalnızca TOKEN+ORG+PROJECT varsa, release=VITE_APP_VERSION, yüklemeden sonra .map siler; token Docker\'a ARG/ENV DEĞİL BuildKit secret (compose secret ortam kaynaklı); imaja .map girmez; nginx *.map → 404',
  /sourcemap: 'hidden'/.test(vite) && /sentryUpload = Boolean\(process\.env\.SENTRY_AUTH_TOKEN && process\.env\.SENTRY_ORG && process\.env\.SENTRY_PROJECT\)/.test(vite) && /release: \{ name: process\.env\.VITE_APP_VERSION/.test(vite) && /filesToDeleteAfterUpload/.test(vite) &&
    /--mount=type=secret,id=sentry_auth_token,required=false/.test(docker) && !/^\s*(ARG|ENV)\s+SENTRY_AUTH_TOKEN/m.test(docker) && /find dist -name '\*\.map' -delete/.test(docker) && /secrets:\s*\n\s+- sentry_auth_token/.test(compose) && /sentry_auth_token:\s*\n\s+environment: SENTRY_AUTH_TOKEN/.test(compose) && /location ~\* \\\.map\$ \{\s*return 404;/.test(nginx), '');
check('Sürüm: compose frontend derlemesine APP_VERSION (VITE_APP_VERSION) ve DSN geçer; CI SSH dağıtımı frontend derlemesine APP_VERSION verir (geri almada geri alınan etiket)',
  /VITE_APP_VERSION: \$\{APP_VERSION:-dev\}/.test(compose) && /VITE_SENTRY_DSN: \$\{SENTRY_DSN:-\}/.test(compose) && (read('.github/workflows/ci-cd.yml').match(/APP_VERSION=.* docker compose up -d --build frontend/g) ?? []).length === 3 && /APP_VERSION="\$\{\{ env\.PREV_TAG \}\}" docker compose up -d --build frontend/.test(read('.github/workflows/ci-cd.yml')), '');
const ci = read('.github/workflows/ci-cd.yml');
check('CI: statik test, derleme/source map testi (--build) ve backend davranış testi (test_res907_sentry) pipeline\'da',
  /node scripts\/test-res907\.mjs\n/.test(ci) && /node scripts\/test-res907\.mjs --build/.test(ci) && /test\/test_res907_sentry\.ts/.test(ci), '');
const doc = existsSync(path.join(ROOT, 'docs/ERROR_TRACKING.md')) ? read('docs/ERROR_TRACKING.md') : '';
const terms = ['trace_id', 'X-Trace-ID', 'sentry-tunnel', 'beforeSend', 'BuildKit secret', 'hidden', 'SOURCEMAP_PROBE', 'APP_VERSION', 'SENTRY_ERROR_SAMPLE_RATE', 'SENTRY_TRACES_SAMPLE_RATE', 'replay', 'Kapsam uyarlaması', 'Elle doğrulama', 'connect-src'];
const missing = terms.filter((t) => !doc.includes(t));
check('Doküman: docs/ERROR_TRACKING.md açma, trace korelasyonu, PII temizliği + tünel güvenliği, source map, sürüm, örnekleme/maliyet ve elle doğrulama adımlarını kapsar', missing.length === 0, `eksik=[${missing}]`);
const pk = JSON.parse(read('backend/package.json')); const fk = JSON.parse(read('frontend/package.json'));
check('Bağımlılıklar: @sentry/node (backend), @sentry/react (frontend), @sentry/vite-plugin (frontend devDependency)', !!pk.dependencies['@sentry/node'] && !!fk.dependencies['@sentry/react'] && !!fk.devDependencies['@sentry/vite-plugin'], '');

if (BUILD) {
  const out = mkdtempSync(path.join(tmpdir(), 'res907-build-'));
  const r = spawnSync('npx', ['vite', 'build', '--outDir', out, '--emptyOutDir'], { cwd: path.join(ROOT, 'frontend'), encoding: 'utf8', env: { ...process.env, VITE_SENTRY_DSN: 'https://k@example.invalid/1', VITE_APP_VERSION: 'res907-test', SENTRY_AUTH_TOKEN: '' }, maxBuffer: 64 * 1024 * 1024 });
  const assets = existsSync(path.join(out, 'assets')) ? readdirSync(path.join(out, 'assets')) : [];
  const jsFiles = assets.filter((f) => f.endsWith('.js'));
  check('Derleme: frontend paketi (DSN gömülü) başarıyla derlenir', r.status === 0 && jsFiles.length > 0, r.status === 0 ? `${jsFiles.length} js` : (r.stdout + r.stderr).slice(-400));
  check('Source map (AC): her .js için .map üretilir; pakette (js/css/html) `sourceMappingURL` YOK (hidden — kaynak kod son kullanıcıya açılmaz); token yokken yükleme yapılmaz',
    jsFiles.length > 0 && jsFiles.every((f) => assets.includes(`${f}.map`)) && assets.filter((f) => /\.(js|css)$/.test(f)).every((f) => !/sourceMappingURL/.test(readFileSync(path.join(out, 'assets', f), 'utf8'))) && !/sourceMappingURL/.test(readFileSync(path.join(out, 'index.html'), 'utf8')), `varlıklar=${assets.length}`);
  const main = jsFiles.find((f) => readFileSync(path.join(out, 'assets', f), 'utf8').includes('res907-sourcemap-probe'));
  let resolved = null;
  if (main) {
    const req = createRequire(path.join(ROOT, 'frontend', 'package.json'));
    const { TraceMap, originalPositionFor } = req('@jridgewell/trace-mapping');
    const js = readFileSync(path.join(out, 'assets', main), 'utf8');
    const map = JSON.parse(readFileSync(path.join(out, 'assets', `${main}.map`), 'utf8'));
    const off = js.indexOf('res907-sourcemap-probe');
    const before = js.slice(0, off);
    resolved = originalPositionFor(new TraceMap(map), { line: before.split('\n').length, column: off - (before.lastIndexOf('\n') + 1) });
  }
  const srcLine = read('frontend/src/utils/sentry.ts').split('\n').findIndex((l) => l.startsWith('export const SOURCEMAP_PROBE')) + 1;
  check(`Okunabilir stack (AC): minify paketteki bir konum .map ile ORİJİNAL kaynağa geri çözülür → ${resolved?.source?.split('/').slice(-3).join('/')}:${resolved?.line} (beklenen frontend/src/utils/sentry.ts:${srcLine})`,
    !!main && resolved?.source?.endsWith('frontend/src/utils/sentry.ts') && resolved?.line === srcLine, JSON.stringify(resolved));
  const bundle = main ? readFileSync(path.join(out, 'assets', main), 'utf8') : '';
  check('Paket: tünel yolu gömülü (doğrudan Sentry ingest adresi çağrılmaz — CSP connect-src self ile uyumlu), sürüm etiketi gömülü', bundle.includes('/monitoring/sentry-tunnel') && bundle.includes('res907-test'), '');
  rmSync(out, { recursive: true, force: true });
}

console.log(`\nSONUÇ: ${passed}/${total} test geçti.`);
process.exit(passed === total ? 0 : 1);
