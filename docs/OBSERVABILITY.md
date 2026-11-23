# Gözlemlenebilirlik: Metrikler, Dashboard'lar ve Merkezi Loglar (OPS-1107)

Sistemin sağlığı **tahmine değil ölçüme** dayanır: uygulama `/metrics` yayınlar, Prometheus toplar, Grafana gösterir; loglar Loki'de merkezi ve aranabilir tutulur.
Ortamlar: [ENVIRONMENTS.md](ENVIRONMENTS.md) · Yedekleme: [BACKUP_RESTORE.md](BACKUP_RESTORE.md). Alarm kuralları/Alertmanager OPS-1108 kapsamındadır (`prometheus.yml`'ye `rule_files` orada eklenir).

## 1. Yığın

```
backend :5000/metrics ──┐
postgres-exporter ──────┤                    ┌─► Grafana  (127.0.0.1:3001)  "Yakıt Takip — Teknik Sağlık" / "Yakıt Takip — İş Özeti"
node-exporter ──────────┼─► Prometheus ──────┤
loki, prometheus (self) ┘   (15 gün / 5 GB)  │
compose konteyner logları ─► Promtail ─► Loki ──┘  (14 gün; etiket: service, container, level)
```

Etkinleştirme (staging/production): `docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up -d` veya sunucudaki `.env`'ye
`COMPOSE_FILE=docker-compose.yml:docker-compose.monitoring.yml[:docker-compose.backup.yml]`. **Zorunlu:** `GRAFANA_ADMIN_PASSWORD` (varsayılan parola YOK).
İsteğe bağlı: `METRICS_TOKEN`, `PG_EXPORTER_USER/PASSWORD` ([`postgres-monitoring-role.sql`](../deploy/monitoring/postgres-monitoring-role.sql) ile `pg_monitor` rolü — superuser yerine),
`DOCKER_SOCK` (rootless Docker'da `$XDG_RUNTIME_DIR/docker.sock`), `MONITORING_DIR` (yapılandırma dizini).

**Güvenlik:** tüm bileşenler yalnızca iç compose ağındadır; dışarı açılan tek port Grafana'dır ve **127.0.0.1**'e bağlanır (uzaktan erişim için SSH tüneli/nginx + TLS).
Backend `/metrics` API dışıdır (`/api/v1` altında değil) → nginx onu proxy'lemez. `METRICS_TOKEN` tanımlıysa `Authorization: Bearer <token>` **zorunludur** (Prometheus aynı env'den alır);
üretimde tanımlayın: rota adları/hacimleri operasyonel bilgidir.

## 2. Metrik kataloğu ve kardinalite politikası

**Kural (AC: "Metrik kardinalitesi kontrol altında olmalıdır"):** sınırsız değerli etiket **yoktur**. `device_id`, `tenant_id`, `user_id`, araç plakası, IP, ham URL/yol metrik etiketi
**olamaz** — bunlar log'a ve `traceId`'ye aittir (Loki). Etiket değerleri kodda sabit kümelerden (enum) türetilir. `route` = Express'in **eşleşen yol kalıbı** (`/api/v1/reports/:reportId`);
eşleşmeyen her şey (404, tarama, rastgele yol) tek değer `unmatched`. Seri sayısı URL sayısıyla değil route × fiil × durum sınıfı kombinasyonuyla sınırlıdır
(testle kanıtlı: 250 yeni URL sonrası seri sayısı değişmez). Prometheus tarafında `sample_limit: 20000` — kod hatası bir hedefi şişirirse scrape reddedilir (`up=0`).

Bir metriğe **yeni etiket eklemeden önce**: değer kümesi sınırlı mı (enum/sabit route)? Değilse etiket yapmayın; log alanı veya `traceId` kullanın.

### Teknik metrikler (uygulama)

| Metrik | Tür | Etiketler (üst sınır) | Açıklama |
|---|---|---|---|
| `http_request_duration_seconds` | histogram | `method` (8), `route` (≈ kullanılan route sayısı + `unmatched`), `status_class` (5) | HTTP süresi; p50/p95/p99 dashboard'da |
| `http_requests_total` | counter | `method`, `route`, `status` (≈ <30 HTTP kodu) | İstek sayısı / hata oranı |
| `http_requests_in_flight` | gauge | — | Şu an işlenen istek |
| `yakit_db_pool_connections` | gauge | `state` = total \| idle \| waiting | Uygulamanın pg havuzu (max 10); `waiting`>0 sürekli = doygunluk |
| `yakit_mqtt_messages_total` | counter | `kind` = telemetry_data \| telemetry_status \| command_ack \| other | MQTT mesaj hızı |
| `yakit_mqtt_rejected_total` | counter | `reason` = unregistered_device \| blocked_device \| tenant_mismatch | IOT-304 uygulama-seviyesi ret |
| `yakit_mqtt_processing_errors_total` | counter | — | MQTT işleme hatası |
| `yakit_dispense_completed_total` | counter | `source` = api \| device \| offline_sync | Tamamlanan ikmal sayısı |
| `nodejs_eventloop_lag_*`, `process_cpu_seconds_total`, `process_resident_memory_bytes`, `nodejs_heap_*`, `nodejs_gc_*` … | (prom-client varsayılanları) | runtime enum'ları | **Event loop gecikmesi**, CPU, bellek, GC |

### İş metrikleri (arka planda 30 sn'de bir yenilenir)

Tek bir tenant-arası sorgu (`adminDb.getBusinessMetricsSnapshot`, tenant-önce indekslere `LATERAL` ile) tüm gauge'ları besler; scrape sıklığı DB yükünü belirlemez. Tenant/cihaz başına seri **üretilmez** (toplam platform).

| Metrik | Tür | Etiketler | Açıklama |
|---|---|---|---|
| `yakit_devices` | gauge | `state` = registered \| active \| offline \| blocked | Kayıtlı AKTİF / son 10 dk'da görülen / son presence OFFLINE / bloke cihaz |
| `yakit_alarms_open` | gauge | `severity` = INFO \| WARNING \| CRITICAL | Açık (RESOLVED/FALSE_POSITIVE olmayan) alarm |
| `yakit_dispenses_today` | gauge | — | Bugünkü ikmal sayısı (tüm tenant'lar) |
| `yakit_dispensed_liters_today` | gauge | — | Bugünkü litre |
| `yakit_despatch_queue` | gauge | `status` = QUEUED \| SENDING \| FAILED | e-İrsaliye iletim kuyruğu derinliği |
| `yakit_despatch_oldest_queued_age_seconds` | gauge | — | Kuyrukta bekleyen en eski e-İrsaliyenin yaşı |
| `yakit_notifications_retry_queue` | gauge | — | Yeniden deneme bekleyen (BAŞARISIZ) bildirim |
| `yakit_notification_circuit_open` | gauge | — | Devre kesicisi açık (otomatik devre dışı) bildirim webhook kanalı sayısı (NOTIF-1604) |
| `yakit_despatch_integrator_circuit_open` | gauge | — | e-İrsaliye entegratör devre kesicisi OPEN/HALF_OPEN mi (1) — GLOBAL, tenant etiketi yok (COMP-602.2) |
| `yakit_business_metrics_last_refresh_timestamp_seconds` | gauge | — | Son başarılı yenileme (bayat veri tespiti) |
| `yakit_business_metrics_refresh_errors_total` | counter | — | Yenileme hatası |

### Altyapı metrikleri (exporter'lar)

`node-exporter`: CPU, bellek, disk doluluk (bağlama noktası), ağ. `postgres-exporter`: `pg_stat_activity_count{state}` (DB bağlantıları), `pg_settings_max_connections`, `pg_database_size_bytes`, işlem oranları.

## 3. Dashboard'lar (Grafana, "Yakıt Takip" klasörü)

İki **ayrı** dashboard (Teknik Not: "yönetici event loop lag'ine bakmaz"):

- **Yakıt Takip — Teknik Sağlık** (`yakit-technical`): hedef durumu, 5xx oranı, istek hızı, gecikme p50/p95/p99, en yavaş 10 route, event loop lag, bellek/CPU, DB havuzu ve PostgreSQL bağlantıları, MQTT hızı/ret/hata, host CPU/bellek/disk/ağ, **loglar** (hacim, hata akışı, `$search` ile arama).
- **Yakıt Takip — İş Özeti** (`yakit-business`): cihaz (kayıtlı/aktif/çevrimdışı/bloke), açık alarm (CRITICAL/WARNING/INFO), bugünkü ikmal + litre + ikmal hızı, e-İrsaliye kuyruğu (QUEUED/SENDING/FAILED/en eski yaş), bildirim yeniden deneme kuyruğu, seyir grafikleri, veri tazeliği.

Dashboard JSON'ları **üretilir**: kaynak [`scripts/monitoring/generate-dashboards.mjs`](../scripts/monitoring/generate-dashboards.mjs); çıktı commit'lidir ve CI, commit'li dosyanın üretimle aynı olduğunu doğrular (elle düzenleme = sapma = kırmızı).
Dashboard değişikliği: script'i düzenle → `node scripts/monitoring/generate-dashboards.mjs` → commit. Her panel ifadesi ya kodda tanımlı bir metriğe ya da bilinen exporter metriğine bağlıdır (testle doğrulanır).

## 4. Loglar (Loki) — merkezi ve aranabilir

Backend her satırı **pino JSON** yazar (`level`, `time`, `msg`, `traceId`, `tenantId`, `req`, `res`, `responseTime` …). Promtail konteyner loglarını **Docker API** ile okur (dosya bağlama gerekmez → rootless'ta da çalışır) ve Loki'ye gönderir.

- **Etiketler (sınırlı):** `service` (compose servisi), `container`, `level` (trace|debug|info|warn|error|fatal).
- **Structured metadata (aranabilir, indekslenmez):** `traceId`, `tenantId` — yüksek kardinaliteli alanlar etiket yapılmaz.
- Örnek sorgular (Grafana → Explore → Loki):
  - Bir isteğin tüm logları: `{service="backend"} | traceId="<X-Trace-ID başlığındaki değer>"`
  - Bir tenant'ın hataları: `{service="backend", level="error"} | tenantId="comp-camsa"`
  - Metinle arama: `{service="backend"} |~ "e-İrsaliye"`
  - Hata oranı: `sum(rate({service="backend", level="error"}[5m]))`
- Çok örnekli kurulumda her replika aynı `service` etiketiyle, `container` ile ayrışarak gelir — tek sorguyla tüm örneklerde arama yapılır.
- Retansiyon 14 gün (`loki.yml`). Log'larda kişisel veri riski: uygulama log redaksiyonu (`utils/redaction.ts`) geçerlidir; Loki erişimi Grafana yönetici hesabıyla sınırlıdır.

## 5. Kapasite ve işletme

- Prometheus: 15 gün / 5 GB üst sınır (`--storage.tsdb.retention.*`). Seri sayısı: bugün backend ≈ 300 + (kullanılan route × durum sınıfı × 15).
- Loki: 14 gün; disk kullanımı log hacmine bağlıdır (hata logları ve istek logları). `LOG_LEVEL=warn` (production şablonu) hacmi düşürür.
- Yedekleme: Grafana/Prometheus/Loki verisi **yedeklenmez** (yeniden üretilebilir/geçici); dashboard'lar ve yapılandırma git'tedir.
- Yük altında doğrulama: `scripts/test-ops1107.mjs --live` çalışan yığında hedefleri, tüm dashboard ifadelerini, Loki etiketlerini ve kardinaliteyi doğrular.

## 6. Bilinen sınırlar

- Trace/dağıtık izleme (OpenTelemetry) kapsam dışıdır; korelasyon `X-Trace-ID` + Loki `traceId` ile yapılır.
- Kuyruk derinlikleri veritabanı tablolarından okunur (BullMQ/Redis Streams yoktur): e-İrsaliye iletimi ve bildirim yeniden denemesi. Yeni bir kuyruk eklenirse metriği `getBusinessMetricsSnapshot`'a ve bu kataloğa eklenmelidir.
- `node-exporter` host dosya sistemine `/:/host:ro` bağlar; kısıtlı (ör. bazı yönetilen konteyner) ortamlarda bu servis devre dışı bırakılıp bulut sağlayıcının host metrikleri kullanılmalıdır.
- Alarm/uyarı kuralları ve bildirim kanalları: OPS-1108.

## Hata izleme (Sentry)

İstemci + sunucu hata izleme, `trace_id` korelasyonu ve source map: [ERROR_TRACKING.md](ERROR_TRACKING.md) (RES-907). Sentry'deki `trace_id` etiketi, yukarıdaki log sorgularındaki `traceId` ile aynı değerdir.
