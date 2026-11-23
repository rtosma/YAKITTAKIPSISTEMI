#!/usr/bin/env node
// ==============================================================================
// TEST-1004 (#196) — Playwright E2E paketinin SÖZLEŞME testleri (sıfır npm bağımlılığı; tarayıcı/docker gerektirmez).
// Tarayıcı testlerinin kendisi orkestratörle (scripts/e2e/run-e2e.mjs --browser) koşar. Bu dosya, paketi kırılgan/rastgele hâle getirecek sessiz
// gerilemeleri ucuza ve her CI koşusunda yakalar: metin/CSS seçici, uyku ile bekleme, yeniden deneme, kayıp data-testid, kanıt yapılandırması, CI.
// AC: (1) 3 panelin kritik akışları; (2) hatada ekran görüntüsü + video CI artefaktı; (3) deterministik.
// ==============================================================================
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
let passed = 0; let total = 0;
const check = (name, ok, detail = '') => { total++; if (ok) passed++; console.log(`${ok ? '✅ [PASS]' : '❌ [FAIL]'} ${name}${detail ? `\n   ${detail}` : ''}`); };

const DIR = 'frontend/e2e/critical';
const specFiles = readdirSync(path.join(ROOT, DIR)).filter((f) => f.endsWith('.spec.ts'));
const spec = (f) => read(`${DIR}/${f}`);
const support = read(`${DIR}/support.ts`);
const allSpecText = specFiles.map(spec).join('\n');

// ── Kapsam: üç panel + kimlik ────────────────────────────────────────────────────────
const need = {
  'developer-panel.spec.ts': ['tenant-add-open', 'tenant-save', 'module-toggle-', 'license-status-', 'device-card', 'publishMqtt'],
  'manager-panel.spec.ts': ['site-save', 'driver-save', 'vehicle-save', 'crosssite-save', 'crosssite-row'],
  'site-panel.spec.ts': ['site-tank', 'site-tx-row', 'site-report-download', 'injectDispense', 'waitForLiveConnection', 'waitForEvent(\'download\')'],
  'identity.spec.ts': ['pwchange-current', 'pwchange-submit', 'forbidden-page', 'login-error', 'parola-degistir']
};
const missing = Object.entries(need).flatMap(([f, keys]) => (specFiles.includes(f) ? keys.filter((k) => !spec(f).includes(k)).map((k) => `${f}:${k}`) : [`${f}:DOSYA YOK`]));
check('AC 1: üç panelin kritik akışları + kimlik akışları var — geliştirici (firma oluştur → modül aç/kapa → cihaz sağlığı), yönetici (şantiye → sürücü/araç → çapraz alım yetkisi), şantiye (canlı ikmal → hareket listesi → rapor indirme), kimlik (geçici parola, zorunlu değişiklik, yetkisiz erişim)', missing.length === 0 && specFiles.length >= 4, `eksik=[${missing}]`);
check('Her spec KENDİ taze firmasını kurar (createTenant, rastgele son ek) ve tohum firmalarına/kullanıcılarına (comp-camsa, kusak, pompa-op-01…) dokunmaz — testler izole', specFiles.filter((f) => f !== 'developer-panel.spec.ts').every((f) => /createTenant\(/.test(spec(f))) && /createTenant\(/.test(spec('developer-panel.spec.ts')) && !/comp-camsa|comp-kusak|'kusak'|'camsa'|pompa-op-01/.test(allSpecText + support), '');

// ── Seçiciler: yalnızca data-testid ───────────────────────────────────────────────────
const forbiddenSelectors = [...allSpecText.matchAll(/\.(getByText|getByRole|getByLabel|getByPlaceholder|getByTitle|getByAltText)\(/g)].map((m) => m[1]);
const badLocators = [...allSpecText.matchAll(/\.locator\(\s*(['"`])([^'"`]|`)*?/g)].map((m) => m[0]).filter(() => false);
const locatorArgs = [...allSpecText.matchAll(/\.locator\(\s*([`'"])([\s\S]*?)\1/g)].map((m) => m[2]);
const nonTestidLocators = locatorArgs.filter((a) => !/^\[data-testid=/.test(a) && a !== 'html');
const pageFill = [...allSpecText.matchAll(/page\.(fill|click|check|selectOption)\(/g)];
check('Seçici kuralı (ticket): yalnızca data-testid — getByText/getByRole/getByLabel/getByPlaceholder YOK; `locator()` yalnızca `[data-testid=…]` niteliğiyle ya da `html`; doğrudan page.fill/click(CSS) YOK', forbiddenSelectors.length === 0 && nonTestidLocators.length === 0 && pageFill.length === 0 && badLocators.length === 0, `yasaklı=[${forbiddenSelectors}] locator=[${nonTestidLocators}] doğrudan=${pageFill.length}`);

// ── Determinizm ─────────────────────────────────────────────────────────────────────
const cfg = read('frontend/playwright.critical.config.ts');
const codeOnly = (t) => t.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const sleeps = [...codeOnly(allSpecText + support).matchAll(/waitForTimeout|setTimeout\(|\bsleep\(|Math\.random|networkidle/g)].map((m) => m[0]);
const skips = [...allSpecText.matchAll(/test\.(only|skip|fixme|fail)\b|\.only\(/g)].map((m) => m[0]);
check('AC 3 (deterministik): uyku/rastgele bekleme YOK (waitForTimeout, setTimeout, sleep, networkidle, Math.random); test.only/skip/fixme YOK; beklemeler koşula bağlı (waitForResponse, expect.poll, öznitelik)', sleeps.length === 0 && skips.length === 0 && /waitForResponse/.test(allSpecText) && /expect\.poll/.test(allSpecText) && /toHaveAttribute/.test(allSpecText), `uyku=[${sleeps}] atlanan=[${skips}]`);
check('Yeniden deneme KAPALI (retries: 0 — rastgele başarısızlığı maskelemez), tek worker (paylaşılan login rate limit), forbidOnly CI\'da; nightly her testi 3× tekrar ederek flake avlar', /retries: 0/.test(cfg) && /workers: 1/.test(cfg) && /forbidOnly: !!process\.env\.CI/.test(cfg) && /repeat-each=3/.test(read('.github/workflows/e2e-nightly.yml')), '');
check('Canlı akış deterministik: sentetik olay ENJEKSİYONU (cihaz olarak HMAC imzalı ikmal döngüsü + MQTT presence) tarayıcı WebSocket\'i bağlandıktan SONRA tetiklenir; uygulama bağlantıyı html[data-socket] ile işaretler', /waitForLiveConnection/.test(spec('site-panel.spec.ts')) && /data-socket/.test(support) && /dataset\.socket = 'connected'/.test(read('frontend/src/context/AppContext.tsx')) && /X-Hardware-Signature/.test(support) && /createHmac\('sha256'/.test(support), '');

// ── data-testid'ler arayüzde GERÇEKTEN var ─────────────────────────────────────────────
function walk(dir) { return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.tsx?$/.test(e.name) ? [`${dir}/${e.name}`] : [])); }
const uiText = walk('frontend/src').filter((f) => !/\.test\./.test(f)).map(read).join('\n');
const used = new Set([...allSpecText.matchAll(/getByTestId\('([^']+)'\)/g)].map((m) => m[1]).concat([...allSpecText.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1])));
const templated = [...allSpecText.matchAll(/getByTestId\(`([^`$]+)\$\{/g)].map((m) => m[1]);
for (const p of templated) used.add(`${p}*`);
const templatePrefixes = [...uiText.matchAll(/data-testid=\{`([^`$]*)\$\{/g)].map((m) => m[1]);
const missingIds = [...used].filter((id) => (id.endsWith('*') ? !templatePrefixes.includes(id.slice(0, -1)) : !new RegExp(`data-testid="${id}"`).test(uiText) && !templatePrefixes.some((p) => id.startsWith(p))));
check(`Spec'lerde kullanılan ${used.size} data-testid'nin HEPSİ arayüz kodunda mevcut (arayüzde ad değişirse tarayıcı açılmadan sözleşme kırılır)`, missingIds.length === 0 && used.size >= 40, `eksik=[${missingIds}]`);
const testidsInUi = (uiText.match(/data-testid=/g) ?? []).length;
check(`Arayüz test kancaları: ${testidsInUi} data-testid; şantiye paneli tank seviyesi ANİMASYONSUZ ham değerle (data-level-liters) ve hareket satırı (data-tx-id, data-liters) sunulur — animasyonlu sayaçtan okuma yok`, testidsInUi >= 50 && /data-level-liters=\{tank\.currentLevelLiters\}/.test(uiText) && /data-tx-id=\{tx\.id\}/.test(uiText) && /data-testid="site-report-download"/.test(uiText), '');

// ── Kanıt (AC 2) + CI ────────────────────────────────────────────────────────────────
check('AC 2 (hata kanıtı): yapılandırma başarısız testte ekran görüntüsü (only-on-failure), VİDEO (retain-on-failure) ve trace kaydeder; HTML + JUnit raporu üretir', /screenshot: 'only-on-failure'/.test(cfg) && /video: 'retain-on-failure'/.test(cfg) && /trace: 'retain-on-failure'/.test(cfg) && /'html'/.test(cfg) && /junit/.test(cfg) && /outputDir: '\.\/test-results'/.test(cfg), '');
const ci = read('.github/workflows/ci-cd.yml');
const job = /\n  e2e-browser:\n([\s\S]*?)(?=\n  [a-z][\w-]*:\n)/.exec(ci)?.[1] ?? '';
const uploadStep = /Upload failure evidence[\s\S]*?(?=\n      - name:|$)/.exec(job)?.[0] ?? '';
check('CI: `e2e-browser` işi Chromium kurar, orkestratörü `--browser` ile koşturur, süre bütçeli (≤ 20 dk zaman aşımı) ve ekran görüntüsü/video/trace/rapor klasörlerini `if: always()` ile artifact yükler; dağıtım işlerinin `needs` listesindedir (E2E kırmızıyken dağıtım yok)', job.length > 0 && /playwright install --with-deps chromium/.test(job) && /run-e2e\.mjs --browser/.test(job) && Number(/timeout-minutes: (\d+)/.exec(job)?.[1]) <= 20 && /if: always\(\)/.test(uploadStep) && /upload-artifact@v4/.test(uploadStep) && /frontend\/test-results\//.test(uploadStep) && (ci.match(/needs: \[[^\]]*e2e-browser[^\]]*\]/g) ?? []).length >= 2, `iş=${job.length > 0}`);
const nightly = read('.github/workflows/e2e-nightly.yml');
check('Nightly: ayrı workflow (schedule + workflow_dispatch) tarayıcı paketini 3× tekrarla koşturur ve kanıtı yükler — testler her PR\'da değil merge öncesi + gece koşar (süre yönetimi)', /schedule:/.test(nightly) && /cron:/.test(nightly) && /workflow_dispatch/.test(nightly) && /--browser/.test(nightly) && /upload-artifact@v4/.test(nightly), '');
const orch = read('scripts/e2e/run-e2e.mjs');
check('Orkestratör tarayıcı kipi: frontend üretim derlemesi nginx\'te backend\'e upstream olarak bağlanır, yalnızca 127.0.0.1 rastgele portu yayınlanır, Playwright ortamına E2E_BASE_URL/E2E_REDIS_CONTAINER/E2E_BACKEND_CONTAINER verilir; eski yerel yapılandırma critical/ dizinini yok sayar', /--browser/.test(orch) && /127\.0\.0\.1::80/.test(orch) && /E2E_BASE_URL: base/.test(orch) && /E2E_REDIS_CONTAINER/.test(orch) && /E2E_BACKEND_CONTAINER/.test(orch) && /testIgnore: '\*\*\/critical\/\*\*'/.test(read('frontend/playwright.config.ts')), '');
check('Belge: docs/E2E_TEST.md tarayıcı paketini (komut, seçici kuralı, determinizm, kanıt, nightly) anlatır', existsSync(path.join(ROOT, 'docs/E2E_TEST.md')) && /## Tarayıcı E2E \(TEST-1004\)/.test(read('docs/E2E_TEST.md')) && /--browser/.test(read('docs/E2E_TEST.md')), '');

console.log(`\nSONUÇ: ${passed}/${total} test geçti.`);
process.exit(passed === total ? 0 : 1);
