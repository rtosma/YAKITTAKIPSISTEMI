#!/usr/bin/env node
// ==============================================================================
// OPS-1104 — dağıtım altyapısı testleri (sıfır bağımlılık; CI'da quality job'unda çalışır).
//
//  1. migration güvenliği (expand/contract kuralları, onay işareti, tarihsel ifadeler)
//  2. sürüm/changelog (semver önerisi, gruplama, geçici git deposunda)
//  3. duman testi (sahte HTTP sunucusuna karşı: hem geçen hem HER TÜRLÜ bozuk dağıtım)
//  4. workflow yapısı (staging otomatik, üretim etiket+onay, onay kaydı, geri alma, secret kuralları)
//  5. ortam şablonları (anahtar eşitliği, ortam farkları, doldurulmamış sırla üretimde açılmama)
// ==============================================================================

import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { analyzeMigration } from './lib/migrationSafety.mjs';
import { parseCommit, bumpVersion, renderChangelog } from './generate-changelog.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let total = 0;
function check(name, ok, detail = '') {
  total++;
  if (ok) passed++;
  console.log(`${ok ? '✅ [PASS]' : '❌ [FAIL]'} ${name}${detail ? `\n   ${detail}` : ''}`);
}
const tmp = mkdtempSync(path.join(tmpdir(), 'ops1104-'));

// ── 1. Migration güvenliği ────────────────────────────────────────────────────
const BASE = `CREATE TABLE IF NOT EXISTS a (id INT PRIMARY KEY, name TEXT);\nDROP TABLE IF EXISTS refresh_tokens;\n`;
const analyze = (added, base = BASE) => analyzeMigration(base, `${base}\n${added}`);
const rules = (r) => r.violations.flatMap((v) => v.issues.map((i) => i.rule)).sort().join(',');

const safeCases = [
  'ALTER TABLE a ADD COLUMN IF NOT EXISTS b INT;',
  'ALTER TABLE a ADD COLUMN c TEXT NOT NULL DEFAULT \'x\';',
  'CREATE TABLE IF NOT EXISTS t (id INT PRIMARY KEY);',
  'CREATE INDEX IF NOT EXISTS idx_a_name ON a(name);',
  'DROP POLICY IF EXISTS p ON a; CREATE POLICY p ON a USING (true);',
  'REVOKE UPDATE, DELETE ON a FROM app_user;',
  'ALTER TABLE a DROP CONSTRAINT IF EXISTS old_uq;',
  "DO $$ BEGIN IF NOT EXISTS (SELECT 1) THEN ALTER TABLE a ADD CONSTRAINT c CHECK (id > 0); END IF; END $$;"
];
check('Migration: eklemeli (expand) ifadelerin hiçbiri ihlal sayılmaz', safeCases.every((s) => analyze(s).violations.length === 0),
  safeCases.filter((s) => analyze(s).violations.length).join(' | '));

const badCases = {
  DROP_TABLE: 'DROP TABLE a;',
  DROP_COLUMN: 'ALTER TABLE a DROP COLUMN name;',
  RENAME: 'ALTER TABLE a RENAME COLUMN name TO title;',
  ALTER_TYPE: 'ALTER TABLE a ALTER COLUMN name TYPE VARCHAR(10);',
  SET_NOT_NULL: 'ALTER TABLE a ALTER COLUMN name SET NOT NULL;',
  ADD_NOT_NULL_NO_DEFAULT: 'ALTER TABLE a ADD COLUMN IF NOT EXISTS z INT NOT NULL;',
  TRUNCATE: 'TRUNCATE a;'
};
const badResults = Object.entries(badCases).map(([rule, sql]) => [rule, rules(analyze(sql))]);
check('Migration: her geriye uyumsuz kalıp yakalanır (DROP TABLE/COLUMN, RENAME, TYPE, SET NOT NULL, DEFAULT\'suz NOT NULL, TRUNCATE)',
  badResults.every(([rule, got]) => got.includes(rule)), badResults.map(([r, g]) => `${r}→${g}`).join(' '));

const mixed = analyze('ALTER TABLE a ADD COLUMN ok INT, ADD COLUMN bad INT NOT NULL;');
check('Migration: tek ALTER içindeki kötü kolon (ok + DEFAULT\'suz NOT NULL) yakalanır', rules(mixed) === 'ADD_NOT_NULL_NO_DEFAULT', rules(mixed));

const withReason = analyze('-- MIGRATION-CONTRACT: artık kullanılmayan tablo, REP-999 ile kod kaldırıldı\nDROP TABLE a;');
const shortReason = analyze('-- MIGRATION-CONTRACT: kısa\nDROP TABLE a;');
const farAway = analyze('-- MIGRATION-CONTRACT: uzun ve yeterli gerekçe metni burada\nALTER TABLE a ADD COLUMN k INT;\nDROP TABLE a;');
const noReason = analyze('-- MIGRATION-CONTRACT:\nDROP TABLE a;');
check('Migration: onay işareti — yeterli gerekçe → onaylı (kırmaz); kısa/boş gerekçe → ihlal; işaret başka ifadenin üstündeyse geçerli DEĞİL',
  withReason.violations.length === 0 && withReason.approved.length === 1 && withReason.approved[0].reason.includes('REP-999') &&
    shortReason.violations.length === 1 && noReason.violations.length === 1 && farAway.violations.length === 1,
  `onaylı=${withReason.approved.length}, kısa=${shortReason.violations.length}, boş=${noReason.violations.length}, uzakta=${farAway.violations.length}`);

const same = analyzeMigration(BASE, `-- yeni yorum\n  DROP   TABLE IF EXISTS\n refresh_tokens ;\nCREATE TABLE IF NOT EXISTS a (id INT PRIMARY KEY, name TEXT);`);
check('Migration: tabanda zaten var olan yıkıcı ifade (yeniden biçimlenmiş/taşınmış olsa da) tekrar ihlal sayılmaz', same.violations.length === 0 && same.added === 0, `added=${same.added}`);

writeFileSync(path.join(tmp, 'old.sql'), BASE);
writeFileSync(path.join(tmp, 'bad.sql'), `${BASE}\nDROP TABLE a;`);
writeFileSync(path.join(tmp, 'good.sql'), `${BASE}\nALTER TABLE a ADD COLUMN IF NOT EXISTS q INT;`);
const cli = (n) => spawnSync('node', [path.join(ROOT, 'scripts/check-migration-safety.mjs'), '--old', path.join(tmp, 'old.sql'), '--new', path.join(tmp, n)], { encoding: 'utf8' });
const cliBad = cli('bad.sql');
const cliGood = cli('good.sql');
check('Migration: CLI — ihlalde exit 1 (kural + onay yönergesi yazar), temiz değişiklikte exit 0',
  cliBad.status === 1 && cliBad.stderr.includes('DROP_TABLE') && cliBad.stderr.includes('MIGRATION-CONTRACT') && cliGood.status === 0,
  `bad=${cliBad.status}, good=${cliGood.status}`);

// ── 2. Sürüm / changelog ──────────────────────────────────────────────────────
const c = (s, b = '') => ({ ...parseCommit(s, b) });
check('Changelog: semver önerisi — breaking(!) → major, BREAKING CHANGE gövdesi → major, feat → minor, yalnız fix → patch, etiket yoksa v0.1.0 tabanı',
  bumpVersion('v1.2.3', [c('feat(a): x'), c('feat!: y')]) === 'v2.0.0' && bumpVersion('v1.2.3', [c('fix: x', 'BREAKING CHANGE: api')]) === 'v2.0.0' &&
    bumpVersion('v1.2.3', [c('fix(a): x'), c('feat(b): y')]) === 'v1.3.0' && bumpVersion('v1.2.3', [c('fix: x'), c('chore: y')]) === 'v1.2.4' &&
    bumpVersion('v0.0.0', [c('feat: ilk')]) === 'v0.1.0',
  '');

const repo = path.join(tmp, 'repo');
mkdirSync(repo);
const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
g('init', '-q');
let n = 0;
const commit = (msg) => { writeFileSync(path.join(repo, 'f.txt'), String(++n)); g('add', '.'); g('commit', '-q', '-m', msg); };
commit('chore: ilk');
g('tag', 'v1.2.3');
commit('fix(auth): oturum süresi hatası düzeltildi');
commit('feat(REP-724): yeni rapor eklendi');
commit('docs: ortam belgesi');
const cl = (...a) => spawnSync('node', [path.join(ROOT, 'scripts/generate-changelog.mjs'), '--repo', repo, ...a], { encoding: 'utf8' });
const next1 = cl('--next-version').stdout.trim();
const md = cl().stdout;
commit('feat(api)!: yanıt biçimi değişti');
const next2 = cl('--next-version').stdout.trim();
const outFile = path.join(tmp, 'CHANGELOG.md');
writeFileSync(outFile, '# Değişiklik Günlüğü\n\n## v1.0.0 — eski\n');
cl('--out', outFile, '--prepend', '--version', 'v2.0.0');
const file = readFileSync(outFile, 'utf8');
check('Changelog: son etiketten (v1.2.3) bu yana feat → v1.3.0; günlük bölümlere ayrılır (Yeni özellikler/Düzeltmeler/Dokümantasyon), kapsam ve kısa hash içerir; etiket öncesi commit YOK',
  next1 === 'v1.3.0' && md.includes('## v1.3.0') && md.includes('### Yeni özellikler') && md.includes('**REP-724:**') && md.includes('### Düzeltmeler') && md.includes('### Dokümantasyon') && !md.includes('ilk') && /\(`[0-9a-f]{7}`\)/.test(md),
  `next=${next1}`);
check('Changelog: breaking commit → v2.0.0 önerisi + "Geriye uyumsuz" bölümü; --prepend eski girdileri korur ve yeni sürümü üste ekler',
  next2 === 'v2.0.0' && file.indexOf('## v2.0.0') < file.indexOf('## v1.0.0') && file.includes('Geriye uyumsuz') && file.startsWith('# Değişiklik Günlüğü'),
  `next=${next2}`);
check('Changelog: etiketsiz depoda taban v0.0.0 (tüm geçmiş taranır)', (() => {
  const r2 = path.join(tmp, 'repo2'); mkdirSync(r2);
  const gg = (...a) => execFileSync('git', a, { cwd: r2, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  gg('init', '-q'); writeFileSync(path.join(r2, 'a'), '1'); gg('add', '.'); gg('commit', '-q', '-m', 'feat: ilk');
  return spawnSync('node', [path.join(ROOT, 'scripts/generate-changelog.mjs'), '--repo', r2, '--next-version'], { encoding: 'utf8' }).stdout.trim() === 'v0.1.0';
})(), '');

// ── 3. Duman testi (sahte sunucu) ─────────────────────────────────────────────
// Sahte sunucu AYRI bir süreçte çalışır (duman testi de ayrı süreç; ikisi de olay döngüsünü paylaşmaz).
async function smokeAsync(behavior, env = {}) {
  const helper = path.join(tmp, `mock-${randomBytes(3).toString('hex')}.mjs`);
  writeFileSync(helper, `
    import { createServer } from 'node:http';
    const behavior = ${JSON.stringify(behavior)};
    const startedAt = Date.now();
    const server = createServer((req, res) => {
      const url = req.url || '';
      const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (url.endsWith('/health/ready')) return behavior.readyAfterMs !== undefined && Date.now() - startedAt < behavior.readyAfterMs ? json(503, { status: 'DOWN' }) : json(behavior.readyNever ? 503 : 200, { status: 'READY' });
      if (url.endsWith('/health')) return json(behavior.healthCode ?? 200, { status: behavior.healthStatus ?? 'UP' });
      if (url.includes('/auth/login')) return behavior.loginFails ? json(401, {}) : json(200, { accessToken: 'tok' });
      if (url.includes('/reports') || url.includes('/dashboard/executive')) {
        const authed = (req.headers.authorization || '') === 'Bearer tok';
        if (!authed) return json(behavior.openAuth ? 200 : 401, behavior.openAuth ? { data: [{}] } : {});
        return url.includes('/dashboard') ? json(200, { data: { kpis: { openAlarms: {} } } }) : json(200, { data: [{ id: 'rep-711' }] });
      }
      res.writeHead(200, { 'Content-Type': behavior.frontendNotHtml ? 'application/json' : 'text/html', 'X-Content-Type-Options': behavior.noSniff ? 'x' : 'nosniff' });
      res.end('<html></html>');
    });
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
  `);
  const { spawn } = await import('node:child_process');
  const srv = spawn('node', [helper], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve) => srv.stdout.once('data', (d) => resolve(String(d).trim())));
  try {
    const base = `http://127.0.0.1:${port}/api/v1`;
    const r = await new Promise((resolve) => {
      const p = spawn('node', [path.join(ROOT, 'scripts/smoke-test.mjs')], { env: { ...process.env, SMOKE_BASE_URL: base, SMOKE_READY_TIMEOUT_SECONDS: '4', ...env } });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      p.on('close', (code) => resolve({ status: code, out }));
    });
    return r;
  } finally {
    srv.kill();
  }
}
const FULL_ENV = { SMOKE_CHECK_FRONTEND: '1', SMOKE_CHECK_HEADERS: '1', SMOKE_USERNAME: 'u', SMOKE_PASSWORD: 'p' };
const good = await smokeAsync({}, FULL_ENV);
check('Duman testi: sağlıklı dağıtımda 9/9 kontrol geçer (health, ready, 401 kapıları, frontend, başlık, giriş, katalog, dashboard) → exit 0',
  good.status === 0 && good.out.includes('9/9 kontrol geçti'), `exit=${good.status}, ${good.out.split('\n').filter((l) => l.startsWith('[smoke]')).join(' ')}`);

const anon = await smokeAsync({});
check('Duman testi: kimlik bilgisi yoksa oturumlu kontroller atlanır, kalanlar geçer (üretimde yan etkisiz)', anon.status === 0 && anon.out.includes('atlandı') && anon.out.includes('4/4'), `exit=${anon.status}`);

const failures = [
  ['health 500', { healthCode: 500 }, 'GET /health'],
  ['health status≠UP', { healthStatus: 'DOWN' }, 'GET /health'],
  ['hiç hazır olmuyor (DB/Redis kopuk)', { readyNever: true }, '/health/ready'],
  ['yetkilendirme kapısı AÇIK (tokensiz 200)', { openAuth: true }, 'token yok'],
  ['frontend HTML değil', { frontendNotHtml: true }, 'Frontend kökü'],
  ['güvenlik başlığı yok', { noSniff: true }, 'nosniff'],
  ['duman kullanıcısı giriş yapamıyor', { loginFails: true }, 'login']
];
const failResults = [];
for (const [label, behavior, needle] of failures) {
  const r = await smokeAsync(behavior, FULL_ENV);
  failResults.push([label, r.status === 1 && r.out.includes('BAŞARISIZ') && r.out.includes(needle), r.status]);
}
check('Duman testi: her bozuk dağıtım türü exit 1 ile yakalanır (health 500, status≠UP, hazır değil, açık yetkilendirme, HTML olmayan frontend, eksik güvenlik başlığı, kırık giriş)',
  failResults.every(([, ok]) => ok), failResults.map(([l, ok, s]) => `${ok ? '✓' : '✗'} ${l}(exit ${s})`).join(' | '));

const warm = await smokeAsync({ readyAfterMs: 3000 }, { SMOKE_READY_TIMEOUT_SECONDS: '20' });
const dead = spawnSync('node', [path.join(ROOT, 'scripts/smoke-test.mjs')], { encoding: 'utf8', env: { ...process.env, SMOKE_BASE_URL: 'http://127.0.0.1:1/api/v1', SMOKE_READY_TIMEOUT_SECONDS: '3' } });
const noUrl = spawnSync('node', [path.join(ROOT, 'scripts/smoke-test.mjs')], { encoding: 'utf8', env: { ...process.env, SMOKE_BASE_URL: '' } });
check('Duman testi: ısınan servis (ilk 3 sn 503) yeniden denemeyle geçer; ulaşılamayan hedef exit 1; SMOKE_BASE_URL yoksa exit 2',
  warm.status === 0 && dead.status === 1 && noUrl.status === 2, `warm=${warm.status}, dead=${dead.status}, noUrl=${noUrl.status}`);

// ── 4. Workflow yapısı ────────────────────────────────────────────────────────
const wfPath = path.join(ROOT, '.github/workflows/ci-cd.yml');
const wf = JSON.parse(execFileSync('python3', ['-c', 'import yaml,json,sys; print(json.dumps(yaml.safe_load(open(sys.argv[1])), default=str))', wfPath], { encoding: 'utf8' }));
const wfText = readFileSync(wfPath, 'utf8');
const gates = ['quality-and-tests', 'auth-integration-test', 'build-bundle', 'docker-security-scan'];
const stg = wf.jobs['deploy-staging'];
const prd = wf.jobs['deploy-production'];
const stepIdx = (job, re) => job.steps.findIndex((s) => re.test(`${s.name || ''} ${s.run || ''} ${s.uses || ''}`));
const triggers = wf.on ?? wf[true];

check('Workflow: staging OTOMATİK — main/master push\'unda, `staging` environment\'ı ile, tüm kalite kapılarına bağlı; üretim referansı yok',
  !!stg && stg.environment?.name === 'staging' && gates.every((gt) => stg.needs.includes(gt)) && /refs\/heads\/main/.test(stg.if) && !/refs\/tags/.test(stg.if) &&
    !JSON.stringify(stg).includes('PRODUCTION_URL'), `if=${stg?.if?.replace(/\s+/g, ' ')}`);
check('Workflow: üretim ONAYLI — yalnızca vX.Y.Z etiketinde, `production` environment\'ı (Required reviewers kapısı), tüm kalite kapıları, dal push\'unda ÇALIŞMAZ',
  !!prd && prd.environment?.name === 'production' && gates.every((gt) => prd.needs.includes(gt)) && /refs\/tags\/v/.test(prd.if) && !/refs\/heads/.test(prd.if) &&
    (triggers.push.tags || []).some((t) => t.startsWith('v')), `if=${prd?.if?.replace(/\s+/g, ' ')}, tags=${JSON.stringify(triggers.push.tags)}`);

const iAppr = stepIdx(prd, /Onay kaydı/);
const iDeploy = stepIdx(prd, /appleboy\/ssh-action[\s\S]*|Deploy via SSH/);
const iSmoke = stepIdx(prd, /smoke-test\.mjs/);
const iAnc = stepIdx(prd, /merge-base --is-ancestor/);
const apprStep = prd.steps[iAppr];
check('Workflow: "kim onayladı" kaydı — run-approvals API\'sinden okunur, iş özetine yazılır, ONAY YOKSA dağıtım durur (exit 1); dağıtımdan ÖNCE çalışır; main-geçmişi kontrolü de dağıtımdan önce',
  iAppr >= 0 && /actions\/runs\/.*\/approvals/.test(apprStep.run) && /GITHUB_STEP_SUMMARY/.test(apprStep.run) && /exit 1/.test(apprStep.run) && iAppr < iDeploy && iAnc >= 0 && iAnc < iDeploy,
  `onay=${iAppr}, deploy=${iDeploy}, anc=${iAnc}`);
check('Workflow: duman testi her iki ortamda dağıtımdan SONRA; üretimde başarısızlıkta önceki etikete otomatik geri alma + GitHub Release (changelog + onaylayan) yalnızca başarıda',
  stepIdx(stg, /smoke-test\.mjs/) > stepIdx(stg, /Deploy via SSH/) && iSmoke > iDeploy &&
    prd.steps.some((s) => /Geri alma dağıtımı/.test(s.name || '') && /failure\(\)/.test(s.if || '')) &&
    prd.steps.some((s) => /GitHub Release/.test(s.name || '') && /success\(\)/.test(s.if || '') && /generate-changelog\.mjs/.test(s.run) && /APPROVERS/.test(s.run)),
  `stgSmoke=${stepIdx(stg, /smoke-test\.mjs/)}, prdSmoke=${iSmoke}`);
check('Workflow: erişim kısıtı — DEPLOY_* secret\'ları ortam kapsamlı (iş `environment:` altında), hiçbir job-seviyesi `if:` `secrets.` bağlamı kullanmaz, ayrı concurrency grupları, ilk push tetikleyicisi korunur',
  Object.values(wf.jobs).every((j) => !/secrets\./.test(j.if || '')) && stg.concurrency.group !== prd.concurrency.group && prd.concurrency['cancel-in-progress'] === false && (triggers.push.branches || []).includes('main'),
  '');
const q = wf.jobs['quality-and-tests'];
const qCheckout = q.steps.find((s) => /actions\/checkout/.test(s.uses || ''));
check('Workflow: quality job tam git geçmişiyle (fetch-depth: 0) migration güvenlik denetimini ve bu testi çalıştırır',
  qCheckout?.with?.['fetch-depth'] === 0 && q.steps.some((s) => /check-migration-safety\.mjs/.test(s.run || '')) && q.steps.some((s) => /test-ops1104\.mjs/.test(s.run || '')), '');
check('Workflow: eski tek `deploy-zero-downtime` işi kalmadı (iki yol net ayrıldı)', !wf.jobs['deploy-zero-downtime'] && !/deploy-zero-downtime/.test(wfText.replace(/#.*$/gm, '')), '');

// ── 5. Ortam şablonları ───────────────────────────────────────────────────────
const keysOf = (t) => new Set([...t.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
const example = readFileSync(path.join(ROOT, 'backend/.env.example'), 'utf8');
const stgTpl = readFileSync(path.join(ROOT, 'deploy/env/staging.env.example'), 'utf8');
const prdTpl = readFileSync(path.join(ROOT, 'deploy/env/production.env.example'), 'utf8');
const val = (t, k) => (t.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1];
const sameSet = (a, b) => a.size === b.size && [...a].every((k) => b.has(k));
check('Ortam şablonları: anahtar kümesi backend/.env.example ile AYNI; NODE_ENV=production; üretim TOTP_ENFORCED=true/LOG_LEVEL=warn; staging ve üretim DB adı farklı; ortama özel placeholder\'lar karışmaz',
  sameSet(keysOf(stgTpl), keysOf(example)) && sameSet(keysOf(prdTpl), keysOf(example)) && val(stgTpl, 'NODE_ENV') === 'production' && val(prdTpl, 'NODE_ENV') === 'production' &&
    val(prdTpl, 'TOTP_ENFORCED') === 'true' && val(prdTpl, 'LOG_LEVEL') === 'warn' && val(stgTpl, 'POSTGRES_DB') !== val(prdTpl, 'POSTGRES_DB') &&
    !stgTpl.includes('PRODUCTION_ONLY') && !prdTpl.includes('STAGING_ONLY') && stgTpl.includes('STAGING_ONLY') && prdTpl.includes('PRODUCTION_ONLY'),
  '');

// fill: false = hiçbir placeholder doldurulmaz; 'hex' = yalnızca 64-hex zorunlu şifreleme anahtarları doldurulur
// (şema regex'ini geçsin diye — böylece placeholder KORUMASININ kendisi sınanır); true = hepsi.
function loadConfigWith(envText, fill) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  for (const m of envText.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)) {
    const doFill = fill === true || (fill === 'hex' && /ENCRYPTION_KEY|TENANT_EXPORT/.test(m[1]));
    env[m[1]] = doFill && m[2].startsWith('__CHANGE_ME') ? randomBytes(32).toString('hex') : m[2];
  }
  return spawnSync(path.join(ROOT, 'backend/node_modules/.bin/tsx'), ['-e', "import('./src/config/env').then(()=>console.log('CONFIG_OK'))"], { cwd: path.join(ROOT, 'backend'), env, encoding: 'utf8', timeout: 60000 });
}
const unfilled = loadConfigWith(prdTpl, 'hex');
const unfilledStg = loadConfigWith(stgTpl, 'hex');
const unfilledRaw = loadConfigWith(prdTpl, false);
const filled = loadConfigWith(prdTpl, true);
const blankRequired = loadConfigWith(prdTpl.replace(/^JWT_SECRET=.*$/m, 'JWT_SECRET='), true);
check('Ortam şablonları: doldurulmamış (`__CHANGE_ME_…_ONLY`) üretim/staging şablonuyla backend BAŞLAMAZ (placeholder koruması ortama özel değerleri de yakalar); sırlar doldurulunca yapılandırma geçer',
  unfilled.status === 1 && /placeholder/.test(unfilled.stderr) && /JWT_SECRET/.test(unfilled.stderr) && unfilledStg.status === 1 && /placeholder/.test(unfilledStg.stderr) && unfilledRaw.status === 1 && filled.status === 0 && filled.stdout.includes('CONFIG_OK'),
  `üretim boş=${unfilled.status}, staging boş=${unfilledStg.status}, hiç doldurulmamış=${unfilledRaw.status}, dolu=${filled.status}${filled.status !== 0 ? ` ${filled.stderr.slice(0, 200)}` : ''}`);
check('Yapılandırma: isteğe bağlı anahtarlar (GEMINI_API_KEY, SMTP_*, SMS_*, LORAWAN_WEBHOOK_TOKEN, CORS_ALLOWED_ORIGINS) BOŞ bırakılınca (compose `${VAR:-}`) backend açılır; ZORUNLU sır (JWT_SECRET) boş bırakılırsa hâlâ reddedilir',
  filled.status === 0 && blankRequired.status === 1 && /JWT_SECRET/.test(blankRequired.stderr), `zorunlu boş=${blankRequired.status}`);

check('Belgeler: docs/ENVIRONMENTS.md üç ortamı, erişim kısıtını, expand/contract\'ı, KVKK veri politikasını, duman testini ve geri almayı kapsar',
  (() => {
    const d = readFileSync(path.join(ROOT, 'docs/ENVIRONMENTS.md'), 'utf8');
    return ['development', 'staging', 'production', 'Required reviewers', 'MIGRATION-CONTRACT', 'KVKK', 'maskelenmiş', 'smoke-test.mjs', 'geri alma', 'Onay kaydı'].every((w) => d.toLowerCase().includes(w.toLowerCase()));
  })(), '');

rmSync(tmp, { recursive: true, force: true });
console.log(`\nSONUÇ: ${passed}/${total} test geçti.`);
process.exit(passed === total ? 0 : 1);
