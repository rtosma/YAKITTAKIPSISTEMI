# Runbook — Saha uyarıları (cihaz, e-İrsaliye, bildirim, MQTT)

> Genel kurallar: [ALERTING.md](../ALERTING.md). Metrikler **platform toplamıdır** (tenant/şantiye etiketi yok — kardinalite politikası): kırılım için
> Grafana "Yakıt Takip — İş Özeti", cihaz raporu **rep-717** (`/reports/rep-717`, `rep-717-kesinti`), e-İrsaliye raporu **rep-721** (`/reports/rep-721?attention=TAKILI`) kullanılır.

## DevicesOfflineRatio

### Etki
Kayıtlı cihazların %30'undan (warning) / %50'sinden (critical) fazlası çevrimdışı. Tek tek cihaz arızasından çok **ortak neden** (broker, ağ, sahada elektrik/GSM, dağıtım) olasıdır; çevrimdışı cihazlar ikmali yerelde tamponlar (IOT-303) ama anlık kota/yetkilendirme çalışmaz.

### Tanı
1. Grafana iş dashboard'u "Çevrimdışı" + teknik dashboard "MQTT mesaj hızı": mesaj hızı da sıfıra yakın mı? Öyleyse broker/backend sorunu.
2. `docker compose ps emqx` / `docker compose logs --tail 100 emqx`; backend log'unda MQTT bağlantı hataları (`{service="backend"} |~ "MQTT"`).
3. Şantiye kırılımı: **rep-717-kesinti** (`?ongoing=1`) — kesinti tek şantiyede mi yoğunlaşıyor? Tek şantiye = saha altyapısı (GSM/elektrik) → saha sorumlusu.
4. Yakın zamanda firmware rollout (IOT-306) veya dağıtım yapıldı mı?

### Müdahale
- Broker/backend kaynaklıysa: `docker compose restart emqx` (önce logdan nedeni anlayın), backend MQTT yeniden bağlanır.
- Saha kaynaklıysa ilgili şantiye yöneticisini arayın (SITE_MANAGER); ikmaller çevrimdışı senkronla sonradan gelir.
- Firmware rollout kaynaklıysa rollout'u durdurun/geri alın (`/firmware-rollouts/:id` — IOT-306).

### Doğrulama
Çevrimdışı oranı < %10 (10 dk); rep-717-kesinti'de süren kesinti sayısı düştü.

### Eskalasyon
Critical (>%50): teknik sorumlu + operasyon yöneticisi anında; saha genelinde ikmal yetkilendirme kesintisidir.

## NoActiveDevices

### Etki
Kayıtlı cihaz var ama 30 dk'dır **hiçbiri** telemetri göndermedi (son 10 dk içinde görülen cihaz = 0): saha filosu veya MQTT hattı tamamen sessiz.

### Tanı
1. Gece/hafta sonu düşük aktivite olabilir mi (şantiye mesai dışı)? Mesai dışıysa cihazlar telemetri göndermeyebilir — `site_working_hours` (AI-504) kontrol edin; sürekli gürültü ise uyarı eşiği/`for` gözden geçirilmelidir.
2. [DevicesOfflineRatio](#devicesofflineratio) tanısı: MQTT hız paneli, EMQX durumu.
3. `yakit_business_metrics_last_refresh_timestamp_seconds` bayat mı ([BusinessMetricsStale](monitoring.md#businessmetricsstale))? Bayat veri yalancı sıfır gösterebilir.

### Müdahale
EMQX/backend MQTT bağlantısını doğrulayıp gerekirse yeniden başlatın; test için bir cihazı elle (ör. `test_mqtt.js`) yayınlatın.

### Doğrulama
En az bir cihaz "aktif"; MQTT mesaj hızı > 0.

### Eskalasyon
Mesai saatlerinde 1 saati aşarsa teknik sorumlu + saha operasyon.

## DespatchQueueBacklog

### Etki
e-İrsaliye iletim kuyruğunda (QUEUED) birikme: yasal belgeler entegratöre gitmiyor; gecikme mevzuat/muhasebe riski (200+ = critical).

### Tanı
1. `GET /api/v1/despatch-advice-transmissions?status=QUEUED` (COMPANY_OWNER); rep-721 `attention=TAKILI`.
2. Süpürücü çalışıyor mu? Backend log'u: `{service="backend"} |~ "COMP-602"`; `yakit_despatch_oldest_queued_age_seconds` artıyor mu ([DespatchQueueStuck](#despatchqueuestuck)).
3. Entegratör tarafı: MockGibIntegrator yerine gerçek sağlayıcı bağlıysa sağlayıcı durum sayfası/erişilebilirlik.

### Müdahale
- Süpürmeyi elle tetikleyin: `POST /api/v1/despatch-advice-transmissions/sweep` (SUPER_ADMIN/COMPANY_OWNER); kuyruk erimiyorsa nedeni log'da arayın.
- Entegratör kesintisindeyse bekleyin (5 denemeye kadar otomatik yeniden dener) ve muhasebeyi bilgilendirin; kalıcı başarısızlar [DespatchDeadLetter](#despatchdeadletter).

### Doğrulama
QUEUED sayısı düşüyor; en eski yaş < 15 dk.

### Eskalasyon
Critical (>200): teknik sorumlu + muhasebe sorumlusu (yasal bildirim gecikmesi).

## DespatchQueueStuck

### Etki
Kuyruktaki **en eski** e-İrsaliye 30 dk (warning) / 60 dk (critical) dır gönderilemedi: iletim ilerlemiyor — entegratör erişilemez veya süpürücü durmuş.

### Tanı
1. Backend çalışıyor mu (BackendDown yoksa)? Süpürücü her ~1 dk çalışır (index.ts); log: `{service="backend"} |~ "despatch|COMP-602"`.
2. En eski kayıt: `SELECT id, document_number, status, attempt_count, last_error, queued_at FROM despatch_advice_transmissions WHERE status IN ('QUEUED','SENDING') ORDER BY queued_at LIMIT 10;` — `SENDING`'te takılı mı (süpürücü yarıda kalmış)? `last_error` ne diyor?
3. Entegratör adaptörü hatası mı (kimlik/ağ) yoksa belge içeriği (XSD) mi?

### Müdahale
- `POST /despatch-advice-transmissions/sweep` ile tetikleyin.
- `SENDING`'te uzun süre takılı kayıt: backend yeniden başlatıldıysa süpürücü sonraki turda toparlar; toparlamazsa geliştirici ekibe iş açın (durum makinesi).
- Entegratör kesintisi: sağlayıcıyla iletişime geçin; belgeler kaybolmaz (kuyrukta kalır).

### Doğrulama
`yakit_despatch_oldest_queued_age_seconds` düşer; rep-721'de TAKILI belge kalmaz.

### Eskalasyon
Critical: teknik sorumlu; > 4 saatte muhasebe bilgilendirilir (yasal süre).

## DespatchDeadLetter

### Etki
Kalıcı başarısız (5 deneme sonrası `FAILED`) e-İrsaliye var — bu bir **DLQ**'dur: otomatik yeniden denenmez, insan müdahalesi gerekir. >10 sistemik sorun demektir.

### Tanı
1. rep-721: `/reports/rep-721?attention=GONDERIM_HATASI` (belge no, alıcı, hata).
2. `SELECT document_number, last_error, attempt_count FROM despatch_advice_transmissions WHERE status='FAILED' ORDER BY updated_at DESC LIMIT 20;` — hata ortak mı (aynı entegratör mesajı → sistemik) yoksa belge bazlı mı (alıcı VKN/XSD)?
3. Alıcı e-İrsaliye mükellefi değilse KAĞIT süreç (COMP-605) — bu bir hata değil, akış.

### Müdahale
- Sistemik neden giderildikten sonra belgeleri yeniden gönderin: `POST /transactions/:id/e-irsaliye/resubmit` (COMP-603; YENİ belge no ile düzeltme belgesi).
- Belge bazlı hata: alıcı bilgisini düzeltin, muhasebeyle koordine edip resubmit/iptal edin (`/e-irsaliye/cancel`).

### Doğrulama
FAILED sayısı 0; rep-721'de "GÖNDERİM HATASI" kalmadı.

### Eskalasyon
Critical (>10): teknik sorumlu + muhasebe; yasal bildirim yükümlülüğü izlenir.

## NotificationRetryBacklog

### Etki
Yeniden deneme bekleyen (BAŞARISIZ) bildirim sayısı > 100: e-posta/SMS/Telegram/webhook sağlayıcısı sorunlu — kritik uyarıların müşteriye ulaşması gecikir.

### Tanı
1. `SELECT channel, count(*) FROM notifications WHERE status='BAŞARISIZ' GROUP BY 1;` — tek kanal mı (ör. yalnızca EMAIL)?
2. SMTP/SMS yapılandırması (`SMTP_*`, `SMS_PROVIDER_*`); sağlayıcı kesintisi; backend log'u `{service="backend"} |~ "NOTIF-160"`.
3. Süpürücü (NOTIF-1601, saatlik/dakikalık) çalışıyor mu?

### Müdahale
Sağlayıcı/yapılandırmayı düzeltin; kayıtlar otomatik yeniden denenir (üst sınıra kadar). Kalıcı düşenler için kullanıcıya alternatif kanalla (IN_APP) duyuru yapın.

### Doğrulama
Kuyruk azalıyor; yeni bildirimler `GÖNDERİLDİ`.

### Eskalasyon
Kritik alarm bildirimlerini etkiliyorsa (NOTIF-1606 eskalasyon) teknik sorumlu.

## NotificationWebhookCircuitOpen

### Etki
Bir veya daha fazla tenant'ın bildirim **webhook'u devre kesici nedeniyle otomatik devre dışı** (ardışık başarısızlık, NOTIF-1604): o müşteriye webhook bildirimleri gitmiyor. Genellikle **müşteri tarafındaki** uç nokta erişilemez/yanlış.

### Tanı
1. `SELECT tenant_id, webhook_url, webhook_consecutive_failures, webhook_disabled_at FROM tenant_notification_channels WHERE webhook_disabled_at IS NOT NULL;`
2. `GET /api/v1/notifications/channels` (tenant yöneticisi) devre kesici durumunu gösterir.
3. Müşterinin uç noktası cevap veriyor mu (`curl -sI <webhook_url>` — URL'yi loglara/sohbete yapıştırmayın, sır içerebilir).

### Müdahale
Müşteriyi bilgilendirin (webhook adresi/sırrı düzeltmesi); müşteri webhook'u yeniden kaydedince devre kesici sıfırlanır (`PUT /notifications/channels`). Bu uyarı **acil değildir** (warning, mesai içi).

### Doğrulama
`yakit_notification_circuit_open` = 0.

### Eskalasyon
Müşteri yanıt vermiyorsa hesap sorumlusu.

## MqttRejectSpike

### Etki
Uygulama seviyesinde reddedilen MQTT mesajı hızı yüksek (> 1/sn): kayıtsız/bloke cihaz veya **sahte cihaz/tenant sahtekarlığı denemesi** (IOT-304).

### Tanı
1. Grafana "Reddedilen / hata": neden dağılımı — `unregistered_device` (yanlış yapılandırılmış/çalıntı cihaz), `blocked_device` (bloke cihaz hâlâ yayın yapıyor), `tenant_mismatch` (**güvenlik**).
2. Loki: `{service="backend"} |~ "IOT-304"` — cihaz kimlikleri ve topic'ler.
3. `tenant_mismatch` görüyorsanız kimlik bilgilerinin sızıp sızmadığını değerlendirin.

### Müdahale
- Kayıtsız cihaz: envanteri kontrol edin (yeni cihaz claim edilmedi mi — IOT-304).
- Bloke cihaz: fiziksel olarak devre dışı bırakın; sürekli yayın yapıyorsa şantiyeyi arayın.
- `tenant_mismatch` veya kötü niyet şüphesi: MQTT kimlik bilgilerini (`MQTT_PASSWORD`) döndürün ([SECRETS.md](../SECRETS.md)) ve güvenlik sorumlusunu bilgilendirin.

### Doğrulama
Grafana "Reddedilen / hata" paneli 10 dk boyunca `sum(rate(yakit_mqtt_rejected_total[5m]))` < 0.1/sn; `MqttRejectSpike` resolved bildirimi gelir; `tenant_mismatch` hiç artmıyor.

### Eskalasyon
`tenant_mismatch` ise güvenlik sorumlusu **aynı gün**.

## MqttProcessingErrors

### Etki
MQTT mesajları işlenirken hata alınıyor (> 0.1/sn): telemetri/durum verisi kaybolabilir (tank seviyesi, presence).

### Tanı
1. Loki: `{service="backend", level="error"} |~ "MQTT"` — hata mesajı ve payload.
2. Tek cihaz mı (bozuk firmware payload'ı, IOT-303.3 doğrulama) yoksa tümü mü (DB hatası: [DbPoolSaturated](database.md#dbpoolsaturated))?
3. Yakın zamanda firmware/şema değişikliği?

### Müdahale
Hatanın kaynağı bozuk cihazsa o cihazı inceleyin/bloke edin; DB kaynaklıysa ilgili runbook. Kod hatası ise geliştirici ekibe iş açın (payload örneğiyle).

### Doğrulama
`yakit_mqtt_processing_errors_total` artışı durur.

### Eskalasyon
Kalıcıysa geliştirici ekip.

## CriticalFieldAlarmsOpen

### Etki
Ürün içi (AI-507) **açık KRİTİK saha alarmı** sayısı > 20 ve düşmüyor: operasyon ekibi alarm kuyruğunu işlemiyor olabilir. Bu bir **altyapı** arızası değildir; bilgi (info) seviyesidir, sayfalama yapılmaz.

### Tanı
1. Grafana iş dashboard'u "Açık alarmlar"; rep-716 (`/reports/rep-716?status=OPEN,ACKNOWLEDGED,INVESTIGATING`) ile tipe göre kırılım.
2. Tek bir kök neden mi alarm yağmuru üretiyor (ör. bir şantiyenin tank seviyesi sensörü)? `rep-716-tip`.
3. Eskalasyon (NOTIF-1606) çalışıyor mu?

### Müdahale
İlgili şantiye yöneticilerine sahip oldukları alarmları hatırlatın; toplu yanlış-pozitifleri kapatın (`FALSE_POSITIVE`, AI-507 geri bildirimi).

### Doğrulama
Açık kritik alarm sayısı < 10.

### Eskalasyon
Operasyon yöneticisi (ürün içi süreç).
