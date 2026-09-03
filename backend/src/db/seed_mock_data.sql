-- ==============================================================================
-- Seed: frontend/src/mock/index.ts içindeki mock verinin PostgreSQL'e aktarımı
-- (companies, sites, vehicles, drivers, tanks)
-- ==============================================================================

-- 1. Companies (Firmalar)
INSERT INTO companies (id, name, tax_number, code, city, license_status, license_expiry, modules) VALUES
('comp-camsa',   'ÇamSA Pelet & Enerji A.Ş.',      '2381092831', 'CAMSA-01', 'Kocaeli / Gebze',    'AKTİF', '2027-12-31', '{"aiAnomaly":true,"eInvoice":true,"smartWarehouse":true,"maintenanceTrack":true,"driverScore":true,"crossSiteAuth":true}'),
('comp-kusak',   'Kuşak Beton & İnşaat Ltd.',       '4820193841', 'KUSAK-02', 'İstanbul / Maltepe', 'AKTİF', '2026-11-15', '{"aiAnomaly":true,"eInvoice":false,"smartWarehouse":true,"maintenanceTrack":false,"driverScore":true,"crossSiteAuth":false}'),
('comp-avrasya', 'Avrasya Altyapı & Mermer A.Ş.',   '9182301928', 'AVR-03',   'Bursa / İnegöl',     'AKTİF', '2027-06-30', '{"aiAnomaly":false,"eInvoice":true,"smartWarehouse":false,"maintenanceTrack":true,"driverScore":false,"crossSiteAuth":true}')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  tax_number = EXCLUDED.tax_number,
  code = EXCLUDED.code,
  city = EXCLUDED.city,
  license_status = EXCLUDED.license_status,
  license_expiry = EXCLUDED.license_expiry,
  modules = EXCLUDED.modules;

-- 2. Sites (Şantiyeler)
INSERT INTO sites (id, tenant_id, name, location) VALUES
('site-gebze',   'comp-camsa',   'Gebze Ana Şantiye',     'Gebze OIZ 4. Cadde'),
('site-orman',   'comp-camsa',   'Orman Şantiyesi',       'Karasu Orman Bölgesi'),
('site-silivri', 'comp-camsa',   'Silivri Tesisleri',     'Silivri Sanayi Bölgesi'),
('site-maltepe', 'comp-kusak',   'Maltepe Santral',       'Maltepe E5 Yanal'),
('site-pendik',  'comp-kusak',   'Pendik Taş Ocağı',      'Pendik Kurtköy'),
('site-inegol',  'comp-avrasya', 'İnegöl Mermer Ocağı',   'Oylat Yolu Mevkii')
ON CONFLICT (id) DO NOTHING;

-- 3. Vehicles (Araçlar) — mock veride yalnızca ÇamSA (comp-camsa) filosu tanımlı
INSERT INTO vehicles (id, tenant_id, plate, brand_model, vehicle_type, rfid_tag, site_name, status) VALUES
('veh-1', 'comp-camsa', '34 CTP 82', 'Volvo FMX 460 (Damperli)',        'Kamyon',        'TAG-882910', 'Gebze Ana Şantiye', 'AKTİF'),
('veh-2', 'comp-camsa', '34 BKT 19', 'CAT 349D Excavator',              'Ekskavatör',    'TAG-882911', 'Gebze Ana Şantiye', 'AKTİF'),
('veh-3', 'comp-camsa', '35 EGE 40', 'Komatsu D275A Dozer',             'Dozer',         'TAG-882912', 'Orman Şantiyesi',   'AKTİF'),
('veh-4', 'comp-camsa', '41 KCL 05', 'MAN TGS 33.420 Beton Mikseri',    'Beton Mikseri', 'TAG-882913', 'Silivri Tesisleri', 'AKTİF'),
('veh-5', 'comp-camsa', '34 SIL 99', 'Hitachi ZX350LC',                 'Ekskavatör',    'TAG-882914', 'Silivri Tesisleri', 'AKTİF'),
('veh-6', 'comp-camsa', '16 ORM 12', 'Ford Transit Saha Hizmet',        'Binek Hizmet',  'TAG-882915', 'Orman Şantiyesi',   'BAKIMDA')
ON CONFLICT (id) DO NOTHING;

-- 4. Drivers (Şoförler)
INSERT INTO drivers (id, tenant_id, name, tc_no, phone, license_type, rfid_card_id, site_name, status) VALUES
('drv-1', 'comp-camsa', 'Ahmet Yılmaz',   '10928374821', '0532 998 12 34', 'CE Sınıfı Ağır Vasıta',              'CARD-881201', 'Gebze Ana Şantiye', 'SAHADA'),
('drv-2', 'comp-camsa', 'Mehmet Demir',   '29810293841', '0533 112 33 44', 'G Sınıfı İş Makinesi (Ekskavatör)',  'CARD-881202', 'Gebze Ana Şantiye', 'SAHADA'),
('drv-3', 'comp-camsa', 'Hasan Kaya',     '30192837412', '0535 443 22 11', 'G Sınıfı İş Makinesi (Dozer)',       'CARD-881203', 'Orman Şantiyesi',   'SAHADA'),
('drv-4', 'comp-camsa', 'Ibrahim Çelik',  '49201928371', '0536 778 99 00', 'C Sınıfı Kamyon',                    'CARD-881204', 'Silivri Tesisleri', 'SAHADA'),
('drv-5', 'comp-camsa', 'Caner Şahin',    '58291029381', '0537 221 00 11', 'B Sınıfı Binek',                     'CARD-881205', 'Orman Şantiyesi',   'İZİNLİ')
ON CONFLICT (id) DO NOTHING;

-- 5. Tanks (Yakıt Tankları)
INSERT INTO tanks (id, tenant_id, name, capacity_liters, current_level_liters, fuel_type, site_name, status) VALUES
('tank-gebze-1',   'comp-camsa', 'Gebze Ana Tank (T-1)',     20000.00, 14830.00, 'Motorin (Euro Diesel)', 'Gebze Ana Şantiye', 'GÜVENLİ'),
('tank-gebze-2',   'comp-camsa', 'Gebze Yedek Depo (T-2)',   15000.00, 4800.00,  'Motorin (Euro Diesel)', 'Gebze Ana Şantiye', 'UYARI'),
('tank-orman-1',   'comp-camsa', 'Orman Depo Tankı (T-3)',   10000.00, 8200.00,  'Motorin (Euro Diesel)', 'Orman Şantiyesi',   'GÜVENLİ'),
('tank-silivri-1', 'comp-camsa', 'Silivri Tesis Tankı (T-4)',12000.00, 1900.00,  'Motorin (Euro Diesel)', 'Silivri Tesisleri', 'KRİTİK')
ON CONFLICT (id) DO NOTHING;

-- 6. Users (Giriş Hesapları) — mock veride her firma/şantiye için username/password
-- '123456' düz metin şifresinin Argon2id hash'i (backend/src/utils/password.ts ile üretildi).
-- DİKKAT: sadece demo/dev verisidir, üretimde asla aynı şifreyi paylaşan hesap yaratmayın.
INSERT INTO users (id, tenant_id, username, password_hash, role, site_name) VALUES
('usr-camsa-owner',   'comp-camsa',   'camsa',            '$argon2id$v=19$m=65536,p=1,t=3$08Vstd8iW8mXbMgeAz8jbA$zca8rRtma2jMjEfCh9tonOGuV3lnBq3DMN6bUHCw+BU', 'COMPANY_OWNER', NULL),
('usr-gebze-mgr',     'comp-camsa',   'gebze-santiye',    '$argon2id$v=19$m=65536,p=1,t=3$08Vstd8iW8mXbMgeAz8jbA$zca8rRtma2jMjEfCh9tonOGuV3lnBq3DMN6bUHCw+BU', 'SITE_MANAGER',  'Gebze Ana Şantiye'),
('usr-orman-mgr',     'comp-camsa',   'orman-santiye',    '$argon2id$v=19$m=65536,p=1,t=3$08Vstd8iW8mXbMgeAz8jbA$zca8rRtma2jMjEfCh9tonOGuV3lnBq3DMN6bUHCw+BU', 'SITE_MANAGER',  'Orman Şantiyesi'),
('usr-silivri-mgr',   'comp-camsa',   'silivri-santiye',  '$argon2id$v=19$m=65536,p=1,t=3$08Vstd8iW8mXbMgeAz8jbA$zca8rRtma2jMjEfCh9tonOGuV3lnBq3DMN6bUHCw+BU', 'SITE_MANAGER',  'Silivri Tesisleri'),
('usr-kusak-owner',   'comp-kusak',   'kusak',            '$argon2id$v=19$m=65536,p=1,t=3$08Vstd8iW8mXbMgeAz8jbA$zca8rRtma2jMjEfCh9tonOGuV3lnBq3DMN6bUHCw+BU', 'COMPANY_OWNER', NULL),
('usr-maltepe-mgr',   'comp-kusak',   'maltepe-santiye',  '$argon2id$v=19$m=65536,p=1,t=3$08Vstd8iW8mXbMgeAz8jbA$zca8rRtma2jMjEfCh9tonOGuV3lnBq3DMN6bUHCw+BU', 'SITE_MANAGER',  'Maltepe Santral'),
('usr-pendik-mgr',    'comp-kusak',   'pendik-santiye',   '$argon2id$v=19$m=65536,p=1,t=3$08Vstd8iW8mXbMgeAz8jbA$zca8rRtma2jMjEfCh9tonOGuV3lnBq3DMN6bUHCw+BU', 'SITE_MANAGER',  'Pendik Taş Ocağı'),
('usr-avrasya-owner', 'comp-avrasya', 'avrasya',          '$argon2id$v=19$m=65536,p=1,t=3$08Vstd8iW8mXbMgeAz8jbA$zca8rRtma2jMjEfCh9tonOGuV3lnBq3DMN6bUHCw+BU', 'COMPANY_OWNER', NULL),
('usr-inegol-mgr',    'comp-avrasya', 'inegol-santiye',   '$argon2id$v=19$m=65536,p=1,t=3$08Vstd8iW8mXbMgeAz8jbA$zca8rRtma2jMjEfCh9tonOGuV3lnBq3DMN6bUHCw+BU', 'SITE_MANAGER',  'İnegöl Mermer Ocağı')
ON CONFLICT (id) DO NOTHING;
