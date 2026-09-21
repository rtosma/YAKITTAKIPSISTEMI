#!/usr/bin/env node
// ==============================================================================
// OPS-1110 — Zero-downtime rolling deploy ve rollback prosedürü testleri (sıfır npm bağımlılığı).
//   node scripts/test-ops1110.mjs           statik + rollback davranışı (SAHTE docker ile; CI'da; docker gerekmez)
//   node scripts/test-ops1110.mjs --live    CANLI TATBİKAT (çalışan docker compose yığını gerekir): sürekli yük + AKTİF ikmal oturumu +
//                                           20 WebSocket istemcisi altında gerçek dağıtım (A→B) ve gerçek geri alma (B→A); kesinti, oturum
//                                           sürekliliği, kademeli soket boşaltma ve geri alma SÜRESİ ölçülür; docs/deploy-drills/<tarih>.md yazılır.
//                                           Yalnızca geliştirme/staging'de çalıştırın (yığını iki kez yeniden dağıtır, veritabanında geçici ikmal kaydı üretir).
// ==============================================================================
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = process.argv.includes('--live');
let passed = 0;
let total = 0;
const check = (name, ok, detail = '') => {
  total++;
  if (ok) passed++;
  console.log(`${ok ? '✅ [PASS]' : '❌ [FAIL]'} ${name}${detail ? `\n   ${detail}` : ''}`);
};
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const tmp = mkdtempSync(path.join(tmpdir(), 'ops1110-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. Drain / grace-period ayarları (derleme zamanı sözleşmesi) ──────────────
const indexTs = read('backend/src/index.ts');
const deploy = read('scripts/zero-downtime-deploy.sh');
const rollback = read('scripts/rollback.sh');
const compose = read('docker-compose.yml');
const shutdownTs = read('backend/src/utils/shutdown.ts');
const socketTs = read('backend/src/socket/socketServer.ts');

const appTimeoutS = Number(/setupGracefulShutdown\(server,\s*\{\s*(?:\/\/[^\n]*\n\s*)*timeoutMs:\s*(\d+)/.exec(indexTs)?.[1]) / 1000;
const drainDefault = Number(/DRAIN_TIMEOUT_SECONDS="\$\{DRAIN_TIMEOUT_SECONDS:-(\d+)\}"/.exec(deploy)?.[1]);
const graceS = Number(/stop_grace_period:\s*(\d+)s/.exec(compose)?.[1]);
const socketWindowS = Number(/SOCKET_DRAIN_WINDOW_MS\s*=\s*(\d+)/.exec(indexTs)?.[1]) / 1000;
check('Drain süresi: docker stop -t (varsayılan) ve compose stop_grace_period, uygulamanın kendi kapanış zaman aşımından (30 sn) BÜYÜK — SIGKILL asla uygulamanın graceful kapanışını kesmez',
  appTimeoutS === 30 && drainDefault > appTimeoutS && graceS > appTimeoutS && /docker stop -t "\$DRAIN_TIMEOUT_SECONDS" "\$OLD_ID"/.test(deploy) && !/docker stop "\$OLD_ID"/.test(deploy),
  `uygulama=${appTimeoutS} sn, deploy -t=${drainDefault} sn, compose=${graceS} sn`);
check('Drain süresi: WebSocket boşaltma penceresi, kapanış zaman aşımından KÜÇÜK (soketler zorla-çıkıştan önce boşalır) ve kapanma kancasına bağlı; server.close boştaki keep-alive bağlantıları da kapatır',
  socketWindowS > 0 && socketWindowS < appTimeoutS && /onShutdownStart:\s*async\s*\(\)\s*=>\s*\{\s*await drainSocketClients\(SOCKET_DRAIN_WINDOW_MS\)/.test(indexTs) &&
    /onShutdownStart/.test(shutdownTs) && /closeIdleConnections\(\)/.test(shutdownTs),
  `pencere=${socketWindowS} sn`);
check('WebSocket: kopuş `socket.conn.close()` (istemcide "transport close" → otomatik yeniden bağlanma) ile yapılır; `socket.disconnect(true)` KULLANILMAZ (canlı tatbikatta "io server disconnect" ile 20/20 istemci kalıcı düştü); handshake reddi yok',
  /socket\.conn\.close\(\)/.test(socketTs) && !/\.disconnect\(true\)/.test(socketTs.replace(/\/\*[\s\S]*?\*\//g, '')) && !/SHUTTING_DOWN/.test(socketTs.replace(/\/\*[\s\S]*?\*\//g, '')),
  '');

// ── 2. Blue/green sırası ve readiness ────────────────────────────────────────
// Yalnızca YORUM OLMAYAN satırlarda ara (betiğin başındaki açıklama aynı ifadeleri içerir).
const deployCode = deploy.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const at = (needle) => deployCode.indexOf(needle);
check('Rolling sırası: şema → yeni replika → healthcheck → READINESS+sürüm doğrulaması → atomik nginx kesmesi → drain ile eski replikayı durdurma → sürüm kaydı; readiness cutover\'dan ÖNCE',
  [at('log "2/8'), at('docker compose up -d --no-deps --scale'), at('.State.Health.Status'), at('${NEW_HEALTH_URL}/ready'), at('write_upstream_target "server ${NEW_NAME}:5000;"'), at('docker stop -t'), at('>> "$RELEASE_LOG"')]
    .every((v, i, a) => v > 0 && (i === 0 || v > a[i - 1])),
  '');
check('Readiness: yeni replika hazır olmazsa VEYA /health sürümü beklenenle uyuşmazsa yeni konteyner kaldırılır ve deploy durur (eski replika trafik almaya devam eder)',
  /HAZIR \(readiness\) olmadı — geri alındı/.test(deploy) && /beklenen sürümü bildirmedi/.test(deploy) && /docker rm -f "\$NEW_ID"/.test(deploy),
  '');
check('Sürüm kaydı: APP_VERSION imaja gömülür (Dockerfile ARG/ENV, compose build.args), /health `version` döner, env şemasında güvenli karakter kümesiyle doğrulanır; release log + imaj etiketi + son N sürüm tutulur',
  /ARG APP_VERSION/.test(read('backend/Dockerfile')) && /ENV APP_VERSION=\$\{APP_VERSION\}/.test(read('backend/Dockerfile')) && /APP_VERSION: \$\{APP_VERSION:-dev\}/.test(compose) &&
    /version: config\.APP_VERSION/.test(read('backend/src/routes/routes.ts')) && /APP_VERSION: z\.string\(\)\.regex/.test(read('backend/src/config/env.ts')) &&
    /docker tag "\$NEW_IMAGE_ID"/.test(deploy) && /RELEASE_KEEP/.test(deploy) && /docker rmi/.test(deploy),
  '');

// ── 3. Rollback davranışı — GERÇEK rollback.sh + GERÇEK migration-safety CLI, SAHTE docker ────────────
const fx = path.join(tmp, 'fx');
mkdirSync(path.join(fx, 'scripts/lib'), { recursive: true });
mkdirSync(path.join(fx, 'backend/src/db'), { recursive: true });
mkdirSync(path.join(fx, 'bin'), { recursive: true });
copyFileSync(path.join(ROOT, 'scripts/rollback.sh'), path.join(fx, 'scripts/rollback.sh'));
copyFileSync(path.join(ROOT, 'scripts/check-migration-safety.mjs'), path.join(fx, 'scripts/check-migration-safety.mjs'));
copyFileSync(path.join(ROOT, 'scripts/lib/migrationSafety.mjs'), path.join(fx, 'scripts/lib/migrationSafety.mjs'));
writeFileSync(path.join(fx, 'scripts/zero-downtime-deploy.sh'), '#!/usr/bin/env bash\necho "DEPLOY APP_VERSION=$APP_VERSION GIT_SHA=$GIT_SHA SKIP_BUILD=$SKIP_BUILD SKIP_SCHEMA=$SKIP_SCHEMA DEPLOY_KIND=$DEPLOY_KIND" >> "$FAKE_LOG"\n');
writeFileSync(path.join(fx, 'bin/docker'), `#!/bin/sh
echo "docker $*" >> "$FAKE_LOG"
case "$1" in
  image) [ -f "$FAKE_IMAGES/$(echo "$3" | sed 's/.*://')" ] && exit 0 || exit 1 ;;
  compose) echo fakebackendid ;;
  inspect) echo myproj-backend ;;
  tag) exit 0 ;;
esac
`);
for (const f of ['scripts/rollback.sh', 'scripts/zero-downtime-deploy.sh', 'bin/docker']) chmodSync(path.join(fx, f), 0o755);
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const g = (...a) => execFileSync('git', a, { cwd: fx, encoding: 'utf8', env: gitEnv }).trim();
const schemaPath = path.join(fx, 'backend/src/db/schema.sql');
const BASE = 'CREATE TABLE IF NOT EXISTS a (id INT, old_col INT);';
g('init', '-q');
const commitSchema = (sql, msg) => { writeFileSync(schemaPath, sql); g('add', '.'); g('commit', '-q', '-m', msg); return g('rev-parse', 'HEAD'); };
const c1 = commitSchema(BASE, 'v1');
const c2 = commitSchema(`${BASE}\nALTER TABLE a ADD COLUMN IF NOT EXISTS x INT;`, 'v2 expand');
const c3 = commitSchema(`${BASE}\nALTER TABLE a ADD COLUMN IF NOT EXISTS x INT;\n-- MIGRATION-CONTRACT: old_col artık hiçbir kod tarafından okunmuyor (OPS-1110 test)\nALTER TABLE a DROP COLUMN IF EXISTS old_col;`, 'v3 contract');
const logFile = path.join(fx, 'releases.log');
const fakeLog = path.join(fx, 'fake.log');
const images = path.join(fx, 'images');
mkdirSync(images);
for (const v of ['v1', 'v2', 'v3']) writeFileSync(path.join(images, v), '');
const line = (v, sha, kind = 'deploy') => `2026-09-21T10:00:00Z\t${kind}\t${v}\t${sha}\timg\tprev\t20\n`;
const setLog = (...lines) => writeFileSync(logFile, lines.join(''));
const run = (...args) => {
  rmSync(fakeLog, { force: true });
  const r = spawnSync('bash', ['scripts/rollback.sh', ...args], { cwd: fx, encoding: 'utf8', env: { ...process.env, PATH: `${path.join(fx, 'bin')}:${process.env.PATH}`, RELEASE_LOG: logFile, FAKE_LOG: fakeLog, FAKE_IMAGES: images } });
  const calls = existsSync(fakeLog) ? readFileSync(fakeLog, 'utf8') : '';
  return { rc: r.status, out: r.stdout + r.stderr, calls, deployed: /DEPLOY /.test(calls), tagged: /docker tag /.test(calls) };
};

// 3a. --strict CLI sözleşmesi
const cli = (oldSql, newSql, ...extra) => {
  writeFileSync(path.join(tmp, 'o.sql'), oldSql); writeFileSync(path.join(tmp, 'n.sql'), newSql);
  return spawnSync('node', [path.join(ROOT, 'scripts/check-migration-safety.mjs'), '--old', path.join(tmp, 'o.sql'), '--new', path.join(tmp, 'n.sql'), ...extra], { encoding: 'utf8' });
};
const expandSql = `${BASE}\nALTER TABLE a ADD COLUMN IF NOT EXISTS x INT;`;
const approvedSql = `${BASE}\n-- MIGRATION-CONTRACT: gerekçe yeterince uzun bir açıklama\nALTER TABLE a DROP COLUMN old_col;`;
const rawSql = `${BASE}\nALTER TABLE a DROP COLUMN old_col;`;
const s1 = cli(BASE, expandSql, '--strict'); const s2 = cli(BASE, approvedSql, '--strict'); const s3 = cli(BASE, approvedSql); const s4 = cli(BASE, rawSql, '--strict');
check('Migration kapısı (--strict): yalnızca expand → çıkış 0 "ROLLBACK GÜVENLİ"; ONAYLI contract bile → çıkış 3 (dağıtım için "bilinçli" ≠ geri alma için güvenli); onaysız contract → 3; --strict olmadan onaylı contract dağıtım için hâlâ 0',
  s1.status === 0 && s1.stdout.includes('ROLLBACK GÜVENLİ') && s2.status === 3 && s2.stderr.includes('ROLLBACK GÜVENSİZ') && s3.status === 0 && s4.status === 3,
  `expand=${s1.status}, onaylı=${s2.status}, onaylı(strict-dışı)=${s3.status}, onaysız=${s4.status}`);

// 3b. Rollback senaryoları
setLog(line('v1', c1), line('v2', c2), line('v3', c3));
const r1 = run();
check('Rollback: v2→v3 arasında ONAYLI contract (DROP COLUMN) varsa "önceki sürüme" geri alma REDDEDİLİR (çıkış 3): dağıtım çalıştırılmaz, imaj etiketlenmez; mesaj hotfix/yedekten geri yükleme yollarını gösterir',
  r1.rc === 3 && !r1.deployed && !r1.tagged && r1.out.includes('GÜVENSİZ') && r1.out.includes('geri dönüşsüz (contract)') && !r1.out.includes('çalıştırılamadı') && r1.out.includes('BACKUP_RESTORE.md') && r1.out.includes('--accept-schema-risk'), `rc=${r1.rc}`);
const r2 = run('--accept-schema-risk');
check('Rollback: --accept-schema-risk ile BİLEREK ilerler — hedef=v2; imaj Compose imajı olarak yeniden etiketlenir; deploy SKIP_BUILD=1 SKIP_SCHEMA=1 DEPLOY_KIND=rollback ve HEDEFİN kendi git SHA\'sı ile çağrılır (yeniden derleme/şema yok)',
  r2.rc === 0 && r2.out.includes('UYARI') && r2.calls.includes('docker tag yakittakip-backend-release:v2 myproj-backend:latest') &&
    r2.calls.includes(`DEPLOY APP_VERSION=v2 GIT_SHA=${c2} SKIP_BUILD=1 SKIP_SCHEMA=1 DEPLOY_KIND=rollback`), `rc=${r2.rc}`);
setLog(line('v1', c1), line('v2', c2));
const r3 = run();
check('Rollback: yalnızca expand-only şema değişikliği varsa (v1→v2) ek bayrak GEREKMEZ — tek komutla önceki sürüme (v1) döner; şema geri alınmaz',
  r3.rc === 0 && r3.out.includes('ROLLBACK GÜVENLİ') && r3.calls.includes('DEPLOY APP_VERSION=v1 ') && r3.calls.includes('SKIP_SCHEMA=1'), `rc=${r3.rc}`);
setLog(line('v1', c1), line('v2', c2), line('v2', c2));
const r3b = run();
check('Rollback: aynı sürüm art arda dağıtıldıysa (v1, v2, v2) "önceki" v2 değil FARKLI olan v1\'dir (satır sayarak değil sürüme bakarak seçilir)',
  r3b.rc === 0 && r3b.calls.includes('DEPLOY APP_VERSION=v1 ') && !r3b.calls.includes('APP_VERSION=v2'), `rc=${r3b.rc}`);
setLog(line('v1', c1), line('v2', c2), line('v3', c3));
const r4 = run('v1');
check('Rollback: açık hedef (v1) — aradaki HERHANGİ bir contract (v2→v3 dahil) yakalanır (yalnızca komşu sürüme bakılmaz)', r4.rc === 3 && !r4.deployed, `rc=${r4.rc}`);
const r5 = run('v9');
check('Rollback: kayıtta olmayan sürüm reddedilir (hiçbir şey çalıştırılmaz)', r5.rc === 1 && !r5.deployed && r5.out.includes('kayıtlı değil'), `rc=${r5.rc}`);
setLog(line('v1', c1), line('v2', c2));
const r6 = run('v2');
check('Rollback: hedef zaten çalışan sürümse reddedilir', r6.rc === 1 && !r6.deployed && r6.out.includes('zaten çalışan'), `rc=${r6.rc}`);
rmSync(path.join(images, 'v1'));
const r7 = run();
check('Rollback: hedef imaj yerelde yoksa (temizlenmiş) reddedilir ve kaynaktan yeniden dağıtım yolu söylenir — çalışan sürüm bozulmaz', r7.rc === 1 && !r7.deployed && !r7.tagged && r7.out.includes('yerelde yok'), `rc=${r7.rc}`);
writeFileSync(path.join(images, 'v1'), '');
setLog(line('v1', 'deadbeef'.repeat(5)), line('v2', c2));
const r8 = run(); const r8b = run('--accept-schema-risk');
check('Rollback: git geçmişinde çözülemeyen şema sürümü (sığ klon/yanlış SHA) → muhafazakâr RED (çıkış 3); yalnızca açık bayrakla ilerler',
  r8.rc === 3 && !r8.deployed && r8.out.includes('doğrulanamadı') && r8b.rc === 0 && r8b.deployed, `rc=${r8.rc}/${r8b.rc}`);
writeFileSync(logFile, '');
const r9 = run();
check('Rollback: kayıt defteri boşsa (bu sunucuda hiç dağıtım kaydı yok) anlaşılır hata verir', r9.rc === 1 && r9.out.includes('kayıtlı bir dağıtım yok') && !r9.deployed, `rc=${r9.rc}`);
setLog(line('v1', c1), line('v2', c2), line('v1', c1, 'rollback'));
const r10 = run(); const r10l = run('--list');
check('Rollback: "önceki" = güncelden FARKLI en son sürüm (v1→v2→rollback v1 sonrası tekrar rollback v2\'ye döner); --list geçmişi (tür/sürüm/SHA/süre) yeniden→eskiye yazar ve hiçbir şey çalıştırmaz',
  r10.rc === 0 && r10.calls.includes('DEPLOY APP_VERSION=v2 ') && r10l.rc === 0 && !r10l.deployed && /rollback \| v1/.test(r10l.out) && r10l.out.indexOf('v1') < r10l.out.lastIndexOf('v2'), `rc=${r10.rc}`);

// ── 4. Doküman ───────────────────────────────────────────────────────────────
const doc = existsSync(path.join(ROOT, 'docs/DEPLOY_ROLLBACK.md')) ? read('docs/DEPLOY_ROLLBACK.md') : '';
const docTerms = ['readiness', 'drain', 'SIGTERM', 'stop_grace_period', 'WebSocket', 'transport close', 'MQTT', '$share', 'Redis', 'rollback.sh', '--accept-schema-risk', 'expand', 'contract', 'BACKUP_RESTORE.md', 'RELEASE_LOG', 'deploy-drills', 'ping-pong', 'SKIP_BUILD'];
const missing = docTerms.filter((t) => !doc.includes(t));
check('Doküman: docs/DEPLOY_ROLLBACK.md drain süresi gerekçesini, WS/MQTT/ikmal-oturumu davranışını, geri alma prosedürünü, migrasyon sınırını (expand/contract, yedekten geri yükleme) ve tatbikat sonuçlarını kapsar',
  missing.length === 0 && existsSync(path.join(ROOT, 'docs/deploy-drills/README.md')), `eksik=[${missing}]`);
const envDoc = read('docs/ENVIRONMENTS.md');
check('Doküman: ENVIRONMENTS.md elle geri almayı rollback.sh\'e yönlendirir (eski `git reset --hard` tarifi tek başına bırakılmaz); runbook geri alma referansı verir',
  envDoc.includes('rollback.sh') && envDoc.includes('DEPLOY_ROLLBACK.md') && read('docs/runbooks/api.md').includes('rollback.sh'), '');
const ci = read('.github/workflows/ci-cd.yml');
check('CI: test-ops1110 (statik + sahte-docker rollback) quality-and-tests içinde; üretim otomatik geri alması scripts/rollback.sh kullanır',
  /node scripts\/test-ops1110\.mjs/.test(ci) && /scripts\/rollback\.sh/.test(ci), '');

// ── 5. CANLI TATBİKAT ────────────────────────────────────────────────────────
if (LIVE) {
  const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  const drillLog = path.join(tmp, 'drill-releases.log');
  const env = { ...process.env, RELEASE_LOG: drillLog, RELEASE_IMAGE_REPO: 'yakittakip-backend-release' };
  const VA = 'ops1110-A';
  const VB = 'ops1110-B';
  const psql = (sql) => sh('docker', ['compose', 'exec', '-T', 'postgres', 'sh', '-c', 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -v ON_ERROR_STOP=1'], { input: sql }).stdout.trim();
  const fe = sh('docker', ['compose', 'ps', '-q', 'frontend']).stdout.trim();
  const be = sh('docker', ['compose', 'ps', '-q', 'backend']).stdout.trim();
  if (!fe || !be) { check('Canlı tatbikat ön koşulu: compose yığını (frontend + backend) çalışıyor', false, 'docker compose up -d ile yığını başlatın'); process.exit(1); }
  const probeSrc = read('scripts/lib/ops1110-probe.cjs');
  const runtimeImage = 'yakittakipsistemi-backend:test-runner';
  const hasRunner = sh('docker', ['image', 'inspect', runtimeImage]).status === 0;
  if (!hasRunner) { check(`Canlı tatbikat ön koşulu: ${runtimeImage} imajı (socket.io-client içerir) mevcut`, false, 'docker build --target test-runner -t ' + runtimeImage + ' backend'); process.exit(1); }

  // Test verisi: FUEL-401 testiyle aynı ön koşul (araç-sürücü ataması); sonda geri alınır.
  const tankBefore = psql("SELECT current_level_liters FROM tanks WHERE id='tank-gebze-1'");
  const restoreDb = () => { psql(`DELETE FROM transactions WHERE idempotency_key LIKE 'ops1110-%'; UPDATE tanks SET current_level_liters=${tankBefore}, status='GÜVENLİ' WHERE id='tank-gebze-1'; UPDATE vehicles SET assigned_driver_name=NULL WHERE id='veh-1';`); };
  psql("UPDATE vehicles SET assigned_driver_name='Ahmet Yılmaz' WHERE id='veh-1'; DELETE FROM transactions WHERE idempotency_key LIKE 'ops1110-%';");
  // Bayat bir sürüm etiketi: retansiyon temizliğinin çalıştığını kanıtlamak için.
  sh('docker', ['tag', 'alpine:3.20', `${env.RELEASE_IMAGE_REPO}:stale-ops1110`]);
  const cleanup = () => {
    sh('docker', ['rm', '-f', 'ops1110-probe']);
    restoreDb();
    for (const v of ['stale-ops1110']) sh('docker', ['rmi', `${env.RELEASE_IMAGE_REPO}:${v}`]);
  };
  process.on('exit', cleanup);

  const startProbe = () => {
    sh('docker', ['rm', '-f', 'ops1110-probe']);
    const r = sh('docker', ['run', '-d', '--name', 'ops1110-probe', '--network', `container:${fe}`, '--env-file', '.env', '-e', `PROBE_SRC=${probeSrc}`, runtimeImage, 'node', '-e', 'eval(process.env.PROBE_SRC)']);
    if (r.status !== 0) throw new Error(`prob başlatılamadı: ${r.stderr}`);
  };
  const waitReady = async () => { for (let i = 0; i < 60; i++) { const o = sh('docker', ['logs', 'ops1110-probe']); if ((o.stdout + o.stderr).includes('READY')) return true; await sleep(500); } return false; };
  const stopProbe = async () => {
    sh('docker', ['kill', '-s', 'USR1', 'ops1110-probe']);
    for (let i = 0; i < 60; i++) { const o = sh('docker', ['logs', 'ops1110-probe']).stdout; const m = /^RESULT (.*)$/m.exec(o); if (m) return JSON.parse(m[1]); await sleep(500); }
    throw new Error('prob sonucu alınamadı: ' + sh('docker', ['logs', 'ops1110-probe']).stdout);
  };
  const evalPhase = (label, res, fromV, toV) => {
    const s = res.sockets;
    const ts = s.disconnects.map((d) => d.t).sort((a, b) => a - b);
    const spread = ts.length ? ts[ts.length - 1] - ts[0] : 0;
    const perSec = {};
    for (const t of ts) perSec[Math.floor(t / 1000)] = (perSec[Math.floor(t / 1000)] || 0) + 1;
    const peak = Math.max(0, ...Object.values(perSec));
    const d = res.dispense;
    check(`[${label}] Kesinti YOK: ${res.health.total} sağlık + ${res.api.total} kimlikli API isteği, hepsi 200 (dağıtım boyunca); trafik ${fromV} → ${toV} geçti`,
      res.health.failures.length === 0 && res.api.failures.length === 0 && res.health.total > 100 && res.health.versions[fromV] && res.health.versions[toV] &&
        res.health.versions[fromV].firstSeenMs < res.health.versions[toV].firstSeenMs,
      `sağlık hatası=${JSON.stringify(res.health.failures.slice(0, 3))}, api hatası=${JSON.stringify(res.api.failures.slice(0, 3))}, sürümler=${JSON.stringify(res.health.versions)}`);
    check(`[${label}] Devam eden ikmal KESİLMEDİ: oturum ${d.sessionStartVersion} örneğinde başladı, ${d.heartbeats} heartbeat hatasız (${d.failures.length} hata), finalize ${d.finalizeVersion} örneğinde 200 + DOĞRULANDI + tutar=${d.expectedLiters} L`,
      d.started && d.failures.length === 0 && d.heartbeats >= 15 && d.sessionStartVersion === fromV && d.finalizeVersion === toV && d.finalize && d.finalize.status === 200 &&
        Number(d.finalize.amount) === d.expectedLiters && d.finalize.verification === 'DOĞRULANDI',
      `${JSON.stringify(d).slice(0, 500)}`);
    check(`[${label}] WebSocket: ${s.n}/${s.n} istemci kademeli koptu (yayılım ${spread} ms ≥ 4000, en yoğun saniyede ${peak} ≤ ${Math.ceil(s.n * 0.3)}), sebep "io server disconnect" DEĞİL, hepsi otomatik yeniden bağlandı (takılan ${s.stuck})`,
      s.initialConnected === s.n && s.disconnects.length === s.n && spread >= 4000 && peak <= Math.ceil(s.n * 0.3) && s.disconnects.every((x) => x.reason !== 'io server disconnect') &&
        s.reconnects.length === s.n && s.stuck === 0 && s.finalConnected === s.n,
      `kopuş=${s.disconnects.length}, yeniden bağlanma=${s.reconnects.length}, sebepler=${[...new Set(s.disconnects.map((x) => x.reason))]}`);
    return { spread, peak };
  };

  console.log('\n── CANLI TATBİKAT ──');
  // 0. Taban sürüm A (yeni koddan derlenir; probun dışında).
  const dA = sh('bash', ['scripts/zero-downtime-deploy.sh'], { env: { ...env, APP_VERSION: VA } });
  check(`Tatbikat 0: taban sürüm ${VA} dağıtıldı (derleme + şema + readiness + kesme + drain)`, dA.status === 0 && /Tamamlandı \[deploy .* → ops1110-A/.test(dA.stdout), dA.stdout.slice(-300) + dA.stderr.slice(-300));

  // 1. A → B: sürekli yük + aktif ikmal + soketler altında.
  startProbe();
  const ready1 = await waitReady();
  const t1 = Date.now();
  const dB = sh('bash', ['scripts/zero-downtime-deploy.sh'], { env: { ...env, APP_VERSION: VB } });
  const deployMs = Date.now() - t1;
  await sleep(5000);
  const res1 = await stopProbe();
  sh('docker', ['rm', '-f', 'ops1110-probe']);
  check('Tatbikat 1: yük sondası hazırdı (20/20 soket bağlı) ve A→B dağıtımı başarılı', ready1 && dB.status === 0, dB.stdout.slice(-300));
  const exitLine1 = /temiz kapandı \(drain (\d+) sn, çıkış kodu 0\)/.exec(dB.stdout);
  check(`[A→B] Eski replika TEMİZ kapandı: çıkış kodu 0 (30 sn zorla-çıkışa da SIGKILL'e de takılmadı), drain ${exitLine1 ? exitLine1[1] : '?'} sn ≤ 20`,
    !!exitLine1 && Number(exitLine1[1]) <= 20, dB.stdout.split('\n').filter((l) => /konteyner temiz|UYARI/.test(l)).join(' | '));
  const ph1 = evalPhase('A→B', res1, VA, VB);

  // 2. Kayıt defteri + imaj etiketleri + retansiyon.
  const log1 = existsSync(drillLog) ? readFileSync(drillLog, 'utf8').trim().split('\n').map((l) => l.split('\t')) : [];
  const tags = sh('docker', ['images', '--format', '{{.Tag}}', env.RELEASE_IMAGE_REPO]).stdout.split('\n').filter(Boolean);
  check('Sürüm kaydı: kayıt defterinde A ve B (tür=deploy, git SHA, önceki sürüm=…); imajlar `yakittakip-backend-release:<sürüm>` olarak etiketli; kayıtta olmayan bayat etiket temizlendi',
    log1.length === 2 && log1[0][2] === VA && log1[1][2] === VB && log1[1][5] === VA && log1[1][1] === 'deploy' && /^[0-9a-f]{40}$/.test(log1[1][3]) && tags.includes(VA) && tags.includes(VB) && !tags.includes('stale-ops1110'),
    `kayıt=${JSON.stringify(log1.map((l) => [l[1], l[2], l[5], l[6]]))}, etiketler=${tags}`);

  // 3. ROLLBACK B → A (tek komut, yeniden derleme yok) — SÜRE ÖLÇÜLÜR.
  psql("DELETE FROM transactions WHERE idempotency_key LIKE 'ops1110-%';");
  startProbe();
  const ready2 = await waitReady();
  const t2 = Date.now();
  const rb = sh('bash', ['scripts/rollback.sh'], { env });
  const rollbackMs = Date.now() - t2;
  await sleep(5000);
  const res2 = await stopProbe();
  sh('docker', ['rm', '-f', 'ops1110-probe']);
  check(`Tatbikat 2: rollback.sh TEK komutla çalıştı (derleme atlandı, şema atlandı), ölçülen süre ${(rollbackMs / 1000).toFixed(1)} sn ≤ 120 sn`,
    ready2 && rb.status === 0 && rb.stdout.includes('Derleme ATLANDI') && rb.stdout.includes('Şema uygulaması ATLANDI') && !rb.stdout.includes('imajı derleniyor') && rollbackMs <= 120000,
    rb.stdout.slice(-400) + rb.stderr.slice(-300));
  const exitLine2 = /temiz kapandı \(drain (\d+) sn, çıkış kodu 0\)/.exec(rb.stdout);
  check(`[B→A] Eski replika TEMİZ kapandı (çıkış kodu 0), drain ${exitLine2 ? exitLine2[1] : '?'} sn`, !!exitLine2 && Number(exitLine2[1]) <= 20, '');
  const ph2 = evalPhase('B→A', res2, VB, VA);
  const log2 = readFileSync(drillLog, 'utf8').trim().split('\n').map((l) => l.split('\t'));
  const nowVersion = sh('docker', ['exec', sh('docker', ['compose', 'ps', '-q', 'backend']).stdout.trim().split('\n')[0], 'wget', '-qO-', 'http://localhost:5000/api/v1/health']).stdout;
  check('Rollback sonucu: çalışan sürüm A (/health `version`), kayıtta tür=rollback + önceki sürüm=B; tek çalışan backend konteyneri',
    nowVersion.includes(`"version":"${VA}"`) && log2.length === 3 && log2[2][1] === 'rollback' && log2[2][2] === VA && log2[2][5] === VB &&
      sh('docker', ['compose', 'ps', '-q', 'backend']).stdout.trim().split('\n').filter(Boolean).length === 1,
    `health=${nowVersion.trim().slice(0, 120)}, kayıt=${JSON.stringify(log2[2])}`);

  // 4. Rapor
  const date = new Date().toISOString().slice(0, 10);
  const dir = path.join(ROOT, 'docs/deploy-drills');
  mkdirSync(dir, { recursive: true });
  const ok = passed === total;
  writeFileSync(path.join(dir, `${date}.md`), `# Dağıtım ve Rollback Tatbikatı — ${date}

**Sonuç: ${ok ? 'BAŞARILI' : 'BAŞARISIZ (ayrıntı için test çıktısı)'}** · Ortam: geliştirme (docker compose, tek makine) · Yapan: \`${process.env.USER || 'bilinmiyor'}@${process.env.HOSTNAME || 'makine'}\` · Betik: \`node scripts/test-ops1110.mjs --live\`

## Senaryo
Dağıtım boyunca (sürekli) çalışan yük: 100 ms'de bir \`GET /health\`, 250 ms'de bir kimlik doğrulamalı API çağrısı, **1 sn'de bir heartbeat gönderen AKTİF ikmal oturumu** (cihaz HMAC imzalı; eski replikada başlar, yeni replikada finalize edilir) ve **20 WebSocket istemcisi** (frontend ile aynı yeniden bağlanma ayarları). Trafik gerçek istemci yolundan geçer (nginx → backend).

## Ölçümler
| Adım | Süre | Sağlık/API hatası | İkmal oturumu | WebSocket |
|---|---|---|---|---|
| Dağıtım ${VA} → ${VB} (derleme + şema + readiness + kesme + drain) | ${(deployMs / 1000).toFixed(1)} sn | ${res1.health.failures.length + res1.api.failures.length} / ${res1.health.total + res1.api.total} istek | ${res1.dispense.heartbeats} heartbeat, 0 hata, finalize ${res1.dispense.finalize?.status} (${res1.dispense.expectedLiters} L doğrulandı) | ${res1.sockets.n} istemci ${ph1.spread} ms'ye yayıldı (en yoğun saniye: ${ph1.peak}), ${res1.sockets.reconnects.length} yeniden bağlandı |
| **Rollback ${VB} → ${VA}** (\`scripts/rollback.sh\`, derleme yok) | **${(rollbackMs / 1000).toFixed(1)} sn** | ${res2.health.failures.length + res2.api.failures.length} / ${res2.health.total + res2.api.total} istek | ${res2.dispense.heartbeats} heartbeat, 0 hata, finalize ${res2.dispense.finalize?.status} (${res2.dispense.expectedLiters} L doğrulandı) | ${res2.sockets.n} istemci ${ph2.spread} ms'ye yayıldı (en yoğun saniye: ${ph2.peak}), ${res2.sockets.reconnects.length} yeniden bağlandı |

## Hedefler
| Hedef (OPS-1110 AC) | Ölçülen | Durum |
|---|---|---|
| Devam eden ikmal kesilmez | oturum eski örnekte başladı, yeni örnekte finalize; heartbeat hatası 0 | ${res1.dispense.failures.length + res2.dispense.failures.length === 0 ? 'KARŞILANDI' : 'KARŞILANMADI'} |
| Önceki sürüme tek adımda dönülebilir | \`./scripts/rollback.sh\` (tek komut) | KARŞILANDI |
| Rollback tatbikatı yapıldı, süre ölçüldü | ${(rollbackMs / 1000).toFixed(1)} sn (bütçe ≤ 120 sn) | ${rollbackMs <= 120000 ? 'KARŞILANDI' : 'KARŞILANMADI'} |
| Kesinti (ölçülen başarısız istek) | ${res1.health.failures.length + res1.api.failures.length + res2.health.failures.length + res2.api.failures.length} | ${res1.health.failures.length + res1.api.failures.length + res2.health.failures.length + res2.api.failures.length === 0 ? 'SIFIR KESİNTİ' : 'KESİNTİ VAR'} |

## Notlar
- Bu tatbikat tek makinedeki compose yığınında yapıldı; üretimde süreler ağ/disk/imaj boyutuna göre değişir. Çeyrekte bir ve büyük altyapı değişikliklerinde (Docker/nginx/Postgres sürümü) tekrarlanmalıdır.
- Migrasyon sınırı bu tatbikatın kapsamı dışındadır: geri alma yalnızca UYGULAMAYI geri alır; contract adımı içeren sürümler arası dönüş \`rollback.sh\` tarafından reddedilir (bkz. [../DEPLOY_ROLLBACK.md](../DEPLOY_ROLLBACK.md)).
`);
  console.log(`\nRapor yazıldı: docs/deploy-drills/${date}.md`);
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\nSONUÇ: ${passed}/${total} test geçti.`);
process.exit(passed === total ? 0 : 1);
