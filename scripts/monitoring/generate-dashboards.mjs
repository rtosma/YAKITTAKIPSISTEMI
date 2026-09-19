#!/usr/bin/env node
// ==============================================================================
// OPS-1107 — Grafana dashboard'larını ÜRETİR (tek doğruluk kaynağı bu dosya; çıktı deploy/monitoring/grafana/dashboards/ altına
// commit'lenir, scripts/test-ops1107.mjs commit'li JSON ile üretimin AYNI olduğunu doğrular — elle düzenlenip sapma olmasın).
//
// İKİ AYRI dashboard (Teknik Not: "İş metrikleri teknik metriklerden ayrı dashboard'da olmalı; yönetici event loop lag'ine bakmaz"):
//   yakit-technical : HTTP/çalışma zamanı/DB/MQTT/altyapı + loglar  (operasyon/geliştirici)
//   yakit-business  : cihaz, alarm, ikmal, e-İrsaliye kuyruğu       (yönetici)
// Kullanım: node scripts/monitoring/generate-dashboards.mjs [--check]   (--check: commit'li dosyalarla farkı raporlar, exit 1)
// ==============================================================================
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../deploy/monitoring/grafana/dashboards');
const PROM = { type: 'prometheus', uid: 'prometheus' };
const LOKI = { type: 'loki', uid: 'loki' };

let nextId = 1;
const grid = (x, y, w, h) => ({ x, y, w, h });
const targets = (exprs, ds) => exprs.map((e, i) => ({ refId: String.fromCharCode(65 + i), datasource: ds, expr: e.expr ?? e, legendFormat: e.legend ?? '__auto', ...(ds.type === 'loki' ? { queryType: 'range' } : {}) }));

const row = (title, y) => ({ id: nextId++, type: 'row', title, collapsed: false, gridPos: grid(0, y, 24, 1), panels: [] });
const timeseries = (title, exprs, pos, { unit = 'short', description = '', ds = PROM, stack = false, min } = {}) => ({
  id: nextId++, type: 'timeseries', title, description, datasource: ds, gridPos: pos, targets: targets(exprs, ds),
  fieldConfig: { defaults: { unit, ...(min !== undefined ? { min } : {}), custom: { lineWidth: 1, fillOpacity: stack ? 30 : 8, stacking: { mode: stack ? 'normal' : 'none' } } }, overrides: [] },
  options: { legend: { displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'multi' } }
});
const stat = (title, expr, pos, { unit = 'short', description = '', thresholds, decimals } = {}) => ({
  id: nextId++, type: 'stat', title, description, datasource: PROM, gridPos: pos, targets: targets([expr], PROM),
  fieldConfig: { defaults: { unit, ...(decimals !== undefined ? { decimals } : {}), thresholds: { mode: 'absolute', steps: thresholds ?? [{ color: 'green', value: null }] }, color: { mode: 'thresholds' } }, overrides: [] },
  options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, colorMode: 'background', graphMode: 'area', textMode: 'auto' }
});
const logs = (title, expr, pos) => ({ id: nextId++, type: 'logs', title, datasource: LOKI, gridPos: pos, targets: targets([expr], LOKI), options: { showTime: true, wrapLogMessage: true, sortOrder: 'Descending', enableLogDetails: true } });
const dashboard = (uid, title, description, panels, templating = []) => ({
  uid, title, description, tags: ['yakittakip', uid === 'yakit-business' ? 'is' : 'teknik'], timezone: 'browser', schemaVersion: 39, version: 1, editable: false,
  refresh: '30s', time: { from: 'now-6h', to: 'now' }, templating: { list: templating }, annotations: { list: [] }, panels
});
const red = (v) => [{ color: 'green', value: null }, { color: 'red', value: v }];
const amber = (a, r) => [{ color: 'green', value: null }, { color: 'orange', value: a }, { color: 'red', value: r }];

// ── Teknik ────────────────────────────────────────────────────────────────────
nextId = 1;
const technical = [];
let y = 0;
technical.push(row('Genel sağlık', y++));
technical.push(stat('Backend hedefleri ayakta (min up)', 'min(up{job="backend"})', grid(0, y, 6, 4), { thresholds: [{ color: 'red', value: null }, { color: 'green', value: 1 }], description: '1 = tüm backend replikaları kazınıyor; 0 = en az biri erişilemiyor.' }));
technical.push(stat('5xx oranı (5 dk)', '(sum(rate(http_requests_total{status=~"5.."}[5m])) or vector(0)) / clamp_min(sum(rate(http_requests_total[5m])), 1e-9)', grid(6, y, 6, 4), { unit: 'percentunit', decimals: 2, thresholds: amber(0.01, 0.05) }));
technical.push(stat('İstek / sn', 'sum(rate(http_requests_total[1m]))', grid(12, y, 6, 4), { decimals: 2 }));
technical.push(stat('İşlenen istek (anlık)', 'sum(http_requests_in_flight)', grid(18, y, 6, 4), { thresholds: amber(50, 200) }));
y += 4;
technical.push(row('HTTP', y++));
technical.push(timeseries('İstek hızı (durum sınıfı)', [{ expr: 'sum by (status_class) (rate(http_request_duration_seconds_count[1m]))', legend: '{{status_class}}' }], grid(0, y, 12, 8), { unit: 'reqps', stack: true }));
technical.push(timeseries('Gecikme p50 / p95 / p99', [
  { expr: 'histogram_quantile(0.50, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))', legend: 'p50' },
  { expr: 'histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))', legend: 'p95' },
  { expr: 'histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))', legend: 'p99' }
], grid(12, y, 12, 8), { unit: 's' }));
y += 8;
technical.push(timeseries('En yavaş 10 route (p95)', [{ expr: 'topk(10, histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket[5m]))))', legend: '{{route}}' }], grid(0, y, 12, 8), { unit: 's', description: 'route = eşleşen Express yol kalıbı (ham URL değil).' }));
technical.push(timeseries('5xx (route, ilk 10)', [{ expr: 'topk(10, sum by (route) (rate(http_requests_total{status=~"5.."}[5m])))', legend: '{{route}}' }], grid(12, y, 12, 8), { unit: 'reqps' }));
y += 8;
technical.push(row('Çalışma zamanı (Node.js)', y++));
technical.push(timeseries('Event loop gecikmesi', [
  { expr: 'nodejs_eventloop_lag_p99_seconds', legend: 'p99' }, { expr: 'nodejs_eventloop_lag_mean_seconds', legend: 'ortalama' }
], grid(0, y, 8, 8), { unit: 's', description: 'Sürekli yüksek p99 = event loop blokajı (CPU-yoğun iş / senkron çağrı).' }));
technical.push(timeseries('Bellek', [{ expr: 'process_resident_memory_bytes', legend: 'RSS' }, { expr: 'nodejs_heap_size_used_bytes', legend: 'heap kullanılan' }], grid(8, y, 8, 8), { unit: 'bytes' }));
technical.push(timeseries('Süreç CPU', [{ expr: 'rate(process_cpu_seconds_total[1m])', legend: '{{instance}}' }], grid(16, y, 8, 8), { unit: 'percentunit' }));
y += 8;
technical.push(row('Veritabanı', y++));
technical.push(timeseries('Uygulama bağlantı havuzu', [{ expr: 'yakit_db_pool_connections', legend: '{{state}}' }], grid(0, y, 8, 8), { description: 'waiting > 0 sürekli = havuz doygun (max 10).' }));
technical.push(timeseries('PostgreSQL bağlantıları (durum)', [{ expr: 'sum by (state) (pg_stat_activity_count)', legend: '{{state}}' }, { expr: 'max(pg_settings_max_connections)', legend: 'max_connections' }], grid(8, y, 8, 8), { stack: false }));
technical.push(timeseries('Veritabanı boyutu / işlem hızı', [
  { expr: 'sum(pg_database_size_bytes{datname!~"template.*|postgres"})', legend: 'boyut' }
], grid(16, y, 8, 8), { unit: 'bytes' }));
y += 8;
technical.push(row('MQTT', y++));
technical.push(timeseries('MQTT mesaj hızı (tür)', [{ expr: 'sum by (kind) (rate(yakit_mqtt_messages_total[1m]))', legend: '{{kind}}' }], grid(0, y, 12, 8), { unit: 'ops', stack: true }));
technical.push(timeseries('Reddedilen / hata', [{ expr: 'sum by (reason) (rate(yakit_mqtt_rejected_total[5m]))', legend: 'red: {{reason}}' }, { expr: 'rate(yakit_mqtt_processing_errors_total[5m])', legend: 'işleme hatası' }], grid(12, y, 12, 8), { unit: 'ops' }));
y += 8;
technical.push(row('Altyapı (host)', y++));
technical.push(timeseries('CPU kullanımı', [{ expr: '100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)', legend: 'CPU %' }], grid(0, y, 6, 8), { unit: 'percent', min: 0 }));
technical.push(timeseries('Bellek kullanımı', [{ expr: '1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)', legend: 'bellek' }], grid(6, y, 6, 8), { unit: 'percentunit', min: 0 }));
technical.push(timeseries('Disk doluluk (bağlama noktası)', [{ expr: '1 - (node_filesystem_avail_bytes{fstype!~"tmpfs|overlay|squashfs"} / node_filesystem_size_bytes{fstype!~"tmpfs|overlay|squashfs"})', legend: '{{mountpoint}}' }], grid(12, y, 6, 8), { unit: 'percentunit', min: 0 }));
technical.push(timeseries('Ağ (alınan / gönderilen)', [{ expr: 'sum(rate(node_network_receive_bytes_total{device!="lo"}[5m]))', legend: 'alınan' }, { expr: 'sum(rate(node_network_transmit_bytes_total{device!="lo"}[5m]))', legend: 'gönderilen' }], grid(18, y, 6, 8), { unit: 'Bps' }));
y += 8;
technical.push(row('Loglar (Loki) — merkezi, aranabilir', y++));
technical.push(timeseries('Log hacmi (seviye)', [{ expr: 'sum by (level) (count_over_time({service="backend"}[1m]))', legend: '{{level}}' }], grid(0, y, 24, 6), { ds: LOKI, stack: true, description: 'Etiketler: service, container, level. traceId/tenantId structured metadata (aranabilir, indekslenmez).' }));
y += 6;
technical.push(logs('Hata logları (error/fatal)', '{service="backend", level=~"error|fatal"}', grid(0, y, 24, 9)));
y += 9;
technical.push(logs('Log arama ($search)', '{service="backend"} |~ "$search"', grid(0, y, 24, 10)));
const searchVar = { name: 'search', label: 'Log arama (regex; ör. traceId, hata metni)', type: 'textbox', query: '', current: { text: '', value: '' }, options: [] };
const technicalDash = dashboard('yakit-technical', 'Yakıt Takip — Teknik Sağlık', 'HTTP, event loop, DB, MQTT, host kaynakları ve loglar. İş görünümü için "Yakıt Takip — İş Özeti".', technical, [searchVar]);

// ── İş ────────────────────────────────────────────────────────────────────────
nextId = 1;
const business = [];
y = 0;
business.push(row('Cihazlar', y++));
business.push(stat('Kayıtlı (AKTİF) cihaz', 'yakit_devices{state="registered"}', grid(0, y, 6, 4)));
business.push(stat('Aktif (son 10 dk)', 'yakit_devices{state="active"}', grid(6, y, 6, 4), { thresholds: [{ color: 'red', value: null }, { color: 'green', value: 1 }] }));
business.push(stat('Çevrimdışı', 'yakit_devices{state="offline"}', grid(12, y, 6, 4), { thresholds: amber(1, 5), description: 'Son presence olayı OFFLINE olan cihazlar (REP-717).' }));
business.push(stat('Bloke', 'yakit_devices{state="blocked"}', grid(18, y, 6, 4)));
y += 4;
business.push(row('Alarmlar', y++));
business.push(stat('Açık alarm — CRITICAL', 'yakit_alarms_open{severity="CRITICAL"}', grid(0, y, 8, 4), { thresholds: red(1) }));
business.push(stat('Açık alarm — WARNING', 'yakit_alarms_open{severity="WARNING"}', grid(8, y, 8, 4), { thresholds: amber(1, 20) }));
business.push(stat('Açık alarm — INFO', 'yakit_alarms_open{severity="INFO"}', grid(16, y, 8, 4)));
y += 4;
business.push(row('İkmal', y++));
business.push(stat('Bugünkü ikmal', 'yakit_dispenses_today', grid(0, y, 6, 4)));
business.push(stat('Bugünkü litre', 'yakit_dispensed_liters_today', grid(6, y, 6, 4), { unit: 'litre', decimals: 0 }));
business.push(timeseries('İkmal hızı (kaynak, adet/dk)', [{ expr: 'sum by (source) (rate(yakit_dispense_completed_total[5m])) * 60', legend: '{{source}}' }], grid(12, y, 12, 4), { stack: true }));
y += 4;
business.push(row('e-İrsaliye ve bildirim kuyrukları', y++));
business.push(stat('e-İrsaliye QUEUED', 'yakit_despatch_queue{status="QUEUED"}', grid(0, y, 4, 4), { thresholds: amber(10, 50) }));
business.push(stat('e-İrsaliye SENDING', 'yakit_despatch_queue{status="SENDING"}', grid(4, y, 4, 4), { thresholds: amber(5, 20) }));
business.push(stat('e-İrsaliye FAILED', 'yakit_despatch_queue{status="FAILED"}', grid(8, y, 4, 4), { thresholds: red(1), description: 'Kalıcı gönderim hatası — muhasebe müdahalesi gerekir (REP-721).' }));
business.push(stat('En eski bekleyen e-İrsaliye', 'yakit_despatch_oldest_queued_age_seconds', grid(12, y, 6, 4), { unit: 's', thresholds: amber(900, 3600) }));
business.push(stat('Bildirim yeniden deneme kuyruğu', 'yakit_notifications_retry_queue', grid(18, y, 6, 4), { thresholds: amber(10, 100) }));
y += 4;
business.push(row('Seyir', y++));
business.push(timeseries('Cihaz durumu', [{ expr: 'yakit_devices', legend: '{{state}}' }], grid(0, y, 12, 8)));
business.push(timeseries('Açık alarmlar (şiddet)', [{ expr: 'yakit_alarms_open', legend: '{{severity}}' }], grid(12, y, 12, 8), { stack: true }));
y += 8;
business.push(timeseries('Bugünkü ikmal (kümülatif)', [{ expr: 'yakit_dispenses_today', legend: 'ikmal' }], grid(0, y, 12, 8)));
business.push(timeseries('e-İrsaliye kuyruğu', [{ expr: 'yakit_despatch_queue', legend: '{{status}}' }], grid(12, y, 12, 8), { stack: true }));
y += 8;
business.push(stat('Veri tazeliği (son yenilemeden bu yana)', 'time() - yakit_business_metrics_last_refresh_timestamp_seconds', grid(0, y, 8, 3), { unit: 's', thresholds: amber(90, 300), description: 'İş metrikleri arka planda 30 sn\'de bir yenilenir; yüksekse veri BAYAT.' }));
business.push(stat('Metrik yenileme hatası (1 sa)', 'increase(yakit_business_metrics_refresh_errors_total[1h])', grid(8, y, 8, 3), { thresholds: red(1), description: 'Arka plan iş metriği sorgusu başarısız oldu — değerler bayat olabilir.' }));
const businessDash = dashboard('yakit-business', 'Yakıt Takip — İş Özeti', 'Cihaz, alarm, ikmal ve kuyruk görünümü (yönetici). Teknik ayrıntı için "Yakıt Takip — Teknik Sağlık".', business);

const outputs = { 'yakittakip-technical.json': technicalDash, 'yakittakip-business.json': businessDash };
const check = process.argv.includes('--check');
let drift = false;
for (const [file, dash] of Object.entries(outputs)) {
  const text = JSON.stringify(dash, null, 2) + '\n';
  const target = path.join(OUT, file);
  if (check) {
    if (!existsSync(target) || readFileSync(target, 'utf8') !== text) { console.error(`[dashboards] ${file} commit'li dosya generate-dashboards.mjs çıktısından FARKLI — 'node scripts/monitoring/generate-dashboards.mjs' çalıştırıp commit'leyin.`); drift = true; }
  } else writeFileSync(target, text);
}
if (check) process.exit(drift ? 1 : 0);
console.log(`[dashboards] ${Object.keys(outputs).join(', ')} yazıldı.`);
