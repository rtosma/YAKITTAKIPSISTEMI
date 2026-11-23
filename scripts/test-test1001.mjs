#!/usr/bin/env node
// ==============================================================================
// TEST-1001 (#193) — E2E test altyapısının SÖZLEŞME testleri (sıfır npm bağımlılığı; docker gerektirmez).
// E2E testlerinin kendisi gerçek bağımlılıklarla koşar (scripts/e2e/run-e2e.mjs → CI işi "e2e-fuel-cycle"). Bu dosya, altyapının AC'lerini
// bozacak sessiz gerilemeleri (bütçe, izolasyon kuralı, paralellik, CI geçidi, temizlik) ucuza ve her CI koşusunda yakalar.
// AC: (1) ikmal zinciri %100 yeşil; (2) CI'da < 10 dk; (3) testler birbirinden izole.
// ==============================================================================
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
let passed = 0; let total = 0;
const check = (name, ok, detail = '') => { total++; if (ok) passed++; console.log(`${ok ? '✅ [PASS]' : '❌ [FAIL]'} ${name}${detail ? `\n   ${detail}` : ''}`); };

const E2E_DIR = 'backend/test/e2e';
const files = readdirSync(path.join(ROOT, E2E_DIR)).filter((f) => /^e2e_.*\.ts$/.test(f));
const lib = read(`${E2E_DIR}/lib.ts`);
const orch = read('scripts/e2e/run-e2e.mjs');
const ci = read('.github/workflows/ci-cd.yml');
const job = /\n  e2e-fuel-cycle:\n([\s\S]*?)(?=\n  [a-z][\w-]*:\n)/.exec(ci)?.[1] ?? '';

// ── Kapsam: ikmal zinciri ─────────────────────────────────────────────────────────
const cycle = read(`${E2E_DIR}/e2e_fuel_cycle.ts`);
const chain = ['request-auth', 'heartbeat', 'finalize', 'dispense:completed', 'dispense:session', 'theft:alert', 'e-irsaliye/transmit', 'despatch-advice-transmissions/sweep', 'rep-711', 'openMqtt', 'WsObserver', 'idempotencyKey', 'current_level_liters'];
const missingChain = chain.filter((k) => !cycle.includes(k));
check('AC 1 (zincir kapsamı): ikmal döngüsü testi ticket zincirinin TÜM halkalarını içerir — yetki (request-auth) → akış (heartbeat + MQTT telemetri) → sonlandırma (finalize) → stok düşümü → olay tüketicileri (WebSocket, hırsızlık motoru) → e-İrsaliye kuyruğu (transmit + sweep) → rapor; idempotency', missingChain.length === 0, `eksik=[${missingChain}]`);
check('Sentetik cihaz istemcisi gerçek protokolü konuşur: HMAC imzalı HTTP (X-Hardware-Signature, timestamp.nonce.gövde) + MQTT v5 (mqtt.js) telemetri konuları (telemetry/v1/…/data|status) + socket.io istemcisi', /X-Hardware-Signature/.test(lib) && /createHmac\('sha256'/.test(lib) && /protocolVersion: 5/.test(lib) && /telemetry\/v1\//.test(lib) && /socket\.io/.test(lib), '');
const checks = (f) => (read(`${E2E_DIR}/${f}`).match(/r\.check\(/g) ?? []).length;
const counts = Object.fromEntries(files.map((f) => [f, checks(f)]));
check(`E2E dosyaları (${files.length}) her biri Reporter ile bitirir ve asgari doğrulama sayısını dayatır (finish(minChecks)); sessizce 0 test koşup yeşil kalamaz`, files.length >= 2 && files.every((f) => { const m = /r\.finish\((\d+)\)/.exec(read(`${E2E_DIR}/${f}`)); return m && Number(m[1]) >= 7 && Number(m[1]) <= counts[f]; }), JSON.stringify(counts));

// ── İzolasyon ────────────────────────────────────────────────────────────────────
const SEED = /comp-camsa|comp-kusak|comp-avrasya|['"]camsa['"]|kusak|avrasya|gebze-santiye|pompa-op-01|tank-gebze|veh-1\b|drv-1\b|CARD-8812|ESP32-PUMP-01|ESP32-TANK-01|Gebze Ana/;
const seedRefs = files.filter((f) => SEED.test(read(`${E2E_DIR}/${f}`)));
const libSeed = [...lib.matchAll(new RegExp(SEED.source, 'g'))].map((m) => m[0]);
check('AC 3 (izolasyon): E2E dosyaları ve lib.ts tohum firmalarına/cihazlarına/kullanıcılarına HİÇ referans vermez (yalnız şifre-hash kopyası için `camsa` kullanıcısı okunur); her dosya kendi taze tenant\'ını `createTenant` ile yaratır', seedRefs.length === 0 && libSeed.every((x) => /camsa/.test(x)) && files.every((f) => /createTenant\(/.test(read(`${E2E_DIR}/${f}`))) && /WHERE username = 'camsa'/.test(lib), `tohum referanslı=[${seedRefs}] lib=[${libSeed}]`);
check('Kimlikler koşuya özgü rastgele son ek taşır (tenant/kullanıcı/cihaz/plaka dışı her kimlik `tag` içerir) → paralel dosyalar ve tekrarlı koşular çakışmaz', /const tag = `\$\{label\}\$\{rnd\(6\)\}`/.test(lib) && /crypto\.randomBytes/.test(lib) && ['tenantId', 'ownerUser', 'siteA', 'siteB', 'tankName', 'tankId', 'driverName', 'card', 'pumpId', 'tankAId', 'tankBId'].every((k) => new RegExp(`const ${k} = [^;]*\\$\\{tag\\}|const ${k} = \`[^\`]*\\$\\{tag\\}`).test(lib)), '');
check('Temizlik yalnız KENDİ tenant\'ını siler (DELETE FROM companies WHERE id = kendi tenantId; cascade) ve hata yutulmaz-senaryoyu bozmaz', /DELETE FROM companies WHERE id = \$1`, \[t\.tenantId\]/.test(lib) && files.every((f) => /cleanupTenant\(/.test(read(`${E2E_DIR}/${f}`))), '');
const iso = read(`${E2E_DIR}/e2e_tenant_isolation.ts`);
check('İzolasyon testi iki tenant\'ı EŞZAMANLI koşturur (Promise.all) ve karşılıklı sızıntıyı dört yerde arar: veritabanı stoğu, API listeleri (RLS), WebSocket olayları, cihaz sırrı/kart sınırı; yabancı tenant olayı sayısı 0 dayatılır', /Promise\.all\(\[\s*dispenseCycle/.test(iso) && /foreign\(wsA/.test(iso) && /foreign\(wsB/.test(iso) && /=== 0/.test(iso) && /cross\.status === 401/.test(iso) && /names\(tanksA\)/.test(iso), '');

// ── Orkestratör / süre / paralellik ───────────────────────────────────────────────
const budget = Number(/DEFAULT_BUDGET_SEC = (\d+)/.exec(orch)?.[1]);
const ciBudget = Number(/--budget-sec (\d+)/.exec(job)?.[1]);
const ciTimeout = Number(/timeout-minutes: (\d+)/.exec(job)?.[1]);
check(`AC 2 (< 10 dk): orkestratör varsayılan bütçesi ${budget} sn (≤ 600); CI işi ${ciBudget} sn bütçe ve ${ciTimeout} dk zaman aşımıyla koşar (ikisi de 10 dakikanın altında); bütçe aşımı başarısızlıktır ve aşama/dosya süreleri raporlanır`, budget <= 600 && ciBudget < 600 && ciBudget > 0 && ciTimeout <= 10 && /total > BUDGET_SEC/.test(orch) && /process\.exit\(1\)/.test(orch) && /E2E ÖZET/.test(orch), `orkestratör=${budget} ci=${ciBudget} timeout=${ciTimeout}`);
check('Paralellik: E2E dosyaları Promise.all ile EŞZAMANLI koşar; imaj derlemeleri ve bağımlılık başlatmaları da paralel; hiçbir konteyner SABİT host portu yayınlamaz (yalnızca tarayıcı kipinde frontend, 127.0.0.1 üzerinde RASTGELE portla → paralel koşular/CI çakışmaz)', /Promise\.all\(files\.map/.test(orch) && /const \[a, b(, c)?\] = await Promise\.all\(\[/.test(orch) && !/'-p', '(?!127\.0\.0\.1::)/.test(orch) && !/publish/.test(orch), '');
const compose = read('docker-compose.yml');
const pg = /image: (postgres:[\w.-]+)/.exec(compose)?.[1]; const rd = /image: (redis:[\w.-]+)/.exec(compose)?.[1];
check(`Gerçek bağımlılıklar üretimle AYNI sürümde: PostgreSQL (${pg}), Redis (${rd}), EMQX (docker/emqx imajı, üretimle aynı parola-tabanlı kimlik doğrulama, anonim erişim yok); TimescaleDB KULLANILMAZ (şemada hypertable yok) — kapsam uyarlaması belgeli`, !!pg && !!rd && orch.includes(`'${pg}'`) && orch.includes(`'${rd}'`) && /docker', \['build', '-q', '-t', IMG_EMQX, 'docker\/emqx'\]/.test(orch) && /EMQX_AUTHENTICATION__1__BACKEND=built_in_database/.test(orch) && !/ALLOW_ANONYMOUS/.test(orch) && !/hypertable|create_hypertable/i.test(read('backend/src/db/schema.sql')) && /KAPSAM UYARLAMASI/.test(orch), `pg=${pg} redis=${rd}`);
check('Kurulum doğru: şema İKİ kez uygulanır (yeni tabloların GRANT sırası), ardından tohum; backend sağlık + MQTT abonelik hazır olmadan test koşmaz; ağ/konteynerler rastgele son ekli', /\['şema #1', schema\], \['şema #2', schema\], \['tohum', seed\]/.test(orch) && /ON_ERROR_STOP=1/.test(orch) && /Telemetri veri akışı \\\(data\\\) dinleniyor/.test(orch) && /RUN = crypto\.randomBytes/.test(orch) && /e2e-net-\$\{RUN\}/.test(orch), '');
check('Temizlik garantili: hata, başarısızlık ve SIGINT/SIGTERM\'de konteynerler + ağ silinir (docker rm -f -v, network rm); yalnızca --keep bırakır; başarısızlıkta backend günlüğü basılır', /for \(const sig of \['SIGINT', 'SIGTERM'\]\)/.test(orch) && /'rm', '-f', '-v'/.test(orch) && /'network', 'rm'/.test(orch) && /\.catch|main\(\)\.catch\(async \(e\) => \{[\s\S]*await cleanup\(\)/.test(orch) && /backend günlüğü/.test(orch) && /KEEP/.test(orch), '');

// ── CI entegrasyonu ───────────────────────────────────────────────────────────────
check('CI: `e2e-fuel-cycle` AYRI ve PARALEL iş (uzun sıralı işe `needs` ile bağlı DEĞİL → toplam süreye eklenmez), orkestratörü koşturur ve staging/production dağıtımlarının `needs` listesindedir (E2E kırmızıyken dağıtım yok)', job.length > 0 && !/needs:/.test(job) && /node scripts\/e2e\/run-e2e\.mjs/.test(job) && (ci.match(/needs: \[[^\]]*e2e-fuel-cycle[^\]]*\]/g) ?? []).length >= 2, `iş bulundu=${job.length > 0}`);
check('CI: bu sözleşme testi pipeline\'da; README/docs E2E\'yi anlatır; belge orkestratör komutunu ve bütçeyi içerir', /node scripts\/test-test1001\.mjs/.test(ci) && existsSync(path.join(ROOT, 'docs/E2E_TEST.md')) && /run-e2e\.mjs/.test(read('docs/E2E_TEST.md')) && /docs\/E2E_TEST\.md/.test(read('README.md')), '');

console.log(`\nSONUÇ: ${passed}/${total} test geçti.`);
process.exit(passed === total ? 0 : 1);
