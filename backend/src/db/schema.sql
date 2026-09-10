-- ==============================================================================
-- [ARCH-101] PostgreSQL Row-Level Security (RLS) & Multi-Tenancy Schema Setup
-- ==============================================================================

-- 1. Companies Table (aynı zamanda tenant kaydı)
CREATE TABLE IF NOT EXISTS companies (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    tax_number VARCHAR(32) NOT NULL,
    code VARCHAR(32),
    city VARCHAR(128),
    license_status VARCHAR(16) DEFAULT 'AKTİF',
    license_expiry DATE,
    modules JSONB NOT NULL DEFAULT '{"aiAnomaly":true,"eInvoice":true,"smartWarehouse":true,"maintenanceTrack":true,"driverScore":true,"crossSiteAuth":true}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Var olan (önceden oluşturulmuş) veritabanları için idempotent kolon ekleri
ALTER TABLE companies ADD COLUMN IF NOT EXISTS code VARCHAR(32);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS city VARCHAR(128);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS license_status VARCHAR(16) DEFAULT 'AKTİF';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS license_expiry DATE;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS modules JSONB NOT NULL DEFAULT '{"aiAnomaly":true,"eInvoice":true,"smartWarehouse":true,"maintenanceTrack":true,"driverScore":true,"crossSiteAuth":true}'::jsonb;

-- 2. Vehicles Table with Tenant ID
CREATE TABLE IF NOT EXISTS vehicles (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    plate VARCHAR(32) NOT NULL,
    brand_model VARCHAR(128) NOT NULL,
    vehicle_type VARCHAR(64) NOT NULL,
    rfid_tag VARCHAR(64) NOT NULL,
    site_name VARCHAR(128) DEFAULT 'Gebze Ana Şantiye',
    status VARCHAR(32) DEFAULT 'AKTİF',
    fuel_capacity_liters NUMERIC(10, 2),
    -- Atanan şoförün adı — araç/şoför formlarından (VehiclesPage & DriversPage)
    -- çift yönlü set edilebilir; tek doğruluk kaynağı burasıdır (bkz.
    -- tenantDb.ts createDriver/updateDriver, şoför tarafından yapılan atamayı
    -- buraya yazar). Basit VARCHAR — mevcut site_name deseniyle tutarlı, FK değil.
    assigned_driver_name VARCHAR(128),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Var olan (önceden oluşturulmuş) veritabanları için idempotent kolon ekleri
-- (createVehicleSchema fuelCapacityLiters'ı zorunlu kılıp doğruluyordu ama
-- hiçbir DB kolonu olmadığı için değer sessizce atılıyordu — bkz. routes.ts)
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS fuel_capacity_liters NUMERIC(10, 2);
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS assigned_driver_name VARCHAR(128);

-- 3. Tanks Table with Tenant ID
CREATE TABLE IF NOT EXISTS tanks (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name VARCHAR(128) NOT NULL,
    capacity_liters NUMERIC(10, 2) NOT NULL,
    current_level_liters NUMERIC(10, 2) NOT NULL,
    fuel_type VARCHAR(64) DEFAULT 'Motorin',
    site_name VARCHAR(128) DEFAULT 'Gebze Ana Şantiye',
    status VARCHAR(32) DEFAULT 'GÜVENLİ',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Drivers Table
CREATE TABLE IF NOT EXISTS drivers (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name VARCHAR(128) NOT NULL,
    tc_no VARCHAR(11) NOT NULL,
    phone VARCHAR(32),
    license_type VARCHAR(64),
    rfid_card_id VARCHAR(64) NOT NULL,
    site_name VARCHAR(128) DEFAULT 'Gebze Ana Şantiye',
    status VARCHAR(32) DEFAULT 'AKTİF',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3b. Fuel Transactions Table (İkmal Kayıtları)
-- Site/vehicle/driver/tank are stored as plain descriptive strings (matching
-- the existing site_name pattern on vehicles/tanks/drivers) rather than FKs,
-- since a dispense record must survive even if the referenced vehicle/driver
-- is later renamed or removed.
CREATE TABLE IF NOT EXISTS transactions (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    site_name VARCHAR(128) NOT NULL,
    vehicle_plate VARCHAR(32) NOT NULL,
    driver_name VARCHAR(128),
    tank_name VARCHAR(128),
    amount_liters NUMERIC(10, 2) NOT NULL,
    flow_rate_lpm NUMERIC(10, 2),
    pump_status VARCHAR(32) DEFAULT 'TAMAMLANTI',
    type VARCHAR(32) DEFAULT 'Manuel',
    rfid_auth BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- FUEL-401.4: cihaz-tetiklemeli (RFID + otomatik dispense state machine)
-- ikmallerin sonlandırma (finalize) adımı için idempotency + bütünlük mührü.
-- Var olan (önceden oluşturulmuş) veritabanları için idempotent kolon ekleri.
-- idempotency_key NULL olabilir (mevcut manuel/santiye-operatörü ikmalleri bu
-- akıştan geçmiyor) ama DOLU olduğunda BENZERSİZ olmalı — cihazın ağ kesintisi
-- sonrası aynı finalize isteğini tekrar göndermesi durumunda ikinci bir kayıt
-- YARATILMAMALI (bkz. tenantDb.ts finalizeDispenseSession).
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(128);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS hash_signature VARCHAR(64);
-- 'DOĞRULANDI': totalizatör farkı ile cihazın kendi bildirdiği miktar arasında
-- %1'i aşan bir sapma yok. 'DOĞRULAMA_BEKLIYOR': sapma %1'i aştı VEYA kayıt
-- bir TIMED_OUT (zorla kesilmiş) oturumun kurtarma akışından geldi — bir
-- operatörün manuel onayı bekleniyor.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS verification_status VARCHAR(32) DEFAULT 'DOĞRULANDI';
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'transactions_idempotency_key_unique'
    ) THEN
        ALTER TABLE transactions ADD CONSTRAINT transactions_idempotency_key_unique UNIQUE (idempotency_key);
    END IF;
END $$;

-- IOT-303.1: çevrimdışı (offline) biriken ikmallerin toplu senkronizasyonu
-- için mükerrer önleme anahtarı. idempotency_key'den (tek bir finalize
-- isteğinin kendi kendini tekrarı) farklı olarak burada cihazın KENDİ yerel
-- sayacı kullanılır — cihaz bağlantısı kesikken ürettiği yüzlerce kaydı
-- (device_id, local_sequence_id) ikilisiyle numaralandırır; sync-batch aynı
-- kaydı tekrar gönderirse (örn. sunucu yanıtı ağ hatasıyla kaybolduysa)
-- bu kısıt ikinci bir mali kayıt oluşmasını veritabanı seviyesinde engeller.
-- device_id NULL olan (manuel/santiye-operatörü) ikmaller bu kısıttan
-- muaftır — Postgres'te NULL'lar birbirine asla eşit sayılmaz.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS device_id VARCHAR(64);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS local_sequence_id BIGINT;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'transactions_device_local_seq_unique'
    ) THEN
        ALTER TABLE transactions ADD CONSTRAINT transactions_device_local_seq_unique UNIQUE (device_id, local_sequence_id);
    END IF;
END $$;

-- 3c. Cross-Site Fuel Permissions (Çapraz Şantiye İkmal Yetkileri — FUEL-402)
-- Bir aracın KENDİ şantiyesi dışında (target_site) yakıt alabilmesi için
-- tanımlanan geçici kota. createTransaction bu tabloyu kontrol eder: araç
-- home_site'i dışında bir site'de ikmal alıyorsa, AKTİF + süresi dolmamış +
-- kalan kotası yeterli bir izin yoksa ikmal reddedilir (QUOTA_EXHAUSTED /
-- NO_CROSS_SITE_PERMISSION); varsa used_liters aynı DB transaction'ında
-- atomik olarak artırılır (bkz. tenantDb.ts createTransaction).
CREATE TABLE IF NOT EXISTS cross_site_permissions (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    vehicle_plate VARCHAR(32) NOT NULL,
    driver_name VARCHAR(128),
    home_site VARCHAR(128) NOT NULL,
    target_site VARCHAR(128) NOT NULL,
    allowed_liters NUMERIC(10, 2) NOT NULL,
    used_liters NUMERIC(10, 2) NOT NULL DEFAULT 0,
    expiry_date DATE NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'AKTİF',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ==============================================================================
-- [AUTH-202.3] Cihaz Secret Üretimi, Saklanması ve Rotasyonu
-- ==============================================================================
-- Önceden (AUTH-202.1/OPS-1105) cihaz sırları hardwareAuthMiddleware.ts'te
-- REGISTERED_HARDWARE_DEVICES adlı statik bir sabit nesnedeydi — her cihaz
-- .env'den okunan SABİT bir sır kullanıyordu, provisioning/rotasyon/bloke
-- etme yoktu. Bu tablo o statik nesnenin yerini alır.
--
-- device_id (ESP32-PUMP-01 gibi insan-okunur kimlik) TENANT'A GÖRE DEĞİL
-- GLOBAL olarak UNIQUE olmalı: hardwareAuthMiddleware bir isteği doğrularken
-- HENÜZ hangi tenant'a ait olduğunu bilmiyor (login öncesi kullanıcı arama
-- ile aynı "pre-tenant-context" durumu, bkz. adminDb.ts
-- getHardwareDeviceByDeviceId) — device_id'den tenant_id'yi BULMAK için
-- kullanılan sorgu budur.
--
-- Secret DÜZ METİN olarak saklanmaz (AC) ama tek yönlü hash de OLAMAZ —
-- HMAC doğrulaması için sunucunun sırrı GERİ ÇÖZEBİLMESİ gerekir. Bu yüzden
-- password_hash gibi Argon2id değil, HW_SECRET_ENCRYPTION_KEY pepper'ıyla
-- AES-256-GCM simetrik şifreleme kullanılır (bkz. utils/hardwareSecretCrypto.ts).
CREATE TABLE IF NOT EXISTS hardware_devices (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    device_id VARCHAR(64) NOT NULL UNIQUE,
    name VARCHAR(128) NOT NULL,
    site_name VARCHAR(128) NOT NULL,
    encrypted_secret TEXT NOT NULL,
    -- Rotasyon sırasında "eski ve yeni secret bir süre birlikte kabul
    -- edilmeli" (ticket notu) — aksi halde komutu henüz almamış bir cihaz
    -- sahada kilitlenir. previous_secret_expires_at dolana kadar HER İKİSİ
    -- de hardwareAuthMiddleware tarafından denenir.
    encrypted_secret_previous TEXT,
    previous_secret_expires_at TIMESTAMP WITH TIME ZONE,
    secret_rotated_at TIMESTAMP WITH TIME ZONE,
    -- 'AKTİF' | 'BLOKE' — bloke edilen cihazın paketleri anında (403) reddedilir.
    status VARCHAR(32) NOT NULL DEFAULT 'AKTİF',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- IOT-304: cihaz envanteri alanları — yalnızca claim akışından (aşağıda)
-- geçen cihazlarda dolar; SUPER_ADMIN/COMPANY_OWNER'ın elle provisioning
-- yaptığı (AUTH-202.3) cihazlarda NULL kalabilir.
ALTER TABLE hardware_devices ADD COLUMN IF NOT EXISTS serial_number VARCHAR(128);
ALTER TABLE hardware_devices ADD COLUMN IF NOT EXISTS mac_address VARCHAR(32);
ALTER TABLE hardware_devices ADD COLUMN IF NOT EXISTS model VARCHAR(128);
ALTER TABLE hardware_devices ADD COLUMN IF NOT EXISTS hardware_revision VARCHAR(64);
-- FUEL-404: akışmetrenin GÜNCEL, cihazın ACK'lediği (bkz. calibration_commands)
-- pals/litre katsayısı. NULL = hiç kalibre edilmemiş, cihaz kendi firmware
-- varsayılanını kullanıyor (backend'in bilgisi/kontrolü dışında bir sabit).
ALTER TABLE hardware_devices ADD COLUMN IF NOT EXISTS k_factor NUMERIC(10, 4);
-- FUEL-410: cihazın EN SON çektiği (GET /telemetry/fail-open-policy) fail-open
-- politikasının id'si. Panelin "dağıtım bekliyor" durumunu göstermesi için —
-- bu değer, o şantiye/tenant için GEÇERLİ olan politikanın id'sinden
-- FARKLIYSA cihaz henüz güncel politikayı çekmemiş demektir (bkz.
-- tenantDb.ts getFailOpenPolicyDeploymentStatus).
ALTER TABLE hardware_devices ADD COLUMN IF NOT EXISTS last_fail_open_policy_id VARCHAR(64);

-- ==============================================================================
-- [IOT-304] Cihaz Provisioning ve Eşleştirme (Device Claim) Akışı
-- ==============================================================================
-- Sahaya götürülen bir ESP32'nin, henüz HİÇBİR secret'ı yokken (AUTH-202.3'ün
-- provisioning'i aksine, JWT ile kimliği doğrulanmış bir yöneticinin DEĞİL,
-- doğrudan cihazın/teknisyenin tetiklediği bir akış) doğru tenant + şantiyeye
-- bağlanmasını sağlayan tek kullanımlık kod. code GLOBAL olarak UNIQUE olmalı
-- — redeem işlemi (adminDb.ts redeemDeviceClaimCode) tenant context'i henüz
-- YOKKEN, kodun kendisinden tenant'ı bulur (login/hardware_devices ile aynı
-- pre-tenant-context deseni).
CREATE TABLE IF NOT EXISTS device_claim_codes (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    code VARCHAR(32) NOT NULL UNIQUE,
    site_name VARCHAR(128) NOT NULL,
    device_name VARCHAR(128) NOT NULL,
    -- 'BEKLIYOR' | 'KULLANILDI' — süresi dolmuş ama hâlâ 'BEKLIYOR' görünen
    -- bir kod redeemDeviceClaimCode'un expires_at kontrolüyle YİNE DE
    -- reddedilir; ayrı bir 'SÜRESİ_DOLDU' durumuna geçiren bir arka plan
    -- job'ı YOK (gereksiz) — durum yalnızca gösterim amaçlı `expires_at <
    -- now()` ile türetilir (bkz. tenantDb.ts getTenantClaimCodes).
    status VARCHAR(32) NOT NULL DEFAULT 'BEKLIYOR',
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    redeemed_device_id VARCHAR(64),
    redeemed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ==============================================================================
-- [FUEL-404.1] K-Factor Uzaktan Kalibrasyon — Komut, Ack, Geri Alma, Geçmiş
-- ==============================================================================
-- K-factor doğrudan faturalanan litreyi belirler — yetkisiz/hatalı bir
-- değişiklik gizli bir hırsızlık aracı ya da ölçüm hatası kaynağı olur
-- (ticket'ın kendi notu). Bu yüzden append-only bir geçmiş (audit_logs'la
-- AYNI "asla silinmez" ilkesi) + cihaz onayı (ack) olmadan "uygulanmış"
-- SAYILMAMA zorunluluğu var: hardware_devices.k_factor yalnızca bir ACK
-- geldiğinde güncellenir (bkz. tenantDb.ts recordCalibrationAck) — bu
-- tablodaki bir satır tek başına "yeni katsayı artık aktif" anlamına gelmez.
CREATE TABLE IF NOT EXISTS calibration_commands (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    device_id VARCHAR(64) NOT NULL,
    previous_k_factor NUMERIC(10, 4),
    new_k_factor NUMERIC(10, 4) NOT NULL,
    reason TEXT NOT NULL,
    -- FUEL-404.2'nin referans kap ölçümü (hazır olduğunda) buraya serbest
    -- JSON olarak yazılır — şimdilik yalnızca FUEL-404.1'in elle-girilen
    -- gerekçe akışı bunu opsiyonel bırakıyor.
    reference_measurement JSONB,
    requested_by VARCHAR(64) NOT NULL,
    -- AC: "±%20'den büyük değişiklikler ikinci onay istemelidir."
    requires_second_approval BOOLEAN NOT NULL DEFAULT FALSE,
    approved_by VARCHAR(64),
    approved_at TIMESTAMP WITH TIME ZONE,
    -- 'IKINCI_ONAY_BEKLIYOR' | 'BEKLIYOR' (cihaza gönderildi, ack bekleniyor)
    -- | 'ONAYLANDI' (ack alındı, k_factor GERÇEKTEN uygulandı) |
    -- 'REDDEDILDI' (cihaz NACK döndü) | 'ZAMAN_ASIMI' (ack hiç gelmedi).
    status VARCHAR(32) NOT NULL DEFAULT 'BEKLIYOR',
    sent_at TIMESTAMP WITH TIME ZONE,
    acked_at TIMESTAMP WITH TIME ZONE,
    -- Geri alma da YENİ bir komut olarak kaydedilir (geçmiş satırları asla
    -- silinmez/değiştirilmez) — bu bayrak yalnızca raporlamada ayırt etmek için.
    is_rollback BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ==============================================================================
-- [FUEL-404.2] Kalibrasyon Test Alımı — Referans Kap ile Sapma Hesabı
-- ==============================================================================
-- Teknisyen sahada bilinen hacimde (örn. 20L) bir referans kaba yakıt alır;
-- cihazın KENDİ (o anki k_factor'e göre hesapladığı) ölçümü ile referans
-- kabın GERÇEK hacmi arasındaki fark, K-factor hatasını ortaya çıkarır. Bu
-- kayıt BİLEREK transactions tablosundan AYRI — AC: "test alımı normal
-- ikmal olarak faturalandırılmamalı" (raporlarda otomatik ayrışır, çünkü
-- transactions'ı sorgulayan hiçbir rapor bu tabloya hiç bakmaz) ama AC:
-- "stoktan düşmeli" gereği tankın current_level_liters'ı YİNE DE düşürülür
-- (bkz. tenantDb.ts recordCalibrationTestIntake).
CREATE TABLE IF NOT EXISTS calibration_test_intakes (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    device_id VARCHAR(64) NOT NULL,
    tank_name VARCHAR(128) NOT NULL,
    reference_volume_liters NUMERIC(10, 3) NOT NULL,
    measured_liters NUMERIC(10, 3) NOT NULL,
    ambient_temperature_celsius NUMERIC(5, 2),
    -- Test anında cihazın AKTİF olan k_factor'ü (hardware_devices'tan
    -- kopyalanır) — sonradan k_factor değişse bile bu ölçümün HANGİ
    -- katsayıyla alındığı asla belirsizleşmez.
    k_factor_at_test NUMERIC(10, 4) NOT NULL,
    deviation_ratio NUMERIC(6, 4) NOT NULL,
    proposed_k_factor NUMERIC(10, 4) NOT NULL,
    -- AC: "Doğrulama alımı sonucu kalibrasyon geçmişine yazılmalıdır" — bu
    -- alan doluysa bu ölçüm, belirtilen kalibrasyon komutunun GERÇEKTEN
    -- sapmayı düzelttiğini doğrulamak için yapılmış bir doğrulama alımıdır.
    verifies_calibration_command_id VARCHAR(64),
    requested_by VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ==============================================================================
-- [FUEL-410] Hibrit Fail-Open Politika Motoru (Sunucu Erişilemezliği)
-- ==============================================================================
-- "Sunucuya ulaşılamadığında şantiye durmasın, ama yetkisiz alım da mümkün
-- olmasın" kararının merkezden tanımlanan politikası. calibration_commands
-- ile AYNI "her değişiklik YENİ bir satır" (versiyonlanan, asla UPDATE
-- edilmeyen) deseni — bir şantiye/tenant için en son (created_at DESC) satır
-- o an GEÇERLİ politikadır (bkz. tenantDb.ts getEffectiveFailOpenPolicy).
-- site_name NULL ise bu, o tenant'ın TÜM şantiyeleri için VARSAYILANDIR —
-- site_name dolu bir satır varsa o şantiye için ÖNCELİKLİDİR.
CREATE TABLE IF NOT EXISTS fail_open_policies (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    site_name VARCHAR(128),
    offline_dispense_allowed BOOLEAN NOT NULL DEFAULT TRUE,
    max_liters_per_vehicle NUMERIC(10, 2) NOT NULL DEFAULT 200,
    max_daily_dispenses_per_vehicle INTEGER NOT NULL DEFAULT 1,
    whitelist_freshness_hours INTEGER NOT NULL DEFAULT 24,
    -- true ise offline_dispense_allowed'ı GEÇERSİZ KILAR — ticket notu:
    -- "Yüksek riskli tenant'lar için tam fail-close seçeneği de
    -- desteklenmelidir." Cihaz bunu görünce sunucuya ulaşamadığında HİÇ
    -- ikmal yapmaz (uygulanması firmware tarafı, backend'in işi bu kararı
    -- doğru iletmek).
    fail_close BOOLEAN NOT NULL DEFAULT FALSE,
    updated_by VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- AI-502: Google Gemini ile şoför/araç tüketim anomali analizi — her üretim
-- YENİ bir satır (calibration_commands/fail_open_policies ile AYNI
-- versiyonlu geçmiş deseni; bir önceki raporun ÜZERİNE yazılmaz, dashboard
-- geçmiş raporları da listeleyebilir). `anomalies` Gemini'nin JSON çıktısı
-- backend/src/schemas/consumptionAnomalySchema.ts'teki Zod şemasıyla
-- doğrulandıktan SONRA buraya yazılır — asla ham/doğrulanmamış model çıktısı
-- değildir.
CREATE TABLE IF NOT EXISTS consumption_anomaly_reports (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    period_days INTEGER NOT NULL,
    period_start TIMESTAMP WITH TIME ZONE NOT NULL,
    period_end TIMESTAMP WITH TIME ZONE NOT NULL,
    vehicle_count INTEGER NOT NULL,
    anomaly_count INTEGER NOT NULL,
    anomalies JSONB NOT NULL,
    model_name VARCHAR(64) NOT NULL,
    generated_by VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- COMP-601.1: üretilen her e-İrsaliye için KALICI belge kimliği. Bir ikmalin
-- e-İrsaliyesi tekrar istendiğinde AYNI belge numarası ve AYNI ETTN (UUID)
-- dönmeli (idempotent) — bu yüzden mapping burada saklanıyor, her istekte
-- yeniden üretilmiyor. audit_logs gibi salt-ekleyici: app_user'dan UPDATE/
-- DELETE/TRUNCATE geri alınıyor (aşağıda) — bir belge numarası bir kez
-- verildiyse asla değişmez/silinmez (GİB denetim gereği).
CREATE TABLE IF NOT EXISTS despatch_advice_documents (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    transaction_id VARCHAR(64) NOT NULL,
    document_number VARCHAR(32) NOT NULL,
    ettn UUID NOT NULL,
    issue_year INTEGER NOT NULL,
    sequence_no INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_despatch_advice_documents_tx UNIQUE (tenant_id, transaction_id),
    CONSTRAINT uq_despatch_advice_documents_number UNIQUE (tenant_id, document_number)
);

-- COMP-601.1 AC: "Belge numaralandırması boşluksuz sıralı olmalıdır (denetim
-- gereği)". Postgres SEQUENCE bunu SAĞLAYAMAZ — rollback'te tüketilen numara
-- geri gelmez, boşluk oluşur. Bunun yerine tenant+yıl başına bir sayaç
-- satırı: numara, belge satırını ekleyen AYNI transaction içinde
-- `UPDATE ... last_sequence + 1` ile alınır; transaction rollback olursa
-- artış da geri alınır → gerçekten boşluksuz. Eşzamanlılık: allocation
-- kodu (tenantDb.ts) tenant başına bir advisory-lock alır, aynı anda gelen
-- iki istek sayacı iki kez artıramaz.
CREATE TABLE IF NOT EXISTS despatch_advice_counters (
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    issue_year INTEGER NOT NULL,
    last_sequence INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, issue_year)
);

-- FUEL-403.1: tank daldırma cetveli (strapping table) VEYA silindirik tank
-- formül konfigürasyonu. Versiyonlu/append-only — bir cetvel bir kez
-- yazıldıktan sonra DEĞİŞTİRİLMEZ/SİLİNMEZ (app_user'dan UPDATE/DELETE/
-- TRUNCATE geri alınır, aşağıda); düzeltme = yeni bir versiyon satırı.
-- "En son satır GEÇERLİ" (bkz. tenantDb.ts getEffectiveTankVolumeModel).
-- Geçmiş transactions kayıtları bu tablodan ETKİLENMEZ — yalnızca YENİ
-- hacim sorguları bu cetveli kullanır (AC: cetvel değişikliği geçmişi
-- yeniden hesaplamaz).
CREATE TABLE IF NOT EXISTS tank_strapping_tables (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    tank_name VARCHAR(128) NOT NULL,
    -- 'CSV_IMPORT' → points dolu; 'CYLINDER_FORMULA' → cylinder_config dolu.
    source VARCHAR(32) NOT NULL,
    -- [{ "levelMm": <int>, "volumeLiters": <numeric> }, ...] — levelMm'e göre
    -- KESİN ARTAN, volumeLiters AZALMAYAN (monotonluk setTankStrappingTable'da
    -- doğrulanır, bozuk cetvel sessizce kabul edilmez).
    points JSONB,
    -- { "diameterMm": <int>, "lengthMm": <int>, "orientation": "HORIZONTAL"|"VERTICAL" }
    cylinder_config JSONB,
    point_count INTEGER NOT NULL DEFAULT 0,
    notes VARCHAR(256),
    imported_by VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- AUTH-210: kayıp/çalıntı/değiştirilmiş RFID kartları için KARA LİSTE
-- (denylist). Bir (tenant, card_uid) için EN FAZLA bir satır; satırın
-- YOKLUĞU kartın aktif olduğu anlamına gelir. "Kart bulundu / yeniden
-- etkinleştirildi" = satırın SİLİNMESİ (her durum değişikliği ayrıca
-- audit_logs'a yazılır). İkmal yetkilendirmesi (authorizeDispenseRequest)
-- bu listeyi WHITELIST'TEN ÖNCE değerlendirir — kayıtlı ve sürücüsü aktif
-- bir kart bile kara listedeyse ikmal alamaz.
CREATE TABLE IF NOT EXISTS rfid_card_blacklist (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    card_uid VARCHAR(64) NOT NULL,
    -- 'LOST' | 'BLOCKED' | 'REPLACED'
    status VARCHAR(16) NOT NULL,
    reason VARCHAR(256),
    -- REPLACED durumunda kaydın devredildiği yeni kartın uid'i.
    replaced_by_card_uid VARCHAR(64),
    reported_by VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_rfid_card_blacklist_tenant_uid UNIQUE (tenant_id, card_uid)
);

-- AUTH-210: IOT-305 komut kuyruğu bu kod tabanında YOK — denylist cihazlara
-- PUSH değil PULL ile dağıtılır (bkz. GET /telemetry/rfid-denylist,
-- FUEL-410 fail-open politikasıyla aynı desen). Cihazın en son çektiği
-- denylist sürümü/zamanı burada tutulur; deployment-status bunu güncel
-- sürümle karşılaştırıp "blok komutunu alamayan" cihazları uyarı olarak
-- işaretler (AC 3).
ALTER TABLE hardware_devices ADD COLUMN IF NOT EXISTS last_rfid_denylist_version VARCHAR(64);
ALTER TABLE hardware_devices ADD COLUMN IF NOT EXISTS last_rfid_denylist_pull_at TIMESTAMP WITH TIME ZONE;

-- FUEL-402.1: araç/şantiye/dönem bazlı yakıt kotası. Mevcut
-- cross_site_permissions (FUEL-402) yalnızca çapraz-şantiye + tek pencere;
-- bu tablo GÜNLÜK/HAFTALIK/AYLIK/TEK_SEFERLİK dönemleri, dönem sonu otomatik
-- sıfırlamayı ve devir (carryover) politikasını ekler. Kapsam alanları NULL
-- ise "hepsi" (tenant geneli). Tüketim balance sorgusunda transactions'tan
-- CANLI hesaplanır; consumed kolonu yok — dönem kapanışında snapshot
-- fuel_quota_history'ye yazılır (uzlaşma/settlement için saklanır).
CREATE TABLE IF NOT EXISTS fuel_quotas (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    vehicle_plate VARCHAR(32),
    site_name VARCHAR(128),
    -- 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'ONE_TIME'
    period_type VARCHAR(16) NOT NULL,
    limit_liters NUMERIC(12, 2) NOT NULL,
    -- 'NONE' (devir yok) | 'FULL' (kalan devreder) | 'CAPPED' (kalan ama en fazla limit kadar)
    carryover_policy VARCHAR(16) NOT NULL DEFAULT 'NONE',
    -- Şu anki dönem penceresi (reset sweep bunları ileri kaydırır).
    period_start TIMESTAMP WITH TIME ZONE NOT NULL,
    period_end TIMESTAMP WITH TIME ZONE NOT NULL,
    -- Bir önceki dönemden devreden litre (efektif limit = limit_liters + bu).
    carried_over_liters NUMERIC(12, 2) NOT NULL DEFAULT 0,
    valid_from DATE NOT NULL DEFAULT CURRENT_DATE,
    valid_until DATE,
    status VARCHAR(16) NOT NULL DEFAULT 'AKTİF',  -- 'AKTİF' | 'PASİF'
    created_by VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- FUEL-402.1: kapanan her kota döneminin anlık görüntüsü — uzlaşma
-- raporları için saklanır (Kritik Not: "geçmiş kota verisi settlement için
-- tutulmalı"). Append-only: app_user'dan UPDATE/DELETE/TRUNCATE geri alınır.
CREATE TABLE IF NOT EXISTS fuel_quota_history (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    quota_id VARCHAR(64) NOT NULL,
    period_start TIMESTAMP WITH TIME ZONE NOT NULL,
    period_end TIMESTAMP WITH TIME ZONE NOT NULL,
    effective_limit_liters NUMERIC(12, 2) NOT NULL,
    consumed_liters NUMERIC(12, 2) NOT NULL,
    carried_over_to_next_liters NUMERIC(12, 2) NOT NULL,
    closed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- FUEL-408: tanka gelen tankerin dolum (alım irsaliyesi) kaydı. Stok
-- hesabının GİRİŞ tarafı — ikmaller çıkış tarafını düşer, bu tablo dolumları
-- ekler; ikisi birlikte FUEL-409 teorik/fiziksel mutabakatını besler.
-- Kritik Not: "tanker beyanı ile fiziksel ölçüm arasındaki fark en sık
-- rastlanan kayıp kalemidir" — bu yüzden hem declared (beyan) hem measured
-- (seviye farkı) tutulur ve 15 °C'ye düzeltilmiş hacimler üzerinden
-- karşılaştırılır (declared_liters_15c vs measured_liters_15c). Append-only.
CREATE TABLE IF NOT EXISTS fuel_intake_receipts (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    tank_id VARCHAR(64) NOT NULL,
    tank_name VARCHAR(128) NOT NULL,
    site_name VARCHAR(128) NOT NULL,
    supplier_name VARCHAR(160) NOT NULL,
    waybill_no VARCHAR(64) NOT NULL,
    delivery_date DATE NOT NULL,
    tanker_plate VARCHAR(32),
    -- Tankerin irsaliyede beyan ettiği miktar (gözlenen litre).
    declared_liters NUMERIC(12, 2) NOT NULL,
    unit_price NUMERIC(12, 4),
    temperature_c NUMERIC(6, 2),
    density_kg_m3 NUMERIC(8, 2),
    -- Dolum öncesi/sonrası tank seviyesi (sensör veya manuel). after NULL ise
    -- ölçüm yapılamamış → measured_* alanları da NULL, stok beyanla artırılır.
    level_before_liters NUMERIC(12, 2),
    level_after_liters NUMERIC(12, 2),
    measured_liters NUMERIC(12, 2),
    -- 15 °C standart hacme düzeltilmiş karşılıklar (ASTM D1250, FUEL-403 motoru).
    declared_liters_15c NUMERIC(12, 2) NOT NULL,
    measured_liters_15c NUMERIC(12, 2),
    -- measured_15c - declared_15c (negatif = eksik teslimat). pct = / declared_15c.
    discrepancy_liters NUMERIC(12, 2),
    discrepancy_pct NUMERIC(8, 4),
    -- Stoğa GERÇEKTEN eklenen miktar (measured varsa o, yoksa declared).
    added_liters NUMERIC(12, 2) NOT NULL,
    -- 'KAYITLI' | 'EKSİK_TESLİMAT_UYARISI'
    status VARCHAR(32) NOT NULL DEFAULT 'KAYITLI',
    -- Dolum penceresi — FUEL-409 mutabakatı bu aralıktaki pompa akışını
    -- hesaba katmamalı (Kritik Not: "dolum sırasında pompa kullanımı hesabı bozar").
    window_start TIMESTAMP WITH TIME ZONE,
    window_end TIMESTAMP WITH TIME ZONE,
    -- Nesne depolama bu yığında yok — irsaliye görseli yalnızca URL referansı.
    waybill_image_url VARCHAR(512),
    note TEXT,
    created_by VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- FUEL-409: teorik (kayıtlara göre) vs fiziksel (sensör) stok mutabakatı.
--   teorik  = açılış bakiyesi + dolumlar (FUEL-408) − ikmaller (transactions)
--             − kalibrasyon test alımları (calibration_test_intakes)
--   fiziksel = tankın o anki current_level_liters'ı (gerçek kurulumda sensör
--              anlık görüntüsü); ayrıca 15 °C'ye düzeltilmiş hali raporlanır.
-- Fark toleransı (öneri ±%1) aşılırsa MUTABAKAT_ALARMI. Fark, dönem uzunluğuna
-- ölçeklenen doğal buharlaşma payıyla (motorin ~aylık binde 1-2) kıyaslanıp
-- sınıflandırılır: TOLERANS_İÇİ / BUHARLAŞMA / ÖLÇÜM_HATASI / AÇIKLANAMAYAN.
-- Append-only düzeltme kaydı — geçmiş ikmaller ASLA değiştirilmez.
CREATE TABLE IF NOT EXISTS stock_reconciliations (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    tank_id VARCHAR(64) NOT NULL,
    tank_name VARCHAR(128) NOT NULL,
    site_name VARCHAR(128) NOT NULL,
    -- 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'AD_HOC'
    period_type VARCHAR(16) NOT NULL,
    period_start TIMESTAMP WITH TIME ZONE NOT NULL,
    period_end TIMESTAMP WITH TIME ZONE NOT NULL,
    opening_book_liters NUMERIC(12, 2) NOT NULL,
    intake_liters NUMERIC(12, 2) NOT NULL,
    dispensed_liters NUMERIC(12, 2) NOT NULL,
    test_intake_liters NUMERIC(12, 2) NOT NULL,
    -- Teorik kapanış = opening + intake − dispensed − test_intake.
    closing_book_liters NUMERIC(12, 2) NOT NULL,
    -- Fiziksel (gözlenen sensör hacmi) + 15 °C düzeltilmiş karşılığı (REP-714).
    physical_liters NUMERIC(12, 2) NOT NULL,
    physical_temp_c NUMERIC(6, 2),
    physical_liters_15c NUMERIC(12, 2) NOT NULL,
    -- physical − closing_book (negatif = kayıp/fire). pct = / closing_book.
    variance_liters NUMERIC(12, 2) NOT NULL,
    variance_pct NUMERIC(8, 4) NOT NULL,
    tolerance_pct NUMERIC(6, 3) NOT NULL,
    evaporation_allowance_pct NUMERIC(8, 4) NOT NULL,
    -- 'TOLERANS_İÇİ' | 'BUHARLAŞMA' | 'ÖLÇÜM_HATASI' | 'AÇIKLANAMAYAN'
    classification VARCHAR(24) NOT NULL,
    -- 'NORMAL' | 'MUTABAKAT_ALARMI'
    status VARCHAR(24) NOT NULL,
    -- 'MANUEL' | 'OTOMATIK' (index.ts günlük süpürücüsü)
    source VARCHAR(16) NOT NULL DEFAULT 'MANUEL',
    note TEXT,
    created_by VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ==============================================================================
-- [AUTH-201] Users Table & Refresh Tokens Rotation Store
-- ==============================================================================

-- 4. Users Table
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    username VARCHAR(64) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(32) NOT NULL DEFAULT 'SITE_MANAGER',
    site_name VARCHAR(128),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- AUTH-204: şantiye oluşturulurken otomatik üretilen geçici parolanın
-- zorunlu değiştirilmesi akışı için.
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS temp_password_expires_at TIMESTAMP WITH TIME ZONE;

-- 5. Refresh Tokens — KASITLI OLARAK YOK.
-- Refresh token rotasyonu + reuse-detection tamamen Redis'te tutuluyor
-- (bkz. backend/src/services/tokenService.ts): `refresh_token:{jti}` ve
-- `refresh_tokens_by_user:{userId}` anahtarları, 7 günlük TTL ile kendi
-- kendini temizler. Daha önce burada duran `refresh_tokens` tablosu hiçbir
-- kod tarafından yazılmıyor/okunmuyordu; yanıltıcı olduğu için kaldırıldı.
-- Uzun vadeli oturum denetimi (audit) gerekirse ayrı bir `login_audit`
-- tablosu eklenmeli — token durumunu aynalayan bir tablo değil.
DROP TABLE IF EXISTS refresh_tokens;

-- ==============================================================================
-- 6. Enable Row Level Security (RLS) Policies
-- ==============================================================================

-- Enable RLS on vehicles, tanks, users
ALTER TABLE vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE tanks ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cross_site_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hardware_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_claim_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE calibration_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE calibration_test_intakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE fail_open_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumption_anomaly_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE despatch_advice_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE despatch_advice_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE tank_strapping_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfid_card_blacklist ENABLE ROW LEVEL SECURITY;
ALTER TABLE fuel_quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE fuel_quota_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE fuel_intake_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_reconciliations ENABLE ROW LEVEL SECURITY;

-- Create app_user role for RLS enforcement (since superusers bypass RLS)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user WITH NOLOGIN;
  END IF;
END
$$;
-- 5. Sites Table with Tenant ID
CREATE TABLE IF NOT EXISTS sites (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name VARCHAR(128) NOT NULL,
    location VARCHAR(255) DEFAULT 'Türkiye',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_tenant_site_name UNIQUE(tenant_id, name)
);

-- Enable RLS on sites (FORCE alone is a no-op without ENABLE — bu satır olmadan
-- sites_tenant_isolation_policy hiç uygulanmaz ve her tenant tüm şantiyeleri görür)
ALTER TABLE sites ENABLE ROW LEVEL SECURITY;

-- AUTH-203: append-only denetim izi. before_value/after_value'da parola,
-- secret ve token ALANLARI asla ham saklanmaz — writeAuditLog() (bkz.
-- utils/auditLog.ts) bunları yazmadan önce maskeler.
CREATE TABLE IF NOT EXISTS audit_logs (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id VARCHAR(64),
    trace_id VARCHAR(64),
    ip_address VARCHAR(64),
    action VARCHAR(64) NOT NULL,
    target_type VARCHAR(64),
    target_id VARCHAR(64),
    before_value JSONB,
    after_value JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO app_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO app_user;

-- AUTH-203 AC: "audit_logs üzerinde UPDATE/DELETE veritabanı düzeyinde
-- reddedilmelidir." Yukarıdaki GRANT ALL bunu da kapsadığı için burada,
-- SONRASINDA açıkça geri alınıyor — app_user yalnızca INSERT + SELECT
-- yapabilir, tablo gerçekten append-only olur (uygulama kodundaki bir hata
-- ya da ele geçirilmiş bir bağlantı bile kaydı değiştiremez/silemez).
-- TRUNCATE de dahil: DELETE'in tek tek satır silmesinden farklı bir
-- komuttur ama sonucu aynıdır (tüm denetim izinin yok olması), o yüzden o
-- da geri alınıyor.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM app_user;

-- FUEL-404.1 AC: "Kalibrasyon geçmişi silinemez olmalıdır." audit_logs'tan
-- FARKLI OLARAK burada UPDATE geri alınMIYOR — bir komutun status'u
-- (BEKLIYOR→ONAYLANDI/REDDEDILDI/ZAMAN_ASIMI) MEŞRU bir yaşam döngüsü
-- geçişidir (bkz. tenantDb.ts recordCalibrationAck/Nack). Yasaklanan yalnızca
-- bir satırın YOK EDİLMESİ — bir kaydı SİLMEK ile onun status'unu ack ile
-- GÜNCELLEMEK arasındaki fark, tam olarak "geçmiş asla kaybolmaz" ile
-- "durum meşru şekilde ilerler" arasındaki farktır.
REVOKE DELETE, TRUNCATE ON calibration_commands FROM app_user;

-- COMP-601.1 AC: "Belge numaralandırması boşluksuz sıralı olmalıdır (denetim
-- gereği)". Verilen bir e-İrsaliye belge numarası/ETTN asla değiştirilemez,
-- silinemez — audit_logs ile AYNI append-only kilidi (INSERT + SELECT).
-- despatch_advice_counters ise UPDATE gerektirir (sayaç artışı) — o yüzden
-- yalnızca DELETE/TRUNCATE geri alınıyor.
REVOKE UPDATE, DELETE, TRUNCATE ON despatch_advice_documents FROM app_user;
REVOKE DELETE, TRUNCATE ON despatch_advice_counters FROM app_user;
-- FUEL-403.1: cetvel versiyonlu/append-only (audit_logs deseni).
REVOKE UPDATE, DELETE, TRUNCATE ON tank_strapping_tables FROM app_user;
-- FUEL-402.1: settlement geçmişi değiştirilemez/silinemez.
REVOKE UPDATE, DELETE, TRUNCATE ON fuel_quota_history FROM app_user;
-- FUEL-408: dolum irsaliyeleri append-only (mali/stok kaydı, sonradan değişmez).
REVOKE UPDATE, DELETE, TRUNCATE ON fuel_intake_receipts FROM app_user;
-- FUEL-409: mutabakat sonucu bir düzeltme kaydıdır — sonradan değiştirilemez.
REVOKE UPDATE, DELETE, TRUNCATE ON stock_reconciliations FROM app_user;

-- Force RLS even for table owners
ALTER TABLE vehicles FORCE ROW LEVEL SECURITY;
ALTER TABLE tanks FORCE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE drivers FORCE ROW LEVEL SECURITY;
ALTER TABLE sites FORCE ROW LEVEL SECURITY;
ALTER TABLE transactions FORCE ROW LEVEL SECURITY;
ALTER TABLE cross_site_permissions FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
ALTER TABLE hardware_devices FORCE ROW LEVEL SECURITY;
ALTER TABLE device_claim_codes FORCE ROW LEVEL SECURITY;
ALTER TABLE calibration_commands FORCE ROW LEVEL SECURITY;
ALTER TABLE calibration_test_intakes FORCE ROW LEVEL SECURITY;
ALTER TABLE fail_open_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE consumption_anomaly_reports FORCE ROW LEVEL SECURITY;
ALTER TABLE despatch_advice_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE despatch_advice_counters FORCE ROW LEVEL SECURITY;
ALTER TABLE tank_strapping_tables FORCE ROW LEVEL SECURITY;
ALTER TABLE rfid_card_blacklist FORCE ROW LEVEL SECURITY;
ALTER TABLE fuel_quotas FORCE ROW LEVEL SECURITY;
ALTER TABLE fuel_quota_history FORCE ROW LEVEL SECURITY;
ALTER TABLE fuel_intake_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE stock_reconciliations FORCE ROW LEVEL SECURITY;

-- Drop existing policies if re-running
DROP POLICY IF EXISTS vehicles_tenant_isolation_policy ON vehicles;
DROP POLICY IF EXISTS tanks_tenant_isolation_policy ON tanks;
DROP POLICY IF EXISTS users_tenant_isolation_policy ON users;
DROP POLICY IF EXISTS drivers_tenant_isolation_policy ON drivers;
DROP POLICY IF EXISTS sites_tenant_isolation_policy ON sites;
DROP POLICY IF EXISTS transactions_tenant_isolation_policy ON transactions;
DROP POLICY IF EXISTS cross_site_permissions_tenant_isolation_policy ON cross_site_permissions;
DROP POLICY IF EXISTS audit_logs_tenant_isolation_policy ON audit_logs;
DROP POLICY IF EXISTS hardware_devices_tenant_isolation_policy ON hardware_devices;
DROP POLICY IF EXISTS device_claim_codes_tenant_isolation_policy ON device_claim_codes;
DROP POLICY IF EXISTS calibration_commands_tenant_isolation_policy ON calibration_commands;
DROP POLICY IF EXISTS calibration_test_intakes_tenant_isolation_policy ON calibration_test_intakes;
DROP POLICY IF EXISTS fail_open_policies_tenant_isolation_policy ON fail_open_policies;
DROP POLICY IF EXISTS consumption_anomaly_reports_tenant_isolation_policy ON consumption_anomaly_reports;
DROP POLICY IF EXISTS despatch_advice_documents_tenant_isolation_policy ON despatch_advice_documents;
DROP POLICY IF EXISTS despatch_advice_counters_tenant_isolation_policy ON despatch_advice_counters;
DROP POLICY IF EXISTS tank_strapping_tables_tenant_isolation_policy ON tank_strapping_tables;
DROP POLICY IF EXISTS rfid_card_blacklist_tenant_isolation_policy ON rfid_card_blacklist;
DROP POLICY IF EXISTS fuel_quotas_tenant_isolation_policy ON fuel_quotas;
DROP POLICY IF EXISTS fuel_quota_history_tenant_isolation_policy ON fuel_quota_history;
DROP POLICY IF EXISTS fuel_intake_receipts_tenant_isolation_policy ON fuel_intake_receipts;
DROP POLICY IF EXISTS stock_reconciliations_tenant_isolation_policy ON stock_reconciliations;

-- Create Tenant Isolation Policy for vehicles
CREATE POLICY vehicles_tenant_isolation_policy ON vehicles
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- Create Tenant Isolation Policy for tanks
CREATE POLICY tanks_tenant_isolation_policy ON tanks
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- Create Tenant Isolation Policy for users
CREATE POLICY users_tenant_isolation_policy ON users
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- Create Tenant Isolation Policy for drivers
CREATE POLICY drivers_tenant_isolation_policy ON drivers
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- Create Tenant Isolation Policy for sites
CREATE POLICY sites_tenant_isolation_policy ON sites
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- Create Tenant Isolation Policy for transactions
CREATE POLICY transactions_tenant_isolation_policy ON transactions
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- Create Tenant Isolation Policy for cross_site_permissions
CREATE POLICY cross_site_permissions_tenant_isolation_policy ON cross_site_permissions
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- Create Tenant Isolation Policy for audit_logs — REVOKE UPDATE/DELETE zaten
-- bunları app_user için SQL seviyesinde imkansız kılıyor; bu politika yalnızca
-- SELECT/INSERT'i tenant'a kısıtlıyor (FOR ALL zararsız, çünkü UPDATE/DELETE
-- yetkisi hiç yok).
CREATE POLICY audit_logs_tenant_isolation_policy ON audit_logs
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- Create Tenant Isolation Policy for hardware_devices — bu politika yalnızca
-- provisioning/rotasyon/bloke etme gibi TENANT İÇİ (withTenant() üzerinden
-- geçen, JWT ile kimliği doğrulanmış) işlemlere uygulanır. hardwareAuthMiddleware
--'in device_id'den tenant bulma sorgusu (adminDb.ts) kasıtlı olarak bunun
-- DIŞINDA, ham pool.query ile çalışır — henüz bir tenant context'i yoktur.
CREATE POLICY hardware_devices_tenant_isolation_policy ON hardware_devices
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- Create Tenant Isolation Policy for device_claim_codes — redeemDeviceClaimCode
-- (adminDb.ts) kasıtlı olarak bunun DIŞINDA, ham pool.query ile çalışır
-- (henüz bir tenant context'i yoktur, hardware_devices ile aynı gerekçe).
CREATE POLICY device_claim_codes_tenant_isolation_policy ON device_claim_codes
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- FUEL-401'in device_id/hardwareAuthMiddleware.ts ile aynı gerekçe: cihazın
-- kalibrasyon ack/nack'ı (telemetry/calibration-ack) tenant context'i JWT
-- yerine hw.tenantId ile kurulur, bu politika o AKIŞ için de geçerli kalır
-- (withTenant() üzerinden geçen normal tenant içi bir işlemdir).
CREATE POLICY calibration_commands_tenant_isolation_policy ON calibration_commands
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY calibration_test_intakes_tenant_isolation_policy ON calibration_test_intakes
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY fail_open_policies_tenant_isolation_policy ON fail_open_policies
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY consumption_anomaly_reports_tenant_isolation_policy ON consumption_anomaly_reports
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY despatch_advice_documents_tenant_isolation_policy ON despatch_advice_documents
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY despatch_advice_counters_tenant_isolation_policy ON despatch_advice_counters
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY tank_strapping_tables_tenant_isolation_policy ON tank_strapping_tables
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY rfid_card_blacklist_tenant_isolation_policy ON rfid_card_blacklist
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY fuel_quotas_tenant_isolation_policy ON fuel_quotas
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY fuel_quota_history_tenant_isolation_policy ON fuel_quota_history
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY fuel_intake_receipts_tenant_isolation_policy ON fuel_intake_receipts
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY stock_reconciliations_tenant_isolation_policy ON stock_reconciliations
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- ==============================================================================
-- [PERF] tenant_id İndeksleri
-- ==============================================================================
-- Bu 10 tabloda da RLS politikası HER sorguda `tenant_id = current_setting(...)`
-- filtresi uyguluyor (bkz. yukarıdaki politikalar) ama tenant_id üzerinde
-- hiçbir tabloda indeks YOKTU — yalnızca PRIMARY KEY (id) indeksliydi. Şu anki
-- veri hacminde (düzinelerce satır) bu görünmüyor (Postgres zaten Seq Scan'i
-- tercih ediyor), ama transactions/audit_logs gibi sürekli büyüyen tablolar
-- üretimde on binlerce/yüz binlerce satıra ulaştığında HER istekte (RLS
-- politikası aracılığıyla, uygulama kodu hiç WHERE tenant_id yazmasa bile)
-- tam tablo taraması yapılır. CREATE INDEX salt-ekleyici bir işlem olduğundan
-- (mevcut sorgu davranışını DEĞİŞTİRMEZ, yalnızca hızlandırır) risk yok.
CREATE INDEX IF NOT EXISTS idx_vehicles_tenant_id ON vehicles(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tanks_tenant_id ON tanks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_drivers_tenant_id ON drivers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sites_tenant_id ON sites(tenant_id);
CREATE INDEX IF NOT EXISTS idx_cross_site_permissions_tenant_id ON cross_site_permissions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_hardware_devices_tenant_id ON hardware_devices(tenant_id);
CREATE INDEX IF NOT EXISTS idx_device_claim_codes_tenant_id ON device_claim_codes(tenant_id);

-- transactions: en sık kullanılan sorgu deseni (GET /transactions,
-- getTenantTransactionsPaginated) `WHERE tenant_id = $1 [AND site_name = $2]
-- ORDER BY created_at DESC` — composite indeks hem RLS filtresini hem
-- sıralamayı tek bir indeks taramasıyla karşılar.
CREATE INDEX IF NOT EXISTS idx_transactions_tenant_created_at ON transactions(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_tenant_site ON transactions(tenant_id, site_name);

-- audit_logs: append-only ve yalnızca INSERT+SELECT yapılabilir (bkz.
-- yukarıdaki REVOKE) — GET /audit-logs de aynı tenant+created_at DESC deseni.
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_created_at ON audit_logs(tenant_id, created_at DESC);

-- AUTH-201.4/TEST-1003: site_name filtresi (SITE_MANAGER kapsaması) vehicles/
-- drivers/tanks'te tenant_id ile HER ZAMAN birlikte kullanılıyor.
CREATE INDEX IF NOT EXISTS idx_vehicles_tenant_site ON vehicles(tenant_id, site_name);
CREATE INDEX IF NOT EXISTS idx_drivers_tenant_site ON drivers(tenant_id, site_name);
CREATE INDEX IF NOT EXISTS idx_tanks_tenant_site ON tanks(tenant_id, site_name);

-- FUEL-404.1: cihaz bazlı geçmiş listesi + ack zaman aşımı süpürücüsünün
-- ("BEKLIYOR" olan, sent_at'i eski olan komutları bulması) sorgu deseni.
CREATE INDEX IF NOT EXISTS idx_calibration_commands_device ON calibration_commands(tenant_id, device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_calibration_commands_status ON calibration_commands(status) WHERE status = 'BEKLIYOR';

-- FUEL-404.2: cihaz bazlı test alımı geçmişi + "son 2 ölçümün ortalaması"
-- önerisinin sorgu deseni (bkz. tenantDb.ts recordCalibrationTestIntake).
CREATE INDEX IF NOT EXISTS idx_calibration_test_intakes_device ON calibration_test_intakes(tenant_id, device_id, created_at DESC);

-- FUEL-410: "en son geçerli politika" sorgusu (tenant+site VEYA tenant+NULL)
-- her zaman created_at DESC LIMIT 1 ile çalışır.
CREATE INDEX IF NOT EXISTS idx_fail_open_policies_lookup ON fail_open_policies(tenant_id, site_name, created_at DESC);

-- AI-502: dashboard'ın geçmiş raporları listelemesi tenant+created_at DESC
-- deseniyle çalışır (diğer versiyonlu geçmiş tablolarıyla aynı).
CREATE INDEX IF NOT EXISTS idx_consumption_anomaly_reports_tenant_created_at ON consumption_anomaly_reports(tenant_id, created_at DESC);

-- COMP-601.1: aynı ikmalin e-İrsaliyesi tekrar istendiğinde mevcut belgeyi
-- bulma sorgusu (UNIQUE constraint zaten bir indeks üretiyor ama açık
-- tutuyoruz).
CREATE INDEX IF NOT EXISTS idx_despatch_advice_documents_tx ON despatch_advice_documents(tenant_id, transaction_id);


-- FUEL-403.1: "en son geçerli cetvel" sorgusu her zaman
-- tenant+tank_name+created_at DESC LIMIT 1 ile çalışır.
CREATE INDEX IF NOT EXISTS idx_tank_strapping_tables_lookup ON tank_strapping_tables(tenant_id, tank_name, created_at DESC);

-- AUTH-210: denylist üyelik kontrolü (authorizeDispenseRequest step-0) ve
-- cihaz pull sorgusu tenant+card_uid ile çalışır.
CREATE INDEX IF NOT EXISTS idx_rfid_card_blacklist_lookup ON rfid_card_blacklist(tenant_id, card_uid);

-- FUEL-402.1: reset sweep "period_end geçmiş AKTİF kotalar" ve balance
-- sorgusu (tek kota) bu desenlerle çalışır.
CREATE INDEX IF NOT EXISTS idx_fuel_quotas_active_period ON fuel_quotas(tenant_id, status, period_end);
CREATE INDEX IF NOT EXISTS idx_fuel_quota_history_quota ON fuel_quota_history(tenant_id, quota_id, closed_at DESC);

-- FUEL-408: bir tankın dolum geçmişi (tank detayında liste) ve FUEL-409
-- mutabakatının "dönemdeki dolumlar" sorgusu bu desenle çalışır.
CREATE INDEX IF NOT EXISTS idx_fuel_intake_receipts_tank ON fuel_intake_receipts(tenant_id, tank_id, delivery_date DESC);

-- FUEL-409: bir tankın mutabakat geçmişi (REP-714) ve "önceki mutabakat"
-- (açılış bakiyesi) sorgusu bu desenle çalışır.
CREATE INDEX IF NOT EXISTS idx_stock_reconciliations_tank ON stock_reconciliations(tenant_id, tank_id, period_end DESC);
