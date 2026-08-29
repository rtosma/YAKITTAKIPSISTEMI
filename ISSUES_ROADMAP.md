# 📋 PROJE MASTER İŞ VE GÖREV DÖKÜMÜ (MASTER NODE.JS BACKEND & SYSTEM ROADMAP)
**Proje Adı:** Endüstriyel IoT Destekli Çok Kiracılı (Multi-Tenant) Akaryakıt, Şantiye ve Telemetri Yönetim Platformu  
**Backend Teknolojisi:** Node.js (TypeScript) + NestJS / Express + Drizzle ORM + TimescaleDB + Redis / BullMQ + EMQX (MQTT)  
**Hedef:** Sıfır Hata Toleransı, Uçtan Uca Bütünsel Mimari, Donanım-Bulut Entegrasyonu ve Kurumsal SaaS Olgunluğu  
**Sürüm:** Node.js Enterprise Roadmap v2.1  
**Tarih:** 2026-08-14  

---

## 🧭 Önceliklendirme ve Zorluk Skalası Matrisi
* **Öncelik (Priority):**
  * `[P0 - Blocker]`: Sistem çalışması için zorunlu, güvenlik açığı veya veri kaybı riski taşıyan kritik görevler.
  * `[P1 - High]`: Temel iş süreçlerini (ikmal, donanım haberleşmesi, fatura/irsaliye) doğrudan etkileyen görevler.
  * `[P2 - Medium]`: Kullanıcı deneyimi, analitik, raporlama ve optimizasyon görevleri.
  * `[P3 - Low]`: İkincil geliştirmeler, ileri seviye kozmetik ve opsiyonel otomasyonlar.
* **Karmaşıklık / Efor (Complexity):** `[XS]` (1-2 Gün) | `[S]` (3-5 Gün) | `[M]` (1-2 Hafta) | `[L]` (2-3 Hafta) | `[XL]` (1+ Ay)

---

# 1. 🏗️ MİMARİ & ÇOKLU KİRACILIK (NODE.JS & MULTI-TENANCY)

---

### `[ARCH-101]` Node.js AsyncLocalStorage & PostgreSQL Row-Level Security (RLS) Entegrasyonu
* **Öncelik:** `[P0 - Blocker]` | **Efor:** `[L]`
* **Teknik Yığın:** Node.js `node:async_hooks` (AsyncLocalStorage) + Drizzle ORM / `pg` Pool + PostgreSQL 16
* **Açıklama:** SaaS kiracılarının (Tenants) verilerinin birbirine sızmaması için gelen her HTTP ve WebSocket isteğinde `AsyncLocalStorage` ile `tenant_id` context'i oluşturulması ve veritabanı bağlantı havuzunda (Connection Pool) RLS oturum değişkeninin atanması.
* **Detay & Node.js Uç Durumları:**
  * PgBouncer / Connection Pool kullanıldığında oturum değişkenlerinin (`SET LOCAL app.current_tenant_id = $1`) bir sonraki async event loop iterasyonuna sızmaması için Drizzle/Prisma transaction wrapper içinde çalıştırılması.
* **Kabul Kriterleri (AC):**
  - [x] NestJS / Express Middleware seviyesinde `TenantContextService.run({ tenantId, userId }, next)` kurulmalıdır.
  - [x] PostgreSQL RLS politikaları `current_setting('app.current_tenant_id', true)` üzerinden çalıştırılmalıdır.
  - [x] Eşzamanlı 50 farklı kiracı isteğinde RLS veri izolasyonu %100 doğrulanmalıdır.

---

### `[ARCH-102]` Node.js Event-Driven Olay Veri Yolu (EventEmitter2 / Redis Streams)
* **Öncelik:** `[P1 - High]` | **Efor:** `[M]`
* **Teknik Yığın:** `@nestjs/event-emitter` / `ioredis` Streams + BullMQ
* **Açıklama:** İkmal tamamlandığında (FuelDispensedEvent) aynı anda faturalandırma, stok düşümü, şoför skoru ve anomali analizi asenkron Node.js worker'larına dağıtılmalıdır.
* **Kabul Kriterleri (AC):**
  - [ ] Domain event publisher ve handler yapısı TypeScript generic arayüzleri ile kurulmalıdır.
  - [ ] İşlemlerin mükerrer çalışmaması için Redis tabanlı `Idempotency-Key` denetleyicisi uygulanmalıdır.
  - [ ] Hatalı event'ler için BullMQ Dead Letter Queue (DLQ) mekanizması yapılandırılmalıdır.

---

### `[ARCH-103]` TimescaleDB & Node.js Stream Batch Ingestion Motoru
* **Öncelik:** `[P1 - High]` | **Efor:** `[M]`
* **Teknik Yığın:** TimescaleDB + `pg-copy-streams` / `drizzle-orm`
* **Açıklama:** Pompalar ve ultrasonik sensörlerden gelen saniyelik ham telemetri verilerinin Node.js event loop'unu bloklamadan (non-blocking) mikro-batch havuzunda toplanıp toplu yazılması.
* **Kabul Kriterleri (AC):**
  - [ ] Gelen telemetri verileri bellekte 500ms veya 1.000 kayıtlık tamponda (Buffer) tutulup toplu `INSERT` yapılmalıdır.
  - [ ] 90 gün öncesi ham telemetri verileri için TimescaleDB sıkıştırma politikası çalıştırılmalıdır.

---

# 2. 🔐 KİMLİK DOĞRULAMA, YETKİLENDİRME & GÜVENLİK (AUTH & SECURITY)

---

### `[AUTH-201]` Node.js JWT Rotation, Passport.js & Argon2id Şifreleme
* **Öncelik:** `[P0 - Blocker]` | **Efor:** `[M]`
* **Teknik Yığın:** `argon2`, `@nestjs/passport`, `@nestjs/jwt`, `ioredis`
* **Açıklama:** Granüler yetki matrisi (`SUPER_ADMIN`, `COMPANY_OWNER`, `SITE_MANAGER`, `PUMP_OPERATOR`, `DRIVER`) ve güvenli token rotasyonu.
* **Detay & Node.js Uç Durumları:**
  * Parola doğrulamalarında CPU blokajını önlemek için `argon2` Node C++ binding'leri optimize thread-pool ile çalıştırılmalıdır.
* **Kabul Kriterleri (AC):**
  - [x] 15 dakikalık Access Token ve 7 günlük tek kullanımlık Refresh Token rotasyonu kurulmalıdır.
  - [x] Şüpheli çoklu oturum kullanımında (Token Reuse Detection) kullanıcının tüm oturumları anında temizlenmelidir.
  - [x] `@Roles()` ve `@Permissions()` Express/NestJS Guard'ları ile rota bazlı RBAC uygulanmalıdır.

---

### `[AUTH-202]` Donanım Kimlik Doğrulaması & Node.js `crypto` HMAC-SHA256 Doğrulayıcı
* **Öncelik:** `[P0 - Blocker]` | **Efor:** `[L]`
* **Teknik Yığın:** Node.js native `node:crypto` + Custom Fastify/Express Interceptor
* **Açıklama:** Sahadaki ESP32 ve debimetre cihazlarının `X-Hardware-Signature` başlığında gönderdiği `HMAC-SHA256(rawBody + timestamp, deviceSecret)` imzasının doğrulanması.
* **Detay & Node.js Uç Durumları:**
  * Express/NestJS `body-parser` JSON'a çevirmeden önceki **RAW Buffer** saklanmalı ve imza doğrulaması saf buffer üzerinden yapılmalıdır.
* **Kabul Kriterleri (AC):**
  - [ ] 30 saniyeden eski `timestamp` içeren paketler (Replay Attack) `401 Unauthorized` ile reddedilmelidir.
  - [ ] Zamanlama saldırılarını (Timing Attacks) önlemek için `crypto.timingSafeEqual` kullanılmalıdır.

---

### `[AUTH-203]` Audit Trail & Append-Only Denetim Günlüğü Servisi
* **Öncelik:** `[P1 - High]` | **Efor:** `[S]`
* **Teknik Yığın:** Node.js Async Interceptor + PostgreSQL Append-Only Table
* **Açıklama:** Kritik her işlemin (pompa açma, limit değiştirme, şantiye yetkisi) geri döndürülemez şekilde loglanması.
* **Kabul Kriterleri (AC):**
  - [ ] `audit_logs` tablosuna `UPDATE` ve `DELETE` yetkisi PostgreSQL düzeyinde kapatılmalıdır.
  - [ ] Tüm işlemler `trace_id` ve IP/Kullanıcı bilgisi ile kaydedilmelidir.

---

# 3. 📡 DONANIM, IoT, TELEMETRİ & MQTT (NODE.JS IOT INGESTION)

---

### `[IOT-301]` Node.js MQTT v5 Client (MQTT.js) & Dağıtık Telemetri Dinleyici
* **Öncelik:** `[P0 - Blocker]` | **Efor:** `[L]`
* **Teknik Yığın:** `mqtt` (MQTT.js) + EMQX Broker + Node.js Worker Threads
* **Açıklama:** Sahadaki yüzlerce pompadan gelen verilerin `telemetry/v1/{tenantId}/{siteId}/{deviceType}/{deviceId}/data` topic'lerinden dinlenip parse edilmesi.
* **Kabul Kriterleri (AC):**
  - [ ] MQTT QoS 1 seviyesinde bağlantı kurulmalı ve otomatik reconnect mekanizması uygulanmalıdır.
  - [ ] Cihazların koptuğunu anında anlamak için `LWT (Last Will and Testament)` mesajları yakalanıp Redis'e cihaz çevrimdışı (`OFFLINE`) yazılmalıdır.

---

### `[IOT-302]` Binary LoRaWAN Payload Decoder (Node.js Buffer Parser)
* **Öncelik:** `[P1 - High]` | **Efor:** `[M]`
* **Teknik Yığın:** Node.js `Buffer.readInt16BE`, `Buffer.readFloatLE`
* **Açıklama:** ChirpStack/TTN üzerinden gelen Hex/Binary sensör verilerinin (ultrasonik mesafe, sıcaklık, pil voltajı, RSSI/SNR) Node.js Buffer API ile yüksek hızda decode edilmesi.
* **Kabul Kriterleri (AC):**
  - [ ] Hexadecimal paketler mikro-saniyeler içinde çözülerek JSON formatına getirilmelidir.
  - [ ] Bozuk/eksik bayt içeren paketler `CorruptedPayloadException` olarak ayrıştırılıp izole edilmelidir.

---

### `[IOT-303]` Çevrimdışı (Offline-First) Toplu Yükleme (Batch Sync) API'si
* **Öncelik:** `[P0 - Blocker]` | **Efor:** `[L]`
* **Teknik Yığın:** Node.js Stream / JSONStream + PostgreSQL Bulk Insert Transaction
* **Açıklama:** İnterneti kesilen şantiyelerin bağlantı geldiğinde yerel belleğindeki 1.000'lerce ikmali tek seferde sunucuya yüklemesi.
* **Kabul Kriterleri (AC):**
  - [ ] `POST /api/v1/telemetry/sync-batch` endpoint'i `local_sequence_id` ile mükerrer kayıtları (deduplication) filtrelemelidir.
  - [ ] Geçmişe dönük stok düşümü kronolojik sıra ile atomik olarak yapılmalıdır.

---

# 4. ⛽ AKARYAKIT OTOMASYONU, RFID & İKMAL PROTOKOLÜ (FUEL & DISPENSING)

---

### `[FUEL-401]` İki Aşamalı İkmal Başlatma, RFID Doğrulama & Heartbeat Motoru
* **Öncelik:** `[P0 - Blocker]` | **Efor:** `[L]`
* **Teknik Yığın:** Node.js `@nestjs/websockets` / Socket.io + Redis TTL
* **Açıklama:** Tabanca araca takıldığında RFID tag okunur -> Node.js API 200ms altında yetki kontrolü yapar -> Pompa açılır -> İkmal süresince 5 saniyede bir Heartbeat gönderilir.
* **Kabul Kriterleri (AC):**
  - [ ] `POST /api/v1/dispense/request-auth` < 200ms yanıt süresi sağlamalıdır.
  - [ ] İkmal devam ederken 15 saniye Heartbeat gelmezse Redis'teki oturum düşürülmeli ve pompaya acil kapatma (`FORCE_CUTOFF`) emri yollanmalıdır.
  - [ ] `POST /api/v1/dispense/finalize` ile sayaç totalizatörü kilitlenip işlem kaydedilmelidir.

---

### `[FUEL-402]` Node.js Dağıtık Kilit (Redlock) ile Çapraz Şantiye Kota Motoru
* **Öncelik:** `[P1 - High]` | **Efor:** `[M]`
* **Teknik Yığın:** `redlock` / `ioredis` + PostgreSQL `SELECT ... FOR UPDATE`
* **Açıklama:** Konsorsiyum ortaklarının birbirlerinin deposundan yakıt çekerken limit aşımını ve aynı saniyede iki aracın aynı kotayı tüketmesini engelleme.
* **Kabul Kriterleri (AC):**
  - [ ] Eşzamanlı isteklerde Redis Redlock kilidi uygulanmalıdır (`lock:quota:{permissionId}`).
  - [ ] Kota bittiğinde anında `QUOTA_EXHAUSTED` yanıtı dönülmeli ve WebSocket ile şantiye ekranına uyarı düşmelidir.

---

### `[FUEL-403]` Tank Seviye - Hacim Kalibrasyon (Strapping Table) Matematiksel Motoru
* **Öncelik:** `[P1 - High]` | **Efor:** `[M]`
* **Teknik Yığın:** Node.js Pure Math Module (Linear Interpolation & ASTM D1250 Density Correction)
* **Açıklama:** Sensörün milimetre seviyesini daldırma cetveli (Strapping Table) veya silindirik tank formülleriyle net litreye ve 15°C standart hacmine çevirme.
* **Kabul Kriterleri (AC):**
  - [ ] CSV kalibrasyon cetvelleri parsed edilip bellekte cache'lenmelidir.
  - [ ] Sıcaklık genleşme katsayısı doğrulaması formüle dahil edilmelidir.

---

# 5. 🧠 YAPAY ZEKA & ANOMALİ TESPİT SERVİSLERİ (AI & ANOMALY)

---

### `[AI-501]` Pompa Debisi vs. Tank Ultrasonik Düşüş Korelasyonu (Hırsızlık Motoru)
* **Öncelik:** `[P0 - Blocker]` | **Efor:** `[L]`
* **Teknik Yığın:** Node.js Background Worker (BullMQ Repeatable Job)
* **Açıklama:** Pompadan çıkan litre ile tank seviye düşüşü arasındaki korelasyonu gerçek zamanlı analiz ederek kaçak, sızıntı veya debimetre müdahalesini anında yakalama.
* **Kabul Kriterleri (AC):**
  - [ ] Pompa çalışmıyorken 10 dakikada 5 litreden fazla düşüş olursa `STATIC_THEFT_DETECTED` alarmı üretilmelidir.
  - [ ] Pompa akışı ile tank seviye farkı ±%1.5 toleransı aşarsa `METER_CALIBRATION_TAMPER` uyarısı fırlatılmalıdır.

---

### `[AI-502]` Google Gemini SDK ile Şoför/Araç Tüketim Anomali Analizi
* **Öncelik:** `[P2 - Medium]` | **Efor:** `[M]`
* **Teknik Yığın:** `@google/genai` (Official Node SDK) + Node.js Scheduled Cron
* **Açıklama:** Haftalık ikmal ve telemetri verilerini derleyip Gemini AI modeline prompt ederek aşırı yakan iş makinelerini ve şüpheli şoför tüketimlerini özetleme.
* **Kabul Kriterleri (AC):**
  - [ ] Gemini API anahtarları yalnızca backend sunucusunda `process.env.GEMINI_API_KEY` üzerinden çağrılmalıdır.
  - [ ] Yapay zeka çıktıları JSON schema formatında doğrulanıp dashboard'a sunulmalıdır.

---

# 6. 📄 GİB E-İRSALİYE, UBL-TR & ENTEGRATÖR SERVİSİ (COMPLIANCE)

---

### `[COMP-601]` Node.js UBL-TR 1.2 XML DespatchAdvice Oluşturucu
* **Öncelik:** `[P1 - High]` | **Efor:** `[L]`
* **Teknik Yığın:** `fast-xml-parser` / `xmlbuilder2` + Schematron Validator
* **Açıklama:** İkmal tamamlandığında Gelir İdaresi Başkanlığı (GİB) standartlarında UBL-TR 1.2 e-İrsaliye XML dosyasının hatasız üretilmesi.
* **Kabul Kriterleri (AC):**
  - [ ] VKN, Plaka, Şoför TC, Sevk Tarihi, GTIP Kodları (Motorin 10 ppm) XML şablonuna basılmalıdır.
  - [ ] XSD şema doğrulamasından %100 hatasız geçmelidir.

---

### `[COMP-602]` Özel Entegratör SOAP/REST İstemcisi & Devre Kesici (Circuit Breaker)
* **Öncelik:** `[P1 - High]` | **Efor:** `[L]`
* **Teknik Yığın:** `axios` / `soap` + `opossum` (Circuit Breaker) + BullMQ
* **Açıklama:** Üretilen irsaliyenin özel entegratöre iletilmesi; entegratör çöktüğünde devre kesici ile kuyruğa alınması ve GİB durum kodunun (1200 Başarılı vb.) takip edilmesi.
* **Kabul Kriterleri (AC):**
  - [ ] Entegratör yanıt vermezse 5 denemeden sonra Circuit Breaker açılmalı ve sistem kilitlenmemelidir.
  - [ ] İmzalanmış UBL UUID ve e-İrsaliye PDF dosyası S3 / Cloud Storage üzerinde saklanmalıdır.

---

# 7. 📊 RAPORLAMA, EXCEL VE ŞİFRELİ ARŞİVLEME (REPORTING & ARCHIVE)

---

### `[REP-701]` Bellek Dostu Node.js Stream Excel Dışa Aktarımı & Dinamik Toplam Satırı
* **Öncelik:** `[P1 - High]` | **Efor:** `[M]`
* **Teknik Yığın:** `exceljs` Stream Writer (`WorkbookWriter`) + Node.js `stream.PassThrough`
* **Açıklama:** 500.000 satırlık ikmal hareketlerini sunucu belleğini tüketmeden stream ederek Excel (.xlsx) üretme ve tablonun en altına dinamik `GENEL TOPLAM` satırı ekleme.
* **Kabul Kriterleri (AC):**
  - [ ] `Alınan Miktar (Litre)` ve `Toplam Tutar` sütunları için genel toplam satırı otomatik hesaplanmalıdır.
  - [ ] 100.000 satır dışa aktarılırken Node.js process bellek kullanımı 150 MB'ı aşmamalıdır.

---

### `[REP-702]` Otomatik (Cron) & Manuel Şifreli ZIP Arşivleme Servisi
* **Öncelik:** `[P1 - High]` | **Efor:** `[M]`
* **Teknik Yığın:** `archiver` + `node:crypto` AES-256 + `@nestjs/schedule`
* **Açıklama:** Müşterinin seçtiği periyoda (7, 15, 30, 90 gün) göre veya "Şimdi Arşiv Oluştur" butonuyla tetiklenen şifreli ZIP arşiv paketi oluşturma.
* **Kabul Kriterleri (AC):**
  - [ ] ZIP paketi: İkmal CSV, e-İrsaliye JSON/XML, Telemetri RAW logları ve Özet PDF dosyalarını içermelidir.
  - [ ] Arşiv paketi oluşturulduğunda kullanıcıya süreli indirme bağlantısı (Presigned URL) üretilmelidir.

---

# 8. 💻 FRONTEND ENTEGRASYONU, REACT & WEBSOCKET (FRONTEND & UI)

---

### `[FE-801]` Socket.io İstemcisi ile Canlı Pompa ve Tank Telemetrisi
* **Öncelik:** `[P1 - High]` | **Efor:** `[M]`
* **Teknik Yığın:** `socket.io-client` + `zustand` + `framer-motion`
* **Açıklama:** Pompa debi göstergesinin, tank seviye barlarının ve anomali alarmlarının gecikmesiz canlı güncellenmesi.
* **Kabul Kriterleri (AC):**
  - [ ] Bağlantı koptuğunda "Bağlantı Yenileniyor..." uyarısı çıkmalı ve Exponential Backoff ile yeniden bağlanmalıdır.
  - [ ] Sekme arka plana alındığında gereksiz render'lar durdurulmalı, bellek sızıntısı (Memory Leak) önlenmelidir.

---

### `[FE-802]` TanStack Query v5 ile Server-Side Pagination, Filtering & Debounce
* **Öncelik:** `[P1 - High]` | **Efor:** `[S]`
* **Teknik Yığın:** `@tanstack/react-query` v5 + `use-debounce`
* **Açıklama:** Yüz binlerce ikmal hareketi arasında hızlı arama, filtreleme ve sayfalama yapılması.
* **Kabul Kriterleri (AC):**
  - [ ] Arama girdilerinde 300ms debounce uygulanmalıdır.
  - [ ] URL parametreleri (`?page=1&siteId=3&startDate=...`) ile senkronizasyon sağlanmalıdır.

---

### `[FE-803]` Rol Bazlı UI Bileşen Koruması (Permission Guards)
* **Öncelik:** `[P1 - High]` | **Efor:** `[S]`
* **Teknik Yığın:** React Context / Zustand Permissions Hook + React Router v6 Guards
* **Açıklama:** Yetkisiz kullanıcıların kritik butonları (örn. "Pompayı Kilitle", "Modül Aç/Kapa") görmesini engelleme.
* **Kabul Kriterleri (AC):**
  - [ ] Yetkisiz butonlar DOM'dan tamamen kaldırılmalıdır.
  - [ ] Rota koruması ile doğrudan URL yazarak erişimler `403 Forbidden` sayfasına yönlendirilmelidir.

---

# 9. ⚠️ HATA YÖNETİMİ, FALLBACK & GİRDİ DOĞRULAMA (NODE.JS RESILIENCE)

---

### `[RES-901]` Zod / Class-Validator ile Katı Girdi Doğrulama & Sanitizasyon
* **Öncelik:** `[P0 - Blocker]` | **Efor:** `[S]`
* **Teknik Yığın:** `zod` veya `class-validator` + `class-transformer`
* **Açıklama:** Tüm API isteklerinin katı şema denetiminden geçirilmesi; tanımsız alanların (`stripUnknown: true`) elenmesi.
* **Kabul Kriterleri (AC):**
  - [x] Negatif yakıt litresi, geçersiz e-posta veya bozuk plaka girişleri `400 Bad Request` ile alan bazlı hata dönmelidir.

---

### `[RES-902]` Node.js Global Exception Filter & Winston / Pino Yapısal Loglama
* **Öncelik:** `[P0 - Blocker]` | **Efor:** `[S]`
* **Teknik Yığın:** `pino` / `pino-http` + NestJS Global Exception Filter
* **Açıklama:** Sunucu hatalarında (stack trace) güvenlik bilgilerinin istemciye sızmasını önleme, JSON formatında `trace_id` ile yapısal log üretme.
* **Kabul Kriterleri (AC):**
  - [x] Beklenmeyen hatalarda istemciye yalnızca `{ success: false, traceId: "uuid", message: "Sunucu hatası" }` dönmelidir.
  - [x] Tüm loglar JSON formatında stdout'a basılmalıdır.

---

# 10. 🧪 TEST OTOMASYONU & TESTCONTAINERS (QA & TESTING)

---

### `[TEST-1001]` Testcontainers ile Gerçekçi Node.js Entegrasyon Testleri
* **Öncelik:** `[P1 - High]` | **Efor:** `[M]`
* **Teknik Yığın:** `vitest` / `jest` + `@testcontainers/postgresql` + `@testcontainers/redis`
* **Açıklama:** CI pipeline üzerinde Docker içinde ayağa kalkan gerçek PostgreSQL ve Redis ile tam ikmal döngüsü testi.
* **Kabul Kriterleri (AC):**
  - [ ] İkmal başlatma -> Telemetri -> İkmal tamamlama -> Stok düşümü testi %100 yeşil geçmelidir.

---

### `[TEST-1002]` k6 ile Node.js Yük ve Stres Testi
* **Öncelik:** `[P1 - High]` | **Efor:** `[M]`
* **Teknik Yığın:** `k6` Load Testing Tool
* **Açıklama:** 100 eşzamanlı pompadan saniyede 1.000 telemetri paketi gönderildiğinde Node.js event loop gecikmesinin (lag) ve P95 süresinin ölçülmesi.
* **Kabul Kriterleri (AC):**
  - [ ] P95 yanıt süresi < 200ms olmalı ve event loop lag < 50ms kalmalıdır.

---

# 11. 🚀 DEVOPS, DOCKER & CI/CD (NODE.JS CONTAINERIZATION)

---

### `[OPS-1101]` Multi-Stage Dockerfile & Node.js Production Optimizasyonu
* **Öncelik:** `[P0 - Blocker]` | **Efor:** `[S]`
* **Teknik Yığın:** Docker Multi-stage (`node:20-alpine`) + `tini` / dumb-init
* **Açıklama:** Minimum imaj boyutu (<150MB), non-root user (`node`) ve doğru sinyal yönetimi (SIGTERM/SIGINT) ile container hazırlığı.
* **Kabul Kriterleri (AC):**
  - [x] `NODE_ENV=production` ile devDependencies imajdan temizlenmelidir.
  - [x] Container kapatılırken (Graceful Shutdown) aktif ikmal bağlantılarına 30 saniye tamamlanma süresi tanınmalıdır.

---

### `[OPS-1102]` GitHub Actions CI/CD Pipeline & Otomatik Dağıtım
* **Öncelik:** `[P0 - Blocker]` | **Efor:** `[M]`
* **Teknik Yığın:** GitHub Actions + Trivy Vulnerability Scanner + GCP Cloud Run / K8s
* **Açıklama:** Her pull request için lint, type-check, test ve güvenlik taramasının otomatik çalışması.
* **Kabul Kriterleri (AC):**
  - [x] Güvenlik açığı (CVE Critical/High) tespit edilen paketler build'i kırmalıdır.
  - [x] Production dağıtımları sıfır kesinti (Zero-Downtime Rolling Update) ile yapılmalıdır.

---

# 12. 📚 OPENAPI (SWAGGER) & GELİŞTİRİCİ DOKÜMANLARI (DOCS)

---

### `[DOC-1201]` NestJS Swagger OpenAPI 3.0 & Donanım Protokol Şartnamesi
* **Öncelik:** `[P1 - High]` | **Efor:** `[S]`
* **Teknik Yığın:** `@nestjs/swagger` + Compodoc / Markdown Docs
* **Açıklama:** Tüm REST endpoint'lerinin, DTO modellerinin ve donanım üreticileri için MQTT formatlarının dokümante edilmesi.
* **Kabul Kriterleri (AC):**
  - [ ] `/api/v1/docs` altında Swagger UI interaktif olarak çalışmalıdır.
  - [ ] Pano üreticileri için "Hardware Integration Guide v1.0" dokümanı sunulmalıdır.

---

## 🎯 Node.js Uygulama ve Dağıtım Fazları

```
FAZ 1: ÇEKİRDEK NODE.JS ALTYAPISI & GÜVENLİK (Hafta 1 - 3)
 ├── ARCH-101 (Node.js AsyncLocalStorage & Postgres RLS)
 ├── AUTH-201 & AUTH-202 (JWT Rotation & Crypto HMAC)
 ├── RES-901 & RES-902 (Zod Validation & Global Exception Filter)
 └── OPS-1101 & OPS-1102 (Docker Multi-Stage & CI/CD)

FAZ 2: IoT HABERLEŞME & AKARYAKIT OTOMASYONU (Hafta 4 - 6)
 ├── IOT-301 & IOT-302 (MQTT.js Ingestion & Buffer Parser)
 ├── FUEL-401 & FUEL-402 (İkmal Handshake & Redlock Kota Motoru)
 ├── ARCH-103 (TimescaleDB Batch Ingestion)
 └── FE-801 (Socket.io Canlı Telemetri)

FAZ 3: ANOMALİ, MEVZUAT & RAPORLAMA (Hafta 7 - 9)
 ├── AI-501 & AI-502 (Kaçak Analizi & Google Gemini SDK)
 ├── COMP-601 & COMP-602 (UBL-TR e-İrsaliye & Circuit Breaker)
 ├── REP-701 & REP-702 (Stream Excel & Şifreli ZIP Arşivi)
 └── FE-802 & FE-803 (TanStack Query v5 & UI Guards)

FAZ 4: TEST, STRES TESTİ & CANLIYA ÇIKIŞ (Hafta 10 - 12)
 ├── TEST-1001 & TEST-1002 (Testcontainers & k6 Yük Testi)
 └── DOC-1201 (Swagger OpenAPI 3.0 & Donanım Şartnamesi)
```
