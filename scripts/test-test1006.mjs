#!/usr/bin/env node
// ==============================================================================
// TEST-1006 (#47) — birim test altyapısı sözleşmesi + coverage EŞİK DAVRANIŞININ doğrulanması (ticket Test Notu: "örnek testlerle eşik davranışının
// doğrulanması"). Vitest'i GERÇEKTEN çalıştırır: küçük bir "probe" projesiyle (a) yeterli coverage → çıkış 0, (b) eşik altı → çıkış ≠ 0 (build kırılır),
// (c) hesap-motoru (dosya başına) eşiği genel eşikten BAĞIMSIZ kırar — "tüm koda aynı eşik anlamsızdır" ilkesinin makine kanıtı.
// Sonra sözleşmeyi denetler: eşik değerleri, hesap motorlarının kapsamdan kaçamaması, ortak fabrikalar, paralellik, CI.
// ==============================================================================
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
let passed = 0; let total = 0;
const check = (name, ok, detail = '') => { total++; if (ok) passed++; console.log(`${ok ? '✅ [PASS]' : '❌ [FAIL]'} ${name}${detail ? `\n   ${detail}` : ''}`); };

// ── 1) Eşik davranışı: probe projesi ────────────────────────────────────────────
const PROBE = path.join(ROOT, 'backend', `.threshold-probe-${process.pid}`);
const engineSrc = `export function grade(n: number): string {
  if (n < 0) return 'negatif';
  if (n === 0) return 'sıfır';
  if (n < 10) return 'küçük';
  if (n < 100) return 'orta';
  return 'büyük';
}
`;
const helperSrc = `export function a(x: number): number { if (x > 0) { return 1; } return 2; }
export function b(x: number): number { if (x > 0) { return 3; } return 4; }
`;
function probe(name, { tests, engine, thresholds }) {
  rmSync(PROBE, { recursive: true, force: true });
  mkdirSync(PROBE, { recursive: true });
  writeFileSync(path.join(PROBE, 'engine.ts'), engineSrc);
  writeFileSync(path.join(PROBE, 'helper.ts'), helperSrc);
  writeFileSync(path.join(PROBE, 'probe.test.ts'), `import { it, expect } from 'vitest';\nimport { grade } from './engine';\nimport { a, b } from './helper';\nit('probe', () => {\n${tests}\n});\n`);
  writeFileSync(path.join(PROBE, 'vitest.config.ts'), `import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['probe.test.ts'], coverage: { provider: 'v8', include: ['engine.ts', 'helper.ts'], reporter: ['text'], thresholds: ${thresholds} } } });\n`);
  const r = spawnSync('npx', ['vitest', 'run', '--coverage', '--root', PROBE, '--config', path.join(PROBE, 'vitest.config.ts')], { cwd: path.join(ROOT, 'backend'), encoding: 'utf8', timeout: 120000 });
  return { name, code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
const fullEngine = `expect(grade(-1)).toBe('negatif'); expect(grade(0)).toBe('sıfır'); expect(grade(5)).toBe('küçük'); expect(grade(50)).toBe('orta'); expect(grade(500)).toBe('büyük');`;
const bothHelpers = `expect(a(1)).toBe(1); expect(a(-1)).toBe(2); expect(b(1)).toBe(3); expect(b(-1)).toBe(4);`;
const partialEngine = `expect(grade(-1)).toBe('negatif'); expect(grade(5)).toBe('küçük');`; // 3 dal (sıfır/orta/büyük) test edilmedi
try {
  const ok = probe('yeterli', { tests: `${fullEngine} ${bothHelpers}`, thresholds: `{ lines: 90, statements: 90, functions: 60, branches: 90, 'engine.ts': { lines: 90, statements: 90, functions: 90, branches: 90 } }` });
  check('Eşik davranışı (a): coverage yeterliyse (motor %100, genel ≥ %90) vitest çıkış kodu 0 — build geçer', ok.code === 0, `çıkış=${ok.code}`);

  const low = probe('düşük', { tests: `${partialEngine} expect(a(1)).toBe(1); expect(a(-1)).toBe(2);`, thresholds: `{ lines: 90, statements: 90, functions: 60, branches: 90 }` });
  check('Eşik davranışı (b): coverage eşiğin altındaysa vitest sıfır olmayan çıkış kodu verir ve hangi eşiğin tutmadığını yazar — CI build\'i kırılır', low.code !== 0 && /does not meet .*threshold/i.test(low.out), `çıkış=${low.code} ${low.out.split('\n').filter((l) => /threshold/i.test(l)).slice(0, 2).join(' | ')}`);

  // Genel eşik geçer (helper %100 motoru yukarı çeker) ama HESAP MOTORU dosyası kendi %90 eşiğinde düşer → dosya başı eşik bağımsız kırar.
  const perFile = probe('motor', { tests: `${partialEngine} expect(a(1)).toBe(1); expect(a(-1)).toBe(2);`, thresholds: `{ lines: 50, statements: 50, functions: 50, branches: 50, 'engine.ts': { lines: 90, statements: 90, functions: 90, branches: 90 } }` });
  const general = probe('genel-geçer', { tests: `${partialEngine} expect(a(1)).toBe(1); expect(a(-1)).toBe(2);`, thresholds: `{ lines: 50, statements: 50, functions: 50, branches: 50 }` });
  check('Eşik davranışı (c): aynı coverage, yalnızca genel %50 eşikle GEÇER (çıkış 0) ama hesap-motoru dosyasına %90 eşik konunca KIRILIR — hesap motorlarında yüksek, genelde düşük eşik ilkesi', general.code === 0 && perFile.code !== 0 && /engine\.ts/.test(perFile.out), `genel=${general.code} motor=${perFile.code}`);
} finally {
  rmSync(PROBE, { recursive: true, force: true });
}

// ── 2) Sözleşme ───────────────────────────────────────────────────────────────────
const bcfg = read('backend/vitest.config.ts');
const fcfg = read('frontend/vitest.config.ts');
const engineFiles = [...(/ENGINE_FILES = \[([\s\S]*?)\];/.exec(bcfg)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
const otherFiles = [...(/OTHER_UNIT_FILES = \[([\s\S]*?)\];/.exec(bcfg)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
check('Eşik değerleri ticket önerisiyle uyumlu: backend hesap motorları dosya başına %90 (satır/fonksiyon/dal/ifade), kapsamdaki tüm dosyalar %70; frontend arayüz için DÜŞÜK genel taban (< %50) ve mantık modülleri %70', /lines: 90, functions: 90, branches: 90, statements: 90/.test(bcfg) && /lines: 70, functions: 70, branches: 70, statements: 70/.test(bcfg) && /lines: 20, statements: 20/.test(fcfg) && /lines: 70, statements: 70, functions: 60, branches: 70/.test(fcfg), '');

const listTs = (dir) => (existsSync(path.join(ROOT, dir)) ? readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.ts')).map((f) => `${dir}/${f}`) : []);
const mustBeEngines = [...listTs('backend/src/fuel'), ...listTs('backend/src/fleet')].map((f) => f.replace('backend/', ''));
const dodging = mustBeEngines.filter((f) => !engineFiles.includes(f));
check(`Hesap motorları eşikten KAÇAMAZ: backend/src/fuel ve fleet altındaki HER dosya (${mustBeEngines.length}) ENGINE_FILES'ta; yeni bir motor eklenip test edilmezse coverage kırar`, dodging.length === 0 && engineFiles.length >= 6, `kaçan=[${dodging}] motor=${engineFiles.length}`);
const missingFiles = [...engineFiles, ...otherFiles].filter((f) => !existsSync(path.join(ROOT, 'backend', f)));
check(`Kapsam listesindeki ${engineFiles.length + otherFiles.length} dosyanın hepsi mevcut; DB/ağ/native bağımlılığı olan modül (tenantDb, routes, libxmljs2) kapsamda YOK — birim testler saf kalır`, missingFiles.length === 0 && ![...engineFiles, ...otherFiles].some((f) => /tenantDb|routes|despatchAdviceXml|withTenant/.test(f)), `eksik=[${missingFiles}]`);

const unitTests = (function walk(d) { return readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : e.name.endsWith('.test.ts') ? [`${d}/${e.name}`] : [])); })('backend/unit');
const unitText = unitTests.map((f) => read(f)).join('\n');
const untested = engineFiles.filter((f) => !new RegExp(`src/${f.replace(/^src\//, '').replace(/\.ts$/, '').replace('/', '\\/')}'`).test(unitText));
check(`Her hesap motoru için birim test var (${unitTests.length} test dosyası): motor dosyası bir testten import edilir`, untested.length === 0, `testsiz=[${untested}]`);

const shared = read('test-support/factories.ts');
const backendUses = unitTests.filter((f) => /@test-support\/factories/.test(read(f)));
const frontendUses = readdirSync(path.join(ROOT, 'frontend/src/utils')).filter((f) => f.endsWith('.test.ts')).filter((f) => /@test-support\/factories/.test(read(`frontend/src/utils/${f}`)));
const factoryNames = [...shared.matchAll(/export const (\w+Factory) = defineFactory/g)].map((m) => m[1]);
check(`AC 3 (ortak fabrikalar): test-support/factories.ts ${factoryNames.length} varlık fabrikası (${factoryNames.join(', ')}) sunar; backend (${backendUses.length} test) ve frontend (${frontendUses.length} test) AYNI dosyayı @test-support takma adıyla kullanır; sıfır bağımlılık`, factoryNames.length >= 8 && backendUses.length >= 3 && frontendUses.length >= 1 && /@test-support/.test(bcfg) && /@test-support/.test(fcfg) && !/^import /m.test(shared) && /@test-support\/\*/.test(read('backend/tsconfig.unit.json')) && /@test-support\/\*/.test(read('frontend/tsconfig.json')), '');
const factoryValid = /validVkn|validTckn/.test(shared) && /toCamel/.test(shared) && /resetFactorySequence/.test(shared);
check('Fabrikalar geçerli kimlik (VKN/TCKN sağlama algoritmasıyla), deterministik sayaç, camelCase dönüştürücü içerir (kırılgan elle nesne kurmayı önler)', factoryValid, '');

check('Paralel çalışabilirlik: hiçbir yapılandırmada dosya paralelliği kapatılmamış (fileParallelism:false / singleThread / --no-file-parallelism yok); backend TZ=UTC sabitlenir (makineden bağımsız sonuç)', ![bcfg, fcfg, read('backend/package.json'), read('frontend/package.json')].some((t) => /fileParallelism:\s*false|singleThread|no-file-parallelism|maxWorkers:\s*1\b/.test(t)) && /process\.env\.TZ = 'UTC'/.test(bcfg) && /isolate: true/.test(bcfg), '');

const rootPkg = JSON.parse(read('package.json')); const bpkg = JSON.parse(read('backend/package.json')); const fpkg = JSON.parse(read('frontend/package.json'));
check('AC 1 (`pnpm test` karşılığı): kökte `npm test` iki paketin testlerini, `npm run test:coverage` coverage eşiklerini koşturur (pnpm/workspace yok — KAPSAM UYARLAMASI); backend ve frontend `test`/`test:coverage` betikleri vitest\'tir', /npm --prefix backend test/.test(rootPkg.scripts.test) && /npm --prefix frontend test/.test(rootPkg.scripts.test) && /test:coverage/.test(rootPkg.scripts['test:coverage']) && /^vitest run/.test(bpkg.scripts.test) && /--coverage/.test(bpkg.scripts['test:coverage']) && /^vitest run/.test(fpkg.scripts.test) && /--coverage/.test(fpkg.scripts['test:coverage']) && !!bpkg.devDependencies.vitest && !!bpkg.devDependencies['@vitest/coverage-v8'] && !!fpkg.devDependencies['@vitest/coverage-v8'], '');

const ci = read('.github/workflows/ci-cd.yml');
const stepBlock = /- name: "TEST_PLAN §3 \+ TEST-1006[^\n]*\n(?:(?!\n      - name:)[\s\S])*/.exec(ci)?.[0] ?? '';
check('AC 2 (eşik altında CI kırılır): quality-and-tests işi `npm run test:coverage` koşturur (continue-on-error YOK), tip denetimi ve bu eşik-davranış testi de pipeline\'da; coverage özeti iş özetine yazılır ve lcov artifact yüklenir', /run: npm run test:coverage/.test(stepBlock) && !/continue-on-error/.test(stepBlock) && /run: npm run test:unit:typecheck/.test(ci) && /node scripts\/test-test1006\.mjs/.test(ci) && /GITHUB_STEP_SUMMARY/.test(ci) && /upload-artifact@v4/.test(ci), '');
check('Belge ve README: docs/BIRIM_TEST.md komutları, iki test katmanını (birim/entegrasyon), eşik gerekçesini ve fabrika kullanımını anlatır', existsSync(path.join(ROOT, 'docs/BIRIM_TEST.md')) && /npm run test:coverage/.test(read('docs/BIRIM_TEST.md')) && /buildMany/.test(read('docs/BIRIM_TEST.md')) && /docs\/BIRIM_TEST\.md/.test(read('README.md')), '');

console.log(`\nSONUÇ: ${passed}/${total} test geçti.`);
process.exit(passed === total ? 0 : 1);
