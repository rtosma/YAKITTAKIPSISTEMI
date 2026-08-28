import { hashPassword } from '../utils/password';
import { execSync } from 'child_process';

async function seedDatabase() {
  console.log('🌱 POSTGRESQL SEEDING STARTING...\n');

  const passwordHash = await hashPassword('123456');
  console.log('Generated Argon2id Hash:', passwordHash);

  const seedSql = `
-- Insert Companies
INSERT INTO companies (id, name, tax_number) VALUES
('comp-camsa', 'ÇamSA Pelet & Enerji A.Ş.', '2381092831'),
('comp-kusak', 'Kuşak Beton & İnşaat Ltd.', '4820193841')
ON CONFLICT (id) DO NOTHING;

-- Clean existing users to refresh hashes
DELETE FROM users;

-- Insert Users with exact Argon2id Hashes
INSERT INTO users (id, tenant_id, username, password_hash, role, site_name) VALUES
('usr-camsa-owner', 'comp-camsa', 'camsa', '${passwordHash}', 'COMPANY_OWNER', NULL),
('usr-gebze-mgr', 'comp-camsa', 'gebze-santiye', '${passwordHash}', 'SITE_MANAGER', 'Gebze Ana Şantiye'),
('usr-orman-mgr', 'comp-camsa', 'orman-santiye', '${passwordHash}', 'SITE_MANAGER', 'Orman Şantiyesi'),
('usr-silivri-mgr', 'comp-camsa', 'silivri-santiye', '${passwordHash}', 'SITE_MANAGER', 'Silivri Tesisleri'),
('usr-kusak-owner', 'comp-kusak', 'kusak', '${passwordHash}', 'COMPANY_OWNER', NULL);

-- Insert Vehicles
INSERT INTO vehicles (id, tenant_id, plate, brand_model, vehicle_type, rfid_tag, status) VALUES
('veh-1', 'comp-camsa', '34 CTP 82', 'Volvo FMX 460 Damperli', 'Kamyon', 'TAG-882910', 'AKTİF'),
('veh-2', 'comp-camsa', '41 KCL 05', 'CAT 349D Paletli Ekskavatör', 'Ekskavatör', 'TAG-104921', 'AKTİF')
ON CONFLICT (id) DO NOTHING;

-- Insert Tanks
INSERT INTO tanks (id, tenant_id, name, capacity_liters, current_level_liters, fuel_type, status) VALUES
('tank-1', 'comp-camsa', 'Gebze Ana İkmal Tankı #1', 20000.00, 14830.00, 'Motorin', 'GÜVENLİ')
ON CONFLICT (id) DO NOTHING;
`;

  execSync(`docker exec -i yakittakip_postgres psql -U postgres -d yakittakip_db`, {
    input: seedSql
  });
  console.log('✅ Seed completed successfully with correct Argon2id hashes!');
}

seedDatabase().catch(err => {
  console.error('❌ Seed error:', err);
  process.exit(1);
});
