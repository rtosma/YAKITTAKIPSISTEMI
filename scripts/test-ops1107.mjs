#!/usr/bin/env node
// ==============================================================================
// OPS-1107 — gözlemlenebilirlik yığını testleri (sıfır npm bağımlılığı).
//   node scripts/test-ops1107.mjs          statik + yapılandırma doğrulamaları (CI'da çalışır; docker varsa promtool/loki/promtail denetimi de)
//   node scripts/test-ops1107.mjs --live   ÇALIŞAN yığına karşı uçtan uca: gerçek Prometheus/Grafana/Loki'yi ayağa kaldırır (docker compose,
//                                          monitoring override), yük üretir, hedefleri/ifadeleri/etiketleri/kardinaliteyi doğrular, sonra kaldırır.
// ==============================================================================
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, cpSync, chmodSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
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
const yaml = (file) => JSON.parse(execFileSync('python3', ['-c', 'import yaml,json,sys; print(json.dumps(yaml.safe_load(open(sys.argv[1])), default=str))', file], { encoding: 'utf8' }));
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const dockerOk = spawnSync('docker', ['info'], { encoding: 'utf8' }).status === 0;

// ── Backend kayıt defteri (kodda tanımlı metrikler) ─────────────────────────────
const envFile = {};
for (const m of read('backend/.env.example').matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)) envFile[m[1]] = m[2].startsWith('__CHANGE_ME') ? randomBytes(32).toString('hex') : m[2];
const backendEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, ...Object.fromEntries(Object.entries(envFile).filter(([, v]) => v !== '')) });
const tsx = path.join(ROOT, 'backend/node_modules/.bin/tsx');
const dump = spawnSync(tsx, ['-e', `
  import('./src/observability/metrics').then(async (m) => {
    const list = await m.registry.getMetricsAsJSON();
    console.log(JSON.stringify(list.map((x) => ({ name: x.name, type: x.type, labelNames: (m.registry.getSingleMetric(x.name) as any).labelNames || [] }))));
    process.exit(0);
  });`], { cwd: path.join(ROOT, 'backend'), env: backendEnv(), encoding: 'utf8', timeout: 60000 });
let registryDump = [];
try { registryDump = JSON.parse(dump.stdout.trim().split('\n').pop()); } catch { console.error(dump.stderr.slice(-400)); }
const custom = registryDump.filter((m) => m.name.startsWith('yakit_') || m.name.startsWith('http_'));
const allNames = new Set(registryDump.map((m) => m.name));

// ── Dashboard'lar ─────────────────────────────────────────────────────────────
const DASH_DIR = path.join(ROOT, 'deploy/monitoring/grafana/dashboards');
const dashboards = Object.fromEntries(readdirSync(DASH_DIR).filter((f) => f.endsWith('.json')).map((f) => [f, JSON.parse(readFileSync(path.join(DASH_DIR, f), 'utf8'))]));
const exprsOf = (d, type) => d.panels.filter((p) => p.type !== 'row' && (!type || p.datasource.type === type)).flatMap((p) => p.targets.map((t) => ({ title: p.title, expr: t.expr })));
const promExprs = Object.values(dashboards).flatMap((d) => exprsOf(d, 'prometheus'));
const metricRefs = (expr) => [...expr.matchAll(/\b((?:http|yakit|nodejs|process|node|pg|up)[a-zA-Z0-9_:]*)\b/g)].map((m) => m[1].replace(/_(bucket|sum|count)$/, '')).filter((n) => !/^(process_)?$/.test(n));
const EXPORTER = /^(node_|pg_|up$)/;

const gen = spawnSync('node', [path.join(ROOT, 'scripts/monitoring/generate-dashboards.mjs'), '--check'], { encoding: 'utf8' });
const tech = dashboards['yakittakip-technical.json']; const biz = dashboards['yakittakip-business.json'];
const bizRefs = new Set(exprsOf(biz, 'prometheus').flatMap((e) => metricRefs(e.expr)));
const techRefs = new Set(exprsOf(tech).flatMap((e) => metricRefs(e.expr)));
check('Dashboard\'lar: commit\'li JSON generate-dashboards.mjs çıktısıyla AYNI (elle düzenleme/sapma yok); iki AYRI dashboard (teknik + iş) sabit uid/başlıkla; iş dashboard\'unda teknik (http_/nodejs_/process_/node_/pg_) metrik YOK, teknikte iş gauge\'ları (yakit_devices/alarms/despatch) YOK',
  gen.status === 0 && Object.keys(dashboards).length === 2 && tech.uid === 'yakit-technical' && biz.uid === 'yakit-business' && tech.title !== biz.title &&
    [...bizRefs].every((n) => n.startsWith('yakit_') || n === 'time') && ![...techRefs].some((n) => /^yakit_(devices|alarms_open|despatch|dispenses_today|dispensed|notifications)/.test(n)) && tech.editable === false,
  gen.stderr.trim() || `teknik ifade=${exprsOf(tech, 'prometheus').length}, iş ifade=${exprsOf(biz, 'prometheus').length}`);

const unknownRefs = [...new Set(promExprs.flatMap((e) => metricRefs(e.expr)))].filter((n) => !allNames.has(n) && !EXPORTER.test(n));
const usedCustom = new Set(promExprs.flatMap((e) => metricRefs(e.expr)));
const unusedCustom = custom.filter((m) => !usedCustom.has(m.name)).map((m) => m.name);
check('Dashboard ↔ metrik kayıt defteri (AC — tanımlı TÜM metrikler dashboard\'larda görünür): her panel ifadesi kodda tanımlı bir metriğe veya bilinen exporter metriğine (node_/pg_/up) bağlı — bilinmeyen referans YOK; kodda tanımlı her yakit_*/http_* metriği en az bir panelde kullanılıyor',
  registryDump.length > 20 && unknownRefs.length === 0 && unusedCustom.length === 0, `tanımlı özel=${custom.length}, bilinmeyen=[${unknownRefs}], panelsiz=[${unusedCustom}]`);

// ── Kardinalite (statik) ──────────────────────────────────────────────────────
const ALLOWED = new Set(['method', 'route', 'status_class', 'status', 'state', 'kind', 'reason', 'source', 'severity']);
const FORBIDDEN = /device|tenant|user|plate|plaka|^ip$|url|path|trace|email|username|session/i;
const labelOffenders = registryDump.filter((m) => (m.name.startsWith('yakit_') || m.name.startsWith('http_')) && m.labelNames.some((l) => !ALLOWED.has(l) || FORBIDDEN.test(l)));
const metricsSrc = read('backend/src/observability/metrics.ts');
const prom = yaml(path.join(ROOT, 'deploy/monitoring/prometheus.yml'));
const backendJob = prom.scrape_configs.find((j) => j.job_name === 'backend');
check('Kardinalite (AC): özel metriklerin etiket anahtarları yalnızca izinli sabit-küme etiketleri (method/route/status_class/status/state/kind/reason/source/severity); device_id/tenant_id/user_id/plaka/IP/url/trace_id gibi sınırsız etiket YOK; Prometheus backend job\'ında sample_limit + label_limit tavanı; route etiketi ham URL\'den değil eşleşen yol kalıbından',
  labelOffenders.length === 0 && backendJob?.sample_limit > 0 && backendJob.sample_limit <= 50000 && backendJob.label_limit > 0 && /req\.route/.test(metricsSrc) && !/req\.(originalUrl|url|path)\b(?!.*segs)/.test(metricsSrc.split('export function routeLabel')[1].split('export function httpMetricsMiddleware')[0].replace(/req\.originalUrl \|\| ''/g, '')),
  `ihlal=[${labelOffenders.map((m) => m.name)}], sample_limit=${backendJob?.sample_limit}`);

// ── Doküman ───────────────────────────────────────────────────────────────────
const doc = read('docs/OBSERVABILITY.md');
const undocumented = custom.filter((m) => !doc.includes(`\`${m.name}\``)).map((m) => m.name);
check('Doküman (drift koruması): docs/OBSERVABILITY.md kodda tanımlı her yakit_*/http_* metriğini listeler; kardinalite politikası, log sorguları, iki dashboard ve güvenlik (Grafana yalnız 127.0.0.1, METRICS_TOKEN) anlatılır',
  undocumented.length === 0 && ['kardinalite', 'traceId', 'unmatched', 'sample_limit', '127.0.0.1', 'METRICS_TOKEN', 'Teknik Sağlık', 'İş Özeti', 'event loop'].every((w) => doc.toLowerCase().includes(w.toLowerCase())), `belgelenmemiş=[${undocumented}]`);

// ── Prometheus / Loki / Promtail yapılandırmaları ─────────────────────────────
const loki = yaml(path.join(ROOT, 'deploy/monitoring/loki.yml'));
const promtail = yaml(path.join(ROOT, 'deploy/monitoring/promtail.yml'));
const stages = JSON.stringify(promtail.scrape_configs[0].pipeline_stages);
const labelStage = promtail.scrape_configs[0].pipeline_stages[0].match.stages.find((s) => s.labels)?.labels || {};
const smStage = promtail.scrape_configs[0].pipeline_stages[0].match.stages.find((s) => s.structured_metadata)?.structured_metadata || {};
const jobs = prom.scrape_configs.map((j) => j.job_name);
check('Yapılandırma (Prometheus/Loki/Promtail): backend DNS SD ile tüm replikalar + Bearer + /metrics; node/postgres/loki/prometheus hedefleri; Loki retansiyon 14 gün + structured metadata; Promtail YALNIZCA `level` etiketi ekler, traceId/tenantId etiket DEĞİL structured metadata; yalnızca bu compose projesinin konteynerleri',
  !!backendJob.dns_sd_configs && backendJob.authorization?.type === 'Bearer' && backendJob.metrics_path === '/metrics' && ['node', 'postgres', 'loki', 'prometheus'].every((j) => jobs.includes(j)) && parseInt(prom.global.scrape_interval) <= 30 &&
    loki.limits_config.retention_period === '336h' && loki.limits_config.allow_structured_metadata === true && loki.compactor.retention_enabled === true &&
    Object.keys(labelStage).join() === 'level' && 'traceId' in smStage && 'tenantId' in smStage && !/"labels":\{[^}]*(traceId|tenantId)/.test(stages) &&
    /com\.docker\.compose\.project/.test(JSON.stringify(promtail.scrape_configs[0].docker_sd_configs)),
  `jobs=${jobs.join(',')}, promtail etiket=${Object.keys(labelStage)}, structured=${Object.keys(smStage)}`);

if (dockerOk) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ops1107-'));
  cpSync(path.join(ROOT, 'deploy/monitoring'), path.join(tmp, 'monitoring'), { recursive: true });
  spawnSync('chmod', ['-R', 'a+rX', tmp]);
  const run = (image, args, extra = []) => spawnSync('docker', ['run', '--rm', '-v', `${tmp}/monitoring:/cfg:ro`, ...extra, image, ...args], { encoding: 'utf8', timeout: 120000 });
  const emptyTok = path.join(tmp, 'metrics_token'); execFileSync('sh', ['-c', `: > ${emptyTok} && chmod a+r ${emptyTok}`]);
  const pt = run('prom/prometheus:v2.55.1', ['check', 'config', '/cfg/prometheus.yml'], ['--entrypoint', 'promtool', '-v', `${emptyTok}:/tmp/metrics_token:ro`]);
  const lk = run('grafana/loki:3.2.1', ['-config.file=/cfg/loki.yml', '-verify-config']);
  const pl = run('grafana/promtail:3.2.1', ['-config.file=/cfg/promtail.yml', '-config.expand-env=true', '-check-syntax'], ['-e', 'COMPOSE_PROJECT_NAME=x']);
  check('Araç doğrulaması (docker): promtool check config, loki -verify-config, promtail -check-syntax gerçek imajlarla geçer', pt.status === 0 && lk.status === 0 && pl.status === 0,
    `promtool=${pt.status}${pt.status ? ' ' + (pt.stdout + pt.stderr).slice(-200) : ''}, loki=${lk.status}${lk.status ? ' ' + (lk.stdout + lk.stderr).slice(-200) : ''}, promtail=${pl.status}${pl.status ? ' ' + (pl.stdout + pl.stderr).slice(-200) : ''}`);
  rmSync(tmp, { recursive: true, force: true });
} else {
  check('Araç doğrulaması: docker yok — atlandı', true, 'docker erişilemez');
}

// ── Compose (monitoring override) ─────────────────────────────────────────────
const composeCfg = (env = {}) => spawnSync('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.monitoring.yml', 'config', '--format', 'json'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
const noPw = composeCfg({ GRAFANA_ADMIN_PASSWORD: '' });
const withPw = composeCfg({ GRAFANA_ADMIN_PASSWORD: 'x-test-password' });
const cfg = withPw.status === 0 ? JSON.parse(withPw.stdout) : { services: {} };
const svc = cfg.services;
const monitoringServices = ['prometheus', 'grafana', 'loki', 'promtail', 'node-exporter', 'postgres-exporter'];
const published = monitoringServices.flatMap((n) => (svc[n]?.ports || []).map((p) => ({ n, host: p.host_ip, published: p.published })));
check('Compose (güvenlik/işletme): GRAFANA_ADMIN_PASSWORD tanımsızsa yapılandırma REDDEDİLİR (varsayılan parola yok); dışarı açılan tek port Grafana ve yalnızca 127.0.0.1; anonim erişim kapalı; tüm imajlar sürüme SABİTLİ (:latest yok); Prometheus 15 gün/5 GB, Loki volume\'lu; token env\'den Prometheus\'a aktarılır; backend METRICS_TOKEN\'ı alır',
  noPw.status !== 0 && /GRAFANA_ADMIN_PASSWORD/.test(noPw.stderr) && withPw.status === 0 && published.length === 1 && published[0].n === 'grafana' && published[0].host === '127.0.0.1' && String(published[0].published) === '3001' &&
    svc.grafana.environment.GF_AUTH_ANONYMOUS_ENABLED === 'false' && monitoringServices.every((n) => svc[n] && !/:latest$|^[^:]+$/.test(svc[n].image)) &&
    svc.prometheus.command.includes('--storage.tsdb.retention.time=15d') && svc.prometheus.command.includes('--storage.tsdb.retention.size=5GB') && 'METRICS_TOKEN' in svc.prometheus.environment && 'METRICS_TOKEN' in svc.backend.environment &&
    (svc.loki.volumes || []).some((v) => v.target === '/loki') && (svc.promtail.volumes || []).some((v) => v.target === '/var/run/docker.sock' && v.read_only === true),
  `noPw=${noPw.status}, ports=${JSON.stringify(published)}`);

// ── Yapılandırma: METRICS_TOKEN doğrulaması ───────────────────────────────────
const loadCfg = (extra) => spawnSync(tsx, ['-e', "import('./src/config/env').then(()=>console.log('CONFIG_OK'))"], { cwd: path.join(ROOT, 'backend'), env: { ...backendEnv(), ...extra }, encoding: 'utf8', timeout: 60000 });
const tokShort = loadCfg({ METRICS_TOKEN: 'kisa' }); const tokOk = loadCfg({ METRICS_TOKEN: randomBytes(24).toString('hex') }); const tokEmpty = loadCfg({ METRICS_TOKEN: '' }); const tokNone = loadCfg({});
check('Yapılandırma: METRICS_TOKEN < 16 karakter REDDEDİLİR (zayıf token); güçlü token kabul; boş/tanımsız = kapalı (iç ağ modeli) — compose\'un `${VAR:-}` boş geçişi backend\'i düşürmez',
  tokShort.status === 1 && /METRICS_TOKEN/.test(tokShort.stderr) && tokOk.stdout.includes('CONFIG_OK') && tokEmpty.stdout.includes('CONFIG_OK') && tokNone.stdout.includes('CONFIG_OK'),
  `kısa=${tokShort.status}, güçlü=${tokOk.status}, boş=${tokEmpty.status}, yok=${tokNone.status}`);

// ── CANLI uçtan uca ───────────────────────────────────────────────────────────
if (LIVE) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ops1107-live-'));
  cpSync(path.join(ROOT, 'deploy/monitoring'), path.join(tmp, 'monitoring'), { recursive: true });
  spawnSync('chmod', ['-R', 'a+rX', tmp]);
  const sock = process.env.DOCKER_SOCK || (process.env.DOCKER_HOST || '').replace('unix://', '') || '/var/run/docker.sock';
  const GPW = `live-${randomBytes(4).toString('hex')}`;
  const cenv = { ...process.env, MONITORING_DIR: path.join(tmp, 'monitoring'), GRAFANA_ADMIN_PASSWORD: GPW, DOCKER_SOCK: sock };
  const dc = (...a) => spawnSync('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.monitoring.yml', ...a], { cwd: ROOT, encoding: 'utf8', env: cenv, timeout: 300000 });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const inCtr = (ctr, ...cmd) => spawnSync('docker', ['exec', ctr, ...cmd], { encoding: 'utf8', timeout: 60000 });
  const promQ = (expr) => JSON.parse(inCtr('yakittakip_prometheus', 'wget', '-qO-', `http://localhost:9090/api/v1/query?query=${encodeURIComponent(expr)}`).stdout);
  const lokiGet = (p) => JSON.parse(inCtr('yakittakip_loki', 'wget', '-qO-', `http://localhost:3100${p}`).stdout);
  const services = ['prometheus', 'loki', 'promtail', 'grafana', 'postgres-exporter', 'node-exporter'];
  try {
    const up = dc('up', '-d', '--no-deps', ...services);
    if (up.status !== 0) throw new Error(`monitoring yığını başlatılamadı: ${up.stderr.slice(-400)}`);
    // yük: giriş + rapor + dashboard + 404 taraması + izlenebilir istek
    const base = process.env.LIVE_API || 'http://localhost:3000/api/v1';
    const traceId = `ops1107-${randomBytes(4).toString('hex')}`;
    const login = await (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'camsa', password: '123456' }) })).json();
    const auth = { Authorization: `Bearer ${login.accessToken}` };
    for (let i = 0; i < 60; i++) {
      await fetch(`${base}/dashboard/executive`, { headers: auth }); await fetch(`${base}/reports/rep-711?pageSize=5`, { headers: auth });
      await fetch(`${base}/nonexistent-${i}`); await fetch(`${base}/transactions/tx-live-${i}`, { headers: auth });
    }
    await fetch(`${base}/nonexistent-traced`, { headers: { 'X-Trace-ID': traceId } });
    let targets = []; const t0 = Date.now();
    while (Date.now() - t0 < 120_000) { targets = promQ('up').data.result; if (['backend', 'node', 'postgres', 'prometheus', 'loki'].every((j) => targets.some((r) => r.metric.job === j && r.value[1] === '1'))) break; await sleep(3000); }
    await sleep(35_000); // birkaç scrape + iş metriği yenilemesi
    const upJobs = targets.filter((r) => r.value[1] === '1').map((r) => r.metric.job).sort();
    check('CANLI: Prometheus 5 hedefi de kazıyor (backend + node-exporter + postgres-exporter + prometheus + loki: up=1)', ['backend', 'loki', 'node', 'postgres', 'prometheus'].every((j) => upJobs.includes(j)), `up=[${upJobs}]`);

    const bad = []; const empty = [];
    for (const { title, expr } of promExprs) { try { const r = promQ(expr); if (r.status !== 'success') bad.push(title); else if (!r.data.result.length) empty.push(title); } catch { bad.push(title); } }
    const seriesNow = Number(promQ('count({job="backend"})').data.result[0].value[1]);
    check('CANLI (AC — dashboard\'larda görünür): TÜM dashboard PromQL ifadeleri gerçek Prometheus\'ta sözdizimi/çalıştırma hatasız; boş sonuç yalnızca hiç olay olmayan sayaçlarda (5xx, MQTT/ikmal hızı)',
      bad.length === 0 && empty.every((t) => /5xx|MQTT|Reddedilen|İkmal hızı/.test(t)), `ifade=${promExprs.length}, hatalı=[${bad}], boş=[${[...new Set(empty)]}]`);
    check('CANLI (AC — kardinalite): yük sonrası backend seri sayısı < 500 (60 farklı 404 yolu + 60 farklı parametre sonrası); route değerleri yalnızca kalıp/unmatched',
      seriesNow < 500 && promQ('count(count by (route) (http_requests_total))').data.result.length > 0 &&
        promQ('count by (route) (http_requests_total)').data.result.every((r) => r.metric.route === 'unmatched' || r.metric.route.startsWith('/')), `backend seri=${seriesNow}`);

    const labels = lokiGet('/loki/api/v1/labels').data;
    const levels = lokiGet('/loki/api/v1/label/level/values').data;
    const start = Math.floor((Date.now() - 600_000) / 1000);
    const traced = lokiGet(`/loki/api/v1/query_range?query=${encodeURIComponent(`{service="backend"} | traceId="${traceId}"`)}&start=${start}&end=${Math.floor(Date.now() / 1000) + 60}&limit=5`).data.result;
    check('CANLI (AC — loglar merkezi ve aranabilir): Loki etiketleri yalnızca {container, level, service, service_name}; seviyeler sınırlı kümede; X-Trace-ID ile atılan istek `{service="backend"} | traceId="..."` sorgusuyla bulunur (structured metadata); tenantId/traceId ETİKET değil',
      labels.every((l) => ['container', 'level', 'service', 'service_name'].includes(l)) && levels.every((l) => ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(l)) && traced.length >= 1 && !labels.includes('traceId') && !labels.includes('tenantId'),
      `etiketler=[${labels}], seviyeler=[${levels}], izlenen akış=${traced.length}`);

    const gAuth = `admin:${GPW}`;
    const g = (p, auth = true) => spawnSync('curl', ['-s', '-w', '\n%{http_code}', ...(auth ? ['-u', gAuth] : []), `http://127.0.0.1:3001${p}`], { encoding: 'utf8' });
    const search = g('/api/search?query=Yak'); const anon = g('/api/search', false);
    const dsProm = g('/api/datasources/uid/prometheus/health'); const dsLoki = g('/api/datasources/uid/loki/health');
    const found = JSON.parse(search.stdout.split('\n').slice(0, -1).join('\n')).map((d) => d.uid);
    check('CANLI (Grafana): iki dashboard provision edilmiş (yakit-technical, yakit-business); veri kaynakları (Prometheus, Loki) sağlıklı; anonim erişim 401; port yalnızca 127.0.0.1',
      found.includes('yakit-technical') && found.includes('yakit-business') && /"status":"OK"/.test(dsProm.stdout) && /OK|Data source connected/i.test(dsLoki.stdout) && anon.stdout.trim().endsWith('401'), `dashboard=[${found}], prom=${dsProm.stdout.slice(0, 60)}, anon=${anon.stdout.trim().slice(-3)}`);

    const viaNginx = await fetch('http://localhost:3000/metrics'); const nginxText = await viaNginx.text();
    const viaApi = await fetch(`${base}/metrics`);
    check('CANLI (güvenlik): /metrics nginx üzerinden DIŞARI açık DEĞİL (SPA HTML döner, metrik yok); /api/v1/metrics yok (404)', !nginxText.includes('http_requests_total') && /<html/i.test(nginxText) && viaApi.status === 404, `nginx=${viaNginx.status}, api=${viaApi.status}`);
  } finally {
    dc('rm', '-sf', ...services);
    spawnSync('docker', ['volume', 'rm', '-f', ...['prometheus_data', 'loki_data', 'grafana_data'].map((v) => `${process.env.COMPOSE_PROJECT_NAME || 'yakittakipsistemi'}_${v}`)]);
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`\nSONUÇ: ${passed}/${total} test geçti.`);
process.exit(passed === total ? 0 : 1);
