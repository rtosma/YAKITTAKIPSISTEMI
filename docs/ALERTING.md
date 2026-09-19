# Uyarılar (Alerting), Nöbet ve Runbook'lar (OPS-1108)

Amaç: sorunun **müşteri tarafından değil ekip tarafından önce** fark edilmesi. Metrikler ve dashboard'lar: [OBSERVABILITY.md](OBSERVABILITY.md).
Yığın: Prometheus kuralları → **Alertmanager** → nöbet/ekip kanalları (Telegram, e-posta, webhook). Her uyarının **runbook**'u vardır ([runbooks/](runbooks/)).

## 1. Mimari

```
Prometheus (kurallar: deploy/monitoring/rules/*.yml, 30 sn değerlendirme)
   └─► Alertmanager (yönlendirme, gruplama, bastırma, susturma) ─► oncall  (critical)  Telegram nöbet grubu + e-posta + webhook (PagerDuty/Opsgenie)
                                                              ├─► team    (warning)   Telegram ekip grubu + e-posta   [gece 23:00-07:00 susturulur]
                                                              ├─► null    (info)      bildirim YOK — panoda görünür
                                                              └─► heartbeat (Watchdog) ─► dış "ölü adam" servisi (ALERT_HEARTBEAT_URL)
```

Etkinleştirme: `docker-compose.monitoring.yml` (bkz. OBSERVABILITY.md). **Nöbet kanalı zorunludur**: `alertmanager-config` servisi, kanalsız yapılandırmayı reddeder
(çıkış 1 → Alertmanager başlamaz). Kanalsız bir izleme yığını "uyarılar çalışıyor" izlenimi verip sessizce hiçbir şey göndermez — bunu bilerek imkânsız kıldık.
Geliştirmede `ALERT_ALLOW_NO_CHANNELS=true`.

## 2. Şiddet seviyeleri ve nöbet kanalları

| Şiddet | Anlamı | Kim / ne zaman | Kanal | Tekrar | Gruplama bekleme |
|---|---|---|---|---|---|
| **critical** | Müşteri/veri **şu an** etkileniyor veya birkaç dakika içinde etkilenecek (uptime, hata oranı, DB/disk dolması, RPO ihlali, sahada yaygın kesinti) | **Nöbetçi, 7/24, hemen** (gece dahil) | `oncall`: Telegram nöbet grubu + e-posta + webhook | 1 saat | 30 sn |
| **warning** | Bozulma var ama acil değil; ihmal edilirse critical olur | Ekip, **mesai içinde**; gece **susturulur**, sabah tekrar bildirilir | `team`: Telegram ekip grubu + e-posta | 12 saat | 2 dk |
| **info** | Bilgi/eğilim (ürün içi alarm kuyruğu vb.) | Panoda bakılır | bildirim **yok** | — | — |
| `Watchdog` | Hat canlı kanıtı (her zaman ateşler) | Dış servis izler | `heartbeat` | 5 dk | 0 sn |

Ortam değişkenleri (kök `.env`; **sırlar `*_file` olarak Alertmanager'a aktarılır, yapılandırmaya yazılmaz**):

| Değişken | Açıklama |
|---|---|
| `ALERT_TELEGRAM_BOT_TOKEN`, `ALERT_TELEGRAM_CHAT_ONCALL`, `ALERT_TELEGRAM_CHAT_TEAM` | Telegram botu ve iki grup (sayısal chat kimliği) |
| `ALERT_SMTP_HOST` (host:port), `ALERT_SMTP_FROM`, `ALERT_SMTP_USER`, `ALERT_SMTP_PASSWORD`, `ALERT_EMAIL_ONCALL`, `ALERT_EMAIL_TEAM` | E-posta (virgülle çoklu alıcı) |
| `ALERT_WEBHOOK_URL_ONCALL`, `ALERT_WEBHOOK_URL_TEAM` | Genel webhook (PagerDuty/Opsgenie/Slack köprüsü) |
| `ALERT_HEARTBEAT_URL` | Watchdog kalp atışı (healthchecks.io / Dead Man's Snitch); **tanımlanması şiddetle önerilir** |
| `ALERT_ALLOW_NO_CHANNELS`, `ALERT_TIMEZONE` (Europe/Istanbul), `ALERT_MUTE_WARNINGS_NIGHT` (true) | Geliştirme/saat dilimi/gece susturma |

Ekip (warning) kanalı tanımsızsa warning'ler nöbet kanallarına gider (sessizlikten iyidir; render uyarı yazar).

**Nöbet düzeni (öneri):** haftalık rotasyon, birincil + yedek nöbetçi; nöbetçi bildirimi Telegram'da "ack" ile üstlenir, 15 dk içinde üstlenmezse yedek aranır;
her critical uyarı sonrası kısa olay notu (ne oldu / ne yaptık / kalıcı düzeltme) tutulur. Telefon numaraları/rotasyon takvimi bu depoya değil ekip aracına (kasa/wiki) yazılır.

## 3. Uyarı yorgunluğunu önleme

1. **Gruplama:** `group_by: [alertname, severity]` — aynı uyarı türünün birçok örneği (3 disk bölümü, birden çok replika) **tek bildirim**dir (canlı tatbikatla doğrulanır).
2. **Oran bazlı saha uyarıları:** cihaz uyarısı tek tek cihaz değil **çevrimdışı oranı**dır (%30/%50; ≥5 cihazda). Tek cihaz arızası sayfalanmaz; ayrıntı rep-717'dedir.
3. **`for` süreleri** geçici dalgalanmayı eler (kritikte 2–5 dk, warning'de 10–30 dk); oran kuralları **asgari trafik** korumalıdır (düşük trafikte tek 500 = %100 hata olmasın).
4. **İki kademeli eşik:** aynı `alertname` warning (erken) + critical (ağır); critical gelince warning **bastırılır** (tek olay iki bildirim üretmez).
5. **Kök neden bastırma (inhibit):** `BackendDown/BackendMissing` → API ve saha belirti uyarıları; `PostgresDown` → DB/API belirtileri; `DiskSpace`(critical) → `DiskWillFillSoon`.
6. **Gece susturma:** warning'ler 23:00–07:00 arası gönderilmez (hâlâ ateşliyorsa sabah bildirilir); critical asla susturulmaz.
7. **Info** bildirim üretmez. **Eşik gözden geçirme:** bir uyarı ayda ≥3 kez "eylem gerektirmeden" kapanıyorsa eşik/`for` gevşetilir veya info'ya çekilir (olay notlarından).

## 4. Uyarı kataloğu

| Alan | Uyarılar (critical/warning) | Runbook |
|---|---|---|
| API/uptime | `ApiErrorRate` (%2 w / %10 c), `ApiLatencyP95` (1 sn w / 3 sn c), `EventLoopLag`, `BackendDown` (c), `BackendMissing` (c), `BackendMemoryHigh` | [api.md](runbooks/api.md) |
| Veritabanı | `DbPoolSaturated` (w/c), `PostgresConnectionsHigh` (%80 w / %90 c), `PostgresDown` (c) | [database.md](runbooks/database.md) |
| Altyapı | `DiskSpace` (%85 w / %95 c), `DiskWillFillSoon`, `HostMemoryLow`, `HostCpuHigh` | [infrastructure.md](runbooks/infrastructure.md) |
| Saha | `DevicesOfflineRatio` (%30 w / %50 c), `NoActiveDevices`, `DespatchQueueBacklog`, `DespatchQueueStuck`, `DespatchDeadLetter` (DLQ), `NotificationRetryBacklog`, `NotificationWebhookCircuitOpen` (devre kesici), `MqttRejectSpike`, `MqttProcessingErrors`, `CriticalFieldAlarmsOpen` (info) | [field.md](runbooks/field.md) |
| İzleme hattı | `Watchdog`, `ScrapeTargetDown`, `BusinessMetricsStale`, `LogPipelineDown` | [monitoring.md](runbooks/monitoring.md) |
| Yedekleme | `BackupTooOld` (c), `BackupMetricsMissing`, `WalShippingStalled` (c, RPO), `WalSpoolBacklog` | [backup.md](runbooks/backup.md) |

**Eşleme notları (ticket → mevcut sistem):** "DLQ derinliği" = kalıcı başarısız e-İrsaliye iletimleri (`yakit_despatch_queue{status="FAILED"}`; BullMQ/DLQ yok — otomatik yeniden denenmeyen terminal durum).
"Entegratör devre kesici açık" = bildirim webhook devre kesicisi (`yakit_notification_circuit_open`, NOTIF-1604) — e-İrsaliye entegratörü için ayrı bir devre kesici **yoktur**;
eşdeğer sinyal `DespatchQueueStuck` + `DespatchDeadLetter`'dır (iletim ilerlemiyor / kalıcı hata).

## 5. Runbook'lar

Her uyarının `runbook_url` açıklaması bildirimde gelir ve [runbooks/](runbooks/) altındaki ilgili başlığa götürür. Her runbook başlığı beş bölümdür: **Etki** (kim/ne etkileniyor),
**Tanı** (nereye bakılır — panel, log sorgusu, SQL, komut), **Müdahale** (güvenli adımlar; geri dönülmez işlemler uyarılır), **Doğrulama** (düzeldiğinin kanıtı), **Eskalasyon** (kime, ne zaman).
CI, her uyarının runbook dosyası + başlığı + beş bölümü içerdiğini doğrular; runbook'suz uyarı **eklenemez**.

## 6. Test ve tatbikat (AC: "kritik durumlar için uyarı kuralları tanımlı ve test edilmiş")

"Hiç tetiklenmemiş bir kural çalıştığının kanıtı değildir" — iki katman:

1. **Birim testi (promtool, CI'da):** `deploy/monitoring/tests/alerts.test.yml` her kuralı **gerçek `for` süreleriyle** ateşletir ve eşik altında sessiz bırakır (asgari trafik, küçük filo, `for` dolmadan, tmpfs…);
   doğru şiddet/etiket/açıklama/runbook_url ile ateşlediğini de doğrular. Dosya `alert-scenarios.mjs` + kurallardan **üretilir** (elle düzenlenmez; CI drift'i yakalar).
2. **Canlı tatbikat (bildirim zinciri, `node scripts/test-ops1108.mjs --live`):** yalıtılmış geçici bir Prometheus + Alertmanager + sahte exporter/webhook alıcısı ayağa kalkar; **kritik uyarıların hepsi yapay olarak tetiklenir**
   (aynı gerçek kurallar; yalnızca `for` ve Alertmanager bekleme süreleri saniyelere indirilir) ve şu doğrulanır: her critical `oncall` alıcısına ulaştı (şiddet, runbook_url dahil), warning'ler `team`'e,
   info hiç gitmedi, critical→warning ve BackendDown→belirti bastırması çalışıyor, 3 disk bölümü **tek** bildirimde gruplandı, çözülünce "resolved" geldi, Watchdog kalp atışı akıyor.
   Ayrıca gerçek kanal (Telegram/e-posta) için manuel tatbikat: staging'de `amtool alert add TestAlert severity=critical summary=tatbikat` ile nöbet zincirini çeyrekte bir deneyin (nöbetçi ack süresini not edin).

## 6b. Susturma (silence)

Planlı bakım için Alertmanager'da susturma açın (kapsam **dar** ve **süreli**; gerekçe yorumu zorunlu):
`docker compose exec alertmanager amtool silence add alertname=~"Devices.*" --duration=2h --comment="OPS-xxxx planlı saha bakımı" --author=$USER --alertmanager.url=http://localhost:9093`.
Süresiz/geniş (`alertname=~".+"`) susturma yapılmaz.

## 7. Yeni uyarı ekleme kontrol listesi

1. Kural: `deploy/monitoring/rules/<alan>.yml` — `severity`, `domain`, `summary`, `description`, `runbook_url`, gerekçeli `for`; oran kurallarında asgari trafik/filo koruması.
2. Senaryo: `scripts/monitoring/alert-scenarios.mjs` — ateşleme + en az bir sessiz durum → `node scripts/monitoring/generate-rule-tests.mjs`.
3. Runbook: `docs/runbooks/<alan>.md` içine `## <AlertName>` + beş bölüm.
4. Metrik yeniyse [OBSERVABILITY.md](OBSERVABILITY.md) kataloğu ve kardinalite politikası.
5. `node scripts/test-ops1108.mjs` (ve kritikse `--live`) yeşil.

## 8. Bilinen sınırlar

- Uyarı bildirimleri **kendi altyapımız** üzerinden gider; tüm sunucu/ağ çöktüğünde Alertmanager de gidebilir — bu yüzden `Watchdog` **dış** kalp atışı servisine bağlanmalıdır (`ALERT_HEARTBEAT_URL`); bağlı değilse render uyarı verir.
- Cihaz/şantiye bazlı uyarı **yoktur** (kardinalite politikası); şantiye kırılımı rep-717 ve iş dashboard'undadır.
- Blackbox (dışarıdan HTTP) probe yoktur: uptime `up{job="backend"}` + `BackendMissing` ile ölçülür; DNS/TLS/CDN sorunları için harici bir uptime servisi (ör. UptimeRobot) önerilir.
- Grafana Alerting kullanılmaz (tek doğruluk kaynağı Prometheus kuralları + Alertmanager); Grafana yalnızca panolarda gösterir.
