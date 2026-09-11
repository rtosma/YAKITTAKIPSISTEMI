import { pool } from './postgresPool';
import { hashPassword } from '../utils/password';
import { generateId } from '../utils/id';
import { encryptDeviceSecret, generateDeviceSecret } from '../utils/hardwareSecretCrypto';
import { ForbiddenError, ConflictError } from '../utils/errors';

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
  package: PackageTier;
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

// ============================================================================
// BILL-1701 — Firma Paketleri ve Lisans Modeli
// ============================================================================
//
// `companies.modules` (yukarıdaki DEFAULT_MODULES) TEK doğruluk kaynağıdır —
// hangi özelliğin gerçekten etkin olduğunu belirleyen odur (bkz.
// tenantDb.ts isTenantModuleEnabled). `package` yalnızca adlandırılmış bir
// ETİKET + admin bir firmanın paketini DEĞİŞTİRDİĞİNDE `modules`'a
// uygulanacak VARSAYILAN demet — paket seçmek modülleri sıfırlar, ama admin
// aynı istekte açık `modules` de gönderirse o üzerine biner (bkz.
// updateCompanyAdmin).
export type PackageTier = 'TEMEL' | 'PROFESYONEL' | 'KURUMSAL';

export const PACKAGE_TIERS: PackageTier[] = ['TEMEL', 'PROFESYONEL', 'KURUMSAL'];

export const PACKAGE_MODULE_DEFAULTS: Record<PackageTier, Record<string, boolean>> = {
  TEMEL: {
    aiAnomaly: false,
    eInvoice: false,
    smartWarehouse: false,
    maintenanceTrack: false,
    driverScore: true,
    crossSiteAuth: false
  },
  PROFESYONEL: {
    aiAnomaly: true,
    eInvoice: true,
    smartWarehouse: false,
    maintenanceTrack: true,
    driverScore: true,
    crossSiteAuth: true
  },
  KURUMSAL: DEFAULT_MODULES
};

function isPackageTier(value: unknown): value is PackageTier {
  return typeof value === 'string' && (PACKAGE_TIERS as string[]).includes(value);
}

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
    package: isPackageTier(c.package) ? c.package : 'TEMEL',
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
    `SELECT id, name, tax_number, code, city, license_status, license_expiry, modules, package FROM companies ORDER BY name ASC`
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
  package?: PackageTier;
}): Promise<AdminCompanyProfile> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const countRes = await client.query('SELECT COUNT(*)::int AS cnt FROM companies');
    const code = 'COMP-' + (countRes.rows[0].cnt + 1).toString().padStart(2, '0');
    const companyId = generateId('comp');
    const taxNumber = data.taxNumber?.trim() || '0000000000';
    const city = data.city?.trim() || 'İstanbul';
    const packageTier: PackageTier = isPackageTier(data.package) ? data.package : 'TEMEL';
    const initialModules = PACKAGE_MODULE_DEFAULTS[packageTier];

    await client.query(
      `INSERT INTO companies (id, name, tax_number, code, city, license_status, license_expiry, modules, package)
       VALUES ($1, $2, $3, $4, $5, 'AKTİF', $6, $7::jsonb, $8)`,
      [companyId, data.name.trim(), taxNumber, code, city, '2027-12-31', JSON.stringify(initialModules), packageTier]
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
      modules: initialModules,
      package: packageTier,
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
  data: {
    licenseStatus?: string;
    licenseExpiry?: string | null;
    package?: PackageTier;
    modules?: Partial<Record<string, boolean>>;
  }
): Promise<AdminCompanyProfile> {
  const current = await pool.query('SELECT modules FROM companies WHERE id = $1', [id]);
  if (current.rows.length === 0) throw new Error('Firma bulunamadı.');

  // BILL-1701: paket değişimi `modules`'u o paketin VARSAYILAN demedine
  // sıfırlar — admin aynı istekte açık `modules` de göndermişse (ör. paketi
  // değiştirirken tek bir özelliği manuel açık bırakmak), o üzerine biner.
  const baseModules = isPackageTier(data.package)
    ? PACKAGE_MODULE_DEFAULTS[data.package]
    : current.rows[0].modules || {};
  const mergedModules = data.package || data.modules ? { ...baseModules, ...(data.modules || {}) } : undefined;

  const fields: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (data.licenseStatus) {
    fields.push(`license_status = $${idx++}`);
    values.push(data.licenseStatus);
  }
  if (data.licenseExpiry !== undefined) {
    fields.push(`license_expiry = $${idx++}`);
    values.push(data.licenseExpiry);
  }
  if (isPackageTier(data.package)) {
    fields.push(`package = $${idx++}`);
    values.push(data.package);
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
// BILL-1701 — Lisans Uygulama (authMiddleware.ts'ten her istekte çağrılır)
// ============================================================================

export interface CompanyLicenseSnapshot {
  licenseStatus: string;
  licenseExpiry: string | null;
}

/**
 * authMiddleware.ts'in lisans kapısı için hafif, tek-satırlık sorgu —
 * getAllCompanies()/buildAdminCompanyProfile() gibi şantiye/araç/ciro
 * join'lerini YAPMAZ (her istekte çalışacağı için önemli). `companies`
 * tablosunun kendisi RLS'siz olduğundan (bu dosyanın başındaki not) doğrudan
 * `pool.query` güvenli.
 */
export async function getCompanyLicenseSnapshot(companyId: string): Promise<CompanyLicenseSnapshot | null> {
  const result = await pool.query('SELECT license_status, license_expiry FROM companies WHERE id = $1', [companyId]);
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    licenseStatus: row.license_status || 'AKTİF',
    licenseExpiry: row.license_expiry ? new Date(row.license_expiry).toISOString().slice(0, 10) : null
  };
}

// ============================================================================
// BILL-1702 — Şantiye/Cihaz/Kullanıcı Sayacı, Paket Limitleri, Lisans Süresi Uyarıları
// ============================================================================

export interface PackageLimits {
  maxSites: number | null; // null = sınırsız (KURUMSAL)
  maxDevices: number | null;
  maxUsers: number | null;
}

export const PACKAGE_LIMITS: Record<PackageTier, PackageLimits> = {
  TEMEL: { maxSites: 1, maxDevices: 5, maxUsers: 5 },
  PROFESYONEL: { maxSites: 5, maxDevices: 30, maxUsers: 25 },
  KURUMSAL: { maxSites: null, maxDevices: null, maxUsers: null }
};

export interface PackageUsage {
  package: PackageTier;
  limits: PackageLimits;
  siteCount: number;
  deviceCount: number;
  userCount: number;
}

/**
 * Bir firmanın şantiye/cihaz/kullanıcı SAYIMI + paketinin limitleri.
 * `sites`/`hardware_devices`/`users` RLS'li tablolardır ama bu dosyadaki
 * her fonksiyon gibi doğrudan `pool` (superuser) ile sorgulanır — dosyanın
 * başındaki nottaki gerekçeyle AYNI (yalnızca SUPER_ADMIN'e özel yollardan
 * çağrılır, routes.ts'te authorizeRoles('SUPER_ADMIN') ile kilitli).
 */
export async function getCompanyPackageUsage(companyId: string): Promise<PackageUsage | null> {
  const companyRes = await pool.query('SELECT package FROM companies WHERE id = $1', [companyId]);
  if (companyRes.rows.length === 0) return null;
  const packageTier: PackageTier = isPackageTier(companyRes.rows[0].package) ? companyRes.rows[0].package : 'TEMEL';

  const [sitesRes, devicesRes, usersRes] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS cnt FROM sites WHERE tenant_id = $1', [companyId]),
    pool.query('SELECT COUNT(*)::int AS cnt FROM hardware_devices WHERE tenant_id = $1', [companyId]),
    pool.query('SELECT COUNT(*)::int AS cnt FROM users WHERE tenant_id = $1', [companyId])
  ]);

  return {
    package: packageTier,
    limits: PACKAGE_LIMITS[packageTier],
    siteCount: sitesRes.rows[0].cnt,
    deviceCount: devicesRes.rows[0].cnt,
    userCount: usersRes.rows[0].cnt
  };
}

export type PackageLimitResource = 'sites' | 'devices' | 'users';

/**
 * routes.ts'teki oluşturma uçlarının (POST /sites, POST /devices, ...)
 * yeni kaydı REDDETMESİ gerekip gerekmediğini söyler — sınırsız (KURUMSAL,
 * limit=null) paketlerde her zaman `reached:false` döner.
 */
export async function isPackageLimitReached(
  companyId: string,
  resource: PackageLimitResource
): Promise<{ reached: boolean; limit: number | null; current: number }> {
  const usage = await getCompanyPackageUsage(companyId);
  if (!usage) return { reached: false, limit: null, current: 0 };

  const limit =
    resource === 'sites' ? usage.limits.maxSites : resource === 'devices' ? usage.limits.maxDevices : usage.limits.maxUsers;
  const current = resource === 'sites' ? usage.siteCount : resource === 'devices' ? usage.deviceCount : usage.userCount;

  return { reached: limit !== null && current >= limit, limit, current };
}

export interface ExpiringCompany {
  id: string;
  name: string;
  licenseExpiry: string;
  daysRemaining: number;
}

/**
 * BILL-1702 AC: "süre bitimine 30/15/7 gün kala uyarı." ASKIDA (zaten admin
 * tarafından askıya alınmış) firmalar hariç tutulur — onlar için zaten
 * authMiddleware.ts'in sert kapısı devrede, ayrıca bir "yakında dolacak"
 * uyarısı anlamsız. Süresi ZATEN geçmiş olanlar da hariç (o, bir "uyarı"
 * değil authMiddleware.ts'in salt-okunur kısıtlamasının konusu).
 */
export async function getCompaniesNearingExpiry(warningWindowDays = 30): Promise<ExpiringCompany[]> {
  const result = await pool.query(
    `SELECT id, name, license_expiry,
       (license_expiry - CURRENT_DATE)::int AS days_remaining
     FROM companies
     WHERE license_status = 'AKTİF'
       AND license_expiry IS NOT NULL
       AND license_expiry >= CURRENT_DATE
       AND license_expiry <= CURRENT_DATE + $1::int
     ORDER BY license_expiry ASC`,
    [warningWindowDays]
  );
  return result.rows.map((r) => ({
    id: r.id,
    name: r.name,
    licenseExpiry: new Date(r.license_expiry).toISOString().slice(0, 10),
    daysRemaining: r.days_remaining
  }));
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
  serial_number: string | null;
  mac_address: string | null;
  model: string | null;
  hardware_revision: string | null;
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

// ── AUTH-206: parola sıfırlama (pre-auth, tenant context YOK) ─────────────
// getHardwareDeviceByDeviceId / login akışıyla AYNI gerekçe: token/istek
// henüz hangi tenant'a ait belli değil, bu yüzden withTenant() DIŞINDA ham
// pool.query. Bu iki fonksiyon yalnızca passwordResetService.ts'ten çağrılır.

export interface AuthUserLite {
  id: string;
  tenant_id: string;
  username: string;
}

export async function findUserForPasswordReset(username: string): Promise<AuthUserLite | null> {
  const result = await pool.query(
    'SELECT id, tenant_id, username FROM users WHERE LOWER(username) = LOWER($1)',
    [username]
  );
  return result.rows[0] ?? null;
}

/**
 * Parola sıfırlama tamamlandığında hash'i günceller VE geçici-parola
 * bayraklarını temizler (bir sıfırlama, kalıcı ve bilinçli bir parola
 * belirlemedir — must_change_password akışını bitirir).
 */
export async function updateUserPasswordHash(userId: string, passwordHash: string): Promise<void> {
  await pool.query(
    `UPDATE users
       SET password_hash = $2, must_change_password = FALSE, temp_password_expires_at = NULL
     WHERE id = $1`,
    [userId, passwordHash]
  );
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

/**
 * AI-502 — index.ts'teki haftalık tüketim anomali süpürücüsünün, hangi
 * tenant'lar için analiz üreteceğini bulmak için kullandığı sistem geneli
 * sorgu (yukarıdaki getAllHardwareDevices ile AYNI gerekçe: bir bakım işi,
 * tek bir tenant context'ine kısıtlı değil). `modules->>'aiAnomaly'` NULL
 * (hiç ayarlanmamış) VEYA 'true' ise dahil edilir — yalnızca AÇIKÇA
 * 'false' yapılmış tenant'lar hariç tutulur (bkz. tenantDb.ts
 * isTenantModuleEnabled'daki AYNI varsayılan-açık mantığı).
 */
export async function getAllTenantIdsWithAiAnomalyEnabled(): Promise<string[]> {
  const result = await pool.query(
    `SELECT id FROM companies WHERE (modules->>'aiAnomaly') IS DISTINCT FROM 'false'`
  );
  return result.rows.map((r) => r.id);
}

/**
 * FUEL-402.1 — kota dönem sıfırlama sweep'i (index.ts) hangi tenant'lar için
 * çalışacağını buradan alır. getAllHardwareDevices ile AYNI gerekçe: sistem
 * geneli bir bakım işi, tek tenant context'ine kısıtlı değil.
 */
export async function getAllTenantIds(): Promise<string[]> {
  const result = await pool.query('SELECT id FROM companies');
  return result.rows.map((r) => r.id);
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

// ============================================================================
// IOT-304 — Cihaz Claim (Eşleştirme) Redemption (Pre-Tenant-Context)
// ============================================================================

/**
 * Bir claim kodunu tüketip YENİ bir cihaz kaydı oluşturur. Cihazın/teknisyenin
 * çağırdığı bu uç HENÜZ hiçbir kimlik doğrulaması (JWT/HMAC) taşımaz — cihazın
 * henüz bir secret'ı YOK, tam olarak bunu üretmek için var. Bu yüzden
 * getHardwareDeviceByDeviceId ile aynı gerekçeyle burada, withTenant()
 * DIŞINDA, ham bir Postgres transaction'ı kullanılır.
 *
 * `SELECT ... FOR UPDATE` ile kod satırı kilitlenir: aynı kodla eşzamanlı iki
 * redemption denemesi (örn. bir teknisyenin isteği zaman aşımına uğrayıp
 * tekrar denemesi) İKİSİNİN DE "hâlâ BEKLIYOR" görüp iki cihaz yaratmasını
 * önler — biri kazanır, diğeri CLAIM_CODE_ALREADY_USED alır.
 */
export async function redeemDeviceClaimCode(input: {
  code: string;
  deviceId: string;
  serialNumber?: string;
  macAddress?: string;
  model?: string;
  hardwareRevision?: string;
}): Promise<{ device: HardwareDeviceRecord; secret: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const claimRes = await client.query('SELECT * FROM device_claim_codes WHERE code = $1 FOR UPDATE', [input.code]);
    if (claimRes.rows.length === 0) {
      throw new ForbiddenError('Geçersiz claim kodu.', { error: 'CLAIM_CODE_INVALID' });
    }
    const claim = claimRes.rows[0];
    if (claim.status !== 'BEKLIYOR') {
      throw new ConflictError('Bu claim kodu daha önce kullanılmış.', { error: 'CLAIM_CODE_ALREADY_USED' });
    }
    if (new Date(claim.expires_at).getTime() < Date.now()) {
      throw new ForbiddenError('Claim kodunun süresi dolmuş.', { error: 'CLAIM_CODE_EXPIRED' });
    }

    const existingDevice = await client.query('SELECT 1 FROM hardware_devices WHERE device_id = $1', [input.deviceId]);
    if (existingDevice.rows.length > 0) {
      throw new ConflictError(`'${input.deviceId}' kimlikli bir cihaz zaten kayıtlı.`, { error: 'DEVICE_ID_TAKEN' });
    }

    const id = generateId('hwdev');
    const secret = generateDeviceSecret();
    const deviceResult = await client.query(
      `INSERT INTO hardware_devices (id, tenant_id, device_id, name, site_name, encrypted_secret, serial_number, mac_address, model, hardware_revision)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        id, claim.tenant_id, input.deviceId, claim.device_name, claim.site_name, encryptDeviceSecret(secret),
        input.serialNumber ?? null, input.macAddress ?? null, input.model ?? null, input.hardwareRevision ?? null
      ]
    );

    await client.query(
      `UPDATE device_claim_codes SET status = 'KULLANILDI', redeemed_device_id = $1, redeemed_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [input.deviceId, claim.id]
    );

    await client.query('COMMIT');
    return { device: deviceResult.rows[0], secret };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

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

// ============================================================================
// FUEL-404.1 — Kalibrasyon Ack Zaman Aşımı Süpürücüsü (Tüm Tenant'lar)
// ============================================================================
// FUEL-401.3'ün heartbeat süpürücüsüyle AYNI gerekçe: bu periyodik bakım
// işi TEK bir tenant'a değil TÜM sistemedir (index.ts'teki interval'dan
// çağrılır) — bu yüzden withTenant() (RLS'i tek bir tenant'a kısıtlar)
// DEĞİL, adminDb.ts'in geri kalanıyla tutarlı ham pool.query kullanılıyor.
const CALIBRATION_ACK_TIMEOUT_MINUTES = 5;

export async function sweepTimedOutCalibrations(): Promise<Array<{ id: string; deviceId: string; tenantId: string }>> {
  const result = await pool.query(
    `UPDATE calibration_commands SET status = 'ZAMAN_ASIMI'
     WHERE status = 'BEKLIYOR' AND sent_at IS NOT NULL AND sent_at < NOW() - INTERVAL '${CALIBRATION_ACK_TIMEOUT_MINUTES} minutes'
     RETURNING id, device_id, tenant_id`
  );
  return result.rows.map((r) => ({ id: r.id, deviceId: r.device_id, tenantId: r.tenant_id }));
}

// ============================================================================
// AUTH-207: TOTP 2FA — user_totp erişimi + auth denetim kaydı
// ============================================================================
// Login/2FA akışı henüz bir tenant context'i (RLS) kurmadan çalışır — bu
// yüzden findUserForPasswordReset ile AYNI gerekçeyle ham pool.query
// (adminDb.ts zaten check-no-raw-pool-query allowlist'inde).

export interface UserAuthRow {
  id: string;
  tenant_id: string;
  username: string;
  role: string;
}

export async function getUserAuthById(userId: string): Promise<UserAuthRow | null> {
  const r = await pool.query('SELECT id, tenant_id, username, role FROM users WHERE id = $1', [userId]);
  return r.rows[0] ?? null;
}

export interface UserTotpRow {
  user_id: string;
  tenant_id: string;
  secret_base32: string;
  enabled: boolean;
  enabled_at: string | null;
  recovery_code_hashes: string[];
  recovery_codes_total: number;
  last_used_at: string | null;
}

export async function getUserTotp(userId: string): Promise<UserTotpRow | null> {
  const r = await pool.query('SELECT * FROM user_totp WHERE user_id = $1', [userId]);
  return r.rows[0] ?? null;
}

/** Kurulum: sırrı + kurtarma kodu hash'lerini yazar (enabled=FALSE). */
export async function saveUserTotpSecret(
  userId: string,
  tenantId: string,
  secretBase32: string,
  recoveryCodeHashes: string[]
): Promise<void> {
  await pool.query(
    `INSERT INTO user_totp (user_id, tenant_id, secret_base32, enabled, recovery_code_hashes, recovery_codes_total, updated_at)
     VALUES ($1, $2, $3, FALSE, $4, $5, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id) DO UPDATE SET
       secret_base32 = EXCLUDED.secret_base32,
       enabled = FALSE,
       enabled_at = NULL,
       recovery_code_hashes = EXCLUDED.recovery_code_hashes,
       recovery_codes_total = EXCLUDED.recovery_codes_total,
       last_used_at = NULL,
       updated_at = CURRENT_TIMESTAMP`,
    [userId, tenantId, secretBase32, recoveryCodeHashes, recoveryCodeHashes.length]
  );
}

export async function enableUserTotp(userId: string): Promise<void> {
  await pool.query(
    `UPDATE user_totp SET enabled = TRUE, enabled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE user_id = $1`,
    [userId]
  );
}

export async function deleteUserTotp(userId: string): Promise<boolean> {
  const r = await pool.query('DELETE FROM user_totp WHERE user_id = $1', [userId]);
  return (r.rowCount ?? 0) > 0;
}

/** Kalan kurtarma kodu hash listesini değiştirir (bir kod tüketilince). */
export async function setTotpRecoveryHashes(userId: string, hashes: string[]): Promise<void> {
  await pool.query(
    `UPDATE user_totp SET recovery_code_hashes = $2, last_used_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE user_id = $1`,
    [userId, hashes]
  );
}

export async function touchTotpLastUsed(userId: string): Promise<void> {
  await pool.query('UPDATE user_totp SET last_used_at = CURRENT_TIMESTAMP WHERE user_id = $1', [userId]);
}

/**
 * AUTH-207 AC: "2FA etkinleştirme/devre dışı bırakma audit log'a
 * yazılmalıdır." Login/2FA akışı tenant context'i kurmadığı için writeAuditLog
 * (getTenantStore'a bağımlı) kullanılamaz — doğrudan, açık tenant_id ile.
 */
export async function insertAuthAuditLog(
  tenantId: string,
  actorUserId: string | null,
  action: string,
  targetId: string,
  detail: Record<string, unknown>
): Promise<void> {
  await pool.query(
    `INSERT INTO audit_logs (id, tenant_id, user_id, action, target_type, target_id, after_value)
     VALUES ($1, $2, $3, $4, 'user_totp', $5, $6)`,
    [generateId('audit'), tenantId, actorUserId, action, targetId, JSON.stringify(detail)]
  );
}
