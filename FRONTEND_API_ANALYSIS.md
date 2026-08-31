# Frontend - Backend API Entegrasyon ve Buton Analiz Dokümanı

Bu doküman, Yakıt Takip Sistemi frontend uygulamasında sunucuya (Backend API) istek atan ve atması gereken tüm butonlar, formlar, veritabanı CRUD işlemleri ve donanım tetikleyicilerinin detaylı analizini içerir.

---

## 1. 🔑 Oturum & Kimlik Doğrulama (Auth & Session Management)

| Ekran / Sayfa | Buton / Tetikleyici | İşlem / Amaç | Backend Endpoint & Metot | Gönderilecek Veri (Payload) |
| :--- | :--- | :--- | :--- | :--- |
| **Firma Girişi (`LoginPage.tsx`)** | `Yönetici Girişi Yap` | Argon2id & PostgreSQL doğrulama ile token alma | `POST /api/v1/auth/login` | `{ username, password }` |
| **Şantiye Giriş (`SiteLoginPage.tsx`)** | `Saha Operatör Girişi` | Şantiye bazlı yetkiyle oturum açma | `POST /api/v1/auth/login` | `{ username, password }` |
| **Üst Bar / Profil Menüsü** | `Çıkış Yap (Logout)` | Oturumu sonlandırma & Refresh Token iptali | `POST /api/v1/auth/logout` | `{ refreshToken }` |
| **Uygulama Başlatma (`AppProvider`)** | F5 / Sayfa Yenileme | Kullanıcı profilini ve token geçerliliğini doğrulama | `GET /api/v1/auth/me` | *Headers: Bearer Token* |

---

## 2. 🚛 Araç Yönetimi (Vehicles)

| Ekran / Sayfa | Buton / Tetikleyici | İşlem / Amaç | Backend Endpoint & Metot | Gönderilecek Veri (Payload) |
| :--- | :--- | :--- | :--- | :--- |
| **Araç Listesi (`VehiclesPage.tsx`)** | Sayfa Yüklenmesi | Tanımlı araç listesini çekme (RLS Korumalı) | `GET /api/v1/vehicles` | *Headers: Bearer Token* |
| **Araç Ekle Modal** | `Yeni Araç Kaydet` | Filoya yeni araç ve RFID etiket tanımlama | `POST /api/v1/vehicles` | `{ plate, brandModel, vehicleType, rfidTag, siteName }` |
| **Araç Düzenle Modal** | `Değişiklikleri Kaydet` | Araç bilgilerini veya şantiye atamasını güncelleme | `PUT /api/v1/vehicles/:id` | `{ plate, brandModel, vehicleType, rfidTag }` |
| **Araç Satırı / Detay** | `Sil (Çöp Kutusu)` | Araç kaydını sistemden kaldırma | `DELETE /api/v1/vehicles/:id` | — |

---

## 3. 👨‍✈️ Şoför Yönetimi (Drivers)

| Ekran / Sayfa | Buton / Tetikleyici | İşlem / Amaç | Backend Endpoint & Metot | Gönderilecek Veri (Payload) |
| :--- | :--- | :--- | :--- | :--- |
| **Şoför Listesi (`DriversPage.tsx`)** | Sayfa Yüklenmesi | Yetkili şoför listesini getirme | `GET /api/v1/drivers` | — |
| **Şoför Ekle Modal** | `Yeni Şoför Tanımla` | Yeni şoför ve TC / Ehliyet kaydı oluşturma | `POST /api/v1/drivers` | `{ name, tcNo, phone, licenseClass, siteName }` |
| **Şoför Düzenle Modal** | `Güncelle` | Şoför bilgilerini güncelleme | `PUT /api/v1/drivers/:id` | `{ name, phone, licenseClass }` |
| **Şoför Satırı** | `Şoför Sil` | Şoför yetkisini / kaydını silme | `DELETE /api/v1/drivers/:id` | — |

---

## 4. 🛢️ Tank & Depo Yönetimi (Tanks)

| Ekran / Sayfa | Buton / Tetikleyici | İşlem / Amaç | Backend Endpoint & Metot | Gönderilecek Veri (Payload) |
| :--- | :--- | :--- | :--- | :--- |
| **Tank Sayfası (`TankStatusPage.tsx`)** | Sayfa Yüklenmesi & `Verileri Yenile` | Tank canlı seviyelerini ve ultrasonik verileri çekme | `GET /api/v1/tanks` | — |
| **Tank Ekle Modal** | `Yeni Tank Ekle` | Sahaya yeni tank / depo tanımlama | `POST /api/v1/tanks` | `{ name, capacityLiters, currentLevelLiters, fuelType, siteName, sensorId }` |
| **Tank Düzenle / İkmal** | `Seviye Güncelle / Manuel Dolum` | Tanka yakıt ikmali girilmesi veya seviye kalibrasyonu | `PUT /api/v1/tanks/:id` | `{ currentLevelLiters, status }` |
| **Tank Kartı** | `Tankı Sil` | Pasife alınan depoyu silme | `DELETE /api/v1/tanks/:id` | — |

---

## 5. ⛽ Yakıt İkmal & Pompa İşlemleri (Dispense & Transactions)

| Ekran / Sayfa | Buton / Tetikleyici | İşlem / Amaç | Backend Endpoint & Metot | Gönderilecek Veri (Payload) |
| :--- | :--- | :--- | :--- | :--- |
| **İkmal Geçmişi (`TransactionsPage.tsx`)** | Sayfa Yüklenmesi | Tüm ikmal raporlarını ve pompa loglarını getirme | `GET /api/v1/transactions` | — |
| **Saha Paneli (`SiteOperatorPanel.tsx`)** | `Pompayı Başlat & İkmal Et` | Pompa solenoidini açma isteği ve ikmal kaydı | `POST /api/v1/dispense` | `{ vehiclePlate, driverName, tankName, amountLiters, flowRateLpm }` |

---

## 6. 🌐 Çapraz Şantiye Yetkilendirme (Cross-Site Auth)

| Ekran / Sayfa | Buton / Tetikleyici | İşlem / Amaç | Backend Endpoint & Metot | Gönderilecek Veri (Payload) |
| :--- | :--- | :--- | :--- | :--- |
| **Çapraz Şantiye (`CrossSitePage.tsx`)** | Sayfa Yüklenmesi | Farklı şantiyelerden yakıt alma izinlerini listeleme | `GET /api/v1/cross-site-permissions` | — |
| **İzin Ekle Modal** | `Çapraz İzin Tanımla` | Araca başka şantiyeden yakıt alma yetkisi verme | `POST /api/v1/cross-site-permissions` | `{ vehiclePlate, homeSite, targetSite, maxLiters, validUntil }` |
| **İzin Kartı** | `Durum Değiştir (Aktif/İptal)` | Çapraz yakıt alma iznini dondurma / açma | `PATCH /api/v1/cross-site-permissions/:id` | `{ status }` |

---

## 7. ⚙️ Donanım Kalibrasyonu & EEPROM (Settings)

| Ekran / Sayfa | Buton / Tetikleyici | İşlem / Amaç | Backend Endpoint & Metot | Gönderilecek Veri (Payload) |
| :--- | :--- | :--- | :--- | :--- |
| **Kalibrasyon Sihirbazı (`SettingsPage.tsx`)** | `EEPROM'a Yaz ve Onayla` | ESP32 debimetre K-Faktörünü donanıma ve veritabanına yazma | `POST /api/v1/hardware/calibration` | `{ kFactor, calibrationMultiplier }` |

---

## 8. 🛠️ Geliştirici & Müşteri Firma Paneli (Multi-Tenant Admin)

| Ekran / Sayfa | Buton / Tetikleyici | İşlem / Amaç | Backend Endpoint & Metot | Gönderilecek Veri (Payload) |
| :--- | :--- | :--- | :--- | :--- |
| **Firmalar Sayfası (`TenantsPage.tsx`)** | `Yeni Firma Oluştur` | Sisteme yeni müşteri firma (tenant) ekleme | `POST /api/v1/tenants` | `{ name, taxNumber, city }` |
| **Firma Detay Modal** | `Lisans Durumu (Aktif/Askıda)` | Müşteri firma lisansını yönetme | `PATCH /api/v1/tenants/:id/status` | `{ status }` |
| **Modüller & Özellikler** | `Modül Toggle (Aç/Kapat)` | Yapay zeka / e-Fatura vb. modülleri firmaya açıp kapama | `PATCH /api/v1/tenants/:id/modules` | `{ moduleKey, enabled }` |

---

## 📋 Sıralı Uygulama Yol Haritası (Implementation Roadmap)

1. **Adım 1: HTTP API İstemcisi & Axios/Fetch Servisi Yapılandırması** (JWT Token Interceptor ve Hata Yönetimi).
2. **Adım 2: Araçlar (Vehicles) Modülü Bağlantısı** (Listeleme, Ekleme, Düzenleme, Silme).
3. **Adım 3: Şoförler (Drivers) Modülü Bağlantısı**.
4. **Adım 4: Tanklar (Tanks) Modülü Bağlantısı**.
5. **Adım 5: İkmal & Pompa Yetkilendirme (`dispense`) Bağlantısı**.
6. **Adım 6: Çapraz Şantiye & Donanım Kalibrasyon Ayarları Bağlantısı**.
