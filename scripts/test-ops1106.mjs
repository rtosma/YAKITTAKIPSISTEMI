#!/usr/bin/env node
// ==============================================================================
// OPS-1106 — yedekleme / geri yükleme testleri (GERÇEK Postgres konteynerleriyle, sıfır npm bağımlılığı).
//
// Kaynak veritabanı, docker-compose.yml + docker-compose.backup.yml'in GERÇEK `postgres` tanımından (komut satırı
// ayarları, ortam, volume'lar) türetilen geçici bir konteynerdir (`--network none`; canlı yığına dokunmaz), üzerine
// schema.sql + seed_mock_data.sql uygulanır. Sonra: yedek → WAL gönderimi → geri yükleme (dump, PITR) → doğrulama.
// ==============================================================================
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync, statSync, chmodSync, mkdirSync, cpSync, readSync, openSync, closeSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN = randomBytes(3).toString('hex');
const P = `ykbk-${RUN}`;
let passed = 0;
let total = 0;
const check = (name, ok, detail = '') => {
  total++;
  if (ok) passed++;
  console.log(`${ok ? '✅ [PASS]' : '❌ [FAIL]'} ${name}${detail ? `\n   ${detail}` : ''}`);
};
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
const docker = (...a) => sh('docker', a);

const tmp = mkdtempSync(path.join(tmpdir(), 'ops1106-'));
const DEST = path.join(tmp, 'yedek-konumu');
const KEY = randomBytes(32).toString('hex');
const CRYPTO = path.join(ROOT, 'scripts/lib/backupCrypto.mjs');
const env = (extra = {}) => ({ ...process.env, BACKUP_DEST_DIR: DEST, BACKUP_ENCRYPTION_KEY: KEY, PG_CONTAINER: `${P}-src`, ...extra });
const script = (name, args = [], extra = {}) => sh('bash', [path.join(ROOT, 'scripts/backup', name), ...args], { env: env(extra), timeout: 600000 });
const lastJson = (r) => JSON.parse(r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop());
const created = { containers: [], volumes: [] };

async function main() {
  console.log(`[ops1106] geçici ortam: ${P}, yedek konumu: ${DEST}\n`);

  // ── 1. Şifreleme (AES-256-GCM) ─────────────────────────────────────────────
  const plain = path.join(tmp, 'plain.bin');
  const marker = 'GIZLI-MUSTERI-VERISI-' + RUN;
  writeFileSync(plain, Buffer.concat([Buffer.from(marker), randomBytes(2_500_000), Buffer.alloc(1_500_000)]));
  const enc = path.join(tmp, 'plain.enc'); const encGz = path.join(tmp, 'plain.gz.enc'); const dec = path.join(tmp, 'plain.out');
  const c = (args, e = {}) => sh('node', [CRYPTO, ...args], { env: { ...process.env, BACKUP_ENCRYPTION_KEY: KEY, ...e } });
  const okEnc = c(['encrypt', plain, enc]); const okEncGz = c(['encrypt', '--gzip', plain, encGz]);
  const okDec = c(['decrypt', enc, dec]);
  const same = existsSync(dec) && readFileSync(dec).equals(readFileSync(plain));
  const decGz = path.join(tmp, 'plain.gz.out'); c(['decrypt', encGz, decGz]);
  check('Şifreleme: AES-256-GCM gidiş-dönüş birebir (gzip\'li ve gzip\'siz); şifreli dosyada düz metin YOK; gzip sıkıştırır; 2 şifreleme aynı girdiyi FARKLI üretir (rastgele IV)',
    okEnc.status === 0 && okEncGz.status === 0 && okDec.status === 0 && same && readFileSync(decGz).equals(readFileSync(plain)) &&
      !readFileSync(enc).includes(Buffer.from(marker)) && statSync(encGz).size < statSync(enc).size * 0.7 &&
      readFileSync(enc).subarray(0, 4).toString() === 'YKB1' && !readFileSync(enc).equals(readFileSync((c(['encrypt', plain, enc + '2']), enc + '2'))),
    `enc=${statSync(enc).size}, gz=${statSync(encGz).size}`);

  const flip = (file, offsetFromEnd, out) => { const b = readFileSync(file); const i = offsetFromEnd < 0 ? b.length + offsetFromEnd : offsetFromEnd; b[i] ^= 0x01; writeFileSync(out, b); return out; };
  const tamperCases = { 'gövde': flip(enc, 1_000_000, path.join(tmp, 't1.enc')), 'etiket (tag)': flip(enc, -3, path.join(tmp, 't2.enc')), 'IV': flip(enc, 6, path.join(tmp, 't3.enc')), 'bayrak (AAD)': flip(enc, 4, path.join(tmp, 't4.enc')) };
  const trunc = path.join(tmp, 't5.enc'); writeFileSync(trunc, readFileSync(enc).subarray(0, 1_000_000));
  const tamperResults = Object.entries({ ...tamperCases, 'kesik dosya': trunc }).map(([k, f]) => {
    const out = path.join(tmp, `out-${k.replace(/\W/g, '')}`);
    const r = c(['decrypt', f, out]); const v = c(['verify', f]);
    return [k, r.status === 1 && v.status === 1 && !existsSync(out) && !existsSync(out + '.part')];
  });
  const wrongKey = c(['decrypt', enc, path.join(tmp, 'wk.out')], { BACKUP_ENCRYPTION_KEY: randomBytes(32).toString('hex') });
  const noKey = sh('node', [CRYPTO, 'encrypt', plain, path.join(tmp, 'nk.enc')], { env: { PATH: process.env.PATH } });
  const badKey = c(['encrypt', plain, path.join(tmp, 'bk.enc')], { BACKUP_ENCRYPTION_KEY: 'kisa' });
  const notEnc = c(['decrypt', plain, path.join(tmp, 'ne.out')]);
  check('Şifreleme (bütünlük): gövde/etiket/IV/bayrak değişimi ve kesik dosya → çözme REDDEDİLİR ve çıktı dosyası BIRAKILMAZ; yanlış anahtar, anahtarsız ve bozuk formatlı anahtar reddedilir; şifreli olmayan dosya reddedilir',
    tamperResults.every(([, ok]) => ok) && wrongKey.status === 1 && !existsSync(path.join(tmp, 'wk.out')) && noKey.status === 1 && /tanımlı değil/.test(noKey.stderr) && badKey.status === 1 && /64 hex/.test(badKey.stderr) && notEnc.status === 1,
    tamperResults.map(([k, ok]) => `${ok ? '✓' : '✗'}${k}`).join(' '));

  // ── 2. Yapılandırma (compose) ──────────────────────────────────────────────
  const cfgOf = (files) => JSON.parse(execFileSync('docker', ['compose', ...files.flatMap((f) => ['-f', f]), 'config', '--format', 'json'], { cwd: ROOT, encoding: 'utf8' }));
  const base = cfgOf(['docker-compose.yml']);
  const withBk = cfgOf(['docker-compose.yml', 'docker-compose.backup.yml']);
  const cmd = withBk.services.postgres.command;
  const opt = (name) => (cmd.find((x) => x.startsWith(`${name}=`)) || '').split('=').slice(1).join('=');
  const cron = readFileSync(path.join(ROOT, 'deploy/cron/yakittakip-backup.cron'), 'utf8');
  const cronLines = cron.split('\n').filter((l) => l.trim() && !l.startsWith('#') && !/^[A-Z_]+=/.test(l.trim()));
  const shipEveryMin = Number((cronLines.find((l) => l.includes('wal-ship.sh')) || '').match(/^\*\/(\d+)/)?.[1] || 999);
  const rpoDesign = Number(opt('archive_timeout')) + shipEveryMin * 60;
  check('Yapılandırma: docker-compose.backup.yml ile WAL arşivi AÇIK (archive_mode=on, wal_level=replica, atomik tmp+mv archive_command, wal_archive volume + sahiplik init servisi); VARSAYILAN yığında ARŞİV YOK (geliştirici diski şişmez); tasarım RPO = archive_timeout + gönderim aralığı ≤ 15 dk',
    opt('archive_mode') === 'on' && opt('wal_level') === 'replica' && /\.tmp/.test(opt('archive_command')) && /mv /.test(opt('archive_command')) && /test ! -f/.test(opt('archive_command')) &&
      withBk.services.postgres.volumes.some((v) => v.target === '/wal_archive') && !!withBk.services['wal-archive-init'] && withBk.services.postgres.depends_on?.['wal-archive-init']?.condition === 'service_completed_successfully' &&
      !(base.services.postgres.command || []).join(' ').includes('archive_mode') && rpoDesign <= 900,
    `archive_timeout=${opt('archive_timeout')}, gönderim=${shipEveryMin} dk, tasarım RPO=${rpoDesign} sn`);

  // ── Kaynak veritabanı (compose'un gerçek postgres tanımından) ────────────────
  const pgc = withBk.services.postgres;
  const envArgs = Object.entries(pgc.environment).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const image = pgc.image;
  const PGU = pgc.environment.POSTGRES_USER || 'postgres'; const PGDB = pgc.environment.POSTGRES_DB || 'yakittakip_db';
  for (const v of [`${P}-pg`, `${P}-wal`]) { docker('volume', 'create', v); created.volumes.push(v); }
  const initCmd = withBk.services['wal-archive-init'].command;
  docker('run', '--rm', '-u', 'root', '-v', `${P}-wal:/wal_archive`, image, ...initCmd);
  const run = docker('run', '-d', '--name', `${P}-src`, '--network', 'none', ...envArgs, '-v', `${P}-pg:/var/lib/postgresql/data`, '-v', `${P}-wal:/wal_archive`, image, ...cmd.slice(1));
  created.containers.push(`${P}-src`);
  if (run.status !== 0) throw new Error(`kaynak konteyner başlatılamadı: ${run.stderr}`);
  for (let i = 0; i < 90; i++) { if (docker('exec', `${P}-src`, 'pg_isready', '-U', PGU, '-d', PGDB).status === 0) { sh('sleep', ['3']); if (docker('exec', `${P}-src`, 'pg_isready', '-U', PGU, '-d', PGDB).status === 0) break; } sh('sleep', ['1']); }
  const feed = (file) => sh('docker', ['exec', '-i', `${P}-src`, 'psql', '-U', PGU, '-d', PGDB, '-X', '-q', '-v', 'ON_ERROR_STOP=1', ...(file.endsWith('schema.sql') ? ['-1'] : [])], { input: readFileSync(path.join(ROOT, 'backend/src/db', file)) });
  const s1 = feed('schema.sql'); const s2 = feed('seed_mock_data.sql');
  if (s1.status !== 0 || s2.status !== 0) throw new Error(`şema/seed uygulanamadı: ${s1.stderr.slice(-300)} ${s2.stderr.slice(-300)}`);
  const q = (sql, container = `${P}-src`, db = PGDB) => docker('exec', container, 'psql', '-U', PGU, '-d', db, '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql).stdout.trim();
  q('CREATE TABLE drill_marker (id text PRIMARY KEY, note text)');
  const usersSrc = Number(q('SELECT count(*) FROM users'));
  const policiesSrc = Number(q('SELECT count(*) FROM pg_policies'));

  // ── 3. Günlük yedek ────────────────────────────────────────────────────────
  const b1 = script('backup.sh');
  const idxDirs = () => (existsSync(path.join(DEST, 'base')) ? readdirSync(path.join(DEST, 'base')).filter((n) => /^\d{8}T\d{6}Z$/.test(n)).sort() : []);
  const firstBk = idxDirs()[0];
  const bkDir = path.join(DEST, 'base', firstBk || 'yok');
  const files = existsSync(bkDir) ? readdirSync(bkDir).sort() : [];
  const allEnc = (function walk(d) { return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])); })(DEST).filter((f) => f.endsWith('.enc'));
  const idx = existsSync(path.join(bkDir, 'index.json')) ? JSON.parse(readFileSync(path.join(bkDir, 'index.json'), 'utf8')) : {};
  const leak = ['CREATE TABLE', 'PGDMP', 'camsa', 'comp-camsa', 'gebze-santiye', 'argon2', 'INSERT INTO', 'users', 'audit_logs'].filter((needle) => [...allEnc, path.join(bkDir, 'index.json')].some((f) => readFileSync(f).includes(Buffer.from(needle))));
  const shaOk = Object.entries(idx.files || {}).every(([f, m]) => execFileSync('sha256sum', [path.join(bkDir, f)], { encoding: 'utf8' }).startsWith(m.sha256));
  check('Yedek (AC — günlük, ŞİFRELİ, ayrı konum): backup.sh çıkış 0; klasörde globals/dump/base/manifest .enc + index.json; hepsi "YKB1" başlıklı AES-GCM; konumda düz metin/dump imzası/kullanıcı adı/tablo adı SIZINTISI YOK (index.json dahil); sha256\'lar tutuyor; WAL segmentleri şifreli; heartbeat ve .last_ok yazıldı',
    b1.status === 0 && ['base.tar.gz.enc', 'dump.custom.enc', 'globals.sql.enc', 'index.json', 'manifest.json.enc'].every((f) => files.includes(f)) &&
      allEnc.length >= 6 && allEnc.every((f) => readFileSync(f).subarray(0, 4).toString() === 'YKB1') && leak.length === 0 && shaOk && idx.encrypted === true && idx.cipher === 'AES-256-GCM' &&
      existsSync(path.join(DEST, 'wal/.heartbeat')) && existsSync(path.join(DEST, 'base/.last_ok')) && readdirSync(path.join(DEST, 'wal')).some((f) => f.endsWith('.enc')),
    `çıkış=${b1.status}, dosyalar=${files.join(',')}, sızıntı=[${leak}], WAL=${readdirSync(path.join(DEST, 'wal')).filter((f) => f.endsWith('.enc')).length}${b1.status !== 0 ? ' ' + b1.stderr.slice(-300) : ''}`);

  // ── 4. dump yolu geri yükleme ──────────────────────────────────────────────
  const r1 = script('restore.sh', ['--mode', 'dump', '--name', `${P}-rd`]);
  created.containers.push(`${P}-rd`); created.volumes.push(`${P}-rd-data`, `${P}-rd-wal`);
  const rd = r1.status === 0 ? lastJson(r1) : null;
  const tools = (a) => sh('node', [path.join(ROOT, 'scripts/lib/backupTools.mjs'), ...a]);
  const statsOf = (container) => sh('bash', ['-c', `source "${ROOT}/scripts/backup/common.sh" && table_stats "${container}" "${PGU}" "${PGDB}"`], { env: env() }).stdout;
  writeFileSync(path.join(tmp, 'src-stats.json'), statsOf(`${P}-src`));
  writeFileSync(path.join(tmp, 'rd-stats.json'), rd ? statsOf(`${P}-rd`) : '{}');
  const maniPlain = path.join(tmp, 'manifest.json'); c(['decrypt', path.join(bkDir, 'manifest.json.enc'), maniPlain]);
  const cmpSrc = tools(['compare', path.join(tmp, 'src-stats.json'), path.join(tmp, 'rd-stats.json'), 'exact']);
  const cmpMani = tools(['compare', maniPlain, path.join(tmp, 'rd-stats.json'), 'exact']);
  const usersRd = rd ? Number(q('SELECT count(*) FROM users', `${P}-rd`)) : -1;
  const policiesRd = rd ? Number(q('SELECT count(*) FROM pg_policies', `${P}-rd`)) : -1;
  const appUser = rd ? q(`SELECT count(*) FROM pg_roles WHERE rolname = 'app_user'`, `${P}-rd`) : '0';
  check('Geri yükleme (dump): temiz konteynere pg_restore — tablo başına satır sayısı + id-md5 hem KAYNAKLA hem yedek MANİFESTİYLE kesin eşit; roller (app_user) ve RLS politikaları geri geldi',
    r1.status === 0 && cmpSrc.status === 0 && cmpMani.status === 0 && usersRd === usersSrc && policiesRd === policiesSrc && policiesSrc > 10 && appUser === '1',
    `tablolar=${cmpSrc.stdout.trim()}, users=${usersRd}/${usersSrc}, politika=${policiesRd}/${policiesSrc}, app_user=${appUser}${r1.status !== 0 ? ' ' + r1.stderr.slice(-300) : ''}`);
  docker('rm', '-f', `${P}-rd`);

  // ── 5. PITR ────────────────────────────────────────────────────────────────
  q(`INSERT INTO drill_marker VALUES ('A', 'hedef zamandan ÖNCE')`);
  sh('sleep', ['2']);
  const T = q(`SELECT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') || '+00'`);
  sh('sleep', ['2']);
  q(`INSERT INTO drill_marker VALUES ('B', 'hedef zamandan SONRA')`);
  q('SELECT pg_switch_wal()'); sh('sleep', ['3']);
  const ship1 = script('wal-ship.sh');
  const restorePitr = (name, args) => { const r = script('restore.sh', ['--mode', 'pitr', '--name', name, ...args]); created.containers.push(name); created.volumes.push(`${name}-data`, `${name}-wal`); return r; };
  const rP = restorePitr(`${P}-rp`, ['--target-time', T]);
  const markersAt = (name) => q(`SELECT coalesce(string_agg(id, ',' ORDER BY id), '') FROM drill_marker`, name);
  const atT = rP.status === 0 ? markersAt(`${P}-rp`) : `HATA:${rP.stderr.slice(-200)}`;
  const inRecovery = rP.status === 0 ? q('SELECT pg_is_in_recovery()', `${P}-rp`) : '?';
  docker('rm', '-f', `${P}-rp`);
  const rL = restorePitr(`${P}-rl`, ['--target-time', 'latest']);
  const atLatest = rL.status === 0 ? markersAt(`${P}-rl`) : 'HATA';
  docker('rm', '-f', `${P}-rl`);
  const early = restorePitr(`${P}-re`, ['--target-time', '2001-01-01 00:00:00+00']);
  const future = restorePitr(`${P}-rf`, ['--target-time', new Date(Date.now() + 3600_000).toISOString().replace('T', ' ').slice(0, 19) + '+00']);
  check('PITR (AC — belirli ana geri dönüş): hedef zamandan ÖNCE yazılan kayıt (A) geri gelir, SONRA yazılan (B) YOKTUR; hedef=latest ikisini de getirir; veritabanı kurtarma sonrası yazılabilir (promote); hedeften önce taban yedek yoksa VE hedef arşivlenmiş WAL\'ın ötesindeyse geri yükleme temiz bir hatayla REDDEDİLİR',
    ship1.status === 0 && rP.status === 0 && atT === 'A' && inRecovery === 'f' && atLatest === 'A,B' && early.status !== 0 && /önce tamamlanmış taban yedek yok/.test(early.stderr) && future.status !== 0 && /kurtarma sırasında durdu|hazır olmadı/.test(future.stderr),
    `T=${T}, hedefte=[${atT}], latest=[${atLatest}], erken=${early.status}, gelecek=${future.status}`);
  docker('rm', '-f', `${P}-rf`);

  // ── 6. Bozulma / kurcalama / yanlış anahtar ─────────────────────────────────
  const walDir = path.join(DEST, 'wal');
  const someWal = readdirSync(walDir).filter((f) => /^[0-9A-F]{24}\.enc$/.test(f)).sort().pop();
  const walPath = path.join(walDir, someWal); const walBackup = readFileSync(walPath);
  const tw = Buffer.from(walBackup); tw[Math.floor(tw.length / 2)] ^= 1; writeFileSync(walPath, tw);
  const rTamperWal = restorePitr(`${P}-rt1`, ['--target-time', 'latest']);
  writeFileSync(walPath, walBackup);
  const baseEnc = path.join(bkDir, 'base.tar.gz.enc'); const baseOrig = readFileSync(baseEnc);
  const tb = Buffer.from(baseOrig); tb[100] ^= 1; writeFileSync(baseEnc, tb);
  const rTamperBase = restorePitr(`${P}-rt2`, ['--target-time', 'latest', '--backup', firstBk]);
  writeFileSync(baseEnc, baseOrig);
  const rWrongKey2 = script('restore.sh', ['--mode', 'dump', '--name', `${P}-rt4`], { BACKUP_ENCRYPTION_KEY: randomBytes(32).toString('hex') }); created.containers.push(`${P}-rt4`);
  const running = docker('ps', '-a', '--format', '{{.Names}} {{.State}}').stdout.split('\n').filter((l) => l.startsWith(`${P}-rt`) && / running$/.test(l));
  const strayVolumes = docker('volume', 'ls', '-q').stdout.split('\n').filter((v) => v.startsWith(`${P}-rt`));
  check('Güvenlik (kurcalama): WAL segmentinde tek bit değişikliği → PITR reddedilir (GCM etiketi); taban yedekte değişiklik → sha256 kontrolü reddeder ("yedek değiştirilmiş"); yanlış anahtarla geri yükleme reddedilir; başarısız geri yüklemede ne çalışan konteyner ne artık volume bırakılır',
    rTamperWal.status !== 0 && /BAŞARISIZ/.test(rTamperWal.stderr) && rTamperBase.status !== 0 && /sha256 uyuşmuyor/.test(rTamperBase.stderr) && rWrongKey2.status !== 0 && /BAŞARISIZ/.test(rWrongKey2.stderr) && running.length === 0 && strayVolumes.length === 0,
    `wal=${rTamperWal.status}, base=${rTamperBase.status}, yanlışAnahtar=${rWrongKey2.status}, çalışan=${running.length}, artık volume=${strayVolumes.length}`);

  // ── 7. WAL göndericisi: dayanıklılık ───────────────────────────────────────
  q(`INSERT INTO drill_marker VALUES ('C', 'gönderici testi')`); q('SELECT pg_switch_wal()'); sh('sleep', ['3']);
  const pending0 = docker('exec', `${P}-src`, 'sh', '-c', 'ls -1 /wal_archive | grep -vc "\\.tmp$"').stdout.trim();
  const isRoot = process.getuid?.() === 0; // root için dizin izni engel olmaz — o ortamda yalnızca düzelme yolu sınanır
  chmodSync(walDir, 0o555);
  const shipFail = script('wal-ship.sh');
  const pendingAfterFail = docker('exec', `${P}-src`, 'sh', '-c', 'ls -1 /wal_archive | grep -vc "\\.tmp$"').stdout.trim();
  chmodSync(walDir, 0o755);
  const shipOk = script('wal-ship.sh'); const shipAgain = script('wal-ship.sh');
  const pendingAfterOk = docker('exec', `${P}-src`, 'sh', '-c', 'ls -1 /wal_archive | grep -vc "\\.tmp$"').stdout.trim();
  check('WAL göndericisi: yedek konumu yazılamazken çıkış 2 ve segmentler volume\'da KALIR (veri kaybı yok); konum düzelince aynı segmentler gönderilir ve volume boşalır; art arda çalıştırma idempotent (0 segment)',
    Number(pending0) >= 1 && (isRoot || (shipFail.status === 2 && Number(pendingAfterFail) >= Number(pending0))) && shipOk.status === 0 && Number(pendingAfterOk) === 0 && shipAgain.status === 0 && /0 segment gönderildi/.test(shipAgain.stderr),
    `bekleyen=${pending0}→${pendingAfterFail}→${pendingAfterOk}, kodlar=${shipFail.status}/${shipOk.status}/${shipAgain.status}`);

  // ── 8. Retansiyon ──────────────────────────────────────────────────────────
  for (const old of ['20200101T000000Z', '20200102T000000Z']) cpSync(bkDir, path.join(DEST, 'base', old), { recursive: true });
  const oldWal = path.join(walDir, '000000010000000000000001.enc'); writeFileSync(oldWal, 'eski'); // başlangıç segmentinden ÖNCE
  const before = idxDirs();
  const b2 = script('backup.sh', [], { BACKUP_RETENTION_DAYS: '1' });
  const afterDirs = idxDirs();
  check('Retansiyon: süresi geçen yedekler silinir (en az 2 yedek HER ZAMAN korunur); en eski korunan yedeğin başlangıç WAL\'ından önceki segmentler silinir, sonrakiler KALIR',
    b2.status === 0 && before.includes('20200101T000000Z') && !afterDirs.includes('20200101T000000Z') && !afterDirs.includes('20200102T000000Z') && afterDirs.length >= 2 && afterDirs.includes(firstBk) &&
      !existsSync(oldWal) && readdirSync(walDir).filter((f) => /^[0-9A-F]{24}\.enc$/.test(f)).length >= 1,
    `önce=${before.length}, sonra=${afterDirs.length}${b2.status !== 0 ? ' ' + b2.stderr.slice(-300) : ''}`);

  // ── 9. Restore tatbikatı ───────────────────────────────────────────────────
  script('wal-ship.sh');
  const report = path.join(tmp, 'tatbikat.md');
  const t0 = Date.now();
  const drill = script('restore-drill.sh', ['--report', report, '--label', 'test']);
  const drillSecs = (Date.now() - t0) / 1000;
  const rep = existsSync(report) ? readFileSync(report, 'utf8') : '';
  const dj = drill.status === 0 ? lastJson(drill) : {};
  const hbFile = path.join(DEST, 'wal/.heartbeat'); const hbOrig = readFileSync(hbFile, 'utf8');
  writeFileSync(hbFile, String(Math.floor(Date.now() / 1000) - 7200)); // WAL gönderimi 2 saattir durmuş
  const drillStale = script('restore-drill.sh', ['--report', path.join(tmp, 'stale.md')]);
  writeFileSync(hbFile, hbOrig);
  const leftovers = docker('ps', '-a', '--format', '{{.Names}}').stdout.split('\n').filter((n) => n.startsWith('yk-restore-'));
  check('Restore tatbikatı (AC — süre ölçülür, dokümante edilir, RPO/RTO karşılanır): iki yol (dump kesin eşitlik + PITR) doğrulanır; rapor süreleri, RTO/RPO tablosunu ve boyut ekstrapolasyonunu içerir; WAL gönderimi 2 saat durmuşsa tatbikat RPO hedefini AŞMIŞ sayıp BAŞARISIZ olur (exit 1); tatbikat sonrası artık konteyner kalmaz',
    drill.status === 0 && dj.result === 'BAŞARILI' && dj.pitrSeconds >= 0 && dj.rtoSeconds <= 14400 && dj.rpoObservedSeconds <= 900 && /Sonuç: BAŞARILI/.test(rep) && /\| RTO \|/.test(rep) && /\| RPO \(gözlenen\) \|/.test(rep) && /Boyut ekstrapolasyonu/.test(rep) && /KESİN eşit/.test(rep) &&
      drillStale.status === 1 && /RPO hedefi karşılanmıyor/.test(drillStale.stderr) && leftovers.length === 0,
    `tatbikat=${dj.result}, dump=${dj.dumpSeconds}s, PITR=${dj.pitrSeconds}s, RPO=${dj.rpoObservedSeconds}s, toplam=${drillSecs.toFixed(0)}s, artık=${leftovers.length}${drill.status !== 0 ? ' ' + drill.stderr.slice(-300) : ''}`);

  // ── 10. Doküman / cron / CI ────────────────────────────────────────────────
  const doc = readFileSync(path.join(ROOT, 'docs/BACKUP_RESTORE.md'), 'utf8').toLowerCase();
  const secrets = readFileSync(path.join(ROOT, 'docs/SECRETS.md'), 'utf8');
  const wf = readFileSync(path.join(ROOT, '.github/workflows/ci-cd.yml'), 'utf8');
  const drills = existsSync(path.join(ROOT, 'docs/restore-drills')) ? readdirSync(path.join(ROOT, 'docs/restore-drills')).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)) : [];
  const schedules = cronLines.map((l) => l.trim().split(/\s+/).slice(0, 5).join(' '));
  check('Doküman/zamanlama: BACKUP_RESTORE.md RPO 15 dk / RTO 4 saat, PITR prosedürü, TimescaleDB notu, nesne depolama bulgusu, anahtar saklama ve çeyreklik tatbikatı kapsar; cron: WAL gönderimi */5, günlük tam yedek, çeyreklik tatbikat; SECRETS.md yedek anahtarını listeler; en az bir gerçek tatbikat raporu commit\'li; CI bu testi çalıştırır',
    ['rpo', '15 dakika', 'rto', '4 saat', 'pitr', 'timescaledb', 'nesne depolama', 'çeyrek', 'anahtar', 'restore-drill.sh', 'wal-ship.sh', 'expand'].every((w) => doc.includes(w)) &&
      schedules.includes('*/5 * * * *') && schedules.some((s) => /^\d+ \d+ \* \* \*$/.test(s)) && schedules.some((s) => /\*\/3|1,4,7,10/.test(s)) &&
      /BACKUP_ENCRYPTION_KEY/.test(secrets) && drills.length >= 1 && /test-ops1106\.mjs/.test(wf),
    `cron=${schedules.join(' | ')}, tatbikat raporları=${drills.join(',')}`);
}

let exitCode = 1;
try {
  await main();
  exitCode = passed === total ? 0 : 1;
} catch (err) {
  console.error('🔥 Test çalıştırılırken beklenmeyen hata:', err);
} finally {
  for (const c of created.containers) docker('rm', '-f', c);
  const leftover = docker('ps', '-a', '--format', '{{.Names}}').stdout.split('\n').filter((n) => n.startsWith(P));
  for (const n of leftover) docker('rm', '-f', n);
  for (const v of created.volumes) docker('volume', 'rm', '-f', v);
  try { chmodSync(path.join(DEST, 'wal'), 0o755); } catch { /* yok */ }
  rmSync(tmp, { recursive: true, force: true });
  console.log(`\nSONUÇ: ${passed}/${total} test geçti.`);
  process.exit(exitCode);
}
