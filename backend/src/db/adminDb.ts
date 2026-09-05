import { pool } from './postgresPool';
import { hashPassword } from '../utils/password';
import { generateId } from '../utils/id';
import { encryptDeviceSecret } from '../utils/hardwareSecretCrypto';

/**
 * SUPER_ADMIN'e özel, tek bir tenant'a kısıtlı OLMAYAN sorgular. Diğer
 * tenantDb.ts fonksiyonlarının aksine burada `SET LOCAL ROLE app_user` /
 * RLS akışı YOKTUR — `companies` tablosunun kendisi zaten RLS'siz (tenant
 * kaydının kendisidir), diğer tablolarda ise `pool` doğrudan superuser
 * (postgres) olarak bağlandığından RLS'i bypass eder; bu dosyadaki her route
 * routes.ts içinde authorizeRoles('SUPER_ADMIN') ile kilitlenmelidir.
 */

export interface AdminCompanySite {
  id: string;
  name: string;
  location: string;
  activeVehiclesCount: number;
  activeTanksCount: number;
}

export interface AdminCompanyProfile {
  id: string;
  name: string;
  code: string | null;
  taxNumber: string;
  city: string | null;
  licenseStatus: string;
  licenseExpiry: string | null;
  modules: Record<string, boolean>;
  sites: AdminCompanySite[];
  activeVehiclesCount: number;
  totalFuelThisMonth: number;
}

const DEFAULT_MODULES = {
  aiAnomaly: true,
  eInvoice: true,
  smartWarehouse: true,
  maintenanceTrack: true,
  driverScore: true,
  crossSiteAuth: true
};

function slugifyCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 32) || 'firma';
}

async function buildAdminCompanyProfile(c: any): Promise<AdminCompanyProfile> {
  // Bu 3 sorgu birbirinden bağımsız (hepsi yalnızca c.id ile filtreleniyor) —
  // sırayla await etmek yerine birlikte çalıştırılır. pool.query() her
  // çağrıda kendi bağlantısını aldığından (tek bir client üzerinde değil) bu
  // gerçekten paralel çalışır.
  const [sitesRes, vehRes, fuelRes] = await Promise.all([
    pool.query(
      `SELECT s.id, s.name, s.location,
         (SELECT COUNT(*)::int FROM tanks t    WHERE t.tenant_id = $1 AND t.site_name = s.name) AS active_tanks_count,
         (SELECT COUNT(*)::int FROM vehicles v WHERE v.tenant_id = $1 AND v.site_name = s.name) AS active_vehicles_count
       FROM sites s WHERE s.tenant_id = $1 ORDER BY s.name ASC`,
      [c.id]
    ),
    pool.query('SELECT COUNT(*)::int AS cnt FROM vehicles WHERE tenant_id = $1', [c.id]),
    pool.query(
      `SELECT COALESCE(SUM(amount_liters), 0)::numeric AS total FROM transactions
       WHERE tenant_id = $1 AND created_at >= date_trunc('month', CURRENT_TIMESTAMP)`,
      [c.id]
    )
  ]);

  return {
    id: c.id,
    name: c.name,
    code: c.code,
    taxNumber: c.tax_number,
    city: c.city,
    licenseStatus: c.license_status || 'AKTİF',
    licenseExpiry: c.license_expiry ? new Date(c.license_expiry).toISOString().slice(0, 10) : null,
    modules: c.modules || {},
    sites: sitesRes.rows.map((s) => ({
      id: s.id,
      name: s.name,
      location: s.location,
      activeTanksCount: s.active_tanks_count,
      activeVehiclesCount: s.active_vehicles_count
    })),
    activeVehiclesCount: vehRes.rows[0].cnt,
    totalFuelThisMonth: Number(fuelRes.rows[0].total)
  };
}

export async function getAllCompanies(): Promise<AdminCompanyProfile[]> {
  const companiesRes = await pool.query(
    `SELECT id, name, tax_number, code, city, license_status, license_expiry, modules FROM companies ORDER BY name ASC`
  );

  // Şirketler arası da bağımsız — hepsini birlikte kur (sırayla N tur yerine).
  return Promise.all(companiesRes.rows.map(buildAdminCompanyProfile));
}

/**
 * Yeni bir kiracı (tenant) firma oluşturur: şirket kaydı + ilk şantiye +
 * COMPANY_OWNER giriş hesabı (demo/dev sistemine uygun olarak diğer seed
 * hesaplarla aynı '123456' şifresiyle — gerçek bir üretim ortamında bunun
 * yerine bir davet/e-posta akışı olmalıdır).
 */
export async function createCompanyWithOwner(data: {
  name: string;
  city?: string;
  taxNumber?: string;
}): Promise<AdminCompanyProfile> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const countRes = await client.query('SELECT COUNT(*)::int AS cnt FROM companies');
    const code = 'COMP-' + (countRes.rows[0].cnt + 1).toString().padStart(2, '0');
    const companyId = generateId('comp');
    const taxNumber = data.taxNumber?.trim() || '0000000000';
    const city = data.city?.trim() || 'İstanbul';

    await client.query(
      `INSERT INTO companies (id, name, tax_number, code, city, license_status, license_expiry, modules)
       VALUES ($1, $2, $3, $4, $5, 'AKTİF', $6, $7::jsonb)`,
      [companyId, data.name.trim(), taxNumber, code, city, '2027-12-31', JSON.stringify(DEFAULT_MODULES)]
    );

    const siteId = generateId('site');
    const siteName = `${data.name.trim()} Ana Şantiye`;
    await client.query(
      `INSERT INTO sites (id, tenant_id, name, location) VALUES ($1, $2, $3, $4)`,
      [siteId, companyId, siteName, city]
    );

    const usernameBase = slugifyCompanyName(data.name);
    let username = usernameBase;
    let suffix = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const existing = await client.query('SELECT 1 FROM users WHERE username = $1', [username]);
      if (existing.rows.length === 0) break;
      username = `${usernameBase}${suffix++}`;
    }

    const passwordHash = await hashPassword('123456');
    await client.query(
      `INSERT INTO users (id, tenant_id, username, password_hash, role, site_name)
       VALUES ($1, $2, $3, $4, 'COMPANY_OWNER', NULL)`,
      [generateId('usr'), companyId, username, passwordHash]
    );

    await client.query('COMMIT');

    return {
      id: companyId,
      name: data.name.trim(),
      code,
      taxNumber,
      city,
      licenseStatus: 'AKTİF',
      licenseExpiry: '2027-12-31',
      modules: DEFAULT_MODULES,
      sites: [{ id: siteId, name: siteName, location: city, activeTanksCount: 0, activeVehiclesCount: 0 }],
      activeVehiclesCount: 0,
      totalFuelThisMonth: 0
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function updateCompanyAdmin(
  id: string,
  data: { licenseStatus?: string; modules?: Partial<Record<string, boolean>> }
): Promise<AdminCompanyProfile> {
  const current = await pool.query('SELECT modules FROM companies WHERE id = $1', [id]);
  if (current.rows.length === 0) throw new Error('Firma bulunamadı.');

  const mergedModules = data.modules
    ? { ...(current.rows[0].modules || {}), ...data.modules }
    : undefined;

  const fields: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (data.licenseStatus) {
    fields.push(`license_status = $${idx++}`);
    values.push(data.licenseStatus);
  }
  if (mergedModules) {
    fields.push(`modules = $${idx++}::jsonb`);
    values.push(JSON.stringify(mergedModules));
  }

  if (fields.length === 0) throw new Error('Güncellenecek alan bulunamadı.');

  values.push(id);
  await pool.query(`UPDATE companies SET ${fields.join(', ')} WHERE id = $${idx}`, values);

  const all = await getAllCompanies();
  const updated = all.find((c) => c.id === id);
  if (!updated) throw new Error('Firma bulunamadı.');
  return updated;
}

// ============================================================================
// AUTH-202.3 — Cihaz Kaydı Arama (Pre-Tenant-Context)
// ============================================================================

export interface HardwareDeviceRecord {
  id: string;
  tenant_id: string;
  device_id: string;
  name: string;
  site_name: string;
  encrypted_secret: string;
  encrypted_secret_previous: string | null;
  previous_secret_expires_at: string | null;
  secret_rotated_at: string | null;
  status: string;
}

/**
 * hardwareAuthMiddleware.ts'in TEK giriş noktası: bir HMAC isteği geldiğinde
 * hangi tenant'a ait olduğu HENÜZ bilinmiyor (login öncesi kullanıcı aramayla
 * aynı durum) — bu yüzden burada, withTenant() DIŞINDA, ham pool.query ile
 * device_id'den tüm kaydı (tenant_id dahil) bulunur. Bundan sonraki HER işlem
 * (provisioning/rotasyon/bloke etme) tenantDb.ts üzerinden, JWT ile kurulan
 * gerçek tenant context'iyle RLS'e tabi olarak yapılır.
 */
export async function getHardwareDeviceByDeviceId(deviceId: string): Promise<HardwareDeviceRecord | null> {
  const result = await pool.query('SELECT * FROM hardware_devices WHERE device_id = $1', [deviceId]);
  return result.rows[0] ?? null;
}

export interface AdminHardwareDeviceSummary {
  device_id: string;
  tenant_id: string;
  name: string;
  site_name: string;
  status: string;
}

/**
 * SUPER_ADMIN'e özel, TÜM tenant'lardaki cihazların (secret hariç) listesi
 * — GET /devices route'unda kullanılır. index.ts'teki FUEL-401.3 heartbeat
 * zaman aşımı süpürücüsü de kontrol edilecek cihaz listesini buradan alır
 * (tenant bazlı filtrelemeye gerek yok, sistem geneli bir bakım işi).
 */
export async function getAllHardwareDevices(): Promise<AdminHardwareDeviceSummary[]> {
  const result = await pool.query('SELECT device_id, tenant_id, name, site_name, status FROM hardware_devices ORDER BY created_at DESC');
  return result.rows;
}

// AUTH-202.3 öncesi (AUTH-202.1/OPS-1105), 3 demo cihazının sırları
// hardwareAuthMiddleware.ts'te REGISTERED_HARDWARE_DEVICES adlı statik bir
// nesnede, HW_SECRET_ESP32_* ortam değişkenlerinden okunuyordu. Bu fonksiyon
// sunucu ilk açıldığında (bkz. index.ts) o 3 cihazı, AYNI env değişken
// değerleriyle (geriye dönük uyumluluk — sahadaki cihazlar hâlâ bu sırları
// kullanıyor) yeni hardware_devices tablosuna BİR KEZ taşır. ON CONFLICT
// DO NOTHING sayesinde zaten rotasyona uğramış bir cihazın secret'ını
// asla ÜZERİNE YAZMAZ — yalnızca tablo hiç yoksa (ilk açılış) devreye girer.
// Değerler değil, ortam değişkeni İSİMLERİ — gitleaks bunları yüksek entropili
// dizgeler olarak yanlışlıkla işaretliyor (env.ts'teki aynı desenle tutarlı).
const LEGACY_DEVICES: Array<{ deviceId: string; name: string; siteName: string; secretEnvVar: string }> = [
  { deviceId: 'ESP32-PUMP-01', name: 'Gebze Pompa Otomasyonu #1', siteName: 'Gebze Ana Şantiye', secretEnvVar: 'HW_SECRET_ESP32_PUMP_01' }, // gitleaks:allow
  { deviceId: 'ESP32-TANK-01', name: 'Gebze Ultrasonik Tank Probu #1', siteName: 'Gebze Ana Şantiye', secretEnvVar: 'HW_SECRET_ESP32_TANK_01' }, // gitleaks:allow
  { deviceId: 'ESP32-FLOW-ISR', name: 'Debimetre Kesme Sensörü', siteName: 'Sistem Kalibrasyonu', secretEnvVar: 'HW_SECRET_ESP32_FLOW_ISR' } // gitleaks:allow
];
const LEGACY_DEVICE_TENANT_ID = 'comp-camsa';

export async function seedLegacyHardwareDevicesIfMissing(secretsByEnvVar: Record<string, string>): Promise<void> {
  for (const device of LEGACY_DEVICES) {
    const secret = secretsByEnvVar[device.secretEnvVar];
    if (!secret) continue;
    await pool.query(
      `INSERT INTO hardware_devices (id, tenant_id, device_id, name, site_name, encrypted_secret)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (device_id) DO NOTHING`,
      [generateId('hwdev'), LEGACY_DEVICE_TENANT_ID, device.deviceId, device.name, device.siteName, encryptDeviceSecret(secret)]
    );
  }
}
