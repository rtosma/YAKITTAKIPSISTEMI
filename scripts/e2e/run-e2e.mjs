#!/usr/bin/env node
// ==============================================================================
// TEST-1001 (#193) — Uçtan uca (E2E) ikmal döngüsü orkestratörü: "Testcontainers" işi, npm bağımlılığı OLMADAN.
//
// KAPSAM UYARLAMASI: ticket vitest + @testcontainers/* + TimescaleDB öneriyor; bu depoda testler tsx betikleridir (vitest yok), şema düz PostgreSQL'dir
// (TimescaleDB/hypertable KULLANILMAZ — schema.sql'de yok; docs/SOZLUK.md "hypertable" notu) ve tüm ortamlar zaten Docker/Compose üzerindedir.
// Testcontainers'ın SAĞLADIĞI şey — her koşuda izole, tek-kullanımlık gerçek bağımlılıklar + bitince kesin temizlik — burada doğrudan docker CLI ile
// yapılır: rastgele son ekli ağ/konteynerler (PostgreSQL 16, Redis 7, EMQX 5 [docker/emqx imajı, üretimle aynı kimlik doğrulama], backend süreci),
// şema + tohum verisi uygulanır, E2E dosyaları PARALEL koşar, her durumda (hata/Ctrl-C dahil) hepsi silinir. Geliştirici tek komut çalıştırır:
//   node scripts/e2e/run-e2e.mjs              (varsayılan: backend/test/e2e/e2e_*.ts hepsi, paralel)
//   node scripts/e2e/run-e2e.mjs --files e2e_fuel_cycle.ts --keep   (--keep: bitince konteynerleri bırak, hata ayıklamak için)
// ZAMAN BÜTÇESİ (AC: "CI'da 10 dakikanın altında"): toplam süre (imaj derleme + kurulum + testler + temizlik) --budget-sec (varsayılan 600) sınırını
// aşarsa koşu BAŞARISIZ sayılır; aşama süreleri tablo olarak yazılır (yavaşlamayı erken gösterir).
// ==============================================================================
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
export const DEFAULT_BUDGET_SEC = 600;
const BUDGET_SEC = Number(opt('--budget-sec', String(DEFAULT_BUDGET_SEC)));
const KEEP = flag('--keep');
// --browser: TEST-1004 — Playwright (3 panel kritik akışı) izole yığında; yalnızca tarayıcı paketi koşar (API E2E dosyaları koşmaz).
const BROWSER = flag('--browser');
const RUN = crypto.randomBytes(3).toString('hex');
const NET = `e2e-net-${RUN}`;
const N = { pg: `e2e-pg-${RUN}`, redis: `e2e-redis-${RUN}`, emqx: `e2e-emqx-${RUN}`, be: `e2e-be-${RUN}`, fe: `e2e-fe-${RUN}` };
const IMG_FRONTEND = 'yakittakip-e2e-frontend';
const IMG_RUNNER = 'yakittakip-e2e-runner';
const IMG_EMQX = 'yakittakip-e2e-emqx';
const rnd = (n = 32) => crypto.randomBytes(n).toString('hex');
const T0 = Date.now();
const stages = [];
const log = (m) => console.log(`[e2e ${((Date.now() - T0) / 1000).toFixed(0).padStart(3)}s] ${m}`);

function sh(cmd, argv, { input, quiet } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, argv, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => resolve({ code: 127, out, err: String(e) }));
    p.on('close', (code) => { if (!quiet && code !== 0) log(`⚠ ${cmd} ${argv.slice(0, 4).join(' ')} → ${code}: ${err.trim().split('\n').slice(-2).join(' | ')}`); resolve({ code, out, err }); });
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
  });
}
async function stage(name, fn) {
  const t = Date.now(); log(`▶ ${name}`);
  const r = await fn(); stages.push([name, (Date.now() - t) / 1000]); return r;
}
const until = async (what, fn, sec) => { const end = Date.now() + sec * 1000; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 1000)); } throw new Error(`zaman aşımı: ${what} (${sec} sn)`); };

let cleaned = false;
async function cleanup() {
  if (cleaned || KEEP) { if (KEEP && !cleaned) log(`--keep: konteynerler bırakıldı (ağ ${NET}); silmek için: docker rm -f ${Object.values(N).join(' ')}; docker network rm ${NET}`); cleaned = true; return; }
  cleaned = true;
  await sh('docker', ['rm', '-f', '-v', ...Object.values(N)], { quiet: true });
  await sh('docker', ['network', 'rm', NET], { quiet: true });
  log('🧹 konteynerler ve ağ silindi');
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await cleanup(); process.exit(130); });

async function main() {
  if ((await sh('docker', ['version', '--format', '{{.Server.Version}}'], { quiet: true })).code !== 0) throw new Error('docker erişilemiyor');
  const testDir = path.join(ROOT, 'backend', 'test', 'e2e');
  const requested = opt('--files', '');
  const files = BROWSER ? [] : (requested ? requested.split(',') : readdirSync(testDir).filter((f) => /^e2e_.*\.ts$/.test(f))).sort();
  if (!BROWSER && files.length === 0) throw new Error('koşulacak E2E dosyası yok');

  // 1) imajlar (paralel; katman önbelleği varsa saniyeler)
  await stage('imajları hazırla (backend/test koşucusu, EMQX)', async () => {
    const [a, b, c] = await Promise.all([
      sh('docker', ['build', '-q', '--target', 'builder', '-t', IMG_RUNNER, 'backend/']),
      sh('docker', ['build', '-q', '-t', IMG_EMQX, 'docker/emqx']),
      BROWSER ? sh('docker', ['build', '-q', '-t', IMG_FRONTEND, 'frontend/']) : Promise.resolve({ code: 0 })
    ]);
    if (a.code || b.code || c.code) throw new Error('imaj derlenemedi');
  });

  // 2) bağımlılıklar
  const mqttUser = `e2e_${RUN}`; const mqttPass = rnd(12); const pgPass = rnd(8);
  await stage('PostgreSQL 16 + Redis 7 + EMQX 5 ayağa kaldır', async () => {
    await sh('docker', ['network', 'create', NET]);
    const runs = await Promise.all([
      sh('docker', ['run', '-d', '--name', N.pg, '--network', NET, '-e', `POSTGRES_PASSWORD=${pgPass}`, '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_DB=yakittakip_db', 'postgres:16-alpine']),
      sh('docker', ['run', '-d', '--name', N.redis, '--network', NET, 'redis:7-alpine']),
      sh('docker', ['run', '-d', '--name', N.emqx, '--network', NET, '-e', `MQTT_USERNAME=${mqttUser}`, '-e', `MQTT_PASSWORD=${mqttPass}`,
        '-e', 'EMQX_AUTHENTICATION__1__MECHANISM=password_based', '-e', 'EMQX_AUTHENTICATION__1__BACKEND=built_in_database', '-e', 'EMQX_AUTHENTICATION__1__USER_ID_TYPE=username',
        '-e', 'EMQX_AUTHENTICATION__1__PASSWORD_HASH_ALGORITHM__NAME=plain', '-e', 'EMQX_AUTHENTICATION__1__BOOTSTRAP_FILE=/opt/emqx/data/authn_bootstrap.csv', '-e', 'EMQX_AUTHENTICATION__1__BOOTSTRAP_TYPE=plain', IMG_EMQX])
    ]);
    if (runs.some((r) => r.code)) throw new Error('bağımlılık konteyneri başlatılamadı');
    await Promise.all([
      until('PostgreSQL', async () => (await sh('docker', ['exec', N.pg, 'pg_isready', '-U', 'postgres', '-d', 'yakittakip_db'], { quiet: true })).code === 0, 60),
      until('Redis', async () => (await sh('docker', ['exec', N.redis, 'redis-cli', 'ping'], { quiet: true })).out.includes('PONG'), 30),
      until('EMQX', async () => (await sh('docker', ['exec', N.emqx, '/opt/emqx/bin/emqx', 'ctl', 'status'], { quiet: true })).code === 0, 90)
    ]);
  });

  // 3) şema + tohum (stdin ile: bind mount gerekmez). Şema İKİ kez: yeni tabloların GRANT'i dosyanın başındaki GRANT'ten sonra gelir (bkz. schema.sql notu).
  await stage('şema (2×) + tohum verisi uygula', async () => {
    const schema = readFileSync(path.join(ROOT, 'backend/src/db/schema.sql'), 'utf8');
    const seed = readFileSync(path.join(ROOT, 'backend/src/db/seed_mock_data.sql'), 'utf8');
    for (const [name, sql] of [['şema #1', schema], ['şema #2', schema], ['tohum', seed]]) {
      const r = await sh('docker', ['exec', '-i', N.pg, 'psql', '-U', 'postgres', '-d', 'yakittakip_db', '-v', 'ON_ERROR_STOP=1', '-q'], { input: sql, quiet: true });
      if (r.code !== 0) throw new Error(`${name} uygulanamadı: ${r.err.trim().split('\n').slice(-3).join(' | ')}`);
    }
  });

  // 4) backend süreci (gerçek MQTT/Redis/Postgres'e bağlı)
  const env = {
    NODE_ENV: 'development', PORT: '5000', POSTGRES_HOST: N.pg, POSTGRES_PORT: '5432', POSTGRES_USER: 'postgres', POSTGRES_PASSWORD: pgPass, POSTGRES_DB: 'yakittakip_db',
    REDIS_HOST: N.redis, REDIS_PORT: '6379', MQTT_URL: `mqtt://${N.emqx}:1883`, MQTT_USERNAME: mqttUser, MQTT_PASSWORD: mqttPass,
    JWT_SECRET: rnd(32), JWT_REFRESH_SECRET: rnd(32), HW_SECRET_ESP32_PUMP_01: rnd(16), HW_SECRET_ESP32_TANK_01: rnd(16), HW_SECRET_ESP32_FLOW_ISR: rnd(16),
    TRANSACTION_HASH_SECRET: rnd(16), HW_SECRET_ENCRYPTION_KEY: rnd(32), TENANT_EXPORT_ENCRYPTION_KEY: rnd(32), NOTIFICATION_CHANNEL_ENCRYPTION_KEY: rnd(32), LORAWAN_WEBHOOK_TOKEN: rnd(16)
  };
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  await stage('backend süreci başlat + sağlık bekle', async () => {
    const r = await sh('docker', ['run', '-d', '--name', N.be, '--network', NET, ...envArgs, IMG_RUNNER, 'npx', 'tsx', 'src/bootstrap.ts']);
    if (r.code) throw new Error('backend başlatılamadı');
    await until('backend /health', async () => (await sh('docker', ['exec', N.be, 'wget', '-q', '-O', '-', 'http://localhost:5000/api/v1/health'], { quiet: true })).out.includes('UP'), 90);
    // /health MQTT aboneliğinden ÖNCE yeşil olabilir: telemetri testleri abonelik kurulmadan yayın yapmasın diye gerçek hazırlık işaretini bekle.
    await until('backend MQTT abonelikleri (data + status + ack)', async () => {
      const l = await sh('docker', ['logs', N.be], { quiet: true });
      const all = l.out + l.err;
      return /Telemetri veri akışı \(data\) dinleniyor/.test(all) && /Cihaz durum akışı \(status\/LWT\) dinleniyor/.test(all);
    }, 60);
  });

  // 5) E2E dosyaları PARALEL
  const results = files.length === 0 ? [] : await stage(`E2E testlerini paralel koş (${files.length} dosya)`, async () => Promise.all(files.map(async (f) => {
    const t = Date.now();
    const r = await sh('docker', ['run', '--rm', '--network', NET, '-v', `${path.join(ROOT, 'backend/test')}:/app/test:ro`,
      '-e', `E2E_API_URL=http://${N.be}:5000/api/v1`, '-e', `E2E_MQTT_URL=mqtt://${N.emqx}:1883`,
      '-e', `POSTGRES_HOST=${N.pg}`, '-e', `POSTGRES_PASSWORD=${pgPass}`, '-e', `REDIS_HOST=${N.redis}`, '-e', `MQTT_USERNAME=${mqttUser}`, '-e', `MQTT_PASSWORD=${mqttPass}`,
      IMG_RUNNER, 'npx', 'tsx', `test/e2e/${f}`], { quiet: true });
    const line = (r.out.match(/SONUÇ: .*/) ?? ['(SONUÇ satırı yok)'])[0];
    return { file: f, code: r.code, secs: (Date.now() - t) / 1000, line, out: r.out, err: r.err };
  })));

  // 5b) TEST-1004: tarayıcı paketi. Frontend (nginx + üretim derlemesi) aynı ağda, backend'e upstream olarak bağlanır; yalnızca 127.0.0.1'de rastgele
  // bir host portu yayınlanır (paralel koşular çakışmaz). Playwright ana makinede koşar (CI'da `npx playwright install --with-deps chromium`).
  let browserRun = null;
  if (BROWSER) {
    browserRun = await stage('frontend (nginx) başlat + Playwright kritik akışları koş', async () => {
      const r = await sh('docker', ['run', '-d', '--name', N.fe, '--network', NET, '-p', '127.0.0.1::80', '--entrypoint', 'sh', IMG_FRONTEND, '-c',
        `echo 'server ${N.be}:5000;' > /etc/nginx/backend_upstream.conf && exec nginx -g 'daemon off;'`]);
      if (r.code) throw new Error('frontend başlatılamadı');
      const port = (await sh('docker', ['port', N.fe, '80'], { quiet: true })).out.trim().split('\n')[0].split(':').pop();
      const base = `http://127.0.0.1:${port}`;
      await until('frontend', async () => (await sh('curl', ['-sf', '-o', '/dev/null', `${base}/`], { quiet: true })).code === 0, 30);
      await until('frontend → backend proxy', async () => (await sh('curl', ['-sf', `${base}/api/v1/health`], { quiet: true })).out.includes('UP'), 30);
      const t = Date.now();
      const pw = await new Promise((resolve) => {
        const p = spawn('npx', ['playwright', 'test', '--config', 'playwright.critical.config.ts', ...(opt('--pw-args', '') ? opt('--pw-args', '').split(' ') : [])], {
          cwd: path.join(ROOT, 'frontend'), stdio: 'inherit',
          env: { ...process.env, CI: process.env.CI ?? '', E2E_BASE_URL: base, E2E_REDIS_CONTAINER: N.redis, E2E_BACKEND_CONTAINER: N.be }
        });
        p.on('close', (code) => resolve(code));
        p.on('error', () => resolve(127));
      });
      return { file: 'playwright (3 panel kritik akışı)', code: pw, secs: (Date.now() - t) / 1000, line: pw === 0 ? 'SONUÇ: tarayıcı akışları geçti' : 'SONUÇ: tarayıcı akışları BAŞARISIZ (bkz. frontend/test-results, frontend/playwright-report)', out: '', err: '' };
    });
    results.push(browserRun);
  }

  for (const r of results) {
    console.log(`\n──────── ${r.file} ────────`);
    console.log(r.out.split('\n').filter((l) => !l.startsWith('{"level"')).join('\n').trim());
    if (r.code !== 0 && r.err.trim()) console.log(r.err.trim().split('\n').slice(-8).join('\n'));
  }
  const failed = results.filter((r) => r.code !== 0);
  if (failed.length > 0) { const be = await sh('docker', ['logs', '--tail', '40', N.be], { quiet: true }); console.log('\n──────── backend günlüğü (son 40 satır) ────────'); console.log((be.out + be.err).split('\n').map((l) => l.slice(0, 220)).join('\n')); }

  // 6) özet + bütçe
  await cleanup();
  const total = (Date.now() - T0) / 1000;
  console.log('\n══════════════ E2E ÖZET ══════════════');
  for (const [n, s] of stages) console.log(`  ${s.toFixed(1).padStart(6)} sn  ${n}`);
  for (const r of results) console.log(`  ${r.secs.toFixed(1).padStart(6)} sn  ${r.code === 0 ? '✅' : '❌'} ${r.file} — ${r.line}`);
  const seq = results.reduce((a, r) => a + r.secs, 0);
  console.log(`  toplam ${total.toFixed(1)} sn (bütçe ${BUDGET_SEC} sn) · testlerin ardışık toplamı ${seq.toFixed(1)} sn → paralel kazanç ${(seq - Math.max(...results.map((r) => r.secs))).toFixed(1)} sn`);
  if (failed.length > 0) { console.log(`\nSONUÇ: ❌ ${failed.length}/${results.length} E2E dosyası başarısız.`); process.exit(1); }
  if (total > BUDGET_SEC) { console.log(`\nSONUÇ: ❌ süre bütçesi aşıldı: ${total.toFixed(0)} sn > ${BUDGET_SEC} sn (AC: CI'da 10 dakikanın altında).`); process.exit(1); }
  console.log(`\nSONUÇ: ✅ ${results.length}/${results.length} E2E dosyası geçti, ${total.toFixed(0)} sn (< ${BUDGET_SEC} sn).`);
}
main().catch(async (e) => { console.error(`\n💥 E2E orkestratörü hatası: ${e.message}`); await cleanup(); process.exit(1); });
