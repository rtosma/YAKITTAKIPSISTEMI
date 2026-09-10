import crypto from 'crypto';
import { config } from '../config/env';
import { ForbiddenError, ConflictError, UnauthorizedError, NotFoundError, BadRequestError } from '../utils/errors';
import { generateId } from '../utils/id';
import { hashPassword, verifyPassword } from '../utils/password';
import { generateReadableUsername, generateTempPassword } from '../utils/tempCredentials';
import { writeAuditLog } from '../utils/auditLog';
import { encryptDeviceSecret, generateDeviceSecret } from '../utils/hardwareSecretCrypto';
import { logger } from '../utils/logger';
import { withTenant } from './withTenant';
import { redisPool } from './redisPool';
import {
  interpolateStrappingVolume,
  cylinderVolume,
  correctToStandardVolume,
  type StrappingPoint,
  type CylinderConfig
} from '../fuel/tankVolume';
import { validateMonotonic, type StrappingPointInput } from '../schemas/strappingTableSchema';
import {
  periodWindowFor,
  nextPeriodWindow,
  computeCarryover,
  type QuotaPeriodType,
  type CarryoverPolicy
} from '../fuel/quotaPeriod';
import { listActiveSessions } from '../services/dispenseSessionService';

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
    throw new BadRequestError('Güncellenecek alan bulunamadı.');
  }

  const setClauses = fields.map((f, idx) => `${f.column} = $${idx + 1}`);
  const values: unknown[] = fields.map((f) => f.value);
  values.push(id);

  const result = await client.query(
    `UPDATE ${table} SET ${setClauses.join(', ')} WHERE id = $${values.length} RETURNING *`,
    values
  );
  // TEST-1003'ün DELETE'te bulduğu AYNI "sahte başarı/yanlış durum kodu"
  // sınıfı: satır 0 dönmesi (ID hiç yok YA DA RLS başka bir tenant'ın
  // satırını gizledi) önceden düz bir Error'a (→ 500 Internal Server Error,
  // yanlış statü kodu + günlüklerde gerçek bir sunucu çökmesiymiş gibi
  // "CRITICAL_UNHANDLED_EXCEPTION" gürültüsü) düşüyordu. Doğru durum bu bir
  // istemci hatası (404), bir sunucu hatası değil.
  if (result.rows.length === 0) throw new NotFoundError(notFoundMessage);
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

/**
 * AI-502: `companies.modules` (SUPER_ADMIN'in TenantDetailModal'dan aç/kapa
 * yaptığı JSONB) üzerinden bir modülün bu tenant için etkin olup olmadığını
 * kontrol eder. Anahtar hiç yoksa (eski/önceden oluşturulmuş bir firma
 * kaydı) VARSAYILAN AÇIK sayılır — DEFAULT_MODULES (adminDb.ts) yeni
 * firmalarda zaten aiAnomaly:true ile başlıyor, burası yalnızca "false diye
 * AÇIKÇA işaretlenmiş" durumu kapalı sayıyor.
 */
export async function isTenantModuleEnabled(moduleName: string): Promise<boolean> {
  return withTenant(async (client, tenantId) => {
    const result = await client.query('SELECT modules FROM companies WHERE id = $1', [tenantId]);
    const modules: Record<string, boolean> = result.rows[0]?.modules || {};
    return modules[moduleName] !== false;
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
      throw new BadRequestError('Güncellenecek alan bulunamadı.');
    }

    // fields boşsa (yalnızca assigned_vehicle_plate güncelleniyorsa) UPDATE
    // yerine SELECT yeterli — buildDynamicUpdate boş listede hata fırlatır,
    // o yüzden burada onu değil doğrudan bir SELECT'i kullanıyoruz.
    let updatedDriver: any;
    if (fields.length > 0) {
      updatedDriver = await buildDynamicUpdate(client, 'drivers', id, fields, 'Şoför bulunamadı veya yetkiniz yok.');
    } else {
      const result = await client.query('SELECT * FROM drivers WHERE id = $1', [id]);
      if (result.rows.length === 0) throw new NotFoundError('Şoför bulunamadı veya yetkiniz yok.');
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
  device_id: string | null;
  local_sequence_id: number | null;
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
/**
 * REP-701 — getTenantTransactionsPaginated VE streamTenantTransactionsForExport
 * aynı filtre kümesini (tarih aralığı, şantiye, sürücü, durum, tip, arama)
 * aynı önceliklerle (siteRestriction her zaman filters.siteName'i EZER) WHERE
 * koşuluna çevirmek zorunda; mantık tek yerde tutulup ikisi de burayı çağırıyor.
 */
function buildTransactionFilterClause(
  filters: TransactionFilters,
  siteRestriction?: string
): { whereClause: string; params: any[] } {
  const effectiveSiteName = siteRestriction ?? filters.siteName;
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
  return { whereClause, params };
}

export async function getTenantTransactionsPaginated(
  filters: TransactionFilters = {},
  siteRestriction?: string
): Promise<PaginatedTransactions> {
  const page = filters.page && filters.page > 0 ? Math.floor(filters.page) : 1;
  const pageSize = filters.pageSize && filters.pageSize > 0
    ? Math.min(Math.floor(filters.pageSize), 100)
    : 10;
  const offset = (page - 1) * pageSize;
  const { whereClause, params } = buildTransactionFilterClause(filters, siteRestriction);

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

export interface TransactionExportAggregate {
  totalCount: number;
  totalLiters: number;
}

/**
 * REP-701 — dışa aktarım başlamadan ÖNCE tek bir aggregate sorguyla toplam
 * satır/litre hesaplanır; "GENEL TOPLAM" satırı bu yüzden akışın en sonunda,
 * satırlar bellekte biriktirilmeden yazılabiliyor.
 */
export async function getTransactionExportAggregate(
  filters: TransactionFilters,
  siteRestriction?: string
): Promise<TransactionExportAggregate> {
  const { whereClause, params } = buildTransactionFilterClause(filters, siteRestriction);
  return withTenant(async (client) => {
    const result = await client.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount_liters), 0)::numeric AS total_liters
       FROM transactions ${whereClause}`,
      params
    );
    return {
      totalCount: result.rows[0]?.count ?? 0,
      totalLiters: Number(result.rows[0]?.total_liters ?? 0)
    };
  });
}

const EXPORT_BATCH_SIZE = 2000;

/**
 * REP-701 AC: "100.000 satır dışa aktarılırken bellek 150 MB'ı aşmamalı."
 * Tüm sonuç kümesini tek sorguda çekmek yerine (created_at, id) keyset
 * sayfalamasıyla EXPORT_BATCH_SIZE'lık gruplar halinde okuyup her grubu
 * hemen `onBatch` ile çağırana devrediyor — bir sonraki grup çekilmeden önce
 * önceki grup zaten yazılıp serbest bırakılmış oluyor. OFFSET/LIMIT yerine
 * keyset kullanılması da önemli: OFFSET N, Postgres'e önce N satırı taratıp
 * atar (sayfa büyüdükçe O(N) maliyet) — 500.000 satırlık bir ihracatın son
 * sayfalarında bu, dakikalar sürecek bir tarama demek olurdu. `id` PRIMARY
 * KEY olduğu için (created_at DESC, id DESC) tam ve kararlı bir sıralama
 * garanti eder, aynı created_at'e sahip satırlar arasında da atlama/tekrar
 * olmaz.
 *
 * Tek bir withTenant() transaction'ı akışın tamamı boyunca açık kalır — bu
 * export'un doğası gereği (RLS bağlamının ve tutarlı bir snapshot'ın tüm
 * sayfalarda aynı kalması gerekir); büyük bir export uzun sürerse bu bir
 * Postgres bağlantısını o süre boyunca meşgul eder, kabul edilen bir maliyet.
 */
export async function streamTenantTransactionsForExport(
  filters: TransactionFilters,
  siteRestriction: string | undefined,
  onBatch: (rows: TransactionRecord[]) => Promise<void>
): Promise<void> {
  const { whereClause, params } = buildTransactionFilterClause(filters, siteRestriction);
  return withTenant(async (client) => {
    let lastCreatedAt: unknown = null;
    let lastId: string | null = null;
    for (;;) {
      const keysetParams = [...params];
      let keysetClause: string;
      if (lastCreatedAt !== null && lastId !== null) {
        keysetParams.push(lastCreatedAt, lastId);
        keysetClause = `${whereClause ? 'AND' : 'WHERE'} (created_at, id) < ($${keysetParams.length - 1}, $${keysetParams.length})`;
      } else {
        keysetClause = '';
      }
      keysetParams.push(EXPORT_BATCH_SIZE);

      const result = await client.query(
        `SELECT * FROM transactions ${whereClause} ${keysetClause}
         ORDER BY created_at DESC, id DESC LIMIT $${keysetParams.length}`,
        keysetParams
      );
      if (result.rows.length === 0) break;

      await onBatch(result.rows);

      const last = result.rows[result.rows.length - 1];
      lastCreatedAt = last.created_at;
      lastId = last.id;
      if (result.rows.length < EXPORT_BATCH_SIZE) break;
    }
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
  data: Omit<TransactionRecord, 'id' | 'tenant_id' | 'created_at' | 'idempotency_key' | 'hash_signature' | 'verification_status' | 'device_id' | 'local_sequence_id'>
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
  return withTenant(async (client, tenantId) => {
    // 0. AUTH-210 — DENYLIST WHITELIST'TEN ÖNCE. Kayıp/çalıntı/değiştirilmiş
    // bir kart, sisteme kayıtlı ve sürücüsü aktif olsa BİLE ikmal alamaz.
    if (await cardDeniedWithClient(client, tenantId, input.rfidCardId)) {
      throw new ForbiddenError(
        `'${input.rfidCardId}' kartı kara listede (kayıp/çalıntı/değiştirilmiş) — ikmal reddedildi.`,
        { error: 'RFID_CARD_BLOCKED' }
      );
    }

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
// IOT-303.1 — Çevrimdışı Toplu Senkronizasyon (Offline Batch Sync)
// ============================================================================
// FUEL-410 (cihaz tarafı fail-open yetki önbelleği) henüz yapılmadığından,
// buradaki kayıtların YETKİLENDİRME kararı (kart aktif mi, kota yeterli mi vb.)
// bu koda hiç GİRMEZ — o karar, bağlantı kesikken cihazın kendi yerel
// önbelleğiyle ZATEN verilmiş ve yakıt ZATEN fiziksel olarak dispense
// edilmiştir. Bu fonksiyonun tek işi: o GEÇMİŞ olayı, mükerrer olmadan,
// doğru sırada kalıcı hale getirmek. Bu yüzden her kayıt varsayılan olarak
// 'DOĞRULAMA_BEKLIYOR' işaretlenir — canlı yetkilendirmeden geçmediler.

export interface SyncBatchRecordInput {
  localSequenceId: number;
  deviceTimestamp: string;
  siteName: string;
  vehiclePlate: string;
  driverName?: string;
  tankName: string;
  amountLiters: number;
  flowRateLpm?: number;
}

export type SyncBatchRecordResult =
  | { localSequenceId: number; status: 'ACCEPTED'; transactionId: string }
  | { localSequenceId: number; status: 'DUPLICATE_SKIPPED'; transactionId: string }
  | { localSequenceId: number; status: 'ERROR'; error: string };

// Ticket notu: "Tek transaction yerine parti parti (200'lük) işleme, uzun
// kilitleri önler." Her KAYIT da kendi withTenant() transaction'ında (aşağıda)
// — bir kaydın hatası (örn. TANK_NOT_FOUND) diğerlerini rollback ETMEMELİ,
// AC kayıt-bazlı kabul/atla/hata durumu istiyor.
const SYNC_BATCH_CHUNK_SIZE = 200;

async function syncSingleOfflineRecord(deviceId: string, record: SyncBatchRecordInput): Promise<SyncBatchRecordResult> {
  try {
    return await withTenant(async (client, tenantId) => {
      const existing = await client.query(
        'SELECT id FROM transactions WHERE device_id = $1 AND local_sequence_id = $2',
        [deviceId, record.localSequenceId]
      );
      if (existing.rows.length > 0) {
        return { localSequenceId: record.localSequenceId, status: 'DUPLICATE_SKIPPED', transactionId: existing.rows[0].id };
      }

      // Tank kilidi + düşümü — createTransaction/finalizeDispenseSession'daki
      // AYNI FOR UPDATE deseni.
      const tankResult = await client.query(
        'SELECT id, capacity_liters, current_level_liters FROM tanks WHERE name = $1 AND site_name = $2 FOR UPDATE',
        [record.tankName, record.siteName]
      );
      if (tankResult.rows.length === 0) {
        throw new NotFoundError(`'${record.tankName}' tankı '${record.siteName}' şantiyesinde bulunamadı.`, { error: 'TANK_NOT_FOUND' });
      }
      const tank = tankResult.rows[0];
      const newLevel = Number(tank.current_level_liters) - record.amountLiters;

      // IOT-303.2 AC: "Negatif stok oluşursa işlemin durdurulup mutabakat
      // uyarısı üretilmesi... sessizce sıfırlanmamalı." Geçmişe dönük bir
      // kaydın, tankın o anda fiziksel olarak sahip olabileceğinden FAZLA
      // yakıt tükettiğini iddia etmesi bir ölçüm hatası ya da kaçak
      // göstergesidir — createTransaction/finalizeDispenseSession'daki
      // Math.max(0, ...) deseni burada BİLEREK KULLANILMIYOR: o desen CANLI
      // ikmaller için "tank boşaldı, 0'da dur" anlamına gelirken, burada
      // GEÇMİŞTE ZATEN OLMUŞ bir olayın kayda alınıp alınmayacağı söz
      // konusu — sessizce 0'a kırpıp kaydı yine de yaratmak, aslında hiç
      // gerçekleşmemiş olabilecek bir tüketimi mali kayıtlara sokardı.
      // Alarm KASITLI OLARAK burada değil, aşağıdaki catch bloğunda AYRI bir
      // transaction'da yazılıyor — bu transaction'ın kendisi reddedilen
      // işlemle birlikte ROLLBACK olacağından, audit log'u burada yazmak onu
      // da geri alırdı (alarm hiç kalıcı olmazdı).
      if (newLevel < 0) {
        throw new ConflictError(
          `'${record.tankName}' tankı için geçmişe dönük kayıt reddedildi: mevcut seviye (${tank.current_level_liters}L) istenen miktarı (${record.amountLiters}L) karşılayamıyor. Mutabakat gerekiyor.`,
          { error: 'NEGATIVE_STOCK_DETECTED', tankId: tank.id, previousLevel: Number(tank.current_level_liters) }
        );
      }

      const percentage = (newLevel / Number(tank.capacity_liters)) * 100;
      const newStatus = percentage < 20 ? 'KRİTİK' : percentage < 40 ? 'UYARI' : 'GÜVENLİ';
      await client.query('UPDATE tanks SET current_level_liters = $1, status = $2 WHERE id = $3', [newLevel, newStatus, tank.id]);

      // FUEL-410: bu geçmiş kayıt, o şantiyenin GEÇERLİ fail-open politikasını
      // aşıyor mu? Fuel zaten fiziksel olarak dispense edildiğinden kaydın
      // KENDİSİ reddedilMİYOR (negatif stok kontrolünden farklı olarak) —
      // yalnızca bir denetim uyarısı üretiliyor, çünkü bu ya politika
      // SONRADAN sıkılaştırıldığı için ya da cihaz politikayı görmezden
      // geldiği (tamper/bug) için olabilir; ikisi de operatör incelemesi ister.
      const policyViolations: string[] = [];
      const effectivePolicy = await getEffectiveFailOpenPolicy(record.siteName, client);
      if (effectivePolicy.fail_close) {
        policyViolations.push('FAIL_CLOSE_VIOLATED');
      }
      if (record.amountLiters > Number(effectivePolicy.max_liters_per_vehicle)) {
        policyViolations.push('MAX_LITERS_PER_VEHICLE_EXCEEDED');
      }
      const sameDayCountRes = await client.query(
        `SELECT COUNT(*)::int AS c FROM transactions
         WHERE vehicle_plate = $1 AND type = 'Çevrimdışı Senkron'
           AND created_at::date = $2::timestamptz::date`,
        [record.vehiclePlate, record.deviceTimestamp]
      );
      if (sameDayCountRes.rows[0].c + 1 > effectivePolicy.max_daily_dispenses_per_vehicle) {
        policyViolations.push('MAX_DAILY_DISPENSES_EXCEEDED');
      }
      if (policyViolations.length > 0) {
        await writeAuditLog(client, {
          action: 'OFFLINE_DISPENSE_POLICY_VIOLATION',
          targetType: 'vehicle',
          targetId: record.vehiclePlate,
          afterValue: { deviceId, localSequenceId: record.localSequenceId, siteName: record.siteName, amountLiters: record.amountLiters, violations: policyViolations, policyId: effectivePolicy.id }
        });
      }

      const id = generateId('tx');
      const hashSignature = crypto
        .createHmac('sha256', config.TRANSACTION_HASH_SECRET)
        .update(`${id}|${tenantId}|${record.vehiclePlate}|${record.amountLiters}|${deviceId}|${record.localSequenceId}`)
        .digest('hex');

      let insertResult;
      try {
        insertResult = await client.query(
          `INSERT INTO transactions
             (id, tenant_id, site_name, vehicle_plate, driver_name, tank_name, amount_liters, flow_rate_lpm, pump_status, type, rfid_auth, device_id, local_sequence_id, hash_signature, verification_status, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
          [
            id, tenantId, record.siteName, record.vehiclePlate, record.driverName ?? null, record.tankName,
            record.amountLiters, record.flowRateLpm ?? null, 'TAMAMLANTI', 'Çevrimdışı Senkron', true,
            deviceId, record.localSequenceId, hashSignature, 'DOĞRULAMA_BEKLIYOR', record.deviceTimestamp
          ]
        );
      } catch (insertErr: any) {
        // Yarış durumu: aynı kaydın iki eşzamanlı sync-batch isteği (örn.
        // cihaz, yanıtı alamadığı için TÜM batch'i tekrar gönderdi) yukarıdaki
        // SELECT'i İKİSİ DE "yeni" görebilir — asıl güvence burada, veritabanı
        // seviyesindeki UNIQUE (device_id, local_sequence_id) kısıtı.
        if (insertErr.code === '23505') {
          const raceCheck = await client.query(
            'SELECT id FROM transactions WHERE device_id = $1 AND local_sequence_id = $2',
            [deviceId, record.localSequenceId]
          );
          return { localSequenceId: record.localSequenceId, status: 'DUPLICATE_SKIPPED' as const, transactionId: raceCheck.rows[0]?.id ?? 'unknown' };
        }
        throw insertErr;
      }

      return { localSequenceId: record.localSequenceId, status: 'ACCEPTED', transactionId: insertResult.rows[0].id };
    });
  } catch (err: any) {
    if (err?.details?.error === 'NEGATIVE_STOCK_DETECTED') {
      // Reddedilen işlemin transaction'ı (yukarıda) zaten ROLLBACK oldu —
      // alarmın KALICI olması için tamamen AYRI, bağımsız bir transaction'da
      // yazılıyor (aksi halde audit log de rollback ile birlikte kaybolurdu).
      try {
        await withTenant(async (client) => {
          await writeAuditLog(client, {
            action: 'NEGATIVE_STOCK_ALARM',
            targetType: 'tank',
            targetId: err.details.tankId,
            beforeValue: { currentLevelLiters: err.details.previousLevel },
            afterValue: {
              rejectedAmountLiters: record.amountLiters,
              deviceId,
              localSequenceId: record.localSequenceId,
              deviceTimestamp: record.deviceTimestamp
            }
          });
        });
      } catch (auditErr) {
        logger.error({ err: auditErr }, '🚨 [IOT-303.2] Negatif stok alarmı denetim izine yazılamadı.');
      }
      logger.error(
        { deviceId, localSequenceId: record.localSequenceId, tankName: record.tankName },
        `🚨 [IOT-303.2] MUTABAKAT ALARMI: geçmişe dönük kayıt '${record.tankName}' tankını negatife düşürüyordu, reddedildi.`
      );
    }
    return { localSequenceId: record.localSequenceId, status: 'ERROR', error: err.details?.error || err.message || 'UNKNOWN_ERROR' };
  }
}

/**
 * AC: "İki alt issue da... geçmişe dönük kronolojik stok işleme." Burada
 * yalnızca BATCH'İN KENDİ İÇİNDE cihaz zaman damgasına göre artan sırada
 * uygulanır — kayıtlar arasında FOR UPDATE ile atomik, ardışık düşüm yapılır.
 * Bu, IOT-303.2'nin istediği "batch'in aralarına girmiş CANLI (online)
 * ikmallerle birlikte TAM yeniden hesaplama" DEĞİLDİR — o, tank bakiyesinin
 * olay-tabanlı (event-sourced) yeniden türetilmesini gerektiren ayrı ve daha
 * büyük bir problem (bkz. #107), kasıtlı olarak bu issue'nun kapsamı dışında.
 */
export async function syncOfflineDispenseBatch(
  deviceId: string,
  records: SyncBatchRecordInput[]
): Promise<SyncBatchRecordResult[]> {
  const sorted = [...records].sort(
    (a, b) => new Date(a.deviceTimestamp).getTime() - new Date(b.deviceTimestamp).getTime()
  );

  const results: SyncBatchRecordResult[] = [];
  for (let i = 0; i < sorted.length; i += SYNC_BATCH_CHUNK_SIZE) {
    const chunk = sorted.slice(i, i + SYNC_BATCH_CHUNK_SIZE);
    for (const record of chunk) {
      results.push(await syncSingleOfflineRecord(deviceId, record));
    }
  }
  return results;
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
    if (result.rows.length === 0) throw new NotFoundError('Çapraz şantiye yetkisi bulunamadı veya yetkiniz yok.');

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

/**
 * IOT-304 AC: "Cihaz nakledildiğinde geçmiş telemetrisi eski şantiyede
 * kalmalı, yeni kayıtlar yeni şantiyeye yazılmalıdır." Bu, EK bir işlem
 * GEREKTİRMİYOR: transactions/audit_logs gibi geçmiş kayıtlar zaten
 * OLUŞTURULDUKLARI ANDAKİ site_name'i kendi satırlarında taşıyor (canlı bir
 * FK ile hardware_devices.site_name'e bağlı değiller) — burada yalnızca
 * cihazın GELECEKTEKİ isteklerinde kullanılacak site_name'i güncelleniyor.
 */
export async function relocateHardwareDevice(deviceId: string, newSiteName: string): Promise<TenantHardwareDeviceRecord> {
  return withTenant(async (client) => {
    const result = await client.query(
      `UPDATE hardware_devices SET site_name = $1 WHERE device_id = $2 RETURNING ${HARDWARE_DEVICE_PUBLIC_COLUMNS}`,
      [newSiteName, deviceId]
    );
    if (result.rows.length === 0) {
      throw new NotFoundError(`'${deviceId}' kimlikli bir cihaz bulunamadı.`, { error: 'DEVICE_NOT_FOUND' });
    }

    await writeAuditLog(client, {
      action: 'HARDWARE_DEVICE_RELOCATED',
      targetType: 'hardware_device',
      targetId: deviceId,
      afterValue: { newSiteName }
    });

    return result.rows[0];
  });
}

// ============================================================================
// IOT-304 — Cihaz Claim Kodu Üretimi (Tenant İçi, JWT ile Kimliği Doğrulanmış)
// ============================================================================
// Kodun TÜKETİLMESİ (redemption) adminDb.ts'te — henüz tenant context'i
// olmayan cihazın/teknisyenin kendisi tarafından çağrılır. Burada yalnızca
// bir COMPANY_OWNER/SUPER_ADMIN'in KENDİ tenant'ı için yeni bir kod ÜRETMESİ var.

export interface DeviceClaimCodeRecord {
  id: string;
  code: string;
  site_name: string;
  device_name: string;
  status: string;
  expires_at: string;
  redeemed_device_id: string | null;
  redeemed_at: string | null;
  created_at: string;
}

const CLAIM_CODE_TTL_MINUTES_DEFAULT = 15;
// 0/O ve 1/I gibi karışabilecek karakterler kasıtlı olarak dışarıda —
// kod bir QR yerine ELLE de girilebilmeli (sahada QR okutma başarısız olabilir).
const CLAIM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CLAIM_CODE_LENGTH = 10;

function generateClaimCode(): string {
  return Array.from({ length: CLAIM_CODE_LENGTH }, () => CLAIM_CODE_ALPHABET[crypto.randomInt(CLAIM_CODE_ALPHABET.length)]).join('');
}

/**
 * AC: "Tek kullanımlık claim kodu / QR." Burada yalnızca kodun kendisi
 * üretiliyor — ticket'ın QR üretimi (görsel encoding) bir imaj kütüphanesi
 * gerektirir (bu kod tabanında yok, ve bu tek özellik için yeni bir bağımlılık
 * eklemek gerekçesiz); kodu bir QR'a çevirmek istemci (provisioning
 * uygulaması/frontend) tarafında, herhangi bir standart QR kütüphanesiyle
 * yapılabilir — sunucunun tek sorumluluğu KRİPTOGRAFİK OLARAK GÜÇLÜ ve TEK
 * KULLANIMLIK bir kod üretmek/doğrulamaktır.
 */
export async function createDeviceClaimCode(data: {
  siteName: string;
  deviceName: string;
  expiresInMinutes?: number;
}): Promise<DeviceClaimCodeRecord> {
  return withTenant(async (client, tenantId) => {
    const code = generateClaimCode();
    const expiresAt = new Date(Date.now() + (data.expiresInMinutes ?? CLAIM_CODE_TTL_MINUTES_DEFAULT) * 60_000);
    const id = generateId('claim');

    const result = await client.query(
      `INSERT INTO device_claim_codes (id, tenant_id, code, site_name, device_name, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, tenantId, code, data.siteName, data.deviceName, expiresAt.toISOString()]
    );

    await writeAuditLog(client, {
      action: 'DEVICE_CLAIM_CODE_CREATED',
      targetType: 'device_claim_code',
      targetId: code,
      afterValue: { siteName: data.siteName, deviceName: data.deviceName, expiresAt: expiresAt.toISOString() }
    });

    return result.rows[0];
  });
}

export async function getTenantClaimCodes(): Promise<DeviceClaimCodeRecord[]> {
  return withTenant(async (client) => {
    const result = await client.query('SELECT * FROM device_claim_codes ORDER BY created_at DESC');
    return result.rows;
  });
}

// ============================================================================
// FUEL-404.1 — K-Factor Uzaktan Kalibrasyon: Komut, Ack, Geri Alma, Geçmiş
// ============================================================================
// Route seviyesi (routes.ts) MQTT yayınını (mqttService.publishCommand)
// yapar — burası yalnızca DB durumunu yönetir. Bu ayrım FUEL-401'in
// dispenseSessionService.ts ile routes.ts arasındaki AYNI sorumluluk
// bölünmesini izliyor.

export interface CalibrationCommandRecord {
  id: string;
  device_id: string;
  previous_k_factor: number | null;
  new_k_factor: number;
  reason: string;
  reference_measurement: Record<string, unknown> | null;
  requested_by: string;
  requires_second_approval: boolean;
  approved_by: string | null;
  approved_at: string | null;
  status: string;
  sent_at: string | null;
  acked_at: string | null;
  is_rollback: boolean;
  created_at: string;
}

// AC: "±%20'den büyük değişiklikler ikinci onay istemelidir."
const CALIBRATION_SECOND_APPROVAL_THRESHOLD_RATIO = 0.20;

/**
 * AC: "Yetkisiz kullanıcı kalibrasyon değiştirememelidir" — bu fonksiyon
 * kasıtlı olarak rol kontrolü YAPMAZ (routes.ts'in authorizeRoles'ü zaten
 * SUPER_ADMIN/COMPANY_OWNER'a kilitler, tenantDb.ts katmanının sorumluluğu
 * DEĞİL, established pattern). Burada yalnızca iş kuralı: mevcut k_factor'e
 * göre %20 eşiği aşılırsa komut CİHAZA HİÇ GÖNDERİLMEDEN 'IKINCI_ONAY_BEKLIYOR'
 * durumunda oluşturulur — routes.ts bu durumu görüp MQTT yayınını ERTELER.
 */
export async function requestKFactorCalibration(data: {
  deviceId: string;
  newKFactor: number;
  reason: string;
  referenceMeasurement?: Record<string, unknown>;
  requestedByUserId: string;
}): Promise<CalibrationCommandRecord> {
  return withTenant(async (client, tenantId) => {
    const deviceRes = await client.query('SELECT k_factor FROM hardware_devices WHERE device_id = $1', [data.deviceId]);
    if (deviceRes.rows.length === 0) {
      throw new NotFoundError(`'${data.deviceId}' kimlikli bir cihaz bulunamadı.`, { error: 'DEVICE_NOT_FOUND' });
    }
    const previousKFactor = deviceRes.rows[0].k_factor !== null ? Number(deviceRes.rows[0].k_factor) : null;

    const changeRatio = previousKFactor && previousKFactor > 0
      ? Math.abs(data.newKFactor - previousKFactor) / previousKFactor
      : 0; // İlk kalibrasyon (previousKFactor NULL) — karşılaştıracak bir temel yok, ikinci onay istenmez.
    const requiresSecondApproval = changeRatio > CALIBRATION_SECOND_APPROVAL_THRESHOLD_RATIO;

    const id = generateId('calib');
    const result = await client.query(
      `INSERT INTO calibration_commands
         (id, tenant_id, device_id, previous_k_factor, new_k_factor, reason, reference_measurement, requested_by, requires_second_approval, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) RETURNING *`,
      [
        id, tenantId, data.deviceId, previousKFactor, data.newKFactor, data.reason,
        JSON.stringify(data.referenceMeasurement ?? null), data.requestedByUserId, requiresSecondApproval,
        requiresSecondApproval ? 'IKINCI_ONAY_BEKLIYOR' : 'BEKLIYOR'
      ]
    );

    await writeAuditLog(client, {
      action: 'CALIBRATION_REQUESTED',
      targetType: 'hardware_device',
      targetId: data.deviceId,
      beforeValue: { kFactor: previousKFactor },
      afterValue: { newKFactor: data.newKFactor, reason: data.reason, requiresSecondApproval, changeRatio }
    });

    return result.rows[0];
  });
}

/**
 * İkinci onay — %20 eşiğini aşan bir isteği SUPER_ADMIN/COMPANY_OWNER
 * (aynı kişi de olabilir, ticket iki farklı kişi şartı koşmuyor) onaylar.
 * Onaydan SONRA route bu satırı MQTT'ye gönderir (status hâlâ 'BEKLIYOR'
 * olarak dönüyor — cihazın ack'i gelene kadar "uygulandı" sayılmaz).
 */
export async function approveKFactorCalibration(commandId: string, approvedByUserId: string): Promise<CalibrationCommandRecord> {
  return withTenant(async (client) => {
    const result = await client.query(
      `UPDATE calibration_commands
       SET status = 'BEKLIYOR', approved_by = $1, approved_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND status = 'IKINCI_ONAY_BEKLIYOR'
       RETURNING *`,
      [approvedByUserId, commandId]
    );
    if (result.rows.length === 0) {
      throw new NotFoundError(
        `'${commandId}' kimlikli, ikinci onay bekleyen bir kalibrasyon komutu bulunamadı.`,
        { error: 'CALIBRATION_COMMAND_NOT_FOUND' }
      );
    }

    await writeAuditLog(client, {
      action: 'CALIBRATION_SECOND_APPROVAL_GRANTED',
      targetType: 'calibration_command',
      targetId: commandId,
      afterValue: { approvedBy: approvedByUserId }
    });

    return result.rows[0];
  });
}

/** Route, approve/request sonrası MQTT yayınını yaptıktan SONRA çağırır — sent_at'i işaretler. */
export async function markCalibrationSent(commandId: string): Promise<void> {
  return withTenant(async (client) => {
    await client.query(`UPDATE calibration_commands SET sent_at = CURRENT_TIMESTAMP WHERE id = $1`, [commandId]);
  });
}

/**
 * AC: "Cihaz onayı (ack) alınmadan değişiklik 'uygulandı' gösterilmemelidir."
 * hardware_devices.k_factor YALNIZCA burada, gerçek bir ack üzerine güncellenir.
 */
export async function recordCalibrationAck(deviceId: string, commandId: string, appliedKFactor: number): Promise<CalibrationCommandRecord> {
  return withTenant(async (client) => {
    const cmdRes = await client.query(
      `UPDATE calibration_commands SET status = 'ONAYLANDI', acked_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND device_id = $2 AND status = 'BEKLIYOR' RETURNING *`,
      [commandId, deviceId]
    );
    if (cmdRes.rows.length === 0) {
      throw new NotFoundError(
        `'${commandId}' kimlikli, ack bekleyen bir kalibrasyon komutu bulunamadı.`,
        { error: 'CALIBRATION_COMMAND_NOT_FOUND' }
      );
    }

    await client.query('UPDATE hardware_devices SET k_factor = $1 WHERE device_id = $2', [appliedKFactor, deviceId]);

    await writeAuditLog(client, {
      action: 'CALIBRATION_ACKED',
      targetType: 'hardware_device',
      targetId: deviceId,
      afterValue: { commandId, appliedKFactor }
    });

    return cmdRes.rows[0];
  });
}

export async function recordCalibrationNack(deviceId: string, commandId: string, reason?: string): Promise<CalibrationCommandRecord> {
  return withTenant(async (client) => {
    const result = await client.query(
      `UPDATE calibration_commands SET status = 'REDDEDILDI'
       WHERE id = $1 AND device_id = $2 AND status = 'BEKLIYOR' RETURNING *`,
      [commandId, deviceId]
    );
    if (result.rows.length === 0) {
      throw new NotFoundError(
        `'${commandId}' kimlikli, ack bekleyen bir kalibrasyon komutu bulunamadı.`,
        { error: 'CALIBRATION_COMMAND_NOT_FOUND' }
      );
    }

    await writeAuditLog(client, {
      action: 'CALIBRATION_NACKED',
      targetType: 'hardware_device',
      targetId: deviceId,
      afterValue: { commandId, reason: reason ?? null }
    });

    return result.rows[0];
  });
}

export async function getCalibrationHistory(deviceId: string): Promise<CalibrationCommandRecord[]> {
  return withTenant(async (client) => {
    const result = await client.query(
      'SELECT * FROM calibration_commands WHERE device_id = $1 ORDER BY created_at DESC',
      [deviceId]
    );
    return result.rows;
  });
}

/**
 * AC: "Kalibrasyon geçmişi silinemez olmalıdır." Geri alma bir DELETE/UPDATE
 * değil, önceki başarılı (ONAYLANDI) değere dönen YENİ bir komuttur — normal
 * kalibrasyon isteğiyle AYNI ack akışından geçer (cihaz onaylamadan
 * "geri alındı" sayılmaz).
 */
export async function rollbackKFactorCalibration(deviceId: string, requestedByUserId: string): Promise<CalibrationCommandRecord> {
  return withTenant(async (client, tenantId) => {
    const currentRes = await client.query('SELECT k_factor FROM hardware_devices WHERE device_id = $1', [deviceId]);
    if (currentRes.rows.length === 0) {
      throw new NotFoundError(`'${deviceId}' kimlikli bir cihaz bulunamadı.`, { error: 'DEVICE_NOT_FOUND' });
    }
    const currentKFactor = currentRes.rows[0].k_factor !== null ? Number(currentRes.rows[0].k_factor) : null;

    // Şu anki değerden ÖNCEKİ son başarılı (ONAYLANDI) kalibrasyonu bul —
    // bu satırın previous_k_factor'ü, geri dönülecek hedef değerdir.
    const previousSuccessRes = await client.query(
      `SELECT previous_k_factor FROM calibration_commands
       WHERE device_id = $1 AND status = 'ONAYLANDI'
       ORDER BY acked_at DESC LIMIT 1`,
      [deviceId]
    );
    if (previousSuccessRes.rows.length === 0 || previousSuccessRes.rows[0].previous_k_factor === null) {
      throw new ConflictError(
        `'${deviceId}' cihazı için geri dönülecek önceki bir kalibrasyon kaydı yok.`,
        { error: 'NO_PREVIOUS_CALIBRATION' }
      );
    }
    const rollbackTarget = Number(previousSuccessRes.rows[0].previous_k_factor);

    const id = generateId('calib');
    const result = await client.query(
      `INSERT INTO calibration_commands
         (id, tenant_id, device_id, previous_k_factor, new_k_factor, reason, requested_by, requires_second_approval, status, is_rollback)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'BEKLIYOR',TRUE) RETURNING *`,
      [id, tenantId, deviceId, currentKFactor, rollbackTarget, 'Bir önceki onaylı kalibrasyona geri alma', requestedByUserId, false]
    );

    await writeAuditLog(client, {
      action: 'CALIBRATION_ROLLBACK_REQUESTED',
      targetType: 'hardware_device',
      targetId: deviceId,
      beforeValue: { kFactor: currentKFactor },
      afterValue: { rollbackTarget }
    });

    return result.rows[0];
  });
}

// ============================================================================
// FUEL-404.2 — Kalibrasyon Test Alımı (Referans Kap ile Sapma Hesabı)
// ============================================================================

export interface CalibrationTestIntakeRecord {
  id: string;
  device_id: string;
  tank_name: string;
  reference_volume_liters: number;
  measured_liters: number;
  ambient_temperature_celsius: number | null;
  k_factor_at_test: number;
  deviation_ratio: number;
  proposed_k_factor: number;
  verifies_calibration_command_id: string | null;
  requested_by: string;
  created_at: string;
}

/**
 * AC: "Test alımı normal ikmal olarak faturalandırılmamalı ama stoktan
 * düşmelidir." Bilerek transactions'a HİÇ yazmıyor (createTransaction/
 * finalizeDispenseSession/syncOfflineDispenseBatch'in HİÇBİRİNİ çağırmıyor)
 * — yalnızca tankın current_level_liters'ını AYNI FOR UPDATE kilitli
 * desenle düşürüyor. Bu, "raporlarda ayrı sınıflandırılması" AC'sini de
 * doğal olarak sağlıyor: transactions'ı sorgulayan hiçbir mevcut rapor bu
 * tabloyu hiç görmez.
 *
 * K-factor önerisi formülü ticket'ın kendi notu: yeni = eski × (ölçülen / gerçek).
 */
export async function recordCalibrationTestIntake(data: {
  deviceId: string;
  tankName: string;
  siteName: string;
  referenceVolumeLiters: number;
  measuredLiters: number;
  ambientTemperatureCelsius?: number;
  verifiesCalibrationCommandId?: string;
  requestedByUserId: string;
}): Promise<{ intake: CalibrationTestIntakeRecord; recommendedKFactor: number; basedOnSingleMeasurement: boolean }> {
  return withTenant(async (client, tenantId) => {
    const deviceRes = await client.query('SELECT k_factor FROM hardware_devices WHERE device_id = $1', [data.deviceId]);
    if (deviceRes.rows.length === 0) {
      throw new NotFoundError(`'${data.deviceId}' kimlikli bir cihaz bulunamadı.`, { error: 'DEVICE_NOT_FOUND' });
    }
    const kFactorAtTest = deviceRes.rows[0].k_factor !== null ? Number(deviceRes.rows[0].k_factor) : null;
    if (kFactorAtTest === null) {
      throw new ConflictError(
        `'${data.deviceId}' cihazının hiç kalibre edilmiş bir k_factor'ü yok — önce bir başlangıç kalibrasyonu (POST /devices/${data.deviceId}/calibration) uygulanmalı.`,
        { error: 'NO_BASELINE_K_FACTOR' }
      );
    }

    // Henüz cihaz tarafından ACK'lenmemiş (uygulanmamış) bir kalibrasyonun
    // "doğrulandığını" iddia etmek mantıksal olarak tutarsız olurdu —
    // verifiesCalibrationCommandId yalnızca GERÇEKTEN uygulanmış (ONAYLANDI)
    // bir komutu işaret edebilir.
    if (data.verifiesCalibrationCommandId) {
      const cmdRes = await client.query(
        `SELECT status FROM calibration_commands WHERE id = $1 AND device_id = $2`,
        [data.verifiesCalibrationCommandId, data.deviceId]
      );
      if (cmdRes.rows.length === 0) {
        throw new NotFoundError(`'${data.verifiesCalibrationCommandId}' kimlikli bir kalibrasyon komutu bulunamadı.`, { error: 'CALIBRATION_COMMAND_NOT_FOUND' });
      }
      if (cmdRes.rows[0].status !== 'ONAYLANDI') {
        throw new ConflictError(
          `'${data.verifiesCalibrationCommandId}' kimlikli komut henüz cihaz tarafından onaylanmadı (durum: ${cmdRes.rows[0].status}) — doğrulama alımı yalnızca ONAYLANDI bir komut için yapılabilir.`,
          { error: 'CALIBRATION_NOT_YET_ACKED' }
        );
      }
    }

    // Tank kilidi + düşümü — createTransaction/syncOfflineDispenseBatch'teki
    // AYNI desen, ama BİLEREK transactions'a INSERT YOK.
    const tankResult = await client.query(
      'SELECT id, capacity_liters, current_level_liters FROM tanks WHERE name = $1 AND site_name = $2 FOR UPDATE',
      [data.tankName, data.siteName]
    );
    if (tankResult.rows.length === 0) {
      throw new NotFoundError(`'${data.tankName}' tankı '${data.siteName}' şantiyesinde bulunamadı.`, { error: 'TANK_NOT_FOUND' });
    }
    const tank = tankResult.rows[0];
    const newLevel = Math.max(0, Number(tank.current_level_liters) - data.measuredLiters);
    const percentage = (newLevel / Number(tank.capacity_liters)) * 100;
    const newStatus = percentage < 20 ? 'KRİTİK' : percentage < 40 ? 'UYARI' : 'GÜVENLİ';
    await client.query('UPDATE tanks SET current_level_liters = $1, status = $2 WHERE id = $3', [newLevel, newStatus, tank.id]);

    const deviationRatio = Math.abs(data.measuredLiters - data.referenceVolumeLiters) / data.referenceVolumeLiters;
    const proposedKFactor = kFactorAtTest * (data.measuredLiters / data.referenceVolumeLiters);

    const id = generateId('testintake');
    const result = await client.query(
      `INSERT INTO calibration_test_intakes
         (id, tenant_id, device_id, tank_name, reference_volume_liters, measured_liters, ambient_temperature_celsius, k_factor_at_test, deviation_ratio, proposed_k_factor, verifies_calibration_command_id, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        id, tenantId, data.deviceId, data.tankName, data.referenceVolumeLiters, data.measuredLiters,
        data.ambientTemperatureCelsius ?? null, kFactorAtTest, deviationRatio, proposedKFactor,
        data.verifiesCalibrationCommandId ?? null, data.requestedByUserId
      ]
    );
    const intake: CalibrationTestIntakeRecord = result.rows[0];

    // AC: "Tek ölçüm yanıltıcı olabilir; en az 2 test alımının ortalaması
    // önerilmelidir." Bu cihaz için (bu dahil) son 2 ölçümün proposed_k_factor
    // ortalaması hesaplanır; yalnızca 1 ölçüm varsa tek başına kullanılır ama
    // basedOnSingleMeasurement=true ile işaretlenip çağıran tarafa bildirilir.
    const recentRes = await client.query(
      `SELECT proposed_k_factor FROM calibration_test_intakes
       WHERE device_id = $1 ORDER BY created_at DESC LIMIT 2`,
      [data.deviceId]
    );
    const recentValues = recentRes.rows.map((r) => Number(r.proposed_k_factor));
    const recommendedKFactor = recentValues.reduce((sum, v) => sum + v, 0) / recentValues.length;

    // AC: "Doğrulama alımı sonucu kalibrasyon geçmişine yazılmalıdır."
    await writeAuditLog(client, {
      action: data.verifiesCalibrationCommandId ? 'CALIBRATION_VERIFICATION_PASS_RECORDED' : 'CALIBRATION_TEST_INTAKE_RECORDED',
      targetType: 'hardware_device',
      targetId: data.deviceId,
      afterValue: {
        referenceVolumeLiters: data.referenceVolumeLiters,
        measuredLiters: data.measuredLiters,
        deviationRatio,
        proposedKFactor,
        recommendedKFactor,
        verifiesCalibrationCommandId: data.verifiesCalibrationCommandId ?? null
      }
    });

    return { intake, recommendedKFactor, basedOnSingleMeasurement: recentValues.length < 2 };
  });
}

export async function getCalibrationTestIntakes(deviceId: string): Promise<CalibrationTestIntakeRecord[]> {
  return withTenant(async (client) => {
    const result = await client.query(
      'SELECT * FROM calibration_test_intakes WHERE device_id = $1 ORDER BY created_at DESC',
      [deviceId]
    );
    return result.rows;
  });
}

// ============================================================================
// FUEL-410 — Hibrit Fail-Open Politika Motoru
// ============================================================================

export interface FailOpenPolicyRecord {
  id: string;
  site_name: string | null;
  offline_dispense_allowed: boolean;
  max_liters_per_vehicle: number;
  max_daily_dispenses_per_vehicle: number;
  whitelist_freshness_hours: number;
  fail_close: boolean;
  updated_by: string;
  created_at: string;
}

// Ticket'ın kendi notu: "Varsayılan politika: çevrimdışı izin AÇIK, araç
// başına 200 L, günde 1 alım, whitelist tazeliği 24 saat." Hiçbir tenant/
// şantiye politikası tanımlanmamışsa bu, sistem genelindeki son çare.
const SYSTEM_DEFAULT_FAIL_OPEN_POLICY: Omit<FailOpenPolicyRecord, 'id' | 'updated_by' | 'created_at'> = {
  site_name: null,
  offline_dispense_allowed: true,
  max_liters_per_vehicle: 200,
  max_daily_dispenses_per_vehicle: 1,
  whitelist_freshness_hours: 24,
  fail_close: false
};

/**
 * AC: "Politika tenant ve şantiye bazında tanımlanabilmelidir." Her çağrı
 * YENİ bir versiyon (satır) yaratır — calibration_commands'la AYNI "asla
 * UPDATE edilmeyen geçmiş" deseni; hangi politikanın NE ZAMAN yürürlüğe
 * girdiği hiçbir zaman belirsizleşmez.
 */
export async function setFailOpenPolicy(data: {
  siteName?: string;
  offlineDispenseAllowed: boolean;
  maxLitersPerVehicle: number;
  maxDailyDispensesPerVehicle: number;
  whitelistFreshnessHours: number;
  failClose: boolean;
  updatedByUserId: string;
}): Promise<FailOpenPolicyRecord> {
  return withTenant(async (client, tenantId) => {
    const id = generateId('failpolicy');
    const result = await client.query(
      `INSERT INTO fail_open_policies
         (id, tenant_id, site_name, offline_dispense_allowed, max_liters_per_vehicle, max_daily_dispenses_per_vehicle, whitelist_freshness_hours, fail_close, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        id, tenantId, data.siteName ?? null, data.offlineDispenseAllowed, data.maxLitersPerVehicle,
        data.maxDailyDispensesPerVehicle, data.whitelistFreshnessHours, data.failClose, data.updatedByUserId
      ]
    );

    await writeAuditLog(client, {
      action: 'FAIL_OPEN_POLICY_UPDATED',
      targetType: 'fail_open_policy',
      targetId: data.siteName ?? '(tenant geneli)',
      afterValue: {
        siteName: data.siteName ?? null,
        offlineDispenseAllowed: data.offlineDispenseAllowed,
        maxLitersPerVehicle: data.maxLitersPerVehicle,
        maxDailyDispensesPerVehicle: data.maxDailyDispensesPerVehicle,
        failClose: data.failClose
      }
    });

    return result.rows[0];
  });
}

export async function getFailOpenPolicies(): Promise<FailOpenPolicyRecord[]> {
  return withTenant(async (client) => {
    const result = await client.query('SELECT * FROM fail_open_policies ORDER BY created_at DESC');
    return result.rows;
  });
}

/**
 * Bir şantiye için GEÇERLİ olan politikayı bulur: önce o şantiyeye özel en
 * son satır, yoksa tenant geneli (site_name IS NULL) en son satır, o da
 * yoksa sistem varsayılanı (id='system-default' ile işaretlenir — hiç
 * DB'den gelmedi). `client` parametresi opsiyonel: syncSingleOfflineRecord
 * gibi ZATEN açık bir transaction'ı olan çağıranlar kendi client'ını
 * geçirip GEREKSİZ ikinci bir DB bağlantısı/transaction'ı açmaktan kaçınır.
 */
export async function getEffectiveFailOpenPolicy(siteName: string, existingClient?: import('pg').PoolClient): Promise<FailOpenPolicyRecord> {
  const query = async (client: import('pg').PoolClient) => {
    const siteSpecific = await client.query(
      `SELECT * FROM fail_open_policies WHERE site_name = $1 ORDER BY created_at DESC LIMIT 1`,
      [siteName]
    );
    if (siteSpecific.rows.length > 0) return siteSpecific.rows[0];

    const tenantWide = await client.query(
      `SELECT * FROM fail_open_policies WHERE site_name IS NULL ORDER BY created_at DESC LIMIT 1`
    );
    if (tenantWide.rows.length > 0) return tenantWide.rows[0];

    return { id: 'system-default', updated_by: 'system', created_at: new Date().toISOString(), ...SYSTEM_DEFAULT_FAIL_OPEN_POLICY };
  };

  if (existingClient) return query(existingClient);
  return withTenant((client) => query(client));
}

/** Cihaz GET /telemetry/fail-open-policy'yi her çektiğinde çağrılır — "dağıtım bekliyor" durumunun kaynağı. */
export async function recordFailOpenPolicyDelivery(deviceId: string, policyId: string): Promise<void> {
  return withTenant(async (client) => {
    await client.query('UPDATE hardware_devices SET last_fail_open_policy_id = $1 WHERE device_id = $2', [policyId, deviceId]);
  });
}

/**
 * AC: "Politika değişikliği cihazlara dağıtılıp uygulandığı doğrulanabilmelidir...
 * panelde 'dağıtım bekliyor' durumu gösterilmelidir." Her cihaz için kendi
 * şantiyesinin GEÇERLİ politika id'sini, cihazın EN SON ÇEKTİĞİ id ile
 * karşılaştırır.
 */
export async function getFailOpenPolicyDeploymentStatus(): Promise<Array<{
  deviceId: string;
  siteName: string;
  effectivePolicyId: string;
  lastDeliveredPolicyId: string | null;
  status: 'GÜNCEL' | 'DAĞITIM_BEKLIYOR';
}>> {
  return withTenant(async (client) => {
    const devicesRes = await client.query('SELECT device_id, site_name, last_fail_open_policy_id FROM hardware_devices');
    const results = [];
    for (const device of devicesRes.rows) {
      const effective = await getEffectiveFailOpenPolicy(device.site_name, client);
      results.push({
        deviceId: device.device_id,
        siteName: device.site_name,
        effectivePolicyId: effective.id,
        lastDeliveredPolicyId: device.last_fail_open_policy_id,
        status: (device.last_fail_open_policy_id === effective.id ? 'GÜNCEL' : 'DAĞITIM_BEKLIYOR') as 'GÜNCEL' | 'DAĞITIM_BEKLIYOR'
      });
    }
    return results;
  });
}

// Ticket bir sayı belirtmiyor — %15, "gözle görülür biçimde yüksek ama tek
// bir gecikmiş senkronizasyonla tetiklenmeyecek kadar toleranslı" bir eşik
// olarak seçildi; ileride tenant bazında yapılandırılabilir hale getirilebilir.
const OFFLINE_DISPENSE_RATIO_ALERT_THRESHOLD = 0.15;

/**
 * AC: "Çevrimdışı alım oranı eşiği aşan şantiyeler için uyarı." IOT-303.1'in
 * zaten yazdığı type='Çevrimdışı Senkron' sınıflandırmasını kullanır — yeni
 * bir işaretleme mekanizması GEREKMEDİ.
 */
export async function getOfflineDispenseRatioAlerts(periodDays = 30): Promise<Array<{
  siteName: string;
  totalDispenses: number;
  offlineDispenses: number;
  offlineRatio: number;
}>> {
  return withTenant(async (client) => {
    const result = await client.query(
      `SELECT
         site_name,
         COUNT(*)::int AS total_dispenses,
         COUNT(*) FILTER (WHERE type = 'Çevrimdışı Senkron')::int AS offline_dispenses
       FROM transactions
       WHERE created_at > NOW() - ($1 || ' days')::interval
       GROUP BY site_name`,
      [periodDays]
    );
    return result.rows
      .map((r) => ({
        siteName: r.site_name,
        totalDispenses: r.total_dispenses,
        offlineDispenses: r.offline_dispenses,
        offlineRatio: r.total_dispenses > 0 ? r.offline_dispenses / r.total_dispenses : 0
      }))
      .filter((r) => r.offlineRatio > OFFLINE_DISPENSE_RATIO_ALERT_THRESHOLD);
  });
}

// ============================================================================
// AI-502: GEMİNİ İLE ŞOFÖR/ARAÇ TÜKETİM ANOMALİ ANALİZİ
// ============================================================================

export interface VehicleConsumptionStat {
  vehiclePlate: string;
  driverName: string | null;
  totalLiters: number;
  dispenseCount: number;
  avgLitersPerDispense: number;
  distinctSites: number;
}

/**
 * Trailing `periodDays` içindeki ikmalleri (araç plakası, sürücü) çiftine
 * göre gruplar — ticket hem "aşırı yakan iş makinelerini" (araç) hem
 * "şüpheli şoför tüketimlerini" (sürücü) hedefliyor; aynı aracı farklı
 * şoförlerin kullanması mümkün olduğundan tek bir grup anahtarı ikisini de
 * ayrı ayrı temsil edemezdi.
 */
export async function aggregateVehicleConsumption(periodDays: number): Promise<VehicleConsumptionStat[]> {
  return withTenant(async (client) => {
    const result = await client.query(
      `SELECT
         vehicle_plate,
         driver_name,
         SUM(amount_liters)::numeric AS total_liters,
         COUNT(*)::int AS dispense_count,
         COUNT(DISTINCT site_name)::int AS distinct_sites
       FROM transactions
       WHERE created_at > NOW() - ($1 || ' days')::interval
       GROUP BY vehicle_plate, driver_name
       ORDER BY total_liters DESC`,
      [periodDays]
    );
    return result.rows.map((r) => ({
      vehiclePlate: r.vehicle_plate,
      driverName: r.driver_name,
      totalLiters: Number(r.total_liters),
      dispenseCount: r.dispense_count,
      avgLitersPerDispense: r.dispense_count > 0 ? Number(r.total_liters) / r.dispense_count : 0,
      distinctSites: r.distinct_sites
    }));
  });
}

export interface ConsumptionAnomalyReportRecord {
  id: string;
  tenant_id: string;
  period_days: number;
  period_start: string;
  period_end: string;
  vehicle_count: number;
  anomaly_count: number;
  anomalies: unknown;
  model_name: string;
  generated_by: string;
  created_at: string;
}

/**
 * Yalnızca ZATEN Zod ile doğrulanmış (bkz. consumptionAnomalyService.ts
 * requestAnomalyAnalysis) bir sonuç buraya yazılmalı — bu fonksiyon kendisi
 * bir doğrulama yapmaz, çağıranın sözleşmesine güvenir.
 */
export async function saveConsumptionAnomalyReport(data: {
  periodDays: number;
  periodStart: Date;
  periodEnd: Date;
  vehicleCount: number;
  anomalies: unknown[];
  modelName: string;
  generatedBy: string;
}): Promise<ConsumptionAnomalyReportRecord> {
  return withTenant(async (client, tenantId) => {
    const id = generateId('anomaly');
    const result = await client.query(
      `INSERT INTO consumption_anomaly_reports
         (id, tenant_id, period_days, period_start, period_end, vehicle_count, anomaly_count, anomalies, model_name, generated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING *`,
      [
        id, tenantId, data.periodDays, data.periodStart, data.periodEnd, data.vehicleCount,
        data.anomalies.length, JSON.stringify(data.anomalies), data.modelName, data.generatedBy
      ]
    );
    return result.rows[0];
  });
}

export async function getConsumptionAnomalyReports(): Promise<ConsumptionAnomalyReportRecord[]> {
  return withTenant(async (client) => {
    const result = await client.query(
      'SELECT * FROM consumption_anomaly_reports ORDER BY created_at DESC'
    );
    return result.rows;
  });
}

// ============================================================================
// COMP-601: UBL 2.1 DESPATCHADVICE (E-İRSALİYE TASLAĞI) İÇİN KAYNAK VERİ
// ============================================================================

export interface DespatchAdvicePreparation {
  transactionId: string;
  /** COMP-601.1: boşluksuz sıralı belge numarası (IRS<yıl><9 hane>). */
  documentNumber: string;
  /** COMP-601.1: ETTN — belge başına kalıcı UUID (regenerasyonda AYNI kalır). */
  ettn: string;
  /** Aynı ikmal için e-İrsaliye daha önce üretildiyse true (yeni numara verilmedi). */
  reusedExisting: boolean;
  issueDate: string;
  supplierVkn: string;
  supplierName: string;
  supplierCity: string | null;
  vehiclePlate: string;
  driverTcNo: string;
  /** tanks.fuel_type serbest metni; GTIP çözümü despatchAdviceXmlService'te. */
  fuelType: string;
  amountLiters: number;
}

/**
 * COMP-601.1 — e-İrsaliye üretimi için gereken TÜM veriyi tek transaction
 * içinde toplar VE (ilk kez üretiliyorsa) boşluksuz sıralı belge numarası +
 * ETTN tahsis eder.
 *
 * Alanların hiçbiri transactions tablosunda doğrudan durmuyor:
 *  - VKN / firma adı / şehir → companies (tenant kaydının kendisi)
 *  - Şoför TC → transactions.driver_name'in (serbest metin) drivers'taki AYNI
 *    isimli kayıtla eşleşmesi (FK yok, bkz. createTransaction)
 *  - GTIP → transactions.tank_name'in tanks.fuel_type'ına çözülmesi (sabit
 *    değil, denetim gereği yakıt tipine göre değişir)
 * VKN veya şoför TC eksikse e-İrsaliye üretilemeyeceği için BadRequestError.
 *
 * Belge numarası: Postgres SEQUENCE boşluksuzluğu garanti edemez (rollback'te
 * numara yanar). Bunun yerine tenant+yıl sayaç satırı bu transaction içinde
 * `UPDATE ... +1` ile artırılır — transaction geri alınırsa artış da geri
 * alınır. Eşzamanlılık: tahsis öncesi tenant başına bir advisory-xact-lock
 * alınır, böylece aynı ikmal için gelen iki paralel istek sayacı iki kez
 * artırıp bir numarayı boşa harcayamaz (ikincisi lock'u bekler, sonra
 * mevcut satırı bulup onu döndürür).
 */
export async function prepareDespatchAdvice(
  transactionId: string,
  siteRestriction?: string
): Promise<DespatchAdvicePreparation> {
  return withTenant(async (client, tenantId) => {
    const txRes = await client.query('SELECT * FROM transactions WHERE id = $1', [transactionId]);
    if (txRes.rows.length === 0) throw new NotFoundError('İkmal kaydı bulunamadı.');
    const tx = txRes.rows[0];
    // AUTH-201.4 ile AYNI desen: SITE_MANAGER başka bir şantiyenin ikmal
    // ID'sini tahmin edip e-İrsaliye üretemez. NotFoundError (403 değil) —
    // aksi halde yanıt kodu, ID'nin var olup olmadığını sızdırırdı.
    if (siteRestriction && tx.site_name !== siteRestriction) {
      throw new NotFoundError('İkmal kaydı bulunamadı.');
    }

    const companyRes = await client.query(
      'SELECT tax_number, name, city FROM companies WHERE id = $1',
      [tenantId]
    );
    const supplierVkn: string | null = companyRes.rows[0]?.tax_number ?? null;
    if (!supplierVkn) {
      throw new BadRequestError('Firma VKN (Vergi Kimlik Numarası) bilgisi tanımlı değil, e-İrsaliye üretilemez.');
    }
    const supplierName: string = companyRes.rows[0]?.name ?? 'Bilinmeyen Firma';
    const supplierCity: string | null = companyRes.rows[0]?.city ?? null;

    let driverTcNo: string | null = null;
    if (tx.driver_name) {
      const driverRes = await client.query(
        'SELECT tc_no FROM drivers WHERE tenant_id = $1 AND name = $2 LIMIT 1',
        [tenantId, tx.driver_name]
      );
      driverTcNo = driverRes.rows[0]?.tc_no ?? null;
    }
    if (!driverTcNo) {
      throw new BadRequestError(
        `Bu ikmal kaydındaki sürücü ('${tx.driver_name ?? 'tanımsız'}') sicilde kayıtlı değil (TC kimlik no bulunamadı), e-İrsaliye üretilemez.`
      );
    }

    let fuelType = 'Motorin';
    if (tx.tank_name) {
      const tankRes = await client.query(
        'SELECT fuel_type FROM tanks WHERE tenant_id = $1 AND name = $2 LIMIT 1',
        [tenantId, tx.tank_name]
      );
      if (tankRes.rows[0]?.fuel_type) fuelType = tankRes.rows[0].fuel_type;
    }

    // --- Belge numarası + ETTN tahsisi (idempotent) ---
    const existing = await client.query(
      'SELECT document_number, ettn FROM despatch_advice_documents WHERE transaction_id = $1',
      [transactionId]
    );
    let documentNumber: string;
    let ettn: string;
    let reusedExisting: boolean;
    if (existing.rows.length > 0) {
      documentNumber = existing.rows[0].document_number;
      ettn = existing.rows[0].ettn;
      reusedExisting = true;
    } else {
      // Tenant başına seri tahsisi tek sıraya sok — hangi ikmal için olursa
      // olsun aynı anda iki numara üretilmesin.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('despatch:' || $1))", [tenantId]);
      // Lock'u aldıktan sonra tekrar kontrol et — beklerken başka bir istek
      // bu ikmal için numara vermiş olabilir.
      const recheck = await client.query(
        'SELECT document_number, ettn FROM despatch_advice_documents WHERE transaction_id = $1',
        [transactionId]
      );
      if (recheck.rows.length > 0) {
        documentNumber = recheck.rows[0].document_number;
        ettn = recheck.rows[0].ettn;
        reusedExisting = true;
      } else {
        const year = new Date(tx.created_at).getFullYear();
        await client.query(
          'INSERT INTO despatch_advice_counters (tenant_id, issue_year) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [tenantId, year]
        );
        const bump = await client.query(
          `UPDATE despatch_advice_counters SET last_sequence = last_sequence + 1
           WHERE tenant_id = $1 AND issue_year = $2 RETURNING last_sequence`,
          [tenantId, year]
        );
        const seq: number = bump.rows[0].last_sequence;
        documentNumber = `IRS${year}${String(seq).padStart(9, '0')}`;
        ettn = crypto.randomUUID();
        await client.query(
          `INSERT INTO despatch_advice_documents
             (id, tenant_id, transaction_id, document_number, ettn, issue_year, sequence_no)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [generateId('despatch'), tenantId, transactionId, documentNumber, ettn, year, seq]
        );
        reusedExisting = false;
      }
    }

    return {
      transactionId: tx.id,
      documentNumber,
      ettn,
      reusedExisting,
      issueDate: new Date(tx.created_at).toISOString().slice(0, 10),
      supplierVkn,
      supplierName,
      supplierCity,
      vehiclePlate: tx.vehicle_plate,
      driverTcNo,
      fuelType,
      amountLiters: Number(tx.amount_liters)
    };
  });
}

// ============================================================================
// FUEL-403.1 / FUEL-403.2: TANK DALDIRMA CETVELİ + SEVİYE→HACİM HESABI
// ============================================================================

const STRAPPING_CACHE_TTL_SECONDS = 3600; // referans veri — 1 saat (redis-patterns)

function strappingCacheKey(tenantId: string, tankName: string): string {
  return `tank:strapping:${tenantId}:${tankName}`;
}

/** Route'lar tank'ı :id ile adresliyor (mevcut /tanks/:id deseni); cetvel
 *  fonksiyonları ise name ile çalışır (transactions.tank_name alanı da öyle). */
export async function getTankNameById(tankId: string): Promise<string> {
  return withTenant(async (client) => {
    const r = await client.query('SELECT name FROM tanks WHERE id = $1', [tankId]);
    if (r.rows.length === 0) throw new NotFoundError('Tank bulunamadı.');
    return r.rows[0].name as string;
  });
}

export interface TankVolumeModel {
  source: 'CSV_IMPORT' | 'CYLINDER_FORMULA';
  points: StrappingPoint[] | null;
  cylinderConfig: CylinderConfig | null;
  pointCount: number;
  createdAt: string;
  /** Sıcaklık düzeltmesinde ASTM ürün grubunu seçmek için (cache'e dahil —
   *  computeTankVolume ikinci bir DB round-trip'i yapmasın, AC: <1ms). */
  fuelType: string | null;
}

export interface StrappingTableVersionRecord {
  id: string;
  tenant_id: string;
  tank_name: string;
  source: string;
  points: unknown;
  cylinder_config: unknown;
  point_count: number;
  notes: string | null;
  imported_by: string;
  created_at: string;
}

/**
 * FUEL-403.1 — bir tank için YENİ bir cetvel versiyonu yazar (append-only).
 * `points` verildiyse monotonluk/bütünlük denetlenir; bozuksa satır bazlı
 * hatalarla BadRequestError fırlatılır (AC: "bozuk cetvel sessizce kabul
 * edilmemeli"). Başarıda ilgili tank'ın strapping cache'i invalide edilir.
 */
export async function setTankStrappingTable(
  tankName: string,
  input: { points?: StrappingPointInput[]; cylinderConfig?: CylinderConfig; notes?: string },
  importedByUserId: string
): Promise<{ id: string; source: 'CSV_IMPORT' | 'CYLINDER_FORMULA'; pointCount: number }> {
  return withTenant(async (client, tenantId) => {
    // Tank gerçekten bu tenant'a ait mi? (RLS zaten kısıtlıyor ama net 404 için.)
    const tankRes = await client.query('SELECT 1 FROM tanks WHERE name = $1 LIMIT 1', [tankName]);
    if (tankRes.rows.length === 0) throw new NotFoundError(`'${tankName}' adlı tank bulunamadı.`);

    let source: 'CSV_IMPORT' | 'CYLINDER_FORMULA';
    let pointsJson: string | null = null;
    let cylinderJson: string | null = null;
    let pointCount = 0;

    if (input.cylinderConfig) {
      source = 'CYLINDER_FORMULA';
      cylinderJson = JSON.stringify(input.cylinderConfig);
    } else {
      source = 'CSV_IMPORT';
      const points = input.points ?? [];
      const errors = validateMonotonic(points);
      if (errors.length > 0) {
        throw new BadRequestError('Strapping cetveli doğrulanamadı — bozuk/eksik satırlar var.', { rows: errors });
      }
      pointsJson = JSON.stringify(points);
      pointCount = points.length;
    }

    const id = generateId('strap');
    await client.query(
      `INSERT INTO tank_strapping_tables
         (id, tenant_id, tank_name, source, points, cylinder_config, point_count, notes, imported_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9)`,
      [id, tenantId, tankName, source, pointsJson, cylinderJson, pointCount, input.notes ?? null, importedByUserId]
    );

    await writeAuditLog(client, {
      action: 'TANK_STRAPPING_TABLE_SET',
      targetType: 'tank',
      targetId: tankName,
      afterValue: { source, pointCount }
    });

    // Yeni versiyon → eski cache geçersiz (write-through invalidation).
    await redisPool.cacheDel(strappingCacheKey(tenantId, tankName));

    return { id, source, pointCount };
  });
}

export async function getTankStrappingTableHistory(tankName: string): Promise<StrappingTableVersionRecord[]> {
  return withTenant(async (client) => {
    const res = await client.query(
      'SELECT * FROM tank_strapping_tables WHERE tank_name = $1 ORDER BY created_at DESC',
      [tankName]
    );
    return res.rows;
  });
}

/**
 * FUEL-403.1 AC: "cetvel sorguları <1 ms cache'den dönmeli". Cache-aside:
 * önce Redis, yoksa DB'den EN SON versiyonu çekip cache'le. Cetvel hiç
 * yoksa null döner.
 */
export async function getEffectiveTankVolumeModel(tankName: string): Promise<TankVolumeModel | null> {
  return withTenant(async (client, tenantId) => {
    const cacheKey = strappingCacheKey(tenantId, tankName);
    const cached = await redisPool.cacheGetJson<TankVolumeModel | { __none: true }>(cacheKey);
    if (cached) return '__none' in cached ? null : cached;

    const [res, tankRes] = await Promise.all([
      client.query(
        'SELECT * FROM tank_strapping_tables WHERE tank_name = $1 ORDER BY created_at DESC LIMIT 1',
        [tankName]
      ),
      client.query('SELECT fuel_type FROM tanks WHERE name = $1 LIMIT 1', [tankName])
    ]);
    if (res.rows.length === 0) {
      // "Cetvel yok" durumunu da cache'le — her sorguda DB'ye gitmesin (kısa TTL yeterli).
      await redisPool.cacheSetJson(cacheKey, { __none: true }, 300);
      return null;
    }

    const row = res.rows[0];
    const model: TankVolumeModel = {
      source: row.source,
      points: row.points ?? null,
      cylinderConfig: row.cylinder_config ?? null,
      pointCount: row.point_count,
      createdAt: row.created_at,
      fuelType: (tankRes.rows[0]?.fuel_type as string | undefined) ?? null
    };
    await redisPool.cacheSetJson(cacheKey, model, STRAPPING_CACHE_TTL_SECONDS);
    return model;
  });
}

export interface TankVolumeComputation {
  tankName: string;
  levelMm: number;
  method: 'STRAPPING_INTERPOLATION' | 'CYLINDER_FORMULA';
  observedLiters: number;
  standardLiters: number;
  temperatureCorrected: boolean;
  observedTempC: number | null;
  vcf: number;
  productGroup: string;
  outOfRange: boolean;
  modelVersionAt: string;
}

/**
 * FUEL-403.2 — verilen mm seviyesi (ve varsa sıcaklık) için ham + 15°C
 * standart hacim. Cetvel yoksa NotFoundError. Sıcaklık yoksa standart = ham
 * ve `temperatureCorrected: false` (AC: ölçülmeyen sıcaklık açıkça işaretli).
 */
export async function computeTankVolume(
  tankName: string,
  levelMm: number,
  observedTempC?: number | null,
  density15?: number
): Promise<TankVolumeComputation> {
  const model = await getEffectiveTankVolumeModel(tankName);
  if (!model) {
    throw new NotFoundError(`'${tankName}' için tanımlı bir daldırma cetveli / silindir formülü yok.`);
  }
  const fuelType = model.fuelType;

  const raw =
    model.source === 'CYLINDER_FORMULA'
      ? cylinderVolume(model.cylinderConfig as CylinderConfig, levelMm)
      : interpolateStrappingVolume(model.points as StrappingPoint[], levelMm);

  const std = correctToStandardVolume(raw.observedLiters, observedTempC ?? null, fuelType, density15);

  return {
    tankName,
    levelMm,
    method: raw.method,
    observedLiters: std.observedLiters,
    standardLiters: std.standardLiters,
    temperatureCorrected: std.temperatureCorrected,
    observedTempC: std.observedTempC,
    vcf: std.vcf,
    productGroup: std.productGroup,
    outOfRange: raw.outOfRange,
    modelVersionAt: model.createdAt
  };
}

// ============================================================================
// AUTH-210: RFID KART KAYIP/BLOKAJ VE KARA LİSTE (DENYLIST)
// ============================================================================

const RFID_DENYLIST_CACHE_TTL_SECONDS = 3600;
function rfidDenylistCacheKey(tenantId: string): string {
  return `rfid:denylist:${tenantId}`;
}

/** Denylist'in kompakt sürüm damgası — herhangi bir ekleme/çıkarmada değişir. */
function rfidDenylistVersion(cardUids: string[]): string {
  if (cardUids.length === 0) return 'empty';
  const sorted = [...cardUids].sort();
  return crypto.createHash('sha1').update(sorted.join('|')).digest('hex').slice(0, 16);
}

export interface RfidBlacklistRecord {
  id: string;
  tenant_id: string;
  card_uid: string;
  status: string;
  reason: string | null;
  replaced_by_card_uid: string | null;
  reported_by: string;
  created_at: string;
  updated_at: string;
}

/**
 * Bir kartı kara listeye alır (LOST/BLOCKED) — (tenant, card_uid) için tek
 * satır (ON CONFLICT ile durum/gerekçe güncellenir). Redis SET invalide
 * edilir → sonraki isCardDenied çağrısı DB'den yeniden kurar (AC 1: online
 * cihazlarda 10 sn içinde ret — cache anında geçersiz kılınır).
 */
export async function blockRfidCard(
  data: { cardUid: string; status: 'LOST' | 'BLOCKED'; reason?: string },
  reportedByUserId: string
): Promise<RfidBlacklistRecord> {
  return withTenant(async (client, tenantId) => {
    const res = await client.query(
      `INSERT INTO rfid_card_blacklist (id, tenant_id, card_uid, status, reason, reported_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, card_uid)
       DO UPDATE SET status = EXCLUDED.status, reason = EXCLUDED.reason,
                     reported_by = EXCLUDED.reported_by, replaced_by_card_uid = NULL,
                     updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [generateId('rfidbl'), tenantId, data.cardUid, data.status, data.reason ?? null, reportedByUserId]
    );
    await writeAuditLog(client, {
      action: 'RFID_CARD_BLOCKED',
      targetType: 'rfid_card',
      targetId: data.cardUid,
      afterValue: { status: data.status, reason: data.reason ?? null }
    });
    await redisPool.cacheDel(rfidDenylistCacheKey(tenantId));
    return res.rows[0];
  });
}

/** Kartı kara listeden çıkarır (kart bulundu / yeniden etkinleştirildi). */
export async function unblockRfidCard(cardUid: string, byUserId: string): Promise<{ removed: boolean }> {
  return withTenant(async (client, tenantId) => {
    const res = await client.query(
      'DELETE FROM rfid_card_blacklist WHERE card_uid = $1 RETURNING id',
      [cardUid]
    );
    if (res.rows.length === 0) throw new NotFoundError(`'${cardUid}' kartı kara listede değil.`);
    await writeAuditLog(client, {
      action: 'RFID_CARD_UNBLOCKED',
      targetType: 'rfid_card',
      targetId: cardUid,
      afterValue: { by: byUserId }
    });
    await redisPool.cacheDel(rfidDenylistCacheKey(tenantId));
    return { removed: true };
  });
}

/**
 * Kart değiştirme: eski kartı REPLACED olarak kara listeye alır, drivers/
 * vehicles kayıtlarındaki kart/tag alanını yeni uid'e taşır. transactions
 * geçmişi driver_name/plate ile anahtarlandığından OTOMATİK korunur — bu
 * fonksiyon yalnızca eski→yeni bağını audit'ler ve kartı geçersiz kılar.
 * Yeni kart kendisi kara listedeyse reddedilir.
 */
export async function replaceRfidCard(
  data: { oldCardUid: string; newCardUid: string },
  byUserId: string
): Promise<{ movedDrivers: number; movedVehicles: number }> {
  return withTenant(async (client, tenantId) => {
    const newBlocked = await client.query(
      "SELECT 1 FROM rfid_card_blacklist WHERE card_uid = $1 AND status IN ('LOST','BLOCKED')",
      [data.newCardUid]
    );
    if (newBlocked.rows.length > 0) {
      throw new ConflictError(`Yeni kart '${data.newCardUid}' zaten kara listede — önce onu temizleyin.`, { error: 'NEW_CARD_BLOCKED' });
    }

    const d = await client.query('UPDATE drivers SET rfid_card_id = $2 WHERE rfid_card_id = $1', [data.oldCardUid, data.newCardUid]);
    const v = await client.query('UPDATE vehicles SET rfid_tag = $2 WHERE rfid_tag = $1', [data.oldCardUid, data.newCardUid]);

    await client.query(
      `INSERT INTO rfid_card_blacklist (id, tenant_id, card_uid, status, reason, replaced_by_card_uid, reported_by)
       VALUES ($1,$2,$3,'REPLACED',$4,$5,$6)
       ON CONFLICT (tenant_id, card_uid)
       DO UPDATE SET status = 'REPLACED', replaced_by_card_uid = EXCLUDED.replaced_by_card_uid,
                     reason = EXCLUDED.reason, reported_by = EXCLUDED.reported_by, updated_at = CURRENT_TIMESTAMP`,
      [generateId('rfidbl'), tenantId, data.oldCardUid, `Kart değiştirildi → ${data.newCardUid}`, data.newCardUid, byUserId]
    );

    await writeAuditLog(client, {
      action: 'RFID_CARD_REPLACED',
      targetType: 'rfid_card',
      targetId: data.oldCardUid,
      afterValue: { newCardUid: data.newCardUid, movedDrivers: d.rowCount ?? 0, movedVehicles: v.rowCount ?? 0 }
    });
    await redisPool.cacheDel(rfidDenylistCacheKey(tenantId));
    return { movedDrivers: d.rowCount ?? 0, movedVehicles: v.rowCount ?? 0 };
  });
}

export async function getRfidDenylist(): Promise<RfidBlacklistRecord[]> {
  return withTenant(async (client) => {
    const res = await client.query('SELECT * FROM rfid_card_blacklist ORDER BY updated_at DESC');
    return res.rows;
  });
}

/**
 * AUTH-210 AC: "Denylist WHITELIST'TEN ÖNCE değerlendirilir." Cache-aside:
 * Redis SET'te SISMEMBER (O(1)); miss'te DB'den kurulur. LOST/BLOCKED ve
 * REPLACED kartların hepsi reddedilir (değiştirilmiş kart artık geçersiz).
 */
export async function isCardDenied(cardUid: string): Promise<boolean> {
  return withTenant(async (client, tenantId) => cardDeniedWithClient(client, tenantId, cardUid));
}

/**
 * isCardDenied'in çekirdeği — authorizeDispenseRequest zaten açık bir
 * withTenant client'ına sahip olduğundan onu doğrudan çağırır (iç içe
 * withTenant / ikinci bir bağlantı açmamak için).
 */
export async function cardDeniedWithClient(
  client: import('pg').PoolClient,
  tenantId: string,
  cardUid: string
): Promise<boolean> {
  const key = rfidDenylistCacheKey(tenantId);
  try {
    if ((await redisPool.client.exists(key)) === 1) {
      return (await redisPool.client.sismember(key, cardUid)) === 1;
    }
  } catch {
    // Redis erişilemez → DB otoritedir.
  }
  const res = await client.query('SELECT card_uid FROM rfid_card_blacklist');
  const uids: string[] = res.rows.map((r) => r.card_uid);
  try {
    if (uids.length > 0) {
      await redisPool.client.sadd(key, ...uids);
      await redisPool.client.expire(key, RFID_DENYLIST_CACHE_TTL_SECONDS);
    }
  } catch {
    /* cache yazılamadı — sorun değil */
  }
  return uids.includes(cardUid);
}

/** Cihazın çekeceği denylist: sürüm + reddedilen kart uid'leri. */
export async function getRfidDenylistForDevice(): Promise<{ version: string; deniedCardUids: string[] }> {
  return withTenant(async (client) => {
    const res = await client.query('SELECT card_uid FROM rfid_card_blacklist ORDER BY card_uid');
    const deniedCardUids: string[] = res.rows.map((r) => r.card_uid);
    return { version: rfidDenylistVersion(deniedCardUids), deniedCardUids };
  });
}

/** Cihaz denylist'i çektiğinde sürüm + zaman damgası kaydedilir. */
export async function recordRfidDenylistPull(deviceId: string, version: string): Promise<void> {
  return withTenant(async (client) => {
    await client.query(
      'UPDATE hardware_devices SET last_rfid_denylist_version = $2, last_rfid_denylist_pull_at = CURRENT_TIMESTAMP WHERE device_id = $1',
      [deviceId, version]
    );
  });
}

/**
 * AUTH-210 AC 3: "Blok komutunu alamayan cihazlar panelde uyarı olarak
 * işaretlenmelidir." FUEL-410 deployment-status ile AYNI desen: her cihazın
 * en son çektiği denylist sürümü GÜNCEL sürümle karşılaştırılır.
 */
export async function getRfidDenylistDeploymentStatus(): Promise<Array<{
  deviceId: string;
  siteName: string;
  currentVersion: string;
  lastPulledVersion: string | null;
  lastPulledAt: string | null;
  status: 'GÜNCEL' | 'DAĞITIM_BEKLIYOR';
}>> {
  return withTenant(async (client) => {
    const [uidsRes, devicesRes] = await Promise.all([
      client.query('SELECT card_uid FROM rfid_card_blacklist ORDER BY card_uid'),
      client.query('SELECT device_id, site_name, last_rfid_denylist_version, last_rfid_denylist_pull_at FROM hardware_devices')
    ]);
    const version = rfidDenylistVersion(uidsRes.rows.map((r) => r.card_uid));
    return devicesRes.rows.map((d) => ({
      deviceId: d.device_id,
      siteName: d.site_name,
      currentVersion: version,
      lastPulledVersion: d.last_rfid_denylist_version,
      lastPulledAt: d.last_rfid_denylist_pull_at,
      status: (d.last_rfid_denylist_version === version ? 'GÜNCEL' : 'DAĞITIM_BEKLIYOR') as 'GÜNCEL' | 'DAĞITIM_BEKLIYOR'
    }));
  });
}

// ============================================================================
// FUEL-402.1: ARAÇ/ŞANTİYE/DÖNEM BAZLI YAKIT KOTASI + DÖNEMSEL SIFIRLAMA
// ============================================================================

const QUOTA_BALANCE_CACHE_TTL_SECONDS = 5;

export interface FuelQuotaRecord {
  id: string;
  tenant_id: string;
  vehicle_plate: string | null;
  site_name: string | null;
  period_type: QuotaPeriodType;
  limit_liters: string;
  carryover_policy: CarryoverPolicy;
  period_start: string;
  period_end: string;
  carried_over_liters: string;
  valid_from: string;
  valid_until: string | null;
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export async function createFuelQuota(data: {
  vehiclePlate?: string;
  siteName?: string;
  periodType: QuotaPeriodType;
  limitLiters: number;
  carryoverPolicy: CarryoverPolicy;
  validFrom?: string;
  validUntil?: string;
}, createdByUserId: string): Promise<FuelQuotaRecord> {
  return withTenant(async (client, tenantId) => {
    const now = new Date();
    const validFrom = data.validFrom ? new Date(`${data.validFrom}T00:00:00Z`) : now;
    const validUntil = data.validUntil ? new Date(`${data.validUntil}T00:00:00Z`) : null;
    const win = periodWindowFor(data.periodType, now, { validFrom, validUntil });

    const res = await client.query(
      `INSERT INTO fuel_quotas
         (id, tenant_id, vehicle_plate, site_name, period_type, limit_liters, carryover_policy,
          period_start, period_end, carried_over_liters, valid_from, valid_until, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$11,$12) RETURNING *`,
      [
        generateId('quota'), tenantId, data.vehiclePlate ?? null, data.siteName ?? null,
        data.periodType, data.limitLiters, data.carryoverPolicy,
        win.periodStart.toISOString(), win.periodEnd.toISOString(),
        data.validFrom ?? now.toISOString().slice(0, 10), data.validUntil ?? null, createdByUserId
      ]
    );
    await writeAuditLog(client, {
      action: 'FUEL_QUOTA_CREATED',
      targetType: 'fuel_quota',
      targetId: res.rows[0].id,
      afterValue: { periodType: data.periodType, limitLiters: data.limitLiters, vehiclePlate: data.vehiclePlate ?? null, siteName: data.siteName ?? null }
    });
    return res.rows[0];
  });
}

export async function getFuelQuotas(): Promise<FuelQuotaRecord[]> {
  return withTenant(async (client) => {
    const res = await client.query('SELECT * FROM fuel_quotas ORDER BY created_at DESC');
    return res.rows;
  });
}

export async function getFuelQuota(quotaId: string): Promise<FuelQuotaRecord> {
  return withTenant(async (client) => {
    const res = await client.query('SELECT * FROM fuel_quotas WHERE id = $1', [quotaId]);
    if (res.rows.length === 0) throw new NotFoundError('Kota bulunamadı.');
    return res.rows[0];
  });
}

export async function updateFuelQuota(
  quotaId: string,
  data: { limitLiters?: number; carryoverPolicy?: CarryoverPolicy; status?: string },
  byUserId: string
): Promise<FuelQuotaRecord> {
  return withTenant(async (client) => {
    const sets: string[] = [];
    const params: any[] = [];
    if (data.limitLiters !== undefined) { params.push(data.limitLiters); sets.push(`limit_liters = $${params.length}`); }
    if (data.carryoverPolicy !== undefined) { params.push(data.carryoverPolicy); sets.push(`carryover_policy = $${params.length}`); }
    if (data.status !== undefined) { params.push(data.status); sets.push(`status = $${params.length}`); }
    if (sets.length === 0) throw new BadRequestError('Güncellenecek alan yok.');
    params.push(quotaId);
    const res = await client.query(
      `UPDATE fuel_quotas SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (res.rows.length === 0) throw new NotFoundError('Kota bulunamadı.');
    await writeAuditLog(client, { action: 'FUEL_QUOTA_UPDATED', targetType: 'fuel_quota', targetId: quotaId, afterValue: { ...data, by: byUserId } });
    await redisPool.cacheDel(`quota:balance:${res.rows[0].tenant_id}:${quotaId}`);
    return res.rows[0];
  });
}

export interface QuotaBalance {
  quotaId: string;
  periodType: QuotaPeriodType;
  periodStart: string;
  periodEnd: string;
  baseLimitLiters: number;
  carriedOverLiters: number;
  effectiveLimitLiters: number;
  consumedLiters: number;
  reservedLiters: number;
  remainingLiters: number;
  computedAt: string;
}

/**
 * FUEL-402.1 — kalan kota. Kritik Not: "rezerve ama tamamlanmamış ikmal
 * 'kullanımda' sayılır; kalan = tanımlı − tamamlanan − rezerve".
 *  - consumed: mevcut dönem penceresinde, kotanın kapsamına uyan
 *    transactions'ın SUM(amount_liters)'i (CANLI hesap).
 *  - reserved: kapsam eşleşen AKTİF dispense oturumlarının maxAllowedLiters
 *    toplamı (pesimist rezervasyon).
 * Sonuç QUOTA_BALANCE_CACHE_TTL_SECONDS boyunca cache'lenir (AC: "with cache").
 */
export async function getQuotaBalance(quotaId: string): Promise<QuotaBalance> {
  return withTenant(async (client, tenantId) => {
    const cacheKey = `quota:balance:${tenantId}:${quotaId}`;
    const cached = await redisPool.cacheGetJson<QuotaBalance>(cacheKey);
    if (cached) return cached;

    const qRes = await client.query('SELECT * FROM fuel_quotas WHERE id = $1', [quotaId]);
    if (qRes.rows.length === 0) throw new NotFoundError('Kota bulunamadı.');
    const q = qRes.rows[0] as FuelQuotaRecord;

    const consRes = await client.query(
      `SELECT COALESCE(SUM(amount_liters), 0)::numeric AS c
         FROM transactions
        WHERE created_at >= $1 AND created_at < $2
          AND ($3::text IS NULL OR vehicle_plate = $3)
          AND ($4::text IS NULL OR site_name = $4)`,
      [q.period_start, q.period_end, q.vehicle_plate, q.site_name]
    );
    const consumedLiters = Number(consRes.rows[0].c);

    const sessions = await listActiveSessions();
    const reservedLiters = sessions
      .filter((s) => s.tenantId === tenantId)
      .filter((s) => (!q.vehicle_plate || s.vehiclePlate === q.vehicle_plate) && (!q.site_name || s.siteName === q.site_name))
      .reduce((sum, s) => sum + Number(s.maxAllowedLiters || 0), 0);

    const baseLimitLiters = Number(q.limit_liters);
    const carriedOverLiters = Number(q.carried_over_liters);
    const effectiveLimitLiters = round2(baseLimitLiters + carriedOverLiters);
    const remainingLiters = round2(effectiveLimitLiters - consumedLiters - reservedLiters);

    const balance: QuotaBalance = {
      quotaId,
      periodType: q.period_type,
      periodStart: q.period_start,
      periodEnd: q.period_end,
      baseLimitLiters,
      carriedOverLiters,
      effectiveLimitLiters,
      consumedLiters: round2(consumedLiters),
      reservedLiters: round2(reservedLiters),
      remainingLiters,
      computedAt: new Date().toISOString()
    };
    await redisPool.cacheSetJson(cacheKey, balance, QUOTA_BALANCE_CACHE_TTL_SECONDS);
    return balance;
  });
}

export async function getQuotaHistory(quotaId: string): Promise<any[]> {
  return withTenant(async (client) => {
    const res = await client.query(
      'SELECT * FROM fuel_quota_history WHERE quota_id = $1 ORDER BY closed_at DESC',
      [quotaId]
    );
    return res.rows;
  });
}

/**
 * FUEL-402.1 — mevcut tenant context'i için dönem sonu geçmiş AKTİF kotaları
 * sıfırlar: kapanan dönemi fuel_quota_history'ye snapshot'lar, devir
 * (carryover) politikasını uygular, pencereyi bir sonraki döneme kaydırır.
 * ONE_TIME kotalar sıfırlanmaz — süresi geçmişse PASİF yapılır.
 * index.ts'teki sweep her tenant için runWithTenant içinde bunu çağırır.
 */
export async function resetDueQuotasForCurrentTenant(): Promise<{ reset: number; expired: number }> {
  return withTenant(async (client, tenantId) => {
    const dueRes = await client.query(
      `SELECT * FROM fuel_quotas WHERE status = 'AKTİF' AND period_end <= NOW()`
    );
    let reset = 0;
    let expired = 0;

    for (const q of dueRes.rows as FuelQuotaRecord[]) {
      if (q.period_type === 'ONE_TIME') {
        await client.query('UPDATE fuel_quotas SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [q.id, 'PASİF']);
        expired++;
        continue;
      }

      const consRes = await client.query(
        `SELECT COALESCE(SUM(amount_liters), 0)::numeric AS c FROM transactions
          WHERE created_at >= $1 AND created_at < $2
            AND ($3::text IS NULL OR vehicle_plate = $3)
            AND ($4::text IS NULL OR site_name = $4)`,
        [q.period_start, q.period_end, q.vehicle_plate, q.site_name]
      );
      const consumed = Number(consRes.rows[0].c);
      const baseLimit = Number(q.limit_liters);
      const effectiveLimit = baseLimit + Number(q.carried_over_liters);
      const carryToNext = computeCarryover(q.carryover_policy, baseLimit, effectiveLimit, consumed);

      await client.query(
        `INSERT INTO fuel_quota_history
           (id, tenant_id, quota_id, period_start, period_end, effective_limit_liters, consumed_liters, carried_over_to_next_liters)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [generateId('quotahist'), tenantId, q.id, q.period_start, q.period_end, effectiveLimit, consumed, carryToNext]
      );

      const nextWin = nextPeriodWindow(q.period_type, {
        periodStart: new Date(q.period_start),
        periodEnd: new Date(q.period_end)
      });
      await client.query(
        `UPDATE fuel_quotas
            SET period_start = $2, period_end = $3, carried_over_liters = $4, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [q.id, nextWin.periodStart.toISOString(), nextWin.periodEnd.toISOString(), carryToNext]
      );
      await redisPool.cacheDel(`quota:balance:${tenantId}:${q.id}`);
      reset++;
    }
    return { reset, expired };
  });
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
