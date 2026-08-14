# 🏭 ÜRETİME GEÇİŞ ÖNCESİ MASTER MİMARİ VE EKSİKLİK DÖKÜMÜ (NODE.JS SPECIFICATION)
### (Pre-Automation & Production-Readiness Master Specification)

**Rol:** Kıdemli Yazılım Mühendisi & Node.js Sistem Mimarı  
**Teknoloji Yığını:** Node.js (TypeScript) + NestJS/Express + PostgreSQL (RLS) + TimescaleDB + Redis/BullMQ + EMQX (MQTT) + React  
**Hedef:** Canlı Saha Otomasyonuna geçilmeden önce kapatılması gereken tüm frontend, backend, veritabanı ve güvenlik boşluklarının sıfır hata toleransı ile çözülmesi.  
**Tarih:** 2026-08-14  

---

# 📑 İÇİNDEKİLER VE KRİTİK YOL (CRITICAL PATH)
1. [Veri Modeli ve Veri Tabanında Nelerin Saklanacağı (Comprehensive Data Dictionary)](#bölüm-1-veri-modeli-ve-saklanacak-veriler)
2. [NODE.JS BACKEND Sorunları ve Teknik Spesifikasyonları](#bölüm-2-nodejs-backend-sorunlari-ve-teknik-spesifikasyonlari)
   * API Tasarımı, Fastify/Express Routing & Idempotent Dispense
   * PostgreSQL RLS, AsyncLocalStorage & TimescaleDB Hypertable
   * Node.js Crypto (HMAC), Argon2id & JWT Rotation
   * Redlock Dağıtık Kilit, Zod Girdi Doğrulama & Global Exception Filter
   * Node.js Test Stratejisi (Testcontainers & k6)
3. [FRONTEND Sorunları ve Teknik Spesifikasyonları](#bölüm-3-frontend-sorunlari-ve-teknik-spesifikasyonlari)
   * Zustand, React Query v5 & Socket.io Canlı Telemetri
   * React Error Boundaries, Skeleton Loading & Empty States
   * Route-Based Code Splitting, Virtual Scrolling & Bundle Optimizasyonu
   * WCAG 2.1 AA Erişilebilirlik, Saha Tableti Touch Targets
   * Playwright E2E & RTL Testleri
4. [Node.js Kritik Yol ve Bağımlılık Sıralaması (Dependency Graph)](#bölüm-4-nodejs-kritik-yol-ve-bağimlilik-haritasi)

---

# BÖLÜM 1: VERİ MODELİ VE SAKLANACAK VERİLER

Otomasyon safhasında hiçbir verinin kaybolmaması, mali denetime açık olması ve telemetri hızına dayanması için PostgreSQL ve TimescaleDB'de saklanacak kesin veri varlıkları:

```
+---------------------------------------------------------------------------------------------------+
|                                      VERİ SÖZLÜĞÜ (DATA DICTIONARY)                               |
+---------------------------------------------------------------------------------------------------+
| 1. TENANTS (Kiracı Şirketler)                                                                     |
|    - id (UUID), name, vkn_tckn, tax_office, license_status (ACTIVE/SUSPENDED/TRIAL),               |
|    - license_expires_at, active_modules (JSONB: {eInvoice, aiAnomaly, warehouse, ...}),            |
|    - contact_email, contact_phone, created_at, updated_at                                         |
+---------------------------------------------------------------------------------------------------+
| 2. SITES (Şantiyeler / İstasyonlar)                                                               |
|    - id (UUID), tenant_id (FK), name, code, latitude, longitude, address, is_active,               |
|    - geofence_radius_meters, emergency_stop_status (BOOLEAN), created_at                          |
+---------------------------------------------------------------------------------------------------+
| 3. TANKS (Sabit / Mobil Yakıt Tankları)                                                           |
|    - id (UUID), tenant_id (FK), site_id (FK), name, fuel_type (DIESEL/GASOLINE),                  |
|    - max_capacity_liters, current_level_liters, min_critical_threshold_liters,                    |
|    - ultrasonic_sensor_id, strapping_table_id (FK), temp_celsius, last_telemetry_at               |
+---------------------------------------------------------------------------------------------------+
| 4. PUMPS & DISPENSERS (Akaryakıt Pompaları ve Tabancalar)                                         |
|    - id (UUID), tank_id (FK), hardware_mac, device_serial_no, lora_dev_eui,                        |
|    - status (IDLE/PUMPING/ERROR/EMERGENCY_LOCKED), totalizer_liters_lifetime,                     |
|    - current_flow_rate_lpm, last_heartbeat_at, firmware_version                                   |
+---------------------------------------------------------------------------------------------------+
| 5. VEHICLES (Kayıtlı Araç ve İş Makineleri)                                                       |
|    - id (UUID), tenant_id (FK), site_id (FK), plate, vehicle_type (TRUCK/EXCAVATOR/GENERATOR),   |
|    - brand_model, rfid_tag_uid, tank_capacity_liters, odo_km, engine_hours,                        |
|    - fuel_quota_monthly_liters, is_fueling_blocked (BOOLEAN), created_at                          |
+---------------------------------------------------------------------------------------------------+
| 6. DRIVERS (Şoförler ve Operatörler)                                                              |
|    - id (UUID), tenant_id (FK), assigned_site_id (FK), full_name, tc_no, phone,                   |
|    - rfid_card_uid, license_classes, performance_score (0-100), is_active                         |
+---------------------------------------------------------------------------------------------------+
| 7. FUEL_TRANSACTIONS (İkmal Hareketleri - Değiştirilemez Finansal Kayıt)                          |
|    - id (UUID), tenant_id (FK), site_id (FK), tank_id (FK), pump_id (FK), vehicle_id (FK),        |
|    - driver_id (FK), start_totalizer, end_totalizer, pumped_liters, duration_seconds,             |
|    - avg_flow_rate_lpm, rfid_auth_mode (AUTO/MANUAL/OVERRIDE), invoice_status,                    |
|    - start_time, end_time, idempotency_key (UNIQUE), hash_signature                               |
+---------------------------------------------------------------------------------------------------+
| 8. SENSOR_TELEMETRY (TimescaleDB Hypertable - Ham Sensör Verisi)                                  |
|    - timestamp (TIMESTAMPTZ), device_id (UUID), device_type (TANK/PUMP/LORA_GATEWAY),             |
|    - raw_level_mm, volume_liters, flow_rate_lpm, temp_c, rssi_dbm, snr, battery_volts            |
+---------------------------------------------------------------------------------------------------+
| 9. ANOMALIES & AUDIT LOGS (Güvenlik, Kaçak ve Hırsızlık Olayları)                                 |
|    - id (UUID), tenant_id, site_id, anomaly_type (UNAUTHORIZED_SIPHONING / METER_DRIFT / SPOOF),  |
|    - discrepancy_liters, confidence_score, status (OPEN/INVESTIGATING/RESOLVED), timestamp         |
+---------------------------------------------------------------------------------------------------+
```

---

# BÖLÜM 2: NODE.JS BACKEND SORUNLARI VE TEKNİK SPESİFİKASYONLARI

```
[CRITICAL NODE.JS BACKEND ROADMAP]
 ├── BE-01: REST API & Idempotent Dispense (Node.js + NestJS/Express)
 ├── BE-02: Node.js AsyncLocalStorage + PostgreSQL RLS + TimescaleDB
 ├── BE-03: Argon2id, JWT Rotation & Node.js Crypto (HMAC)
 ├── BE-04: Redis Redlock, Zod Input Validation & Global Exception Filter
 └── BE-05: Testcontainers Entegrasyon & k6 Yük Testi
```

---

### `[BE-01]` Node.js RESTful API & Idempotent Dispense Protokolü
* **Öncelik:** `P0 - Blocker` | **Bağımlılık:** Yok
* **Teknik Spesifikasyon:**
  * Node.js ortamında mükerrer yakıt ikmalini önlemek için `Idempotency-Key` (UUID v4) middleware'i geliştirilmelidir.
  * API endpoints:
    * `POST /api/v1/dispense/authorize` (Araç + RFID + Kota yetkilendirmesi, <200ms).
    * `POST /api/v1/dispense/stream-telemetry` (500ms canlı debi akışı).
    * `POST /api/v1/dispense/finalize` (Totalizatör kilitleme ve işlem tamamlama).
* **Node.js Uç Durumu (Edge Case):**
  * Şantiyede elektrik kesilip pompa kapandığında yarım kalan işlem için Node.js sunucusunda 60 saniyelik timeout uygulanmalı ve `INCOMPLETE_POWER_FAILURE` statüsüyle otomatik kapatılmalıdır.
* **Kabul Kriterleri (AC):**
  - [ ] Aynı `Idempotency-Key` ile 5 saniye içinde gelen tekrarlı istekler yeni işlem yaratmamalı, ilk işlemin sonucunu `HTTP 200` ile dönmelidir.
  - [ ] OpenAPI 3.0 (Swagger) spesifikasyonu `@nestjs/swagger` ile otomatik üretilip `/api/v1/docs` üzerinde sunulmalıdır.

---

### `[BE-02]` Node.js `AsyncLocalStorage`, PostgreSQL RLS & TimescaleDB
* **Öncelik:** `P0 - Blocker` | **Bağımlılık:** `BE-01`
* **Teknik Spesifikasyon:**
  * Gelen her HTTP isteğinde Node.js `node:async_hooks` (AsyncLocalStorage) ile `tenant_id` context'i saklanmalı ve veritabanı sorgusu başında `SET LOCAL app.current_tenant_id = $1` çalıştırılmalıdır.
  * PostgreSQL 16 üzerinde Drizzle ORM ile tüm tablolar yönetilmelidir.
  * `sensor_telemetry` tablosu TimescaleDB hipertablosuna dönüştürülmeli ve Node.js içinde 500ms mikro-batch havuzunda toplanarak toplu `INSERT` yapılmalıdır.
* **Kabul Kriterleri (AC):**
  - [ ] PostgreSQL RLS politikaları `current_setting('app.current_tenant_id', true)` üzerinden hatasız çalışmalıdır.
  - [ ] A firmasının API token'ı ile gelen istek hiçbir koşulda B firmasının verisini sorgulayamamalıdır (`0 rows returned`).

---

### `[BE-03]` Node.js `crypto` HMAC-SHA256, Argon2id & JWT Rotation
* **Öncelik:** `P0 - Blocker` | **Bağımlılık:** `BE-02`
* **Teknik Spesifikasyon:**
  * Parolalar `argon2` (m=65536, t=3, p=4) ile hash'lenmelidir.
  * JWT Access Token (15 dk) ve Redis'te tutulan tek kullanımlık Refresh Token (7 gün) rotasyonu kurulmalıdır.
  * Donanım güvenliği: Sahadaki ESP32 cihazlarından gelen `X-Hardware-Signature` başlığı, Node.js `crypto.createHmac('sha256', deviceSecret).update(rawBody + timestamp).digest('hex')` ile doğrulanmalı ve zamanlama saldırılarına karşı `crypto.timingSafeEqual` kullanılmalıdır.
* **Kabul Kriterleri (AC):**
  - [ ] 30 saniyeden eski `timestamp` içeren paketler Replay Attack koruması ile reddedilmelidir (`HTTP 401 Unauthorized`).
  - [ ] Token çalınması durumunda (Token Reuse Detection) kullanıcının tüm aktif oturumları Redis'ten silinmelidir.

---

### `[BE-04]` Redis Redlock Dağıtık Kilit, Zod Doğrulama & Global Exception Filter
* **Öncelik:** `P1 - High` | **Bağımlılık:** `BE-03`
* **Teknik Spesifikasyon:**
  * Eşzamanlı yakıt çekiminde Race Condition engellemek için `ioredis` + `redlock` algoritması kurulmalıdır (`lock:tank:{tankId}` ve `lock:vehicle:{vehicleId}`).
  * Tüm HTTP gövdeleri `Zod` veya `class-validator` ile katı biçimde doğrulanmalı; tanımsız alanlar (`stripUnknown: true`) elenmelidir.
  * Merkezi Hata Filtresi ile sistem iç hataları (stack trace) istemciye sızdırılmamalı, benzersiz bir `trace_id` üretilerek `pino` logger'a yazılmalıdır.
* **Kabul Kriterleri (AC):**
  - [ ] Aynı araca aynı anda 2 farklı pompadan ikmal başlatma isteği geldiğinde ikinci istek `HTTP 409 Conflict` dönmelidir.
  - [ ] Geçersiz formatlı girdiler `HTTP 400 Bad Request` ile alan bazlı hata mesajı üretmelidir.

---

### `[BE-05]` Node.js Test Stratejisi (Testcontainers & k6 Load Testing)
* **Öncelik:** `P1 - High` | **Bağımlılık:** `BE-04`
* **Teknik Spesifikasyon:**
  * Birim Testleri: Servis mantığı ve algoritmalar için Vitest / Jest (%85+ code coverage).
  * Entegrasyon Testleri: `@testcontainers/postgresql` ve `@testcontainers/redis` ile gerçek konteynerlerde tam ikmal döngüsü testi.
  * Yük Testi: `k6` scriptleri ile 100 eşzamanlı pompadan saniyede 1.000 telemetri paketi gönderimi.
* **Kabul Kriterleri (AC):**
  - [ ] k6 yük testinde Node.js event loop lag < 50ms ve P95 yanıt süresi < 200ms kalmalıdır.
  - [ ] Paket kaybı oranı %0 olmalıdır.

---

# BÖLÜM 3: FRONTEND SORUNLARI VE TEKNİK SPESİFİKASYONLARI

```
[CRITICAL FRONTEND ROADMAP]
 ├── FE-01: Zustand, TanStack Query v5 & Socket.io Canlı Telemetri
 ├── FE-02: React Error Boundaries, Skeleton Loading & Empty States
 ├── FE-03: Lazy Loading, Virtual Scrolling & Bundle Optimizasyonu
 ├── FE-04: WCAG 2.1 AA Erişilebilirlik, Saha Tableti Touch UI
 └── FE-05: Playwright E2E & React Testing Library Entegrasyonu
```

---

### `[FE-01]` Durum Yönetimi (Zustand + React Query v5) & Socket.io Canlı Telemetri
* **Öncelik:** `P0 - Blocker` | **Bağımlılık:** Yok
* **Teknik Spesifikasyon:**
  * Sunucu verileri için `TanStack Query (React Query) v5`, istemci yerel durumları için `Zustand` kullanılmalıdır.
  * Pompa debi hızları ve tank seviyeleri için `socket.io-client` kurulmalı; oda bazlı abonelik yapılmalıdır (`subscribe:site:{siteId}`).
* **Uç Durum (Edge Case):**
  * WebSocket bağlantısı koptuğunda UI üzerinde sarı "Bağlantı Yenileniyor..." uyarı çubuğu çıkmalı, otomatik Exponential Backoff ile yeniden bağlanmalı ve kaçırılan veriler için HTTP REST API'den senkronizasyon yapılmalıdır.
* **Kabul Kriterleri (AC):**
  - [ ] Sekme arka plana alındığında gereksiz render'lar durdurulmalı, bellek sızıntısı (Memory Leak) önlenmelidir.

---

### `[FE-02]` Hata Sınırları (Error Boundaries), Skeleton Loading & Boş Durumlar
* **Öncelik:** `P1 - High` | **Bağımlılık:** `FE-01`
* **Teknik Spesifikasyon:**
  * Tek bir bileşendeki hatanın tüm sayfayı beyaz ekrana düşürmesini engellemek için modüler `React Error Boundary` blokları yerleştirilmelidir.
  * Veriler yüklenirken ekranlarda Layout Shift (CLS) olmaması için tablolara ve kartlara özel `Skeleton Loading` animasyonları eklenmelidir.
* **Kabul Kriterleri (AC):**
  - [ ] Hata durumunda kullanıcıya "Yeniden Dene" butonu ve teknik destek için `Error Reference ID` gösterilmelidir.
  - [ ] CLS (Cumulative Layout Shift) skoru 0.05'in altında olmalıdır.

---

### `[FE-03]` Performans Optimizasyonu, Lazy Loading & Sanallaştırma (Virtual Scrolling)
* **Öncelik:** `P1 - High` | **Bağımlılık:** `FE-02`
* **Teknik Spesifikasyon:**
  * `React.lazy` ve `Suspense` ile sayfa bazlı rota bölme (Route-based Code Splitting) uygulanmalıdır.
  * 1.000+ satırlık tablolarda DOM şişmesini engellemek için `react-virtual` entegre edilmelidir.
* **Kabul Kriterleri (AC):**
  - [ ] Ana giriş bundle boyutu (Gzip sonrası) 200 KB altında olmalıdır.
  - [ ] Lighthouse Performance skoru masaüstünde 90+, mobilde 80+ olmalıdır.

---

### `[FE-04]` Erişilebilirlik (WCAG 2.1 AA), Touch Targets & Saha Tableti Uyumluluğu
* **Öncelik:** `P2 - Medium` | **Bağımlılık:** `FE-03`
* **Teknik Spesifikasyon:**
  * Saha operatörlerinin eldivenle tablet kullanabilmesi için dokunma hedefleri minimum `48x48px` olmalıdır.
  * Kontrast oranları WCAG AA standardına (minimum 4.5:1) uygun hale getirilmelidir.
* **Kabul Kriterleri (AC):**
  - [ ] `axe-core` ve Lighthouse Accessibility testlerinden 95+ puan alınmalıdır.
  - [ ] Mobil ve tablet ekranlarda yatay taşma (horizontal scroll) olmamalıdır.

---

### `[FE-05]` Frontend Test Süitleri (Playwright E2E)
* **Öncelik:** `P1 - High` | **Bağımlılık:** `FE-04`
* **Teknik Spesifikasyon:**
  * Kritik akışlar için Playwright E2E testleri:
    1. Giriş yapma -> Şantiye seçme -> Canlı pompayı izleme.
    2. İkmal hareketleri tablosundan filtreleme yapıp toplam satırlı Excel indirme.
    3. Firma modüllerini açıp kapatma ve lisans durumunu askıya alma.
* **Kabul Kriterleri (AC):**
  - [ ] Playwright E2E testleri Chromium, Firefox ve WebKit üzerinde hatasız koşmalıdır.

---

# BÖLÜM 4: NODE.JS KRİTİK YOL VE BAĞIMLILIK HARİTASI

```
[FAZ 1: VERİ & ÇEKİRDEK GÜVENLİK]
  BE-02 (PostgreSQL RLS & AsyncLocalStorage) ──► BE-03 (Auth & Node.js Crypto HMAC)
                                                           │
[FAZ 2: DAĞITIK MOTOR & API]                              ▼
  BE-01 (Idempotent API & MQTT.js) ◄────────────── BE-04 (Redlock & Pino Logger)
        │
        ▼
  BE-05 (Testcontainers & k6 Yük Testi)
        │
        ▼
[FAZ 3: FRONTEND MODERNİZASYONU]
  FE-01 (Zustand & Socket.io) ───────────────────► FE-02 (Error Boundaries & Skeletons)
                                                           │
[FAZ 4: PERFORMANS & DOĞRULAMA]                           ▼
  FE-03 (Bundle & Virtual Scroll) ────────────────► FE-04 (A11y & Touch UI)
                                                           │
                                                           ▼
                                                  FE-05 (Playwright E2E)
                                                           │
                                                           ▼
                                            [🚀 CANLI SAHA OTOMASYONU]
```
