import crypto from 'crypto';
import { config } from '../config/env';
import { ForbiddenError, ConflictError, UnauthorizedError, NotFoundError } from '../utils/errors';
import { generateId } from '../utils/id';
import { hashPassword, verifyPassword } from '../utils/password';
import { generateReadableUsername, generateTempPassword } from '../utils/tempCredentials';
import { writeAuditLog } from '../utils/auditLog';
import { encryptDeviceSecret, generateDeviceSecret } from '../utils/hardwareSecretCrypto';
import { withTenant } from './withTenant';

/**
 * updateVehicle/updateTank (ve kısmen updateDriver) aynı deseni tekrarlıyordu:
 * gelen `data`'dan izin verilen kolonlarla dinamik bir SET listesi kurup
 * `UPDATE <table> SET ... WHERE id=$n RETURNING *` çalıştırmak, satır yoksa
 * hata fırlatmak. Hangi alanların güncellenebilir olduğuna ve değerlerin
 * nasıl normalize edileceğine (örn. vehicles'taki "Atanmadı" sentinel
 * temizliği) hâlâ çağıran karar verir — burada yalnızca ortak SQL inşası var.
 */
async function buildDynamicUpdate(
  client: import('pg').PoolClient,
  table: 'vehicles' | 'tanks' | 'drivers',
  id: string,
  fields: Array<{ column: string; value: unknown }>,
  notFoundMessage: string
): Promise<any> {
  if (fields.length === 0) {
    throw new Error('Güncellenecek alan bulunamadı.');
  }

  const setClauses = fields.map((f, idx) => `${f.column} = $${idx + 1}`);
  const values: unknown[] = fields.map((f) => f.value);
  values.push(id);

  const result = await client.query(
    `UPDATE ${table} SET ${setClauses.join(', ')} WHERE id = $${values.length} RETURNING *`,
    values
  );
  if (result.rows.length === 0) throw new Error(notFoundMessage);
  return result.rows[0];
}

export interface VehicleRecord {
  id: string;
  tenant_id: string;
  plate: string;
  brand_model: string;
  vehicle_type: string;
  rfid_tag: string;
  site_name: string;
  status: string;
  fuel_capacity_liters: number | null;
  assigned_driver_name: string | null;
}

// Şoför/araç formlarının "atanmadı" durumu için kullandığı sentinel değerler —
// bunlardan biri gelirse ilişki NULL'a çekilir (bkz. createDriver/updateDriver).
const UNASSIGNED_SENTINELS = new Set(['Atanmadı', 'Yok', '']);

export interface SiteRecord {
  id: string;
  tenant_id: string;
  name: string;
  location: string;
  created_at: Date;
}

export interface CompanySiteProfile {
  id: string;
  name: string;
  location: string;
  activeTanksCount: number;
  activeVehiclesCount: number;
}

export interface CompanyProfile {
  id: string;
  name: string;
  code: string | null;
  taxNumber: string;
  city: string | null;
  licenseStatus: string;
  licenseExpiry: string | null;
  modules: Record<string, boolean>;
  sites: CompanySiteProfile[];
  activeVehiclesCount: number;
  totalFuelThisMonth: number;
}

/**
 * Oturum açmış tenant'ın firma profilini döndürür.
 * - COMPANY_OWNER / SUPER_ADMIN: firmanın tüm şantiyelerini görür.
 * - SITE_MANAGER: yalnızca kendi şantiyesini (token'daki site_name) görür.
 * `companies` tablosu tenant kaydının kendisidir; RLS yerine doğrudan
 * id = tenantId ile filtrelenir, diğer tablolar tenant_id ile kısıtlanır.
 *
 * ARCH-101.2 düzeltmesi: bu fonksiyon önceden `withTenant()` DIŞINDA, çıplak
 * `pool.query` ile çalışıyordu — pool'un bağlandığı `postgres` kullanıcısı
 * superuser olduğundan bu üç sorgu RLS'i tamamen bypass edip yalnızca elle
 * yazılmış tenant_id/id eşleşmesine güveniyordu (bkz. git geçmişi). Artık
 * diğer tüm fonksiyonlarla aynı desende: app_user rolüne düşüp
 * app.current_tenant_id ayarlanmış bir transaction içinde çalışıyor.
 */
export async function getTenantCompanyProfile(opts?: { role?: string; siteName?: string }): Promise<CompanyProfile> {
  return withTenant(async (client, tenantId) => {
    const companyRes = await client.query(
      `SELECT id, name, tax_number, code, city, license_status, license_expiry, modules
       FROM companies WHERE id = $1`,
      [tenantId]
    );
    if (companyRes.rows.length === 0) throw new Error('COMPANY_NOT_FOUND');
    const c = companyRes.rows[0];

    const restrictSite = opts?.role === 'SITE_MANAGER' && opts?.siteName ? opts.siteName : null;

    const sitesRes = await client.query(
      `SELECT s.id, s.name, s.location,
         (SELECT COUNT(*)::int FROM tanks t   WHERE t.tenant_id = $1 AND t.site_name = s.name)   AS active_tanks_count,
         (SELECT COUNT(*)::int FROM vehicles v WHERE v.tenant_id = $1 AND v.site_name = s.name) AS active_vehicles_count
       FROM sites s
       WHERE s.tenant_id = $1 AND ($2::text IS NULL OR s.name = $2)
       ORDER BY s.name ASC`,
      [tenantId, restrictSite]
    );

    const vehRes = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM vehicles
       WHERE tenant_id = $1 AND ($2::text IS NULL OR site_name = $2)`,
      [tenantId, restrictSite]
    );

    return {
      id: c.id,
      name: c.name,
      code: c.code,
      taxNumber: c.tax_number,
      city: c.city,
      licenseStatus: c.license_status || 'AKTİF',
      licenseExpiry: c.license_expiry
        ? new Date(c.license_expiry).toISOString().slice(0, 10)
        : null,
      modules: c.modules || {},
      sites: sitesRes.rows.map((s) => ({
        id: s.id,
        name: s.name,
        location: s.location,
        activeTanksCount: s.active_tanks_count,
        activeVehiclesCount: s.active_vehicles_count
      })),
      activeVehiclesCount: vehRes.rows[0].cnt,
      totalFuelThisMonth: 0
    };
  });
}

export async function getTenantSites(): Promise<string[]> {
  return withTenant(async (client) => {
    // RLS will ensure we only see the current tenant's data in these queries
    const result = await client.query(`
      SELECT DISTINCT site_name FROM (
        SELECT name AS site_name FROM sites
        UNION
        SELECT site_name FROM users WHERE site_name IS NOT NULL
        UNION
        SELECT site_name FROM tanks WHERE site_name IS NOT NULL
        UNION
        SELECT site_name FROM vehicles WHERE site_name IS NOT NULL
        UNION
        SELECT site_name FROM drivers WHERE site_name IS NOT NULL
      ) AS all_sites
      ORDER BY site_name ASC
    `);

    return result.rows.map(row => row.site_name);
  });
}

export interface ProvisionedSite {
  site: SiteRecord;
  username: string;
  temporaryPassword: string;
  passwordExpiresAt: string;
}

const TEMP_PASSWORD_TTL_HOURS = 72;

/**
 * AUTH-204 — "Yeni şantiye ekle" TEK işlemde hem şantiyeyi HEM de o
 * şantiyenin SITE_MANAGER kullanıcısını (okunabilir kullanıcı adı + rastgele
 * geçici parola) oluşturur, aynı transaction'da (biri başarısızsa ikisi de
 * geri alınır). Geçici parola yalnızca burada, TEK SEFERLİK olarak düz metin
 * döner — veritabanında yalnızca hash'i tutulur, sonradan görüntüleme ucu
 * kasıtlı olarak YOK.
 *
 * AUTH-203: SITE_CREATED + USER_PROVISIONED denetim kayıtları aynı
 * transaction'da yazılır — audit_logs INSERT'i başarısız olursa (örn. DB
 * kısıtlaması) TÜM işlem (şantiye + kullanıcı dahil) rollback olur.
 */
export async function createSiteWithManager(siteName: string, location: string = 'Türkiye'): Promise<ProvisionedSite> {
  return withTenant(async (client, tenantId) => {
    const existingSite = await client.query('SELECT id FROM sites WHERE tenant_id = $1 AND name = $2', [tenantId, siteName]);
    if (existingSite.rows.length > 0) {
      throw new ConflictError(`'${siteName}' adında bir şantiye zaten mevcut.`);
    }

    const siteId = generateId('site');
    const siteResult = await client.query(
      `INSERT INTO sites (id, tenant_id, name, location) VALUES ($1, $2, $3, $4) RETURNING *`,
      [siteId, tenantId, siteName, location]
    );

    // `users.username` tüm tenant'lar genelinde UNIQUE — çakışırsa artan
    // sayısal sonek eklenir (bkz. adminDb.ts'teki createCompanyWithOwner'da
    // kurulan aynı desen).
    const usernameBase = generateReadableUsername(siteName);
    let username = usernameBase;
    let suffix = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const existing = await client.query('SELECT 1 FROM users WHERE username = $1', [username]);
      if (existing.rows.length === 0) break;
      username = `${usernameBase}${suffix++}`;
    }

    const temporaryPassword = generateTempPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    const passwordExpiresAt = new Date(Date.now() + TEMP_PASSWORD_TTL_HOURS * 60 * 60 * 1000);
    const userId = generateId('usr');

    await client.query(
      `INSERT INTO users (id, tenant_id, username, password_hash, role, site_name, must_change_password, temp_password_expires_at)
       VALUES ($1, $2, $3, $4, 'SITE_MANAGER', $5, TRUE, $6)`,
      [userId, tenantId, username, passwordHash, siteName, passwordExpiresAt.toISOString()]
    );

    await writeAuditLog(client, {
      action: 'SITE_CREATED',
      targetType: 'site',
      targetId: siteId,
      afterValue: { name: siteName, location }
    });
    await writeAuditLog(client, {
      action: 'USER_PROVISIONED',
      targetType: 'user',
      targetId: userId,
      afterValue: { username, role: 'SITE_MANAGER', siteName, mustChangePassword: true }
    });

    return {
      site: siteResult.rows[0],
      username,
      temporaryPassword,
      passwordExpiresAt: passwordExpiresAt.toISOString()
    };
  });
}

export async function deleteTenantSite(siteName: string): Promise<boolean> {
  return withTenant(async (client) => {
    // TEST-1003'te deleteVehicle/deleteDriver/deleteTank'ta yakalanan aynı
    // desen: silinen satır sayısı kontrol edilmezse var olmayan (ya da RLS'in
    // gizlediği başka bir tenant'a ait) bir şantiye adı için bile yanıltıcı
    // bir "başarılı" dönülür.
    const result = await client.query('DELETE FROM sites WHERE name = $1', [siteName]);
    if (result.rowCount === 0) throw new NotFoundError('Şantiye bulunamadı veya yetkiniz yok.');

    // Disassociate site_name from vehicles, drivers, tanks, users
    await client.query("UPDATE vehicles SET site_name = 'Atanmadı' WHERE site_name = $1", [siteName]);
    await client.query("UPDATE drivers SET site_name = 'Atanmadı' WHERE site_name = $1", [siteName]);
    await client.query("UPDATE tanks SET site_name = 'Atanmadı' WHERE site_name = $1", [siteName]);
    await client.query("UPDATE users SET site_name = NULL WHERE site_name = $1", [siteName]);

    return true;
  });
}

export interface DriverRecord {
  id: string;
  tenant_id: string;
  name: string;
  tc_no: string;
  phone: string;
  license_type: string;
  rfid_card_id: string;
  site_name: string;
  status: string;
  // Gerçek bir kolon değil — vehicles.assigned_driver_name = drivers.name
  // eşleşmesinden türetilir (bkz. getTenantDrivers).
  assigned_vehicle_plate: string | null;
}

export interface TankRecord {
  id: string;
  tenant_id: string;
  name: string;
  capacity_liters: number;
  current_level_liters: number;
  fuel_type: string;
  site_name: string;
  status: string;
}

/**
 * Helper to fetch vehicles enforcing RLS (Row-Level Security)
 */
/**
 * AUTH-201.4 AC: "SITE_MANAGER başka şantiyenin verisini sorgulayamamalıdır."
 * RLS yalnızca TENANT izolasyonunu sağlar — aynı tenant içindeki farklı
 * şantiyeler arasında hiçbir ayrım yapmaz. `siteRestriction` verilirse
 * (route handler'da SITE_MANAGER rolü için doldurulur) yalnızca o şantiyenin
 * kayıtları döner; SUPER_ADMIN/COMPANY_OWNER için undefined kalır (tüm
 * şantiyeleri görürler).
 */
export async function getTenantVehicles(siteRestriction?: string): Promise<VehicleRecord[]> {
  return withTenant(async (client) => {
    const result = siteRestriction
      ? await client.query('SELECT * FROM vehicles WHERE site_name = $1 ORDER BY created_at DESC', [siteRestriction])
      : await client.query('SELECT * FROM vehicles ORDER BY created_at DESC');
    return result.rows.map(row => ({
      id: row.id,
      tenant_id: row.tenant_id,
      plate: row.plate,
      brand_model: row.brand_model,
      vehicle_type: row.vehicle_type,
      rfid_tag: row.rfid_tag,
      site_name: row.site_name,
      status: row.status,
      fuel_capacity_liters: row.fuel_capacity_liters !== null ? Number(row.fuel_capacity_liters) : null,
      assigned_driver_name: row.assigned_driver_name
    }));
  });
}

export async function createVehicle(data: Omit<VehicleRecord, 'id' | 'tenant_id'>): Promise<VehicleRecord> {
  return withTenant(async (client, tenantId) => {
    const id = generateId('veh'); // In production, use UUID or better ID generation
    const assignedDriverName = data.assigned_driver_name && !UNASSIGNED_SENTINELS.has(data.assigned_driver_name)
      ? data.assigned_driver_name
      : null;
    const result = await client.query(
      `INSERT INTO vehicles (id, tenant_id, plate, brand_model, vehicle_type, rfid_tag, site_name, status, fuel_capacity_liters, assigned_driver_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [id, tenantId, data.plate, data.brand_model, data.vehicle_type, data.rfid_tag, data.site_name, data.status, data.fuel_capacity_liters ?? null, assignedDriverName]
    );
    return result.rows[0];
  });
}

export async function updateVehicle(id: string, data: Partial<VehicleRecord>): Promise<VehicleRecord> {
  return withTenant(async (client) => {
    const fields: Array<{ column: string; value: unknown }> = [];

    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (['plate', 'brand_model', 'vehicle_type', 'rfid_tag', 'site_name', 'status', 'fuel_capacity_liters'].includes(key)) {
        fields.push({ column: key, value });
      } else if (key === 'assigned_driver_name') {
        fields.push({
          column: 'assigned_driver_name',
          value: typeof value === 'string' && !UNASSIGNED_SENTINELS.has(value) ? value : null
        });
      }
    }

    return buildDynamicUpdate(client, 'vehicles', id, fields, 'Araç bulunamadı veya yetkiniz yok.');
  });
}

export async function deleteVehicle(id: string): Promise<void> {
  return withTenant(async (client) => {
    // TEST-1003'te yakalandı: silinen satır sayısı kontrol edilmediğinden
    // ID başka bir tenant'a ait olsa bile (RLS 0 satır etkiler ama sorgu
    // BAŞARIYLA döner) uç, hiçbir şey silinmediği halde 200 "başarılı"
    // dönüyordu — yalnızca bir UX/doğruluk hatası (RLS'in kendisi hâlâ
    // satırı korumuş oluyordu), ama yanıltıcıydı.
    const result = await client.query('DELETE FROM vehicles WHERE id = $1', [id]);
    if (result.rowCount === 0) throw new NotFoundError('Araç bulunamadı veya yetkiniz yok.');
  });
}

// ============================================================================
// DRIVERS CRUD
// ============================================================================

export async function getTenantDrivers(siteRestriction?: string): Promise<DriverRecord[]> {
  return withTenant(async (client) => {
    // assigned_vehicle_plate gerçek bir kolon değil — vehicles.assigned_driver_name
    // eşleşmesinden korele bir alt sorguyla türetiliyor (LIMIT 1: bir şoföre
    // birden fazla araç atanmışsa — normal akışta olmamalı — çift satır yerine
    // rastgele birini gösterir).
    const result = await client.query(`
      SELECT d.*,
        (SELECT v.plate FROM vehicles v WHERE v.assigned_driver_name = d.name AND v.tenant_id = d.tenant_id LIMIT 1) AS assigned_vehicle_plate
      FROM drivers d
      WHERE $1::text IS NULL OR d.site_name = $1
      ORDER BY d.created_at DESC
    `, [siteRestriction ?? null]);
    return result.rows;
  });
}

/**
 * Bir şoförü verilen plakadaki araca atar (vehicles.assigned_driver_name
 * kolonunu günceller); önce bu şoförün önceden atanmış olabileceği BAŞKA bir
 * aracı boşaltarak 1 şoför : 1 araç tutarlılığını korur. plate sentinel
 * ('Atanmadı'/'Yok'/boş) ise sadece eski atamayı temizler.
 */
async function syncDriverVehicleAssignment(
  client: import('pg').PoolClient,
  tenantId: string,
  driverName: string,
  plate: string | null | undefined
): Promise<void> {
  // Bu şoföre önceden atanmış olabilecek her aracı boşalt.
  await client.query(
    'UPDATE vehicles SET assigned_driver_name = NULL WHERE assigned_driver_name = $1 AND tenant_id = $2',
    [driverName, tenantId]
  );

  const normalizedPlate = plate && !UNASSIGNED_SENTINELS.has(plate) ? plate : null;
  if (normalizedPlate) {
    // Hedef araç bu tenant'ta yoksa sessizce yok sayılır (serbest metin plaka
    // girilmiş olabilir) — ikmal kaydında tank eşleşmesiyle aynı toleranslı desen.
    await client.query(
      'UPDATE vehicles SET assigned_driver_name = $1 WHERE plate = $2 AND tenant_id = $3',
      [driverName, normalizedPlate, tenantId]
    );
  }
}

export async function createDriver(data: Omit<DriverRecord, 'id' | 'tenant_id'>): Promise<DriverRecord> {
  return withTenant(async (client, tenantId) => {
    const id = generateId('drv');
    const result = await client.query(
      `INSERT INTO drivers (id, tenant_id, name, tc_no, phone, license_type, rfid_card_id, site_name, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [id, tenantId, data.name, data.tc_no, data.phone, data.license_type, data.rfid_card_id, data.site_name, data.status]
    );

    if (data.assigned_vehicle_plate !== undefined) {
      await syncDriverVehicleAssignment(client, tenantId, data.name, data.assigned_vehicle_plate);
    }

    return { ...result.rows[0], assigned_vehicle_plate: data.assigned_vehicle_plate ?? null };
  });
}

export async function updateDriver(id: string, data: Partial<DriverRecord>): Promise<DriverRecord> {
  return withTenant(async (client, tenantId) => {
    const fields: Array<{ column: string; value: unknown }> = [];
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (['name', 'tc_no', 'phone', 'license_type', 'rfid_card_id', 'site_name', 'status'].includes(key)) {
        fields.push({ column: key, value });
      }
    }

    if (fields.length === 0 && data.assigned_vehicle_plate === undefined) {
      throw new Error('Güncellenecek alan bulunamadı.');
    }

    // fields boşsa (yalnızca assigned_vehicle_plate güncelleniyorsa) UPDATE
    // yerine SELECT yeterli — buildDynamicUpdate boş listede hata fırlatır,
    // o yüzden burada onu değil doğrudan bir SELECT'i kullanıyoruz.
    let updatedDriver: any;
    if (fields.length > 0) {
      updatedDriver = await buildDynamicUpdate(client, 'drivers', id, fields, 'Şoför bulunamadı veya yetkiniz yok.');
    } else {
      const result = await client.query('SELECT * FROM drivers WHERE id = $1', [id]);
      if (result.rows.length === 0) throw new Error('Şoför bulunamadı veya yetkiniz yok.');
      updatedDriver = result.rows[0];
    }

    if (data.assigned_vehicle_plate !== undefined) {
      await syncDriverVehicleAssignment(client, tenantId, updatedDriver.name, data.assigned_vehicle_plate);
    }

    return { ...updatedDriver, assigned_vehicle_plate: data.assigned_vehicle_plate ?? null };
  });
}

export async function deleteDriver(id: string): Promise<void> {
  return withTenant(async (client) => {
    const result = await client.query('DELETE FROM drivers WHERE id = $1', [id]);
    if (result.rowCount === 0) throw new NotFoundError('Şoför bulunamadı veya yetkiniz yok.');
  });
}

// ============================================================================
// TANKS CRUD
// ============================================================================

export async function getTenantTanks(siteRestriction?: string): Promise<TankRecord[]> {
  return withTenant(async (client) => {
    const result = siteRestriction
      ? await client.query('SELECT * FROM tanks WHERE site_name = $1 ORDER BY created_at DESC', [siteRestriction])
      : await client.query('SELECT * FROM tanks ORDER BY created_at DESC');
    return result.rows;
  });
}

export async function createTank(data: Omit<TankRecord, 'id' | 'tenant_id'>): Promise<TankRecord> {
  return withTenant(async (client, tenantId) => {
    const id = generateId('tnk');
    const result = await client.query(
      `INSERT INTO tanks (id, tenant_id, name, capacity_liters, current_level_liters, fuel_type, site_name, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [id, tenantId, data.name, data.capacity_liters, data.current_level_liters, data.fuel_type, data.site_name, data.status]
    );
    return result.rows[0];
  });
}

export async function updateTank(id: string, data: Partial<TankRecord>): Promise<TankRecord> {
  return withTenant(async (client) => {
    const fields: Array<{ column: string; value: unknown }> = [];

    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (['name', 'capacity_liters', 'current_level_liters', 'fuel_type', 'site_name', 'status'].includes(key)) {
        fields.push({ column: key, value });
      }
    }

    return buildDynamicUpdate(client, 'tanks', id, fields, 'Tank bulunamadı veya yetkiniz yok.');
  });
}

export async function deleteTank(id: string): Promise<void> {
  return withTenant(async (client) => {
    const result = await client.query('DELETE FROM tanks WHERE id = $1', [id]);
    if (result.rowCount === 0) throw new NotFoundError('Tank bulunamadı veya yetkiniz yok.');
  });
}

export interface TransactionRecord {
  id: string;
  tenant_id: string;
  site_name: string;
  vehicle_plate: string;
  driver_name: string | null;
  tank_name: string | null;
  amount_liters: number;
  flow_rate_lpm: number | null;
  pump_status: string;
  type: string;
  rfid_auth: boolean;
  created_at: string;
  idempotency_key: string | null;
  hash_signature: string | null;
  verification_status: string;
}

export interface TransactionFilters {
  page?: number;
  pageSize?: number;
  startDate?: string;
  endDate?: string;
  siteName?: string;
  driverName?: string;
  pumpStatus?: string;
  type?: string;
  search?: string;
}

export interface PaginatedTransactions {
  data: TransactionRecord[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  totalLiters: number;
}

/**
 * FE-802 — sunucu taraflı sayfalama + filtreleme. Eskiden bu fonksiyon tüm
 * geçmişi sabit bir LIMIT 200 ile döndürüyordu (bkz. git geçmişi); artık
 * WHERE koşulları ve LIMIT/OFFSET ile hem toplam kayıt sayısını hem de
 * istenen tek sayfayı getiriyor. Tüm filtre değerleri parametreli sorgu
 * ($n) ile geçiliyor — hiçbir kullanıcı girdisi SQL string'ine doğrudan
 * enjekte edilmiyor. Tenant izolasyonu (RLS) burada da app_user rolü +
 * app.current_tenant_id ile sağlanıyor; WHERE'e ayrıca tenant_id eklemeye
 * gerek yok.
 */
/**
 * AUTH-201.4 AC: `siteRestriction` — SITE_MANAGER için route handler'da
 * doldurulur ve `filters.siteName`'İ EZER. filters.siteName istemciden
 * (query string) gelir ve SITE_MANAGER onu boş bırakıp tüm tenant'ın ikmal
 * geçmişini görmeye çalışabilirdi — sunucu tarafı kısıtlama istemci
 * girdisine güvenmez.
 */
export async function getTenantTransactionsPaginated(
  filters: TransactionFilters = {},
  siteRestriction?: string
): Promise<PaginatedTransactions> {
  const effectiveSiteName = siteRestriction ?? filters.siteName;
  const page = filters.page && filters.page > 0 ? Math.floor(filters.page) : 1;
  const pageSize = filters.pageSize && filters.pageSize > 0
    ? Math.min(Math.floor(filters.pageSize), 100)
    : 10;
  const offset = (page - 1) * pageSize;

  const conditions: string[] = [];
  const params: any[] = [];

  if (filters.startDate) {
    params.push(filters.startDate);
    conditions.push(`created_at >= $${params.length}::date`);
  }
  if (filters.endDate) {
    params.push(filters.endDate);
    conditions.push(`created_at < ($${params.length}::date + INTERVAL '1 day')`);
  }
  if (effectiveSiteName) {
    params.push(effectiveSiteName);
    conditions.push(`site_name = $${params.length}`);
  }
  if (filters.driverName) {
    params.push(filters.driverName);
    conditions.push(`driver_name = $${params.length}`);
  }
  if (filters.pumpStatus) {
    params.push(filters.pumpStatus);
    conditions.push(`pump_status = $${params.length}`);
  }
  if (filters.type) {
    params.push(filters.type);
    conditions.push(`type = $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${filters.search}%`);
    const idx = params.length;
    conditions.push(`(vehicle_plate ILIKE $${idx} OR driver_name ILIKE $${idx} OR tank_name ILIKE $${idx})`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  return withTenant(async (client) => {
    // Sayaç ve toplam litre, filtreye uyan TÜM kayıtlar üzerinden (yalnızca
    // görüntülenen sayfa değil) tek bir aggregate sorguda hesaplanıyor — arayüz
    // "filtrelenen toplam hacim" rakamını buradan alıyor.
    const aggregateResult = await client.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount_liters), 0)::numeric AS total_liters
       FROM transactions ${whereClause}`,
      params
    );
    const totalCount: number = aggregateResult.rows[0]?.count ?? 0;
    const totalLiters: number = Number(aggregateResult.rows[0]?.total_liters ?? 0);

    const dataParams = [...params, pageSize, offset];
    const dataResult = await client.query(
      `SELECT * FROM transactions ${whereClause} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      dataParams
    );

    return {
      data: dataResult.rows,
      page,
      pageSize,
      totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / pageSize)),
      totalLiters
    };
  });
}

/**
 * Bir ikmal kaydı oluşturur VE ilgili tankın seviyesini aynı DB transaction'ı
 * içinde atomik olarak düşürür (FOR UPDATE kilidiyle) — böylece aynı anda
 * gelen iki ikmal isteği tank seviyesini birbirinin üzerine yazamaz.
 */
export async function createTransaction(
  // idempotency_key/hash_signature/verification_status yalnızca FUEL-401.4'ün
  // finalizeDispenseSession()'ından geçen, cihaz-tetiklemeli otomatik
  // ikmallere özgü (bkz. yukarıdaki alan yorumları) — bu fonksiyon (manuel/
  // operatör tetiklemeli tek seferlik ikmal) bunları hiç set etmez, DB
  // varsayılanları (NULL / 'DOĞRULANDI') geçerli olur.
  data: Omit<TransactionRecord, 'id' | 'tenant_id' | 'created_at' | 'idempotency_key' | 'hash_signature' | 'verification_status'>
): Promise<TransactionRecord> {
  return withTenant(async (client, tenantId) => {
    const id = generateId('tx');

    // FUEL-402: Araç kendi şantiyesi (site_name) DIŞINDA bir yerde ikmal
    // alıyorsa, bu "çapraz şantiye" ikmalidir ve AKTİF + süresi dolmamış +
    // yeterli kotalı bir cross_site_permissions kaydı gerektirir. Araç kaydı
    // yoksa (serbest metin plaka) kontrol atlanır — diğer tolerans desenleriyle
    // tutarlı.
    const vehicleRes = await client.query(
      'SELECT site_name FROM vehicles WHERE plate = $1',
      [data.vehicle_plate]
    );
    if (vehicleRes.rows.length > 0 && vehicleRes.rows[0].site_name !== data.site_name) {
      const permRes = await client.query(
        `SELECT id, allowed_liters, used_liters FROM cross_site_permissions
         WHERE vehicle_plate = $1 AND target_site = $2 AND status = 'AKTİF' AND expiry_date >= CURRENT_DATE
         FOR UPDATE`,
        [data.vehicle_plate, data.site_name]
      );

      if (permRes.rows.length === 0) {
        throw new ForbiddenError(
          `'${data.vehicle_plate}' plakalı aracın '${data.site_name}' şantiyesinde geçerli bir çapraz şantiye ikmal yetkisi yok.`
        );
      }

      const perm = permRes.rows[0];
      const remaining = Number(perm.allowed_liters) - Number(perm.used_liters);
      if (remaining < Number(data.amount_liters)) {
        throw new ConflictError(
          `Çapraz şantiye kotası yetersiz: kalan ${remaining.toFixed(2)} L, istenen ${Number(data.amount_liters).toFixed(2)} L.`,
          { error: 'QUOTA_EXHAUSTED' }
        );
      }

      const newUsed = Number(perm.used_liters) + Number(data.amount_liters);
      const newPermStatus = newUsed >= Number(perm.allowed_liters) ? 'KULLANILDI' : 'AKTİF';
      await client.query(
        'UPDATE cross_site_permissions SET used_liters = $1, status = $2 WHERE id = $3',
        [newUsed, newPermStatus, perm.id]
      );
    }

    // İlgili tankı bul ve satırı kilitle (varsa) — isim eşleşmesi olmayabilir
    // (örn. serbest metin girilmiş tankName), bu durumda seviye düşümü
    // sessizce atlanır ama ikmal kaydı yine de oluşturulur.
    if (data.tank_name) {
      const tankResult = await client.query(
        'SELECT id, capacity_liters, current_level_liters FROM tanks WHERE name = $1 FOR UPDATE',
        [data.tank_name]
      );

      if (tankResult.rows.length > 0) {
        const tank = tankResult.rows[0];
        const newLevel = Math.max(0, Number(tank.current_level_liters) - Number(data.amount_liters));
        const percentage = (newLevel / Number(tank.capacity_liters)) * 100;
        const newStatus = percentage < 20 ? 'KRİTİK' : percentage < 40 ? 'UYARI' : 'GÜVENLİ';

        await client.query(
          'UPDATE tanks SET current_level_liters = $1, status = $2 WHERE id = $3',
          [newLevel, newStatus, tank.id]
        );
      }
    }

    const result = await client.query(
      `INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, driver_name, tank_name, amount_liters, flow_rate_lpm, pump_status, type, rfid_auth)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [
        id, tenantId, data.site_name, data.vehicle_plate, data.driver_name ?? null, data.tank_name ?? null,
        data.amount_liters, data.flow_rate_lpm ?? null, data.pump_status || 'TAMAMLANTI', data.type || 'Manuel',
        data.rfid_auth ?? true
      ]
    );
    return result.rows[0];
  });
}

// ============================================================================
// FUEL-401: RFID-TETİKLEMELİ İKMAL OTURUMU — YETKİLENDİRME ZİNCİRİ + FİNALİZE
// ============================================================================

// Aracın kendi fuel_capacity_liters'ı tanımlı değilse (NULL) kullanılan
// güvenli üst sınır — tipik bir kamyon/iş makinesi yakıt deposu kapasitesi.
// Ticket'ta sabit bir "kota" mekanizması tanımlanmıyor; aynı şantiyede kota
// kontrolü zaten aracın KENDİ depo kapasitesiyle doğal olarak sınırlı (çapraz
// şantiye durumu ayrıca cross_site_permissions.allowed_liters ile sınırlanır
// — bkz. aşağıdaki çapraz şantiye bloğu, createTransaction'daki FUEL-402
// deseniyle birebir aynı).
const DEFAULT_MAX_DISPENSE_LITERS = 300;

export interface DispenseAuthResult {
  vehiclePlate: string;
  driverName: string;
  siteName: string;
  tankName: string;
  maxAllowedLiters: number;
}

/**
 * FUEL-401.1 — "request-auth" ucunun yetkilendirme zinciri: kart aktif mi →
 * araç aktif mi → şantiye yetkisi → kota → tank seviyesi. Her ret, ticket'ın
 * istediği makine-okunur bir `error` koduyla (details.error) fırlatılır —
 * cihaz firmware'i buna göre farklı bir LED/ekran mesajı gösterebilir.
 *
 * Cihazın kendisinin (MQTT presence) ONLINE olup olmadığı BİLEREK ayrı bir
 * adım olarak kontrol EDİLMİYOR: bu isteğin kendisi zaten hardwareAuthMiddleware
 * üzerinden geçerli bir HMAC imzasıyla geldi — cihaz bu ANDA HTTP üzerinden
 * kanıtlanmış şekilde canlı. MQTT presence farklı bir kanaldır (telemetri) ve
 * o kanalın gecikmeli/susmuş olması bu HTTP isteğinin geçerliliğini etkilemez;
 * ayrı bir kontrol eklemek gereksiz bir yanlış-red kaynağı olurdu.
 */
export async function authorizeDispenseRequest(input: {
  rfidCardId: string;
  tankName: string;
  deviceSiteName: string;
}): Promise<DispenseAuthResult> {
  return withTenant(async (client) => {
    // 1. Kart tanınıyor mu, sürücü aktif mi?
    const driverRes = await client.query(
      'SELECT name, status FROM drivers WHERE rfid_card_id = $1',
      [input.rfidCardId]
    );
    if (driverRes.rows.length === 0) {
      throw new ForbiddenError(`'${input.rfidCardId}' kartı sisteme kayıtlı değil.`, { error: 'CARD_UNKNOWN' });
    }
    const driver = driverRes.rows[0];
    // Sürücü durumu 'AKTİF'|'SAHADA'|'İZİNLİ'|'PASİF' olabilir (bkz.
    // frontend/src/types/index.ts) — 'SAHADA' (o an sahada/görevde) da
    // çalışan bir durumdur, yalnızca 'İZİNLİ' ve 'PASİF' ikmal almamalı.
    if (driver.status !== 'AKTİF' && driver.status !== 'SAHADA') {
      throw new ForbiddenError(`'${driver.name}' sürücüsü aktif değil (durum: ${driver.status}).`, { error: 'DRIVER_INACTIVE' });
    }

    // 2. Sürücüye atanmış aktif bir araç var mı?
    const vehicleRes = await client.query(
      'SELECT plate, status, site_name, fuel_capacity_liters FROM vehicles WHERE assigned_driver_name = $1',
      [driver.name]
    );
    if (vehicleRes.rows.length === 0) {
      throw new ForbiddenError(`'${driver.name}' sürücüsüne atanmış bir araç bulunamadı.`, { error: 'NO_VEHICLE_ASSIGNED' });
    }
    const vehicle = vehicleRes.rows[0];
    if (vehicle.status !== 'AKTİF') {
      throw new ForbiddenError(`'${vehicle.plate}' plakalı araç aktif değil (durum: ${vehicle.status}).`, { error: 'VEHICLE_BLOCKED' });
    }

    // 3. Şantiye yetkisi + kota — createTransaction'daki FUEL-402 deseniyle
    // birebir aynı (çapraz şantiyede cross_site_permissions.allowed_liters
    // üst sınırı belirler; aynı şantiyede aracın kendi depo kapasitesi).
    let maxAllowedLiters = vehicle.fuel_capacity_liters ? Number(vehicle.fuel_capacity_liters) : DEFAULT_MAX_DISPENSE_LITERS;
    if (vehicle.site_name !== input.deviceSiteName) {
      const permRes = await client.query(
        `SELECT allowed_liters, used_liters FROM cross_site_permissions
         WHERE vehicle_plate = $1 AND target_site = $2 AND status = 'AKTİF' AND expiry_date >= CURRENT_DATE`,
        [vehicle.plate, input.deviceSiteName]
      );
      if (permRes.rows.length === 0) {
        throw new ForbiddenError(
          `'${vehicle.plate}' plakalı aracın '${input.deviceSiteName}' şantiyesinde geçerli bir çapraz şantiye ikmal yetkisi yok.`,
          { error: 'NO_SITE_PERMISSION' }
        );
      }
      const perm = permRes.rows[0];
      const remaining = Number(perm.allowed_liters) - Number(perm.used_liters);
      if (remaining <= 0) {
        throw new ConflictError(`Çapraz şantiye kotası tükenmiş.`, { error: 'QUOTA_EXHAUSTED' });
      }
      maxAllowedLiters = Math.min(maxAllowedLiters, remaining);
    }

    // 4. Tank bu şantiyede var mı, seviyesi yeterli mi?
    const tankRes = await client.query(
      'SELECT current_level_liters FROM tanks WHERE name = $1 AND site_name = $2',
      [input.tankName, input.deviceSiteName]
    );
    if (tankRes.rows.length === 0) {
      throw new NotFoundError(`'${input.tankName}' tankı '${input.deviceSiteName}' şantiyesinde bulunamadı.`, { error: 'TANK_NOT_FOUND' });
    }
    const tankLevel = Number(tankRes.rows[0].current_level_liters);
    if (tankLevel <= 0) {
      throw new ConflictError(`'${input.tankName}' tankında yakıt kalmamış.`, { error: 'TANK_LOW' });
    }
    maxAllowedLiters = Math.min(maxAllowedLiters, tankLevel);

    return {
      vehiclePlate: vehicle.plate,
      driverName: driver.name,
      siteName: vehicle.site_name,
      tankName: input.tankName,
      maxAllowedLiters
    };
  });
}

// FUEL-401.4 AC: totalizatör farkı ile cihazın kendi bildirdiği miktar
// arasındaki sapma bu oranı aşarsa kayıt otomatik "doğrulandı" sayılmaz.
const DISCREPANCY_THRESHOLD_RATIO = 0.01; // %1

export interface FinalizeDispenseInput {
  siteName: string;
  vehiclePlate: string;
  driverName: string | null;
  tankName: string;
  startTotalizerLiters: number;
  endTotalizerLiters: number;
  reportedLiters: number;
  flowRateLpm: number | null;
  idempotencyKey: string;
  forceManualVerification: boolean;
}

/**
 * FUEL-401.4 — "finalize" ucu. createTransaction'ın (manuel/operatör ikmali)
 * tank-düşümü + çapraz-şantiye-kota deseniyle BİREBİR aynı mantığı, cihaz
 * kaynaklı otomatik ikmaller için idempotency + hash_signature + sapma
 * doğrulamasıyla genişletir. createTransaction'ın YERİNE geçmiyor — o
 * endpoint (manuel/operatör tetiklemeli tek seferlik ikmal) olduğu gibi
 * duruyor, bu tamamen ayrı, RFID/state-machine tetiklemeli bir akış.
 */
/**
 * FUEL-401.4 — finalize akışının, oturum state machine'ine dokunmadan ÖNCE
 * çağırdığı idempotency ön kontrolü. Neden ayrı bir fonksiyon: bir cihaz
 * finalize isteğini başarıyla işletip sunucu yanıtı GERİ DÖNMEDEN (ağ
 * kesintisi) aynı isteği tekrar gönderirse, o sıradaki oturum artık
 * COMPLETED'dır — routes.ts önce bunu kontrol etmezse dispenseSessionService
 * beginFinalize() COMPLETED→FINALIZING geçişini reddeder ve idempotent
 * yanıt yerine 409 döner (bkz. test_fuel401_dispense_session.ts Test 10).
 */
export async function findTransactionByIdempotencyKey(idempotencyKey: string): Promise<TransactionRecord | null> {
  return withTenant(async (client) => {
    const result = await client.query('SELECT * FROM transactions WHERE idempotency_key = $1', [idempotencyKey]);
    return result.rows[0] ?? null;
  });
}

export async function finalizeDispenseSession(
  data: FinalizeDispenseInput
): Promise<TransactionRecord & { alreadyExisted: boolean }> {
  return withTenant(async (client, tenantId) => {
    // İdempotency: cihaz ağ kesintisi sonrası AYNI finalize isteğini tekrar
    // gönderebilir — ikinci bir kayıt yaratmak yerine var olanı döndür.
    const existing = await client.query('SELECT * FROM transactions WHERE idempotency_key = $1', [data.idempotencyKey]);
    if (existing.rows.length > 0) {
      return { ...(existing.rows[0] as TransactionRecord), alreadyExisted: true };
    }

    // Totalizatör farkı asıl doğruluk kaynağı — cihazın kendi bildirdiği
    // `reportedLiters`e KÖRÜ KÖRÜNE güvenilmez (ticket notu).
    const totalizerLiters = Math.max(0, data.endTotalizerLiters - data.startTotalizerLiters);
    const discrepancyRatio = data.reportedLiters > 0
      ? Math.abs(totalizerLiters - data.reportedLiters) / data.reportedLiters
      : 0;
    const needsVerification = data.forceManualVerification || discrepancyRatio > DISCREPANCY_THRESHOLD_RATIO;

    // Tank seviyesi düşümü — createTransaction'daki AYNI kilitli-satır deseni.
    if (data.tankName) {
      const tankResult = await client.query(
        'SELECT id, capacity_liters, current_level_liters FROM tanks WHERE name = $1 AND site_name = $2 FOR UPDATE',
        [data.tankName, data.siteName]
      );
      if (tankResult.rows.length > 0) {
        const tank = tankResult.rows[0];
        const newLevel = Math.max(0, Number(tank.current_level_liters) - totalizerLiters);
        const percentage = (newLevel / Number(tank.capacity_liters)) * 100;
        const newStatus = percentage < 20 ? 'KRİTİK' : percentage < 40 ? 'UYARI' : 'GÜVENLİ';
        await client.query('UPDATE tanks SET current_level_liters = $1, status = $2 WHERE id = $3', [newLevel, newStatus, tank.id]);
      }
    }

    // Çapraz şantiye kota kullanımı — createTransaction'daki AYNI desen.
    const vehicleRes = await client.query('SELECT site_name FROM vehicles WHERE plate = $1', [data.vehiclePlate]);
    if (vehicleRes.rows.length > 0 && vehicleRes.rows[0].site_name !== data.siteName) {
      const permRes = await client.query(
        `SELECT id, allowed_liters, used_liters FROM cross_site_permissions
         WHERE vehicle_plate = $1 AND target_site = $2 AND status = 'AKTİF' AND expiry_date >= CURRENT_DATE
         FOR UPDATE`,
        [data.vehiclePlate, data.siteName]
      );
      if (permRes.rows.length > 0) {
        const perm = permRes.rows[0];
        const newUsed = Number(perm.used_liters) + totalizerLiters;
        const newPermStatus = newUsed >= Number(perm.allowed_liters) ? 'KULLANILDI' : 'AKTİF';
        await client.query('UPDATE cross_site_permissions SET used_liters = $1, status = $2 WHERE id = $3', [newUsed, newPermStatus, perm.id]);
      }
    }

    const id = generateId('tx');
    // Değişmezlik mührü: sonradan doğrudan DB üzerinden (bu sunucu sırrını
    // bilmeden) fark ettirilmeden değiştirilemeyecek bir HMAC. Kaydın kendisi
    // hash'i taşır ama onu OTOMATİK yeniden hesaplayıp karşılaştıran bir
    // denetim job'ı henüz yok (kapsam dışı — audit tooling ayrı bir ticket).
    const hashSignature = crypto
      .createHmac('sha256', config.TRANSACTION_HASH_SECRET)
      .update(`${id}|${tenantId}|${data.vehiclePlate}|${totalizerLiters}|${data.idempotencyKey}`)
      .digest('hex');

    const result = await client.query(
      `INSERT INTO transactions
         (id, tenant_id, site_name, vehicle_plate, driver_name, tank_name, amount_liters, flow_rate_lpm, pump_status, type, rfid_auth, idempotency_key, hash_signature, verification_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [
        id, tenantId, data.siteName, data.vehiclePlate, data.driverName, data.tankName,
        totalizerLiters, data.flowRateLpm, 'TAMAMLANTI', 'Otomatik', true,
        data.idempotencyKey, hashSignature, needsVerification ? 'DOĞRULAMA_BEKLIYOR' : 'DOĞRULANDI'
      ]
    );
    return { ...(result.rows[0] as TransactionRecord), alreadyExisted: false };
  });
}

// ============================================================================
// CROSS-SITE FUEL PERMISSIONS CRUD (FUEL-402)
// ============================================================================

export interface CrossSitePermissionRecord {
  id: string;
  tenant_id: string;
  vehicle_plate: string;
  driver_name: string | null;
  home_site: string;
  target_site: string;
  allowed_liters: number;
  used_liters: number;
  expiry_date: string;
  status: string;
  created_at: string;
}

export async function getTenantCrossSitePermissions(): Promise<CrossSitePermissionRecord[]> {
  return withTenant(async (client) => {
    const result = await client.query('SELECT * FROM cross_site_permissions ORDER BY created_at DESC');
    return result.rows;
  });
}

export async function createCrossSitePermission(
  data: Omit<CrossSitePermissionRecord, 'id' | 'tenant_id' | 'used_liters' | 'status' | 'created_at'>
): Promise<CrossSitePermissionRecord> {
  return withTenant(async (client, tenantId) => {
    const id = generateId('csp');
    const result = await client.query(
      `INSERT INTO cross_site_permissions (id, tenant_id, vehicle_plate, driver_name, home_site, target_site, allowed_liters, expiry_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [id, tenantId, data.vehicle_plate, data.driver_name ?? null, data.home_site, data.target_site, data.allowed_liters, data.expiry_date]
    );

    // AUTH-203: "yetki verme" — bu ticket'ın kendi örneği olan kritik
    // operasyonlardan biri.
    await writeAuditLog(client, {
      action: 'PERMISSION_GRANTED',
      targetType: 'cross_site_permission',
      targetId: id,
      afterValue: {
        vehiclePlate: data.vehicle_plate,
        homeSite: data.home_site,
        targetSite: data.target_site,
        allowedLiters: data.allowed_liters,
        expiryDate: data.expiry_date
      }
    });

    return result.rows[0];
  });
}

export async function updateCrossSitePermissionStatus(id: string, status: string): Promise<CrossSitePermissionRecord> {
  return withTenant(async (client) => {
    const before = await client.query('SELECT status FROM cross_site_permissions WHERE id = $1', [id]);

    const result = await client.query(
      'UPDATE cross_site_permissions SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );
    if (result.rows.length === 0) throw new Error('Çapraz şantiye yetkisi bulunamadı veya yetkiniz yok.');

    await writeAuditLog(client, {
      action: 'PERMISSION_STATUS_CHANGED',
      targetType: 'cross_site_permission',
      targetId: id,
      beforeValue: { status: before.rows[0]?.status ?? null },
      afterValue: { status }
    });

    return result.rows[0];
  });
}

// ============================================================================
// AUTH-204: ZORUNLU PAROLA DEĞİŞTİRME
// ============================================================================

/**
 * Mevcut parolayı doğrulayıp yenisiyle değiştirir; must_change_password ve
 * temp_password_expires_at'ı temizler (artık geçici bir parola değil).
 * Mevcut parola yanlışsa UnauthorizedError fırlatır — bu, birinin çalınmış
 * bir access token ile parolayı ele geçirmek için kaba kuvvet denemesini
 * (mevcut parolayı bilmeden) engeller.
 */
export async function changeOwnPassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
  return withTenant(async (client) => {
    const result = await client.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    if (result.rows.length === 0) throw new UnauthorizedError('Kullanıcı bulunamadı.');

    const isValid = await verifyPassword(result.rows[0].password_hash, currentPassword);
    if (!isValid) throw new UnauthorizedError('Mevcut parola hatalı.');

    const newHash = await hashPassword(newPassword);
    await client.query(
      'UPDATE users SET password_hash = $1, must_change_password = FALSE, temp_password_expires_at = NULL WHERE id = $2',
      [newHash, userId]
    );

    // AUTH-203: parolanın KENDİSİ (ne eskisi ne yenisi) hiçbir zaman yazılmaz
    // — beforeValue/afterValue burada hiç geçilmiyor, yalnızca "değişti"
    // olayının kendisi kaydediliyor.
    await writeAuditLog(client, {
      action: 'PASSWORD_CHANGED',
      targetType: 'user',
      targetId: userId
    });
  });
}

// ============================================================================
// AUTH-203: DENETİM İZİ (yalnızca okuma — kayıt writeAuditLog ile yazılır)
// ============================================================================

export interface AuditLogRecord {
  id: string;
  tenant_id: string;
  user_id: string | null;
  trace_id: string | null;
  ip_address: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  before_value: Record<string, unknown> | null;
  after_value: Record<string, unknown> | null;
  created_at: string;
}

export async function getAuditLogs(limit = 100): Promise<AuditLogRecord[]> {
  return withTenant(async (client) => {
    const result = await client.query(
      'SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1',
      [Math.min(Math.max(limit, 1), 500)]
    );
    return result.rows;
  });
}

// ============================================================================
// AUTH-202.3 — Cihaz Provisioning, Rotasyon ve Bloke Etme (Tenant İçi)
// ============================================================================
// Kimlik doğrulama sırasındaki device_id→tenant_id aramasının aksine
// (bkz. adminDb.ts getHardwareDeviceByDeviceId, henüz tenant context'i
// yokken çalışır), buradaki her fonksiyon JWT ile kimliği doğrulanmış bir
// SUPER_ADMIN/COMPANY_OWNER'ın KENDİ tenant'ı için çağrılır — withTenant()
// üzerinden normal RLS akışına tabidir.

export interface TenantHardwareDeviceRecord {
  id: string;
  device_id: string;
  name: string;
  site_name: string;
  status: string;
  secret_rotated_at: string | null;
  previous_secret_expires_at: string | null;
  created_at: string;
}

// Secret sütunları (encrypted_secret*) BİLEREK seçilmiyor — bu liste ucu
// provisioning/rotasyon dışında hiçbir zaman şifreli de olsa secret
// döndürmemeli (AC: "tek seferlik gösterim").
const HARDWARE_DEVICE_PUBLIC_COLUMNS = 'id, device_id, name, site_name, status, secret_rotated_at, previous_secret_expires_at, created_at';

export async function getTenantHardwareDevices(): Promise<TenantHardwareDeviceRecord[]> {
  return withTenant(async (client) => {
    const result = await client.query(`SELECT ${HARDWARE_DEVICE_PUBLIC_COLUMNS} FROM hardware_devices ORDER BY created_at DESC`);
    return result.rows;
  });
}

/**
 * AC: "Provisioning sırasında secret'ın tek seferlik gösterimi." Üretilen
 * düz metin secret yalnızca bu fonksiyonun DÖNÜŞ DEĞERİNDE bulunur — DB'ye
 * yalnızca şifrelenmiş hali yazılır, bir daha asla geri okunamaz.
 */
export async function createHardwareDevice(data: {
  deviceId: string;
  name: string;
  siteName: string;
}): Promise<{ device: TenantHardwareDeviceRecord; secret: string }> {
  return withTenant(async (client, tenantId) => {
    const existing = await client.query('SELECT 1 FROM hardware_devices WHERE device_id = $1', [data.deviceId]);
    if (existing.rows.length > 0) {
      throw new ConflictError(`'${data.deviceId}' kimlikli bir cihaz zaten kayıtlı.`, { error: 'DEVICE_ID_TAKEN' });
    }

    const id = generateId('hwdev');
    const secret = generateDeviceSecret();
    const result = await client.query(
      `INSERT INTO hardware_devices (id, tenant_id, device_id, name, site_name, encrypted_secret)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${HARDWARE_DEVICE_PUBLIC_COLUMNS}`,
      [id, tenantId, data.deviceId, data.name, data.siteName, encryptDeviceSecret(secret)]
    );

    await writeAuditLog(client, {
      action: 'HARDWARE_DEVICE_PROVISIONED',
      targetType: 'hardware_device',
      targetId: data.deviceId,
      afterValue: { name: data.name, siteName: data.siteName }
    });

    return { device: result.rows[0], secret };
  });
}

/**
 * AC: "Uzaktan secret rotasyonu komutu ve geçiş süresince iki secret'ın da
 * geçerli olması." Mevcut secret `encrypted_secret_previous`'a taşınır ve
 * previous_secret_expires_at ile 24 saatlik bir geçiş penceresi açılır —
 * hardwareAuthMiddleware bu pencere içinde HER İKİ secret'ı da dener.
 */
const SECRET_ROTATION_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

export async function rotateHardwareDeviceSecret(deviceId: string): Promise<{ device: TenantHardwareDeviceRecord; secret: string }> {
  return withTenant(async (client) => {
    const current = await client.query('SELECT encrypted_secret FROM hardware_devices WHERE device_id = $1', [deviceId]);
    if (current.rows.length === 0) {
      throw new NotFoundError(`'${deviceId}' kimlikli bir cihaz bulunamadı.`, { error: 'DEVICE_NOT_FOUND' });
    }

    const newSecret = generateDeviceSecret();
    const previousExpiresAt = new Date(Date.now() + SECRET_ROTATION_GRACE_PERIOD_MS);
    const result = await client.query(
      `UPDATE hardware_devices
       SET encrypted_secret = $1, encrypted_secret_previous = $2, previous_secret_expires_at = $3, secret_rotated_at = CURRENT_TIMESTAMP
       WHERE device_id = $4
       RETURNING ${HARDWARE_DEVICE_PUBLIC_COLUMNS}`,
      [encryptDeviceSecret(newSecret), current.rows[0].encrypted_secret, previousExpiresAt.toISOString(), deviceId]
    );

    await writeAuditLog(client, {
      action: 'HARDWARE_DEVICE_SECRET_ROTATED',
      targetType: 'hardware_device',
      targetId: deviceId,
      afterValue: { previousSecretExpiresAt: previousExpiresAt.toISOString() }
    });

    return { device: result.rows[0], secret: newSecret };
  });
}

async function setHardwareDeviceStatus(deviceId: string, status: 'AKTİF' | 'BLOKE', auditAction: string): Promise<TenantHardwareDeviceRecord> {
  return withTenant(async (client) => {
    const result = await client.query(
      `UPDATE hardware_devices SET status = $1 WHERE device_id = $2 RETURNING ${HARDWARE_DEVICE_PUBLIC_COLUMNS}`,
      [status, deviceId]
    );
    if (result.rows.length === 0) {
      throw new NotFoundError(`'${deviceId}' kimlikli bir cihaz bulunamadı.`, { error: 'DEVICE_NOT_FOUND' });
    }

    await writeAuditLog(client, { action: auditAction, targetType: 'hardware_device', targetId: deviceId });

    return result.rows[0];
  });
}

/** AC: "Sızıntı şüphesinde cihazın anında bloke edilmesi." */
export async function blockHardwareDevice(deviceId: string): Promise<TenantHardwareDeviceRecord> {
  return setHardwareDeviceStatus(deviceId, 'BLOKE', 'HARDWARE_DEVICE_BLOCKED');
}

export async function unblockHardwareDevice(deviceId: string): Promise<TenantHardwareDeviceRecord> {
  return setHardwareDeviceStatus(deviceId, 'AKTİF', 'HARDWARE_DEVICE_UNBLOCKED');
}
