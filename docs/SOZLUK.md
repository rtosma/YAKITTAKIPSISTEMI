# Terim sözlüğü (Yakıt Takip Sistemi)

**Amaç:** gömülü, backend, frontend, saha ve muhasebe ekiplerinin aynı terimi aynı anlamda kullanması.
**Kural:** kod ve tanımlayıcılar **İngilizce**, konuşma ve belgeler **Türkçe**dir; bu yüzden her terim iki dilde verilir. Her terimin **projede nerede geçtiği** belirtilir (dosya/dizin yolları gerçektir ve CI'da doğrulanır).
Rehber: [PROJE-REHBERI.md](PROJE-REHBERI.md) — rehberde terimler **ilk geçtikleri yerde** bu sözlüğe bağlanır. Eksik terim mi var? Bu dosyaya ekleyin (tablo satırı + `<a id>`); test biçimi denetler.

**İçindekiler:** [Teknik](#teknik-terimler) · [Güvenlik ve işletme](#güvenlik-ve-işletme-terimleri) · [İş (saha ve muhasebe)](#iş-terimleri) · [Donanım](#donanım-terimleri) · [Kısaltmalar](#kısaltmalar)

---

## Teknik terimler

| Terim (TR) | English | Tanım | Projede nerede |
|---|---|---|---|
| <a id="k-factor"></a>**K-faktör** | K-factor | Akışmetrenin **pals / litre** katsayısı. Yanlışsa tüm ikmaller aynı oranda sapar. Uzaktan değiştirilir: komut → cihaz uygular → **ACK** ile onaylar; %20'yi aşan değişiklik ikinci onay ister. | `backend/src/db/tenantDb.ts` (kalibrasyon), `backend/src/reports/definitions/rep718CalibrationHistory.ts`, `docs/SAHA_KURULUM.md` §4.6 |
| <a id="totalizator"></a>**Totalizatör** | Totalizer (cumulative meter) | Akışmetrenin **toplam geçen hacim** sayacı (litre, sürekli artar). İkmal litresi = bitiş − başlangıç totalizatörü; cihazın bildirdiği miktarla farkı > %1 ise kayıt otomatik "doğrulandı" sayılmaz. | `backend/src/schemas/dispenseSessionSchema.ts`, `backend/src/db/tenantDb.ts` (finalize), `docs/HARDWARE_INTEGRATION_GUIDE.md` §9 |
| <a id="strapping-table"></a>**Boylama tablosu** | Strapping table | Tankın **seviye (mm) → hacim (litre)** dönüşüm tablosu; silindirik/eğimli tankta doğrusal olmayan ilişkiyi hesaplar. Ultrasonik seviye ölçümü litreye bununla çevrilir. | `backend/src/schemas/strappingTableSchema.ts`, `backend/src/db/schema.sql` (`tank_strapping_tables`) |
| <a id="hypertable"></a>**Hypertable** | Hypertable (TimescaleDB) | Zaman serisi verisini otomatik parçalara (chunk) bölen TimescaleDB tablosu; sıkıştırma ve saklama politikası uygular. **Projede henüz kurulu değil** (ARCH-103 planı). | `docs/PROJE-REHBERI.md` §9.2, `docs/DATA_RETENTION.md` |
| <a id="rls"></a>**Satır düzeyi güvenlik (RLS)** | Row-Level Security (RLS) | PostgreSQL'in her satırı tenant'a göre **veritabanı düzeyinde** filtrelemesi. Uygulama `WHERE tenant_id` unutsa bile başka firmanın verisi görünmez. | `backend/src/db/schema.sql` (`ENABLE/FORCE ROW LEVEL SECURITY`), `backend/src/db/withTenant.ts`, `scripts/check-rls-coverage.mjs` |
| <a id="tenant"></a>**Kiracı (tenant) / firma** | Tenant (customer company) | Sistemi kullanan **bir müşteri firması** ve verisi; çok kiracılı (multi-tenant) SaaS'ta firmalar birbirinden yalıtılır. Tablolarda `tenant_id`, kodda `companies` tablosu. | `backend/src/context/tenantContext.ts`, `backend/src/db/schema.sql` (`companies`) |
| <a id="idempotency"></a>**Tekrarlanabilirlik güvencesi (idempotency)** | Idempotency | Aynı isteğin **birden çok kez** gönderilmesinin sonucu değiştirmemesi. İkmalde `(device_id, local_sequence_id)` DB'de benzersizdir: aynı kayıt yeniden gelirse `DUPLICATE_SKIPPED`, ikinci mali kayıt oluşmaz. | `backend/src/db/schema.sql` (`transactions`), `backend/src/db/tenantDb.ts` (`syncOfflineDispenseBatch`), `docs/CHAOS_TESTING.md` |
| <a id="sync-batch"></a>**Toplu senkron** | Sync batch | Çevrimdışı biriken ikmallerin bağlantı gelince tek istekle (≤ 5000 kayıt) gönderilmesi; yanıt kayıt bazlıdır (`ACCEPTED`/`DUPLICATE_SKIPPED`/`ERROR`). | `backend/src/routes/routes.ts` (`/telemetry/sync-batch`), `docs/HARDWARE_INTEGRATION_GUIDE.md` §7 |
| <a id="heartbeat"></a>**Kalp atışı (heartbeat)** | Heartbeat | İkmal sırasında cihazın ~5 sn'de bir gönderdiği "yaşıyorum + totalizatör/debi" mesajı. 15 sn gelmezse oturum düşürülür. | `backend/src/services/dispenseSessionService.ts` (`HEARTBEAT_TIMEOUT_MS`), `docs/HARDWARE_INTEGRATION_GUIDE.md` §9.2 |
| <a id="dispense-session"></a>**İkmal oturumu** | Dispense session | Kart okutmadan sonlandırmaya kadar süren **durum makinesi** (AUTHORIZED → PUMPING → tamamlandı/iptal); Redis'te tutulur, replikalar arası paylaşılır (30 dk TTL). | `backend/src/services/dispenseSessionService.ts`, `docs/PROJE-REHBERI.md` §3.4 |
| <a id="presence"></a>**Çevrimiçi durum (presence)** | Presence | Cihazın ONLINE/OFFLINE bilgisi; ONLINE **10 sn TTL** ile Redis'te tutulur, mesaj gelmezse kendiliğinden OFFLINE olur. | `backend/src/db/redisPool.ts` (`DEVICE_PRESENCE_TTL_SECONDS`), `docs/HARDWARE_INTEGRATION_GUIDE.md` §3.4 |
| <a id="lwt"></a>**Son vasiyet mesajı (LWT)** | Last Will and Testament (MQTT) | Cihaz bağlanırken broker'a bıraktığı mesaj; bağlantı **ansızın** koparsa broker onu yayınlar (`OFFLINE`) — panel anında görür. | `backend/src/iot/mqttClient.ts`, `docs/HARDWARE_INTEGRATION_GUIDE.md` §3.4 |
| <a id="mqtt"></a>**MQTT** | MQTT (message queuing telemetry transport) | Cihazlar için hafif yayın/abone mesajlaşma protokolü; sistemde EMQX broker'ı, v5, QoS 1. Topic: `telemetry/v1/{tenant}/{site}/{tip}/{cihaz}/data`. | `backend/src/iot/mqttClient.ts`, `docker/emqx/`, `docs/PROJE-REHBERI.md` §8 |
| <a id="shared-subscription"></a>**Paylaşımlı abonelik** | Shared subscription (`$share`) | Aynı abone grubundaki birden çok backend kopyasının bir topic'i **paylaşması**; her mesaj yalnızca **bir** kopyaya gider (dağıtımda çift işleme olmaz). | `backend/src/iot/mqttClient.ts`, `docs/DEPLOY_ROLLBACK.md` §3 |
| <a id="qos"></a>**Hizmet kalitesi (QoS)** | Quality of Service (MQTT QoS 0/1/2) | MQTT teslim garantisi seviyesi. Sistem **QoS 1** ("en az bir kez") kullanır; tekrar teslim ihtimali idempotency ile karşılanır. | `docs/HARDWARE_INTEGRATION_GUIDE.md` §3.1 |
| <a id="ota"></a>**Havadan güncelleme (OTA)** | Over-the-air update (OTA) | Cihaz yazılımının uzaktan güncellenmesi. Sunucu tarafı dağıtım/geri alma takibi vardır; A/B bölümü ve geri dönüş firmware'e aittir (FW-1311). | `backend/src/services/firmwareRolloutService.ts`, `backend/src/db/schema.sql` (`firmware_rollouts`) |
| <a id="event-bus"></a>**Olay yolu (event bus)** | Event bus (`ioTEventBus`) | Telemetrinin süreç içinde yayılması: MQTT/webhook → olay → Socket.io canlı yayını ve anomali motoru. | `backend/src/iot/mqttClient.ts`, `backend/src/socket/socketServer.ts` |
| <a id="websocket"></a>**WebSocket (Socket.io)** | WebSocket (Socket.io) | Tarayıcıya **canlı** veri itme kanalı; JWT ile el sıkışır, her tenant kendi odasına (`tenant:{id}`) katılır. Dağıtımda bağlantılar kademeli koparılır. | `backend/src/socket/socketServer.ts`, `frontend/src/utils/socket.ts` |
| <a id="async-local-storage"></a>**AsyncLocalStorage** | AsyncLocalStorage (Node.js) | Bir isteğin **tenant/kullanıcı bağlamını** çağrı zinciri boyunca taşıyan Node.js mekanizması; `withTenant()` bunu RLS'e aktarır. | `backend/src/context/tenantContext.ts`, `backend/src/db/withTenant.ts` |
| <a id="backoff"></a>**Üstel geri çekilme (exponential backoff)** | Exponential backoff | Hata sonrası yeniden denemeler arasındaki süreyi katlayarak artırma (yük altındaki sunucuyu boğmamak için). Cihaz, MQTT istemcisi ve tarayıcı Socket.io'su kullanır. | `backend/src/iot/mqttClient.ts`, `frontend/src/utils/socket.ts` |
| <a id="circuit-breaker"></a>**Devre kesici** | Circuit breaker | Sürekli hata veren dış servise istek göndermeyi **geçici durdurup** sistemi koruyan desen (e-İrsaliye entegratörü, bildirim webhook'ları). | `backend/src/db/tenantDb.ts`, `backend/src/notifications/`, `backend/src/observability/metrics.ts` |
| <a id="dead-letter"></a>**Ölü mektup (dead letter)** | Dead-letter queue (DLQ) | Belirli deneme sayısından sonra **kalıcı başarısız** olan iş/bildirim/iletimin ayrı tutulup elle incelenmesi (`KALICI_BAŞARISIZ`). | `backend/src/db/schema.sql` (`notifications`, `despatch_advice_transmissions`), `docs/runbooks/field.md` |

## Güvenlik ve işletme terimleri

| Terim (TR) | English | Tanım | Projede nerede |
|---|---|---|---|
| <a id="hmac"></a>**HMAC imzası** | HMAC (hash-based message authentication code) | Gizli anahtarla üretilen kısa imza; cihaz her istekte gövdeyi imzalar, sunucu aynı anahtarla doğrular. Anahtarı bilmeyen geçerli imza üretemez, gövde değişirse imza bozulur. | `backend/src/middleware/hardwareAuthMiddleware.ts`, `docs/HARDWARE_INTEGRATION_GUIDE.md` §2 |
| <a id="nonce"></a>**Nonce** | Nonce (number used once) | İstek başına **tek kullanımlık** rastgele değer; sunucu 120 sn içinde aynısını ikinci kez kabul etmez → yakalanan paket tekrar gönderilemez. | `backend/src/db/redisPool.ts`, `backend/src/middleware/hardwareAuthMiddleware.ts` |
| <a id="replay"></a>**Tekrar saldırısı (replay)** | Replay attack | Geçerli bir paketi yakalayıp aynen yeniden göndermek. Zaman damgası penceresi (±30 sn) + nonce ile engellenir. | `backend/src/middleware/hardwareAuthMiddleware.ts` (`REPLAY_ATTACK_DETECTED`) |
| <a id="jwt"></a>**JWT / yenileme belirteci** | JSON Web Token (JWT) / refresh token | Panel oturum belirteci: kısa ömürlü (15 dk) **access** + döner (rotasyonlu) **refresh**. Çalınan refresh belirteci tek kullanımlıktır. | `backend/src/services/tokenService.ts`, `frontend/src/utils/api.ts` |
| <a id="argon2id"></a>**Argon2id** | Argon2id | Parolaları saklamak için kullanılan, kırma maliyeti yüksek özet (hash) algoritması. | `backend/src/utils/password.ts` |
| <a id="fail-open"></a>**Sınırlı serbest bırakma (fail-open)** | Fail-open / fail-closed | Bağımlılık çökünce ne yapılacağı: **fail-open** = çalışmaya sınırlı devam (çevrimdışı ikmal, önbellekteki whitelist+limit); **fail-closed** = güvenlik gereği reddet (Redis yokken cihaz isteği 503). | `backend/src/db/redisPool.ts`, `backend/src/routes/routes.ts` (`/telemetry/fail-open-policy`), `docs/CHAOS_TESTING.md` |
| <a id="graceful-shutdown"></a>**Nazik kapanma (graceful shutdown)** | Graceful shutdown / drain | Sunucu kapanırken yeni istek almayıp **devam edenleri bitirmesi**; WebSocket'ler kademeli koparılır. | `backend/src/utils/shutdown.ts`, `docs/DEPLOY_ROLLBACK.md` §2 |
| <a id="blue-green"></a>**Mavi/yeşil dağıtım** | Blue/green deployment | Yeni sürümü eskisiyle **yan yana** ayağa kaldırıp hazır olunca trafiği atomik geçirmek → sıfır kesinti; eski sürüme tek komutla dönülebilir. | `scripts/zero-downtime-deploy.sh`, `scripts/rollback.sh`, `docs/DEPLOY_ROLLBACK.md` |
| <a id="expand-only"></a>**Genişleten şema değişikliği (expand-only)** | Expand/contract migration | Yalnızca **ekleyen** (yeni tablo/sütun) şema değişikliği; eski uygulama sürümü çalışmaya devam eder. Silme/yeniden adlandırma iki aşamalı (contract) yapılır. | `scripts/check-migration-safety.mjs`, `docs/DEPLOY_ROLLBACK.md` §5 |
| <a id="readiness"></a>**Hazırlık / canlılık (readiness / liveness)** | Readiness / liveness probe | **Liveness:** süreç yaşıyor mu. **Readiness:** bağımlılıklar (DB, Redis, MQTT) hazır mı — trafik yalnızca hazır örneğe gider. | `backend/src/services/readinessService.ts`, `backend/src/routes/routes.ts` (`/health/ready`) |
| <a id="rpo-rto"></a>**RPO / RTO** | Recovery point / recovery time objective | **RPO:** felakette en çok ne kadar veri kaybı kabul (≤ 15 dk). **RTO:** ne kadar sürede geri dönülür (≤ 4 sa). | `docs/BACKUP_RESTORE.md`, `docs/restore-drills/` |
| <a id="pitr"></a>**Belirli ana geri dönüş (PITR / WAL)** | Point-in-time recovery (PITR) / write-ahead log (WAL) | Taban yedek + sürekli arşivlenen WAL ile veritabanını **seçilen bir ana** geri yüklemek. | `scripts/backup/`, `docs/BACKUP_RESTORE.md` |
| <a id="trace-id"></a>**İz kimliği (traceId)** | Trace ID (correlation ID) | Bir isteğin tüm log/hata/Sentry kayıtlarını birbirine bağlayan kimlik (`X-Trace-ID`). Kullanıcıya hata ekranında gösterilir. | `backend/src/middleware/loggerMiddleware.ts`, `docs/ERROR_TRACKING.md` |
| <a id="pii"></a>**Kişisel veri (PII) / KVKK** | Personally identifiable information (PII) / Turkish data-protection law (KVKK) | Kişiyi tanıtan veri (ad, TCKN, telefon). Loglarda/dış servislerde bulunmaz, rol bazlı maskelenir, süresi dolunca **anonimleştirilir**. | `backend/src/privacy/`, `docs/KVKK_ENVANTER.md` |
| <a id="anonymization"></a>**Anonimleştirme** | Anonymization | Kişisel alanları geri dönüşsüz yer tutucularla değiştirmek; **kayıt ve mali tutarlar korunur**. | `backend/src/services/privacyService.ts`, `docs/KVKK_ENVANTER.md` §4 |
| <a id="retention"></a>**Saklama politikası** | Retention policy | Hangi verinin ne kadar saklanıp süresi dolunca (arşivlenerek) silineceği; mali kayıtlar asla silinmez. | `backend/src/retention/retentionCatalog.ts`, `docs/DATA_RETENTION.md` |
| <a id="claim"></a>**Cihaz talep etme (claim)** | Device claim | Yeni cihazın **tek kullanımlık kodla** sunucuya kaydolup kendi secret'ını **bir kez** alması. | `backend/src/routes/routes.ts` (`/devices/claim`), `docs/HARDWARE_INTEGRATION_GUIDE.md` §6 |

## İş terimleri

| Terim (TR) | English | Tanım | Projede nerede |
|---|---|---|---|
| <a id="ikmal"></a>**İkmal** | Dispense / refueling | Bir araca (veya bidona) pompadan yakıt verilmesi ve kaydı: yetki → akış → sonlandırma → stok düşümü. | `backend/src/services/dispenseSessionService.ts`, `backend/src/db/schema.sql` (`transactions`), `docs/OPERATOR_EL_KITABI.md` |
| <a id="cross-site"></a>**Çapraz alım** | Cross-site dispense | Bir aracın **kendi şantiyesi dışındaki** şantiyenin tankından yakıt alması; izin ve kota gerektirir. | `backend/src/db/schema.sql` (`cross_site_permissions`), `backend/src/reports/definitions/rep715CrossSite.ts` |
| <a id="kota"></a>**Kota** | Quota | Çapraz alım için tanımlı izinli litre sınırı; ikmal başlarken **rezerve** edilir. Aracın dönemlik **yakıt limiti** ayrı bir kavramdır (ikisinin kısıtlayıcısı geçerli). | `backend/src/services/quotaLockService.ts`, `backend/src/db/schema.sql` (`fuel_quotas`, `vehicle_fuel_limits`) |
| <a id="mahsuplasma"></a>**Mahsuplaşma** | Inter-site netting / settlement | Şantiyelerin birbirinden çektiği yakıtın (alım anı tutarıyla) karşılıklı **netleştirilmesi**. | `backend/src/reports/definitions/rep715CrossSite.ts` (`rep-715-mahsup`) |
| <a id="fire"></a>**Fire** | Shrinkage / fuel loss | Tankta beklenenden **eksik** yakıt (buharlaşma, ölçüm hatası, açıklanamayan kayıp); tolerans üstü fire onay ister. | `backend/src/db/schema.sql` (`fire_records`), `backend/src/reports/definitions/rep714TankReconciliation.ts` |
| <a id="mutabakat"></a>**Mutabakat** | Stock reconciliation | Dönem sonunda **teorik stok** (açılış + dolum − ikmal) ile **ölçülen fiziksel stok**un karşılaştırılması; fark = fire/fazla. | `backend/src/db/schema.sql` (`stock_reconciliations`), `backend/src/reports/definitions/rep713SiteStock.ts` |
| <a id="e-irsaliye"></a>**e-İrsaliye** | e-Despatch advice (e-Waybill) | GİB'in elektronik sevk belgesi; yakıt hareketinde taşıyıcı/şoför bilgisiyle üretilir. Belge numarası boşluksuz sıralıdır ve değiştirilemez. | `backend/src/compliance/despatchAdviceXmlService.ts`, `backend/src/db/schema.sql` (`despatch_advice_documents`) |
| <a id="ubl-tr"></a>**UBL-TR** | UBL-TR (Universal Business Language, Turkish customization) | e-İrsaliye/e-Fatura belgelerinin **XML biçimi** (UBL 2.1'in Türkiye özelleştirmesi); XSD şemalarıyla doğrulanır. | `backend/src/compliance/ubl-xsd/`, `backend/src/compliance/despatchAdviceXmlService.ts` |
| <a id="mukellef"></a>**Mükellef** | Taxpayer (e-invoice registered) | Vergi kimlik numarasıyla (VKN) e-Belge kullanmakla yükümlü kayıtlı firma; alıcı mükellef değilse e-İrsaliye gönderilemez. | `backend/src/schemas/recipientSchema.ts`, `backend/src/db/schema.sql` (`recipient_taxpayers`) |
| <a id="ettn"></a>**ETTN** | ETTN (unique document UUID) | e-Belgenin evrensel **tekil kimliği** (UUID); her e-İrsaliyeye bir ETTN atanır. | `backend/src/db/schema.sql` (`despatch_advice_documents`), `backend/src/services/despatchAdviceDownloadService.ts` |
| <a id="zimmet"></a>**Zimmet** | Assignment (vehicle–driver) | Bir aracın bir sürücüye atanması; RFID ile ikmalde kartın sahibinden aracı bulmak için kullanılır. | `backend/src/db/schema.sql` (`vehicles.assigned_driver_name`), `docs/OPERATOR_EL_KITABI.md` |
| <a id="maliyet-yontemi"></a>**Maliyet yöntemi** | Cost method (weighted average / FIFO) | Yakıtın birim maliyetini hesaplama yöntemi: **ağırlıklı ortalama** veya **FIFO** (ilk giren ilk çıkar); tenant başına seçilir, geçmiş kayıtlar değişmez. | `backend/src/fuel/fuelCostService.ts`, `backend/src/schemas/fuelCostSchema.ts` |
| <a id="dolum"></a>**Dolum / alım irsaliyesi** | Fuel intake / delivery receipt | Tanka **tedarikçiden yakıt girişi**; teslim edilen ile ölçülen litre farkı kısa teslimat uyarısı üretir. | `backend/src/db/schema.sql` (`fuel_intake_receipts`), `backend/src/routes/routes.ts` (`/tanks/:id/intakes`) |
| <a id="santiye"></a>**Şantiye** | Site (construction site) | Firmanın bir çalışma yeri; kendi tank, pompa, cihaz ve şantiye şefi vardır. `SITE_MANAGER` yalnızca kendi şantiyesini görür. | `backend/src/db/schema.sql` (`sites`), `docs/PROJE-REHBERI.md` §10 |
| <a id="anomali"></a>**Anomali / hırsızlık alarmı** | Anomaly / theft alarm | Beklenmeyen tüketim (mesai dışı ikmal, tankın pompa debisinden hızlı azalması, art arda ikmal); **alarm** olarak kaydedilir ve bildirim gider. | `backend/src/services/theftDetectionService.ts`, `backend/src/db/schema.sql` (`alarms`), `docs/OPERATOR_EL_KITABI.md` §5.2 |
| <a id="veri-sahibi"></a>**Veri sahibi başvurusu** | Data subject request (DSR) | KVKK m.11 gereği kişinin **erişim/silme** talebi; 30 gün içinde sonuçlandırılır. | `backend/src/services/privacyService.ts`, `docs/KVKK_ENVANTER.md` §5 |
| <a id="devreye-alma"></a>**Devreye alma (commissioning)** | Commissioning / go-live acceptance | Yeni şantiyenin kurulumu, kalibrasyonu ve **sayısal kabul kriterleriyle** imzalanarak canlıya alınması. | `docs/SAHA_KURULUM.md`, `docs/saha-kurulum/DEVREYE_ALMA_FORMU.html` |

## Donanım terimleri

| Terim (TR) | English | Tanım | Projede nerede |
|---|---|---|---|
| <a id="debimetre"></a>**Debimetre (akışmetre)** | Flow meter | Borudan geçen yakıtı **pals** sayarak ölçen sensör; her pals belirli bir hacme karşılık gelir (K-faktör). | `docs/SAHA_KURULUM.md` §4.2, `docs/HARDWARE_INTEGRATION_GUIDE.md` §5 |
| <a id="pals"></a>**Pals (pulse)** | Pulse | Akışmetrenin ürettiği elektrik darbesi; sayılıp K-faktöre bölünerek litreye çevrilir. Gürültü **sahte pals** üretebilir (topraklama sorunu). | `docs/SAHA_KURULUM.md` §4.3.1 |
| <a id="ultrasonik"></a>**Ultrasonik seviye sensörü** | Ultrasonic level sensor | Tank içindeki yakıt yüzeyinin uzaklığını ses dalgasıyla ölçüp seviyeyi (mm) veren sensör; boylama tablosuyla litreye çevrilir. | `backend/src/iot/lorawanDecoder.ts`, `docs/HARDWARE_INTEGRATION_GUIDE.md` §4 |
| <a id="role"></a>**Röle / kontaktör** | Relay / contactor | Pompanın elektrik enerjisini açıp kesen anahtar; **arıza durumunda pompayı kesecek** (fail-safe) bağlanır, acil durdurma ile de kesilir. | `docs/SAHA_KURULUM.md` §4.2, `docs/OPERATOR_EL_KITABI.md` §5.1 |
| <a id="rfid"></a>**RFID etiketi / kart UID** | RFID tag / card UID | Sürücüyü (kart) veya aracı (etiket) tanıyan temassız kimlik; okuyucu benzersiz **UID**'i okur. Kart numarası kişiye bağlı kimlik bilgisidir. | `backend/src/db/schema.sql` (`drivers.rfid_card_id`, `rfid_card_blacklist`), `backend/src/routes/routes.ts` (`/rfid-cards`) |
| <a id="lorawan"></a>**LoRaWAN** | LoRaWAN | Uzun menzilli, düşük güçlü kablosuz ağ; tank probları 15 baytlık ikili paketle veri yollar, ağ sunucusu webhook'la iletir. | `backend/src/iot/lorawanDecoder.ts`, `backend/src/services/lorawanUplinkService.ts` |
| <a id="brown-out"></a>**Gerilim çökmesi (brown-out)** | Brown-out | Besleme geriliminin geçici düşmesi; cihazın rastgele yeniden başlamasına neden olur. Firmware'de brown-out detektörü ile ele alınır. | `docs/SAHA_KURULUM.md` §6 (rastgele yeniden başlama) |
| <a id="watchdog"></a>**Bekçi zamanlayıcı (watchdog)** | Watchdog timer (TWDT) | Yazılım takılırsa cihazı otomatik yeniden başlatan donanım zamanlayıcısı. Firmware konusudur (FW-1313; depoda yok). | `docs/PROJE-REHBERI.md` §2 (FW grubu) |
| <a id="rtc"></a>**Gerçek zamanlı saat (RTC) / NTP** | Real-time clock (RTC) / Network Time Protocol (NTP) | **RTC:** cihazda pille çalışan saat; **NTP:** ağdan saat eşitleme. Cihaz saati ±30 sn içinde olmalıdır (HMAC penceresi). | `backend/src/middleware/hardwareAuthMiddleware.ts`, `docs/SAHA_KURULUM.md` §4.5 |
| <a id="apn"></a>**APN** | APN (access point name) | 4G/GSM modemin operatör ağına bağlandığı ayar (SIM'e özgü); konfigürasyon portalında girilir. | `docs/SAHA_KURULUM.md` §4.4 |
| <a id="topraklama"></a>**Topraklama ve ekran (shield)** | Grounding and cable shield | Elektriksel gürültüyü uzaklaştıran toprak bağlantısı ve sinyal kablosunun metal örgüsü; ekran **yalnızca kabin ucunda** topraklanır. | `docs/SAHA_KURULUM.md` §4.3, `docs/saha-kurulum/img/02-topraklama-ekran.svg` |
| <a id="snubber"></a>**Snubber / varistör** | Snubber / varistor | Kontaktör bobininin anahtarlama gürültüsünü (ani gerilim sıçraması) bastıran bileşen. | `docs/SAHA_KURULUM.md` §4.3 |
| <a id="solenoid"></a>**Solenoid vana** | Solenoid valve | Elektrikle açılıp kapanan vana; pompa çıkışında yakıt akışını fiziksel olarak keser. | `docs/HARDWARE_INTEGRATION_GUIDE.md` (`FORCE_CUTOFF`) |
| <a id="esp32"></a>**ESP32 pompa ünitesi** | ESP32 pump controller | Sahadaki RFID okuyucu, akışmetre ve röleyi yöneten, WiFi/4G ile sunucuya bağlanan kontrol ünitesi. Firmware bu depoda yoktur. | `docs/HARDWARE_INTEGRATION_GUIDE.md`, `docs/saha-kurulum/img/01-sistem-mimarisi.svg` |

## Kısaltmalar

| Kısaltma | Açılım | Bkz. |
|---|---|---|
| **AC** | Kabul kriteri (acceptance criterion) | issue şablonu |
| **ACK / NACK** | Onay / ret (acknowledge) | [K-faktör](#k-factor) |
| **ATEX** | Patlayıcı ortam ekipman yönergesi | `docs/SAHA_KURULUM.md` §1.1 |
| **GİB** | Gelir İdaresi Başkanlığı | [e-İrsaliye](#e-irsaliye) |
| **HIL** | Hardware-in-the-loop (donanım döngüde test) | `docs/PROJE-REHBERI.md` §13 |
| **KRT** | Devreye alma kabul kriteri kodu | `docs/SAHA_KURULUM.md` §3 |
| **LOTO** | Kilitle-etiketle (lockout–tagout) | `docs/SAHA_KURULUM.md` §1.1 |
| **VKN** | Vergi kimlik numarası | [Mükellef](#mukellef) |
| **SLA** | Hizmet seviyesi (online oranı) | `docs/SAHA_KURULUM.md` §4.9 |
| **SPA** | Tek sayfa uygulaması (React paneli) | `frontend/` |

---

*Bu belge: DOC-1205. Doğrulama: `scripts/test-doc1205.mjs` (terim sayısı, iki dilli karşılıklar, "projede nerede" yollarının varlığı, rehberdeki ilk-geçiş bağlantıları).*
