// ==============================================================================
// OPS-1108 — uyarı SENARYOLARI: TEK doğruluk kaynağı. İKİ tüketicisi var:
//   1. generate-rule-tests.mjs → deploy/monitoring/tests/alerts.test.yml (promtool unit test: GERÇEK `for` süreleriyle ateşleme + ateşlememe)
//   2. test-ops1108.mjs --live → bildirim zinciri tatbikatı (sahte exporter bu serileri yayınlar; Prometheus GERÇEK kurallarla değerlendirir,
//      Alertmanager GERÇEK yönlendirmeyle webhook'a gönderir)
// "Hiç tetiklenmemiş bir uyarı kuralı çalıştığının kanıtı değildir" (ticket Teknik Notu) — her kural burada ateşlenir VE eşik altında sessiz kalır.
//
// series: [ [seçici, 'a+bxN' | 'a-bxN'] ]  (promtool sözdizimi; canlıda: b=0 → gauge sabiti, b≠0 → dakikada b artan/azalan sayaç)
// expect: [{ severity, value?, labels? }] — BOŞ = ateşlememeli. value = $value'nun beklenen sayısı (açıklama şablonunu üretmek için).
// live:false → yalnızca promtool (Prometheus'un kendi ürettiği `up` gibi seriler sahte exporter'la üretilemez).
// ==============================================================================
const g = (sel, v, n = 60) => [sel, `${v}+0x${n}`];
const c = (sel, perMin, n = 60) => [sel, `0+${perMin}x${n}`];
const traffic = () => c('http_requests_total{status="200",route="/x"}', 1000);   // ≈16.7 istek/sn (asgari trafik korumasını aşar)
const lat = (fast, slowLe) => [   // %90 ≤0.5 sn, %10 slowLe'de → p95 = alt + (üst-alt)*0.5
  c('http_request_duration_seconds_bucket{le="0.5"}', fast), c('http_request_duration_seconds_bucket{le="1"}', fast),
  c('http_request_duration_seconds_bucket{le="2.5"}', slowLe <= 2.5 ? 1000 : fast), c('http_request_duration_seconds_bucket{le="5"}', slowLe <= 5 ? 1000 : fast),
  c('http_request_duration_seconds_bucket{le="10"}', 1000), c('http_request_duration_seconds_bucket{le="+Inf"}', 1000)
];
const disk = (avail, mp = '/') => [g(`node_filesystem_avail_bytes{mountpoint="${mp}",fstype="ext4"}`, avail), g(`node_filesystem_size_bytes{mountpoint="${mp}",fstype="ext4"}`, 100)];
const dummy = g('dummy_metric', 1);

export const SCENARIOS = [
  { alert: 'ApiErrorRate', cases: [
    { name: 'warning: %4.8 hata', series: [traffic(), c('http_requests_total{status="500",route="/x"}', 50)], evalMinutes: 20, expect: [{ severity: 'warning', value: 50 / 1050 }] },
    { name: 'critical: %14.3 hata (warning de aktif; Alertmanager bastırır)', series: [traffic(), c('http_requests_total{status="500",route="/x"}', 150)], evalMinutes: 20, expect: [{ severity: 'critical', value: 150 / 1150 }, { severity: 'warning', value: 150 / 1150 }] },
    { name: 'sessiz: %1 hata', series: [traffic(), c('http_requests_total{status="500",route="/x"}', 10)], evalMinutes: 20, expect: [] },
    { name: 'sessiz: asgari trafik koruması (oran %33 ama 0.05 istek/sn)', series: [c('http_requests_total{status="200",route="/x"}', 2), c('http_requests_total{status="500",route="/x"}', 1)], evalMinutes: 20, expect: [] },
    { name: 'sessiz: `for` dolmadı (9 dk)', series: [traffic(), c('http_requests_total{status="500",route="/x"}', 50)], evalMinutes: 9, expect: [] }
  ] },
  { alert: 'ApiLatencyP95', cases: [
    { name: 'warning: p95 = 1.75 sn', series: [traffic(), ...lat(900, 2.5)], evalMinutes: 20, expect: [{ severity: 'warning', value: 1.75 }] },
    { name: 'critical: p95 = 7.5 sn', series: [traffic(), ...lat(900, 10)], evalMinutes: 20, expect: [{ severity: 'critical', value: 7.5 }, { severity: 'warning', value: 7.5 }] },
    { name: 'sessiz: hepsi ≤0.5 sn', series: [traffic(), ...lat(1000, 0.5)], evalMinutes: 20, expect: [] }
  ] },
  { alert: 'EventLoopLag', cases: [
    { name: 'warning: p99 = 0.75 sn', series: [g('nodejs_eventloop_lag_p99_seconds', 0.75)], evalMinutes: 10, gauge: 5, expect: [{ severity: 'warning', value: 0.75 }] },
    { name: 'sessiz: 50 ms', series: [g('nodejs_eventloop_lag_p99_seconds', 0.05)], evalMinutes: 10, expect: [] }
  ] },
  { alert: 'BackendDown', cases: [
    { name: 'critical: up=0', series: [g('up{job="backend",instance="b1:5000"}', 0)], evalMinutes: 5, live: false, expect: [{ severity: 'critical', labels: { job: 'backend', instance: 'b1:5000' } }] },
    { name: 'sessiz: up=1', series: [g('up{job="backend",instance="b1:5000"}', 1)], evalMinutes: 5, expect: [] },
    { name: 'sessiz: `for` dolmadı (1 dk)', series: [g('up{job="backend",instance="b1:5000"}', 0)], evalMinutes: 1, expect: [] }
  ] },
  { alert: 'BackendMissing', cases: [
    { name: 'critical: backend serisi yok (DNS SD boş)', series: [g('up{job="node",instance="n1:9100"}', 1)], evalMinutes: 10, live: false, expect: [{ severity: 'critical', labels: { job: 'backend' } }] },
    { name: 'sessiz: backend var', series: [g('up{job="backend",instance="b1:5000"}', 1)], evalMinutes: 10, expect: [] }
  ] },
  { alert: 'BackendMemoryHigh', cases: [
    { name: 'warning: 2 GB RSS', series: [g('process_resident_memory_bytes{job="backend"}', 2000000000)], evalMinutes: 25, expect: [{ severity: 'warning', value: 2000000000 }] },
    { name: 'sessiz: 500 MB', series: [g('process_resident_memory_bytes{job="backend"}', 500000000)], evalMinutes: 25, expect: [] }
  ] },
  { alert: 'DbPoolSaturated', cases: [
    { name: 'warning: 3 bekleyen', series: [g('yakit_db_pool_connections{state="waiting"}', 3)], evalMinutes: 5, gauge: 2, expect: [{ severity: 'warning', value: 3 }] },
    { name: 'critical: 8 bekleyen', series: [g('yakit_db_pool_connections{state="waiting"}', 8)], evalMinutes: 5, expect: [{ severity: 'critical', value: 8 }, { severity: 'warning', value: 8 }] },
    { name: 'sessiz: bekleyen yok', series: [g('yakit_db_pool_connections{state="waiting"}', 0)], evalMinutes: 5, expect: [] }
  ] },
  { alert: 'PostgresConnectionsHigh', cases: [
    { name: 'warning: %85', series: [g('pg_stat_activity_count{state="active"}', 85), g('pg_settings_max_connections', 100)], evalMinutes: 10, gauge: 5, expect: [{ severity: 'warning', value: 0.85 }] },
    { name: 'critical: %95', series: [g('pg_stat_activity_count{state="active"}', 95), g('pg_settings_max_connections', 100)], evalMinutes: 10, expect: [{ severity: 'critical', value: 0.95 }, { severity: 'warning', value: 0.95 }] },
    { name: 'sessiz: %30', series: [g('pg_stat_activity_count{state="active"}', 30), g('pg_settings_max_connections', 100)], evalMinutes: 10, expect: [] }
  ] },
  { alert: 'PostgresDown', cases: [
    { name: 'critical: pg_up=0', series: [g('pg_up', 0)], evalMinutes: 5, gauge: 2, expect: [{ severity: 'critical' }] },
    { name: 'sessiz: pg_up=1', series: [g('pg_up', 1)], evalMinutes: 5, expect: [] }
  ] },
  { alert: 'DiskSpace', cases: [
    { name: 'warning: %10 boş', series: disk(10), evalMinutes: 15, gauge: 10, expect: [{ severity: 'warning', value: 0.1, labels: { mountpoint: '/', fstype: 'ext4' } }] },
    { name: 'critical: %3 boş', series: disk(3), evalMinutes: 15, expect: [{ severity: 'critical', value: 0.03, labels: { mountpoint: '/', fstype: 'ext4' } }, { severity: 'warning', value: 0.03, labels: { mountpoint: '/', fstype: 'ext4' } }] },
    { name: 'sessiz: %40 boş', series: disk(40), evalMinutes: 15, expect: [] },
    { name: 'sessiz: tmpfs yok sayılır', series: [g('node_filesystem_avail_bytes{mountpoint="/run",fstype="tmpfs"}', 1), g('node_filesystem_size_bytes{mountpoint="/run",fstype="tmpfs"}', 100)], evalMinutes: 15, expect: [] }
  ] },
  { alert: 'DiskWillFillSoon', cases: [
    { name: 'warning: eğilim 4 saatte doldurur', series: [['node_filesystem_avail_bytes{mountpoint="/",fstype="ext4"}', '800000000-5000000x120'], g('node_filesystem_size_bytes{mountpoint="/",fstype="ext4"}', 2000000000, 120)], evalMinutes: 90, expect: [{ severity: 'warning', labels: { mountpoint: '/', fstype: 'ext4' } }] },
    { name: 'sessiz: düz eğim', series: [g('node_filesystem_avail_bytes{mountpoint="/",fstype="ext4"}', 800000000, 120), g('node_filesystem_size_bytes{mountpoint="/",fstype="ext4"}', 2000000000, 120)], evalMinutes: 90, expect: [] }
  ] },
  { alert: 'HostMemoryLow', cases: [
    { name: 'warning: %5', series: [g('node_memory_MemAvailable_bytes', 5), g('node_memory_MemTotal_bytes', 100)], evalMinutes: 15, gauge: 10, expect: [{ severity: 'warning', value: 0.05 }] },
    { name: 'sessiz: %50', series: [g('node_memory_MemAvailable_bytes', 50), g('node_memory_MemTotal_bytes', 100)], evalMinutes: 15, expect: [] }
  ] },
  { alert: 'HostCpuHigh', cases: [
    { name: 'warning: CPU %95', series: [c('node_cpu_seconds_total{mode="idle",cpu="0"}', 3)], evalMinutes: 30, expect: [{ severity: 'warning', value: 95 }] },
    { name: 'sessiz: CPU %30', series: [c('node_cpu_seconds_total{mode="idle",cpu="0"}', 42)], evalMinutes: 30, expect: [] }
  ] },
  { alert: 'DevicesOfflineRatio', cases: [
    { name: 'warning: %40 çevrimdışı', series: [g('yakit_devices{state="offline"}', 4), g('yakit_devices{state="registered"}', 10)], evalMinutes: 20, gauge: 15, expect: [{ severity: 'warning', value: 0.4 }] },
    { name: 'critical: %60 çevrimdışı', series: [g('yakit_devices{state="offline"}', 6), g('yakit_devices{state="registered"}', 10)], evalMinutes: 20, expect: [{ severity: 'critical', value: 0.6 }, { severity: 'warning', value: 0.6 }] },
    { name: 'sessiz: %10', series: [g('yakit_devices{state="offline"}', 1), g('yakit_devices{state="registered"}', 10)], evalMinutes: 20, expect: [] },
    { name: 'sessiz: küçük filo (4 cihaz, hepsi çevrimdışı) — oran koruması', series: [g('yakit_devices{state="offline"}', 4), g('yakit_devices{state="registered"}', 4)], evalMinutes: 20, expect: [] }
  ] },
  { alert: 'NoActiveDevices', cases: [
    { name: 'warning: kayıtlı 10, aktif 0', series: [g('yakit_devices{state="active"}', 0), g('yakit_devices{state="registered"}', 10)], evalMinutes: 40, expect: [{ severity: 'warning' }] },
    { name: 'sessiz: 3 aktif', series: [g('yakit_devices{state="active"}', 3), g('yakit_devices{state="registered"}', 10)], evalMinutes: 40, expect: [] }
  ] },
  { alert: 'DespatchQueueBacklog', cases: [
    { name: 'warning: 60 bekleyen', series: [g('yakit_despatch_queue{status="QUEUED"}', 60)], evalMinutes: 20, gauge: 15, expect: [{ severity: 'warning', value: 60 }] },
    { name: 'critical: 250 bekleyen', series: [g('yakit_despatch_queue{status="QUEUED"}', 250)], evalMinutes: 20, expect: [{ severity: 'critical', value: 250 }, { severity: 'warning', value: 250 }] },
    { name: 'sessiz: 5 bekleyen', series: [g('yakit_despatch_queue{status="QUEUED"}', 5)], evalMinutes: 20, expect: [] }
  ] },
  { alert: 'DespatchQueueStuck', cases: [
    { name: 'warning: en eski 2000 sn', series: [g('yakit_despatch_oldest_queued_age_seconds', 2000)], evalMinutes: 15, gauge: 10, expect: [{ severity: 'warning', value: 2000 }] },
    { name: 'critical: en eski 4000 sn', series: [g('yakit_despatch_oldest_queued_age_seconds', 4000)], evalMinutes: 15, expect: [{ severity: 'critical', value: 4000 }, { severity: 'warning', value: 4000 }] },
    { name: 'sessiz: 60 sn', series: [g('yakit_despatch_oldest_queued_age_seconds', 60)], evalMinutes: 15, expect: [] }
  ] },
  { alert: 'DespatchDeadLetter', cases: [
    { name: 'warning: 3 FAILED', series: [g('yakit_despatch_queue{status="FAILED"}', 3)], evalMinutes: 15, gauge: 10, expect: [{ severity: 'warning', value: 3 }] },
    { name: 'critical: 15 FAILED', series: [g('yakit_despatch_queue{status="FAILED"}', 15)], evalMinutes: 15, expect: [{ severity: 'critical', value: 15 }, { severity: 'warning', value: 15 }] },
    { name: 'sessiz: 0 FAILED', series: [g('yakit_despatch_queue{status="FAILED"}', 0)], evalMinutes: 15, expect: [] }
  ] },
  { alert: 'NotificationRetryBacklog', cases: [
    { name: 'warning: 150', series: [g('yakit_notifications_retry_queue', 150)], evalMinutes: 20, gauge: 15, expect: [{ severity: 'warning', value: 150 }] },
    { name: 'sessiz: 20', series: [g('yakit_notifications_retry_queue', 20)], evalMinutes: 20, expect: [] }
  ] },
  { alert: 'NotificationWebhookCircuitOpen', cases: [
    { name: 'warning: 2 kanal', series: [g('yakit_notification_circuit_open', 2)], evalMinutes: 35, gauge: 30, expect: [{ severity: 'warning', value: 2 }] },
    { name: 'sessiz: 0', series: [g('yakit_notification_circuit_open', 0)], evalMinutes: 35, expect: [] }
  ] },
  { alert: 'MqttRejectSpike', cases: [
    { name: 'warning: 2 ret/sn', series: [c('yakit_mqtt_rejected_total{reason="blocked_device"}', 120)], evalMinutes: 20, expect: [{ severity: 'warning', value: 2 }] },
    { name: 'sessiz: 0.1 ret/sn', series: [c('yakit_mqtt_rejected_total{reason="blocked_device"}', 6)], evalMinutes: 20, expect: [] }
  ] },
  { alert: 'MqttProcessingErrors', cases: [
    { name: 'warning: 0.2 hata/sn', series: [c('yakit_mqtt_processing_errors_total', 12)], evalMinutes: 20, expect: [{ severity: 'warning', value: 0.2 }] },
    { name: 'sessiz: 0.01 hata/sn', series: [c('yakit_mqtt_processing_errors_total', 0.6)], evalMinutes: 20, expect: [] }
  ] },
  { alert: 'CriticalFieldAlarmsOpen', cases: [
    { name: 'info: 25 açık kritik alarm', series: [g('yakit_alarms_open{severity="CRITICAL"}', 25)], evalMinutes: 35, gauge: 30, expect: [{ severity: 'info', value: 25 }] },
    { name: 'sessiz: 5', series: [g('yakit_alarms_open{severity="CRITICAL"}', 5)], evalMinutes: 35, expect: [] }
  ] },
  { alert: 'Watchdog', cases: [
    { name: 'her zaman ateşler (kalp atışı)', series: [dummy], evalMinutes: 3, expect: [{ severity: 'none' }] }
  ] },
  { alert: 'ScrapeTargetDown', cases: [
    { name: 'warning: node hedefi down', series: [g('up{job="node",instance="n1:9100"}', 0)], evalMinutes: 10, live: false, expect: [{ severity: 'warning', labels: { job: 'node', instance: 'n1:9100' } }] },
    { name: 'sessiz: hedefler up', series: [g('up{job="node",instance="n1:9100"}', 1)], evalMinutes: 10, expect: [] },
    { name: 'sessiz: backend down bu kuralın konusu DEĞİL (BackendDown)', series: [g('up{job="backend",instance="b1:5000"}', 0)], evalMinutes: 10, expect: [] }
  ] },
  { alert: 'BusinessMetricsStale', cases: [
    { name: 'warning: son yenileme 1100 sn önce', series: [g('yakit_business_metrics_last_refresh_timestamp_seconds', 100)], evalMinutes: 20, expect: [{ severity: 'warning', value: 1100 }] },
    { name: 'sessiz: taze (zamanla artan)', series: [c('yakit_business_metrics_last_refresh_timestamp_seconds', 60)], evalMinutes: 20, expect: [] }
  ] },
  { alert: 'LogPipelineDown', cases: [
    { name: 'warning: loki down', series: [g('up{job="loki",instance="l1:3100"}', 0)], evalMinutes: 10, live: false, expect: [{ severity: 'warning', labels: { job: 'loki', instance: 'l1:3100' } }] },
    { name: 'sessiz: loki up', series: [g('up{job="loki",instance="l1:3100"}', 1)], evalMinutes: 10, expect: [] }
  ] },
  { alert: 'BackupTooOld', cases: [
    { name: 'critical: son yedek 96000 sn önce', series: [g('yakit_backup_last_success_timestamp_seconds{kind="base"}', 0, 1600)], evalMinutes: 1600, live: false, expect: [{ severity: 'critical', value: 96000 }] },
    { name: 'sessiz: taze yedek', series: [g('yakit_backup_last_success_timestamp_seconds{kind="base"}', 0, 100)], evalMinutes: 60, expect: [] }
  ] },
  { alert: 'BackupMetricsMissing', cases: [
    { name: 'warning: yedek metriği hiç yok', series: [dummy], evalMinutes: 90, expect: [{ severity: 'warning', labels: { kind: 'base' } }] },
    { name: 'sessiz: metrik var', series: [g('yakit_backup_last_success_timestamp_seconds{kind="base"}', 0, 100)], evalMinutes: 90, expect: [] }
  ] },
  { alert: 'WalShippingStalled', cases: [
    { name: 'critical: son WAL gönderimi 1800 sn önce', series: [g('yakit_backup_last_success_timestamp_seconds{kind="wal"}', 0)], evalMinutes: 30, expect: [{ severity: 'critical', value: 1800 }] },
    { name: 'sessiz: taze WAL gönderimi', series: [c('yakit_backup_last_success_timestamp_seconds{kind="wal"}', 60)], evalMinutes: 30, expect: [] }
  ] },
  { alert: 'WalSpoolBacklog', cases: [
    { name: 'warning: 25 bekleyen segment', series: [g('yakit_wal_spool_pending_files', 25)], evalMinutes: 20, gauge: 15, expect: [{ severity: 'warning', value: 25 }] },
    { name: 'sessiz: 2 segment', series: [g('yakit_wal_spool_pending_files', 2)], evalMinutes: 20, expect: [] }
  ] }
];

// Canlı tatbikatın SAĞLIKLI taban çizgisi: bu setle Watchdog dışında HİÇBİR uyarı ateşlememeli (yalancı pozitif kontrolü).
export const BASELINE = [
  c('http_requests_total{status="200",route="/x"}', 1000),
  ...['0.5', '1', '2.5', '5', '10', '+Inf'].map((le) => c(`http_request_duration_seconds_bucket{le="${le}"}`, 1000)),
  g('nodejs_eventloop_lag_p99_seconds', 0.05), g('process_resident_memory_bytes{job="backend"}', 300000000),
  g('yakit_db_pool_connections{state="waiting"}', 0), g('pg_up', 1), g('pg_stat_activity_count{state="active"}', 30), g('pg_settings_max_connections', 100),
  ...disk(60), g('node_memory_MemAvailable_bytes', 60), g('node_memory_MemTotal_bytes', 100), c('node_cpu_seconds_total{mode="idle",cpu="0"}', 45),
  g('yakit_devices{state="offline"}', 1), g('yakit_devices{state="registered"}', 10), g('yakit_devices{state="active"}', 3),
  g('yakit_despatch_queue{status="QUEUED"}', 2), g('yakit_despatch_queue{status="FAILED"}', 0), g('yakit_despatch_oldest_queued_age_seconds', 30),
  g('yakit_notifications_retry_queue', 1), g('yakit_notification_circuit_open', 0), c('yakit_mqtt_rejected_total{reason="blocked_device"}', 1), c('yakit_mqtt_processing_errors_total', 0),
  g('yakit_alarms_open{severity="CRITICAL"}', 3),
  // Zaman damgası metrikleri: canlıda GERÇEK unix zamanı gerekir ('now' = sunucunun şimdisi; promtool'da time() 0'dan başlar, orada c() kullanılır).
  ['yakit_business_metrics_last_refresh_timestamp_seconds', 'now'], ['yakit_backup_last_success_timestamp_seconds{kind="base"}', 'now'], ['yakit_backup_last_success_timestamp_seconds{kind="wal"}', 'now'],
  g('yakit_wal_spool_pending_files', 1)
];
