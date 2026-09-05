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

