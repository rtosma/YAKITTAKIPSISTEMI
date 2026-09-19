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
    -- BILL-1701: adlandırılmış paket kademesi (TEMEL/PROFESYONEL/KURUMSAL).
    -- `modules` her zaman TEK doğruluk kaynağı (fiilen etkin özellikler) —
    -- `package` yalnızca bir ETİKET + admin paket değiştirdiğinde `modules`'a
    -- uygulanacak VARSAYILAN demet (bkz. adminDb.ts PACKAGE_MODULE_DEFAULTS).
    package VARCHAR(32) NOT NULL DEFAULT 'TEMEL',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Var olan (önceden oluşturulmuş) veritabanları için idempotent kolon ekleri
ALTER TABLE companies ADD COLUMN IF NOT EXISTS code VARCHAR(32);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS city VARCHAR(128);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS license_status VARCHAR(16) DEFAULT 'AKTİF';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS license_expiry DATE;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS modules JSONB NOT NULL DEFAULT '{"aiAnomaly":true,"eInvoice":true,"smartWarehouse":true,"maintenanceTrack":true,"driverScore":true,"crossSiteAuth":true}'::jsonb;
-- BILL-1701: bu ALTER'ın varsayılanı CREATE TABLE'daki 'TEMEL'DEN KASITLI
-- FARKLI — bu satır yalnızca `package` kolonu olmadan ÖNCEDEN oluşturulmuş
-- (dolayısıyla `modules`'u zaten yukarıdaki tam-açık demetle kurulmuş) var
-- olan firmalarda çalışır; onları sessizce 'TEMEL' (kısıtlı varsayılan demet)
-- olarak etiketlemek modülleri geri almadan yanıltıcı bir paket adı verirdi.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS package VARCHAR(32) NOT NULL DEFAULT 'KURUMSAL';

-- ARCH-108: tenant yaşam döngüsü — dondurma (giriş engellenir, veri KORUNUR)
-- ve kalıcı silme (30 gün bekleme + iki farklı SUPER_ADMIN onayı). Bu,
-- license_status/BILL-1702'nin ('ASKIDA') KASITLI olarak AYRI bir kavramdır:
-- biri fatura/ödeme ihlali (geri döndürülebilir, otomatik), diğeri hesap
-- yaşam döngüsü (SUPER_ADMIN'in bilerek tetiklediği, müşteri ayrılışı/fesih
-- sonrası bir işlem) — bkz. authMiddleware.ts'teki ayrı kontrol.
-- 'AKTİF' | 'DONDURULDU' | 'SILME_BEKLIYOR'
ALTER TABLE companies ADD COLUMN IF NOT EXISTS account_status VARCHAR(20) NOT NULL DEFAULT 'AKTİF';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS frozen_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS frozen_by VARCHAR(64);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS frozen_reason TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS deletion_scheduled_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS deletion_requested_by VARCHAR(64);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS deletion_reason TEXT;

-- INV-1503 AC: "Maliyet yöntemi tenant bazında seçilebilmelidir." Varsayılan
-- ağırlıklı ortalama (ticket'ın kendi varsayılanı) — bkz. fuelCostService.ts.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS fuel_cost_method VARCHAR(32) NOT NULL DEFAULT 'AGIRLIKLI_ORTALAMA';

-- REP-702: periyodik şifreli arşiv ayarı. NULL = periyodik oluşturma kapalı
-- (yalnızca "Şimdi Arşiv Oluştur" ile manuel tetikleme). archive_period_days
-- 7/15/30/90 dışında bir değer alamaz (uygulama katmanında Zod ile zorlanır,
-- burada CHECK ile ikinci savunma katmanı).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS archive_period_days INTEGER;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS archive_last_generated_at TIMESTAMP WITH TIME ZONE;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'companies_archive_period_days_check') THEN
    ALTER TABLE companies ADD CONSTRAINT companies_archive_period_days_check
      CHECK (archive_period_days IS NULL OR archive_period_days IN (7, 15, 30, 90));
  END IF;
END $$;

-- ARCH-108: kalıcı silme için TOPLANAN onaylar. AC: "iki farklı SUPER_ADMIN
-- onayı olmadan silme gerçekleşemez" — (tenant_id, approved_by) PRIMARY KEY
-- olduğundan AYNI admin iki kez onaylayıp sayacı kendi başına ikiye
-- çıkaramaz (ON CONFLICT DO NOTHING ile idempotent).
CREATE TABLE IF NOT EXISTS tenant_deletion_approvals (
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    approved_by VARCHAR(64) NOT NULL,
    approved_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, approved_by)
);

-- ARCH-108: kalıcı silme, `companies` satırını (ve ON DELETE CASCADE ile
-- TÜM tenant verisini) siler — bu yüzden olayın KENDİSİ audit_logs'a
-- YAZILAMAZ (audit_logs.tenant_id de AYNI CASCADE'e bağımlı, silinen
-- tenant'la BİRLİKTE giderdi; bir silme kaydının silinmesi denetim gereğiyle
-- çelişir). Bu tablo KASITLI OLARAK `companies`'e FK DEĞİL — sildiği
-- tenant'tan bağımsız, kalıcı olarak hayatta kalır. `deleted_tenant_id`
-- adı (`tenant_id` DEĞİL) bilerek seçildi: check-rls-coverage.mjs'in
-- tenant_id sütunlu her tabloda RLS arayan taramasını YANLIŞLIKLA
-- tetiklemesin — bu satırlar zaten SUPER_ADMIN'e özel, RLS'siz.
CREATE TABLE IF NOT EXISTS platform_audit_log (
    id VARCHAR(64) PRIMARY KEY,
    deleted_tenant_id VARCHAR(64) NOT NULL,
    tenant_name VARCHAR(255),
    action VARCHAR(64) NOT NULL,
    actor_user_id VARCHAR(64) NOT NULL,
    detail JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- BILL-1703: bir firmaya PAKETİNİN dışında, tek tek "satın alınmış" ek
-- modüller. companies.modules (paket temelli, admin paket değiştirince
-- SIFIRLANIR — bkz. adminDb.ts updateCompanyAdmin) ile KASITLI olarak AYRI:
-- burası bir eklentinin NEDEN etkin olduğunun kalıcı kaydı — paket
-- değiştiğinde/paket varsayılanları yeniden uygulandığında (reapplyPackageDefaults)
-- buradaki satırlar `companies.modules`'a HER ZAMAN true olarak yeniden
-- uygulanır, yani ek modül satın alımı paket değişikliğinden ETKİLENMEZ.
CREATE TABLE IF NOT EXISTS company_module_addons (
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    module_name VARCHAR(64) NOT NULL,
    added_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    added_by VARCHAR(64) NOT NULL,
    PRIMARY KEY (tenant_id, module_name)
);

-- BILL-1704: dönemsel (aylık) kullanım ölçümü — faturalama verisi. Diğer
-- mutabakat/geçmiş kayıtlarıyla (fuel_quota_history, stock_reconciliations,
-- vehicle_maintenance_records) AYNI gerekçeyle APPEND-ONLY: bir fatura
-- döneminin ölçümü bir kez hesaplanıp kilitlenir, sonradan "düzeltilmez"
-- (düzeltme gerekirse yeni bir kayıt — bu ilk sürümde kapsam dışı, YAGNI).
-- `device_days` = aktif (BLOKE olmayan) cihaz sayısı × dönemdeki gün sayısı
-- (SaaS'ta standart "provisioned device-days" ölçüsü — telemetri UPTIME'ı
-- DEĞİL, çünkü MQTT paketleri kalıcı loglanmıyor; bkz. telemetry_packet_count
-- için mqttClient.ts'teki Redis sayaç notu).
CREATE TABLE IF NOT EXISTS usage_metering_records (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    period_label VARCHAR(7) NOT NULL, -- 'YYYY-MM'
    active_device_count INTEGER NOT NULL,
    device_days INTEGER NOT NULL,
    dispense_count INTEGER NOT NULL,
    telemetry_packet_count INTEGER NOT NULL,
    edocument_count INTEGER NOT NULL,
    computed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tenant_id, period_label)
);

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
-- FUEL-407: aracın alabileceği yakıt tipi (Motorin/Benzin/AdBlue/...). NULL
-- ise kısıt yok; doluysa ikmal yetkilendirmesinde tank yakıt tipiyle uyumu
-- denetlenir (yanlış yakıt = ciddi maddi hasar).
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS fuel_type VARCHAR(64);
-- FLEET-1404: aracın sayaç ölçüm birimi. NULL ise vehicle_type'tan türetilir
-- (iş makineleri MOTOR_SAAT, diğerleri KM). 'KM' | 'MOTOR_SAAT'.
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS meter_type VARCHAR(16);
-- FLEET-1401: "yıl" ve "ortalama tüketim beklentisi" — ikisi de İKİNCİL/
-- bilgilendirici alanlar (hiçbir iş kuralı bunlara dayanmaz), NULL edilebilir.
-- avg_consumption_expectation birimi meter_type'a göre değişir (KM ise
-- L/100km, MOTOR_SAAT ise L/saat) — ayrı bir birim kolonu YOK, meter_type
-- zaten aracın birincil ölçüm birimini taşıyor, tekrar etmeye gerek yok.
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS year_of_manufacture INTEGER;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS avg_consumption_expectation NUMERIC(10, 2);

-- FLEET-1401 AC: "Şantiye ataması ve atama geçmişi" — vehicles.site_name
-- yalnızca GÜNCEL atamayı taşır (üzerine yazılır); bu tablo her GERÇEK
-- değişiklikte (createVehicle'daki ilk atama + updateVehicle'daki her
-- site_name değişikliği) append-only bir satır ekler. FK'sı vehicles(id)'ye
-- CASCADE'dir ama pratikte "Sil ve Kaldır" akışından artık TETİKLENMEZ —
-- tenantDb.ts deleteVehicle GERÇEK bir DELETE DEĞİL, `status='PASİF'`
-- güncellemesidir (AC: "araç silinmemeli, pasife alınmalıdır"); CASCADE
-- yalnızca kalıcı tenant silme gibi ayrı, gerçekten geri alınamaz bir
-- admin akışında (adminDb.ts, companies(id) ON DELETE CASCADE zinciri) devreye girer.
CREATE TABLE IF NOT EXISTS vehicle_site_assignments (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    vehicle_id VARCHAR(64) NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
    from_site_name VARCHAR(128),
    to_site_name VARCHAR(128) NOT NULL,
    changed_by VARCHAR(64),
    changed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vehicle_site_assignments_vehicle ON vehicle_site_assignments(vehicle_id, changed_at DESC);
ALTER TABLE vehicle_site_assignments ENABLE ROW LEVEL SECURITY;

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

-- INV-1504 AC: "Tank bazında kritik ve minimum stok eşikleri." NULL ise
-- (eşik hiç tanımlanmamış) kalan-gün tahmini yine çalışır, yalnızca sabit
-- litre eşiği devre dışı kalır — bkz. tankStockAlertService.ts.
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS low_stock_threshold_liters NUMERIC(10, 2);
-- Ticket notu: "3 gün sonra biter" uyarısı eyleme daha dönük — varsayılan 3.
ALTER TABLE tanks ADD COLUMN IF NOT EXISTS reorder_lead_days INTEGER NOT NULL DEFAULT 3;

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

-- HR-1801: personel kaydı + izin hakları. `drivers` tablosundan KASITLI
-- olarak AYRI — personel şoför olmayabilir (şantiye şefi, operatör vb.);
-- şoför olan bir personel `driver_id` ile drivers'a bağlanır (çakışma
-- tespiti için: bu personel izindeyken atanmış olduğu bir araç var mı).
CREATE TABLE IF NOT EXISTS personnel (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    full_name VARCHAR(128) NOT NULL,
    tc_no VARCHAR(11),
    role_title VARCHAR(64) NOT NULL DEFAULT 'DİĞER', -- 'ŞOFÖR' | 'ŞANTİYE_ŞEFİ' | 'OPERATÖR' | 'DİĞER'
    site_name VARCHAR(128),
    driver_id VARCHAR(64) REFERENCES drivers(id) ON DELETE SET NULL,
    annual_leave_entitlement_days NUMERIC(5,1) NOT NULL DEFAULT 14,
    hire_date DATE,
    status VARCHAR(16) NOT NULL DEFAULT 'AKTİF', -- 'AKTİF' | 'PASİF'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- HR-1801: izin talebi — İKİ AŞAMALI onay akışı (AC: "şantiye müdürü →
-- firma yöneticisi"). manual_dispense_requests/fuel_quotas ile AYNI desen:
-- bir durum makinesi olduğu için (diğer yeni tablolarımın çoğunun aksine)
-- APPEND-ONLY DEĞİL, app_user'dan UPDATE/DELETE REVOKE EDİLMEMİŞTİR.
-- Durumlar: TALEP_EDILDI → SAHA_ONAYLANDI (SITE_MANAGER) → ONAYLANDI
-- (COMPANY_OWNER; TALEP_EDILDI'den de kısayoldan onaylayabilir, üst rol) |
-- REDDEDILDI (her iki aşamada da) | IPTAL_EDILDI (talep sahibi, karar
-- verilmeden önce).
CREATE TABLE IF NOT EXISTS leave_requests (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    personnel_id VARCHAR(64) NOT NULL REFERENCES personnel(id) ON DELETE CASCADE,
    leave_type VARCHAR(16) NOT NULL, -- 'YILLIK' | 'MAZERET' | 'ÜCRETSİZ'
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    day_count NUMERIC(5,1) NOT NULL,
    reason TEXT,
    status VARCHAR(16) NOT NULL DEFAULT 'TALEP_EDILDI',
    requested_by VARCHAR(64) NOT NULL,
    site_approved_by VARCHAR(64),
    site_approved_at TIMESTAMP WITH TIME ZONE,
    company_approved_by VARCHAR(64),
    company_approved_at TIMESTAMP WITH TIME ZONE,
    rejection_reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_leave_requests_personnel ON leave_requests(tenant_id, personnel_id, start_date DESC);
-- personnel'de hiç indeks yoktu (yalnızca PK): her RLS'li personel sorgusu ve
-- tenant silme CASCADE'i tam tablo taraması; driver_id FK'si (ON DELETE SET
-- NULL) de şoför silinirken tam tarama yapıyordu.
CREATE INDEX IF NOT EXISTS idx_personnel_tenant_id ON personnel(tenant_id);
CREATE INDEX IF NOT EXISTS idx_personnel_driver_id ON personnel(driver_id);
CREATE INDEX IF NOT EXISTS idx_leave_requests_status ON leave_requests(tenant_id, status);

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
-- FUEL-407: ikmal anında tanktan kopyalanır — yakıt tipi bazlı stok/rapor için.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS fuel_type VARCHAR(64);
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

-- INV-1503: bu ikmalin o ANDAKİ birim maliyeti + toplam tutarı. Yazma-bir-kez
-- (createTransaction/finalizeDispenseSession/syncSingleOfflineRecord'un INSERT'i
-- ANINDA yazılır, ASLA sonradan UPDATE edilmez) — AC: "sonradan fiyat değişince
-- geçmiş maliyetler değişmemelidir." Tank'ın hiç dolum geçmişi yoksa (fiyat
-- bilinmiyor) NULL kalır — maliyetlendirilemeyen bir ikmal sessizce sıfır
-- maliyetli sayılmaz, raporlarda "maliyet bilinmiyor" olarak ayırt edilir.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS unit_cost_liters NUMERIC(12, 4);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS total_cost NUMERIC(14, 2);

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
    CONSTRAINT uq_despatch_advice_documents_number UNIQUE (tenant_id, document_number)
);

-- COMP-605: belge kesilen alıcının VKN'si ve teslim yöntemi. Alıcı
-- e-İrsaliye mükellefi DEĞİLSE elektronik belge kesilemez → delivery_mode
-- 'KAGIT' olarak işaretlenir (Kritik Not).
ALTER TABLE despatch_advice_documents ADD COLUMN IF NOT EXISTS recipient_tax_id VARCHAR(16);
ALTER TABLE despatch_advice_documents ADD COLUMN IF NOT EXISTS delivery_mode VARCHAR(16) NOT NULL DEFAULT 'ELEKTRONIK';

-- COMP-603: bir ikmal için normalde TEK aktif belge olur, ama reddedilen/iptal
-- edilen bir belge "düzeltilip yeniden gönderilebilir" (AC: yeni belge no ile).
-- Bu yüzden (tenant_id, transaction_id) artık MUTLAK tekil DEĞİL — yalnızca
-- is_correction=false olan (ORİJİNAL) satır tekildir (aşağıdaki kısmi index).
-- Düzeltme satırları corrects_document_id ile önceki (supersede edilen)
-- belgeye zincirlenir — bkz. tenantDb.ts resolveActiveDespatchAdviceDocument.
ALTER TABLE despatch_advice_documents ADD COLUMN IF NOT EXISTS is_correction BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE despatch_advice_documents ADD COLUMN IF NOT EXISTS corrects_document_id VARCHAR(64);
-- Halihazırda çalışan veritabanlarında tablo ilk CREATE TABLE ile (eski
-- UNIQUE(tenant_id, transaction_id) kısıtıyla) zaten var olabilir — schema.sql
-- yeniden çalıştırıldığında CREATE TABLE IF NOT EXISTS o eski kısıtı SİLMEZ,
-- bu yüzden burada açıkça DROP edilip yerine kısmi index konur.
ALTER TABLE despatch_advice_documents DROP CONSTRAINT IF EXISTS uq_despatch_advice_documents_tx;
CREATE UNIQUE INDEX IF NOT EXISTS uq_despatch_advice_documents_tx_original
    ON despatch_advice_documents(tenant_id, transaction_id) WHERE NOT is_correction;

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

-- COMP-602.1: e-İrsaliye entegratör iletim kuyruğu + imzalanmış çıktı arşivi.
-- Ticket S3-uyumlu obje deposu öneriyor — bu ortamda yok; imzalanmış/XSD
-- doğrulanmış XML çıktısı doğrudan xml_snapshot'a yazılır (belge kesildiği
-- anki HALİYLE kalıcı arşiv — GİB denetim gereği bir kez gönderilen içerik
-- asla değişmez). status/attempt_count/last_error/provider_reference/sent_at
-- durum makinesi alanlarıdır ve süpürücü tarafından güncellenir; xml_snapshot
-- ise despatch_advice_documents'taki belge no/ETTN gibi KALICI kabul edilir.
CREATE TABLE IF NOT EXISTS despatch_advice_transmissions (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    despatch_advice_document_id VARCHAR(64) NOT NULL,
    transaction_id VARCHAR(64) NOT NULL,
    document_number VARCHAR(32) NOT NULL,
    ettn UUID NOT NULL,
    vehicle_plate VARCHAR(32) NOT NULL,
    provider VARCHAR(32) NOT NULL,
    -- QUEUED → SENDING → SENT | FAILED (MAX deneme aşılırsa FAILED kalıcıdır;
    -- aksi halde başarısız denemeler QUEUED'a döner — bkz. tenantDb.ts
    -- runDespatchAdviceTransmissionSweepForCurrentTenant).
    status VARCHAR(16) NOT NULL DEFAULT 'QUEUED',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    provider_reference VARCHAR(128),
    xml_snapshot TEXT NOT NULL,
    queued_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    sent_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_despatch_advice_transmissions_doc UNIQUE (tenant_id, despatch_advice_document_id)
);

-- COMP-603: bir e-İrsaliye belgesinin İŞ/HUKUKİ durumu (ISSUED/REJECTED/
-- CANCELLED/SUPERSEDED). despatch_advice_transmissions'tan (entegratöre
-- TEKNİK gönderim durumu) KASITLI olarak AYRI bir tablo — biri "gönderildi mi"
-- sorusuna, diğeri "alıcı/GİB nezdinde geçerli mi" sorusuna cevap verir. Bu
-- tablo MUTABLE'dır (durum makinesi); geçmiş İSE audit_logs'ta (append-only)
-- zaten tutulur, bu yüzden ayrıca bir *_events tablosuna gerek yok.
CREATE TABLE IF NOT EXISTS despatch_advice_documents_status (
    despatch_advice_document_id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    transaction_id VARCHAR(64) NOT NULL,
    -- ISSUED (varsayılan) → REJECTED | CANCELLED → (yeniden gönderimde) SUPERSEDED
    status VARCHAR(16) NOT NULL DEFAULT 'ISSUED',
    reject_reason TEXT,
    rejected_at TIMESTAMP WITH TIME ZONE,
    cancel_reason TEXT,
    -- Gerçek bir GİB iptal sertifikası/HSM imzası bu ortamda YOK (COMP-601'in
    -- XAdES kısıt notuyla AYNI gerekçe) — simüle edilmiş bir referans üretilir.
    cancellation_certificate_ref VARCHAR(128),
    cancelled_at TIMESTAMP WITH TIME ZONE,
    superseded_by_document_id VARCHAR(64),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_despatch_advice_documents_status_tx ON despatch_advice_documents_status(tenant_id, transaction_id);

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
-- FUEL-407: bu pompanın beslendiği tank (bir tank BİRDEN ÇOK pompaya
-- bağlanabilir → benzersizlik YOK). authorizeDispenseRequest istekteki
-- tankName ile bu eşlemeyi karşılaştırır.
ALTER TABLE hardware_devices ADD COLUMN IF NOT EXISTS tank_name VARCHAR(128);

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

-- ============================================================================
-- [INV-1505] Fire/Kayıp Kaydı ve Sınıflandırması
-- ============================================================================
-- AC: "Mutabakat farkları otomatik fire adayı üretmelidir." reconcileTankRow
-- (yukarıda) status='MUTABAKAT_ALARMI' ürettiğinde BURAYA da BEKLIYOR
-- durumunda bir aday satır yazar — reconciliation_id UNIQUE olduğundan
-- (NULL'lar hariç, Postgres kuralı) aynı mutabakattan İKİNCİ bir aday asla
-- üretilmez (idempotent, ON CONFLICT DO NOTHING). classification başlangıçta
-- reconciliation'ın KENDİ (makine) sınıflandırmasıdır (BUHARLAŞMA/ÖLÇÜM_HATASI/
-- AÇIKLANAMAYAN); KAÇAK/HIRSIZLIK yalnızca bir İNSANIN inceleyip onaylarken
-- (approveFireRecord'un reclassify parametresi) atayabileceği İKİ İNCE
-- sınıftır — makine bu ikisini asla ÜRETMEZ (araştırma gerektirir).
-- Manuel kayıt da mümkündür (reconciliation_id NULL) — ticket "Fire record:
-- tarih, tank, miktar, sınıflandırma, açıklama" formunu ayrıca tanımlıyor.
-- AC: "Yüksek değerli fire kayıtları çift onay gerektirir" — manual_dispense_
-- requests'teki (FUEL-405) BİREBİR AYNI desen: first/second_approver_id/role,
-- ikinci onayın rolü BİRİNCİDEN FARKLI (bir SITE_MANAGER + bir COMPANY_OWNER/
-- SUPER_ADMIN) olmalı. AC: "fire kayıtları stok bakiyesini düzeltmeli ama
-- geçmiş dolum kayıtlarını DEĞİŞTİRMEMELİ" — onay KESİNLEŞTİĞİNDE tanks.
-- current_level_liters'a GÖRELİ bir düzeltme uygulanır (fuel_intake_receipts
-- append-only, hiç dokunulmaz).
CREATE TABLE IF NOT EXISTS fire_records (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    tank_id VARCHAR(64) NOT NULL,
    tank_name VARCHAR(128) NOT NULL,
    site_name VARCHAR(128) NOT NULL,
    -- ON DELETE SET NULL (CASCADE değil): bir fire kaydı ONAYLANDI olup gerçek
    -- bir stok düzeltmesi uygulamış olabilir — kaynak mutabakat silinse de
    -- (normal işleyişte hiç olmaz, yalnızca test/bakım senaryosu) o karar
    -- kaydı YOK OLMAMALI, sadece kaynağıyla bağlantısını kaybeder.
    reconciliation_id VARCHAR(64) UNIQUE REFERENCES stock_reconciliations(id) ON DELETE SET NULL,
    record_date DATE NOT NULL,
    -- Her zaman POZİTİF büyüklük — yön variance_direction'da ayrı tutulur.
    quantity_liters NUMERIC(10, 2) NOT NULL,
    -- 'KAYIP' (fiziksel < defter) | 'FAZLA' (fiziksel > defter).
    variance_direction VARCHAR(10) NOT NULL,
    -- 'BUHARLAŞMA' | 'ÖLÇÜM_HATASI' | 'KAÇAK' | 'HIRSIZLIK' | 'AÇIKLANAMAYAN'
    classification VARCHAR(24) NOT NULL,
    description TEXT,
    -- 'BEKLIYOR' | 'ONAYLANDI' | 'REDDEDİLDİ'
    status VARCHAR(24) NOT NULL DEFAULT 'BEKLIYOR',
    requires_dual_approval BOOLEAN NOT NULL DEFAULT FALSE,
    first_approver_id VARCHAR(64),
    first_approver_role VARCHAR(32),
    first_approved_at TIMESTAMP WITH TIME ZONE,
    second_approver_id VARCHAR(64),
    second_approver_role VARCHAR(32),
    second_approved_at TIMESTAMP WITH TIME ZONE,
    rejected_by VARCHAR(64),
    rejected_at TIMESTAMP WITH TIME ZONE,
    rejection_reason TEXT,
    created_by VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_fire_records_lookup ON fire_records(tenant_id, tank_id, status, record_date DESC);
ALTER TABLE fire_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE fire_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fire_records_tenant_isolation_policy ON fire_records;
CREATE POLICY fire_records_tenant_isolation_policy ON fire_records
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- FUEL-405: cihaz arızası / elle pompa kullanımı durumunda ikmalin kayıt
-- dışı kalmaması için manuel ikmal girişi — AMA bu kapı kaçak için
-- kullanılamasın diye İKİ FARKLI yetkilinin (bir SITE_MANAGER + bir
-- COMPANY_OWNER/SUPER_ADMIN) onayı olmadan kesinleşMEZ. İkinci onayda gerçek
-- bir transactions kaydı üretilir ve tank stoğu düşülür (transaction_id
-- doldurulur). Geriye dönük tarih en fazla MANUAL_BACKDATE_MAX_DAYS gün.
CREATE TABLE IF NOT EXISTS manual_dispense_requests (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    site_name VARCHAR(128) NOT NULL,
    vehicle_plate VARCHAR(32) NOT NULL,
    driver_name VARCHAR(128),
    tank_id VARCHAR(64) NOT NULL,
    tank_name VARCHAR(128) NOT NULL,
    liters NUMERIC(10, 2) NOT NULL,
    dispensed_at TIMESTAMP WITH TIME ZONE NOT NULL,
    reason TEXT NOT NULL,
    -- Nesne depolama yok — belge/fotoğraf yalnızca URL referansı.
    document_url VARCHAR(512),
    -- 'ONAY_BEKLIYOR' | 'ONAYLANDI' | 'REDDEDİLDİ' | 'İPTAL'
    status VARCHAR(24) NOT NULL DEFAULT 'ONAY_BEKLIYOR',
    requested_by VARCHAR(64) NOT NULL,
    first_approver_id VARCHAR(64),
    first_approver_role VARCHAR(32),
    first_approved_at TIMESTAMP WITH TIME ZONE,
    second_approver_id VARCHAR(64),
    second_approver_role VARCHAR(32),
    second_approved_at TIMESTAMP WITH TIME ZONE,
    rejected_by VARCHAR(64),
    rejected_at TIMESTAMP WITH TIME ZONE,
    rejection_reason TEXT,
    -- İkinci onayda üretilen gerçek ikmal kaydının id'si.
    transaction_id VARCHAR(64),
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

-- NOTIF-1602: e-posta kanalı hedefi. NULL = bu kullanıcı için e-posta
-- bildirimi hiç denenmez (notifyEvent EMAIL kanalında sessizce atlar).
ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255);
-- AC: "Bounce alan adresler işaretlenip tekrar denenmemelidir." Dolu ise
-- (herhangi bir zaman damgası) bu adrese BİR DAHA ASLA e-posta denemesi
-- yapılmaz — yalnızca bir yönetici manuel olarak temizleyebilir (bkz.
-- clearEmailBounce). Otomatik "bir süre sonra tekrar dene" YOK (AC net:
-- "tekrar denenmemeli", zaman aşımlı bir af mekanizması İSTENMEDİ).
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_bounced_at TIMESTAMP WITH TIME ZONE;

-- NOTIF-1603: SMS kanalı hedefi. NULL = bu kullanıcı için SMS hiç denenmez.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(32);

-- 5. Refresh Tokens — KASITLI OLARAK YOK.
-- Refresh token rotasyonu + reuse-detection tamamen Redis'te tutuluyor
-- (bkz. backend/src/services/tokenService.ts): `refresh_token:{jti}` ve
-- `refresh_tokens_by_user:{userId}` anahtarları, 7 günlük TTL ile kendi
-- kendini temizler. Daha önce burada duran `refresh_tokens` tablosu hiçbir
-- kod tarafından yazılmıyor/okunmuyordu; yanıltıcı olduğu için kaldırıldı.
-- Uzun vadeli oturum denetimi (audit) gerekirse ayrı bir `login_audit`
-- tablosu eklenmeli — token durumunu aynalayan bir tablo değil.
DROP TABLE IF EXISTS refresh_tokens;

-- AI-504: şantiye bazında mesai saatleri + çalışma günleri. Mesai dışı alım
-- tespiti bunlara göre yapılır. Kritik Not: "Vardiyalı şantiyelerde gece
-- alımı normaldir; mesai tanımı olmadan bu kural gürültü üretir" → tanımı
-- olmayan şantiye için makul bir varsayılan (07:00-19:00, Pzt-Cmt) uygulanır;
-- is_24_7=TRUE ise şantiye mesai-dışı kuralından TAMAMEN muaftır (beyaz liste).
CREATE TABLE IF NOT EXISTS site_working_hours (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    site_name VARCHAR(128) NOT NULL,
    -- Europe/Istanbul yerel gün içi dakika [0..1440). start<end varsayılır
    -- (gece yarısını aşan vardiya bu modelde is_24_7 ile ele alınır).
    start_minute INTEGER NOT NULL DEFAULT 420,   -- 07:00
    end_minute INTEGER NOT NULL DEFAULT 1140,    -- 19:00
    -- ISO haftagünü: 1=Pazartesi ... 7=Pazar.
    working_days INTEGER[] NOT NULL DEFAULT '{1,2,3,4,5,6}',
    is_24_7 BOOLEAN NOT NULL DEFAULT FALSE,
    -- Aynı araca bu süre içinde ikinci alım "kısa aralıklı mükerrer" sayılır.
    rapid_repeat_window_minutes INTEGER NOT NULL DEFAULT 30,
    updated_by VARCHAR(64) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tenant_id, site_name)
);

-- AI-504: kural tabanlı işaretlemeler. Kritik Not: "Kısa aralıklı ikinci
-- alım ... işaretleme ALARM DEĞİL inceleme kaydı üretmelidir" → bu tablo bir
-- inceleme kuyruğudur, ayrı bir alarm mekanizması değil.
CREATE TABLE IF NOT EXISTS transaction_anomaly_flags (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    transaction_id VARCHAR(64) NOT NULL,
    -- 'MESAI_DISI' | 'KISA_ARALIK_MUKERRER'
    anomaly_type VARCHAR(32) NOT NULL,
    -- 'BILGI' | 'INCELEME'
    severity VARCHAR(16) NOT NULL DEFAULT 'INCELEME',
    site_name VARCHAR(128) NOT NULL,
    vehicle_plate VARCHAR(32) NOT NULL,
    driver_name VARCHAR(128),
    transaction_at TIMESTAMP WITH TIME ZONE NOT NULL,
    amount_liters NUMERIC(10, 2),
    detail JSONB,
    -- 'ACIK' | 'INCELENDI' | 'MUAF'
    status VARCHAR(16) NOT NULL DEFAULT 'ACIK',
    reviewed_by VARCHAR(64),
    reviewed_at TIMESTAMP WITH TIME ZONE,
    review_note TEXT,
    detected_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    -- Tespit idempotent: aynı işlem+tip ikinci kez işaretlenmez.
    UNIQUE (transaction_id, anomaly_type)
);

-- AUTH-207: TOTP (RFC 6238) tabanlı 2FA. secret_base32 kurulumda üretilir,
-- enabled ancak kullanıcı ilk doğru kodu girince TRUE olur. recovery_code_hashes
-- = kalan tek kullanımlık kurtarma kodlarının Argon2id hash'leri (kullanılan
-- diziden çıkarılır). Rol bazlı ZORUNLULUK config.TOTP_ENFORCED bayrağına
-- bağlıdır (seed/demo ve mevcut test paketi yönetici hesaplarından kilitlenmesin
-- diye varsayılan kapalı; üretimde TRUE).
CREATE TABLE IF NOT EXISTS user_totp (
    user_id VARCHAR(64) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    secret_base32 VARCHAR(64) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    enabled_at TIMESTAMP WITH TIME ZONE,
    recovery_code_hashes TEXT[] NOT NULL DEFAULT '{}',
    recovery_codes_total INTEGER NOT NULL DEFAULT 0,
    last_used_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- AI-507: TÜM alarm kaynaklarının (hırsızlık AI-501, tüketim anomalisi
-- AI-502/503, mesai dışı/mükerrer AI-504, stok mutabakatı FUEL-409, negatif
-- stok IOT-303.2, kalibrasyon sapması FUEL-404, ...) tek bir yaşam döngüsüne
-- aktığı birleşik alarm tablosu. alarm_key GRUPLAMA anahtarıdır: aynı kök
-- nedenden doğan tekrarlar 50 ayrı satır değil, 1 alarm + event_count olur
-- (olaylar alarm_events'te). Kritik Not.
CREATE TABLE IF NOT EXISTS alarms (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    -- Kök nedene özgü sabit anahtar, ör. 'STOCK_RECON:tank-gebze-1' —
    -- (tenant_id, alarm_key) BENZERSİZ → gruplama.
    alarm_key VARCHAR(200) NOT NULL,
    category VARCHAR(40) NOT NULL,
    -- 'INFO' | 'WARNING' | 'CRITICAL'
    severity VARCHAR(16) NOT NULL DEFAULT 'WARNING',
    title VARCHAR(300) NOT NULL,
    site_name VARCHAR(128),
    subject_type VARCHAR(32),   -- 'VEHICLE' | 'TANK' | 'DRIVER' | 'DEVICE' | 'SITE'
    subject_id VARCHAR(128),
    -- 'OPEN' | 'ACKNOWLEDGED' | 'INVESTIGATING' | 'RESOLVED' | 'FALSE_POSITIVE'
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    assignee_id VARCHAR(64),
    event_count INTEGER NOT NULL DEFAULT 1,
    first_seen_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Susturma: bu ana kadar varsayılan listede/eskalasyonda gösterilmez.
    snoozed_until TIMESTAMP WITH TIME ZONE,
    escalation_level INTEGER NOT NULL DEFAULT 0,
    escalated_at TIMESTAMP WITH TIME ZONE,
    resolution_note TEXT,
    resolved_by VARCHAR(64),
    resolved_at TIMESTAMP WITH TIME ZONE,
    source_ref JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tenant_id, alarm_key)
);

-- AI-507: gruplanmış alarmın altındaki tekil olaylar (append-only).
CREATE TABLE IF NOT EXISTS alarm_events (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    alarm_id VARCHAR(64) NOT NULL,
    detail JSONB,
    occurred_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- COMP-605: e-İrsaliye kesilecek alıcı (mükellef) kayıtları. VKN/TCKN
-- algoritmik olarak doğrulanır; e-İrsaliye mükellefiyeti sorgulanıp
-- (COMP-602 adaptörü yoksa deterministik taklit) 24 sa önbelleklenir;
-- unvan/adres/vergi dairesi eksikse missing_fields uyarısı üretilir.
-- FLEET-1404 + RES-903: araç sayaç (km / motor-saat) okumaları. L/100km ve
-- L/motor-saat hesabının girdisi. APPEND-ONLY: bir düzeltme eski satırı
-- SİLMEZ, corrects_reading_id ile yeni bir satır ekler (Kritik Not).
-- RES-903 doğrulaması: geri giden değer / absürt sıçrama / mükerrer dönem →
-- is_suspicious + suspicion_reasons; onaylı geçişte override_approved +
-- override_reason + approved_by (audit'lenir).
CREATE TABLE IF NOT EXISTS vehicle_meter_readings (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    vehicle_id VARCHAR(64) NOT NULL,
    vehicle_plate VARCHAR(32) NOT NULL,
    -- 'KM' | 'MOTOR_SAAT'
    meter_type VARCHAR(16) NOT NULL,
    reading_value NUMERIC(12, 2) NOT NULL,
    reading_at TIMESTAMP WITH TIME ZONE NOT NULL,
    -- Dönem etiketi (ör. '2026-09' aylık, veya 'AD_HOC').
    period_label VARCHAR(16) NOT NULL,
    -- 'MANUEL' | 'TOPLU' | 'IKMAL'
    source VARCHAR(16) NOT NULL DEFAULT 'MANUEL',
    is_suspicious BOOLEAN NOT NULL DEFAULT FALSE,
    -- 'BACKWARD' | 'ABSURD_JUMP' | 'DUPLICATE_PERIOD'
    suspicion_reasons TEXT[] NOT NULL DEFAULT '{}',
    override_approved BOOLEAN NOT NULL DEFAULT FALSE,
    override_reason TEXT,
    approved_by VARCHAR(64),
    -- Bu okuma hangi (hatalı) okumayı düzeltiyor.
    corrects_reading_id VARCHAR(64),
    note TEXT,
    entered_by VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recipient_taxpayers (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    tax_id VARCHAR(16) NOT NULL,
    -- 'VKN' | 'TCKN'
    tax_id_type VARCHAR(8) NOT NULL,
    title VARCHAR(300),
    address VARCHAR(500),
    tax_office VARCHAR(160),
    is_einvoice_obligated BOOLEAN,
    obligation_checked_at TIMESTAMP WITH TIME ZONE,
    obligation_source VARCHAR(24),
    -- Eksik zorunlu alanlar (unvan/adres/vergi dairesi) — belge üretiminden
    -- önce kullanıcıya gösterilir.
    missing_fields TEXT[] NOT NULL DEFAULT '{}',
    status VARCHAR(16) NOT NULL DEFAULT 'AKTİF',
    created_by VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tenant_id, tax_id)
);

-- FLEET-1406: araç bazlı dönemsel (günlük/haftalık/aylık) yakıt limiti. Bu,
-- çapraz şantiye kotasından (cross_site_permissions) VE tanımlı yakıt
-- kotasından (fuel_quotas, FUEL-402.1) FARKLI bir kavramdır — hepsi birlikte
-- değerlendirilir, en kısıtlayıcı olan kazanır (Kritik Not). enforcement
-- 'REJECT' ise limit dolduğunda ikmal reddedilir/kısılır; 'WARN' ise yalnızca
-- uyarı (AI-507 alarmı) üretilir, ikmal engellenmez. Geçici artış (onaylı,
-- süreli) temp_increase_* alanlarında — kalıcı limit DEĞİŞMEZ.
CREATE TABLE IF NOT EXISTS vehicle_fuel_limits (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    vehicle_id VARCHAR(64) NOT NULL,
    vehicle_plate VARCHAR(32) NOT NULL,
    -- 'DAILY' | 'WEEKLY' | 'MONTHLY'
    period_type VARCHAR(16) NOT NULL DEFAULT 'MONTHLY',
    limit_liters NUMERIC(10, 2) NOT NULL,
    -- 'REJECT' | 'WARN'
    enforcement VARCHAR(16) NOT NULL DEFAULT 'REJECT',
    status VARCHAR(16) NOT NULL DEFAULT 'AKTİF',
    -- Geçici (onaylı) limit artışı — kalıcı limit_liters'ı DEĞİŞTİRMEZ.
    temp_increase_liters NUMERIC(10, 2),
    temp_increase_until DATE,
    temp_increase_reason TEXT,
    temp_increase_approved_by VARCHAR(64),
    created_by VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tenant_id, vehicle_id)
);

-- FLEET-1407: bakım-servis kaydı. Geçmiş bakım kaydı bir denetim/garanti
-- kaydıdır — fuel_intake_receipts/vehicle_meter_readings gibi APPEND-ONLY
-- (app_user'dan UPDATE/DELETE/TRUNCATE geri alınır, aşağıda). Düzeltme
-- gerekiyorsa yeni bir kayıt (örn. maintenance_type='DÜZELTME') eklenir.
CREATE TABLE IF NOT EXISTS vehicle_maintenance_records (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    vehicle_id VARCHAR(64) NOT NULL,
    vehicle_plate VARCHAR(32) NOT NULL,
    -- 'PERİYODİK_BAKIM' | 'LASTİK' | 'YAĞ_DEĞİŞİMİ' | 'ARIZA_ONARIMI' | 'DİĞER'
    maintenance_type VARCHAR(32) NOT NULL,
    performed_at DATE NOT NULL,
    -- Bakım anındaki km/motor-saat (aracın meter_type'ına göre, FLEET-1404 ile tutarlı).
    odometer_value NUMERIC(12, 2),
    cost_amount NUMERIC(12, 2) NOT NULL,
    operations_description TEXT NOT NULL,
    -- Hatırlatma sistemi için (AC): bir sonraki bakımın beklenen tarihi VE/VEYA
    -- sayaç eşiği — ikisi de opsiyonel, ikisi de dolu olabilir (hangisi önce
    -- gelirse bakım o zaman gerekir).
    next_due_date DATE,
    next_due_meter_value NUMERIC(12, 2),
    created_by VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vehicle_maintenance_records_vehicle ON vehicle_maintenance_records(tenant_id, vehicle_id, performed_at DESC);

-- FLEET-1408: muayene/egzoz/sigorta gibi yasal teslim tarihleri. Her yenileme
-- YENİ bir satır — vehicle_maintenance_records ile AYNI gerekçeyle APPEND-ONLY
-- (geçmiş asla değişmez); bir (araç, tip) için GEÇERLİ olan, o ikilinin EN SON
-- (due_date'i en büyük DEĞİL, created_at'i en yeni) satırıdır.
CREATE TABLE IF NOT EXISTS vehicle_compliance_deadlines (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    vehicle_id VARCHAR(64) NOT NULL,
    vehicle_plate VARCHAR(32) NOT NULL,
    -- 'MUAYENE' | 'EGZOZ' | 'SİGORTA' | 'DİĞER'
    deadline_type VARCHAR(32) NOT NULL,
    issued_at DATE NOT NULL,
    due_date DATE NOT NULL,
    reference_no VARCHAR(64),
    note TEXT,
    created_by VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vehicle_compliance_deadlines_vehicle ON vehicle_compliance_deadlines(tenant_id, vehicle_id, deadline_type, created_at DESC);

-- FLEET-1408: lastik envanteri — km bazlı ömür + diş derinliği takibi.
-- vehicle_maintenance_records'tan FARKLI olarak MUTABLE: takılı lastiğin
-- diş derinliği ölçümü zamanla GÜNCELLENİR (recordTireTreadDepth); bir lastik
-- değiştirildiğinde eski satır 'DEĞİŞTİRİLDİ' olarak KAPANIR (silinmez),
-- yeni lastik için YENİ bir 'AKTİF' satır açılır — bu yüzden konum başına
-- (tenant, vehicle, position) en fazla BİR 'AKTİF' satır olabilir (aşağıdaki
-- kısmi index).
CREATE TABLE IF NOT EXISTS vehicle_tires (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    vehicle_id VARCHAR(64) NOT NULL,
    vehicle_plate VARCHAR(32) NOT NULL,
    -- 'SOL_ON' | 'SAG_ON' | 'SOL_ARKA' | 'SAG_ARKA' | 'DIGER'
    position VARCHAR(16) NOT NULL,
    brand_model VARCHAR(128),
    installed_at DATE NOT NULL,
    installed_meter_value NUMERIC(12, 2) NOT NULL,
    expected_lifespan_km NUMERIC(10, 2) NOT NULL,
    tread_depth_mm NUMERIC(5, 2) NOT NULL,
    tread_depth_measured_at DATE NOT NULL,
    -- 'AKTİF' | 'DEĞİŞTİRİLDİ'
    status VARCHAR(16) NOT NULL DEFAULT 'AKTİF',
    replaced_at DATE,
    created_by VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vehicle_tires_vehicle ON vehicle_tires(tenant_id, vehicle_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_tires_active_position
    ON vehicle_tires(tenant_id, vehicle_id, position) WHERE status = 'AKTİF';

-- FLEET-1409: araç doküman/ruhsat arşivi. Ticket "presigned URL + obje
-- depolama" öneriyor — bu ortamda yok (COMP-602.1'deki aynı boşluk); dosya
-- doğrudan Postgres'te BYTEA olarak saklanıyor (10MB/PDF-JPG-PNG sınırı
-- vehicleDocumentService.ts'te uygulanıyor). APPEND-ONLY: bir belge türü
-- yenilendiğinde (ör. yeni ruhsat) YENİ bir satır eklenir, eskisi
-- SİLİNMEZ/DEĞİŞTİRİLMEZ — geçmiş belgeler denetim için saklanır; "güncel"
-- belge (vehicle_id, document_type) başına en son yüklenen olarak okunur.
CREATE TABLE IF NOT EXISTS vehicle_documents (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    vehicle_id VARCHAR(64) NOT NULL,
    vehicle_plate VARCHAR(32) NOT NULL,
    -- 'RUHSAT' | 'MUAYENE_RAPORU' | 'EGZOZ_RAPORU' | 'SIGORTA_POLICESI' | 'DIGER'
    document_type VARCHAR(32) NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(64) NOT NULL,
    file_size_bytes INTEGER NOT NULL,
    file_content BYTEA NOT NULL,
    expiry_date DATE,
    uploaded_by VARCHAR(64) NOT NULL,
    uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vehicle_documents_vehicle ON vehicle_documents(tenant_id, vehicle_id, document_type, uploaded_at DESC);

-- FLEET-1409 AC: "Belgeler ... presigned URL ile indirilebilmelidir." Bu
-- ortamda S3/obje deposu yok — REP-702'nin (tenant_archives) AYNI deseni:
-- ham token DEĞİL yalnızca SHA-256 hash'i saklanır (passwordResetService.ts
-- ile aynı ilke). BİLEREK vehicle_documents'e KOLON EKLEMEK yerine AYRI bir
-- tabloda — o tablo yukarıdaki yorumun da belirttiği gibi (ve
-- `REVOKE UPDATE, DELETE, TRUNCATE ON vehicle_documents FROM app_user`
-- ile DB seviyesinde ZORLANAN) KASITLI OLARAK DEĞİŞTİRİLEMEZ/immutable —
-- bir indirme bağlantısı token'ı UPDATE edilebilir bir durum, belgenin
-- kendisi değil; bu canlı olarak "permission denied for table
-- vehicle_documents" hatasıyla yakalandı (ilk sürüm yanlışlıkla oraya
-- UPDATE atmaya çalışıyordu). Tek aktif token/belge —
-- ON CONFLICT (document_id) DO UPDATE ile yeni bağlantı istenince eskisi
-- otomatik geçersiz kalır (rfid_card_blacklist'in AYNI deseni).
CREATE TABLE IF NOT EXISTS vehicle_document_download_links (
    document_id VARCHAR(64) PRIMARY KEY REFERENCES vehicle_documents(id) ON DELETE CASCADE,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    download_token_hash VARCHAR(64) NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- INV-1506: yedek parça/sarf malzeme kartı. Yakıt tanklarından (tanks)
-- KASITLI olarak farklı bir mimari — Kritik Not (ticket): "yakıt envanteri
-- SENSÖRLÜ, burası SENSÖRSÜZ." `current_stock` yalnızca KAYDEDİLEN
-- hareketlerle (inventory_movements) değişir, tanks.current_level_liters
-- gibi bir telemetri akışı yoktur.
CREATE TABLE IF NOT EXISTS inventory_items (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    code VARCHAR(64) NOT NULL,
    name VARCHAR(200) NOT NULL,
    unit VARCHAR(32) NOT NULL,
    site_name VARCHAR(128) DEFAULT 'Gebze Ana Şantiye',
    storage_location VARCHAR(128),
    critical_stock_level NUMERIC(12, 2) NOT NULL DEFAULT 0,
    current_stock NUMERIC(12, 2) NOT NULL DEFAULT 0,
    status VARCHAR(16) NOT NULL DEFAULT 'AKTİF',
    created_by VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tenant_id, code)
);

-- Append-only hareket geçmişi — fuel_intake_receipts/transactions ile AYNI
-- gerekçe: bir stok hareketi bir kez kaydedildikten sonra ASLA değişmez;
-- düzeltme (AC: "envanter sayımı ve düzeltme kaydı") YENİ bir
-- 'SAYIM_DÜZELTME' hareketiyle yapılır, geçmiş satır asla UPDATE edilmez.
CREATE TABLE IF NOT EXISTS inventory_movements (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    item_id VARCHAR(64) NOT NULL,
    item_code VARCHAR(64) NOT NULL,
    -- 'GİRİŞ' | 'ÇIKIŞ' | 'SAYIM_DÜZELTME'
    movement_type VARCHAR(16) NOT NULL,
    -- GİRİŞ/ÇIKIŞ için her zaman POZİTİF miktar; SAYIM_DÜZELTME için İMZALI
    -- fark (delta) — bkz. tenantDb.ts recordInventoryCount.
    quantity NUMERIC(12, 2) NOT NULL,
    balance_after NUMERIC(12, 2) NOT NULL,
    -- AC: "hareketler araç/iş emirlerine bağlanabilmeli" — iş emri kavramı bu
    -- kod tabanında yok, en yakın karşılığı FLEET-1407'nin bakım kaydıdır.
    related_vehicle_id VARCHAR(64),
    related_maintenance_record_id VARCHAR(64),
    note TEXT,
    created_by VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_item ON inventory_movements(tenant_id, item_id, created_at DESC);

-- INV-1507: şantiye laboratuvar numunesi (beton/agrega/zemin/yakıt). Mutable —
-- BEKLIYOR → TEST_EDILDI/İPTAL durum geçişi vardır. Test SONUÇLARI
-- (lab_test_results) KASITLI olarak AYRI ve append-only'dir (AC: "sonuç
-- kayıtları değiştirilemez olmalı") — numunenin kendisi bir denetim kaydı
-- DEĞİL, bir iş akışı nesnesidir.
CREATE TABLE IF NOT EXISTS lab_samples (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    -- 'BETON' | 'AGREGA' | 'ZEMİN' | 'YAKIT' | 'DİĞER'
    sample_type VARCHAR(32) NOT NULL,
    site_name VARCHAR(128) NOT NULL,
    location VARCHAR(200),
    reference_no VARCHAR(64),
    collected_at DATE NOT NULL,
    -- 'BEKLIYOR' | 'TEST_EDILDI' | 'İPTAL'
    status VARCHAR(16) NOT NULL DEFAULT 'BEKLIYOR',
    note TEXT,
    created_by VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_lab_samples_site ON lab_samples(tenant_id, site_name, collected_at DESC);

-- Append-only test sonucu — AC: "sonuç kayıtları değiştirilemez olmalı,
-- geçmiş raporlama yapılabilmeli." conformity ya doğrudan verilir (kalitatif
-- test) ya da result_value + spec_min/spec_max'tan tenantDb.ts tarafından
-- TÜRETİLİR (bkz. deriveLabResultConformity).
CREATE TABLE IF NOT EXISTS lab_test_results (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    sample_id VARCHAR(64) NOT NULL,
    test_type VARCHAR(64) NOT NULL,
    tested_at DATE NOT NULL,
    result_value NUMERIC(12, 4),
    unit VARCHAR(32),
    spec_min NUMERIC(12, 4),
    spec_max NUMERIC(12, 4),
    -- 'UYGUN' | 'UYGUNSUZ'
    conformity VARCHAR(16) NOT NULL,
    note TEXT,
    created_by VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_lab_test_results_sample ON lab_test_results(tenant_id, sample_id, created_at DESC);

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
ALTER TABLE despatch_advice_transmissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE despatch_advice_documents_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE tank_strapping_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfid_card_blacklist ENABLE ROW LEVEL SECURITY;
ALTER TABLE fuel_quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE fuel_quota_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE fuel_intake_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE manual_dispense_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_working_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_anomaly_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_totp ENABLE ROW LEVEL SECURITY;
ALTER TABLE alarms ENABLE ROW LEVEL SECURITY;
ALTER TABLE alarm_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipient_taxpayers ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_fuel_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_maintenance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_compliance_deadlines ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_tires ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_document_download_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE personnel ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_test_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_module_addons ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_deletion_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_metering_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_meter_readings ENABLE ROW LEVEL SECURITY;

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

-- REP-702: periyodik/manuel şifreli (AES-256) tenant veri arşivi.
-- `file_data` — bu yığında S3/nesne depolama YOK (Postgres + Redis dışında
-- durum tutan bir servis yok); dosya BYTEA olarak DB'de tutulur. Bu, birden
-- fazla backend replikasının AYNI arşive erişebilmesi için ZORUNLU (yerel
-- diske yazmak, "hangi replika üretti, hangi replika indirme isteğini
-- karşılıyor" tutarsızlığı yaratırdı — Dockerfile'ın "runtime'da /app'e
-- hiçbir şey YAZMIYOR" ilkesiyle de çelişirdi). Büyük kurumsal ölçek için
-- gerçek bir nesne depolamaya taşınmalı — bkz. tenantArchiveService.ts.
-- `download_token_hash` — AUTH-206 şifre sıfırlama token'ıyla AYNI desen:
-- ham token ASLA saklanmaz, yalnızca SHA-256'sı.
CREATE TABLE IF NOT EXISTS tenant_archives (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    requested_by VARCHAR(64),
    period_days INTEGER NOT NULL,
    trigger_type VARCHAR(16) NOT NULL DEFAULT 'MANUEL', -- 'MANUEL' | 'PERIYODIK'
    status VARCHAR(16) NOT NULL DEFAULT 'HAZIRLANIYOR', -- 'HAZIRLANIYOR' | 'HAZIR' | 'BASARISIZ'
    file_data BYTEA,
    file_size_bytes BIGINT,
    manifest_sha256 VARCHAR(64),
    download_token_hash VARCHAR(64) NOT NULL,
    download_count INTEGER NOT NULL DEFAULT 0,
    last_downloaded_at TIMESTAMP WITH TIME ZONE,
    error_message TEXT,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS idx_tenant_archives_tenant_created ON tenant_archives(tenant_id, created_at DESC);
ALTER TABLE tenant_archives ENABLE ROW LEVEL SECURITY;

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

-- TEST_PLAN.md §4 — platform_audit_log, audit_logs ile AYNI korumayı hak
-- ediyordu ama gözden kaçmıştı (ARCH-108'de eklenirken REVOKE yazılmamış).
-- Burası tenant DONDURMA/KALICI SİLME gibi geri alınamaz platform
-- kararlarının tek kalıcı kaydı — yani audit_logs'tan bile DAHA kritik.
-- RLS'i YOK (tenant'a ait değil, platform seviyesi bir tablo), dolayısıyla
-- tek savunması bu yetki kısıtlamasıydı; o da eksikti: app_user tabloyu
-- UPDATE/DELETE/TRUNCATE edebiliyordu. Kod tabanında tabloya YALNIZCA
-- adminDb.ts INSERT yapıyor (o da superuser bağlantısıyla), yani bu geri
-- alma hiçbir mevcut akışı etkilemiyor.
REVOKE UPDATE, DELETE, TRUNCATE ON platform_audit_log FROM app_user;

-- TEST_PLAN.md §4 — `companies` de RLS'siz (platform seviyesi tablo) ve
-- app_user'ın üzerinde INSERT/UPDATE/DELETE/TRUNCATE yetkisi vardı; oysa
-- app_user bu tabloya HİÇ YAZMIYOR — tenantDb.ts yalnızca 3 yerde ve daima
-- `WHERE id = $1` ile OKUYOR (lisans/modül/firma bilgisi). Firma oluşturma,
-- güncelleme ve silme tamamen adminDb.ts'ten (SUPER_ADMIN + superuser
-- bağlantısı) yapılıyor. SELECT ve REFERENCES bırakılıyor: okuma gerçekten
-- gerekli, REFERENCES ise diğer tabloların companies(id)'ye verdiği
-- foreign key'ler için şart.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON companies FROM app_user;

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
-- FLEET-1404 / RES-903: sayaç okumaları append-only; düzeltme = yeni satır.
REVOKE UPDATE, DELETE, TRUNCATE ON vehicle_meter_readings FROM app_user;
-- FUEL-409: mutabakat sonucu bir düzeltme kaydıdır — sonradan değiştirilemez.
REVOKE UPDATE, DELETE, TRUNCATE ON stock_reconciliations FROM app_user;
-- FLEET-1407: bakım kaydı bir denetim/garanti kaydıdır — sonradan değiştirilemez.
REVOKE UPDATE, DELETE, TRUNCATE ON vehicle_maintenance_records FROM app_user;
-- FLEET-1408: yasal teslim tarihi geçmişi de aynı gerekçeyle append-only.
-- vehicle_tires KASITLI OLARAK bu listede DEĞİL — mutable (diş derinliği/durum).
REVOKE UPDATE, DELETE, TRUNCATE ON vehicle_compliance_deadlines FROM app_user;
-- FLEET-1409: geçmiş belgeler denetim için saklanır, üzerine yazılmaz —
-- bir belge türü yenilenince YENİ satır eklenir.
REVOKE UPDATE, DELETE, TRUNCATE ON vehicle_documents FROM app_user;
-- INV-1506: stok hareket geçmişi de aynı gerekçeyle append-only.
-- inventory_items KASITLI OLARAK bu listede DEĞİL — mutable (current_stock).
REVOKE UPDATE, DELETE, TRUNCATE ON inventory_movements FROM app_user;
-- INV-1507: test sonucu bir denetim kanıtıdır — sonradan değiştirilemez.
-- lab_samples KASITLI OLARAK bu listede DEĞİL — mutable (status geçişi).
REVOKE UPDATE, DELETE, TRUNCATE ON lab_test_results FROM app_user;
-- BILL-1704: bir faturalama döneminin ölçümü bir kez hesaplanıp kilitlenir.
REVOKE UPDATE, DELETE, TRUNCATE ON usage_metering_records FROM app_user;

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
ALTER TABLE despatch_advice_transmissions FORCE ROW LEVEL SECURITY;
ALTER TABLE despatch_advice_documents_status FORCE ROW LEVEL SECURITY;
ALTER TABLE tank_strapping_tables FORCE ROW LEVEL SECURITY;
ALTER TABLE rfid_card_blacklist FORCE ROW LEVEL SECURITY;
ALTER TABLE fuel_quotas FORCE ROW LEVEL SECURITY;
ALTER TABLE fuel_quota_history FORCE ROW LEVEL SECURITY;
ALTER TABLE fuel_intake_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE stock_reconciliations FORCE ROW LEVEL SECURITY;
ALTER TABLE manual_dispense_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE site_working_hours FORCE ROW LEVEL SECURITY;
ALTER TABLE transaction_anomaly_flags FORCE ROW LEVEL SECURITY;
ALTER TABLE user_totp FORCE ROW LEVEL SECURITY;
ALTER TABLE alarms FORCE ROW LEVEL SECURITY;
ALTER TABLE alarm_events FORCE ROW LEVEL SECURITY;
ALTER TABLE recipient_taxpayers FORCE ROW LEVEL SECURITY;
ALTER TABLE vehicle_fuel_limits FORCE ROW LEVEL SECURITY;
ALTER TABLE vehicle_maintenance_records FORCE ROW LEVEL SECURITY;
ALTER TABLE vehicle_compliance_deadlines FORCE ROW LEVEL SECURITY;
ALTER TABLE vehicle_tires FORCE ROW LEVEL SECURITY;
ALTER TABLE vehicle_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE vehicle_document_download_links FORCE ROW LEVEL SECURITY;
ALTER TABLE personnel FORCE ROW LEVEL SECURITY;
ALTER TABLE leave_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_items FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_movements FORCE ROW LEVEL SECURITY;
ALTER TABLE lab_samples FORCE ROW LEVEL SECURITY;
ALTER TABLE lab_test_results FORCE ROW LEVEL SECURITY;
ALTER TABLE company_module_addons FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_deletion_approvals FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_metering_records FORCE ROW LEVEL SECURITY;
ALTER TABLE vehicle_meter_readings FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_archives FORCE ROW LEVEL SECURITY;
ALTER TABLE vehicle_site_assignments FORCE ROW LEVEL SECURITY;

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
DROP POLICY IF EXISTS despatch_advice_transmissions_tenant_isolation_policy ON despatch_advice_transmissions;
DROP POLICY IF EXISTS despatch_advice_documents_status_tenant_isolation_policy ON despatch_advice_documents_status;
DROP POLICY IF EXISTS tank_strapping_tables_tenant_isolation_policy ON tank_strapping_tables;
DROP POLICY IF EXISTS rfid_card_blacklist_tenant_isolation_policy ON rfid_card_blacklist;
DROP POLICY IF EXISTS fuel_quotas_tenant_isolation_policy ON fuel_quotas;
DROP POLICY IF EXISTS fuel_quota_history_tenant_isolation_policy ON fuel_quota_history;
DROP POLICY IF EXISTS fuel_intake_receipts_tenant_isolation_policy ON fuel_intake_receipts;
DROP POLICY IF EXISTS stock_reconciliations_tenant_isolation_policy ON stock_reconciliations;
DROP POLICY IF EXISTS manual_dispense_requests_tenant_isolation_policy ON manual_dispense_requests;
DROP POLICY IF EXISTS site_working_hours_tenant_isolation_policy ON site_working_hours;
DROP POLICY IF EXISTS transaction_anomaly_flags_tenant_isolation_policy ON transaction_anomaly_flags;
DROP POLICY IF EXISTS user_totp_tenant_isolation_policy ON user_totp;
DROP POLICY IF EXISTS alarms_tenant_isolation_policy ON alarms;
DROP POLICY IF EXISTS alarm_events_tenant_isolation_policy ON alarm_events;
DROP POLICY IF EXISTS recipient_taxpayers_tenant_isolation_policy ON recipient_taxpayers;
DROP POLICY IF EXISTS vehicle_fuel_limits_tenant_isolation_policy ON vehicle_fuel_limits;
DROP POLICY IF EXISTS vehicle_maintenance_records_tenant_isolation_policy ON vehicle_maintenance_records;
DROP POLICY IF EXISTS vehicle_compliance_deadlines_tenant_isolation_policy ON vehicle_compliance_deadlines;
DROP POLICY IF EXISTS vehicle_tires_tenant_isolation_policy ON vehicle_tires;
DROP POLICY IF EXISTS vehicle_documents_tenant_isolation_policy ON vehicle_documents;
DROP POLICY IF EXISTS vehicle_document_download_links_tenant_isolation_policy ON vehicle_document_download_links;
DROP POLICY IF EXISTS personnel_tenant_isolation_policy ON personnel;
DROP POLICY IF EXISTS leave_requests_tenant_isolation_policy ON leave_requests;
DROP POLICY IF EXISTS inventory_items_tenant_isolation_policy ON inventory_items;
DROP POLICY IF EXISTS inventory_movements_tenant_isolation_policy ON inventory_movements;
DROP POLICY IF EXISTS lab_samples_tenant_isolation_policy ON lab_samples;
DROP POLICY IF EXISTS lab_test_results_tenant_isolation_policy ON lab_test_results;
DROP POLICY IF EXISTS company_module_addons_tenant_isolation_policy ON company_module_addons;
DROP POLICY IF EXISTS tenant_deletion_approvals_tenant_isolation_policy ON tenant_deletion_approvals;
DROP POLICY IF EXISTS usage_metering_records_tenant_isolation_policy ON usage_metering_records;
DROP POLICY IF EXISTS vehicle_meter_readings_tenant_isolation_policy ON vehicle_meter_readings;
DROP POLICY IF EXISTS tenant_archives_tenant_isolation_policy ON tenant_archives;
DROP POLICY IF EXISTS vehicle_site_assignments_tenant_isolation_policy ON vehicle_site_assignments;

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

CREATE POLICY despatch_advice_transmissions_tenant_isolation_policy ON despatch_advice_transmissions
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY despatch_advice_documents_status_tenant_isolation_policy ON despatch_advice_documents_status
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

CREATE POLICY manual_dispense_requests_tenant_isolation_policy ON manual_dispense_requests
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY site_working_hours_tenant_isolation_policy ON site_working_hours
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY transaction_anomaly_flags_tenant_isolation_policy ON transaction_anomaly_flags
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY user_totp_tenant_isolation_policy ON user_totp
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY alarms_tenant_isolation_policy ON alarms
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY alarm_events_tenant_isolation_policy ON alarm_events
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY recipient_taxpayers_tenant_isolation_policy ON recipient_taxpayers
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY vehicle_fuel_limits_tenant_isolation_policy ON vehicle_fuel_limits
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY vehicle_maintenance_records_tenant_isolation_policy ON vehicle_maintenance_records
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY company_module_addons_tenant_isolation_policy ON company_module_addons
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY tenant_deletion_approvals_tenant_isolation_policy ON tenant_deletion_approvals
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY usage_metering_records_tenant_isolation_policy ON usage_metering_records
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY vehicle_compliance_deadlines_tenant_isolation_policy ON vehicle_compliance_deadlines
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY vehicle_tires_tenant_isolation_policy ON vehicle_tires
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY vehicle_documents_tenant_isolation_policy ON vehicle_documents
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY vehicle_document_download_links_tenant_isolation_policy ON vehicle_document_download_links
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY personnel_tenant_isolation_policy ON personnel
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY leave_requests_tenant_isolation_policy ON leave_requests
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY inventory_items_tenant_isolation_policy ON inventory_items
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY inventory_movements_tenant_isolation_policy ON inventory_movements
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY lab_samples_tenant_isolation_policy ON lab_samples
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY lab_test_results_tenant_isolation_policy ON lab_test_results
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY vehicle_meter_readings_tenant_isolation_policy ON vehicle_meter_readings
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY tenant_archives_tenant_isolation_policy ON tenant_archives
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY vehicle_site_assignments_tenant_isolation_policy ON vehicle_site_assignments
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
-- Araç bazlı dönem toplamları: HER ikmalde çalışan araç yakıt limiti kontrolü
-- (FLEET-1406), limit bakiyesi ve TCO `WHERE vehicle_plate = $1 AND
-- created_at >= $2 [AND < $3]`. Yalnızca (tenant_id, created_at) varken
-- 200k satırlık tenant'ta ölçüldü (EXPLAIN ANALYZE, TEST_PLAN §4): ay toplamı
-- 7,5k satır filtreleyip 2,1 ms, 365 günlük TCO paralel sıralı tarama 18 ms;
-- bu indeksle 0,12 ms / 0,9 ms. 1M satırda kurulum ~1,2 sn (deploy'un
-- tek-transaction şema adımında yazmalar bu kadar bekler).
CREATE INDEX IF NOT EXISTS idx_transactions_tenant_plate_created ON transactions(tenant_id, vehicle_plate, created_at);

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
-- COMP-602.1: süpürücünün "en eski QUEUED" seçimi bu birleşik indexi kullanır.
CREATE INDEX IF NOT EXISTS idx_despatch_advice_transmissions_status ON despatch_advice_transmissions(tenant_id, status, queued_at);


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

-- FLEET-1404: bir aracın en son okuması + dönem bazlı eksik-giriş sorgusu.
CREATE INDEX IF NOT EXISTS idx_vehicle_meter_readings_lookup ON vehicle_meter_readings(tenant_id, vehicle_id, meter_type, reading_at DESC);

-- FLEET-1406: aracın aktif limitini bulma + ikmal yetkilendirmesindeki
-- dönemsel tüketim sorgusu bu desenle çalışır.
CREATE INDEX IF NOT EXISTS idx_vehicle_fuel_limits_vehicle ON vehicle_fuel_limits(tenant_id, vehicle_id, status);

-- FUEL-405: onay kuyruğu (status='ONAY_BEKLIYOR') ve şantiye bazlı manuel
-- giriş oranı sorgusu bu desenle çalışır.
CREATE INDEX IF NOT EXISTS idx_manual_dispense_requests_status ON manual_dispense_requests(tenant_id, status, created_at DESC);

-- AI-504: inceleme kuyruğu (status='ACIK') ve dönem/şantiye filtreli listeleme.
CREATE INDEX IF NOT EXISTS idx_transaction_anomaly_flags_queue ON transaction_anomaly_flags(tenant_id, status, transaction_at DESC);

-- AI-507: aktif alarm listesi (RESOLVED/FALSE_POSITIVE hariç) + eskalasyon
-- süpürücüsü (CRITICAL + OPEN + eski) bu desenle çalışır.
CREATE INDEX IF NOT EXISTS idx_alarms_active ON alarms(tenant_id, status, severity, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_alarm_events_alarm ON alarm_events(tenant_id, alarm_id, occurred_at DESC);

-- ============================================================================
-- [AI-506] Şoför Davranış Skorlama Motoru
-- ============================================================================
-- AC: "0-100 arası davranış skoru... skor geçmişi tutulmalı." Skor; mesai
-- dışı alım (AI-504 MESAI_DISI oranı), mükerrer alım (AI-504
-- KISA_ARALIK_MUKERRER oranı), tüketim sapması (AI-503'teki z-score
-- yöntemiyle AYNI, ama şoförün KENDİ geçmiş ikmal miktarına göre),
-- iptal/anormal sonlanan ikmaller (transactions.verification_status =
-- 'DOĞRULAMA_BEKLIYOR' + manual_dispense_requests.status IN
-- ('İPTAL','REDDEDİLDİ')) ve manuel giriş oranı (rfid_auth = false)
-- girdilerinin ağırlıklı toplamından üretilir.
-- Kritik Not: "minimum işlem eşiği altında skor üretilmemeli" — AI-503'teki
-- "yetersiz geçmiş → anomali üretilmez" deseniyle AYNI: eşiğin altındaki
-- şoförler için bu tabloya HİÇ satır yazılmaz.
-- "Skor geçmişi" AC'si: her hesaplama turu YENİ bir satır ekler
-- (append-only, UPDATE yok) — tarihçe böylece doğal olarak sağlanır.
-- driver_name: transactions/drivers ile AYNI desen — plain string, FK değil
-- (bkz. transactions tablosu üstündeki not); şoför yeniden adlandırılırsa
-- geçmiş skorlar eski adla kalır.
CREATE TABLE IF NOT EXISTS driver_behavior_scores (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    driver_name VARCHAR(128) NOT NULL,
    -- Şoförün bu dönemdeki EN SON işlemine ait şantiye — filtreleme/rapor
    -- amaçlı; drivers.name↔transactions.driver_name FK OLMADIĞI için
    -- ayrıca bir JOIN gerektirmesin diye burada da tutuluyor (denormalize).
    site_name VARCHAR(128),
    period_days INTEGER NOT NULL,
    transaction_count INTEGER NOT NULL,
    score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
    offhours_ratio_pct NUMERIC(5, 2) NOT NULL DEFAULT 0,
    rapid_repeat_ratio_pct NUMERIC(5, 2) NOT NULL DEFAULT 0,
    consumption_deviation_ratio_pct NUMERIC(5, 2) NOT NULL DEFAULT 0,
    cancelled_ratio_pct NUMERIC(5, 2) NOT NULL DEFAULT 0,
    manual_entry_ratio_pct NUMERIC(5, 2) NOT NULL DEFAULT 0,
    detail JSONB,
    computed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_driver_behavior_scores_lookup ON driver_behavior_scores(tenant_id, driver_name, computed_at DESC);
ALTER TABLE driver_behavior_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_behavior_scores FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS driver_behavior_scores_tenant_isolation_policy ON driver_behavior_scores;
CREATE POLICY driver_behavior_scores_tenant_isolation_policy ON driver_behavior_scores
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- ============================================================================
-- [IOT-308] Cihaz Sağlık Skoru, Sürüm Envanteri ve Online SLA Takibi
-- ============================================================================
-- Bloklayan IOT-301.2 (presence/LWT) VAR, IOT-306 (OTA firmware) YOK — bu
-- yüzden "firmware_version" burada yalnızca cihazın KENDİ bildirdiği sürümü
-- KAYDEDER (envanter), bir OTA dağıtım/rollout mekanizması İÇERMEZ (o,
-- IOT-306'nın kapsamı).
--
-- Bilinçli sapma — "paket kaybı/hata sayısı/pil-RSSI/saat sapması" ticket'ın
-- istediği ama bugüne kadar HİÇBİR yerde toplanmayan sinyaller (bkz.
-- mqttClient.ts/redisPool.ts'teki IOT-308 yorumları):
--  - "online oranı" → device_presence_events (aşağıda, append-only) — IOT-301.2
--    zaten GERÇEK zamanlı geçişleri (deviceStatusChanged) tespit ediyordu ama
--    hiçbir yere KALICI olarak yazmıyordu (yalnızca 10sn TTL'li bir Redis
--    anahtarı — geçmiş yok). Bu tablo o boşluğu dolduruyor; SADECE BUGÜNDEN
--    SONRAKİ geçişler için gerçek veri üretir, geriye dönük backfill YOK.
--  - "paket kaybı" → GERÇEK bir sıra numarası/beklenen-aralık takibi YOK;
--    vekil gösterge olarak OFFLINE geçiş SIKLIĞI kullanılıyor (sık
--    online/offline "flapping" = bağlantı kararsızlığı). Dürüst bir yaklaşım
--    olarak düşük ağırlıklı bir girdi (bkz. tenantDb.ts DEVICE_HEALTH_WEIGHTS).
--  - "hata sayısı" → IOT-301.3 payload validation'ın REDDETTİĞİ paket oranı
--    (bozuk JSON/LoRaWAN) — Redis sayaçları (device:{id}:health:total/error,
--    bkz. redisPool.ts), her hesaplama turunda okunup sıfırlanır (Postgres'e
--    her paketi yazmak hacim açısından anlamsız).
--  - "pil/RSSI" ve "saat sapması" → yalnızca cihaz bu alanları KENDİSİ
--    bildiriyorsa (LoRaWAN decoder zaten rssi/batteryVoltage/lowBattery
--    çözüyor; standart JSON telemetri için `rssi`/`batteryPct`/`deviceTimeMs`
--    OPSİYONEL alanlar) hardware_devices'te "son bilinen değer" olarak
--    tutulur ve NOKTA-ZAMANLI (ratio değil, 0/1) bir ceza girdisi olarak
--    skora katılır — veri yoksa ceza YOK (cihazın firmware'i bu alanları
--    hiç göndermiyor olabilir, bu onu "kötü" yapmaz).

-- Cihazın kendi bildirdiği sürüm + en son telemetri "vital" değerleri —
-- her yeni ONLINE/telemetri mesajında ÜZERİNE YAZILIR (append-only DEĞİL,
-- "son bilinen durum" anlık görüntüsü — geçmiş için device_presence_events'e
-- ve device_health_scores'a bakın).
ALTER TABLE hardware_devices ADD COLUMN IF NOT EXISTS firmware_version VARCHAR(32);
ALTER TABLE hardware_devices ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE hardware_devices ADD COLUMN IF NOT EXISTS last_reported_rssi INTEGER;
ALTER TABLE hardware_devices ADD COLUMN IF NOT EXISTS last_reported_battery_pct NUMERIC(5, 2);
ALTER TABLE hardware_devices ADD COLUMN IF NOT EXISTS last_reported_low_battery BOOLEAN;
ALTER TABLE hardware_devices ADD COLUMN IF NOT EXISTS last_clock_drift_ms BIGINT;

-- IOT-301.2'nin GERÇEK ZAMANLI ürettiği (ama hiçbir yere kalıcı yazmadığı)
-- ONLINE/OFFLINE geçişlerinin append-only geçmişi — online oranı/SLA
-- hesabının TEK gerçek veri kaynağı budur (Redis'teki TTL anahtarı geçmiş
-- tutmaz). mqttClient.ts'te SADECE gerçek bir geçişte (setDeviceState'in
-- true döndürdüğü an) bir satır eklenir.
CREATE TABLE IF NOT EXISTS device_presence_events (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    device_id VARCHAR(64) NOT NULL,
    site_name VARCHAR(128),
    status VARCHAR(16) NOT NULL, -- 'ONLINE' | 'OFFLINE'
    occurred_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_device_presence_events_lookup ON device_presence_events(tenant_id, device_id, occurred_at DESC);
ALTER TABLE device_presence_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_presence_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS device_presence_events_tenant_isolation_policy ON device_presence_events;
CREATE POLICY device_presence_events_tenant_isolation_policy ON device_presence_events
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- AI-506 (driver_behavior_scores) ile AYNI desen: append-only, her hesaplama
-- turu YENİ bir satır ekler (UPDATE yok) — "skor geçmişi" böylece korunur.
-- Eşiğin altındaki (yetersiz örnek/presence olayı) cihazlar İÇİN HİÇ satır
-- yazılmaz (bkz. tenantDb.ts computeDeviceHealthScores — skippedInsufficientData).
CREATE TABLE IF NOT EXISTS device_health_scores (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    device_id VARCHAR(64) NOT NULL,
    site_name VARCHAR(128),
    period_days INTEGER NOT NULL,
    sample_count INTEGER NOT NULL,
    score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
    offline_ratio_pct NUMERIC(5, 2) NOT NULL DEFAULT 0,
    packet_loss_ratio_pct NUMERIC(5, 2) NOT NULL DEFAULT 0,
    telemetry_error_ratio_pct NUMERIC(5, 2) NOT NULL DEFAULT 0,
    signal_battery_penalty_pct NUMERIC(5, 2) NOT NULL DEFAULT 0,
    clock_drift_penalty_pct NUMERIC(5, 2) NOT NULL DEFAULT 0,
    detail JSONB,
    computed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_device_health_scores_lookup ON device_health_scores(tenant_id, device_id, computed_at DESC);
ALTER TABLE device_health_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_health_scores FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS device_health_scores_tenant_isolation_policy ON device_health_scores;
CREATE POLICY device_health_scores_tenant_isolation_policy ON device_health_scores
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- ============================================================================
-- [IOT-306] OTA Firmware Dağıtım Servisi (Sürüm, Kanal, Kademeli Rollout)
-- ============================================================================
-- AC bağımlılığı FW-1311 (güvenli OTA + A/B partition rollback) bu depoda
-- YOK — cihaz tarafı firmware/bootloader kodu bu projenin kapsamı dışında.
-- Bu yüzden "cihaz tarafı rollback sinyalinin izlenmesi" AC'si, cihazın
-- KENDİSİNİN bir A/B rollback yaptığını AYRI bir bildirim olarak raporladığı
-- varsayımıyla modellenir (routes.ts: POST .../devices/:deviceId/report-rollback)
-- — IOT-305'in ack/timeout/retry kuyruğunun (commandQueueService.ts) PAYLOAD'ını
-- GENİŞLETMEDEN (o dosya IOT-305/FUEL-406 arasında paylaşımlı, riskli).
--
-- Firmware artefaktları TENANT'A ÖZEL DEĞİL — platform genelinde tek bir
-- katalog (getAllHardwareDevices/getModuleCatalog ile AYNI gerekçe: donanım
-- envanteri SUPER_ADMIN'in yönettiği bir kaynak) — bu yüzden RLS YOK, ham
-- `pool` ile adminDb.ts'te yazılır (schema.sql'in kendisi bunu KISITLAMAZ,
-- ama tenant_id kolonu OLMADIĞI için check-rls-coverage.mjs'in "tenant
-- tablosu" taramasına hiç girmez). Rollout'lar İSE bir tenant'ın KENDİ
-- cihazlarını hedeflediği için tenant-scoped (RLS var).
CREATE TABLE IF NOT EXISTS firmware_artifacts (
    id VARCHAR(64) PRIMARY KEY,
    version VARCHAR(32) NOT NULL,
    -- Bu firmware'in uyumlu olduğu donanım revizyonu (hardware_devices.hardware_revision, IOT-304).
    hardware_revision VARCHAR(64) NOT NULL,
    -- 'stable' | 'beta'
    channel VARCHAR(16) NOT NULL DEFAULT 'stable',
    -- Nesne depolama yok (ticket "S3 uyumlu" öneriyor) — manual_dispense_
    -- requests.document_url/vehicle_documents ile AYNI desen: sadece URL referansı.
    artifact_url VARCHAR(512) NOT NULL,
    sha256 VARCHAR(64) NOT NULL,
    signature TEXT NOT NULL,
    created_by VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (version, hardware_revision)
);

-- AC: "Cihaz grubuna kademeli dağıtım yapılabilmelidir" — %10 → %50 → %100.
-- Her aşama SENKRON olarak (bir startFirmwareRollout çağrısı İÇİNDE, ayrı bir
-- süpürücü/job OLMADAN) işlenir: aşamanın başarısızlık oranı %20'yi (
-- failure_threshold_pct) aşarsa rollout DURDURULDU'ya düşer ve BİR SONRAKİ
-- aşamaya HİÇ geçilmez (AC: "Başarısızlık eşiği aşıldığında rollout otomatik
-- durmalıdır").
CREATE TABLE IF NOT EXISTS firmware_rollouts (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    firmware_artifact_id VARCHAR(64) NOT NULL REFERENCES firmware_artifacts(id),
    -- NULL = tüm uygun cihazlar; verilirse yalnızca o şantiyedeki cihazlar.
    site_name VARCHAR(128),
    -- 10 | 50 | 100 — o ana kadar ULAŞILAN kademe.
    current_stage_pct INTEGER NOT NULL DEFAULT 0,
    target_device_count INTEGER NOT NULL,
    failure_threshold_pct NUMERIC(5, 2) NOT NULL DEFAULT 20,
    -- 'DEVAM_EDIYOR' | 'DURDURULDU' | 'TAMAMLANDI'
    status VARCHAR(24) NOT NULL DEFAULT 'DEVAM_EDIYOR',
    halted_reason TEXT,
    halted_at TIMESTAMP WITH TIME ZONE,
    started_by VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_firmware_rollouts_lookup ON firmware_rollouts(tenant_id, status, created_at DESC);
ALTER TABLE firmware_rollouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE firmware_rollouts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS firmware_rollouts_tenant_isolation_policy ON firmware_rollouts;
CREATE POLICY firmware_rollouts_tenant_isolation_policy ON firmware_rollouts
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- Rollout'a atanan HER cihaz için TEK satır (hangi aşamada gönderildi + sonucu).
CREATE TABLE IF NOT EXISTS firmware_rollout_devices (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    rollout_id VARCHAR(64) NOT NULL REFERENCES firmware_rollouts(id) ON DELETE CASCADE,
    device_id VARCHAR(64) NOT NULL,
    stage_pct INTEGER NOT NULL,
    command_id VARCHAR(64),
    -- 'GÖNDERILDI' | 'BAŞARILI' | 'BAŞARISIZ' | 'GERİ_ALINDI' (FW-1311 rollback bildirimi)
    status VARCHAR(24) NOT NULL,
    failure_reason TEXT,
    dispatched_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP WITH TIME ZONE,
    UNIQUE (rollout_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_firmware_rollout_devices_lookup ON firmware_rollout_devices(tenant_id, rollout_id, stage_pct);
ALTER TABLE firmware_rollout_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE firmware_rollout_devices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS firmware_rollout_devices_tenant_isolation_policy ON firmware_rollout_devices;
CREATE POLICY firmware_rollout_devices_tenant_isolation_policy ON firmware_rollout_devices
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- ============================================================================
-- [NOTIF-1601] Bildirim Çekirdeği: Olay → Şablon → Kanal Yönlendirme
-- ============================================================================
-- Bloklayan ARCH-102 (event-driven olay veri yolu, #14) bu depoda YOK — bu
-- yüzden "olay yayımlanır" AC'si, notificationService.ts'in `notifyEvent()`
-- fonksiyonunun DÜZ bir çağrı (fire-and-forget, `void notifyEvent(...)`)
-- olarak çağrılmasıyla sağlanır; ayrı bir event bus/kuyruk YOK. Şablon
-- motoru: handlebars/eta (ticket'ın Teknik Yığın'ı) DEĞİL — basit bir
-- `{{degisken}}` regex değiştiricisi (templateRegistry.ts, kod içi, DB'de
-- DEĞİL — "yeni bir bildirim tipi şablon+eşleme EKLENEREK tanımlanabilir"
-- AC'si TypeScript registry'sine YENİ BİR SATIR eklemekle sağlanıyor, ayrıca
-- iş mantığı kodu YAZILMADAN). "Aynı olay için mükerrer bildirim gitmemeli"
-- AC'si UNIQUE(tenant_id, idempotency_key) ile (NULL'lar hariç, Postgres
-- kuralı — idempotency_key vermeyen çağrılar dedupe edilmez, bilerek).
CREATE TABLE IF NOT EXISTS notifications (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    event_type VARCHAR(64) NOT NULL,
    idempotency_key VARCHAR(128),
    -- NULL = tenant geneli (tüm yönetici rolleri) — belirli bir kullanıcıya YÖNELİK değil.
    user_id VARCHAR(64),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    -- Şimdilik yalnızca 'IN_APP' (NOTIF-1602/1603/1604 e-posta/SMS/Telegram — AYRI ticket'lar).
    channel VARCHAR(16) NOT NULL DEFAULT 'IN_APP',
    -- NOTIF-1603: kanal-özel karar mantığı (örn. SMS "yalnızca CRITICAL")
    -- YARATMA anındaki opts.priority'ye bağlıdır. Bu KALICI olarak
    -- saklanmalı — runNotificationRetrySweepForCurrentTenant() aynı
    -- bildirimi GÜNLER sonra yeniden dener; priority argüman olarak
    -- YENİDEN geçirilseydi (geçirilmiyordu, canlı yakalanan bir kusur)
    -- her retry sessizce 'NORMAL'e düşer, CRITICAL bir SMS'i kalıcı olarak
    -- reddederdi. 'NORMAL' | 'CRITICAL'.
    priority VARCHAR(16) NOT NULL DEFAULT 'NORMAL',
    -- 'BEKLIYOR' | 'GÖNDERILDI' | 'BAŞARISIZ' (yeniden denenecek) | 'KALICI_BAŞARISIZ' (deneme tükendi)
    status VARCHAR(24) NOT NULL DEFAULT 'BEKLIYOR',
    attempts INTEGER NOT NULL DEFAULT 0,
    variables JSONB,
    read_at TIMESTAMP WITH TIME ZONE,
    delivered_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_notifications_lookup ON notifications(tenant_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_retry ON notifications(status) WHERE status = 'BAŞARISIZ';
-- `priority` CREATE TABLE'ın kendi sütun listesinde de var (yeni bir kurulum
-- için) — ama bu tablo NOTIF-1601/1602'den beri VAR olan kurulumlarda
-- `IF NOT EXISTS` CREATE TABLE'ı hiç ÇALIŞTIRMAZ (canlıda böyle yakalandı:
-- sütun sessizce eksik kaldı). Var olan kurulumlar için ayrıca ALTER gerekli.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS priority VARCHAR(16) NOT NULL DEFAULT 'NORMAL';
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notifications_tenant_isolation_policy ON notifications;
CREATE POLICY notifications_tenant_isolation_policy ON notifications
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- ============================================================================
-- [NOTIF-1603] SMS Kanalı — Aylık Kullanım/Limit Takibi
-- ============================================================================
-- AC: "Aylık SMS limiti aşıldığında uyarı üretilmelidir." Redis DEĞİL —
-- e-posta hızı sınırının (NOTIF-1602, 60sn'lik kayan pencere) AKSİNE bu
-- AY BOYUNCA kalıcı olmalı (bir Redis restart'ı sayacı sıfırlarsa maliyet
-- kontrolü AC'si delinir) — bu yüzden kalıcı bir DB satırı.
CREATE TABLE IF NOT EXISTS sms_monthly_usage (
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    -- 'YYYY-MM' — insan-okunur, sıralanabilir, DATE_TRUNC gerektirmez.
    year_month VARCHAR(7) NOT NULL,
    sent_count INTEGER NOT NULL DEFAULT 0,
    monthly_limit INTEGER NOT NULL DEFAULT 100,
    limit_alarm_raised BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, year_month)
);
ALTER TABLE sms_monthly_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_monthly_usage FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_monthly_usage_tenant_isolation_policy ON sms_monthly_usage;
CREATE POLICY sms_monthly_usage_tenant_isolation_policy ON sms_monthly_usage
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- ============================================================================
-- [NOTIF-1604] Telegram ve Webhook Kanalı — Tenant Bazlı Yapılandırma
-- ============================================================================
-- AC: "Bot token'ı tenant bazında saklanmalı ve şifrelenmelidir" — bu yüzden
-- `companies` üzerinde DEĞİL (app_user'dan UPDATE zaten REVOKE edilmiş,
-- INV-1503/REP-702 ile AYNI gerekçe) ayrı, tenant-scoped bir tablo; şifreli
-- alanlar channelSecretCrypto.ts ile (webhook_secret_encrypted DE dahil —
-- HMAC imzalamak için düz metne geri dönülebilmesi gerekir, tek yönlü hash
-- KULLANILAMAZ).
CREATE TABLE IF NOT EXISTS tenant_notification_channels (
    tenant_id VARCHAR(64) PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    telegram_bot_token_encrypted TEXT,
    telegram_chat_id VARCHAR(64),
    webhook_url VARCHAR(512),
    webhook_secret_encrypted TEXT,
    -- AC: "Sürekli hata veren webhook otomatik devre dışı bırakılmalıdır."
    -- Opossum (COMP-602.2'nin kendi ticket'ı, YOK) yerine basit bir ardışık-
    -- başarısızlık sayacı — WEBHOOK_DISABLE_THRESHOLD (kod içi) art üst
    -- üste başarısızlıkta webhook_disabled_at doldurulur, bir SONRAKİ
    -- gönderim denemesi bile YAPILMAZ (WebhookDisabledError). Yalnızca elle
    -- (bir yönetici webhook_url/secret'i YENİDEN kaydederek) temizlenebilir.
    webhook_consecutive_failures INTEGER NOT NULL DEFAULT 0,
    webhook_disabled_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE tenant_notification_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_notification_channels FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_notification_channels_tenant_isolation_policy ON tenant_notification_channels;
CREATE POLICY tenant_notification_channels_tenant_isolation_policy ON tenant_notification_channels
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- ============================================================================
-- [NOTIF-1605] Kullanıcı Bazlı Abonelik ve Sessize Alma
-- ============================================================================
-- AC: "Kullanıcı olay tipi VE kanal bazında tercih belirleyebilmelidir."
-- Satır YOKSA varsayılan enabled=TRUE (opt-out modeli — "herkes başta her
-- şeyi alır, istemeyen kapatır"). Ticket'ın "varsayılan tercih setleri (rol
-- bazlı)" notu BİLEREK basitleştirildi (Efor: S) — tek bir global opt-out
-- varsayılanı, rol bazlı farklı varsayılan setleri YOK.
CREATE TABLE IF NOT EXISTS user_notification_preferences (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id VARCHAR(64) NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    channel VARCHAR(16) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, event_type, channel)
);
ALTER TABLE user_notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_notification_preferences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_notification_preferences_tenant_isolation_policy ON user_notification_preferences;
CREATE POLICY user_notification_preferences_tenant_isolation_policy ON user_notification_preferences
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- AC: "Sessize alma süreli olmalı ve süre sonunda otomatik kalkmalıdır."
-- Aktif temizlik/cron YOK — `muted_until > NOW()` kontrolü DELIVERY
-- ANINDA yapılır (users.email_bounced_at/tank stok tahmini gibi "TTL
-- karşılaştırmayla doğal olarak biter" deseninin AYNISI): süresi geçmiş
-- bir satır basitçe artık etkisiz, silinmesi GEREKMEZ.
CREATE TABLE IF NOT EXISTS user_notification_mutes (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id VARCHAR(64) NOT NULL,
    -- NULL = TÜM olay tipleri susturulur.
    event_type VARCHAR(64),
    muted_until TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_user_notification_mutes_lookup ON user_notification_mutes(tenant_id, user_id, muted_until);
ALTER TABLE user_notification_mutes ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_notification_mutes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_notification_mutes_tenant_isolation_policy ON user_notification_mutes;
CREATE POLICY user_notification_mutes_tenant_isolation_policy ON user_notification_mutes
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- REP-705 (#167): zamanlanmış rapor gönderimi (cron → e-posta) tanımı.
-- `recipient_user_ids` bilerek e-posta ADRESİ değil kullanıcı ID'si tutar —
-- "alıcı listesi kullanıcı silindiğinde güncellenmelidir" AC'si, gönderim
-- ANINDA canlı bir `users` sorgusuyla e-postanın ÇÖZÜLMESİYLE karşılanır
-- (bkz. reportScheduleService.ts) — silinen bir kullanıcı sorgudan
-- KENDİLİĞİNDEN düşer, ayrı bir "temizleme" adımı gerekmez.
CREATE TABLE IF NOT EXISTS report_schedules (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    -- reports/reportRegistry.ts'teki KAYITLI bir rapor id'si (ör. 'rep-711').
    report_id VARCHAR(64) NOT NULL,
    filters JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- 'CSV' — EXCEL/PDF bu turun KAPSAMI DIŞI (bkz. reportScheduleService.ts başı).
    format VARCHAR(16) NOT NULL DEFAULT 'CSV',
    -- 'DAILY' | 'WEEKLY' | 'MONTHLY'.
    period_type VARCHAR(16) NOT NULL,
    -- Europe/Istanbul (SABİT UTC+3 — bkz. index.ts'teki kota sıfırlama
    -- yorumuyla AYNI varsayım, gerçek bir IANA tz kütüphanesi YOK) saatte 0-23.
    send_hour_local INTEGER NOT NULL DEFAULT 7,
    day_of_week INTEGER,   -- WEEKLY için 0(Pazar)-6(Cumartesi).
    day_of_month INTEGER,  -- MONTHLY için 1-28 (ay uzunluğu belirsizliğini önlemek için 28'de sınırlı).
    recipient_user_ids TEXT[] NOT NULL,
    -- AC/Kapsam: "Boş rapor durumunda gönderim yapılmaması seçeneği."
    skip_if_empty BOOLEAN NOT NULL DEFAULT FALSE,
    -- Oluşturan SITE_MANAGER ise siteScopeFor() ile SABİTLENİR (routes.ts'teki
    -- AYNI desen) — zamanlama sonradan başka bir şantiyeye "kaydırılamaz".
    site_scope VARCHAR(128),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_by VARCHAR(64) NOT NULL,
    next_run_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_report_schedules_due ON report_schedules(tenant_id, next_run_at) WHERE enabled = TRUE;
ALTER TABLE report_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_schedules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS report_schedules_tenant_isolation_policy ON report_schedules;
CREATE POLICY report_schedules_tenant_isolation_policy ON report_schedules
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- REP-705: gönderim geçmişi + yeniden deneme. `notifications` tablosunun
-- status/attempts deseninin AYNISI (bkz. NOTIF-1601). `UNIQUE(schedule_id,
-- period_key)` — AYNI dönem için süpürücü birden fazla kez çalışsa da
-- (retry) YENİ bir satır YARATMAZ, VAR OLANI dener (idempotency_key ile
-- AYNI ruh). `file_data` yalnızca LINK modunda (>10MB) doldurulur —
-- ATTACHMENT modunda e-posta zaten teslim edildiği için ekin KENDİSİ
-- ayrıca DB'de saklanmaz (bkz. REP-702'nin her zaman sakladığı ZIP'ten
-- BİLİNÇLİ fark — burada sık/küçük raporların DB'yi şişirmemesi öncelikli).
CREATE TABLE IF NOT EXISTS report_deliveries (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    schedule_id VARCHAR(64) NOT NULL REFERENCES report_schedules(id) ON DELETE CASCADE,
    period_key VARCHAR(32) NOT NULL,
    -- 'BEKLIYOR' | 'GÖNDERILDI' | 'BAŞARISIZ' | 'KALICI_BAŞARISIZ' | 'ATLANDI_BOŞ'.
    status VARCHAR(24) NOT NULL DEFAULT 'BEKLIYOR',
    attempts INTEGER NOT NULL DEFAULT 0,
    row_count INTEGER,
    delivery_mode VARCHAR(16), -- 'ATTACHMENT' | 'LINK'
    file_data BYTEA,
    file_size_bytes INTEGER,
    download_token_hash VARCHAR(64),
    expires_at TIMESTAMP WITH TIME ZONE,
    last_error TEXT,
    sent_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (schedule_id, period_key)
);
CREATE INDEX IF NOT EXISTS idx_report_deliveries_schedule ON report_deliveries(schedule_id, created_at DESC);
ALTER TABLE report_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_deliveries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS report_deliveries_tenant_isolation_policy ON report_deliveries;
CREATE POLICY report_deliveries_tenant_isolation_policy ON report_deliveries
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- REP-712 (#169): araç bazlı tüketim raporunun (REP-703 çatısı SQL-tanımlı)
-- FLEET-1405 motorunu (tenantDb.ts computeVehicleConsumptionWindow, JS)
-- SQL'de yeniden ifade eden iki YARDIMCI fonksiyon. Çift kaynak riskine karşı
-- test_rep712_vehicle_consumption.ts, rapor satırlarını JS motorunun
-- (getFleetConsumptionReport) çıktısıyla karşılaştırır (parite testi).
-- İkisi de SECURITY INVOKER (varsayılan) — çağıran app_user'ın RLS'i içeride
-- de geçerli, tenant sızıntısı yok.

-- fleet/meterValidation.ts resolveMeterType ile AYNI kural (açık değer > araç tipi regex'i > KM).
CREATE OR REPLACE FUNCTION resolve_vehicle_meter_type(p_vehicle_type TEXT, p_explicit TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_explicit IN ('KM', 'MOTOR_SAAT') THEN p_explicit
    WHEN lower(coalesce(p_vehicle_type, '')) ~ 'ekskavat|dozer|loader|y[üu]kleyici|greyder|silindir|vin[çc]|forklift|i[şs]\s*makine|kep[çc]e|beko|kompres[öo]r|jenerat[öo]r' THEN 'MOTOR_SAAT'
    ELSE 'KM'
  END
$$;

-- Bir araç için [p_start, p_end) penceresinde sayaç açılış/kapanış + yakıt.
-- Açılış: pencereden ÖNCEKİ en son okuma; kapanış: pencere içindeki en son
-- GİRİLEN (created_at) okuma. Eksik → EKSIK_VERI; kullanım (2 haneye
-- yuvarlanmış) <= 0 → GECERSIZ_VERI (Kritik Not: tahmin/0 üretilmez).
-- fuel_liters/total_cost sayaç verisinden BAĞIMSIZ, gerçek ikmal toplamıdır.
CREATE OR REPLACE FUNCTION vehicle_consumption_window(
  p_vehicle_id VARCHAR, p_plate VARCHAR, p_meter_type TEXT, p_start TIMESTAMPTZ, p_end TIMESTAMPTZ
) RETURNS TABLE (usage_amount NUMERIC, fuel_liters NUMERIC, total_cost NUMERIC, data_status TEXT)
LANGUAGE sql STABLE AS $$
  WITH o AS (
    SELECT reading_value FROM vehicle_meter_readings
     WHERE vehicle_id = p_vehicle_id AND meter_type = p_meter_type AND reading_at < p_start
     ORDER BY reading_at DESC, created_at DESC LIMIT 1
  ), c AS (
    SELECT reading_value FROM vehicle_meter_readings
     WHERE vehicle_id = p_vehicle_id AND meter_type = p_meter_type AND reading_at >= p_start AND reading_at < p_end
     ORDER BY created_at DESC LIMIT 1
  ), f AS (
    SELECT COALESCE(SUM(amount_liters), 0) AS l, SUM(total_cost) AS cost FROM transactions
     WHERE vehicle_plate = p_plate AND created_at >= p_start AND created_at < p_end
  )
  SELECT
    CASE WHEN o.reading_value IS NOT NULL AND c.reading_value IS NOT NULL THEN round(c.reading_value - o.reading_value, 2) END,
    round(f.l, 2),
    f.cost,
    CASE
      WHEN o.reading_value IS NULL OR c.reading_value IS NULL THEN 'EKSIK_VERI'
      WHEN round(c.reading_value - o.reading_value, 2) <= 0 THEN 'GECERSIZ_VERI'
      ELSE 'HESAPLANDI'
    END
  FROM f LEFT JOIN o ON TRUE LEFT JOIN c ON TRUE
$$;

-- REP-715 (#172): reddedilen çapraz şantiye ikmal denemeleri. FUEL-402 bu
-- ret'leri yalnızca hata olarak fırlatıyordu (hiçbir yerde KALICI değildi) —
-- "kota aşım denemeleri ve reddedilen talepler" raporu için ayrı, append-only
-- bir iz. Yazım best-effort'tur (tenantDb.ts recordCrossSiteDenialFromError):
-- kayıt yazılamazsa ret davranışı DEĞİŞMEZ. Ret transaction'ı ROLLBACK
-- olduğundan kayıt AYRI bir transaction'da yazılır.
CREATE TABLE IF NOT EXISTS cross_site_denials (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    vehicle_plate VARCHAR(32) NOT NULL,
    home_site VARCHAR(128),
    target_site VARCHAR(128) NOT NULL,
    -- Manuel yolda istenen litre; cihaz yolunda (oturum açılışında miktar yok) NULL.
    requested_liters NUMERIC(10, 2),
    -- 'NO_SITE_PERMISSION' | 'QUOTA_EXHAUSTED'
    reason VARCHAR(32) NOT NULL,
    permission_id VARCHAR(64),
    allowed_liters NUMERIC(10, 2),
    used_liters NUMERIC(10, 2),
    -- 'DEVICE' (RFID/request-auth) | 'MANUEL' (POST /dispense)
    source VARCHAR(16) NOT NULL,
    occurred_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cross_site_denials_lookup ON cross_site_denials(tenant_id, occurred_at DESC);
ALTER TABLE cross_site_denials ENABLE ROW LEVEL SECURITY;
ALTER TABLE cross_site_denials FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cross_site_denials_tenant_isolation_policy ON cross_site_denials;
CREATE POLICY cross_site_denials_tenant_isolation_policy ON cross_site_denials
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true))
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
REVOKE UPDATE, DELETE, TRUNCATE ON cross_site_denials FROM app_user;
