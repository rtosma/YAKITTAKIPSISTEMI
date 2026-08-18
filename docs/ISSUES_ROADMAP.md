# 📋 PROJE MASTER İŞ VE GÖREV DÖKÜMÜ
**Proje Adı:** Endüstriyel IoT Destekli Çok Kiracılı (Multi-Tenant) Akaryakıt, Şantiye ve Telemetri Yönetim Platformu  
**Backend:** Node.js (TypeScript) + NestJS + Drizzle ORM + PostgreSQL 16/TimescaleDB + Redis/BullMQ + EMQX (MQTT v5)  
**Firmware:** ESP32 + **ESP-IDF v5.x** (FreeRTOS, güvenli OTA, NVS şifreleme)  
**Frontend:** React 18 + TypeScript + Vite + TanStack Query v5 + Zustand  
**Hedef:** Sıfır hata toleransı, uçtan uca bütünsel mimari, donanım-bulut entegrasyonu ve kurumsal SaaS olgunluğu  
**Sürüm:** Node.js Enterprise Roadmap **v2.2** (v2.1 genişletildi — 6 yeni modül grubu, firmware ve rapor kataloğu eklendi)  
**Toplam iş paketi:** 198 (18 epic + 180 alt/bağımsız issue)  

> ⚙️ Bu dosya `scripts/roadmap/` altındaki katalogdan otomatik üretilir (`node scripts/roadmap/generate-roadmap-doc.mjs`). Elle düzenlemeyin; kaynağı `scripts/roadmap/catalog/*.mjs` dosyalarıdır.

---

## 🧭 Önceliklendirme ve Efor Skalası
* **Öncelik:** `[P0 - Blocker]` sistem çalışması için zorunlu / güvenlik / veri kaybı riski · `[P1 - High]` temel iş süreçleri · `[P2 - Medium]` deneyim, analitik, optimizasyon · `[P3 - Low]` ikincil ve opsiyonel
* **Efor:** `[XS]` 1-2 gün · `[S]` 3-5 gün · `[M]` 1-2 hafta · `[L]` 2-3 hafta · `[XL]` 1+ ay
* **Not:** `[L]` ve `[XL]` iş paketleri **epic** olarak tutulur ve her biri `XS`/`S` boyutunda alt issue’lara bölünmüştür.

## 🎯 Alınan Temel Kararlar
| Konu | Karar | Gerekçe |
|---|---|---|
| Firmware framework | **ESP-IDF v5.x** | Gerçek task watchdog, güvenli OTA + rollback, NVS şifreleme, brown-out detector — röle süren bir cihazda zorunlu |
| Sunucuya ulaşılamadığında | **Hibrit sınırlı fail-open** | Şantiye durmaz; yerel whitelist + araç başına 200 L + günde 1 alım + 24 saat liste tazeliği ile kaçak riski sınırlanır (`FUEL-410`, `FW-1310`) |
| Ölçek profili | **Orta** (5-20 firma, 20-80 şantiye, 100-300 cihaz) | Günde 2.000-10.000 ikmal; read replica, Redis cluster ve EMQX çok düğüm FAZ 2’den itibaren planlanır |
| Tenant izolasyonu | **PostgreSQL RLS + AsyncLocalStorage** | Uygulama katmanında unutulan filtre veri sızıntısına dönüşmemeli |
| Kota kontrolü kesintide | **Fail-close** | Cihaz yetkilendirmesinden farklı: kota aşımı riski, kesinti riskinden ağırdır (`RES-905`) |

---

## 📅 Faz Planı ve Milestone’lar

| Faz | Milestone | Issue | Kapsam |
|---|---|---|---|
| FAZ 1 | FAZ 1 — Çekirdek Altyapı & Güvenlik (Hafta 1-3) | 35 | Multi-tenancy, kimlik, güvenlik, CI/CD temeli |
| FAZ 2 | FAZ 2 — IoT Haberleşme & Akaryakıt Otomasyonu (Hafta 4-6) | 63 | MQTT/LoRaWAN, ESP32 firmware, ikmal otomasyonu, filo/tank tanımları |
| FAZ 3 | FAZ 3 — Anomali, Mevzuat & Raporlama (Hafta 7-9) | 71 | Anomali tespiti, e-İrsaliye, 13 rapor, bildirim kanalları |
| FAZ 4 | FAZ 4 — Test, Stres Testi & Canlıya Çıkış (Hafta 10-12) | 17 | Test otomasyonu, yük testi, izleme, yedekleme, canlıya çıkış |
| FAZ 5 | FAZ 5 — Kapsam Genişletme (Backlog) | 12 | Lisans, İK, bakım-lastik, envanter, laboratuvar (canlı sonrası) |

## 📊 Modül × Faz Dağılımı

| Modül | FAZ 1 | FAZ 2 | FAZ 3 | FAZ 4 | FAZ 5 | Toplam |
|---|---:|---:|---:|---:|---:|---:|
| ARCH — Mimari & Çoklu Kiracılık (Multi-Tenancy) | 13 | 4 | 2 | – | 1 | **20** |
| AUTH — Kimlik Doğrulama, Yetkilendirme & Güvenlik | 10 | 3 | 2 | – | – | **15** |
| IOT — Donanım Haberleşmesi, Telemetri & MQTT | – | 12 | 2 | – | – | **14** |
| FW — ESP32 Firmware (ESP-IDF) | – | 13 | 4 | – | – | **17** |
| FUEL — Akaryakıt Otomasyonu, RFID & İkmal Protokolü | – | 17 | 3 | – | – | **20** |
| FLEET — Filo, Araç & Sürücü Yönetimi | – | 3 | 3 | – | 3 | **9** |
| INV — Stok, Tedarik & Maliyet | – | 1 | 4 | – | 2 | **7** |
| AI — Yapay Zeka & Anomali Tespiti | – | – | 8 | – | – | **8** |
| COMP — GİB e-İrsaliye, UBL-TR & Mevzuat | – | – | 9 | – | – | **9** |
| REP — Raporlama, Export & Arşivleme | – | – | 18 | – | 1 | **19** |
| FE — Frontend & Üç Panel | 1 | 9 | 9 | 1 | – | **20** |
| NOTIF — Bildirim & Alarm | – | – | 6 | – | – | **6** |
| RES — Hata Yönetimi & Dayanıklılık | 3 | – | 1 | 2 | – | **6** |
| TEST — Test Otomasyonu | 1 | – | – | 6 | – | **7** |
| OPS — DevOps, Container, CI/CD & İzleme | 4 | – | – | 5 | – | **9** |
| DOC — Dokümantasyon | 3 | 1 | – | 3 | – | **7** |
| BILL — SaaS Abonelik & Lisans | – | – | – | – | 4 | **4** |
| HR — İnsan Kaynakları | – | – | – | – | 1 | **1** |
| **TOPLAM** | **35** | **63** | **71** | **17** | **12** | **198** |

---

# 🏗️ ARCH — Mimari & Çoklu Kiracılık (Multi-Tenancy)

| Kod | Issue | Başlık | Faz | Öncelik | Efor | Bağımlı olduğu |
|---|---|---|---|---|---|---|
| `ARCH-101` 🎯 | [#13](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/13) | EPIC — AsyncLocalStorage + PostgreSQL RLS ile multi-tenant izolasyon | FAZ 1 | P0-Blocker | L | `ARCH-100`, `ARCH-109` |
| &nbsp;&nbsp;↳ `ARCH-101.1` | [#18](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/18) | TenantContext (AsyncLocalStorage) middleware ve interceptor | FAZ 1 | P0-Blocker | S | `ARCH-100` |
| &nbsp;&nbsp;↳ `ARCH-101.2` | [#19](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/19) | Drizzle transaction wrapper + SET LOCAL app.current_tenant_id | FAZ 1 | P0-Blocker | S | `ARCH-101.1` |
| &nbsp;&nbsp;↳ `ARCH-101.3` | [#20](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/20) | Tüm tenant tablolarına RLS politikası migration’ı | FAZ 1 | P0-Blocker | S | `ARCH-101.2` |
| &nbsp;&nbsp;↳ `ARCH-101.4` | [#21](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/21) | WebSocket, MQTT worker ve BullMQ job’larında tenant context taşınması | FAZ 1 | P0-Blocker | XS | `ARCH-101.2` |
| `ARCH-102` 🎯 | [#14](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/14) | EPIC — Event-driven olay veri yolu | FAZ 1 | P1-High | M | `ARCH-101` |
| &nbsp;&nbsp;↳ `ARCH-102.1` | [#22](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/22) | Domain event publisher/handler altyapısı ve Idempotency-Key denetleyicisi | FAZ 1 | P1-High | S | `ARCH-101.2` |
| &nbsp;&nbsp;↳ `ARCH-102.3` | [#58](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/58) | BullMQ Dead Letter Queue ve retry/backoff politikası | FAZ 2 | P1-High | S | `ARCH-102.1` |
| `ARCH-103` 🎯 | [#48](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/48) | EPIC — TimescaleDB stream batch ingestion motoru | FAZ 2 | P1-High | M | `ARCH-109` |
| &nbsp;&nbsp;↳ `ARCH-103.1` | [#59](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/59) | Hypertable şeması, chunk aralığı ve sıkıştırma politikası | FAZ 2 | P1-High | S | `ARCH-109` |
| &nbsp;&nbsp;↳ `ARCH-103.2` | [#60](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/60) | Mikro-batch buffer (500ms / 1.000 kayıt) ve pg-copy-streams toplu yazım | FAZ 2 | P1-High | S | `ARCH-103.1` |
| &nbsp;&nbsp;↳ `ARCH-103.3` | [#122](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/122) | Continuous aggregate (saatlik/günlük rollup) katmanı | FAZ 3 | P2-Medium | S | `ARCH-103.2` |
| `ARCH-100` | [#17](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/17) | Monorepo iskeleti ve workspace ayrımı | FAZ 1 | P0-Blocker | S | – |
| `ARCH-104` | [#23](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/23) | packages/shared: ortak tip, enum ve Zod şemaları | FAZ 1 | P1-High | XS | `ARCH-100` |
| `ARCH-109` | [#26](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/26) | Drizzle migration ve seed stratejisi | FAZ 1 | P0-Blocker | XS | `ARCH-100` |
| `ARCH-110` | [#27](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/27) | Zod tabanlı environment ve config doğrulama | FAZ 1 | P0-Blocker | XS | `ARCH-100` |
| `ARCH-105` | [#24](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/24) | Tenant onboarding / provisioning akışı | FAZ 1 | P1-High | S | `ARCH-101`, `AUTH-201.1` |
| `ARCH-106` | [#25](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/25) | Tenant bazlı feature-flag ve modül aç/kapa altyapısı | FAZ 1 | P1-High | S | `ARCH-101` |
| `ARCH-107` | [#123](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/123) | Veri saklama (retention) politikası ve otomatik purge job’ı | FAZ 3 | P2-Medium | S | `ARCH-103.1`, `REP-702` |
| `ARCH-108` | [#199](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/199) | Tenant dondurma, silme ve veri dışa aktarımı | FAZ 5 | P2-Medium | S | `ARCH-106`, `REP-702` |

# 🔐 AUTH — Kimlik Doğrulama, Yetkilendirme & Güvenlik

| Kod | Issue | Başlık | Faz | Öncelik | Efor | Bağımlı olduğu |
|---|---|---|---|---|---|---|
| `AUTH-201` 🎯 | [#15](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/15) | EPIC — JWT rotation, Passport.js ve Argon2id kimlik altyapısı | FAZ 1 | P0-Blocker | M | `ARCH-101` |
| &nbsp;&nbsp;↳ `AUTH-201.1` | [#28](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/28) | Argon2id parola saklama ve login/logout uçları | FAZ 1 | P0-Blocker | S | `ARCH-101.2` |
| &nbsp;&nbsp;↳ `AUTH-201.2` | [#29](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/29) | Access/Refresh token rotasyonu, Redis store ve token reuse detection | FAZ 1 | P0-Blocker | S | `AUTH-201.1` |
| &nbsp;&nbsp;↳ `AUTH-201.4` | [#30](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/30) | RBAC guard’ları ve 5 rollü yetki matrisi | FAZ 1 | P0-Blocker | S | `AUTH-201.1` |
| `AUTH-202` 🎯 | [#16](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/16) | EPIC — Donanım kimlik doğrulama (HMAC-SHA256) | FAZ 1 | P0-Blocker | L | `ARCH-101` |
| &nbsp;&nbsp;↳ `AUTH-202.1` | [#31](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/31) | Raw body interceptor ve HMAC-SHA256 doğrulayıcı | FAZ 1 | P0-Blocker | S | `ARCH-110` |
| &nbsp;&nbsp;↳ `AUTH-202.2` | [#32](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/32) | Replay koruması: timestamp penceresi ve nonce denetimi | FAZ 1 | P0-Blocker | XS | `AUTH-202.1` |
| &nbsp;&nbsp;↳ `AUTH-202.3` | [#61](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/61) | Cihaz secret üretimi, saklanması ve rotasyonu | FAZ 2 | P0-Blocker | S | `AUTH-202.1`, `IOT-304` |
| `AUTH-203` | [#33](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/33) | Append-only audit trail servisi | FAZ 1 | P1-High | S | `ARCH-101.2` |
| `AUTH-204` | [#34](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/34) | Şantiye oluşturulurken otomatik kullanıcı/parola üretimi ve ilk girişte zorunlu değişiklik | FAZ 1 | P0-Blocker | S | `AUTH-201` |
| `AUTH-206` | [#62](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/62) | Parola sıfırlama (tek kullanımlık token) akışı | FAZ 2 | P1-High | S | `AUTH-201.2`, `NOTIF-1602` |
| `AUTH-207` | [#124](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/124) | TOTP tabanlı 2FA (SUPER_ADMIN ve COMPANY_OWNER için zorunlu) | FAZ 3 | P2-Medium | S | `AUTH-201.2` |
| `AUTH-208` | [#125](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/125) | Aktif oturum/cihaz listesi ve uzaktan oturum kapatma | FAZ 3 | P2-Medium | S | `AUTH-201.2` |
| `AUTH-209` | [#35](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/35) | Brute-force koruması, rate-limit ve hesap kilitleme | FAZ 1 | P0-Blocker | S | `AUTH-201.1` |
| `AUTH-210` | [#63](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/63) | RFID kart kayıp/blokaj ve kara liste akışı | FAZ 2 | P1-High | S | `IOT-305`, `FLEET-1402` |

# 📡 IOT — Donanım Haberleşmesi, Telemetri & MQTT

| Kod | Issue | Başlık | Faz | Öncelik | Efor | Bağımlı olduğu |
|---|---|---|---|---|---|---|
| `IOT-301` 🎯 | [#55](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/55) | EPIC — MQTT v5 telemetri ingestion katmanı | FAZ 2 | P0-Blocker | L | `AUTH-202`, `OPS-1103` |
| &nbsp;&nbsp;↳ `IOT-301.1` | [#102](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/102) | EMQX bağlantısı, QoS 1, reconnect ve topic şeması | FAZ 2 | P0-Blocker | S | `OPS-1103` |
| &nbsp;&nbsp;↳ `IOT-301.2` | [#103](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/103) | LWT ile cihaz OFFLINE tespiti ve Redis presence kaydı | FAZ 2 | P0-Blocker | S | `IOT-301.1` |
| &nbsp;&nbsp;↳ `IOT-301.3` | [#104](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/104) | Payload doğrulama ve worker thread parse hattı | FAZ 2 | P1-High | S | `IOT-301.1`, `ARCH-103.2` |
| `IOT-302` 🎯 | [#56](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/56) | EPIC — LoRaWAN binary payload decoder | FAZ 2 | P1-High | M | `IOT-301` |
| &nbsp;&nbsp;↳ `IOT-302.1` | [#105](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/105) | ChirpStack/TTN uplink webhook ve Buffer decoder (bozuk paket izolasyonu dahil) | FAZ 2 | P1-High | S | `IOT-301.3` |
| `IOT-303` 🎯 | [#57](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/57) | EPIC — Çevrimdışı (offline-first) toplu yükleme API’si | FAZ 2 | P0-Blocker | L | `IOT-301`, `FUEL-401` |
| &nbsp;&nbsp;↳ `IOT-303.1` | [#106](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/106) | sync-batch endpoint ve local_sequence_id ile deduplication | FAZ 2 | P0-Blocker | S | `FUEL-401.4` |
| &nbsp;&nbsp;↳ `IOT-303.2` | [#107](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/107) | Kronolojik geriye dönük stok düşümü ve atomik işleme | FAZ 2 | P0-Blocker | S | `IOT-303.1` |
| `IOT-304` | [#108](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/108) | Cihaz provisioning ve eşleştirme (device claim) akışı | FAZ 2 | P0-Blocker | S | `ARCH-105` |
| `IOT-305` | [#109](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/109) | device_shadow ve uzaktan komut kuyruğu (ack, timeout, retry) | FAZ 2 | P1-High | S | `IOT-304` |
| `IOT-306` | [#156](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/156) | OTA firmware dağıtım servisi (sürüm, kanal, kademeli rollout) | FAZ 3 | P1-High | S | `IOT-305`, `FW-1311` |
| `IOT-307` | [#110](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/110) | NTP/RTC saat senkronu ve saat sapması tespiti | FAZ 2 | P1-High | XS | `AUTH-202.2` |
| `IOT-308` | [#157](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/157) | Cihaz sağlık skoru, sürüm envanteri ve online SLA takibi | FAZ 3 | P2-Medium | S | `IOT-301.2`, `IOT-306` |

# 🔧 FW — ESP32 Firmware (ESP-IDF)

| Kod | Issue | Başlık | Faz | Öncelik | Efor | Bağımlı olduğu |
|---|---|---|---|---|---|---|
| `FW-1300` 🎯 | [#49](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/49) | EPIC — ESP32 pompa kontrol ünitesi firmware’i (ESP-IDF) | FAZ 2 | P0-Blocker | XL | `AUTH-202`, `DOC-1202` |
| &nbsp;&nbsp;↳ `FW-1301` | [#65](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/65) | ESP-IDF proje iskeleti, partition table ve build/flash pipeline | FAZ 2 | P0-Blocker | S | – |
| &nbsp;&nbsp;↳ `FW-1302` | [#66](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/66) | RFID okuyucu sürücüsü ve kart UID okuma | FAZ 2 | P0-Blocker | S | `FW-1301` |
| &nbsp;&nbsp;↳ `FW-1303` | [#67](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/67) | Röle sürme, güvenli kesme ve donanımsal interlock | FAZ 2 | P0-Blocker | S | `FW-1301` |
| &nbsp;&nbsp;↳ `FW-1304` | [#68](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/68) | Akışmetre pals sayımı (ISR + debounce), totalizatör ve K-factor uygulaması | FAZ 2 | P0-Blocker | S | `FW-1301` |
| &nbsp;&nbsp;↳ `FW-1306` | [#69](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/69) | WiFi/GSM bağlantı yöneticisi ve otomatik yeniden bağlanma | FAZ 2 | P0-Blocker | S | `FW-1301` |
| &nbsp;&nbsp;↳ `FW-1307` | [#70](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/70) | MQTT/HTTPS istemcisi ve TLS sertifika yönetimi | FAZ 2 | P0-Blocker | S | `FW-1306` |
| &nbsp;&nbsp;↳ `FW-1308` | [#71](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/71) | HMAC-SHA256 paket imzalama, timestamp ve nonce | FAZ 2 | P0-Blocker | S | `FW-1307`, `AUTH-202.3` |
| &nbsp;&nbsp;↳ `FW-1309` | [#72](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/72) | LittleFS offline kuyruk (ring buffer) ve batch sync istemcisi | FAZ 2 | P0-Blocker | S | `FW-1308`, `IOT-303` |
| &nbsp;&nbsp;↳ `FW-1310` | [#73](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/73) | Sınırlı fail-open yetki önbelleği (yerel whitelist ve limitler) | FAZ 2 | P0-Blocker | S | `FW-1309`, `FW-1302`, `FUEL-410` |
| &nbsp;&nbsp;↳ `FW-1311` | [#133](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/133) | Güvenli OTA ve A/B partition rollback | FAZ 3 | P1-High | S | `FW-1307` |
| &nbsp;&nbsp;↳ `FW-1312` | [#74](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/74) | RTC (DS3231) entegrasyonu ve NTP saat senkronu | FAZ 2 | P1-High | XS | `FW-1306`, `IOT-307` |
| &nbsp;&nbsp;↳ `FW-1313` | [#75](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/75) | Task watchdog (TWDT), brown-out detector ve panik kurtarma | FAZ 2 | P0-Blocker | XS | `FW-1303` |
| &nbsp;&nbsp;↳ `FW-1314` | [#76](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/76) | Güç kesintisinde totalizatör koruma (NVS commit stratejisi) | FAZ 2 | P0-Blocker | S | `FW-1304` |
| &nbsp;&nbsp;↳ `FW-1315` | [#134](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/134) | Akışmetre arıza tespiti (röle açık, pals yok) ve otomatik kesme | FAZ 3 | P1-High | S | `FW-1303`, `FW-1304` |
| &nbsp;&nbsp;↳ `FW-1316` | [#135](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/135) | OLED/LCD ekran ve buzzer ile operatör geri bildirimi (Türkçe) | FAZ 3 | P1-High | S | `FW-1302` |
| &nbsp;&nbsp;↳ `FW-1317` | [#136](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/136) | Cihaz konfigürasyon portalı (WiFi/APN, captive portal) | FAZ 3 | P1-High | S | `FW-1306`, `IOT-304` |

# ⛽ FUEL — Akaryakıt Otomasyonu, RFID & İkmal Protokolü

| Kod | Issue | Başlık | Faz | Öncelik | Efor | Bağımlı olduğu |
|---|---|---|---|---|---|---|
| `FUEL-401` 🎯 | [#51](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/51) | EPIC — İkmal handshake, RFID doğrulama ve heartbeat motoru | FAZ 2 | P0-Blocker | L | `IOT-301`, `ARCH-102` |
| &nbsp;&nbsp;↳ `FUEL-401.1` | [#88](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/88) | request-auth ucu (<200ms) ve yetki kontrol zinciri | FAZ 2 | P0-Blocker | S | `FLEET-1402`, `FUEL-402.1` |
| &nbsp;&nbsp;↳ `FUEL-401.2` | [#89](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/89) | Redis TTL ile ikmal oturumu ve durum makinesi | FAZ 2 | P0-Blocker | S | `FUEL-401.1` |
| &nbsp;&nbsp;↳ `FUEL-401.3` | [#90](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/90) | Heartbeat izleme, 15sn timeout → FORCE_CUTOFF ve maksimum limitler | FAZ 2 | P0-Blocker | S | `FUEL-401.2` |
| &nbsp;&nbsp;↳ `FUEL-401.4` | [#91](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/91) | finalize ucu, totalizatör kilidi ve idempotency | FAZ 2 | P0-Blocker | S | `FUEL-401.3` |
| `FUEL-402` 🎯 | [#52](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/52) | EPIC — Çapraz şantiye kota motoru (Redlock) | FAZ 2 | P1-High | M | `ARCH-101` |
| &nbsp;&nbsp;↳ `FUEL-402.1` | [#92](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/92) | Kota tanımı, dönemsel sıfırlama ve kalan kota sorgusu | FAZ 2 | P1-High | S | `ARCH-101` |
| &nbsp;&nbsp;↳ `FUEL-402.2` | [#93](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/93) | Redlock ve SELECT FOR UPDATE ile eşzamanlılık koruması, QUOTA_EXHAUSTED yanıtı | FAZ 2 | P1-High | S | `FUEL-402.1` |
| `FUEL-403` 🎯 | [#53](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/53) | EPIC — Tank seviye-hacim (strapping table) matematik motoru | FAZ 2 | P1-High | M | `IOT-302` |
| &nbsp;&nbsp;↳ `FUEL-403.1` | [#94](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/94) | CSV strapping table import, doğrulama ve cache | FAZ 2 | P1-High | S | `INV-1501` |
| &nbsp;&nbsp;↳ `FUEL-403.2` | [#95](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/95) | Lineer interpolasyon ve ASTM D1250 sıcaklık düzeltmesi | FAZ 2 | P1-High | S | `FUEL-403.1` |
| `FUEL-404` 🎯 | [#54](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/54) | EPIC — K-factor uzaktan kalibrasyon akışı | FAZ 2 | P0-Blocker | M | `IOT-305` |
| &nbsp;&nbsp;↳ `FUEL-404.1` | [#96](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/96) | Kalibrasyon komutu, ack, geri alma ve geçmiş kaydı | FAZ 2 | P0-Blocker | S | `IOT-305`, `AUTH-203` |
| &nbsp;&nbsp;↳ `FUEL-404.2` | [#97](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/97) | Kalibrasyon test alımı sihirbazı (referans kap ile sapma hesabı) | FAZ 2 | P0-Blocker | S | `FUEL-404.1`, `FW-1304` |
| `FUEL-405` | [#149](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/149) | Manuel ikmal girişi (cihaz arızası) ve çift onay mekanizması | FAZ 3 | P1-High | S | `FUEL-401.4`, `FW-1314` |
| `FUEL-406` | [#98](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/98) | Kartsız/yetkisiz akış alarmı ve acil kesme | FAZ 2 | P1-High | S | `FUEL-401.2` |
| `FUEL-407` | [#99](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/99) | Çoklu tank, pompa ve yakıt tipi modeli (Motorin, Benzin, AdBlue) | FAZ 2 | P1-High | S | `INV-1501` |
| `FUEL-408` | [#150](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/150) | Tank dolum (alım irsaliyesi) girişi ve stok artışı | FAZ 3 | P1-High | S | `FUEL-403`, `INV-1502` |
| `FUEL-409` | [#151](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/151) | Teorik vs fiziksel stok mutabakatı ve fire hesabı | FAZ 3 | P1-High | S | `FUEL-408`, `IOT-303.2`, `FUEL-403` |
| `FUEL-410` | [#100](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/100) | Hibrit fail-open politika motoru (sunucu erişilemezliği) | FAZ 2 | P0-Blocker | S | `IOT-305` |

# 🚚 FLEET — Filo, Araç & Sürücü Yönetimi

| Kod | Issue | Başlık | Faz | Öncelik | Efor | Bağımlı olduğu |
|---|---|---|---|---|---|---|
| `FLEET-1401` | [#77](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/77) | Araç ve iş makinesi kartı (CRUD) | FAZ 2 | P1-High | S | `ARCH-101` |
| `FLEET-1402` | [#78](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/78) | RFID tag eşleştirme, değiştirme ve geçmişi | FAZ 2 | P1-High | S | `FLEET-1401` |
| `FLEET-1403` | [#79](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/79) | Sürücü tanımı, RFID kartı ve şantiye ataması | FAZ 2 | P1-High | S | `ARCH-101` |
| `FLEET-1404` | [#137](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/137) | Dönem başı/sonu km ve motor-saat (hourmeter) girişi | FAZ 3 | P1-High | S | `FLEET-1401` |
| `FLEET-1405` | [#138](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/138) | L/100km ve L/motor-saat tüketim hesap motoru | FAZ 3 | P1-High | S | `FLEET-1404` |
| `FLEET-1406` | [#139](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/139) | Araç bazlı aylık limit ve kota tanımı | FAZ 3 | P2-Medium | S | `FUEL-402.1`, `FLEET-1401` |
| `FLEET-1407` | [#204](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/204) | Bakım-servis kaydı ve yakıt maliyeti ilişkisi | FAZ 5 | P2-Medium | S | `FLEET-1405` |
| `FLEET-1408` | [#205](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/205) | Araç muayene, periyodik bakım ve lastik takip merkezi | FAZ 5 | P2-Medium | S | `FLEET-1407` |
| `FLEET-1409` | [#206](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/206) | Araç doküman/ruhsat arşivi ve son kullanma uyarıları | FAZ 5 | P3-Low | XS | `FLEET-1401` |

# 📦 INV — Stok, Tedarik & Maliyet

| Kod | Issue | Başlık | Faz | Öncelik | Efor | Bağımlı olduğu |
|---|---|---|---|---|---|---|
| `INV-1501` | [#101](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/101) | Tank tanımı, kapasite ve sensör eşleştirme | FAZ 2 | P1-High | S | `ARCH-101` |
| `INV-1502` | [#152](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/152) | Tedarikçi tanımı ve yakıt alım (dolum) irsaliyesi kaydı | FAZ 3 | P1-High | S | `INV-1501` |
| `INV-1503` | [#153](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/153) | Birim fiyat geçmişi ve dönemsel maliyet hesabı | FAZ 3 | P1-High | S | `INV-1502` |
| `INV-1504` | [#154](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/154) | Minimum stok eşiği ve otomatik sipariş uyarısı | FAZ 3 | P2-Medium | S | `INV-1501`, `NOTIF-1601` |
| `INV-1505` | [#155](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/155) | Fire/kayıp kaydı ve sınıflandırması | FAZ 3 | P2-Medium | S | `FUEL-409` |
| `INV-1506` | [#208](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/208) | Envanter ve yedek parça stok takibi | FAZ 5 | P3-Low | S | `ARCH-101` |
| `INV-1507` | [#209](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/209) | Şantiye laboratuvar ve numune takibi | FAZ 5 | P3-Low | S | `ARCH-101` |

# 🧠 AI — Yapay Zeka & Anomali Tespiti

| Kod | Issue | Başlık | Faz | Öncelik | Efor | Bağımlı olduğu |
|---|---|---|---|---|---|---|
| `AI-501` 🎯 | [#111](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/111) | EPIC — Debi-seviye korelasyonlu hırsızlık tespit motoru | FAZ 3 | P0-Blocker | L | `ARCH-103`, `FUEL-403` |
| &nbsp;&nbsp;↳ `AI-501.1` | [#115](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/115) | Pompa kapalıyken seviye düşüşü tespiti (STATIC_THEFT_DETECTED) | FAZ 3 | P0-Blocker | S | `FUEL-403`, `FUEL-409` |
| &nbsp;&nbsp;↳ `AI-501.2` | [#116](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/116) | Debi-seviye sapma tespiti (METER_CALIBRATION_TAMPER) | FAZ 3 | P0-Blocker | S | `AI-501.1`, `FW-1315`, `FUEL-407` |
| `AI-502` | [#117](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/117) | Google Gemini SDK ile haftalık tüketim anomali özeti | FAZ 3 | P2-Medium | M | `FLEET-1405`, `ARCH-103.3` |
| `AI-503` | [#118](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/118) | Km/motor-saat bazlı tüketim anomalisi (L/100km sapması) | FAZ 3 | P1-High | S | `FLEET-1405`, `RES-903` |
| `AI-504` | [#119](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/119) | Mesai dışı/gece alım ve kısa aralıkla mükerrer alım tespiti | FAZ 3 | P1-High | XS | `FUEL-401.4` |
| `AI-506` | [#120](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/120) | Şoför davranış skorlama motoru | FAZ 3 | P2-Medium | S | `AI-504`, `FLEET-1403` |
| `AI-507` | [#121](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/121) | Alarm yaşam döngüsü: durum, susturma, eskalasyon, çözüm notu | FAZ 3 | P1-High | S | `AI-501.1`, `AI-504`, `FUEL-406` |

# 📄 COMP — GİB e-İrsaliye, UBL-TR & Mevzuat

| Kod | Issue | Başlık | Faz | Öncelik | Efor | Bağımlı olduğu |
|---|---|---|---|---|---|---|
| `COMP-601` 🎯 | [#112](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/112) | EPIC — UBL-TR 1.2 e-İrsaliye üretimi | FAZ 3 | P1-High | L | `FUEL-401` |
| &nbsp;&nbsp;↳ `COMP-601.1` | [#126](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/126) | DespatchAdvice XML builder, alan eşlemesi ve XSD doğrulama | FAZ 3 | P1-High | S | `FUEL-401.4`, `COMP-605` |
| `COMP-602` 🎯 | [#113](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/113) | EPIC — Özel entegratör istemcisi ve devre kesici | FAZ 3 | P1-High | L | `COMP-601` |
| &nbsp;&nbsp;↳ `COMP-602.1` | [#127](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/127) | Entegratör adaptör arayüzü (SOAP/REST), kuyruk ve belge saklama | FAZ 3 | P1-High | S | `COMP-601.1` |
| &nbsp;&nbsp;↳ `COMP-602.2` | [#128](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/128) | Opossum circuit breaker, retry/backoff ve durum yoklaması | FAZ 3 | P1-High | S | `COMP-602.1` |
| `COMP-603` | [#129](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/129) | e-İrsaliye iptal/red senaryosu ve yeniden gönderim | FAZ 3 | P1-High | S | `COMP-602.1` |
| `COMP-604` | [#130](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/130) | GİB durum kodu takip ekranı ve otomatik durum sorgulama | FAZ 3 | P2-Medium | S | `COMP-602.2` |
| `COMP-605` | [#131](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/131) | Mükellef (VKN) doğrulama ve alıcı bilgisi kontrolü | FAZ 3 | P1-High | S | `ARCH-105` |
| `COMP-606` | [#132](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/132) | KVKK: kişisel veri envanteri, log saklama süresi ve anonimleştirme | FAZ 3 | P1-High | S | `AUTH-203`, `ARCH-107` |

# 📊 REP — Raporlama, Export & Arşivleme

| Kod | Issue | Başlık | Faz | Öncelik | Efor | Bağımlı olduğu |
|---|---|---|---|---|---|---|
| `REP-700` 🎯 | [#114](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/114) | EPIC — Rapor altyapısı ve rapor kataloğu | FAZ 3 | P1-High | L | `ARCH-103.3` |
| &nbsp;&nbsp;↳ `REP-701` | [#164](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/164) | Bellek dostu stream Excel export motoru ve dinamik GENEL TOPLAM satırı | FAZ 3 | P1-High | S | `ARCH-103.3` |
| &nbsp;&nbsp;↳ `REP-702` | [#165](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/165) | Şifreli ZIP arşivleme (cron + manuel) ve presigned indirme bağlantısı | FAZ 3 | P1-High | S | `REP-701` |
| &nbsp;&nbsp;↳ `REP-703` | [#166](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/166) | Ortak rapor çatısı: filtre, sayfalama, rol görünürlüğü, PDF/CSV export | FAZ 3 | P1-High | S | `REP-701`, `ARCH-103.3` |
| &nbsp;&nbsp;↳ `REP-705` | [#167](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/167) | Zamanlanmış rapor gönderimi (cron → e-posta) | FAZ 3 | P2-Medium | S | `REP-703`, `NOTIF-1602` |
| &nbsp;&nbsp;↳ `REP-711` | [#168](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/168) | Rapor: İkmal Hareket Raporu | FAZ 3 | P1-High | S | `REP-703`, `FUEL-401.4`, `FUEL-405` |
| &nbsp;&nbsp;↳ `REP-712` | [#169](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/169) | Rapor: Araç Bazlı Tüketim Raporu (L/100km, L/motor-saat) | FAZ 3 | P1-High | S | `REP-703`, `FLEET-1405`, `AI-503` |
| &nbsp;&nbsp;↳ `REP-713` | [#170](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/170) | Rapor: Şantiye Bazlı Tüketim ve Stok Raporu | FAZ 3 | P1-High | S | `REP-703`, `FUEL-409`, `INV-1504` |
| &nbsp;&nbsp;↳ `REP-714` | [#171](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/171) | Rapor: Tank Mutabakat ve Fire Raporu | FAZ 3 | P1-High | S | `REP-703`, `FUEL-409`, `INV-1505`, `FUEL-408` |
| &nbsp;&nbsp;↳ `REP-715` | [#172](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/172) | Rapor: Çapraz Alım ve Mahsuplaşma Raporu | FAZ 3 | P1-High | S | `REP-703`, `FUEL-402`, `INV-1503` |
| &nbsp;&nbsp;↳ `REP-716` | [#173](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/173) | Rapor: Anomali ve Alarm Raporu | FAZ 3 | P2-Medium | S | `REP-703`, `AI-507`, `AI-501` |
| &nbsp;&nbsp;↳ `REP-717` | [#174](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/174) | Rapor: Cihaz Sağlık ve Kesinti Raporu | FAZ 3 | P2-Medium | S | `REP-703`, `IOT-308` |
| &nbsp;&nbsp;↳ `REP-718` | [#175](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/175) | Rapor: Kalibrasyon Geçmişi Raporu | FAZ 3 | P2-Medium | XS | `REP-703`, `FUEL-404.1`, `FUEL-404.2` |
| &nbsp;&nbsp;↳ `REP-719` | [#176](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/176) | Rapor: Maliyet ve Bütçe Raporu | FAZ 3 | P2-Medium | S | `REP-703`, `INV-1503` |
| &nbsp;&nbsp;↳ `REP-720` | [#177](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/177) | Rapor: Sürücü Bazlı Rapor | FAZ 3 | P2-Medium | S | `REP-703`, `AI-506`, `FLEET-1403` |
| &nbsp;&nbsp;↳ `REP-721` | [#178](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/178) | Rapor: e-İrsaliye Durum Raporu | FAZ 3 | P2-Medium | XS | `REP-703`, `COMP-602`, `COMP-603`, `COMP-604` |
| &nbsp;&nbsp;↳ `REP-722` | [#179](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/179) | Rapor: Denetim (Audit) Raporu | FAZ 3 | P2-Medium | XS | `REP-703`, `AUTH-203` |
| &nbsp;&nbsp;↳ `REP-723` | [#180](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/180) | Rapor: Yönetici Özet Dashboard’u (KPI, trend, ilk 10) | FAZ 3 | P2-Medium | S | `REP-703`, `ARCH-103.3` |
| `REP-724` | [#210](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/210) | Rapor: AI destekli aylık yönetim raporu | FAZ 5 | P3-Low | S | `AI-502`, `REP-705` |

# 💻 FE — Frontend & Üç Panel

| Kod | Issue | Başlık | Faz | Öncelik | Efor | Bağımlı olduğu |
|---|---|---|---|---|---|---|
| `FE-800` 🎯 | [#50](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/50) | EPIC — Frontend uygulama iskeleti ve 3 panel ekran envanteri | FAZ 2 | P1-High | L | `ARCH-100` |
| &nbsp;&nbsp;↳ `FE-804` | [#43](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/43) | Login, ilk giriş parola değiştirme ve parola sıfırlama ekranları | FAZ 1 | P0-Blocker | S | `AUTH-201`, `AUTH-204` |
| &nbsp;&nbsp;↳ `FE-805` | [#81](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/81) | Geliştirici Paneli: firma listesi, tenant detayı ve modül aç/kapa | FAZ 2 | P1-High | S | `ARCH-105`, `ARCH-106`, `FE-803` |
| &nbsp;&nbsp;↳ `FE-806` | [#82](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/82) | Geliştirici Paneli: cihaz sağlığı, canlı log ve sistem metrikleri | FAZ 2 | P1-High | S | `IOT-301.2`, `IOT-308`, `FE-801` |
| &nbsp;&nbsp;↳ `FE-807` | [#83](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/83) | Yönetici Paneli: şantiye oluşturma sihirbazı (kullanıcı/parola üretimi) | FAZ 2 | P1-High | S | `AUTH-204`, `FE-803` |
| &nbsp;&nbsp;↳ `FE-808` | [#84](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/84) | Yönetici Paneli: araç ve sürücü yönetim ekranları | FAZ 2 | P1-High | S | `FLEET-1401`, `FLEET-1402`, `FLEET-1403` |
| &nbsp;&nbsp;↳ `FE-809` | [#85](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/85) | Yönetici Paneli: tank, pompa ve cihaz yönetimi | FAZ 2 | P1-High | S | `INV-1501`, `IOT-304`, `FUEL-403.1` |
| &nbsp;&nbsp;↳ `FE-810` | [#142](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/142) | Çapraz alım yetkilendirme ve kota ekranı | FAZ 3 | P1-High | S | `FUEL-402`, `FE-803` |
| &nbsp;&nbsp;↳ `FE-811` | [#86](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/86) | Şantiye Paneli: canlı ikmal ekranı ve acil durdurma | FAZ 2 | P1-High | S | `FE-801`, `FUEL-401` |
| &nbsp;&nbsp;↳ `FE-812` | [#143](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/143) | İkmal hareketleri tablosu, filtre ve export | FAZ 3 | P1-High | S | `FE-802`, `REP-711` |
| &nbsp;&nbsp;↳ `FE-813` | [#144](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/144) | Km/motor-saat giriş ekranı ve toplu giriş | FAZ 3 | P1-High | S | `FLEET-1404`, `RES-903` |
| &nbsp;&nbsp;↳ `FE-814` | [#145](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/145) | Kalibrasyon (K-factor) ekranı ve test alım sihirbazı | FAZ 3 | P1-High | S | `FUEL-404`, `FE-803` |
| &nbsp;&nbsp;↳ `FE-815` | [#146](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/146) | Alarm/anomali merkezi ve bildirim tercihleri | FAZ 3 | P2-Medium | S | `AI-507`, `NOTIF-1605` |
| &nbsp;&nbsp;↳ `FE-816` | [#147](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/147) | Rapor merkezi ekranı (katalog, filtre, indirme) | FAZ 3 | P2-Medium | S | `REP-703`, `REP-723`, `REP-705` |
| `FE-801` | [#80](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/80) | Socket.io canlı pompa/tank telemetrisi ve reconnect | FAZ 2 | P1-High | S | `ARCH-101.4`, `FE-804` |
| `FE-802` | [#140](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/140) | TanStack Query v5 ile sunucu taraflı sayfalama, filtreleme ve debounce | FAZ 3 | P1-High | S | `FE-804` |
| `FE-803` | [#141](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/141) | Rol bazlı UI bileşen koruması ve rota guard’ları | FAZ 3 | P1-High | S | `AUTH-201.4`, `ARCH-106`, `FE-804` |
| `FE-817` | [#148](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/148) | Boş, hata ve yükleniyor durumları, error boundary ve skeleton | FAZ 3 | P1-High | S | `FE-802` |
| `FE-818` | [#190](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/190) | Responsive ve saha tableti dokunmatik optimizasyonu (WCAG 2.1 AA) | FAZ 4 | P2-Medium | S | `FE-817` |
| `FE-819` | [#87](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/87) | Türkçe dil, sayı/tarih/para birimi formatı ve i18n altyapısı | FAZ 2 | P1-High | XS | `ARCH-100` |

# 🔔 NOTIF — Bildirim & Alarm

| Kod | Issue | Başlık | Faz | Öncelik | Efor | Bağımlı olduğu |
|---|---|---|---|---|---|---|
| `NOTIF-1601` | [#158](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/158) | Bildirim çekirdeği: olay → şablon → kanal yönlendirme | FAZ 3 | P1-High | S | `ARCH-102` |
| `NOTIF-1602` | [#159](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/159) | E-posta kanalı ve teslim takibi | FAZ 3 | P1-High | S | `NOTIF-1601` |
| `NOTIF-1603` | [#160](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/160) | SMS kanalı entegrasyonu | FAZ 3 | P1-High | S | `NOTIF-1601` |
| `NOTIF-1604` | [#161](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/161) | Telegram ve webhook kanalları | FAZ 3 | P2-Medium | XS | `NOTIF-1601` |
| `NOTIF-1605` | [#162](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/162) | Kullanıcı bazlı abonelik ve sessize alma | FAZ 3 | P2-Medium | S | `NOTIF-1601` |
| `NOTIF-1606` | [#163](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/163) | Eskalasyon kuralları (yanıtsız alarm → üst kademe) | FAZ 3 | P2-Medium | S | `NOTIF-1601`, `AI-507` |

# ⚠️ RES — Hata Yönetimi & Dayanıklılık

| Kod | Issue | Başlık | Faz | Öncelik | Efor | Bağımlı olduğu |
|---|---|---|---|---|---|---|
| `RES-901` | [#44](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/44) | Zod ile katı girdi doğrulama ve sanitizasyon | FAZ 1 | P0-Blocker | S | `ARCH-104` |
| `RES-902` | [#45](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/45) | Global exception filter ve Pino yapısal loglama | FAZ 1 | P0-Blocker | S | `RES-901`, `ARCH-101.1` |
| `RES-903` | [#181](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/181) | Km/motor-saat giriş mantık doğrulaması (geri giden km, absürt değer) | FAZ 3 | P1-High | XS | `FLEET-1404` |
| `RES-905` | [#191](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/191) | Graceful degradation (Redis/MQTT/DB kısmi arıza senaryoları) | FAZ 4 | P1-High | S | `RES-906`, `FUEL-410` |
| `RES-906` | [#46](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/46) | Health/readiness uçları ve graceful shutdown | FAZ 1 | P1-High | XS | `RES-902` |
| `RES-907` | [#192](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/192) | İstemci hata izleme (Sentry) ve trace korelasyonu | FAZ 4 | P2-Medium | XS | `RES-902`, `FE-817` |

# 🧪 TEST — Test Otomasyonu

| Kod | Issue | Başlık | Faz | Öncelik | Efor | Bağımlı olduğu |
|---|---|---|---|---|---|---|
| `TEST-1001` | [#193](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/193) | Testcontainers ile uçtan uca ikmal döngüsü testi | FAZ 4 | P1-High | S | `FUEL-401`, `TEST-1006` |
| `TEST-1002` | [#194](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/194) | k6 ile yük ve stres testi (event loop lag, P95) | FAZ 4 | P1-High | S | `TEST-1001` |
| `TEST-1003` | [#195](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/195) | Tenant izolasyon sızıntı testi (RLS negatif senaryolar) | FAZ 4 | P0-Blocker | S | `ARCH-101.3`, `TEST-1001` |
| `TEST-1004` | [#196](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/196) | Playwright e2e: 3 panelin kritik akışları | FAZ 4 | P1-High | S | `FE-800`, `TEST-1006` |
| `TEST-1005` | [#197](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/197) | Firmware HIL (hardware-in-the-loop) ve simülatör testleri | FAZ 4 | P1-High | S | `FW-1300` |
| `TEST-1006` | [#47](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/47) | Birim test altyapısı, coverage eşiği ve CI entegrasyonu | FAZ 1 | P1-High | XS | `ARCH-100` |
| `TEST-1007` | [#198](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/198) | Kesinti/offline kaos testi (batch sync doğrulaması) | FAZ 4 | P2-Medium | S | `TEST-1005`, `RES-905`, `IOT-303` |

# 🚀 OPS — DevOps, Container, CI/CD & İzleme

| Kod | Issue | Başlık | Faz | Öncelik | Efor | Bağımlı olduğu |
|---|---|---|---|---|---|---|
| `OPS-1101` | [#36](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/36) | Multi-stage Dockerfile ve production optimizasyonu | FAZ 1 | P0-Blocker | S | `ARCH-100`, `RES-906` |
| `OPS-1102` | [#37](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/37) | GitHub Actions CI: lint, typecheck, test ve Trivy taraması | FAZ 1 | P0-Blocker | S | `OPS-1101`, `TEST-1006` |
| `OPS-1103` | [#38](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/38) | docker-compose geliştirme ortamı (Postgres/Timescale, Redis, EMQX) | FAZ 1 | P0-Blocker | S | `OPS-1101`, `ARCH-109` |
| `OPS-1104` | [#182](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/182) | Ortam yönetimi (dev/staging/prod) ve dağıtım pipeline’ı | FAZ 4 | P1-High | S | `OPS-1102` |
| `OPS-1105` | [#39](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/39) | Secret yönetimi ve rotasyon prosedürü | FAZ 1 | P0-Blocker | S | `ARCH-110` |
| `OPS-1106` | [#183](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/183) | Yedekleme ve geri yükleme (restore tatbikatı) | FAZ 4 | P0-Blocker | S | `OPS-1104` |
| `OPS-1107` | [#184](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/184) | Prometheus + Grafana metrikleri, dashboard’ları ve log toplama | FAZ 4 | P1-High | S | `OPS-1104` |
| `OPS-1108` | [#185](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/185) | Alerting: uptime, cihaz offline, kuyruk birikmesi | FAZ 4 | P1-High | S | `OPS-1107` |
| `OPS-1110` | [#186](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/186) | Zero-downtime rolling deploy ve rollback prosedürü | FAZ 4 | P1-High | XS | `OPS-1104`, `RES-906` |

# 📚 DOC — Dokümantasyon

| Kod | Issue | Başlık | Faz | Öncelik | Efor | Bağımlı olduğu |
|---|---|---|---|---|---|---|
| `DOC-1201` | [#187](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/187) | Swagger/OpenAPI 3.0 ve DTO dokümantasyonu | FAZ 4 | P1-High | S | `RES-901` |
| `DOC-1202` | [#64](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/64) | Donanım Entegrasyon Şartnamesi v1.0 (paket, HMAC, komut, K-factor) | FAZ 2 | P1-High | S | `AUTH-202.1` |
| `DOC-1203` | [#40](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/40) | docs/PROJE-REHBERI.md — ekip çalışma rehberi | FAZ 1 | P1-High | S | `ARCH-100` |
| `DOC-1204` | [#41](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/41) | docs/SUNUM-REHBERI.md — anlatım ve sunum rehberi | FAZ 1 | P2-Medium | S | `DOC-1203` |
| `DOC-1205` | [#42](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/42) | docs/SOZLUK.md — terim sözlüğü | FAZ 1 | P2-Medium | XS | `ARCH-100` |
| `DOC-1206` | [#188](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/188) | Saha kurulum ve devreye alma prosedürü + checklist | FAZ 4 | P1-High | S | `DOC-1203`, `FUEL-404.2` |
| `DOC-1207` | [#189](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/189) | Operatör el kitabı (şantiye şefi ve pompa operatörü) | FAZ 4 | P2-Medium | S | `FW-1316`, `DOC-1206` |

# 💳 BILL — SaaS Abonelik & Lisans

| Kod | Issue | Başlık | Faz | Öncelik | Efor | Bağımlı olduğu |
|---|---|---|---|---|---|---|
| `BILL-1701` | [#200](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/200) | Firma paketleri ve lisans modeli | FAZ 5 | P2-Medium | S | `ARCH-106` |
| `BILL-1702` | [#201](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/201) | Cihaz/şantiye başına lisans sayacı, limit ve süre bitişi uyarıları | FAZ 5 | P2-Medium | S | `BILL-1701` |
| `BILL-1703` | [#202](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/202) | Modül bazlı feature-flag satış eşlemesi | FAZ 5 | P2-Medium | S | `BILL-1701`, `ARCH-106` |
| `BILL-1704` | [#203](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/203) | Kullanım ölçümü (metering) ve faturalama verisi | FAZ 5 | P3-Low | S | `BILL-1702` |

# 👥 HR — İnsan Kaynakları

| Kod | Issue | Başlık | Faz | Öncelik | Efor | Bağımlı olduğu |
|---|---|---|---|---|---|---|
| `HR-1801` | [#207](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/207) | Personel izin takip modülü | FAZ 5 | P3-Low | S | `FLEET-1403` |

---

## 🔗 Kritik Yol (Critical Path)

Projenin toplam süresini belirleyen, birbirine bağımlı en uzun zincir:

```
 1. ARCH-100       #17  Monorepo iskeleti ve workspace ayrımı
 2. ARCH-109       #26  Drizzle migration ve seed stratejisi
 3. ARCH-101.1     #18  TenantContext (AsyncLocalStorage) middleware ve interceptor
 4. ARCH-101.2     #19  Drizzle transaction wrapper + SET LOCAL app.current_tenant_id
 5. ARCH-101.3     #20  Tüm tenant tablolarına RLS politikası migration’ı
 6. AUTH-201.1     #28  Argon2id parola saklama ve login/logout uçları
 7. AUTH-201.2     #29  Access/Refresh token rotasyonu, Redis store ve token reuse detection
 8. AUTH-201.4     #30  RBAC guard’ları ve 5 rollü yetki matrisi
 9. AUTH-202.1     #31  Raw body interceptor ve HMAC-SHA256 doğrulayıcı
10. AUTH-202.2     #32  Replay koruması: timestamp penceresi ve nonce denetimi
11. AUTH-202.3     #61  Cihaz secret üretimi, saklanması ve rotasyonu
12. IOT-304        #108  Cihaz provisioning ve eşleştirme (device claim) akışı
13. IOT-301.1      #102  EMQX bağlantısı, QoS 1, reconnect ve topic şeması
14. IOT-301.2      #103  LWT ile cihaz OFFLINE tespiti ve Redis presence kaydı
15. IOT-305        #109  device_shadow ve uzaktan komut kuyruğu (ack, timeout, retry)
16. FW-1301        #65  ESP-IDF proje iskeleti, partition table ve build/flash pipeline
17. FW-1304        #68  Akışmetre pals sayımı (ISR + debounce), totalizatör ve K-factor uygulaması
18. FW-1307        #70  MQTT/HTTPS istemcisi ve TLS sertifika yönetimi
19. FW-1308        #71  HMAC-SHA256 paket imzalama, timestamp ve nonce
20. FW-1309        #72  LittleFS offline kuyruk (ring buffer) ve batch sync istemcisi
21. FW-1310        #73  Sınırlı fail-open yetki önbelleği (yerel whitelist ve limitler)
22. FUEL-401.1     #88  request-auth ucu (<200ms) ve yetki kontrol zinciri
23. FUEL-401.2     #89  Redis TTL ile ikmal oturumu ve durum makinesi
24. FUEL-401.3     #90  Heartbeat izleme, 15sn timeout → FORCE_CUTOFF ve maksimum limitler
25. FUEL-401.4     #91  finalize ucu, totalizatör kilidi ve idempotency
26. FUEL-410       #100  Hibrit fail-open politika motoru (sunucu erişilemezliği)
27. IOT-303.1      #106  sync-batch endpoint ve local_sequence_id ile deduplication
28. IOT-303.2      #107  Kronolojik geriye dönük stok düşümü ve atomik işleme
29. ARCH-103.2     #60  Mikro-batch buffer (500ms / 1.000 kayıt) ve pg-copy-streams toplu yazım
30. AI-501.1       #115  Pompa kapalıyken seviye düşüşü tespiti (STATIC_THEFT_DETECTED)
31. COMP-601.1     #126  DespatchAdvice XML builder, alan eşlemesi ve XSD doğrulama
32. COMP-602.1     #127  Entegratör adaptör arayüzü (SOAP/REST), kuyruk ve belge saklama
33. REP-703        #166  Ortak rapor çatısı: filtre, sayfalama, rol görünürlüğü, PDF/CSV export
34. REP-711        #168  Rapor: İkmal Hareket Raporu
35. TEST-1001      #193  Testcontainers ile uçtan uca ikmal döngüsü testi
36. TEST-1003      #195  Tenant izolasyon sızıntı testi (RLS negatif senaryolar)
37. OPS-1104       #182  Ortam yönetimi (dev/staging/prod) ve dağıtım pipeline’ı
38. OPS-1106       #183  Yedekleme ve geri yükleme (restore tatbikatı)
```

**Zincir uzunluğu:** 38 issue. Tek geliştiriciyle yaklaşık 14 hafta; backend / firmware / frontend olarak üç paralel şerit ile 12 haftaya sığar.

**Zincirdeki en riskli üç geçiş:**
1. `AUTH-202.3` → `FW-1308` ([#71](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/71)): sunucu ve firmware’in **kanonik serileştirmede birebir aynı** olması gerekir. `DOC-1202` test vektörleri olmadan bu geçiş sahada patlar.
2. `FUEL-401.4` → `IOT-303.1` ([#106](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/106)): çevrimdışı senkronun mükerrer finansal kayıt üretmemesi, idempotency tasarımının doğruluğuna bağlıdır.
3. `FUEL-403` → `AI-501.1` ([#115](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/115)): hacim hesabı yanlışsa hırsızlık motoru sürekli yanlış alarm üretir ve güvenilirliğini kaybeder.

---

## 🗂️ Eski Issue’ların Yeni Karşılıkları

v2.1 öncesi açılan `Modül 1…11` issue’ları kapatıldı; kapsamları aşağıdaki iş paketlerine taşındı.

| Eski | Yeni iş paketleri |
|---|---|
| #2 Modül 1: Çekirdek Kurulum ve Güvenlik | [#17](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/17) `ARCH-100`, [#13](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/13) `ARCH-101`, [#15](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/15) `AUTH-201`, [#16](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/16) `AUTH-202`, [#44](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/44) `RES-901`, [#45](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/45) `RES-902`, [#36](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/36) `OPS-1101` |
| #3 Modül 2: Context → Zustand | [#50](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/50) `FE-800`, [#80](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/80) `FE-801`, [#140](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/140) `FE-802` |
| #4 Modül 3: Mock → REST API | [#17](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/17) `ARCH-100`, [#23](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/23) `ARCH-104`, [#50](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/50) `FE-800`, [#140](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/140) `FE-802`, [#187](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/187) `DOC-1201` |
| #5 Modül 4: Gerçek Zamanlı Telemetri | [#55](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/55) `IOT-301`, [#56](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/56) `IOT-302`, [#48](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/48) `ARCH-103`, [#80](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/80) `FE-801` |
| #6 Modül 5: Test ve CI/CD | [#47](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/47) `TEST-1006`, [#193](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/193) `TEST-1001`, [#196](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/196) `TEST-1004`, [#37](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/37) `OPS-1102`, [#38](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/38) `OPS-1103` |
| #7 Modül 6: Personel İzin Takibi | [#207](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/207) `HR-1801` |
| #8 Modül 7: Muayene / Bakım / Lastik | [#205](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/205) `FLEET-1408`, [#204](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/204) `FLEET-1407`, [#206](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/206) `FLEET-1409` |
| #9 Modül 8: GİB e-İrsaliye | [#112](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/112) `COMP-601`, [#113](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/113) `COMP-602`, [#129](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/129) `COMP-603`, [#130](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/130) `COMP-604`, [#131](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/131) `COMP-605` |
| #10 Modül 9: Laboratuvar / Numune | [#209](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/209) `INV-1507` |
| #11 Modül 10: Envanter / Yedek Parça | [#208](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/208) `INV-1506` |
| #12 Modül 11: AI Aylık Rapor | [#210](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/210) `REP-724`, [#117](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/117) `AI-502` |

---

## 🏷️ Etiket Sistemi

| Grup | Etiketler |
|---|---|
| Modül | `mod:arch` `mod:auth` `mod:iot` `mod:firmware` `mod:fuel` `mod:ai` `mod:compliance` `mod:reporting` `mod:frontend` `mod:resilience` `mod:test` `mod:devops` `mod:docs` `mod:fleet` `mod:inventory` `mod:notification` `mod:billing` `mod:hr` |
| Katman | `layer:firmware` `layer:backend` `layer:frontend` `layer:database` `layer:infra` |
| Öncelik | `P0-blocker` `P1-high` `P2-medium` `P3-low` |
| Efor | `size:XS` `size:S` `size:M` `size:L` `size:XL` |
| Tip | `type:feature` `type:bug` `type:chore` `type:spike` `type:design` `type:security` |
| Ek | `epic` `blocked` |

---

## ❓ Açık Sorular

Aşağıdaki başlıklar varsayımla ilerletildi; netleştiğinde ilgili issue’lar güncellenmelidir.

| Konu | Varsayım | Etkilediği iş paketi |
|---|---|---|
| Özel entegratör (Logo / Sovos / diğer) | Sağlayıcı adapter pattern ile soyutlandı; somut adaptör seçim sonrası yazılacak | `COMP-602.1` [#127](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/127) |
| Dağıtım hedefi (VPS / Cloud Run / K8s) | Docker Compose’lu tek VPS + ayrı staging | `OPS-1104` [#182](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/182) |
| SMS sağlayıcısı | Adapter pattern; sağlayıcı sonradan bağlanacak | `NOTIF-1603` [#160](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/160) |
| Gözlemlenebilirlik yığını | Prometheus + Grafana + Sentry | `OPS-1107` [#184](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/184) |
| Geçici parolanın teslim kanalı | Panelde tek seferlik gösterim + ilk girişte zorunlu değişiklik | `AUTH-204` [#34](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/34) |
| Offline kuyruk dolduğunda davranış | Yeni ikmal reddedilir (en eski kayıt silinmez) — mali kayıt kaybı kabul edilmez | `FW-1309` [#72](https://github.com/rtosma/YAKITTAKIPSISTEMI/issues/72) |

---

_Son güncelleme: 2026-08-18 · Kaynak: `scripts/roadmap/catalog/` · Issue aralığı: #13–#210_
