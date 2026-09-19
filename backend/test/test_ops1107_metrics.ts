import { Client } from 'pg';
import http from 'http';
import express from 'express';
import mqtt from 'mqtt';
import { resetLoginRateLimit } from './helpers/loginRateLimit';
import { registry, metricsHandler, refreshBusinessMetrics, recordDispenseCompleted, normalizeMethod, statusClass } from '../src/observability/metrics';
import { getBusinessMetricsSnapshot } from '../src/db/adminDb';

/**
 * OPS-1107 (#184) — Prometheus metrikleri: GERÇEK çalışan backend'in /metrics çıktısı + arka plan iş metriği yenileyicisi +
 * kardinalite kontrolü. Prometheus/Grafana/Loki yığını scripts/test-ops1107.mjs'in (--live) konusudur.
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';
const ROOT_URL = API_URL.replace(/\/api\/v1$/, '');
const RUN = Date.now();
const TENANT = 'comp-camsa';
const GEBZE = 'Gebze Ana Şantiye';
// CI'daki backend işi gerçek bir EMQX'e bağlanmaz (MQTT_URL=__CI_SKIP__): MQTT_URL_TEST tanımsızsa MQTT adımları atlanır (yerelde/compose'ta tanımlanır).
const MQTT_URL = process.env.MQTT_URL_TEST || '';
const FORBIDDEN_LABELS = ['device_id', 'deviceid', 'tenant_id', 'tenantid', 'user_id', 'userid', 'plate', 'vehicle_plate', 'ip', 'url', 'path', 'trace_id', 'traceid', 'username', 'email'];
const ALLOWED_LABELS = new Set(['method', 'route', 'status_class', 'status', 'state', 'kind', 'reason', 'source', 'severity', 'le', 'service', 'quantile', 'gc_type', 'kind_gc', 'type', 'space', 'version', 'major', 'minor', 'patch', 'name']);

function pg(): Client {
  return new Client({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database: process.env.POSTGRES_DB || 'yakittakip_db'
  });
}
async function q(sql: string, params: any[] = []): Promise<any[]> {
  const c = pg();
  await c.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}
async function scrape(): Promise<{ status: number; ct: string; text: string }> {
  const res = await fetch(`${ROOT_URL}/metrics`);
  return { status: res.status, ct: res.headers.get('content-type') || '', text: await res.text() };
}
interface Sample { name: string; labels: Record<string, string>; value: number }
function parse(text: string): Sample[] {
  const out: Sample[] = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)/.exec(line);
    if (!m) continue;
    const labels: Record<string, string> = {};
    for (const lm of (m[2] || '').matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) labels[lm[1]] = lm[2];
    out.push({ name: m[1], labels, value: Number(m[3]) });
  }
  return out;
}
const val = (s: Sample[], name: string, want: Record<string, string> = {}): number =>
  s.filter((x) => x.name === name && Object.entries(want).every(([k, v]) => x.labels[k] === v)).reduce((a, x) => a + x.value, 0);
async function call(method: string, p: string, token?: string, body?: any): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API_URL}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function login(username: string): Promise<string> {
  await resetLoginRateLimit();
  const r = await call('POST', '/auth/login', undefined, { username, password: '123456' });
  return r.body.accessToken;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run() {
  console.log('===========================================================');
  console.log('📈 [OPS-1107] PROMETHEUS METRİKLERİ TESTİ');
  console.log('===========================================================\n');
  let passed = 0;
  let total = 0;
  const check = (name: string, condition: boolean, detail: string) => {
    total++;
    console.log(`${condition ? '✅ [PASS]' : '❌ [FAIL]'} ${name}\n   ${detail}\n`);
    if (condition) passed++;
  };

  const owner = await login('camsa');
  const ids = { alarms: [] as string[], tx: [] as string[], desp: [] as string[], notif: [] as string[], ev: [] as string[], tank: `tank-o1107-${RUN}` };
  const PLATE = `34 OPS ${String(RUN).slice(-4)}`;

  try {
    // === Test 1: /metrics biçimi + tanımlı tüm metrikler ===
    const s0 = await scrape();
    const parsed0 = parse(s0.text);
    const names = new Set(parsed0.map((x) => x.name.replace(/_(bucket|sum|count)$/, '')));
    const defined = (await registry.getMetricsAsJSON()).map((m) => m.name).filter((n) => n.startsWith('yakit_') || n.startsWith('http_'));
    const runtime = ['nodejs_eventloop_lag_seconds', 'nodejs_eventloop_lag_p99_seconds', 'process_resident_memory_bytes', 'process_cpu_seconds_total', 'nodejs_heap_size_used_bytes'];
    check(
      'Test 1 (AC — tanımlı tüm metrikler toplanır): /metrics 200 + Prometheus içerik türü (text/plain; version=0.0.4); çalışma zamanı metrikleri (event loop lag p99, RSS, CPU, heap) var; kodda tanımlı TÜM yakit_*/http_* metrikleri canlı çıktıda yer alır',
      s0.status === 200 && /text\/plain.*version=0\.0\.4/.test(s0.ct) && runtime.every((r) => names.has(r)) && defined.length >= 14 && defined.every((d) => names.has(d) || parsed0.some((x) => x.name.startsWith(d))),
      `status=${s0.status}, ct=${s0.ct}, tanımlı=${defined.length}, eksik=${defined.filter((d) => !names.has(d) && !parsed0.some((x) => x.name.startsWith(d))).join(',')}`
    );

    // === Test 2: HTTP metrikleri ===
    const before = parse((await scrape()).text);
    for (let i = 0; i < 5; i++) await call('GET', '/health');
    for (let i = 0; i < 3; i++) await call('GET', '/reports'); // tokensiz → 401
    for (let i = 0; i < 2; i++) await call('GET', `/reports/rep-711?pageSize=1`, owner);
    const after = parse((await scrape()).text);
    const d = (name: string, w: Record<string, string>) => val(after, name, w) - val(before, name, w);
    check(
      'Test 2 (AC — HTTP süreleri): /health 5, /reports 401 3, /reports/:reportId 200 2 istek → http_requests_total route KALIBIYLA (ham URL değil) ve histogram sayımı aynı artışı gösterir; in-flight gauge var',
      d('http_requests_total', { route: '/api/v1/health', status: '200' }) >= 5 && d('http_requests_total', { route: '/api/v1/reports', status: '401' }) === 3 &&
        d('http_requests_total', { route: '/api/v1/reports/:reportId', status: '200' }) === 2 && d('http_request_duration_seconds_count', { route: '/api/v1/reports/:reportId', status_class: '2xx' }) === 2 &&
        d('http_request_duration_seconds_count', { route: '/api/v1/reports', status_class: '4xx' }) === 3 && after.some((x) => x.name === 'http_requests_in_flight'),
      `health=${d('http_requests_total', { route: '/api/v1/health', status: '200' })}, reports401=${d('http_requests_total', { route: '/api/v1/reports', status: '401' })}, param=${d('http_requests_total', { route: '/api/v1/reports/:reportId', status: '200' })}`
    );

    // === Test 3: kardinalite ===
    const flood = async (tag: string) => {
      for (let i = 0; i < 150; i++) await call('GET', `/nonexistent-${RUN}-${tag}-${i}`);                     // tarama/404 yolları
      for (let i = 0; i < 100; i++) await call('GET', `/reports/rep-random-${RUN}-${tag}-${i}`, owner);       // parametre değerleri
      await call('DELETE', `/dispense/${RUN}${tag}`); await call('PATCH', '/x');                              // farklı fiiller
    };
    await flood('a'); // yeni (method,route,sınıf) kombinasyonları BİR KEZ seri açar (kod tabanındaki route sayısıyla sınırlı)
    const parsedA = parse((await scrape()).text);
    const seriesA = parsedA.filter((x) => x.name.startsWith('http_')).length;
    await flood('b'); // 250 YENİ farklı URL/parametre değeri
    const parsed3 = parse((await scrape()).text);
    const seriesB = parsed3.filter((x) => x.name.startsWith('http_')).length;
    const routeValues = new Set(parsed3.map((x) => x.labels.route).filter(Boolean));
    const labelKeys = new Set(parsed3.flatMap((x) => Object.keys(x.labels)));
    const forbidden = [...labelKeys].filter((k) => FORBIDDEN_LABELS.includes(k.toLowerCase()));
    const unknown = [...labelKeys].filter((k) => !ALLOWED_LABELS.has(k));
    check(
      'Test 3 (AC — kardinalite kontrolü): 250 farklı 404 yolu/parametre değeri (1. dalga) yeni kombinasyonları açar; ikinci dalgada 250 TAMAMEN YENİ URL sonrası http_* seri sayısı DEĞİŞMEZ (Δ=0 — seri sayısı URL sayısıyla değil route/fiil/sınıf kombinasyonuyla sınırlı); route değerleri /api/v1... kalıbı, "unmatched" veya "/metrics"; yasaklı etiket (device_id, tenant_id, user_id, plaka, IP, ham url/yol) YOK; bilinmeyen etiket anahtarı yok; toplam seri < 2000',
      seriesB === seriesA && [...routeValues].every((r) => r === 'unmatched' || r === '/metrics' || r.startsWith('/api/v1')) && !routeValues.has(`/api/v1/reports/rep-random-${RUN}-b-1`) &&
        forbidden.length === 0 && unknown.length === 0 && parsed3.length < 2000 && normalizeMethod('PROPFIND') === 'OTHER' && statusClass(503) === '5xx',
      `http seri: ${seriesA}→${seriesB}, route değerleri=[${[...routeValues]}], yasaklı=[${forbidden}], bilinmeyen=[${unknown}], toplam=${parsed3.length}`
    );

    // === Test 4: iş metrikleri — DB fixture'ı → snapshot ve ARKA PLAN yenileyicisi (canlı backend) ===
    const snap0 = await getBusinessMetricsSnapshot();
    // Taban: canlı gauge'ların DB gerçeğine oturması beklenir (önceki koşunun fixture'ı temizlenmiş ama gauge 30 sn'ye kadar bayat olabilir).
    let live0 = parse((await scrape()).text);
    const settle0 = Date.now();
    while (Date.now() - settle0 < 45_000 && (val(live0, 'yakit_alarms_open', { severity: 'CRITICAL' }) !== (snap0.alarmsOpen.CRITICAL ?? 0) || val(live0, 'yakit_despatch_queue', { status: 'QUEUED' }) !== (snap0.despatchQueue.QUEUED ?? 0) || val(live0, 'yakit_devices', { state: 'offline' }) !== snap0.devices.offline)) {
      await sleep(2000);
      live0 = parse((await scrape()).text);
    }
    const ins = async (sql: string, p: any[]) => q(sql, p);
    for (const [tag, sev, st] of [['c1', 'CRITICAL', 'OPEN'], ['c2', 'CRITICAL', 'RESOLVED'], ['w1', 'WARNING', 'ACKNOWLEDGED']] as const) {
      const id = `alarm-o1107-${RUN}-${tag}`; ids.alarms.push(id);
      await ins(`INSERT INTO alarms (id, tenant_id, alarm_key, category, severity, title, site_name, subject_type, subject_id, status, event_count, first_seen_at, last_seen_at) VALUES ($1,$2,$3,'OTHER',$4,$5,$6,'TANK',$7,$8,1,NOW(),NOW())`, [id, TENANT, `O1107:${tag}:${RUN}`, sev, `O1107-${tag}`, GEBZE, `subj-${tag}-${RUN}`, st]);
    }
    const tank = ids.tank;
    await ins(`INSERT INTO tanks (id, tenant_id, name, capacity_liters, current_level_liters, fuel_type, site_name) VALUES ($1,$2,$3,10000,5000,'Motorin',$4)`, [tank, TENANT, `O1107 Tank ${RUN}`, GEBZE]);
    for (const [tag, st, ageMin] of [['q', 'QUEUED', 90], ['f', 'FAILED', 5]] as const) {
      const id = `dtx-o1107-${RUN}-${tag}`; ids.desp.push(id);
      const txId = `tx-o1107-${RUN}-d${tag}`; ids.tx.push(txId);
      await ins(`INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, amount_liters, created_at) VALUES ($1,$2,$3,$4,5,NOW())`, [txId, TENANT, GEBZE, `O1107-${tag}`]);
      await ins(`INSERT INTO despatch_advice_transmissions (id, tenant_id, despatch_advice_document_id, transaction_id, document_number, ettn, vehicle_plate, provider, status, xml_snapshot, queued_at) VALUES ($1,$2,$3,$4,$5,gen_random_uuid(),$6,'MOCK_GIB',$7,'<x/>', NOW() - ($8 || ' minutes')::interval)`, [id, TENANT, `dad-o1107-${RUN}-${tag}`, txId, `IRS2099${String(RUN).slice(-9)}${tag}`.slice(0, 32), `O1107-${tag}`, st, String(ageMin)]);
    }
    const nid = `notif-o1107-${RUN}`; ids.notif.push(nid);
    const uid = (await q(`SELECT id FROM users WHERE username = 'camsa'`))[0].id;
    await ins(`INSERT INTO notifications (id, tenant_id, user_id, channel, status, attempts, event_type, title, body) VALUES ($1,$2,$3,'EMAIL','BAŞARISIZ',3,'TEST','o1107','o1107')`, [nid, TENANT, uid]).catch(async () => {
      // şema farklıysa (zorunlu kolon adları) fixture'ı atla — retry kuyruğu farkı doğrulanmaz
      ids.notif.pop();
    });
    for (const [dev, st, ago] of [[`O1107-DEV-${RUN}`, 'OFFLINE', 5]] as const) {
      const id = `dpe-o1107-${RUN}`; ids.ev.push(id);
      await ins(`INSERT INTO device_presence_events (id, tenant_id, device_id, site_name, status, occurred_at) VALUES ($1,$2,$3,$4,$5, NOW() - ($6 || ' minutes')::interval)`, [id, TENANT, dev, GEBZE, st, String(ago)]);
    }
    const snap1 = await getBusinessMetricsSnapshot();
    // canlı backend'in ARKA PLAN yenileyicisi (30 sn) yeni değerleri /metrics'e yansıtmalı
    let live1 = live0; const t0 = Date.now();
    while (Date.now() - t0 < 45_000) {
      live1 = parse((await scrape()).text);
      if (val(live1, 'yakit_alarms_open', { severity: 'CRITICAL' }) === val(live0, 'yakit_alarms_open', { severity: 'CRITICAL' }) + 1) break;
      await sleep(2000);
    }
    const dl = (name: string, w: Record<string, string> = {}) => val(live1, name, w) - val(live0, name, w);
    await refreshBusinessMetrics(); // süreç-içi kayıt defteri (test sürecindeki) snapshot ile birebir
    const inproc = (await registry.getMetricsAsJSON()).find((m) => m.name === 'yakit_alarms_open') as any;
    const inprocCrit = inproc?.values?.find((v: any) => v.labels.severity === 'CRITICAL')?.value;
    check(
      'Test 4 (AC — iş metrikleri): fixture (1 açık CRITICAL + 1 çözülmüş + 1 WARNING, e-İrsaliye QUEUED 90 dk + FAILED, çevrimdışı cihaz) → snapshot farkları doğru (RESOLVED sayılmaz); çalışan backend\'in arka plan yenileyicisi ≤ 45 sn içinde /metrics\'e yansıtır (CRITICAL +1, WARNING +1, QUEUED +1, FAILED +1, offline +1); en eski QUEUED yaşı ≥ 5400 sn; tazelik zaman damgası taze; süreç-içi refresh aynı değeri verir',
      snap1.alarmsOpen.CRITICAL - (snap0.alarmsOpen.CRITICAL ?? 0) === 1 && snap1.alarmsOpen.WARNING - (snap0.alarmsOpen.WARNING ?? 0) === 1 &&
        snap1.despatchQueue.QUEUED - (snap0.despatchQueue.QUEUED ?? 0) === 1 && snap1.despatchQueue.FAILED - (snap0.despatchQueue.FAILED ?? 0) === 1 && snap1.devices.offline - snap0.devices.offline === 1 &&
        dl('yakit_alarms_open', { severity: 'CRITICAL' }) === 1 && dl('yakit_alarms_open', { severity: 'WARNING' }) === 1 && dl('yakit_despatch_queue', { status: 'QUEUED' }) === 1 &&
        dl('yakit_despatch_queue', { status: 'FAILED' }) === 1 && dl('yakit_devices', { state: 'offline' }) === 1 && val(live1, 'yakit_despatch_oldest_queued_age_seconds') >= 5400 &&
        Date.now() / 1000 - val(live1, 'yakit_business_metrics_last_refresh_timestamp_seconds') < 90 && inprocCrit === snap1.alarmsOpen.CRITICAL,
      `Δsnapshot crit=${snap1.alarmsOpen.CRITICAL - (snap0.alarmsOpen.CRITICAL ?? 0)}, Δcanlı crit=${dl('yakit_alarms_open', { severity: 'CRITICAL' })}, queued=${dl('yakit_despatch_queue', { status: 'QUEUED' })}, offline=${dl('yakit_devices', { state: 'offline' })}, oldest=${val(live1, 'yakit_despatch_oldest_queued_age_seconds')}s, süre=${Date.now() - t0}ms`
    );

    // === Test 5: ikmal ve MQTT sayaçları (GERÇEK olaylarla) ===
    await q(`INSERT INTO tanks (id, tenant_id, name, capacity_liters, current_level_liters, fuel_type, site_name) VALUES ($1,$2,$3,10000,5000,'Motorin',$4) ON CONFLICT DO NOTHING`, [`${tank}-d`, TENANT, `O1107 Dispense Tank ${RUN}`, GEBZE]);
    ids.tank = tank;
    const dispBefore = parse((await scrape()).text);
    const disp = await call('POST', '/dispense', owner, { siteName: GEBZE, vehiclePlate: PLATE, amountLiters: 10, tankName: `O1107 Dispense Tank ${RUN}` });
    if (MQTT_URL) {
      const publisher = mqtt.connect(MQTT_URL, { username: process.env.MQTT_USERNAME || '', password: process.env.MQTT_PASSWORD || '', protocolVersion: 5 });
      await new Promise<void>((resolve, reject) => { publisher.once('connect', () => resolve()); publisher.once('error', reject); });
      for (let i = 0; i < 3; i++) publisher.publish(`telemetry/v1/${TENANT}/site1/pump/UNKNOWN-O1107-${RUN}-${i}/data`, JSON.stringify({ t: 1 }), { qos: 1 });
      publisher.publish(`telemetry/v1/${TENANT}/site1/pump/UNKNOWN-O1107-${RUN}-s/status`, JSON.stringify({ s: 'ONLINE' }), { qos: 1 });
      await sleep(2500); publisher.end(true);
    }
    const mAfter = parse((await scrape()).text);
    const dm = (name: string, w: Record<string, string>) => val(mAfter, name, w) - val(dispBefore, name, w);
    recordDispenseCompleted('offline_sync', 0); // 0 adet sayaç artırmaz
    check(
      'Test 5 (AC — ikmal ve MQTT hızı): gerçek POST /dispense → yakit_dispense_completed_total{source=api} +1; 3 data + 1 status MQTT mesajı (kayıtsız cihaz) → yakit_mqtt_messages_total telemetry_data +3, telemetry_status +1 ve yakit_mqtt_rejected_total{unregistered_device} +4; cihaz kimliği ETİKET olmadı; 0 adetlik kayıt sayacı artırmaz; sıfır-başlatılmış seriler (device/offline_sync/other) baştan var',
      disp.status === 200 && dm('yakit_dispense_completed_total', { source: 'api' }) === 1 && dm('yakit_dispense_completed_total', { source: 'offline_sync' }) === 0 &&
        (!MQTT_URL || (dm('yakit_mqtt_messages_total', { kind: 'telemetry_data' }) === 3 && dm('yakit_mqtt_messages_total', { kind: 'telemetry_status' }) === 1 && dm('yakit_mqtt_rejected_total', { reason: 'unregistered_device' }) === 4)) &&
        !mAfter.some((x) => JSON.stringify(x.labels).includes('UNKNOWN-O1107')) &&
        ['device', 'offline_sync'].every((s) => mAfter.some((x) => x.name === 'yakit_dispense_completed_total' && x.labels.source === s)) && mAfter.some((x) => x.name === 'yakit_mqtt_messages_total' && x.labels.kind === 'other'),
      `dispense=${disp.status}/${JSON.stringify(disp.body).slice(0, 80)}, api+${dm('yakit_dispense_completed_total', { source: 'api' })}, data+${dm('yakit_mqtt_messages_total', { kind: 'telemetry_data' })}, status+${dm('yakit_mqtt_messages_total', { kind: 'telemetry_status' })}, red+${dm('yakit_mqtt_rejected_total', { reason: 'unregistered_device' })}${MQTT_URL ? '' : ' (MQTT adımları atlandı: MQTT_URL_TEST yok)'}`
    );

    // === Test 6: DB havuzu gauge'ı ===
    const poolS = parse((await scrape()).text);
    check(
      'Test 6 (altyapı — DB bağlantıları): yakit_db_pool_connections total/idle/waiting üç durumla var; total ≥ 1 ve idle ≤ total; waiting = 0 (havuz doygun değil)',
      ['total', 'idle', 'waiting'].every((st) => poolS.some((x) => x.name === 'yakit_db_pool_connections' && x.labels.state === st)) && val(poolS, 'yakit_db_pool_connections', { state: 'total' }) >= 1 &&
        val(poolS, 'yakit_db_pool_connections', { state: 'idle' }) <= val(poolS, 'yakit_db_pool_connections', { state: 'total' }) && val(poolS, 'yakit_db_pool_connections', { state: 'waiting' }) === 0,
      `total=${val(poolS, 'yakit_db_pool_connections', { state: 'total' })}, idle=${val(poolS, 'yakit_db_pool_connections', { state: 'idle' })}, waiting=${val(poolS, 'yakit_db_pool_connections', { state: 'waiting' })}`
    );

    // === Test 7: METRICS_TOKEN (süreç-içi Express) ===
    const app = express();
    app.get('/metrics', metricsHandler('test-token-0123456789'));
    app.get('/open', metricsHandler(undefined));
    const srv = http.createServer(app);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(srv.address() as any).port}`;
    const noAuth = await fetch(`${base}/metrics`); const wrong = await fetch(`${base}/metrics`, { headers: { Authorization: 'Bearer wrong-token-0123456789' } });
    const short = await fetch(`${base}/metrics`, { headers: { Authorization: 'Bearer x' } }); const basic = await fetch(`${base}/metrics`, { headers: { Authorization: 'Basic dGVzdA==' } });
    const good = await fetch(`${base}/metrics`, { headers: { Authorization: 'Bearer test-token-0123456789' } }); const open = await fetch(`${base}/open`);
    const goodText = await good.text(); const noAuthText = await noAuth.text();
    srv.close();
    check(
      'Test 7 (güvenlik — /metrics token): METRICS_TOKEN tanımlıyken tokensiz/yanlış/kısa/Basic şema → 401 (gövdede metrik YOK); doğru Bearer → 200 + metrikler; token tanımsızken uç açık (iç ağ modeli)',
      noAuth.status === 401 && wrong.status === 401 && short.status === 401 && basic.status === 401 && good.status === 200 && goodText.includes('http_requests_total') && !noAuthText.includes('http_requests_total') && open.status === 200,
      `noAuth=${noAuth.status}, wrong=${wrong.status}, short=${short.status}, basic=${basic.status}, good=${good.status}, open=${open.status}`
    );
  } finally {
    await q('DELETE FROM despatch_advice_transmissions WHERE id = ANY($1)', [ids.desp]);
    await q('DELETE FROM notifications WHERE id = ANY($1)', [ids.notif]);
    await q('DELETE FROM alarms WHERE id = ANY($1)', [ids.alarms]);
    await q('DELETE FROM device_presence_events WHERE id = ANY($1)', [ids.ev]);
    await q('DELETE FROM transactions WHERE id = ANY($1) OR vehicle_plate = $2', [ids.tx, PLATE]);
    await q('DELETE FROM tanks WHERE id = ANY($1)', [[ids.tank, `${ids.tank}-d`]]);
    await resetLoginRateLimit();
    console.log('🧹 Test fixture verisi temizlendi.\n');
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => {
  console.error('🔥 Test çalıştırılırken beklenmeyen hata:', err);
  process.exit(1);
});
