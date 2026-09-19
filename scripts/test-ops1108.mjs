#!/usr/bin/env node
// ==============================================================================
// OPS-1108 — uyarı kuralları, Alertmanager yapılandırması ve runbook testleri (sıfır npm bağımlılığı).
//   node scripts/test-ops1108.mjs          statik + promtool (CI'da; docker varsa)
//   node scripts/test-ops1108.mjs --live   BİLDİRİM ZİNCİRİ TATBİKATI: yalıtılmış geçici Prometheus + Alertmanager + sahte exporter/webhook alıcısı;
//                                          kritik uyarıların HEPSİ yapay olarak tetiklenir, gerçek kurallar/yönlendirme ile alıcıya ulaşması doğrulanır.
// ==============================================================================
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SCENARIOS, BASELINE } from './monitoring/alert-scenarios.mjs';
import { loadRules, render as renderRuleTests } from './monitoring/generate-rule-tests.mjs';
import { renderAlertmanager } from './monitoring/render-alertmanager.mjs';

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
const yamlJson = (file) => JSON.parse(execFileSync('python3', ['-c', 'import yaml,json,sys; print(json.dumps(yaml.safe_load(open(sys.argv[1])), default=str))', file], { encoding: 'utf8' }));
const dockerOk = spawnSync('docker', ['info'], { encoding: 'utf8' }).status === 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rules = loadRules();
const names = [...new Set(rules.map((r) => r.alert))];
const sev = (r) => r.labels.severity;

// ── 1. Kural yapısı (uyarı yorgunluğu + runbook alanları) ─────────────────────────
const bad = [];
for (const r of rules) {
  if (!['critical', 'warning', 'info', 'none'].includes(sev(r))) bad.push(`${r.alert}: geçersiz severity`);
  if (!r.labels.domain) bad.push(`${r.alert}: domain yok`);
  for (const k of ['summary', 'description', 'runbook_url']) if (!r.annotations?.[k]) bad.push(`${r.alert}: ${k} yok`);
  if (r.alert !== 'Watchdog' && !r.for) bad.push(`${r.alert}(${sev(r)}): for yok (anlık dalgalanma sayfalar)`);
  const forMin = r.for ? (/^(\d+)m$/.test(r.for) ? Number(r.for.slice(0, -1)) : /^(\d+)h$/.test(r.for) ? Number(r.for.slice(0, -1)) * 60 : NaN) : 0;
  if (r.for && Number.isNaN(forMin)) bad.push(`${r.alert}: for dakika/saat cinsinden olmalı`);
  if (r.for && r.alert !== 'Watchdog' && forMin < 2) bad.push(`${r.alert}: for ≥ 2m olmalı`);
  if (/ \/ /.test(r.expr) && !/\band\b/.test(r.expr) && !/clamp_min/.test(r.expr) && !r.alert.startsWith('Disk') && !r.alert.startsWith('Host') && !r.alert.startsWith('Postgres')) bad.push(`${r.alert}: oran kuralında asgari trafik/filo koruması (and …) yok`);
}
const critWithWarn = names.filter((n) => rules.some((r) => r.alert === n && sev(r) === 'critical') && rules.some((r) => r.alert === n && sev(r) === 'warning'));
check('Kural yapısı (uyarı yorgunluğu): her kural severity/domain/summary/description/runbook_url taşır; Watchdog dışında hepsinde `for` ≥ 2 dk; oran kuralları asgari trafik/filo korumalı; iki kademeli uyarılarda (warning+critical) aynı alertname kullanılır (bastırma için)',
  bad.length === 0 && names.length >= 30 && critWithWarn.length >= 9, `${names.length} alertname, ${rules.length} kural, iki kademeli=${critWithWarn.length}, sorun=[${bad}]`);

// ── 2. Senaryo ↔ kural kapsamı ────────────────────────────────────────────────
const scNames = new Set(SCENARIOS.map((s) => s.alert));
const uncovered = names.filter((n) => !scNames.has(n));
const stray = [...scNames].filter((n) => !names.includes(n));
const missingFire = []; const missingQuiet = [];
for (const r of rules) {
  const sc = SCENARIOS.find((s) => s.alert === r.alert);
  if (!sc) continue;
  if (!sc.cases.some((c) => c.expect.some((e) => e.severity === sev(r)))) missingFire.push(`${r.alert}/${sev(r)}`);
}
for (const sc of SCENARIOS) if (sc.alert !== 'Watchdog' && !sc.cases.some((c) => c.expect.length === 0)) missingQuiet.push(sc.alert);
check('Test kapsamı (Teknik Not: "hiç tetiklenmemiş kural kanıt değildir"): HER kuralın (alertname × şiddet) ateşleme senaryosu ve HER alertname\'in eşik altı sessiz senaryosu var; kuralsız senaryo/senaryosuz kural yok',
  uncovered.length === 0 && stray.length === 0 && missingFire.length === 0 && missingQuiet.length === 0, `senaryosuz=[${uncovered}], kuralsız=[${stray}], ateşleme yok=[${missingFire}], sessiz yok=[${missingQuiet}]`);

// ── 3. Üretilen promtool testi drift + promtool (docker) ───────────────────────
const testFile = path.join(ROOT, 'deploy/monitoring/tests/alerts.test.yml');
check('Test dosyası: commit\'li alerts.test.yml, kurallar + senaryolardan üretilenle AYNI (elle düzenleme/sapma yok)', existsSync(testFile) && readFileSync(testFile, 'utf8') === renderRuleTests(), '');
let promtoolDetail = 'docker yok — atlandı';
if (dockerOk) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ops1108-'));
  spawnSync('cp', ['-r', path.join(ROOT, 'deploy/monitoring'), path.join(tmp, 'cfg')]);
  spawnSync('chmod', ['-R', 'a+rX', tmp]);
  const promtool = (...a) => spawnSync('docker', ['run', '--rm', '--entrypoint', 'promtool', '-v', `${tmp}/cfg:/cfg:ro`, 'prom/prometheus:v2.55.1', ...a], { encoding: 'utf8', timeout: 240000 });
  const chk = promtool('check', 'rules', ...['api', 'infra', 'field', 'meta'].map((f) => `/cfg/rules/${f}.yml`));
  const unit = promtool('test', 'rules', '/cfg/tests/alerts.test.yml');
  const nTests = (read('deploy/monitoring/tests/alerts.test.yml').match(/^\s+- interval:/gm) || []).length;
  const emptyTok = path.join(tmp, 'tok'); writeFileSync(emptyTok, ''); spawnSync('chmod', ['a+r', emptyTok]);
  const cfgChk = spawnSync('docker', ['run', '--rm', '--entrypoint', 'promtool', '-v', `${tmp}/cfg:/etc/prometheus-src:ro`, '-v', `${tmp}/cfg/rules:/etc/prometheus/rules:ro`, '-v', `${emptyTok}:/tmp/metrics_token:ro`, 'prom/prometheus:v2.55.1', 'check', 'config', '/etc/prometheus-src/prometheus.yml'], { encoding: 'utf8', timeout: 120000 });
  check('promtool: kurallar geçerli (check rules); ' + `${nTests} birim testi GERÇEK \`for\` süreleriyle geçer (ateşleme, sessizlik, asgari trafik/filo korumaları, for dolmadan pending); prometheus.yml (rule_files + alerting) geçerli`,
    chk.status === 0 && unit.status === 0 && cfgChk.status === 0 && nTests >= 80,
    `check=${chk.status}, test=${unit.status}${unit.status ? ' ' + (unit.stdout + unit.stderr).slice(-400) : ''}, config=${cfgChk.status}${cfgChk.status ? ' ' + (cfgChk.stdout + cfgChk.stderr).slice(-300) : ''}`);
  rmSync(tmp, { recursive: true, force: true });
} else {
  check('promtool: docker yok — atlandı', true, promtoolDetail);
}

// ── 4. Runbook'lar ────────────────────────────────────────────────────────────
const SECTIONS = ['Etki', 'Tanı', 'Müdahale', 'Doğrulama', 'Eskalasyon'];
const rbProblems = [];
for (const r of rules) {
  const m = /docs\/runbooks\/([a-z]+\.md)#([a-z0-9]+)$/.exec(r.annotations.runbook_url || '');
  if (!m) { rbProblems.push(`${r.alert}: runbook_url biçimi`); continue; }
  const file = `docs/runbooks/${m[1]}`;
  if (!existsSync(path.join(ROOT, file))) { rbProblems.push(`${r.alert}: ${file} yok`); continue; }
  if (m[2] !== r.alert.toLowerCase()) rbProblems.push(`${r.alert}: çapa ${m[2]} ≠ alertname`);
  const doc = read(file);
  const start = doc.indexOf(`\n## ${r.alert}\n`);
  if (start === -1) { rbProblems.push(`${r.alert}: '## ${r.alert}' başlığı yok`); continue; }
  const rest = doc.slice(start + 1);
  const end = rest.slice(3).search(/\n## /);
  const body = end === -1 ? rest : rest.slice(0, end + 3);
  for (const s of SECTIONS) {
    const sm = new RegExp(`### ${s}\\n([\\s\\S]*?)(?=\\n### |$)`).exec(body);
    if (!sm || sm[1].trim().length < 25) rbProblems.push(`${r.alert}: '${s}' bölümü yok/boş`);
  }
  if (!/`[^`]+`/.test(body)) rbProblems.push(`${r.alert}: somut komut/sorgu yok`);
}
const alertingDoc = read('docs/ALERTING.md');
const undocumented = names.filter((n) => !alertingDoc.includes(n));
check('Runbook\'lar (AC): HER uyarının (31 alertname; tüm şiddetler) runbook_url\'si mevcut dosya + çapaya çıkar; başlıkta beş bölüm (Etki/Tanı/Müdahale/Doğrulama/Eskalasyon) dolu ve somut komut/sorgu içerir; docs/ALERTING.md tüm uyarıları listeler',
  rbProblems.length === 0 && undocumented.length === 0, `sorun=[${rbProblems.slice(0, 6)}], belgelenmemiş=[${undocumented}]`);

// ── 5. Kurallardaki metrikler gerçekten var mı ────────────────────────────────
const dump = spawnSync(path.join(ROOT, 'backend/node_modules/.bin/tsx'), ['-e', `import('./src/observability/metrics').then(async (m) => { console.log(JSON.stringify((await m.registry.getMetricsAsJSON()).map((x) => x.name))); process.exit(0); });`],
  { cwd: path.join(ROOT, 'backend'), env: { PATH: process.env.PATH, HOME: process.env.HOME, ...Object.fromEntries([...read('backend/.env.example').matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((m) => [m[1], m[2].startsWith('__CHANGE_ME') ? randomBytes(32).toString('hex') : m[2]]).filter(([, v]) => v !== '')) }, encoding: 'utf8', timeout: 60000 });
let registryNames = new Set(); try { registryNames = new Set(JSON.parse(dump.stdout.trim().split('\n').pop())); } catch { /* aşağıda fail */ }
const textfile = new Set([...read('scripts/backup/backup.sh').matchAll(/(yakit_[a-z_]+)[{ ]/g), ...read('scripts/backup/wal-ship.sh').matchAll(/(yakit_[a-z_]+)[{ ]/g)].map((m) => m[1]));
const refs = [...new Set(rules.flatMap((r) => [...r.expr.matchAll(/\b((?:http|yakit|nodejs|process|node|pg)[a-zA-Z0-9_]*)\b/g)].map((m) => m[1].replace(/_(bucket|sum|count)$/, '')).filter((n) => n.includes('_'))))];
const unknown = refs.filter((n) => !registryNames.has(n) && !textfile.has(n) && !/^(node_|pg_)/.test(n));
check('Kural ↔ metrik: kurallardaki her yakit_*/http_*/nodejs_*/process_* metriği backend kayıt defterinde veya yedek textfile metriklerinde tanımlı (yazım hatası = sonsuza dek sessiz kural); node_/pg_ exporter metrikleri', registryNames.size > 20 && unknown.length === 0, `başvurulan=${refs.length}, bilinmeyen=[${unknown}]`);

// ── 6. Alertmanager yapılandırması ────────────────────────────────────────────
const FULL = { ALERT_TELEGRAM_BOT_TOKEN: '123456:TOKEN-SECRET-VALUE', ALERT_TELEGRAM_CHAT_ONCALL: '-1001', ALERT_TELEGRAM_CHAT_TEAM: '-1002', ALERT_SMTP_HOST: 'smtp.example.com:587', ALERT_SMTP_FROM: 'alerts@example.com', ALERT_SMTP_USER: 'smtpuser', ALERT_SMTP_PASSWORD: 'SMTP-PASSWORD-SECRET',
  ALERT_EMAIL_ONCALL: 'a@x.com,b@x.com', ALERT_EMAIL_TEAM: 'team@x.com', ALERT_WEBHOOK_URL_ONCALL: 'https://events.example.com/v2/enqueue?key=WEBHOOK-SECRET', ALERT_HEARTBEAT_URL: 'https://hc.example.com/ping/HEARTBEAT-SECRET' };
const full = renderAlertmanager(FULL);
const cfgText = JSON.stringify(full.config);
const rcv = (n) => full.config.receivers.find((r) => r.name === n);
const leaks = ['TOKEN-SECRET-VALUE', 'SMTP-PASSWORD-SECRET', 'WEBHOOK-SECRET', 'HEARTBEAT-SECRET'].filter((s) => cfgText.includes(s));
const routes = full.config.route.routes;
const warnRoute = routes.find((r) => r.matchers.includes('severity="warning"'));
const critRoute = routes.find((r) => r.matchers.includes('severity="critical"'));
check('Alertmanager (kanallar ve sırlar): nöbet alıcısı Telegram + 2 e-posta + webhook, ekip alıcısı Telegram + e-posta, heartbeat webhook; SIRLAR (bot token, SMTP parolası, webhook/heartbeat URL\'leri) yapılandırmaya YAZILMAZ — yalnızca `*_file` referansları ve ayrı sır dosyaları',
  rcv('oncall').telegram_configs.length === 1 && rcv('oncall').email_configs.length === 2 && rcv('oncall').webhook_configs.length === 1 && rcv('team').telegram_configs.length === 1 && rcv('team').email_configs.length === 1 &&
    rcv('heartbeat').webhook_configs.length === 1 && leaks.length === 0 && full.secrets.telegram_bot_token === FULL.ALERT_TELEGRAM_BOT_TOKEN && full.secrets.smtp_password === FULL.ALERT_SMTP_PASSWORD && full.secrets.webhook_heartbeat === FULL.ALERT_HEARTBEAT_URL &&
    /bot_token_file/.test(cfgText) && /url_file/.test(cfgText) && /smtp_auth_password_file/.test(cfgText), `sızıntı=[${leaks}]`);

let failClosed = false; try { renderAlertmanager({}); } catch (e) { failClosed = /on-call|HİÇ bildirim kanalı/i.test(e.message); }
const dev = renderAlertmanager({ ALERT_ALLOW_NO_CHANNELS: 'true' });
const teamFallback = renderAlertmanager({ ALERT_TELEGRAM_BOT_TOKEN: 'x:y', ALERT_TELEGRAM_CHAT_ONCALL: '-5' });
const noHeartbeat = renderAlertmanager({ ALERT_TELEGRAM_BOT_TOKEN: 'x:y', ALERT_TELEGRAM_CHAT_ONCALL: '-5' });
const badChat = (() => { try { renderAlertmanager({ ALERT_TELEGRAM_BOT_TOKEN: 'x:y', ALERT_TELEGRAM_CHAT_ONCALL: 'abc' }); return false; } catch { return true; } })();
const badUrl = (() => { try { renderAlertmanager({ ALERT_WEBHOOK_URL_ONCALL: 'javascript:alert(1)' }); return false; } catch { return true; } })();
check('Alertmanager (fail-closed ve güvenli varsayılanlar): nöbet kanalı HİÇ yoksa yapılandırma ÜRETİLMEZ (kanalsız izleme sessizce hiçbir şey göndermez); yalnızca ALERT_ALLOW_NO_CHANNELS ile geliştirmede geçer; ekip kanalı yoksa warning\'ler nöbet kanalına düşer; kalp atışı tanımsızsa UYARI verilir; geçersiz chat kimliği / webhook şeması reddedilir',
  failClosed && dev.channels.oncall === 0 && teamFallback.channels.team === 1 && teamFallback.warnings.some((w) => /ekip/.test(w)) && noHeartbeat.warnings.some((w) => /HEARTBEAT/.test(w)) && badChat && badUrl, '');

const inhibitText = JSON.stringify(full.config.inhibit_rules);
const nightIv = full.config.time_intervals[0];
check('Alertmanager (gruplama/bastırma/susturma): group_by yalnızca [alertname, severity] (örnek/şantiye başına bildirim YOK); critical→aynı alertname\'in warning\'ini, BackendDown/BackendMissing→API+saha belirtilerini, PostgresDown→DB/API belirtilerini, DiskSpace(critical)→DiskWillFillSoon\'u bastırır; warning gece 23:00-07:00 (Europe/Istanbul) SUSTURULUR, critical asla; info alıcısız; Watchdog heartbeat\'e; nöbet tekrarı 1 sa, ekip 12 sa',
  JSON.stringify(full.config.route.group_by) === '["alertname","severity"]' && /"equal":\["alertname"\]/.test(inhibitText) && /BackendDown/.test(inhibitText) && /BackendMissing/.test(inhibitText) && /PostgresDown/.test(inhibitText) && /DiskWillFillSoon/.test(inhibitText) &&
    warnRoute.mute_time_intervals?.[0] === 'night' && !critRoute.mute_time_intervals && nightIv.time_intervals[0].location === 'Europe/Istanbul' && nightIv.time_intervals[0].times.some((t) => t.start_time === '23:00') &&
    routes.find((r) => r.matchers.includes('severity="info"')).receiver === 'null' && routes.find((r) => r.matchers.includes('alertname="Watchdog"')).receiver === 'heartbeat' && critRoute.repeat_interval === '1h' && warnRoute.repeat_interval === '12h', '');

if (dockerOk) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ops1108-am-'));
  writeFileSync(path.join(tmp, 'alertmanager.yml'), JSON.stringify(full.config, null, 2));
  spawnSync('mkdir', ['-p', path.join(tmp, 'secrets')]);
  for (const [k, v] of Object.entries(full.secrets)) writeFileSync(path.join(tmp, 'secrets', k), v);
  spawnSync('chmod', ['-R', 'a+rX', tmp]);
  // amtool, `*_file` yollarını /etc/alertmanager/secrets altında arar → aynı yola bağla.
  const am = (...a) => spawnSync('docker', ['run', '--rm', '--entrypoint', 'amtool', '-v', `${tmp}:/etc/alertmanager:ro`, 'prom/alertmanager:v0.27.0', ...a], { encoding: 'utf8', timeout: 120000 });
  const chk = am('check-config', '/etc/alertmanager/alertmanager.yml');
  const route = (labels) => am('config', 'routes', 'test', '--config.file=/etc/alertmanager/alertmanager.yml', '--verify.receivers=' + labels.expect, ...labels.args);
  const cases = [
    { expect: 'oncall', args: ['alertname=ApiErrorRate', 'severity=critical'] }, { expect: 'team', args: ['alertname=ApiErrorRate', 'severity=warning'] },
    { expect: 'null', args: ['alertname=CriticalFieldAlarmsOpen', 'severity=info'] }, { expect: 'heartbeat', args: ['alertname=Watchdog', 'severity=none'] },
    { expect: 'oncall', args: ['alertname=WalShippingStalled', 'severity=critical', 'domain=backup'] }
  ].map((c) => [c.args.join(' '), route(c).status === 0]);
  const wrong = am('config', 'routes', 'test', '--config.file=/etc/alertmanager/alertmanager.yml', '--verify.receivers=team', 'alertname=ApiErrorRate', 'severity=critical');
  check('amtool (gerçek Alertmanager): check-config geçer; yönlendirme testi — critical→oncall, warning→team, info→null, Watchdog→heartbeat (yanlış alıcı beklentisi BAŞARISIZ olur)',
    chk.status === 0 && cases.every(([, ok]) => ok) && wrong.status !== 0, `check=${chk.status}${chk.status ? ' ' + (chk.stdout + chk.stderr).slice(-200) : ''}, yönlendirme=${cases.map(([a, ok]) => `${ok ? '✓' : '✗'}${a}`).join(' | ')}`);
  rmSync(tmp, { recursive: true, force: true });
}

// ── 7. Compose / prometheus.yml ───────────────────────────────────────────────
const prom = yamlJson(path.join(ROOT, 'deploy/monitoring/prometheus.yml'));
const cc = spawnSync('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.monitoring.yml', 'config', '--format', 'json'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, GRAFANA_ADMIN_PASSWORD: 'x' } });
const svc = cc.status === 0 ? JSON.parse(cc.stdout).services : {};
check('Compose: Alertmanager yapılandırması init servisiyle üretilir ve tamamlanmadan Alertmanager BAŞLAMAZ (fail-closed); Alertmanager dışarıya port açmaz ve imajı sürüme sabit; Prometheus kurallar dizinini bağlar ve Alertmanager\'a bağlıdır (rule_files + alerting); node-exporter textfile toplayıcısı (yedek metrikleri) açık',
  svc.alertmanager?.depends_on?.['alertmanager-config']?.condition === 'service_completed_successfully' && !(svc.alertmanager?.ports || []).length && /:v\d/.test(svc.alertmanager?.image || '') && svc['alertmanager-config']?.restart === 'no' &&
    svc.prometheus?.volumes?.some((v) => v.target === '/etc/prometheus/rules') && JSON.stringify(prom.rule_files) === '["/etc/prometheus/rules/*.yml"]' && prom.alerting.alertmanagers[0].static_configs[0].targets[0] === 'alertmanager:9093' &&
    svc['node-exporter']?.command?.includes('--collector.textfile.directory=/textfile') && ['ALERT_TELEGRAM_BOT_TOKEN', 'ALERT_HEARTBEAT_URL', 'ALERT_ALLOW_NO_CHANNELS'].every((k) => k in (svc['alertmanager-config']?.environment || {})),
  `compose=${cc.status}`);

// ── 8. Yedek metrikleri (OPS-1106 ↔ uyarılar) ────────────────────────────────
const backupSh = read('scripts/backup/backup.sh'); const walSh = read('scripts/backup/wal-ship.sh'); const common = read('scripts/backup/common.sh');
check('Yedek metrikleri: backup.sh ve wal-ship.sh BACKUP_METRICS_DIR\'e atomik (tmp+mv) textfile metriği yazar (son başarılı zaman damgası yalnızca BAŞARIDA güncellenir → betik durursa değer BAYATLAR = ölü adam anahtarı); BackupTooOld/WalShippingStalled/WalSpoolBacklog kuralları bu metriklere dayanır',
  /write_backup_metrics\(\)/.test(common) && /\.tmp" && mv/.test(common) && /write_backup_metrics yakit_backup_base\.prom/.test(backupSh) && /write_backup_metrics yakit_backup_wal\.prom/.test(walSh) &&
    ['BackupTooOld', 'WalShippingStalled', 'WalSpoolBacklog'].every((n) => rules.some((r) => r.alert === n)) && /kind=\\?"base\\?"/.test(backupSh) && /kind=\\?"wal\\?"/.test(walSh), '');

// ── CANLI: bildirim zinciri tatbikatı ─────────────────────────────────────────
if (LIVE) {
  const RUN = randomBytes(3).toString('hex');
  const P = `ykalert-${RUN}`;
  const net = `${P}-net`;
  const work = mkdtempSync(path.join(tmpdir(), 'ops1108-live-'));
  const ctrs = [];
  const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000, ...opts });
  const docker = (...a) => sh('docker', a);
  const put = (ctr, dest, content) => sh('docker', ['exec', '-i', '-u', 'root', ctr, 'sh', '-c', `mkdir -p "$(dirname '${dest}')" && cat > '${dest}'`], { input: content });
  const drill = (p, method = 'GET', body) => JSON.parse(sh('docker', ['exec', `${P}-drill`, 'wget', '-qO-', ...(method === 'POST' ? ['--post-data', body ?? '{}', '--header', 'Content-Type: application/json'] : []), `http://localhost:8080${p}`]).stdout || 'null');
  const post = (p, body) => sh('docker', ['exec', `${P}-drill`, 'wget', '-qO-', '--post-data', body, '--header', 'Content-Type: application/json', `http://localhost:8080${p}`]);
  const received = () => JSON.parse(sh('docker', ['exec', `${P}-drill`, 'wget', '-qO-', 'http://localhost:8080/received']).stdout || '[]');
  const setScenario = (series) => post('/scenario', JSON.stringify({ series }));
  const alertsIn = (rcv, status = 'firing') => received().filter((r) => r.receiver === rcv && r.payload.status === status).flatMap((r) => r.payload.alerts.filter((a) => a.status === status));
  const waitFor = async (pred, ms = 100_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(2500); } return false; };
  const dedupe = (lists) => { const m = new Map(); for (const [sel, spec] of lists) { if (m.has(sel) && m.get(sel) !== spec) throw new Error(`senaryo çakışması: ${sel} ${m.get(sel)} ≠ ${spec}`); m.set(sel, spec); } return [...m].map(([a, b]) => [a, b]); };

  // Kurallar: GERÇEK ifadeler; yalnızca `for` saniyelere indirilir (birim testleri gerçek süreleri doğrular).
  const fastRules = JSON.stringify({ groups: [{ name: 'drill', rules: rules.map((r) => ({ alert: r.alert, expr: r.expr, ...(r.for ? { for: '10s' } : {}), labels: r.labels, annotations: r.annotations })) }] });
  const promCfg = (extraBackendTargets = []) => JSON.stringify({
    global: { scrape_interval: '2s', evaluation_interval: '2s' }, rule_files: ['/etc/prometheus/rules/*.yml'],
    alerting: { alertmanagers: [{ static_configs: [{ targets: ['alertmanager:9093'] }] }] },
    scrape_configs: [{ job_name: 'backend', metrics_path: '/metrics', static_configs: [{ targets: ['drill:8080', ...extraBackendTargets] }] }]
  });
  const am = renderAlertmanager({ ALERT_WEBHOOK_URL_ONCALL: 'http://drill:8080/hook/oncall', ALERT_WEBHOOK_URL_TEAM: 'http://drill:8080/hook/team', ALERT_HEARTBEAT_URL: 'http://drill:8080/hook/heartbeat', ALERT_TIMING: 'fast' });

  try {
    docker('network', 'create', net);
    const start = (name, image, args, waitFile) => { const r = docker('run', '-d', '--name', `${P}-${name}`, '--network', net, '--network-alias', name, '-u', 'root', '--entrypoint', 'sh', image, '-c', args); ctrs.push(`${P}-${name}`); if (r.status !== 0) throw new Error(`${name} başlatılamadı: ${r.stderr}`); return waitFile; };
    const PROM_CMD = 'while [ ! -f /etc/prometheus/ready ]; do sleep 0.2; done; exec /bin/prometheus --config.file=/etc/prometheus/prometheus.yml --storage.tsdb.path=/tmp/prom --web.enable-lifecycle';
    // Her tatbikat fazı TEMİZ bir Prometheus (boş TSDB) ile başlar: rate() geçmiş penceresi (5 dk) önceki fazın serilerini taşımasın.
    let promN = 0;
    const startProm = (extraTargets = []) => {
      const name = `prometheus${++promN}`;
      start(name, 'prom/prometheus:v2.55.1', PROM_CMD);
      put(`${P}-${name}`, '/etc/prometheus/rules/drill.yml', fastRules);
      put(`${P}-${name}`, '/etc/prometheus/prometheus.yml', promCfg(extraTargets));
      put(`${P}-${name}`, '/etc/prometheus/ready', '1');
      return `${P}-${name}`;
    };
    start('drill', 'node:20-alpine', 'while [ ! -f /drill.mjs ]; do sleep 0.2; done; exec node /drill.mjs');
    start('alertmanager', 'prom/alertmanager:v0.27.0', 'while [ ! -f /etc/alertmanager/ready ]; do sleep 0.2; done; exec /bin/alertmanager --config.file=/etc/alertmanager/alertmanager.yml --storage.path=/tmp/am --cluster.listen-address=');
    put(`${P}-drill`, '/drill.mjs', readFileSync(path.join(ROOT, 'scripts/monitoring/drill-server.mjs')));
    put(`${P}-alertmanager`, '/etc/alertmanager/alertmanager.yml', JSON.stringify(am.config));
    for (const [k, v] of Object.entries(am.secrets)) put(`${P}-alertmanager`, `/etc/alertmanager/secrets/${k}`, v);
    put(`${P}-alertmanager`, '/etc/alertmanager/ready', '1');
    let promCtr = startProm();
    await sleep(6000);

    // — Taban çizgisi: sağlıklı → yalnızca Watchdog kalp atışı; hiçbir nöbet/ekip bildirimi (yalancı pozitif yok) —
    setScenario(dedupe(BASELINE));
    const heartbeatOk = await waitFor(() => alertsIn('heartbeat').some((a) => a.labels.alertname === 'Watchdog'), 60_000);
    await sleep(25_000);
    const quietBase = received().filter((r) => r.receiver !== 'heartbeat');
    check('TATBİKAT — taban çizgisi: sağlıklı sistemde Watchdog kalp atışı heartbeat alıcısına akar; nöbet (oncall) ve ekip (team) alıcılarına HİÇBİR bildirim gitmez (yalancı pozitif yok)', heartbeatOk && quietBase.length === 0, `heartbeat=${heartbeatOk}, beklenmeyen=${quietBase.map((r) => r.payload.alerts?.map((a) => a.labels.alertname)).flat()}`);

    // — Faz A: kritik (ve warning/info) uyarıların HEPSİ yapay tetiklenir (TEMİZ Prometheus: rate() geçmişi taban çizgisinden bağımsız) —
    docker('rm', '-f', promCtr);
    promCtr = startProm();
    setScenario([]); // sahte exporter'ın seri durumunu sıfırla: temiz Prometheus'ta TÜM sayaçlar 'ilk örnek düşük → 5 dk'lık atlama' düzeniyle başlasın
    await sleep(6000);
    const liveScenarios = SCENARIOS.filter((s) => s.cases.some((c) => c.live !== false && c.expect.length) && !['PostgresDown', 'Watchdog', 'DiskWillFillSoon', 'BackupMetricsMissing'].includes(s.alert));
    const pick = (s) => { const withExpect = s.cases.filter((c) => c.live !== false && c.expect.length); return withExpect.find((c) => c.expect.some((e) => e.severity === 'critical')) || withExpect[0]; };
    const chosen = liveScenarios.map((s) => ({ alert: s.alert, case: pick(s) }));
    const extraDisks = [['/data'], ['/var']].flatMap(([mp]) => [[`node_filesystem_avail_bytes{mountpoint="${mp}",fstype="ext4"}`, '3+0x60'], [`node_filesystem_size_bytes{mountpoint="${mp}",fstype="ext4"}`, '100+0x60']]);
    const fireSeries = dedupe([...BASELINE.filter(([sel]) => !chosen.some((c) => c.case.series.some(([s2]) => s2 === sel))), ...chosen.flatMap((c) => c.case.series), ...extraDisks]);
    setScenario(fireSeries);
    const wantCritical = chosen.filter((c) => c.case.expect.some((e) => e.severity === 'critical')).map((c) => c.alert);
    const wantWarnOnly = chosen.filter((c) => !c.case.expect.some((e) => e.severity === 'critical') && c.case.expect.some((e) => e.severity === 'warning')).map((c) => c.alert);
    const wantInfo = chosen.filter((c) => c.case.expect.every((e) => e.severity === 'info')).map((c) => c.alert);
    const gotCrit = () => new Set(alertsIn('oncall').map((a) => a.labels.alertname));
    await waitFor(() => wantCritical.every((n) => gotCrit().has(n)) && wantWarnOnly.every((n) => alertsIn('team').some((a) => a.labels.alertname === n)));
    const promDebug = (q) => { const r = sh('docker', ['exec', promCtr, 'wget', '-qO-', `http://localhost:9090/api/v1/query?query=${encodeURIComponent(q)}`]).stdout; try { return JSON.stringify(JSON.parse(r).data.result.map((x) => [x.metric.le ?? x.metric, Number(x.value[1]).toFixed(2)])); } catch { return r.slice(0, 200); } };
    if (process.env.DRILL_DEBUG) console.log('DEBUG ALERTS:', promDebug('ALERTS{alertname=~"ApiLatencyP95|ApiErrorRate"}'), '\nDEBUG p95:', promDebug('histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))'), '\nDEBUG traffic:', promDebug('sum(rate(http_requests_total[5m]))'), '\nDEBUG buckets:', promDebug('rate(http_request_duration_seconds_bucket[5m])'));
    const oncallAlerts = alertsIn('oncall'); const teamAlerts = alertsIn('team');
    const missingCrit = wantCritical.filter((n) => !gotCrit().has(n));
    const critShapeBad = oncallAlerts.filter((a) => a.labels.severity !== 'critical' || !/docs\/runbooks\/[a-z]+\.md#/.test(a.annotations.runbook_url || '') || !a.annotations.summary).map((a) => a.labels.alertname);
    check(`TATBİKAT (AC — kritik uyarılar tetiklenip bildirim zinciri doğrulanır): ${wantCritical.length} kritik uyarının HEPSİ (${wantCritical.join(', ')}) yapay tetiklenir → Prometheus (gerçek kurallar) → Alertmanager (gerçek yönlendirme) → nöbet alıcısına ulaşır; her bildirim severity=critical + özet + runbook_url taşır`,
      missingCrit.length === 0 && critShapeBad.length === 0, `eksik=[${missingCrit}], biçim hatalı=[${critShapeBad}], ulaşan=${[...gotCrit()].length}`);

    const warnMissing = wantWarnOnly.filter((n) => !teamAlerts.some((a) => a.labels.alertname === n));
    const leakedWarn = teamAlerts.filter((a) => wantCritical.includes(a.labels.alertname)).map((a) => a.labels.alertname);
    const infoLeak = [...oncallAlerts, ...teamAlerts].filter((a) => wantInfo.includes(a.labels.alertname)).map((a) => a.labels.alertname);
    check('TATBİKAT (yönlendirme + yorgunluk): yalnızca-warning uyarılar ekip (team) alıcısına gider; critical de ateşleyen alertname\'lerin warning\'i BASTIRILIR (tek olay iki bildirim yok); info seviyesi hiçbir alıcıya gitmez; nöbet alıcısına warning sızmaz',
      warnMissing.length === 0 && leakedWarn.length === 0 && infoLeak.length === 0 && oncallAlerts.every((a) => a.labels.severity === 'critical'), `warning eksik=[${warnMissing}], sızan warning=[${[...new Set(leakedWarn)]}], info sızıntısı=[${infoLeak}]`);

    const diskNotif = received().filter((r) => r.receiver === 'oncall' && r.payload.status === 'firing' && r.payload.alerts.some((a) => a.labels.alertname === 'DiskSpace'));
    const diskGroups = diskNotif.map((r) => r.payload.alerts.filter((a) => a.labels.alertname === 'DiskSpace').length);
    check('TATBİKAT (gruplama): 3 disk bölümü (/, /data, /var) aynı anda kritik → Alertmanager TEK bildirimde 3 uyarıyı gruplar (bölüm başına ayrı bildirim/sayfalama yok)',
      diskGroups.length >= 1 && Math.max(...diskGroups) === 3 && diskGroups.filter((n) => n === 1).length === 0, `DiskSpace bildirimleri (uyarı sayısı)=[${diskGroups}]`);

    // — Çözülme: taban çizgisine dönünce "resolved" —
    // Çözülme: gauge'lar sağlıklıya döner; fire senaryosunda FARKLI hızla üretilen SAYAÇ serileri kesilir (bayatlar → rate() boşalır; aksi halde 5 dk'lık pencere eski hızı taşırdı).
    const isCounterSpec = (spec) => /^-?[\d.]+\+[\d.]+x\d+$/.test(spec) && !/^-?[\d.]+\+0x/.test(spec);
    const changedCounters = new Set(fireSeries.filter(([sel, spec]) => isCounterSpec(spec) && BASELINE.some(([bs, bspec]) => bs === sel && bspec !== spec)).map(([sel]) => sel));
    setScenario(dedupe(BASELINE.filter(([sel]) => !changedCounters.has(sel))));
    // rate()[5m] tabanlı uyarılar (hata oranı, gecikme) gerçek dünyada da pencere (5 dk) boşalana kadar çözülmez — bu bir hata değil Prometheus semantiğidir;
    // tatbikat süresini uzatmamak için çözülme doğrulaması ANLIK (gauge/oran) tabanlı kritiklerle yapılır.
    const RATE_WINDOW = ['ApiErrorRate', 'ApiLatencyP95']; // gitleaks:allow — uyarı adları (generic-api-key yanlış pozitifi)
    const resolvable = wantCritical.filter((n) => !RATE_WINDOW.includes(n));
    const resolvedOk = await waitFor(() => resolvable.every((n) => alertsIn('oncall', 'resolved').some((a) => a.labels.alertname === n)), 80_000);
    if (process.env.DRILL_DEBUG && !resolvedOk) console.log('DEBUG res ALERTS:', promDebug('ALERTS{alertname="ApiErrorRate"}'), '\nDEBUG 5xx:', promDebug('http_requests_total{status=~"5.."}'), '\nDEBUG ratio:', promDebug('sum(rate(http_requests_total{status=~"5.."}[5m]))'), '\nDEBUG received:', JSON.stringify(received().filter((r) => r.payload.alerts?.some((a) => a.labels.alertname === 'ApiErrorRate')).map((r) => [r.receiver, r.payload.status, r.payload.alerts.map((a) => a.labels.severity + ':' + a.status)])));
    check('TATBİKAT (çözülme): sistem sağlıklıya dönünce anlık-değer tabanlı tüm kritik uyarılar için "resolved" bildirimi nöbet alıcısına gelir (nöbetçi olayın bittiğini görür; rate()[5m] tabanlı hata-oranı/gecikme uyarıları pencere boşalınca çözülür)', resolvedOk, `çözülmeyen=[${resolvable.filter((n) => !alertsIn('oncall', 'resolved').some((a) => a.labels.alertname === n))}]`);

    // — Faz B: kök neden bastırma —
    post('/reset', '{}');
    const inhibSeries = dedupe([...BASELINE.filter(([sel]) => !['pg_up', 'yakit_db_pool_connections{state="waiting"}', 'http_requests_total{status="200",route="/x"}'].includes(sel) && !sel.startsWith('http_request_duration')),
      ['pg_up', '0+0x60'], ['yakit_db_pool_connections{state="waiting"}', '8+0x60'], ...SCENARIOS.find((s) => s.alert === 'ApiErrorRate').cases[1].series]);
    setScenario(inhibSeries);
    await waitFor(() => alertsIn('oncall').some((a) => a.labels.alertname === 'PostgresDown'), 80_000);
    await sleep(20_000);
    const inhibited = ['DbPoolSaturated', 'ApiErrorRate'].filter((n) => alertsIn('oncall').some((a) => a.labels.alertname === n));
    check('TATBİKAT (kök neden bastırma): PostgresDown (kök neden) nöbet alıcısına gider; aynı anda ateşleyen belirti uyarıları (DbPoolSaturated, ApiErrorRate) BASTIRILIR — nöbetçi tek anlamlı bildirim alır', alertsIn('oncall').some((a) => a.labels.alertname === 'PostgresDown') && inhibited.length === 0, `bastırılamayan=[${inhibited}]`);

    setScenario(dedupe(BASELINE)); await sleep(20_000);
    post('/reset', '{}');
    put(promCtr, '/etc/prometheus/prometheus.yml', promCfg(['dead-backend:5000']));
    sh('docker', ['exec', promCtr, 'wget', '-qO-', '--post-data', '', 'http://localhost:9090/-/reload']);
    const downOk = await waitFor(() => alertsIn('oncall').some((a) => a.labels.alertname === 'BackendDown'), 80_000);
    // BackendDown ATEŞLİYORKEN saha belirtisi (çevrimdışı cihaz oranı %60, critical) yeni ateşlenir → bastırılmalı.
    setScenario(dedupe([...BASELINE.filter(([sel]) => !sel.startsWith('yakit_devices')), ['yakit_devices{state="offline"}', '6+0x60'], ['yakit_devices{state="registered"}', '10+0x60'], ['yakit_devices{state="active"}', '3+0x60']]));
    await sleep(35_000);
    const symptom = alertsIn('oncall').filter((a) => a.labels.alertname === 'DevicesOfflineRatio').length;
    check('TATBİKAT (uptime + bastırma): backend hedefi düşünce BackendDown (critical, uptime) nöbet alıcısına gider; aynı anda ateşleyen saha belirtisi DevicesOfflineRatio (critical) BASTIRILIR', downOk && symptom === 0, `BackendDown=${downOk}, bastırılamayan saha belirtisi=${symptom}`);
  } finally {
    for (const c of ctrs) docker('rm', '-f', c);
    docker('network', 'rm', net);
    rmSync(work, { recursive: true, force: true });
  }
}

console.log(`\nSONUÇ: ${passed}/${total} test geçti.`);
process.exit(passed === total ? 0 : 1);
