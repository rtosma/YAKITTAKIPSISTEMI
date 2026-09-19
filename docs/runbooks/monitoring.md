# Runbook — İzleme hattının kendisi

> Genel kurallar: [ALERTING.md](../ALERTING.md). Bu uyarılar "izleme kör mü?" sorusuna cevap verir; **körsek diğer tüm uyarılara güvenilemez**.

## Watchdog

### Etki
`Watchdog` **her zaman** ateşler (normaldir). Alertmanager onu dış "kalp atışı" servisine (`ALERT_HEARTBEAT_URL`, ör. healthchecks.io/Dead Man's Snitch) düzenli gönderir.
Bu sayfaya **kalp atışı servisi "sinyal kesildi" dediğinde** gelirsiniz: Prometheus → Alertmanager → bildirim hattının bir yerinde kopukluk var; **kritik uyarılar şu an size ulaşmıyor olabilir**.

### Tanı
1. `docker compose ps prometheus alertmanager alertmanager-config`; `docker compose logs --tail 100 alertmanager`.
2. Alertmanager UI/API (iç ağ): `docker compose exec alertmanager wget -qO- localhost:9093/api/v2/status` ve `.../api/v2/alerts` (Watchdog var mı?).
3. Prometheus → Status → Rules/Alerts: Watchdog `firing` mi; "Alertmanagers" listesi dolu mu (`/api/v1/alertmanagers`).
4. Alertmanager giden bildirim hatası: log'da `Notify for alerts failed`, `context deadline exceeded` (webhook/SMTP/Telegram erişimi).
5. Sunucu dışarıya çıkabiliyor mu (`curl -sI https://api.telegram.org`)? Ağ/DNS/güvenlik duvarı.

### Müdahale
- Servis durmuşsa `docker compose up -d prometheus alertmanager`; yapılandırma hatasıysa `docker compose logs alertmanager-config` (kanal env'leri eksik olabilir).
- Kanal kimlik bilgisi değiştiyse `.env`'yi düzeltip `docker compose up -d --force-recreate alertmanager-config alertmanager`.
- **Geçici gözlem:** hat düzelene kadar Grafana → Alerting ve `docker compose logs` ile elle izleyin; ilgili ekibi kanal dışı (telefon) bilgilendirin.

### Doğrulama
Kalp atışı servisi sinyali yeniden alır; yeni bir test uyarısı gönderin: `docker compose exec alertmanager amtool alert add TestAlert severity=warning summary=test --alertmanager.url=http://localhost:9093` ve ekip kanalında görün.

### Eskalasyon
30 dk içinde düzelmezse teknik sorumlu — bu sürede kritik olaylar için manuel nöbet gözetimi başlatılır.

## ScrapeTargetDown

### Etki
İzleme hedeflerinden biri (node-exporter, postgres-exporter, Loki, Alertmanager) kazınamıyor: o bileşenin metrikleri ve dayandığı uyarılar (disk/DB bağlantıları/loglar/bildirim hattı) **körleşti**.

### Tanı
1. Uyarıdaki `job` etiketi hangisi? `docker compose ps <servis>`; `docker compose logs --tail 50 <servis>`.
2. node-exporter: host dosya sistemi bağlaması (`/:/host:ro,rslave`) çalışmıyor olabilir (kısıtlı ortam); postgres-exporter: DB kimlik bilgisi/`pg_monitor` yetkisi.
3. Prometheus → Status → Targets: hata metni (`connection refused`, `context deadline`, `sample_limit exceeded`).

### Müdahale
Servisi yeniden başlatın (`docker compose up -d <servis>`); `sample_limit` aşımı ise kardinalite sorunudur → [OBSERVABILITY.md](../OBSERVABILITY.md) politikasına göre etiket kaynağını bulun (yeni etiket eklendi mi?).

### Doğrulama
Prometheus → Status → Targets sayfasında ilgili hedef `UP`; `up{job="<job>"}` = 1 ve `ScrapeTargetDown` resolved bildirimi gelir.

### Eskalasyon
Mesai içinde çözülmezse teknik sorumlu (körlük süresi uzuyor).

## BusinessMetricsStale

### Etki
İş metrikleri (cihaz/alarm/kuyruk) 5 dk'dır yenilenmiyor: bunlara dayanan **saha uyarıları (cihaz oranı, e-İrsaliye kuyruğu…) bayat/yanlış veriye bakıyor** — sessiz kalabilirler.

### Tanı
1. Backend `/metrics`: `yakit_business_metrics_refresh_errors_total` artıyor mu? Log: `{service="backend"} |~ "OPS-1107"` — "İş metrikleri yenilenemedi" hatası (genellikle DB).
2. DB erişimi: [PostgresDown](database.md#postgresdown), [DbPoolSaturated](database.md#dbpoolsaturated). Sorgu yavaşlığı: `getBusinessMetricsSnapshot` uzun sürüyor mu?
3. Backend'in kendisi düşmüş olabilir (BackendDown).

### Müdahale
Kök nedeni (DB/havuz) giderin; backend yeniden başlatma yenileyiciyi sıfırlar (`./scripts/zero-downtime-deploy.sh`).

### Doğrulama
`time() - yakit_business_metrics_last_refresh_timestamp_seconds` < 60.

### Eskalasyon
DB sorunuysa DB sorumlusu; yenileyici kodu hatalıysa geliştirici ekip.

## LogPipelineDown

### Etki
Loki erişilemiyor: yeni loglar toplanmıyor/aranamıyor (uygulama etkilenmez; hata ayıklama ve denetim kanıtı riski).

### Tanı
`docker compose ps loki promtail`; `docker compose logs --tail 50 loki` — disk dolu (`no space left`), bozuk indeks, bellek; promtail bağlantı hatası.

### Müdahale
Disk doluysa [DiskSpace](infrastructure.md#diskspace); `docker compose up -d loki promtail`. Promtail kayıtları konum dosyasından devam eder; kısa kesintide log kaybı olmaz (Docker log tamponu).

### Doğrulama
Grafana → Loki `{service="backend"}` son dakikanın loglarını gösterir.

### Eskalasyon
Mesai içinde çözülmezse teknik sorumlu.
