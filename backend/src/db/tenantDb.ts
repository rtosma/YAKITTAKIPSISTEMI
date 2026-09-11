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
import { validateTaxId } from '../compliance/taxIdValidation';
import { getEInvoiceObligation } from '../services/taxpayerRegistryService';
import { areFuelTypesCompatible, resolveFuelType } from '../fuel/fuelTypes';
import { checkMeterReading, resolveMeterType, type MeterType } from '../fleet/meterValidation';
import { generateDespatchAdviceXml } from '../compliance/despatchAdviceXmlService';
import { getIntegratorAdapter } from '../compliance/integratorAdapter';

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
  fuel_type: string | null;
  meter_type: string | null;
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
  package: string;
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
      `SELECT id, name, tax_number, code, city, license_status, license_expiry, modules, package
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
      package: c.package || 'TEMEL',
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
      assigned_driver_name: row.assigned_driver_name,
      fuel_type: row.fuel_type ?? null,
      meter_type: row.meter_type ?? null
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
      `INSERT INTO vehicles (id, tenant_id, plate, brand_model, vehicle_type, rfid_tag, site_name, status, fuel_capacity_liters, assigned_driver_name, fuel_type, meter_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [id, tenantId, data.plate, data.brand_model, data.vehicle_type, data.rfid_tag, data.site_name, data.status, data.fuel_capacity_liters ?? null, assignedDriverName, data.fuel_type ?? null, data.meter_type ?? null]
    );
    return result.rows[0];
  });
}

export async function updateVehicle(id: string, data: Partial<VehicleRecord>): Promise<VehicleRecord> {
  return withTenant(async (client) => {
    const fields: Array<{ column: string; value: unknown }> = [];

    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (['plate', 'brand_model', 'vehicle_type', 'rfid_tag', 'site_name', 'status', 'fuel_capacity_liters', 'fuel_type', 'meter_type'].includes(key)) {
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
    let txFuelType: string | null = null;
    if (data.tank_name) {
      const tankResult = await client.query(
        'SELECT id, capacity_liters, current_level_liters, fuel_type FROM tanks WHERE name = $1 FOR UPDATE',
        [data.tank_name]
      );

      if (tankResult.rows.length > 0) {
        const tank = tankResult.rows[0];
        txFuelType = tank.fuel_type ?? null;
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
      `INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, driver_name, tank_name, amount_liters, flow_rate_lpm, pump_status, type, rfid_auth, fuel_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [
        id, tenantId, data.site_name, data.vehicle_plate, data.driver_name ?? null, data.tank_name ?? null,
        data.amount_liters, data.flow_rate_lpm ?? null, data.pump_status || 'TAMAMLANTI', data.type || 'Manuel',
        data.rfid_auth ?? true, txFuelType
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
  /** FUEL-407: ikmalin yakıt tipi (tanktan) — oturum/transaction taşır. */
  tankFuelType: string | null;
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
  deviceId?: string;
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
      'SELECT id, plate, status, site_name, fuel_capacity_liters, fuel_type FROM vehicles WHERE assigned_driver_name = $1',
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

    // 3.4 FLEET-1406 — araç bazlı dönemsel yakıt limiti. Bu, çapraz şantiye
    // kotasından FARKLI bir kavramdır (Kritik Not) — ikisi BİRLİKTE
    // değerlendirilir, en kısıtlayıcı olan kazanır (aşağıdaki Math.min).
    const limitRes = await client.query(`SELECT * FROM vehicle_fuel_limits WHERE vehicle_id = $1 AND status = 'AKTİF'`, [vehicle.id]);
    if (limitRes.rows.length > 0) {
      const limit = limitRes.rows[0];
      const { periodStart, periodEnd } = periodWindowFor(limit.period_type, new Date());
      const limitConsRes = await client.query(
        `SELECT COALESCE(SUM(amount_liters), 0)::numeric AS c FROM transactions
          WHERE vehicle_plate = $1 AND created_at >= $2 AND created_at < $3`,
        [vehicle.plate, periodStart.toISOString(), periodEnd.toISOString()]
      );
      const consumed = Number(limitConsRes.rows[0].c);
      const tempActive = !!(limit.temp_increase_liters && limit.temp_increase_until && new Date(limit.temp_increase_until) >= new Date());
      const effectiveLimit = Number(limit.limit_liters) + (tempActive ? Number(limit.temp_increase_liters) : 0);
      const limitRemaining = effectiveLimit - consumed;

      if (limit.enforcement === 'REJECT') {
        if (limitRemaining <= 0) {
          throw new ConflictError(
            `'${vehicle.plate}' plakalı aracın ${limit.period_type} yakıt limiti (${effectiveLimit} L) doldu.`,
            { error: 'VEHICLE_FUEL_LIMIT_EXCEEDED', limitLiters: effectiveLimit, consumedLiters: round2(consumed) }
          );
        }
        maxAllowedLiters = Math.min(maxAllowedLiters, limitRemaining);
      } else if (limitRemaining <= 0) {
        // 'WARN' — ikmali ENGELLEMEZ, yalnızca AI-507 birleşik alarmına düşer.
        await raiseAlarm(client, tenantId, {
          alarmKey: `VEHICLE_LIMIT_EXCEEDED:${vehicle.id}`,
          category: 'VEHICLE_LIMIT_EXCEEDED',
          severity: 'WARNING',
          title: `Araç yakıt limiti aşıldı (uyarı modu): ${vehicle.plate} (${round2(consumed)}/${effectiveLimit} L)`,
          siteName: vehicle.site_name,
          subjectType: 'VEHICLE',
          subjectId: vehicle.plate,
          detail: { periodType: limit.period_type, limitLiters: effectiveLimit, consumedLiters: round2(consumed) }
        });
      }
    }

    // 3.5 FUEL-407 — pompa-tank eşlemesi. Bu cihaz bir tanka bağlıysa ve
    // istekteki tankName ondan farklıysa yanlış yapılandırma/manipülasyon
    // vardır; reddet. (Eşleme yoksa istekteki tankName olduğu gibi kullanılır.)
    if (input.deviceId) {
      const devRes = await client.query(
        'SELECT tank_name FROM hardware_devices WHERE device_id = $1',
        [input.deviceId]
      );
      const mappedTank: string | null = devRes.rows[0]?.tank_name ?? null;
      if (mappedTank && mappedTank !== input.tankName) {
        throw new ConflictError(
          `Pompa '${input.deviceId}' '${mappedTank}' tankına bağlı ama istek '${input.tankName}' tankını gösteriyor.`,
          { error: 'DEVICE_TANK_MISMATCH', mappedTank, requestedTank: input.tankName }
        );
      }
    }

    // 4. Tank bu şantiyede var mı, seviyesi yeterli mi?
    const tankRes = await client.query(
      'SELECT current_level_liters, fuel_type FROM tanks WHERE name = $1 AND site_name = $2',
      [input.tankName, input.deviceSiteName]
    );
    if (tankRes.rows.length === 0) {
      throw new NotFoundError(`'${input.tankName}' tankı '${input.deviceSiteName}' şantiyesinde bulunamadı.`, { error: 'TANK_NOT_FOUND' });
    }
    const tankFuelType: string | null = tankRes.rows[0].fuel_type ?? null;

    // 4.5 FUEL-407 AC: "Araç yakıt tipi uyuşmazlığında ikmal reddedilmelidir."
    if (!areFuelTypesCompatible(vehicle.fuel_type, tankFuelType)) {
      throw new ForbiddenError(
        `Yanlış yakıt tipi: '${vehicle.plate}' aracı '${vehicle.fuel_type}' alır, '${input.tankName}' tankı '${tankFuelType}' içerir.`,
        { error: 'FUEL_TYPE_MISMATCH', vehicleFuelType: vehicle.fuel_type, tankFuelType }
      );
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
      maxAllowedLiters,
      tankFuelType
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
    let finalizeFuelType: string | null = null;
    if (data.tankName) {
      const tankResult = await client.query(
        'SELECT id, capacity_liters, current_level_liters, fuel_type FROM tanks WHERE name = $1 AND site_name = $2 FOR UPDATE',
        [data.tankName, data.siteName]
      );
      if (tankResult.rows.length > 0) {
        const tank = tankResult.rows[0];
        finalizeFuelType = tank.fuel_type ?? null;
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
         (id, tenant_id, site_name, vehicle_plate, driver_name, tank_name, amount_liters, flow_rate_lpm, pump_status, type, rfid_auth, idempotency_key, hash_signature, verification_status, fuel_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [
        id, tenantId, data.siteName, data.vehiclePlate, data.driverName, data.tankName,
        totalizerLiters, data.flowRateLpm, 'TAMAMLANTI', 'Otomatik', true,
        data.idempotencyKey, hashSignature, needsVerification ? 'DOĞRULAMA_BEKLIYOR' : 'DOĞRULANDI', finalizeFuelType
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
  // COMP-605 — alıcı (mükellef) doğrulaması. recipientTaxId verilmediyse
  // hepsi null/varsayılan (öz filo teslimi — ayrı bir alıcı yok).
  recipientTaxId: string | null;
  recipientTitle: string | null;
  recipientObligated: boolean | null;
  /** 'ELEKTRONIK' (alıcı e-İrsaliye mükellefi) | 'KAGIT' (değil → kağıt süreç). */
  deliveryMode: 'ELEKTRONIK' | 'KAGIT';
  /** Alıcı kaydında eksik zorunlu alanlar (unvan/adres/vergi dairesi). */
  recipientWarnings: string[];
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
  siteRestriction?: string,
  recipientTaxId?: string | null
): Promise<DespatchAdvicePreparation> {
  return withTenant((client, tenantId) => prepareDespatchAdviceCore(client, tenantId, transactionId, siteRestriction, recipientTaxId));
}

interface DespatchAdviceDerivedFields {
  tx: any;
  supplierVkn: string;
  supplierName: string;
  supplierCity: string | null;
  driverTcNo: string;
  fuelType: string;
  recipientTaxIdNorm: string | null;
  recipientTitle: string | null;
  recipientObligated: boolean | null;
  deliveryMode: 'ELEKTRONIK' | 'KAGIT';
  recipientWarnings: string[];
}

/**
 * Belge NUMARASI/ETTN dışındaki TÜM iş alanlarını (VKN, şoför, yakıt tipi,
 * alıcı mükellefiyet doğrulaması) türetir. COMP-603'ün `resubmitDespatchAdvice`
 * fonksiyonu da (belge no tahsisi hariç, AYNI türetmeyle) bunu çağırır — iki
 * kez yazılmasın diye `prepareDespatchAdviceCore`'dan ayrıştırıldı.
 */
async function deriveDespatchAdviceFields(
  client: any,
  tenantId: string,
  transactionId: string,
  siteRestriction?: string,
  recipientTaxId?: string | null
): Promise<DespatchAdviceDerivedFields> {
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

  // --- COMP-605: alıcı (mükellef) doğrulaması ---
  let recipientTaxIdNorm: string | null = null;
  let recipientTitle: string | null = null;
  let recipientObligated: boolean | null = null;
  let deliveryMode: 'ELEKTRONIK' | 'KAGIT' = 'ELEKTRONIK';
  const recipientWarnings: string[] = [];
  if (recipientTaxId) {
    const v = validateTaxId(recipientTaxId);
    if (!v.ok) {
      throw new BadRequestError(
        `Alıcı VKN/TCKN geçersiz — belge kesilemez: ${v.reason}`,
        { error: 'INVALID_RECIPIENT_TAX_ID', taxId: v.normalized }
      );
    }
    recipientTaxIdNorm = v.normalized;
    const rec = await client.query('SELECT * FROM recipient_taxpayers WHERE tax_id = $1', [recipientTaxIdNorm]);
    const oblig = await getEInvoiceObligation(recipientTaxIdNorm);
    recipientObligated = oblig.obligated;
    if (rec.rows.length > 0) {
      const r = rec.rows[0] as RecipientTaxpayerRecord;
      recipientTitle = r.title;
      if (Array.isArray(r.missing_fields) && r.missing_fields.length > 0) {
        recipientWarnings.push(`Alıcı kaydında eksik alan(lar): ${r.missing_fields.join(', ')}.`);
      }
      // Mükellefiyet bilgisini kayıtta da tazele.
      await client.query(
        `UPDATE recipient_taxpayers SET is_einvoice_obligated = $2, obligation_checked_at = CURRENT_TIMESTAMP, obligation_source = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [r.id, oblig.obligated, oblig.source]
      );
    } else {
      recipientWarnings.push('Alıcı sistemde kayıtlı değil — POST /recipients ile unvan/adres/vergi dairesi bilgilerini kaydedin.');
    }
    if (!oblig.obligated) {
      deliveryMode = 'KAGIT';
      recipientWarnings.push('Alıcı e-İrsaliye mükellefi DEĞİL — elektronik belge kesilemez, KAĞIT süreç işaretlendi (Kritik Not).');
    }
  }

  return { tx, supplierVkn, supplierName, supplierCity, driverTcNo, fuelType, recipientTaxIdNorm, recipientTitle, recipientObligated, deliveryMode, recipientWarnings };
}

/**
 * COMP-603: bir ikmal için AKTİF (henüz supersede edilmemiş) e-İrsaliye
 * belgesini bulur. Bir belge reddedilip/iptal edilip yeniden gönderildiğinde
 * ORİJİNAL satır supersede edilir ve YENİ bir despatch_advice_documents
 * satırı "aktif" olur — bu yüzden artık transaction_id ile TEK bir satır
 * garanti edilemez (bkz. schema.sql'deki kısmi UNIQUE index: yalnızca
 * is_correction=false olan satır tekildir). Zincir uzunluğu pratikte 1-2
 * düzeltmeyi geçmez; sonsuz döngüye karşı üst sınır 10.
 */
async function resolveActiveDespatchAdviceDocument(client: any, tenantId: string, transactionId: string): Promise<any | null> {
  let doc = (
    await client.query(
      `SELECT d.*, COALESCE(s.status, 'ISSUED') AS lifecycle_status, s.superseded_by_document_id
         FROM despatch_advice_documents d
         LEFT JOIN despatch_advice_documents_status s ON s.despatch_advice_document_id = d.id
        WHERE d.tenant_id = $1 AND d.transaction_id = $2 AND d.is_correction = false`,
      [tenantId, transactionId]
    )
  ).rows[0];
  if (!doc) return null;
  for (let hops = 0; hops < 10 && doc.superseded_by_document_id; hops++) {
    const next = (
      await client.query(
        `SELECT d.*, COALESCE(s.status, 'ISSUED') AS lifecycle_status, s.superseded_by_document_id
           FROM despatch_advice_documents d
           LEFT JOIN despatch_advice_documents_status s ON s.despatch_advice_document_id = d.id
          WHERE d.id = $1`,
        [doc.superseded_by_document_id]
      )
    ).rows[0];
    if (!next) break;
    doc = next;
  }
  return doc;
}

/**
 * `prepareDespatchAdvice`'ın çekirdeği — `client`'ı çağırandan alır. COMP-602.1
 * bunu KENDİ withTenant transaction'ının İÇİNDEN çağırır (belge numarası
 * tahsisi + kuyruğa alma tek bir atomik transaction'da olsun diye — AI-507'nin
 * raiseAlarm(client, tenantId, spec) ile AYNI kompozisyon deseni).
 */
async function prepareDespatchAdviceCore(
  client: any,
  tenantId: string,
  transactionId: string,
  siteRestriction?: string,
  recipientTaxId?: string | null
): Promise<DespatchAdvicePreparation> {
  const f = await deriveDespatchAdviceFields(client, tenantId, transactionId, siteRestriction, recipientTaxId);
  let { deliveryMode, recipientTaxIdNorm } = f;

  // --- Belge numarası + ETTN tahsisi (idempotent, AKTİF belgeyi arar) ---
  const active = await resolveActiveDespatchAdviceDocument(client, tenantId, transactionId);
  let documentNumber: string;
  let ettn: string;
  let reusedExisting: boolean;
  if (active) {
    documentNumber = active.document_number;
    ettn = active.ettn;
    reusedExisting = true;
    // Yeniden üretim: kesimdeki teslim yöntemi/alıcı KORUNUR (belge no gibi
    // değişmez); yeni bir recipientTaxId ile çağrılsa bile.
    deliveryMode = (active.delivery_mode as 'ELEKTRONIK' | 'KAGIT') ?? deliveryMode;
    recipientTaxIdNorm = active.recipient_tax_id ?? recipientTaxIdNorm;
  } else {
    // Tenant başına seri tahsisi tek sıraya sok — hangi ikmal için olursa
    // olsun aynı anda iki numara üretilmesin.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('despatch:' || $1))", [tenantId]);
    // Lock'u aldıktan sonra tekrar kontrol et — beklerken başka bir istek
    // bu ikmal için numara vermiş olabilir.
    const recheck = await resolveActiveDespatchAdviceDocument(client, tenantId, transactionId);
    if (recheck) {
      documentNumber = recheck.document_number;
      ettn = recheck.ettn;
      reusedExisting = true;
      deliveryMode = (recheck.delivery_mode as 'ELEKTRONIK' | 'KAGIT') ?? deliveryMode;
      recipientTaxIdNorm = recheck.recipient_tax_id ?? recipientTaxIdNorm;
    } else {
      const allocated = await allocateDespatchAdviceDocumentNumber(client, tenantId, f.tx, recipientTaxIdNorm, deliveryMode, false, null);
      documentNumber = allocated.documentNumber;
      ettn = allocated.ettn;
      reusedExisting = false;
    }
  }

  return {
    transactionId: f.tx.id,
    documentNumber,
    ettn,
    reusedExisting,
    issueDate: new Date(f.tx.created_at).toISOString().slice(0, 10),
    supplierVkn: f.supplierVkn,
    supplierName: f.supplierName,
    supplierCity: f.supplierCity,
    vehiclePlate: f.tx.vehicle_plate,
    driverTcNo: f.driverTcNo,
    fuelType: f.fuelType,
    amountLiters: Number(f.tx.amount_liters),
    recipientTaxId: recipientTaxIdNorm,
    recipientTitle: f.recipientTitle,
    recipientObligated: f.recipientObligated,
    deliveryMode,
    recipientWarnings: f.recipientWarnings
  };
}

/**
 * Boşluksuz sıralı belge no + kalıcı ETTN tahsis edip yeni bir
 * despatch_advice_documents satırı ekler. `isCorrection`/`correctsDocumentId`
 * COMP-603'ün yeniden gönderim akışı için — normal ilk kesimde ikisi de
 * false/null'dur. Çağıran, tahsisten ÖNCE advisory-lock almış olmalıdır
 * (prepareDespatchAdviceCore) VEYA zaten tekil bir durum makinesi geçişiyle
 * korunuyor olmalıdır (resubmitDespatchAdvice — status satırı FOR UPDATE).
 */
async function allocateDespatchAdviceDocumentNumber(
  client: any,
  tenantId: string,
  tx: any,
  recipientTaxIdNorm: string | null,
  deliveryMode: 'ELEKTRONIK' | 'KAGIT',
  isCorrection: boolean,
  correctsDocumentId: string | null
): Promise<{ id: string; documentNumber: string; ettn: string }> {
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
  const documentNumber = `IRS${year}${String(seq).padStart(9, '0')}`;
  const ettn = crypto.randomUUID();
  const id = generateId('despatch');
  await client.query(
    `INSERT INTO despatch_advice_documents
       (id, tenant_id, transaction_id, document_number, ettn, issue_year, sequence_no, recipient_tax_id, delivery_mode, is_correction, corrects_document_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [id, tenantId, tx.id, documentNumber, ettn, year, seq, recipientTaxIdNorm, deliveryMode, isCorrection, correctsDocumentId]
  );
  return { id, documentNumber, ettn };
}

// ============================================================================
// COMP-602.1: ENTEGRATÖR ADAPTÖR ARAYÜZÜ, İLETİM KUYRUĞU + BELGE SAKLAMA
// ============================================================================

/**
 * COMP-602.1 AC: "sağlayıcı değişimi yalnızca adapter sınıfı değişikliğiyle
 * olmalıdır." Ticket NestJS + BullMQ + S3 öneriyor; bu kod tabanında hiçbiri
 * yok. Gönderim sırası SEQUENTIAL bir setInterval süpürücüsüyle (aşağıda,
 * index.ts'teki diğer tüm süpürücülerle AYNI desen) korunur — BullMQ'nun
 * "tek worker eşzamanlılığı" gereksinimini tek bir Node process'in doğal
 * sıralı `for` döngüsüyle karşılıyoruz (yatay ölçeklenmiş çoklu backend
 * instance'ı bu ortamda YOK, dolayısıyla dağıtık kilit gerekmiyor).
 * S3-uyumlu depolama yerine imzalanmış çıktı (xml_snapshot) doğrudan bu
 * tabloya yazılır — belge bir yasal kayıttır (GİB denetim gereği), bu yüzden
 * bu tablo da despatch_advice_documents gibi UPDATE/DELETE'ten korunacak
 * KALICI bir sütun (xml_snapshot) taşır; yalnızca durum makinesi alanları
 * (status/attempt_count/last_error/provider_reference/sent_at) değişebilir.
 */
export interface DespatchAdviceTransmissionRecord {
  id: string;
  tenantId: string;
  despatchAdviceDocumentId: string;
  transactionId: string;
  documentNumber: string;
  provider: string;
  status: 'QUEUED' | 'SENDING' | 'SENT' | 'FAILED';
  attemptCount: number;
  lastError: string | null;
  providerReference: string | null;
  queuedAt: string;
  sentAt: string | null;
  updatedAt: string;
}

const DESPATCH_TRANSMISSION_MAX_ATTEMPTS = 5;
const DESPATCH_TRANSMISSION_SWEEP_BATCH_SIZE = 20;

function mapDespatchTransmissionRow(row: any): DespatchAdviceTransmissionRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    despatchAdviceDocumentId: row.despatch_advice_document_id,
    transactionId: row.transaction_id,
    documentNumber: row.document_number,
    provider: row.provider,
    status: row.status,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    providerReference: row.provider_reference,
    queuedAt: row.queued_at,
    sentAt: row.sent_at,
    updatedAt: row.updated_at
  };
}

/**
 * e-İrsaliye'yi (idempotent şekilde) hazırlar, UBL XML'ini üretip XSD'ye karşı
 * doğrular ve iletim kuyruğuna alır — tamamı TEK transaction'da (belge no
 * tahsisi ile kuyruğa alma arasında yarış olmasın diye). Aynı belge için
 * tekrar çağrılırsa (ON CONFLICT) kuyruktaki MEVCUT satır döner — yeniden
 * kuyruğa eklenmez (COMP-603'ün konusu olan "yeniden gönderim" burada değil).
 */
export async function enqueueDespatchAdviceTransmission(
  transactionId: string,
  siteRestriction: string | undefined,
  recipientTaxId: string | null | undefined
): Promise<DespatchAdviceTransmissionRecord> {
  return withTenant(async (client, tenantId) => {
    const prep = await prepareDespatchAdviceCore(client, tenantId, transactionId, siteRestriction, recipientTaxId);
    if (prep.deliveryMode === 'KAGIT') {
      throw new ConflictError(
        'Alıcı e-İrsaliye mükellefi değil (KAĞIT süreç) — elektronik iletim kuyruğuna alınamaz.',
        { error: 'RECIPIENT_NOT_EINVOICE_OBLIGATED' }
      );
    }

    // COMP-603: transaction_id artık TEK bir belgeye karşılık gelmeyebilir
    // (reddedilip yeniden gönderilmiş olabilir) — AKTİF (supersede edilmemiş)
    // belge çözülür; prepareDespatchAdviceCore zaten AYNI çözümlemeyi
    // kullandığı için `prep.documentNumber` burada dönen belgeyle tutarlıdır.
    const activeDoc = await resolveActiveDespatchAdviceDocument(client, tenantId, transactionId);
    const despatchAdviceDocumentId: string = activeDoc.id;

    const existing = await client.query(
      'SELECT * FROM despatch_advice_transmissions WHERE tenant_id = $1 AND despatch_advice_document_id = $2',
      [tenantId, despatchAdviceDocumentId]
    );
    if (existing.rows.length > 0) {
      return mapDespatchTransmissionRow(existing.rows[0]);
    }

    const xml = generateDespatchAdviceXml(prep);
    const id = generateId('dtx');
    const inserted = await client.query(
      `INSERT INTO despatch_advice_transmissions
         (id, tenant_id, despatch_advice_document_id, transaction_id, document_number, ettn, vehicle_plate, provider, status, xml_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'QUEUED', $9)
       RETURNING *`,
      [id, tenantId, despatchAdviceDocumentId, transactionId, prep.documentNumber, prep.ettn, prep.vehiclePlate, getIntegratorAdapter().providerName, xml]
    );
    await writeAuditLog(client, {
      action: 'DESPATCH_ADVICE_TRANSMISSION_QUEUED',
      targetType: 'despatch_advice_transmission',
      targetId: id,
      afterValue: { documentNumber: prep.documentNumber, transactionId }
    });
    return mapDespatchTransmissionRow(inserted.rows[0]);
  });
}

export async function getDespatchAdviceTransmissions(
  filter: { status?: string; transactionId?: string } = {}
): Promise<DespatchAdviceTransmissionRecord[]> {
  return withTenant(async (client, tenantId) => {
    const conditions: string[] = ['tenant_id = $1'];
    const params: any[] = [tenantId];
    if (filter.status) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }
    if (filter.transactionId) {
      params.push(filter.transactionId);
      conditions.push(`transaction_id = $${params.length}`);
    }
    const res = await client.query(
      `SELECT * FROM despatch_advice_transmissions WHERE ${conditions.join(' AND ')} ORDER BY queued_at DESC LIMIT 200`,
      params
    );
    return res.rows.map(mapDespatchTransmissionRow);
  });
}

export async function getDespatchAdviceTransmission(id: string): Promise<DespatchAdviceTransmissionRecord> {
  return withTenant(async (client, tenantId) => {
    const res = await client.query('SELECT * FROM despatch_advice_transmissions WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
    if (res.rows.length === 0) throw new NotFoundError('İletim kaydı bulunamadı.');
    return mapDespatchTransmissionRow(res.rows[0]);
  });
}

/**
 * Kuyruktaki en eski QUEUED satırlardan başlayarak SIRAYLA (tek seferde bir
 * tane, önceki bitmeden bir sonrakine geçmeden) entegratöre gönderir —
 * "gönderim sırası korunmalı" AC'si. Bir tenant'ın süpürmesi başarısız
 * OLMAZ; her satır kendi try/catch'i içinde işlenir (bir satırın entegratör
 * hatası aynı turdaki diğer satırları durdurmamalı).
 */
export async function runDespatchAdviceTransmissionSweepForCurrentTenant(): Promise<{
  processed: number;
  sent: number;
  failed: number;
  requeued: number;
}> {
  const adapter = getIntegratorAdapter();
  let processed = 0;
  let sent = 0;
  let failed = 0;
  let requeued = 0;
  // Başarısız bir satır bu turda QUEUED'a geri dönebilir (bounded retry) —
  // AYNI çağrı içinde onu HEMEN tekrar seçip "hot loop" yapmamak için zaten
  // denenmiş id'ler bu turda bir daha seçilmez. Her satır bir sweep
  // çağrısında EN FAZLA BİR kez denenir; bir sonraki deneme BİR SONRAKİ
  // (manuel veya otomatik) süpürme turunu bekler.
  const attemptedIds: string[] = [];
  for (let i = 0; i < DESPATCH_TRANSMISSION_SWEEP_BATCH_SIZE; i++) {
    const outcome = await withTenant(async (client, tenantId) => {
      const next = await client.query(
        `SELECT * FROM despatch_advice_transmissions
         WHERE tenant_id = $1 AND status = 'QUEUED' AND NOT (id = ANY($2::text[]))
         ORDER BY queued_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [tenantId, attemptedIds]
      );
      if (next.rows.length === 0) return null;
      const row = next.rows[0];
      attemptedIds.push(row.id);
      await client.query(`UPDATE despatch_advice_transmissions SET status = 'SENDING', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [row.id]);

      let result: { success: boolean; providerReference?: string; errorMessage?: string };
      try {
        result = await adapter.send({
          xml: row.xml_snapshot,
          documentNumber: row.document_number,
          ettn: row.ettn,
          vehiclePlate: row.vehicle_plate
        });
      } catch (err: any) {
        result = { success: false, errorMessage: err?.message ?? 'Bilinmeyen entegratör hatası.' };
      }

      if (result.success) {
        await client.query(
          `UPDATE despatch_advice_transmissions
             SET status = 'SENT', sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
                 provider_reference = $2, attempt_count = attempt_count + 1, last_error = NULL
           WHERE id = $1`,
          [row.id, result.providerReference ?? null]
        );
        await writeAuditLog(client, {
          action: 'DESPATCH_ADVICE_TRANSMISSION_SENT',
          targetType: 'despatch_advice_transmission',
          targetId: row.id,
          afterValue: { documentNumber: row.document_number, providerReference: result.providerReference ?? null }
        });
        return 'sent' as const;
      }

      const newAttemptCount = row.attempt_count + 1;
      const terminal = newAttemptCount >= DESPATCH_TRANSMISSION_MAX_ATTEMPTS;
      await client.query(
        `UPDATE despatch_advice_transmissions
           SET status = $2, attempt_count = $3, last_error = $4, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [row.id, terminal ? 'FAILED' : 'QUEUED', newAttemptCount, result.errorMessage ?? 'Bilinmeyen hata']
      );
      if (terminal) {
        await writeAuditLog(client, {
          action: 'DESPATCH_ADVICE_TRANSMISSION_FAILED',
          targetType: 'despatch_advice_transmission',
          targetId: row.id,
          afterValue: { documentNumber: row.document_number, attemptCount: newAttemptCount, lastError: result.errorMessage ?? null }
        });
        return 'failed' as const;
      }
      return 'requeued' as const;
    });
    if (outcome === null) break;
    processed++;
    if (outcome === 'sent') sent++;
    else if (outcome === 'failed') failed++;
    else requeued++;
  }
  return { processed, sent, failed, requeued };
}

// ============================================================================
// COMP-603: e-İRSALİYE RED/İPTAL SENARYOSU + YENİDEN GÖNDERİM (DÜZELTME)
// ============================================================================

// Gerçek GİB e-İrsaliye/e-Fatura sisteminde iptal, belgenin GİB'e iletildiği
// günü izleyen belirli bir süreyle sınırlıdır (belge türüne göre değişir).
// Ticket kesin bir süre vermiyor — 72 saat, "gönderildikten kısa süre sonra"
// gerçeğine makul bir yaklaşım olarak seçildi (Bilinçli sapma, ticket'ta yok).
const DESPATCH_ADVICE_CANCELLATION_WINDOW_HOURS = 72;

export interface DespatchAdviceStatusRecord {
  despatchAdviceDocumentId: string;
  transactionId: string;
  documentNumber: string;
  status: 'ISSUED' | 'REJECTED' | 'CANCELLED' | 'SUPERSEDED';
  rejectReason: string | null;
  rejectedAt: string | null;
  cancelReason: string | null;
  cancellationCertificateRef: string | null;
  cancelledAt: string | null;
  supersededByDocumentId: string | null;
  supersededByDocumentNumber: string | null;
}

function mapDespatchAdviceStatusRow(row: any, documentNumber: string, supersededByDocumentNumber: string | null = null): DespatchAdviceStatusRecord {
  return {
    despatchAdviceDocumentId: row.despatch_advice_document_id,
    transactionId: row.transaction_id,
    documentNumber,
    status: row.status,
    rejectReason: row.reject_reason,
    rejectedAt: row.rejected_at,
    cancelReason: row.cancel_reason,
    cancellationCertificateRef: row.cancellation_certificate_ref,
    cancelledAt: row.cancelled_at,
    supersededByDocumentId: row.superseded_by_document_id,
    supersededByDocumentNumber
  };
}

/**
 * Aktif belgenin durum satırını LAZY olarak var eder (COMP-602.1'den önceki
 * belgelerin hiç durum satırı yoktur — ilk erişimde ISSUED olarak yaratılır)
 * ve `FOR UPDATE` ile kilitler — reject/cancel/resubmit arasındaki yarışı
 * önler (aynı belge için iki eşzamanlı istek).
 */
async function lockOrCreateDespatchAdviceStatus(client: any, tenantId: string, activeDoc: any): Promise<any> {
  await client.query(
    `INSERT INTO despatch_advice_documents_status (despatch_advice_document_id, tenant_id, transaction_id)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [activeDoc.id, tenantId, activeDoc.transaction_id]
  );
  const res = await client.query(
    'SELECT * FROM despatch_advice_documents_status WHERE despatch_advice_document_id = $1 FOR UPDATE',
    [activeDoc.id]
  );
  return res.rows[0];
}

async function resolveActiveDocOrThrow(client: any, tenantId: string, transactionId: string, siteRestriction?: string): Promise<any> {
  // Şantiye kapsaması + "hiç ikmal yok" ayrımı diğer tüm despatch fonksiyonlarıyla
  // AYNI (NotFoundError, 403 değil — ID sızıntısı önlenir).
  const txRes = await client.query('SELECT site_name FROM transactions WHERE id = $1', [transactionId]);
  if (txRes.rows.length === 0 || (siteRestriction && txRes.rows[0].site_name !== siteRestriction)) {
    throw new NotFoundError('İkmal kaydı bulunamadı.');
  }
  const active = await resolveActiveDespatchAdviceDocument(client, tenantId, transactionId);
  if (!active) {
    throw new NotFoundError('Bu ikmal için henüz üretilmiş bir e-İrsaliye yok — önce POST /transactions/:id/e-irsaliye/transmit ile kuyruğa alın.');
  }
  return active;
}

export async function getDespatchAdviceStatus(transactionId: string, siteRestriction?: string): Promise<DespatchAdviceStatusRecord> {
  return withTenant(async (client, tenantId) => {
    const active = await resolveActiveDocOrThrow(client, tenantId, transactionId, siteRestriction);
    const status = await lockOrCreateDespatchAdviceStatus(client, tenantId, active);
    return mapDespatchAdviceStatusRow(status, active.document_number);
  });
}

/**
 * Alıcının belgeyi reddettiğini kaydeder (AC: "Red sebepleri kaydedilip
 * kullanıcıya anlaşılır biçimde gösterilmelidir"). Yalnızca GERÇEKTEN
 * gönderilmiş (despatch_advice_transmissions.status='SENT') bir belge
 * reddedilebilir — hiç gönderilmemiş bir belgeyi "alıcı reddetti" demek
 * anlamsızdır.
 */
export async function rejectDespatchAdvice(transactionId: string, reason: string, siteRestriction?: string): Promise<DespatchAdviceStatusRecord> {
  return withTenant(async (client, tenantId) => {
    const active = await resolveActiveDocOrThrow(client, tenantId, transactionId, siteRestriction);
    const sent = await client.query(
      "SELECT 1 FROM despatch_advice_transmissions WHERE tenant_id = $1 AND despatch_advice_document_id = $2 AND status = 'SENT'",
      [tenantId, active.id]
    );
    if (sent.rows.length === 0) {
      throw new BadRequestError(
        'Bu belge henüz entegratöre GÖNDERİLMEDİ (SENT) — gönderilmemiş bir belge reddedilemez.',
        { error: 'NOT_YET_TRANSMITTED' }
      );
    }
    const statusRow = await lockOrCreateDespatchAdviceStatus(client, tenantId, active);
    if (statusRow.status !== 'ISSUED') {
      throw new ConflictError(`Belge zaten '${statusRow.status}' durumunda — tekrar reddedilemez.`, { error: 'INVALID_STATUS_TRANSITION', currentStatus: statusRow.status });
    }
    const updated = await client.query(
      `UPDATE despatch_advice_documents_status
         SET status = 'REJECTED', reject_reason = $2, rejected_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE despatch_advice_document_id = $1 RETURNING *`,
      [active.id, reason]
    );
    await writeAuditLog(client, {
      action: 'DESPATCH_ADVICE_REJECTED',
      targetType: 'despatch_advice_document',
      targetId: active.id,
      afterValue: { documentNumber: active.document_number, reason }
    });
    return mapDespatchAdviceStatusRow(updated.rows[0], active.document_number);
  });
}

/**
 * İhraç eden tarafın belgeyi iptal etmesi — sertifika/imza yerine (bu ortamda
 * gerçek bir HSM/PKI yok, COMP-601'in XAdES notuyla AYNI gerekçe) simüle
 * edilmiş bir iptal referansı üretir. Yasal süre penceresi dışında reddedilir.
 */
export async function cancelDespatchAdvice(transactionId: string, reason: string, siteRestriction?: string): Promise<DespatchAdviceStatusRecord> {
  return withTenant(async (client, tenantId) => {
    const active = await resolveActiveDocOrThrow(client, tenantId, transactionId, siteRestriction);
    const ageHours = (Date.now() - new Date(active.created_at).getTime()) / (60 * 60 * 1000);
    if (ageHours > DESPATCH_ADVICE_CANCELLATION_WINDOW_HOURS) {
      throw new BadRequestError(
        `Belge iptal süresi (${DESPATCH_ADVICE_CANCELLATION_WINDOW_HOURS} saat) aşıldı — artık yalnızca reddedilip yeniden gönderilebilir.`,
        { error: 'CANCELLATION_WINDOW_EXPIRED' }
      );
    }
    const statusRow = await lockOrCreateDespatchAdviceStatus(client, tenantId, active);
    if (statusRow.status === 'CANCELLED' || statusRow.status === 'SUPERSEDED') {
      throw new ConflictError(`Belge zaten '${statusRow.status}' durumunda — tekrar iptal edilemez.`, { error: 'INVALID_STATUS_TRANSITION', currentStatus: statusRow.status });
    }
    const certificateRef = `IPTAL-${active.document_number}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const updated = await client.query(
      `UPDATE despatch_advice_documents_status
         SET status = 'CANCELLED', cancel_reason = $2, cancellation_certificate_ref = $3, cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE despatch_advice_document_id = $1 RETURNING *`,
      [active.id, reason, certificateRef]
    );
    await writeAuditLog(client, {
      action: 'DESPATCH_ADVICE_CANCELLED',
      targetType: 'despatch_advice_document',
      targetId: active.id,
      afterValue: { documentNumber: active.document_number, reason, certificateRef }
    });
    return mapDespatchAdviceStatusRow(updated.rows[0], active.document_number);
  });
}

export interface DespatchAdviceResubmission {
  previousDocumentId: string;
  previousDocumentNumber: string;
  newDocumentId: string;
  newDocumentNumber: string;
  newEttn: string;
}

/**
 * AC: "Düzeltilen belgeler YENİ belge numarasıyla yeniden gönderilmelidir."
 * Yalnızca REDDEDİLMİŞ veya İPTAL EDİLMİŞ bir belge düzeltilebilir. Alıcı/
 * teslim yöntemi ÖNCEKİ belgeden KORUNUR (ticket alıcı değişikliğinden söz
 * etmiyor — yalnızca "düzeltme" istiyor). Yeni belge otomatik OLARAK
 * iletim kuyruğuna EKLENMEZ — çağıran ayrıca POST .../transmit çağırmalı
 * (COMP-602.1 ile AYNI kompozisyon: her adım kendi sorumluluğunda).
 */
export async function resubmitDespatchAdvice(transactionId: string, siteRestriction?: string): Promise<DespatchAdviceResubmission> {
  return withTenant(async (client, tenantId) => {
    const active = await resolveActiveDocOrThrow(client, tenantId, transactionId, siteRestriction);
    const statusRow = await lockOrCreateDespatchAdviceStatus(client, tenantId, active);
    if (statusRow.status !== 'REJECTED' && statusRow.status !== 'CANCELLED') {
      throw new ConflictError(
        `Yalnızca REDDEDİLMİŞ veya İPTAL EDİLMİŞ bir belge yeniden gönderilebilir (mevcut durum: '${statusRow.status}').`,
        { error: 'INVALID_STATUS_TRANSITION', currentStatus: statusRow.status }
      );
    }

    const f = await deriveDespatchAdviceFields(client, tenantId, transactionId, siteRestriction, active.recipient_tax_id);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('despatch:' || $1))", [tenantId]);
    const allocated = await allocateDespatchAdviceDocumentNumber(
      client,
      tenantId,
      f.tx,
      active.recipient_tax_id,
      active.delivery_mode,
      true,
      active.id
    );
    await client.query(
      `INSERT INTO despatch_advice_documents_status (despatch_advice_document_id, tenant_id, transaction_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [allocated.id, tenantId, transactionId]
    );
    await client.query(
      `UPDATE despatch_advice_documents_status
         SET status = 'SUPERSEDED', superseded_by_document_id = $2, updated_at = CURRENT_TIMESTAMP
       WHERE despatch_advice_document_id = $1`,
      [active.id, allocated.id]
    );
    await writeAuditLog(client, {
      action: 'DESPATCH_ADVICE_RESUBMITTED',
      targetType: 'despatch_advice_document',
      targetId: allocated.id,
      beforeValue: { previousDocumentId: active.id, previousDocumentNumber: active.document_number },
      afterValue: { newDocumentNumber: allocated.documentNumber }
    });
    return {
      previousDocumentId: active.id,
      previousDocumentNumber: active.document_number,
      newDocumentId: allocated.id,
      newDocumentNumber: allocated.documentNumber,
      newEttn: allocated.ettn
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

// ============================================================================
// FUEL-408: TANK DOLUM (ALIM İRSALİYESİ) GİRİŞİ + STOK ARTIŞI
// ============================================================================

// Beyan (tanker irsaliyesi) ile fiziksel ölçüm (seviye farkı) arasında bu
// oranı aşan fark "eksik teslimat" uyarısı üretir. Motorin dolumunda tanker
// sayacı ile tank sensörü arasında ~%0.3-0.5 fark normaldir; varsayılan eşik
// %0.5 (istek gövdesinde tolerancePct ile ezilebilir).
const DEFAULT_INTAKE_TOLERANCE_PCT = 0.5;
// Dolum penceresi: kayıt anından bu kadar geriye. FUEL-409 mutabakatı bu
// aralıktaki pompa akışını "gerçek tüketim değil, dolum türbülansı" sayıp
// hesap dışı bırakabilsin diye işaretlenir.
const INTAKE_WINDOW_LOOKBACK_MS = 15 * 60 * 1000;

export interface FuelIntakeRecord {
  id: string;
  tenant_id: string;
  tank_id: string;
  tank_name: string;
  site_name: string;
  supplier_name: string;
  waybill_no: string;
  delivery_date: string;
  tanker_plate: string | null;
  declared_liters: string;
  unit_price: string | null;
  temperature_c: string | null;
  density_kg_m3: string | null;
  level_before_liters: string | null;
  level_after_liters: string | null;
  measured_liters: string | null;
  declared_liters_15c: string;
  measured_liters_15c: string | null;
  discrepancy_liters: string | null;
  discrepancy_pct: string | null;
  added_liters: string;
  status: string;
  window_start: string | null;
  window_end: string | null;
  waybill_image_url: string | null;
  note: string | null;
  created_by: string;
  created_at: string;
}

export interface FuelIntakeResult {
  receipt: FuelIntakeRecord;
  /** Beyan ile ölçüm 15 °C'de karşılaştırılabildi mi (levelAfter verildiyse). */
  compared: boolean;
  /** Tolerans aşıldı mı → EKSİK_TESLİMAT_UYARISI + WS uyarısı. */
  shortDeliveryAlert: boolean;
  tankLevelBefore: number;
  tankLevelAfter: number;
}

/**
 * FUEL-408 — bir dolum kaydı oluşturur ve tank stoğunu atomik olarak artırır.
 *
 *  - Tank satırı `FOR UPDATE` ile kilitlenir (createTransaction'daki FUEL-402
 *    deseniyle aynı) — eşzamanlı bir ikmal/dolum seviyeyi ezmez.
 *  - Beyan (declaredLiters) ve — verildiyse — ölçüm (levelAfter - levelBefore)
 *    ASTM D1250 ile 15 °C'ye düzeltilip karşılaştırılır (Kritik Not:
 *    "karşılaştırma sıcaklık düzeltilmiş hacimler üzerinden yapılmalıdır").
 *  - Stoğa eklenen miktar: ölçüm varsa measured, yoksa declared (AC: "dolum
 *    kaydı tank stoğunu DOĞRU artırmalıdır").
 *  - Tank kapasitesi aşılırsa TANK_OVERFLOW ile reddedilir.
 */
export async function recordFuelIntake(
  tankId: string,
  data: {
    supplierName: string;
    waybillNo: string;
    deliveryDate: string;
    declaredLiters: number;
    tankerPlate?: string;
    unitPrice?: number;
    temperatureC?: number;
    densityKgM3?: number;
    levelBeforeLiters?: number;
    levelAfterLiters?: number;
    tolerancePct?: number;
    waybillImageUrl?: string;
    note?: string;
  },
  createdByUserId: string
): Promise<FuelIntakeResult> {
  return withTenant(async (client, tenantId) => {
    const tankRes = await client.query(
      'SELECT id, name, site_name, fuel_type, capacity_liters, current_level_liters FROM tanks WHERE id = $1 FOR UPDATE',
      [tankId]
    );
    if (tankRes.rows.length === 0) {
      throw new NotFoundError(`'${tankId}' tankı bulunamadı.`, { error: 'TANK_NOT_FOUND' });
    }
    const tank = tankRes.rows[0];
    const capacity = Number(tank.capacity_liters);
    const levelBeforeActual = Number(tank.current_level_liters);

    // level_before: çağıran bir "dolum öncesi" ölçüm beyan ettiyse onu SAKLA
    // (irsaliye/tutanak değeri), ama stok hesabı her zaman tankın GERÇEK
    // mevcut seviyesinden (levelBeforeActual) yürür.
    const levelBefore = data.levelBeforeLiters ?? levelBeforeActual;
    const hasMeasurement = data.levelAfterLiters !== undefined;
    const measuredLiters = hasMeasurement ? round2(data.levelAfterLiters! - levelBefore) : null;

    // Stoğa eklenecek miktar: ölçüm varsa fiziksel fark, yoksa beyan.
    const addedLiters = round2(hasMeasurement ? measuredLiters! : data.declaredLiters);
    if (addedLiters <= 0) {
      throw new BadRequestError('Dolum miktarı sıfır veya negatif — kayıt oluşturulmadı.', { error: 'INTAKE_NON_POSITIVE' });
    }

    const newLevel = round2(levelBeforeActual + addedLiters);
    if (newLevel > capacity + 0.01) {
      throw new ConflictError(
        `Dolum tank kapasitesini aşıyor: mevcut ${levelBeforeActual} L + ${addedLiters} L > ${capacity} L kapasite.`,
        { error: 'TANK_OVERFLOW', capacityLiters: capacity, currentLevelLiters: levelBeforeActual, addedLiters }
      );
    }

    // 15 °C standart hacim düzeltmesi (sıcaklık yoksa vcf=1, düzeltme yok).
    const declared15c = correctToStandardVolume(data.declaredLiters, data.temperatureC ?? null, tank.fuel_type, data.densityKgM3 ?? undefined).standardLiters;
    let measured15c: number | null = null;
    let discrepancyLiters: number | null = null;
    let discrepancyPct: number | null = null;
    let shortDeliveryAlert = false;
    const tolerancePct = data.tolerancePct ?? DEFAULT_INTAKE_TOLERANCE_PCT;

    if (hasMeasurement) {
      measured15c = correctToStandardVolume(measuredLiters!, data.temperatureC ?? null, tank.fuel_type, data.densityKgM3 ?? undefined).standardLiters;
      discrepancyLiters = round2(measured15c - declared15c);
      discrepancyPct = declared15c > 0 ? Number(((discrepancyLiters / declared15c) * 100).toFixed(4)) : 0;
      // Eksik teslimat = ölçülen, beyan edilenden tolerans eşiğinin ÖTESİNDE az.
      shortDeliveryAlert = discrepancyPct < -tolerancePct;
    }

    const status = shortDeliveryAlert ? 'EKSİK_TESLİMAT_UYARISI' : 'KAYITLI';
    const now = new Date();
    const windowStart = new Date(now.getTime() - INTAKE_WINDOW_LOOKBACK_MS);

    const capacityPct = (newLevel / capacity) * 100;
    const newTankStatus = capacityPct < 20 ? 'KRİTİK' : capacityPct < 40 ? 'UYARI' : 'GÜVENLİ';
    await client.query('UPDATE tanks SET current_level_liters = $1, status = $2 WHERE id = $3', [newLevel, newTankStatus, tank.id]);

    const id = generateId('intake');
    const insRes = await client.query(
      `INSERT INTO fuel_intake_receipts
         (id, tenant_id, tank_id, tank_name, site_name, supplier_name, waybill_no, delivery_date, tanker_plate,
          declared_liters, unit_price, temperature_c, density_kg_m3, level_before_liters, level_after_liters,
          measured_liters, declared_liters_15c, measured_liters_15c, discrepancy_liters, discrepancy_pct,
          added_liters, status, window_start, window_end, waybill_image_url, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
       RETURNING *`,
      [
        id, tenantId, tank.id, tank.name, tank.site_name, data.supplierName, data.waybillNo, data.deliveryDate,
        data.tankerPlate ?? null, data.declaredLiters, data.unitPrice ?? null, data.temperatureC ?? null,
        data.densityKgM3 ?? null, data.levelBeforeLiters ?? null, data.levelAfterLiters ?? null,
        measuredLiters, declared15c, measured15c, discrepancyLiters, discrepancyPct,
        addedLiters, status, windowStart.toISOString(), now.toISOString(), data.waybillImageUrl ?? null,
        data.note ?? null, createdByUserId
      ]
    );

    await writeAuditLog(client, {
      action: 'FUEL_INTAKE_RECORDED',
      targetType: 'fuel_intake_receipt',
      targetId: id,
      afterValue: {
        tankId: tank.id, tankName: tank.name, declaredLiters: data.declaredLiters, addedLiters,
        status, discrepancyLiters, discrepancyPct
      }
    });

    if (shortDeliveryAlert) {
      logger.warn(
        { tankId: tank.id, tankName: tank.name, waybillNo: data.waybillNo, declared15c, measured15c, discrepancyPct },
        `🚨 [FUEL-408] Eksik teslimat şüphesi: '${tank.name}' — beyan ${declared15c} L, ölçüm ${measured15c} L (%${discrepancyPct}).`
      );
    }

    return {
      receipt: insRes.rows[0] as FuelIntakeRecord,
      compared: hasMeasurement,
      shortDeliveryAlert,
      tankLevelBefore: levelBeforeActual,
      tankLevelAfter: newLevel
    };
  });
}

export async function getFuelIntakes(filters: {
  tankId?: string;
  status?: string;
  from?: string;
  to?: string;
}): Promise<FuelIntakeRecord[]> {
  return withTenant(async (client) => {
    const where: string[] = [];
    const params: any[] = [];
    if (filters.tankId) { params.push(filters.tankId); where.push(`tank_id = $${params.length}`); }
    if (filters.status) { params.push(filters.status); where.push(`status = $${params.length}`); }
    if (filters.from) { params.push(filters.from); where.push(`delivery_date >= $${params.length}`); }
    if (filters.to) { params.push(filters.to); where.push(`delivery_date <= $${params.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const res = await client.query(`SELECT * FROM fuel_intake_receipts ${clause} ORDER BY delivery_date DESC, created_at DESC`, params);
    return res.rows;
  });
}

export async function getFuelIntake(intakeId: string): Promise<FuelIntakeRecord> {
  return withTenant(async (client) => {
    const res = await client.query('SELECT * FROM fuel_intake_receipts WHERE id = $1', [intakeId]);
    if (res.rows.length === 0) throw new NotFoundError('Dolum kaydı bulunamadı.');
    return res.rows[0];
  });
}

// ============================================================================
// FUEL-409: TEORİK vs FİZİKSEL STOK MUTABAKATI + FİRE HESABI
// ============================================================================

export type ReconciliationPeriodType = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'AD_HOC';

// Kritik Not: "Motorin doğal buharlaşması aylık binde 1-2 mertebesindedir; bu
// normal fire tolerans içinde sayılmalı, hırsızlık alarmı üretmemelidir."
// Üst sınır (%0.2/ay) dönem uzunluğuna (gün) ölçeklenip "normal fire payı"
// olarak kullanılır.
const EVAPORATION_MONTHLY_PCT = 0.2;
const DEFAULT_RECON_TOLERANCE_PCT = 1.0;

export interface StockReconciliationRecord {
  id: string;
  tenant_id: string;
  tank_id: string;
  tank_name: string;
  site_name: string;
  period_type: ReconciliationPeriodType;
  period_start: string;
  period_end: string;
  opening_book_liters: string;
  intake_liters: string;
  dispensed_liters: string;
  test_intake_liters: string;
  closing_book_liters: string;
  physical_liters: string;
  physical_temp_c: string | null;
  physical_liters_15c: string;
  variance_liters: string;
  variance_pct: string;
  tolerance_pct: string;
  evaporation_allowance_pct: string;
  classification: string;
  status: string;
  source: string;
  note: string | null;
  created_by: string;
  created_at: string;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/**
 * FUEL-409 çekirdeği — bir tank satırı için dönem mutabakatını hesaplayıp
 * stock_reconciliations'a yazar. Hem manuel POST ucu hem index.ts günlük
 * süpürücüsü bunu çağırır.
 *
 * Açılış bakiyesi (opening_book):
 *   1) çağıran açıkça verdiyse onu kullan,
 *   2) yoksa bu tankın bir önceki mutabakatının physical_liters'ı (fiziksel
 *      ölçüm her dönem sonunda kaydı "gerçeğe" sıfırlar — Kritik Not:
 *      "mutabakat sonucu düzeltme kaydı olarak saklanmalı"),
 *   3) hiç önceki mutabakat yoksa: OTOMATIK çağrıda geriye hesaplayarak
 *      (physical − intake + dispensed + test) bir taban çizgisi kur (ilk tur
 *      yanlış alarm üretmesin); MANUEL çağrıda OPENING_BOOK_REQUIRED fırlat.
 *
 * Kütüphane tutarlılığı için mutabakat GÖZLENEN (ambient) litre üzerinden
 * yapılır (defter zaten gözlenen hacimlerin akan toplamı: tank seviyesi,
 * transactions.amount_liters, test alımı hepsi gözlenen). 15 °C'ye düzeltilmiş
 * fiziksel hacim ayrıca physical_liters_15c'de raporlama (REP-714) için tutulur.
 */
async function reconcileTankRow(
  client: any,
  tenantId: string,
  tank: { id: string; name: string; site_name: string; fuel_type: string | null },
  input: {
    periodType: ReconciliationPeriodType;
    periodStart: Date;
    periodEnd: Date;
    physicalLiters: number;
    physicalTempC?: number | null;
    openingBookLiters?: number;
    tolerancePct?: number;
    source: 'MANUEL' | 'OTOMATIK';
    note?: string;
  },
  createdByUserId: string
): Promise<StockReconciliationRecord> {
  const startIso = input.periodStart.toISOString();
  const endIso = input.periodEnd.toISOString();

  const [intakeRes, dispRes, testRes] = await Promise.all([
    client.query(
      `SELECT COALESCE(SUM(added_liters), 0)::numeric AS s FROM fuel_intake_receipts
        WHERE tank_id = $1 AND created_at >= $2 AND created_at < $3`,
      [tank.id, startIso, endIso]
    ),
    client.query(
      `SELECT COALESCE(SUM(amount_liters), 0)::numeric AS s FROM transactions
        WHERE tank_name = $1 AND created_at >= $2 AND created_at < $3`,
      [tank.name, startIso, endIso]
    ),
    client.query(
      `SELECT COALESCE(SUM(measured_liters), 0)::numeric AS s FROM calibration_test_intakes
        WHERE tank_name = $1 AND created_at >= $2 AND created_at < $3`,
      [tank.name, startIso, endIso]
    )
  ]);
  const intakeLiters = round2(Number(intakeRes.rows[0].s));
  const dispensedLiters = round2(Number(dispRes.rows[0].s));
  const testIntakeLiters = round2(Number(testRes.rows[0].s));

  let openingBook: number;
  if (input.openingBookLiters !== undefined) {
    openingBook = round2(input.openingBookLiters);
  } else {
    const prior = await client.query(
      `SELECT physical_liters FROM stock_reconciliations
        WHERE tank_id = $1 AND period_end <= $2 ORDER BY period_end DESC LIMIT 1`,
      [tank.id, startIso]
    );
    if (prior.rows.length > 0) {
      openingBook = round2(Number(prior.rows[0].physical_liters));
    } else if (input.source === 'OTOMATIK') {
      // Taban çizgisi: closing_book == physical olacak şekilde geri hesapla.
      openingBook = round2(input.physicalLiters - intakeLiters + dispensedLiters + testIntakeLiters);
    } else {
      throw new BadRequestError(
        'Bu tank için önceki mutabakat kaydı yok — ilk mutabakatta openingBookLiters zorunludur.',
        { error: 'OPENING_BOOK_REQUIRED' }
      );
    }
  }

  const closingBook = round2(openingBook + intakeLiters - dispensedLiters - testIntakeLiters);
  const physical15c = correctToStandardVolume(input.physicalLiters, input.physicalTempC ?? null, tank.fuel_type).standardLiters;
  const varianceLiters = round2(input.physicalLiters - closingBook);
  const variancePct = closingBook !== 0 ? round4((varianceLiters / closingBook) * 100) : 0;

  const tolerancePct = input.tolerancePct ?? DEFAULT_RECON_TOLERANCE_PCT;
  const periodDays = Math.max(0, (input.periodEnd.getTime() - input.periodStart.getTime()) / 86_400_000);
  const evaporationAllowancePct = round4((EVAPORATION_MONTHLY_PCT * periodDays) / 30);

  let classification: string;
  let status: string;
  if (Math.abs(variancePct) <= tolerancePct) {
    classification = 'TOLERANS_İÇİ';
    status = 'NORMAL';
  } else if (variancePct > tolerancePct) {
    // Fiziksel, teorikten FAZLA — yakıt "kazanılamaz", ölçüm/kayıt hatası.
    classification = 'ÖLÇÜM_HATASI';
    status = 'MUTABAKAT_ALARMI';
  } else {
    // Fiziksel, teorikten toleransın ÖTESİNDE az (kayıp).
    const lossBeyondTolerancePct = -variancePct - tolerancePct;
    if (lossBeyondTolerancePct <= evaporationAllowancePct) {
      classification = 'BUHARLAŞMA';
      status = 'NORMAL';
    } else {
      classification = 'AÇIKLANAMAYAN';
      status = 'MUTABAKAT_ALARMI';
    }
  }

  const id = generateId('recon');
  const insRes = await client.query(
    `INSERT INTO stock_reconciliations
       (id, tenant_id, tank_id, tank_name, site_name, period_type, period_start, period_end,
        opening_book_liters, intake_liters, dispensed_liters, test_intake_liters, closing_book_liters,
        physical_liters, physical_temp_c, physical_liters_15c, variance_liters, variance_pct,
        tolerance_pct, evaporation_allowance_pct, classification, status, source, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
     RETURNING *`,
    [
      id, tenantId, tank.id, tank.name, tank.site_name, input.periodType, startIso, endIso,
      openingBook, intakeLiters, dispensedLiters, testIntakeLiters, closingBook,
      round2(input.physicalLiters), input.physicalTempC ?? null, physical15c, varianceLiters, variancePct,
      tolerancePct, evaporationAllowancePct, classification, status, input.source, input.note ?? null, createdByUserId
    ]
  );

  await writeAuditLog(client, {
    action: 'STOCK_RECONCILIATION',
    targetType: 'stock_reconciliation',
    targetId: id,
    afterValue: {
      tankId: tank.id, tankName: tank.name, periodType: input.periodType,
      closingBookLiters: closingBook, physicalLiters: round2(input.physicalLiters),
      varianceLiters, variancePct, classification, status, source: input.source
    }
  });

  if (status === 'MUTABAKAT_ALARMI') {
    logger.warn(
      { tankId: tank.id, tankName: tank.name, varianceLiters, variancePct, classification },
      `🚨 [FUEL-409] Stok mutabakat alarmı: '${tank.name}' — teorik ${closingBook} L, fiziksel ${round2(input.physicalLiters)} L (fark %${variancePct}, ${classification}).`
    );
    // AI-507: birleşik alarm yaşam döngüsüne ilet (gruplama anahtarı tank).
    await raiseAlarm(client, tenantId, {
      alarmKey: `STOCK_RECON:${tank.id}`,
      category: 'STOCK_RECONCILIATION',
      severity: classification === 'AÇIKLANAMAYAN' ? 'CRITICAL' : 'WARNING',
      title: `Stok mutabakat farkı: ${tank.name} (%${variancePct}, ${classification})`,
      siteName: tank.site_name,
      subjectType: 'TANK',
      subjectId: tank.id,
      detail: { reconciliationId: id, varianceLiters, variancePct, classification, closingBookLiters: closingBook, physicalLiters: round2(input.physicalLiters) },
      sourceRef: { table: 'stock_reconciliations', id }
    });
  }

  return insRes.rows[0] as StockReconciliationRecord;
}

export interface StockReconciliationResult {
  reconciliation: StockReconciliationRecord;
  alarm: boolean;
}

/**
 * FUEL-409 — manuel/entegrasyon mutabakat tetikleyicisi. `physicalLiters`
 * çağıran tarafından verilir (gerçek kurulumda sensör anlık görüntüsü).
 * `periodStart`/`periodEnd` verilmezse periodType'a göre son tam dönem
 * (dün / geçen hafta / geçen ay) alınır; AD_HOC için ikisi de zorunludur.
 */
export async function computeStockReconciliation(
  tankId: string,
  input: {
    periodType: ReconciliationPeriodType;
    physicalLiters: number;
    physicalTempC?: number;
    periodStart?: string;
    periodEnd?: string;
    openingBookLiters?: number;
    tolerancePct?: number;
    note?: string;
  },
  createdByUserId: string
): Promise<StockReconciliationResult> {
  return withTenant(async (client, tenantId) => {
    const tankRes = await client.query(
      'SELECT id, name, site_name, fuel_type FROM tanks WHERE id = $1',
      [tankId]
    );
    if (tankRes.rows.length === 0) {
      throw new NotFoundError(`'${tankId}' tankı bulunamadı.`, { error: 'TANK_NOT_FOUND' });
    }
    const tank = tankRes.rows[0];

    let periodStart: Date;
    let periodEnd: Date;
    if (input.periodStart && input.periodEnd) {
      periodStart = new Date(input.periodStart);
      periodEnd = new Date(input.periodEnd);
    } else if (input.periodType === 'AD_HOC') {
      throw new BadRequestError('AD_HOC mutabakat için periodStart ve periodEnd zorunludur.', { error: 'PERIOD_RANGE_REQUIRED' });
    } else {
      const now = new Date();
      periodEnd = now;
      const spanDays = input.periodType === 'WEEKLY' ? 7 : input.periodType === 'MONTHLY' ? 30 : 1;
      periodStart = new Date(now.getTime() - spanDays * 86_400_000);
    }
    if (periodEnd.getTime() <= periodStart.getTime()) {
      throw new BadRequestError('periodEnd, periodStart değerinden sonra olmalıdır.', { error: 'INVALID_PERIOD_RANGE' });
    }

    const reconciliation = await reconcileTankRow(
      client,
      tenantId,
      tank,
      {
        periodType: input.periodType,
        periodStart,
        periodEnd,
        physicalLiters: input.physicalLiters,
        physicalTempC: input.physicalTempC,
        openingBookLiters: input.openingBookLiters,
        tolerancePct: input.tolerancePct,
        source: 'MANUEL',
        note: input.note
      },
      createdByUserId
    );
    return { reconciliation, alarm: reconciliation.status === 'MUTABAKAT_ALARMI' };
  });
}

export async function getStockReconciliations(filters: {
  tankId?: string;
  status?: string;
  from?: string;
  to?: string;
}): Promise<StockReconciliationRecord[]> {
  return withTenant(async (client) => {
    const where: string[] = [];
    const params: any[] = [];
    if (filters.tankId) { params.push(filters.tankId); where.push(`tank_id = $${params.length}`); }
    if (filters.status) { params.push(filters.status); where.push(`status = $${params.length}`); }
    if (filters.from) { params.push(filters.from); where.push(`period_end >= $${params.length}`); }
    if (filters.to) { params.push(filters.to); where.push(`period_end <= $${params.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const res = await client.query(`SELECT * FROM stock_reconciliations ${clause} ORDER BY period_end DESC, created_at DESC`, params);
    return res.rows;
  });
}

export async function getStockReconciliation(reconId: string): Promise<StockReconciliationRecord> {
  return withTenant(async (client) => {
    const res = await client.query('SELECT * FROM stock_reconciliations WHERE id = $1', [reconId]);
    if (res.rows.length === 0) throw new NotFoundError('Mutabakat kaydı bulunamadı.');
    return res.rows[0];
  });
}

/**
 * FUEL-409 AC: "Günlük mutabakat otomatik hesaplanıp kaydedilmelidir."
 * index.ts'teki günlük süpürücü her tenant için bunu çağırır — her tank için
 * son 24 saatlik rolling mutabakat, fiziksel = tankın o anki
 * current_level_liters'ı (gerçek kurulumda sensör anlık görüntüsü).
 */
export async function runDailyStockReconciliationForCurrentTenant(): Promise<{ tanksProcessed: number; alarms: number }> {
  return withTenant(async (client, tenantId) => {
    const tanksRes = await client.query('SELECT id, name, site_name, fuel_type, current_level_liters FROM tanks');
    const now = new Date();
    const periodStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    let alarms = 0;
    for (const t of tanksRes.rows) {
      try {
        const rec = await reconcileTankRow(
          client,
          tenantId,
          { id: t.id, name: t.name, site_name: t.site_name, fuel_type: t.fuel_type },
          {
            periodType: 'DAILY',
            periodStart,
            periodEnd: now,
            physicalLiters: Number(t.current_level_liters),
            physicalTempC: null,
            source: 'OTOMATIK'
          },
          'system-daily-reconciler'
        );
        if (rec.status === 'MUTABAKAT_ALARMI') alarms++;
      } catch (err) {
        logger.error({ err, tenantId, tankId: t.id }, '🚨 [FUEL-409] Tank günlük mutabakatı başarısız.');
      }
    }
    return { tanksProcessed: tanksRes.rows.length, alarms };
  });
}

// ============================================================================
// FUEL-405: MANUEL İKMAL GİRİŞİ (CİHAZ ARIZASI) + ÇİFT ONAY MEKANİZMASI
// ============================================================================

// Geriye dönük tarih sınırı (Kritik Not: "öneri: en fazla 7 gün").
const MANUAL_BACKDATE_MAX_DAYS = 7;
// İkinci onayda üretilen transactions kaydının tipi — raporlar bunu ayrı
// gösterir (type LIKE 'Manuel (Çift Onaylı)%').
const MANUAL_DISPENSE_TX_TYPE = 'Manuel (Çift Onaylı)';
// Şantiye başına manuel ikmal oranı bu eşiği (%) aşarsa uyarı üretilir.
export const MANUAL_RATIO_DEFAULT_THRESHOLD_PCT = 10;

export interface ManualDispenseRequestRecord {
  id: string;
  tenant_id: string;
  site_name: string;
  vehicle_plate: string;
  driver_name: string | null;
  tank_id: string;
  tank_name: string;
  liters: string;
  dispensed_at: string;
  reason: string;
  document_url: string | null;
  status: string;
  requested_by: string;
  first_approver_id: string | null;
  first_approver_role: string | null;
  first_approved_at: string | null;
  second_approver_id: string | null;
  second_approver_role: string | null;
  second_approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  transaction_id: string | null;
  created_at: string;
}

export async function createManualDispenseRequest(
  data: {
    tankId: string;
    vehiclePlate: string;
    driverName?: string;
    liters: number;
    dispensedAt: string;
    reason: string;
    documentUrl?: string;
  },
  requestedByUserId: string
): Promise<ManualDispenseRequestRecord> {
  return withTenant(async (client, tenantId) => {
    const tankRes = await client.query('SELECT id, name, site_name FROM tanks WHERE id = $1', [data.tankId]);
    if (tankRes.rows.length === 0) {
      throw new NotFoundError(`'${data.tankId}' tankı bulunamadı.`, { error: 'TANK_NOT_FOUND' });
    }
    const tank = tankRes.rows[0];

    const dispensedAt = new Date(data.dispensedAt);
    const now = Date.now();
    if (dispensedAt.getTime() > now + 60_000) {
      throw new BadRequestError('dispensedAt gelecekte olamaz.', { error: 'FUTURE_DATE' });
    }
    if (dispensedAt.getTime() < now - MANUAL_BACKDATE_MAX_DAYS * 86_400_000) {
      throw new BadRequestError(
        `Geriye dönük giriş en fazla ${MANUAL_BACKDATE_MAX_DAYS} gün olabilir.`,
        { error: 'BACKDATE_LIMIT_EXCEEDED', maxDays: MANUAL_BACKDATE_MAX_DAYS }
      );
    }

    const id = generateId('mandisp');
    const res = await client.query(
      `INSERT INTO manual_dispense_requests
         (id, tenant_id, site_name, vehicle_plate, driver_name, tank_id, tank_name, liters, dispensed_at, reason, document_url, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        id, tenantId, tank.site_name, data.vehiclePlate, data.driverName ?? null, tank.id, tank.name,
        data.liters, dispensedAt.toISOString(), data.reason, data.documentUrl ?? null, requestedByUserId
      ]
    );
    await writeAuditLog(client, {
      action: 'MANUAL_DISPENSE_REQUESTED',
      targetType: 'manual_dispense_request',
      targetId: id,
      afterValue: { tankId: tank.id, vehiclePlate: data.vehiclePlate, liters: data.liters, reason: data.reason }
    });
    return res.rows[0];
  });
}

export async function getManualDispenseRequests(filters: {
  status?: string;
  siteName?: string;
}): Promise<ManualDispenseRequestRecord[]> {
  return withTenant(async (client) => {
    const where: string[] = [];
    const params: any[] = [];
    if (filters.status) { params.push(filters.status); where.push(`status = $${params.length}`); }
    if (filters.siteName) { params.push(filters.siteName); where.push(`site_name = $${params.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const res = await client.query(`SELECT * FROM manual_dispense_requests ${clause} ORDER BY created_at DESC`, params);
    return res.rows;
  });
}

export async function getManualDispenseRequest(id: string): Promise<ManualDispenseRequestRecord> {
  return withTenant(async (client) => {
    const res = await client.query('SELECT * FROM manual_dispense_requests WHERE id = $1', [id]);
    if (res.rows.length === 0) throw new NotFoundError('Manuel ikmal kaydı bulunamadı.');
    return res.rows[0];
  });
}

export interface ManualDispenseApprovalResult {
  request: ManualDispenseRequestRecord;
  finalized: boolean;
  transactionId?: string;
}

/**
 * FUEL-405 — bir manuel ikmal kaydına onay ekler.
 *
 * Çift onay kuralı (Kritik Not: "tek onayla açık bırakılırsa tüm otomasyon
 * anlamsızlaşır"):
 *   - İki onay İKİ FARKLI kullanıcıdan gelmeli, talep eden onaylayamaz.
 *   - İkinci (kesinleştiren) onayda roller birlikte {SITE_MANAGER} VE
 *     {COMPANY_OWNER | SUPER_ADMIN} kümelerini karşılamalı.
 * İkinci onay geçince: tank satırı FOR UPDATE ile kilitlenir, stok düşülür ve
 * dispensed_at tarihli GERÇEK bir transactions kaydı üretilir (transaction_id
 * doldurulur). Bu kayıt COMP-601 e-İrsaliye ucundan da işlenebilir.
 */
export async function approveManualDispenseRequest(
  id: string,
  byUserId: string,
  byUserRole: string
): Promise<ManualDispenseApprovalResult> {
  return withTenant(async (client, tenantId) => {
    const res = await client.query('SELECT * FROM manual_dispense_requests WHERE id = $1 FOR UPDATE', [id]);
    if (res.rows.length === 0) throw new NotFoundError('Manuel ikmal kaydı bulunamadı.');
    const reqRow = res.rows[0] as ManualDispenseRequestRecord;

    if (reqRow.status !== 'ONAY_BEKLIYOR') {
      throw new ConflictError(`Kayıt '${reqRow.status}' durumunda — yeni onay kabul edilmez.`, { error: 'ALREADY_RESOLVED' });
    }
    if (byUserId === reqRow.requested_by) {
      throw new ForbiddenError('Talebi oluşturan kişi kendi kaydını onaylayamaz.', { error: 'REQUESTER_CANNOT_APPROVE' });
    }
    if (reqRow.first_approver_id === byUserId) {
      throw new ConflictError('Bu kaydı zaten onayladınız — ikinci onay farklı bir yetkiliden gelmelidir.', { error: 'DUPLICATE_APPROVER' });
    }

    // BİRİNCİ ONAY
    if (!reqRow.first_approver_id) {
      const upd = await client.query(
        `UPDATE manual_dispense_requests
            SET first_approver_id = $2, first_approver_role = $3, first_approved_at = CURRENT_TIMESTAMP
          WHERE id = $1 RETURNING *`,
        [id, byUserId, byUserRole]
      );
      await writeAuditLog(client, {
        action: 'MANUAL_DISPENSE_APPROVED',
        targetType: 'manual_dispense_request',
        targetId: id,
        afterValue: { step: 1, approverId: byUserId, approverRole: byUserRole }
      });
      return { request: upd.rows[0], finalized: false };
    }

    // İKİNCİ ONAY — rol kuralı
    const roles = [reqRow.first_approver_role, byUserRole];
    const hasSiteManager = roles.includes('SITE_MANAGER');
    const hasOwner = roles.some((r) => r === 'COMPANY_OWNER' || r === 'SUPER_ADMIN');
    if (!(hasSiteManager && hasOwner)) {
      throw new ForbiddenError(
        'İki onay birlikte bir SITE_MANAGER ve bir COMPANY_OWNER (veya SUPER_ADMIN) içermelidir.',
        { error: 'APPROVAL_ROLE_RULE_UNMET', roles }
      );
    }

    // Tankı kilitle + stok düş (createTransaction'daki FUEL-402 deseni).
    const tankRes = await client.query(
      'SELECT id, capacity_liters, current_level_liters FROM tanks WHERE id = $1 FOR UPDATE',
      [reqRow.tank_id]
    );
    if (tankRes.rows.length === 0) {
      throw new NotFoundError(`'${reqRow.tank_id}' tankı bulunamadı — kayıt kesinleştirilemiyor.`, { error: 'TANK_NOT_FOUND' });
    }
    const tank = tankRes.rows[0];
    const liters = Number(reqRow.liters);
    const newLevel = Math.max(0, Number(tank.current_level_liters) - liters);
    const pct = (newLevel / Number(tank.capacity_liters)) * 100;
    const newStatus = pct < 20 ? 'KRİTİK' : pct < 40 ? 'UYARI' : 'GÜVENLİ';
    await client.query('UPDATE tanks SET current_level_liters = $1, status = $2 WHERE id = $3', [newLevel, newStatus, tank.id]);

    const txId = generateId('txn');
    await client.query(
      `INSERT INTO transactions
         (id, tenant_id, site_name, vehicle_plate, driver_name, tank_name, amount_liters, pump_status, type, rfid_auth, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        txId, tenantId, reqRow.site_name, reqRow.vehicle_plate, reqRow.driver_name, reqRow.tank_name,
        liters, 'ONAYLANDI', MANUAL_DISPENSE_TX_TYPE, false, reqRow.dispensed_at
      ]
    );

    const upd = await client.query(
      `UPDATE manual_dispense_requests
          SET status = 'ONAYLANDI', second_approver_id = $2, second_approver_role = $3,
              second_approved_at = CURRENT_TIMESTAMP, transaction_id = $4
        WHERE id = $1 RETURNING *`,
      [id, byUserId, byUserRole, txId]
    );
    await writeAuditLog(client, {
      action: 'MANUAL_DISPENSE_FINALIZED',
      targetType: 'manual_dispense_request',
      targetId: id,
      afterValue: {
        step: 2, approverId: byUserId, approverRole: byUserRole,
        transactionId: txId, liters, tankId: tank.id, tankNewLevel: newLevel
      }
    });
    logger.info({ id, transactionId: txId, liters, tankId: tank.id }, '✅ [FUEL-405] Manuel ikmal çift onayla kesinleşti.');
    return { request: upd.rows[0], finalized: true, transactionId: txId };
  });
}

export async function rejectManualDispenseRequest(
  id: string,
  byUserId: string,
  reason: string
): Promise<ManualDispenseRequestRecord> {
  return withTenant(async (client) => {
    const res = await client.query('SELECT status, requested_by FROM manual_dispense_requests WHERE id = $1 FOR UPDATE', [id]);
    if (res.rows.length === 0) throw new NotFoundError('Manuel ikmal kaydı bulunamadı.');
    if (res.rows[0].status !== 'ONAY_BEKLIYOR') {
      throw new ConflictError(`Kayıt '${res.rows[0].status}' durumunda — reddedilemez.`, { error: 'ALREADY_RESOLVED' });
    }
    const upd = await client.query(
      `UPDATE manual_dispense_requests
          SET status = 'REDDEDİLDİ', rejected_by = $2, rejected_at = CURRENT_TIMESTAMP, rejection_reason = $3
        WHERE id = $1 RETURNING *`,
      [id, byUserId, reason]
    );
    await writeAuditLog(client, {
      action: 'MANUAL_DISPENSE_REJECTED',
      targetType: 'manual_dispense_request',
      targetId: id,
      afterValue: { rejectedBy: byUserId, reason }
    });
    return upd.rows[0];
  });
}

export interface ManualDispenseRatioRow {
  siteName: string;
  manualCount: number;
  totalCount: number;
  manualLiters: number;
  ratioPct: number;
  overThreshold: boolean;
}

/**
 * FUEL-405 AC: "Manuel giriş oranı eşiği aşıldığında uyarı üretilmelidir."
 * Şantiye bazında: kesinleşmiş manuel ikmal (transactions.type =
 * 'Manuel (Çift Onaylı)') / tüm ikmal kayıtları — son `days` gün.
 */
export async function getManualDispenseRatio(filters: {
  siteName?: string;
  days: number;
  thresholdPct: number;
}): Promise<{ threshold_pct: number; period_days: number; rows: ManualDispenseRatioRow[]; alertSites: string[] }> {
  return withTenant(async (client) => {
    const params: any[] = [MANUAL_DISPENSE_TX_TYPE, `${filters.days} days`];
    let siteClause = '';
    if (filters.siteName) { params.push(filters.siteName); siteClause = `AND site_name = $${params.length}`; }
    const res = await client.query(
      `SELECT site_name,
              COUNT(*) FILTER (WHERE type = $1)                       AS manual_count,
              COUNT(*)                                                AS total_count,
              COALESCE(SUM(amount_liters) FILTER (WHERE type = $1), 0) AS manual_liters
         FROM transactions
        WHERE created_at >= NOW() - $2::interval ${siteClause}
        GROUP BY site_name
        ORDER BY site_name`,
      params
    );
    const rows: ManualDispenseRatioRow[] = res.rows.map((r: any) => {
      const manualCount = Number(r.manual_count);
      const totalCount = Number(r.total_count);
      const ratioPct = totalCount > 0 ? Math.round((manualCount / totalCount) * 10000) / 100 : 0;
      return {
        siteName: r.site_name,
        manualCount,
        totalCount,
        manualLiters: Math.round(Number(r.manual_liters) * 100) / 100,
        ratioPct,
        overThreshold: ratioPct > filters.thresholdPct
      };
    });
    return {
      threshold_pct: filters.thresholdPct,
      period_days: filters.days,
      rows,
      alertSites: rows.filter((x) => x.overThreshold).map((x) => x.siteName)
    };
  });
}

// ============================================================================
// AUTH-208: OTURUM KAPATMA DENETİM KAYDI
// ============================================================================

/**
 * AUTH-208 AC: "Oturum kapatma işlemi audit log'a yazılmalıdır."
 * Oturum uçları authenticateJWT arkasında olduğundan tenant context (RLS)
 * mevcuttur — writeAuditLog aynı transaction'da çalışır.
 */
export async function auditSessionRevocation(
  targetUserId: string,
  detail: Record<string, unknown>
): Promise<void> {
  await withTenant(async (client) => {
    await writeAuditLog(client, {
      action: 'SESSION_REVOKED',
      targetType: 'auth_session',
      targetId: targetUserId,
      afterValue: detail
    });
  });
}

// ============================================================================
// AI-504: MESAİ DIŞI / GECE ALIMI + KISA ARALIKLI MÜKERRER ALIM TESPİTİ
// ============================================================================

const DEFAULT_WORKING_HOURS = {
  start_minute: 420,   // 07:00
  end_minute: 1140,    // 19:00
  working_days: [1, 2, 3, 4, 5, 6] as number[], // Pzt-Cmt
  is_24_7: false,
  rapid_repeat_window_minutes: 30
};

export interface SiteWorkingHoursRecord {
  id: string;
  tenant_id: string;
  site_name: string;
  start_minute: number;
  end_minute: number;
  working_days: number[];
  is_24_7: boolean;
  rapid_repeat_window_minutes: number;
  updated_by: string;
  updated_at: string;
  created_at: string;
}

/** Europe/Istanbul (sabit UTC+3) yerel gün-içi dakika + ISO haftagünü. */
function istanbulLocalParts(d: Date): { minuteOfDay: number; isoWeekday: number; hhmm: string } {
  const local = new Date(d.getTime() + 3 * 60 * 60 * 1000);
  const h = local.getUTCHours();
  const m = local.getUTCMinutes();
  const jsDay = local.getUTCDay(); // 0=Pazar
  return {
    minuteOfDay: h * 60 + m,
    isoWeekday: jsDay === 0 ? 7 : jsDay,
    hhmm: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  };
}
function minutesToHHMM(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export async function setSiteWorkingHours(
  siteName: string,
  data: { startMinute: number; endMinute: number; workingDays: number[]; is247: boolean; rapidRepeatWindowMinutes: number },
  updatedByUserId: string
): Promise<SiteWorkingHoursRecord> {
  return withTenant(async (client, tenantId) => {
    const res = await client.query(
      `INSERT INTO site_working_hours
         (id, tenant_id, site_name, start_minute, end_minute, working_days, is_24_7, rapid_repeat_window_minutes, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (tenant_id, site_name) DO UPDATE SET
         start_minute = EXCLUDED.start_minute,
         end_minute = EXCLUDED.end_minute,
         working_days = EXCLUDED.working_days,
         is_24_7 = EXCLUDED.is_24_7,
         rapid_repeat_window_minutes = EXCLUDED.rapid_repeat_window_minutes,
         updated_by = EXCLUDED.updated_by,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        generateId('swh'), tenantId, siteName, data.startMinute, data.endMinute,
        data.workingDays, data.is247, data.rapidRepeatWindowMinutes, updatedByUserId
      ]
    );
    await writeAuditLog(client, {
      action: 'SITE_WORKING_HOURS_SET',
      targetType: 'site_working_hours',
      targetId: siteName,
      afterValue: { ...data }
    });
    return res.rows[0];
  });
}

export async function getSiteWorkingHours(siteName: string): Promise<SiteWorkingHoursRecord & { isDefault: boolean }> {
  return withTenant(async (client, tenantId) => {
    const res = await client.query('SELECT * FROM site_working_hours WHERE site_name = $1', [siteName]);
    if (res.rows.length > 0) return { ...res.rows[0], isDefault: false };
    return {
      id: '', tenant_id: tenantId, site_name: siteName,
      ...DEFAULT_WORKING_HOURS,
      updated_by: '', updated_at: '', created_at: '', isDefault: true
    };
  });
}

export interface AnomalyFlagRecord {
  id: string;
  tenant_id: string;
  transaction_id: string;
  anomaly_type: string;
  severity: string;
  site_name: string;
  vehicle_plate: string;
  driver_name: string | null;
  transaction_at: string;
  amount_liters: string | null;
  detail: any;
  status: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  detected_at: string;
}

export interface AnomalyScanResult {
  scannedTransactions: number;
  sinceHours: number;
  newFlags: { MESAI_DISI: number; KISA_ARALIK_MUKERRER: number };
}

/**
 * AI-504 — kural tabanlı tespit. Mevcut tenant context'inde son `sinceHours`
 * saatlik (veya verilen `transactionIds`) ikmalleri tarar:
 *   1. MESAI_DISI: şantiyenin mesai saatleri/çalışma günleri dışında yapılan
 *      alım (is_24_7 şantiyeler MUAF — Kritik Not / AC).
 *   2. KISA_ARALIK_MUKERRER: aynı araca, yapılandırılan pencere içinde (ö.
 *      30 dk) yapılan ikinci alım — ALARM DEĞİL, "İNCELEME" kaydı (Kritik Not).
 * Tespit idempotent: (transaction_id, anomaly_type) benzersiz.
 */
export async function runAnomalyDetectionForCurrentTenant(opts: {
  sinceHours?: number;
  transactionIds?: string[];
}): Promise<AnomalyScanResult> {
  return withTenant(async (client, tenantId) => {
    const sinceHours = opts.sinceHours ?? 168;

    const whRes = await client.query('SELECT * FROM site_working_hours');
    const whMap = new Map<string, SiteWorkingHoursRecord>();
    for (const r of whRes.rows) whMap.set(r.site_name, r);

    const params: any[] = [];
    let filterClause: string;
    if (opts.transactionIds && opts.transactionIds.length > 0) {
      params.push(opts.transactionIds);
      filterClause = `t.id = ANY($1::text[])`;
    } else {
      params.push(`${sinceHours} hours`);
      filterClause = `t.created_at >= NOW() - $1::interval`;
    }

    const txRes = await client.query(
      `SELECT t.id, t.site_name, t.vehicle_plate, t.driver_name, t.amount_liters, t.created_at,
              LAG(t.created_at) OVER (PARTITION BY t.vehicle_plate ORDER BY t.created_at) AS prev_at,
              LAG(t.id)         OVER (PARTITION BY t.vehicle_plate ORDER BY t.created_at) AS prev_id
         FROM transactions t
        WHERE ${filterClause}
        ORDER BY t.created_at`,
      params
    );

    const toInsert: Array<{ type: string; severity: string; row: any; detail: any }> = [];
    for (const row of txRes.rows) {
      const cfg = whMap.get(row.site_name);
      const startMin = cfg?.start_minute ?? DEFAULT_WORKING_HOURS.start_minute;
      const endMin = cfg?.end_minute ?? DEFAULT_WORKING_HOURS.end_minute;
      const days: number[] = cfg?.working_days ?? DEFAULT_WORKING_HOURS.working_days;
      const is247 = cfg?.is_24_7 ?? DEFAULT_WORKING_HOURS.is_24_7;
      const repeatWindowMin = cfg?.rapid_repeat_window_minutes ?? DEFAULT_WORKING_HOURS.rapid_repeat_window_minutes;

      const { minuteOfDay, isoWeekday, hhmm } = istanbulLocalParts(new Date(row.created_at));

      if (!is247) {
        const outsideDay = !days.includes(isoWeekday);
        const outsideHours = minuteOfDay < startMin || minuteOfDay >= endMin;
        if (outsideDay || outsideHours) {
          toInsert.push({
            type: 'MESAI_DISI',
            severity: 'INCELEME',
            row,
            detail: {
              localTime: hhmm,
              isoWeekday,
              isNight: minuteOfDay < 360 || minuteOfDay >= 1320,
              reason: outsideDay ? 'CALISMA_GUNU_DISI' : 'MESAI_SAATI_DISI',
              workingWindow: `${minutesToHHMM(startMin)}-${minutesToHHMM(endMin)}`,
              workingDays: days
            }
          });
        }
      }

      if (row.prev_at) {
        const gapMs = new Date(row.created_at).getTime() - new Date(row.prev_at).getTime();
        if (gapMs >= 0 && gapMs <= repeatWindowMin * 60_000) {
          toInsert.push({
            type: 'KISA_ARALIK_MUKERRER',
            severity: 'INCELEME',
            row,
            detail: {
              previousTransactionId: row.prev_id,
              gapMinutes: Math.round(gapMs / 60_000),
              windowMinutes: repeatWindowMin
            }
          });
        }
      }
    }

    const counts = { MESAI_DISI: 0, KISA_ARALIK_MUKERRER: 0 };
    for (const f of toInsert) {
      const ins = await client.query(
        `INSERT INTO transaction_anomaly_flags
           (id, tenant_id, transaction_id, anomaly_type, severity, site_name, vehicle_plate, driver_name, transaction_at, amount_liters, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (transaction_id, anomaly_type) DO NOTHING
         RETURNING id`,
        [
          generateId('anom'), tenantId, f.row.id, f.type, f.severity, f.row.site_name,
          f.row.vehicle_plate, f.row.driver_name, f.row.created_at, f.row.amount_liters, JSON.stringify(f.detail)
        ]
      );
      if (ins.rows.length > 0) {
        counts[f.type as 'MESAI_DISI' | 'KISA_ARALIK_MUKERRER']++;
        // AI-507: her yeni işaret birleşik alarm yaşam döngüsüne akar. Gruplama
        // anahtarı (kategori + plaka) → aynı aracın 10 mesai-dışı alımı = 1
        // alarm + 10 olay.
        const alarmCategory: AlarmCategory = f.type === 'MESAI_DISI' ? 'OFFHOURS_DISPENSE' : 'RAPID_REPEAT';
        await raiseAlarm(client, tenantId, {
          alarmKey: `${alarmCategory}:${f.row.vehicle_plate}`,
          category: alarmCategory,
          severity: 'WARNING',
          title: f.type === 'MESAI_DISI'
            ? `Mesai dışı yakıt alımı: ${f.row.vehicle_plate} @ ${f.row.site_name}`
            : `Kısa aralıklı mükerrer alım: ${f.row.vehicle_plate}`,
          siteName: f.row.site_name,
          subjectType: 'VEHICLE',
          subjectId: f.row.vehicle_plate,
          detail: { transactionId: f.row.id, ...f.detail },
          sourceRef: { table: 'transaction_anomaly_flags', transactionId: f.row.id, anomalyType: f.type }
        });
      }
    }

    if (counts.MESAI_DISI + counts.KISA_ARALIK_MUKERRER > 0) {
      await writeAuditLog(client, {
        action: 'ANOMALY_SCAN',
        targetType: 'transaction_anomaly_flags',
        targetId: tenantId,
        afterValue: { sinceHours, scanned: txRes.rows.length, newFlags: counts }
      });
    }

    return { scannedTransactions: txRes.rows.length, sinceHours, newFlags: counts };
  });
}

export async function getAnomalyFlags(filters: {
  type?: string;
  status?: string;
  siteName?: string;
  from?: string;
  to?: string;
}): Promise<AnomalyFlagRecord[]> {
  return withTenant(async (client) => {
    const where: string[] = [];
    const params: any[] = [];
    if (filters.type) { params.push(filters.type); where.push(`anomaly_type = $${params.length}`); }
    if (filters.status) { params.push(filters.status); where.push(`status = $${params.length}`); }
    if (filters.siteName) { params.push(filters.siteName); where.push(`site_name = $${params.length}`); }
    if (filters.from) { params.push(filters.from); where.push(`transaction_at >= $${params.length}`); }
    if (filters.to) { params.push(filters.to); where.push(`transaction_at <= $${params.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const res = await client.query(`SELECT * FROM transaction_anomaly_flags ${clause} ORDER BY transaction_at DESC, detected_at DESC`, params);
    return res.rows;
  });
}

export async function getAnomalyFlag(id: string): Promise<AnomalyFlagRecord> {
  return withTenant(async (client) => {
    const res = await client.query('SELECT * FROM transaction_anomaly_flags WHERE id = $1', [id]);
    if (res.rows.length === 0) throw new NotFoundError('Anomali işareti bulunamadı.');
    return res.rows[0];
  });
}

export async function reviewAnomalyFlag(
  id: string,
  byUserId: string,
  data: { status: 'INCELENDI' | 'MUAF'; reviewNote?: string }
): Promise<AnomalyFlagRecord> {
  return withTenant(async (client) => {
    const res = await client.query(
      `UPDATE transaction_anomaly_flags
          SET status = $2, reviewed_by = $3, reviewed_at = CURRENT_TIMESTAMP, review_note = $4
        WHERE id = $1 RETURNING *`,
      [id, data.status, byUserId, data.reviewNote ?? null]
    );
    if (res.rows.length === 0) throw new NotFoundError('Anomali işareti bulunamadı.');
    await writeAuditLog(client, {
      action: 'ANOMALY_FLAG_REVIEWED',
      targetType: 'transaction_anomaly_flag',
      targetId: id,
      afterValue: { status: data.status, by: byUserId, note: data.reviewNote ?? null }
    });
    return res.rows[0];
  });
}

// ============================================================================
// AI-507: BİRLEŞİK ALARM YAŞAM DÖNGÜSÜ (durum, atama, susturma, eskalasyon,
//         gruplama, yanlış-pozitif geri beslemesi)
// ============================================================================

export type AlarmCategory =
  | 'THEFT' | 'CONSUMPTION_ANOMALY' | 'STOCK_RECONCILIATION' | 'OFFHOURS_DISPENSE'
  | 'RAPID_REPEAT' | 'NEGATIVE_STOCK' | 'CALIBRATION_DRIFT' | 'MANUAL_ENTRY_RATIO'
  // FUEL-406 (peer session, backend/src/iot/unauthorizedFlowDetector.ts):
  // kartsız/yetkisiz akış tespiti — dispense oturumu olmadan pompa akışı.
  | 'UNAUTHORIZED_FLOW'
  // FLEET-1406: araç bazlı yakıt limiti 'WARN' modunda dolduğunda.
  | 'VEHICLE_LIMIT_EXCEEDED'
  // BILL-1702 (backend/src/services/licenseWarningService.ts): lisans süresi
  // 30/15/7 gün içinde dolacak firmalara proaktif uyarı.
  | 'LICENSE_EXPIRY'
  // FLEET-1407: bir aracın bakımı süre/sayaç eşiğini geçtiğinde/yaklaştığında.
  | 'MAINTENANCE_DUE' | 'OTHER';
export type AlarmSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
export type AlarmStatus = 'OPEN' | 'ACKNOWLEDGED' | 'INVESTIGATING' | 'RESOLVED' | 'FALSE_POSITIVE';

const SEVERITY_RANK: Record<AlarmSeverity, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };
const ALARM_TERMINAL: AlarmStatus[] = ['RESOLVED', 'FALSE_POSITIVE'];
// AI-507 AC: "Kritik alarm belirlenen sürede yanıtlanmazsa eskalasyon".
const ALARM_ESCALATE_AFTER_MINUTES = 60;
const ALARM_MAX_ESCALATION_LEVEL = 3;

export interface AlarmSpec {
  alarmKey: string;
  category: AlarmCategory;
  severity: AlarmSeverity;
  title: string;
  siteName?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  detail?: Record<string, unknown>;
  sourceRef?: Record<string, unknown>;
}

export interface RaiseAlarmResult {
  alarmId: string;
  isNew: boolean;
  reopened: boolean;
  suppressed: boolean;
  status: AlarmStatus;
}

/**
 * AI-507 çekirdeği — tüm alarm kaynaklarının çağırdığı TEK huni. (tenant_id,
 * alarm_key) BENZERSİZ olduğundan aynı kök nedenden doğan tekrarlar yeni satır
 * DEĞİL, mevcut alarmın event_count'unu artırır + alarm_events'e bir olay ekler
 * (Kritik Not: "50 ayrı alarm yerine 1 alarm + 50 olay"). `client` çağıranın
 * withTenant transaction'ıdır → atomik.
 */
export async function raiseAlarm(
  client: any,
  tenantId: string,
  spec: AlarmSpec
): Promise<RaiseAlarmResult> {
  const found = await client.query(
    'SELECT id, severity, status, snoozed_until FROM alarms WHERE tenant_id = $1 AND alarm_key = $2 FOR UPDATE',
    [tenantId, spec.alarmKey]
  );

  if (found.rows.length === 0) {
    const id = generateId('alarm');
    await client.query(
      `INSERT INTO alarms (id, tenant_id, alarm_key, category, severity, title, site_name, subject_type, subject_id, source_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id, tenantId, spec.alarmKey, spec.category, spec.severity, spec.title,
        spec.siteName ?? null, spec.subjectType ?? null, spec.subjectId ?? null,
        spec.sourceRef ? JSON.stringify(spec.sourceRef) : null
      ]
    );
    await client.query(
      `INSERT INTO alarm_events (id, tenant_id, alarm_id, detail) VALUES ($1,$2,$3,$4)`,
      [generateId('almev'), tenantId, id, JSON.stringify(spec.detail ?? {})]
    );
    return { alarmId: id, isNew: true, reopened: false, suppressed: false, status: 'OPEN' };
  }

  const a = found.rows[0];
  await client.query(
    `INSERT INTO alarm_events (id, tenant_id, alarm_id, detail) VALUES ($1,$2,$3,$4)`,
    [generateId('almev'), tenantId, a.id, JSON.stringify(spec.detail ?? {})]
  );

  const snoozedActive = a.snoozed_until && new Date(a.snoozed_until).getTime() > Date.now();
  const newSeverity: AlarmSeverity =
    SEVERITY_RANK[spec.severity] > SEVERITY_RANK[a.severity as AlarmSeverity] ? spec.severity : (a.severity as AlarmSeverity);

  let newStatus: AlarmStatus = a.status;
  let reopened = false;
  if (!snoozedActive && ALARM_TERMINAL.includes(a.status)) {
    newStatus = 'OPEN'; // kapatılmış bir alarm tekrar tetiklendi → yeniden aç
    reopened = true;
  }

  await client.query(
    `UPDATE alarms SET
        event_count = event_count + 1,
        last_seen_at = CURRENT_TIMESTAMP,
        severity = $2,
        status = $3,
        title = $4,
        resolved_at = CASE WHEN $5 THEN NULL ELSE resolved_at END,
        resolved_by = CASE WHEN $5 THEN NULL ELSE resolved_by END,
        resolution_note = CASE WHEN $5 THEN NULL ELSE resolution_note END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1`,
    [a.id, newSeverity, newStatus, spec.title, reopened]
  );
  return { alarmId: a.id, isNew: false, reopened, suppressed: !!snoozedActive, status: newStatus };
}

export async function raiseAlarmForCurrentTenant(spec: AlarmSpec): Promise<RaiseAlarmResult> {
  return withTenant((client, tenantId) => raiseAlarm(client, tenantId, spec));
}

export interface AlarmRecord {
  id: string;
  tenant_id: string;
  alarm_key: string;
  category: string;
  severity: string;
  title: string;
  site_name: string | null;
  subject_type: string | null;
  subject_id: string | null;
  status: string;
  assignee_id: string | null;
  event_count: number;
  first_seen_at: string;
  last_seen_at: string;
  snoozed_until: string | null;
  escalation_level: number;
  escalated_at: string | null;
  resolution_note: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  source_ref: any;
  created_at: string;
  updated_at: string;
}

export async function getAlarms(filters: {
  status?: string;
  category?: string;
  severity?: string;
  siteName?: string;
  assigneeId?: string;
  includeSnoozed?: boolean;
  includeResolved?: boolean;
}): Promise<AlarmRecord[]> {
  return withTenant(async (client) => {
    const where: string[] = [];
    const params: any[] = [];
    if (filters.status) {
      params.push(filters.status); where.push(`status = $${params.length}`);
    } else if (!filters.includeResolved) {
      where.push(`status NOT IN ('RESOLVED', 'FALSE_POSITIVE')`);
    }
    if (!filters.includeSnoozed) where.push(`(snoozed_until IS NULL OR snoozed_until <= NOW())`);
    if (filters.category) { params.push(filters.category); where.push(`category = $${params.length}`); }
    if (filters.severity) { params.push(filters.severity); where.push(`severity = $${params.length}`); }
    if (filters.siteName) { params.push(filters.siteName); where.push(`site_name = $${params.length}`); }
    if (filters.assigneeId) { params.push(filters.assigneeId); where.push(`assignee_id = $${params.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const res = await client.query(
      `SELECT * FROM alarms ${clause}
        ORDER BY (severity = 'CRITICAL') DESC, escalation_level DESC, last_seen_at DESC`,
      params
    );
    return res.rows;
  });
}

export async function getAlarm(id: string): Promise<AlarmRecord & { events: any[] }> {
  return withTenant(async (client) => {
    const res = await client.query('SELECT * FROM alarms WHERE id = $1', [id]);
    if (res.rows.length === 0) throw new NotFoundError('Alarm bulunamadı.');
    const events = await client.query(
      'SELECT id, detail, occurred_at FROM alarm_events WHERE alarm_id = $1 ORDER BY occurred_at DESC LIMIT 100',
      [id]
    );
    return { ...res.rows[0], events: events.rows };
  });
}

export async function updateAlarm(
  id: string,
  byUserId: string,
  data: { status?: AlarmStatus; assigneeId?: string | null; resolutionNote?: string }
): Promise<AlarmRecord> {
  return withTenant(async (client, tenantId) => {
    const cur = await client.query('SELECT * FROM alarms WHERE id = $1 FOR UPDATE', [id]);
    if (cur.rows.length === 0) throw new NotFoundError('Alarm bulunamadı.');
    const before = cur.rows[0] as AlarmRecord;

    const sets: string[] = ['updated_at = CURRENT_TIMESTAMP'];
    const params: any[] = [id];

    if (data.assigneeId !== undefined) {
      if (data.assigneeId) {
        const u = await client.query('SELECT 1 FROM users WHERE id = $1', [data.assigneeId]);
        if (u.rows.length === 0) throw new BadRequestError('Atanacak kullanıcı bulunamadı.', { error: 'ASSIGNEE_NOT_FOUND' });
      }
      params.push(data.assigneeId);
      sets.push(`assignee_id = $${params.length}`);
    }

    if (data.status) {
      const terminal = ALARM_TERMINAL.includes(data.status);
      if (terminal && !(data.resolutionNote && data.resolutionNote.trim().length >= 3)) {
        throw new BadRequestError('RESOLVED / FALSE_POSITIVE için resolutionNote (en az 3 karakter) zorunludur.', { error: 'RESOLUTION_NOTE_REQUIRED' });
      }
      params.push(data.status);
      sets.push(`status = $${params.length}`);
      if (terminal) {
        params.push(byUserId); sets.push(`resolved_by = $${params.length}`);
        sets.push(`resolved_at = CURRENT_TIMESTAMP`);
      } else {
        sets.push(`resolved_by = NULL`, `resolved_at = NULL`);
      }
    }
    if (data.resolutionNote !== undefined) {
      params.push(data.resolutionNote);
      sets.push(`resolution_note = $${params.length}`);
    }

    const res = await client.query(`UPDATE alarms SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    await writeAuditLog(client, {
      action: 'ALARM_UPDATED',
      targetType: 'alarm',
      targetId: id,
      beforeValue: { status: before.status, assigneeId: before.assignee_id },
      afterValue: { status: res.rows[0].status, assigneeId: res.rows[0].assignee_id, by: byUserId, resolutionNote: data.resolutionNote }
    });
    return res.rows[0];
  });
}

export async function snoozeAlarm(id: string, byUserId: string, minutes: number): Promise<AlarmRecord> {
  return withTenant(async (client) => {
    const res = await client.query(
      `UPDATE alarms SET snoozed_until = NOW() + ($2 || ' minutes')::interval, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 RETURNING *`,
      [id, String(minutes)]
    );
    if (res.rows.length === 0) throw new NotFoundError('Alarm bulunamadı.');
    await writeAuditLog(client, {
      action: 'ALARM_SNOOZED',
      targetType: 'alarm',
      targetId: id,
      afterValue: { minutes, until: res.rows[0].snoozed_until, by: byUserId }
    });
    return res.rows[0];
  });
}

/**
 * AI-507 AC: "FALSE_POSITIVE işaretlemeleri eşik kalibrasyonu için
 * toplanmalıdır." Bu uç, o toplamı kategori bazında sunar (eşik ayarını
 * elle/otomatik gözden geçirmek için).
 */
export async function getFalsePositiveFeedback(): Promise<{
  byCategory: Array<{ category: string; falsePositives: number; totalResolved: number; falsePositiveRate: number }>;
  recent: Array<{ id: string; category: string; title: string; resolution_note: string | null; resolved_at: string }>;
}> {
  return withTenant(async (client) => {
    const agg = await client.query(
      `SELECT category,
              COUNT(*) FILTER (WHERE status = 'FALSE_POSITIVE') AS fp,
              COUNT(*) FILTER (WHERE status IN ('RESOLVED', 'FALSE_POSITIVE')) AS closed
         FROM alarms GROUP BY category ORDER BY fp DESC`
    );
    const recent = await client.query(
      `SELECT id, category, title, resolution_note, resolved_at FROM alarms
        WHERE status = 'FALSE_POSITIVE' ORDER BY resolved_at DESC NULLS LAST LIMIT 50`
    );
    return {
      byCategory: agg.rows.map((r: any) => {
        const fp = Number(r.fp);
        const closed = Number(r.closed);
        return {
          category: r.category,
          falsePositives: fp,
          totalResolved: closed,
          falsePositiveRate: closed > 0 ? Math.round((fp / closed) * 10000) / 100 : 0
        };
      }),
      recent: recent.rows
    };
  });
}

/**
 * AI-507 — index.ts saatlik süpürücüsü. CRITICAL + OPEN + atanmamış +
 * susturulmamış, eşik süreyi (kademe başına) aşan alarmların escalation_level'ını
 * artırır. Döndürülen satırları çağıran (index.ts) WebSocket'te yayınlar.
 */
export async function runAlarmEscalationForCurrentTenant(): Promise<Array<{ id: string; title: string; escalation_level: number; site_name: string | null }>> {
  return withTenant(async (client) => {
    const res = await client.query(
      `UPDATE alarms SET escalation_level = escalation_level + 1, escalated_at = NOW(), updated_at = NOW()
        WHERE severity = 'CRITICAL'
          AND status = 'OPEN'
          AND assignee_id IS NULL
          AND escalation_level < $1
          AND (snoozed_until IS NULL OR snoozed_until <= NOW())
          AND COALESCE(escalated_at, first_seen_at) <= NOW() - (($2 * (escalation_level + 1)) || ' minutes')::interval
      RETURNING id, title, escalation_level, site_name`,
      [ALARM_MAX_ESCALATION_LEVEL, ALARM_ESCALATE_AFTER_MINUTES]
    );
    return res.rows;
  });
}

// ============================================================================
// COMP-605: MÜKELLEF (VKN/TCKN) DOĞRULAMA + ALICI BİLGİSİ KONTROLÜ
// ============================================================================

const RECIPIENT_REQUIRED_FIELDS = ['title', 'address', 'tax_office'] as const;

export interface RecipientTaxpayerRecord {
  id: string;
  tenant_id: string;
  tax_id: string;
  tax_id_type: string;
  title: string | null;
  address: string | null;
  tax_office: string | null;
  is_einvoice_obligated: boolean | null;
  obligation_checked_at: string | null;
  obligation_source: string | null;
  missing_fields: string[];
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function computeMissingRecipientFields(data: { title?: string; address?: string; taxOffice?: string }): string[] {
  const missing: string[] = [];
  if (!data.title || !data.title.trim()) missing.push('title');
  if (!data.address || !data.address.trim()) missing.push('address');
  if (!data.taxOffice || !data.taxOffice.trim()) missing.push('tax_office');
  return missing;
}

/**
 * COMP-605 — alıcı mükellef kaydı oluşturur/günceller. VKN/TCKN algoritmik
 * doğrulamadan geçmezse INVALID (AC). Kayıt oluşur ama unvan/adres/vergi
 * dairesi eksikse `missing_fields` uyarısıyla döner (AC: "eksik alan uyarısı").
 * e-İrsaliye mükellefiyeti sorgulanıp saklanır.
 */
export async function upsertRecipientTaxpayer(
  data: { taxId: string; title?: string; address?: string; taxOffice?: string; status?: string },
  createdByUserId: string
): Promise<{ recipient: RecipientTaxpayerRecord; obligation: { obligated: boolean; source: string; checkedAt: string }; warnings: string[] }> {
  const v = validateTaxId(data.taxId);
  if (!v.ok) {
    throw new BadRequestError(`VKN/TCKN geçersiz: ${v.reason}`, { error: 'INVALID_TAX_ID', taxId: v.normalized, kind: v.kind });
  }
  const oblig = await getEInvoiceObligation(v.normalized);
  const missing = computeMissingRecipientFields(data);

  return withTenant(async (client, tenantId) => {
    const res = await client.query(
      `INSERT INTO recipient_taxpayers
         (id, tenant_id, tax_id, tax_id_type, title, address, tax_office, is_einvoice_obligated, obligation_checked_at, obligation_source, missing_fields, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP,$9,$10,$11,$12)
       ON CONFLICT (tenant_id, tax_id) DO UPDATE SET
         tax_id_type = EXCLUDED.tax_id_type,
         title = EXCLUDED.title,
         address = EXCLUDED.address,
         tax_office = EXCLUDED.tax_office,
         is_einvoice_obligated = EXCLUDED.is_einvoice_obligated,
         obligation_checked_at = CURRENT_TIMESTAMP,
         obligation_source = EXCLUDED.obligation_source,
         missing_fields = EXCLUDED.missing_fields,
         status = EXCLUDED.status,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        generateId('rcpt'), tenantId, v.normalized, v.kind, data.title ?? null, data.address ?? null,
        data.taxOffice ?? null, oblig.obligated, oblig.source, missing, data.status ?? 'AKTİF', createdByUserId
      ]
    );
    await writeAuditLog(client, {
      action: 'RECIPIENT_TAXPAYER_UPSERTED',
      targetType: 'recipient_taxpayer',
      targetId: res.rows[0].id,
      afterValue: { taxId: v.normalized, kind: v.kind, obligated: oblig.obligated, missingFields: missing }
    });

    const warnings: string[] = [];
    if (missing.length > 0) warnings.push(`Eksik zorunlu alan(lar): ${missing.join(', ')}. Bu alanlar tamamlanmadan e-İrsaliye reddedilebilir.`);
    if (!oblig.obligated) warnings.push('Bu alıcı e-İrsaliye mükellefi değil — belge kesilirse KAĞIT süreç işaretlenir.');
    return { recipient: res.rows[0], obligation: { obligated: oblig.obligated, source: oblig.source, checkedAt: oblig.checkedAt }, warnings };
  });
}

export async function getRecipientTaxpayers(): Promise<RecipientTaxpayerRecord[]> {
  return withTenant(async (client) => {
    const res = await client.query('SELECT * FROM recipient_taxpayers ORDER BY created_at DESC');
    return res.rows;
  });
}

export async function getRecipientTaxpayer(id: string): Promise<RecipientTaxpayerRecord> {
  return withTenant(async (client) => {
    const res = await client.query('SELECT * FROM recipient_taxpayers WHERE id = $1', [id]);
    if (res.rows.length === 0) throw new NotFoundError('Alıcı kaydı bulunamadı.');
    return res.rows[0];
  });
}

/** COMP-605 — mükellefiyet durumunu entegratörden (taklit) yeniden sorgular. */
export async function refreshRecipientObligation(id: string): Promise<RecipientTaxpayerRecord> {
  return withTenant(async (client) => {
    const cur = await client.query('SELECT tax_id FROM recipient_taxpayers WHERE id = $1', [id]);
    if (cur.rows.length === 0) throw new NotFoundError('Alıcı kaydı bulunamadı.');
    const oblig = await getEInvoiceObligation(cur.rows[0].tax_id, true);
    const res = await client.query(
      `UPDATE recipient_taxpayers SET is_einvoice_obligated = $2, obligation_checked_at = CURRENT_TIMESTAMP, obligation_source = $3, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 RETURNING *`,
      [id, oblig.obligated, oblig.source]
    );
    return res.rows[0];
  });
}

// ============================================================================
// FUEL-407: ÇOKLU TANK/POMPA/YAKIT TİPİ — POMPA-TANK EŞLEMESİ + YAKIT TİPİ STOK
// ============================================================================

/**
 * FUEL-407 — bir pompanın (hardware_devices) hangi tanktan beslendiğini
 * ayarlar. Bir tank BİRDEN ÇOK pompaya bağlanabilir (benzersizlik yok).
 * tankName null → eşleme kaldırılır.
 */
export async function setHardwareDeviceTank(deviceId: string, tankName: string | null): Promise<{ deviceId: string; tankName: string | null }> {
  return withTenant(async (client) => {
    if (tankName) {
      const t = await client.query('SELECT 1 FROM tanks WHERE name = $1', [tankName]);
      if (t.rows.length === 0) throw new NotFoundError(`'${tankName}' tankı bu firmada bulunamadı.`, { error: 'TANK_NOT_FOUND' });
    }
    const res = await client.query(
      'UPDATE hardware_devices SET tank_name = $2 WHERE device_id = $1 RETURNING device_id, tank_name',
      [deviceId, tankName]
    );
    if (res.rows.length === 0) throw new NotFoundError(`'${deviceId}' cihazı bulunamadı.`, { error: 'DEVICE_NOT_FOUND' });
    await writeAuditLog(client, {
      action: 'DEVICE_TANK_MAPPED',
      targetType: 'hardware_device',
      targetId: deviceId,
      afterValue: { tankName }
    });
    return { deviceId: res.rows[0].device_id, tankName: res.rows[0].tank_name };
  });
}

export interface FuelStockByType {
  fuelType: string;
  group: string;
  isFuel: boolean;
  gtip: string;
  tankCount: number;
  currentStockLiters: number;
  dispensedLiters: number;
  transactionCount: number;
}

/**
 * FUEL-407 AC: "Stok ve raporlar yakıt tipi bazında ayrışmalıdır."
 * Tank stoğu (o anki) + son `days` günün ikmal toplamı, yakıt tipi bazında.
 */
export async function getFuelStockSummary(days: number): Promise<{ periodDays: number; byFuelType: FuelStockByType[] }> {
  return withTenant(async (client) => {
    const tankRows = await client.query(
      `SELECT COALESCE(fuel_type, 'Tanımsız') AS ft, COUNT(*)::int AS n, COALESCE(SUM(current_level_liters), 0)::numeric AS lvl
         FROM tanks GROUP BY COALESCE(fuel_type, 'Tanımsız')`
    );
    const txRows = await client.query(
      `SELECT COALESCE(fuel_type, 'Tanımsız') AS ft, COUNT(*)::int AS n, COALESCE(SUM(amount_liters), 0)::numeric AS lit
         FROM transactions WHERE created_at >= NOW() - ($1 || ' days')::interval
        GROUP BY COALESCE(fuel_type, 'Tanımsız')`,
      [String(days)]
    );
    const txMap = new Map<string, { n: number; lit: number }>();
    for (const r of txRows.rows) txMap.set(r.ft, { n: Number(r.n), lit: Number(r.lit) });

    const keys = new Set<string>([...tankRows.rows.map((r: any) => r.ft), ...txMap.keys()]);
    const byFuelType: FuelStockByType[] = [];
    for (const ft of keys) {
      const info = resolveFuelType(ft === 'Tanımsız' ? null : ft);
      const tank = tankRows.rows.find((r: any) => r.ft === ft);
      const tx = txMap.get(ft);
      byFuelType.push({
        fuelType: ft,
        group: info.group,
        isFuel: info.isFuel,
        gtip: info.gtip,
        tankCount: tank ? Number(tank.n) : 0,
        currentStockLiters: tank ? Math.round(Number(tank.lvl) * 100) / 100 : 0,
        dispensedLiters: tx ? Math.round(tx.lit * 100) / 100 : 0,
        transactionCount: tx ? tx.n : 0
      });
    }
    byFuelType.sort((a, b) => b.currentStockLiters - a.currentStockLiters);
    return { periodDays: days, byFuelType };
  });
}

// ============================================================================
// FLEET-1404 + RES-903: ARAÇ SAYAÇ (KM / MOTOR-SAAT) GİRİŞİ + DOĞRULAMA
// ============================================================================

function istanbulMonthLabel(d: Date): string {
  const local = new Date(d.getTime() + 3 * 60 * 60 * 1000);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface MeterReadingRecord {
  id: string;
  tenant_id: string;
  vehicle_id: string;
  vehicle_plate: string;
  meter_type: string;
  reading_value: string;
  reading_at: string;
  period_label: string;
  source: string;
  is_suspicious: boolean;
  suspicion_reasons: string[];
  override_approved: boolean;
  override_reason: string | null;
  approved_by: string | null;
  corrects_reading_id: string | null;
  note: string | null;
  entered_by: string;
  created_at: string;
}

export interface RecordMeterReadingInput {
  meterType?: MeterType;
  value: number;
  readingAt?: string;
  periodLabel?: string;
  note?: string;
  source?: 'MANUEL' | 'TOPLU' | 'IKMAL';
  /** RES-903: şüpheli girişin onaylı geçişi (gerekçe). */
  overrideReason?: string;
  correctsReadingId?: string;
}

async function insertMeterReading(
  client: any,
  tenantId: string,
  vehicle: { id: string; plate: string; vehicle_type: string; meter_type: string | null },
  input: RecordMeterReadingInput,
  enteredByUserId: string
): Promise<{ reading: MeterReadingRecord; warnings: string[] }> {
  const meterType: MeterType = resolveMeterType(vehicle.vehicle_type, input.meterType ?? vehicle.meter_type);
  const readingAt = input.readingAt ? new Date(input.readingAt) : new Date();
  if (Number.isNaN(readingAt.getTime())) {
    throw new BadRequestError('readingAt geçerli bir tarih değil.', { error: 'INVALID_DATE' });
  }
  if (readingAt.getTime() > Date.now() + 60_000) {
    throw new BadRequestError('readingAt gelecekte olamaz.', { error: 'FUTURE_DATE' });
  }
  const periodLabel = input.periodLabel ?? istanbulMonthLabel(readingAt);

  const prevRes = await client.query(
    `SELECT reading_value, reading_at FROM vehicle_meter_readings
      WHERE vehicle_id = $1 AND meter_type = $2 AND reading_at <= $3
      ORDER BY reading_at DESC LIMIT 1`,
    [vehicle.id, meterType, readingAt.toISOString()]
  );
  const previous = prevRes.rows.length > 0
    ? { value: Number(prevRes.rows[0].reading_value), at: new Date(prevRes.rows[0].reading_at) }
    : null;

  let duplicatePeriod = false;
  if (!input.correctsReadingId) {
    const dupRes = await client.query(
      `SELECT 1 FROM vehicle_meter_readings
        WHERE vehicle_id = $1 AND meter_type = $2 AND period_label = $3 AND corrects_reading_id IS NULL LIMIT 1`,
      [vehicle.id, meterType, periodLabel]
    );
    duplicatePeriod = dupRes.rows.length > 0;
  }

  const check = checkMeterReading({ meterType, newValue: input.value, newAt: readingAt, previous, duplicatePeriod });

  // RES-903 AC: "Geri giden değer UYARI üretmeli, GEREKÇELİ ONAYLA
  // kaydedilebilmelidir." → gerekçe yoksa reddet (kalıcı engel değil).
  if (check.suspicious && !(input.overrideReason && input.overrideReason.trim().length >= 3)) {
    throw new ConflictError(
      `Şüpheli sayaç girişi (${check.reasons.join(', ')}). Kaydetmek için gerekçeli onay (overrideReason) gereklidir.`,
      { error: 'METER_READING_SUSPICIOUS', reasons: check.reasons, detail: check.detail, requiresOverride: true }
    );
  }

  const id = generateId('meter');
  const insRes = await client.query(
    `INSERT INTO vehicle_meter_readings
       (id, tenant_id, vehicle_id, vehicle_plate, meter_type, reading_value, reading_at, period_label, source,
        is_suspicious, suspicion_reasons, override_approved, override_reason, approved_by, corrects_reading_id, note, entered_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [
      id, tenantId, vehicle.id, vehicle.plate, meterType, input.value, readingAt.toISOString(), periodLabel,
      input.source ?? 'MANUEL', check.suspicious, check.reasons, check.suspicious, input.overrideReason ?? null,
      check.suspicious ? enteredByUserId : null, input.correctsReadingId ?? null, input.note ?? null, enteredByUserId
    ]
  );

  await writeAuditLog(client, {
    action: check.suspicious ? 'METER_READING_OVERRIDE' : 'METER_READING_RECORDED',
    targetType: 'vehicle_meter_reading',
    targetId: id,
    afterValue: {
      vehicleId: vehicle.id, plate: vehicle.plate, meterType, value: input.value, periodLabel,
      suspicious: check.suspicious, reasons: check.reasons, overrideReason: input.overrideReason ?? null,
      correctsReadingId: input.correctsReadingId ?? null
    }
  });

  const warnings: string[] = [];
  if (check.suspicious) warnings.push(`Şüpheli giriş onaylı geçişle kaydedildi: ${check.reasons.join(', ')}.`);
  return { reading: insRes.rows[0], warnings };
}

export async function recordMeterReading(
  vehicleId: string,
  input: RecordMeterReadingInput,
  enteredByUserId: string
): Promise<{ reading: MeterReadingRecord; warnings: string[] }> {
  return withTenant(async (client, tenantId) => {
    const vRes = await client.query('SELECT id, plate, vehicle_type, meter_type FROM vehicles WHERE id = $1', [vehicleId]);
    if (vRes.rows.length === 0) throw new NotFoundError('Araç bulunamadı.', { error: 'VEHICLE_NOT_FOUND' });
    return insertMeterReading(client, tenantId, vRes.rows[0], input, enteredByUserId);
  });
}

export interface BulkMeterItem {
  vehiclePlate: string;
  value: number;
  meterType?: MeterType;
  readingAt?: string;
  periodLabel?: string;
  note?: string;
  overrideReason?: string;
}
export interface BulkMeterResultRow {
  vehiclePlate: string;
  ok: boolean;
  readingId?: string;
  suspicious?: boolean;
  reasons?: string[];
  error?: string;
  message?: string;
}

/** FLEET-1404 AC: "Toplu giriş ile 50 araç tek işlemde güncellenebilmelidir." */
export async function recordMeterReadingsBulk(
  items: BulkMeterItem[],
  enteredByUserId: string
): Promise<{ total: number; accepted: number; failed: number; rows: BulkMeterResultRow[] }> {
  return withTenant(async (client, tenantId) => {
    const rows: BulkMeterResultRow[] = [];
    for (const item of items) {
      try {
        const vRes = await client.query('SELECT id, plate, vehicle_type, meter_type FROM vehicles WHERE plate = $1', [item.vehiclePlate]);
        if (vRes.rows.length === 0) {
          rows.push({ vehiclePlate: item.vehiclePlate, ok: false, error: 'VEHICLE_NOT_FOUND', message: 'Araç bulunamadı.' });
          continue;
        }
        const res = await insertMeterReading(client, tenantId, vRes.rows[0], { ...item, source: 'TOPLU' }, enteredByUserId);
        rows.push({
          vehiclePlate: item.vehiclePlate, ok: true, readingId: res.reading.id,
          suspicious: res.reading.is_suspicious, reasons: res.reading.suspicion_reasons,
          message: res.warnings[0]
        });
      } catch (err: any) {
        rows.push({
          vehiclePlate: item.vehiclePlate, ok: false,
          error: err?.details?.error ?? 'ERROR',
          reasons: err?.details?.reasons,
          message: err?.message
        });
      }
    }
    const accepted = rows.filter((r) => r.ok).length;
    return { total: rows.length, accepted, failed: rows.length - accepted, rows };
  });
}

export async function getVehicleMeterReadings(vehicleId: string): Promise<MeterReadingRecord[]> {
  return withTenant(async (client) => {
    const res = await client.query(
      'SELECT * FROM vehicle_meter_readings WHERE vehicle_id = $1 ORDER BY reading_at DESC, created_at DESC',
      [vehicleId]
    );
    return res.rows;
  });
}

/** FLEET-1404 AC: "Eksik giriş yapılan araçların listelenmesi." */
export async function getMissingMeterReadings(
  periodLabel: string,
  meterType?: MeterType
): Promise<{ periodLabel: string; missingCount: number; bySite: Array<{ siteName: string; plates: string[] }> }> {
  return withTenant(async (client) => {
    const params: any[] = [periodLabel];
    let mtClause = '';
    if (meterType) { params.push(meterType); mtClause = `AND r.meter_type = $${params.length}`; }
    const res = await client.query(
      `SELECT v.plate, COALESCE(v.site_name, 'Tanımsız') AS site_name
         FROM vehicles v
        WHERE v.status <> 'PASİF'
          AND NOT EXISTS (
            SELECT 1 FROM vehicle_meter_readings r
             WHERE r.vehicle_id = v.id AND r.period_label = $1 ${mtClause}
          )
        ORDER BY site_name, v.plate`,
      params
    );
    const bySiteMap = new Map<string, string[]>();
    for (const row of res.rows) {
      if (!bySiteMap.has(row.site_name)) bySiteMap.set(row.site_name, []);
      bySiteMap.get(row.site_name)!.push(row.plate);
    }
    return {
      periodLabel,
      missingCount: res.rows.length,
      bySite: [...bySiteMap.entries()].map(([siteName, plates]) => ({ siteName, plates }))
    };
  });
}

/**
 * FLEET-1404 AC: "Eksik giriş yapan şantiyelere hatırlatma gitmelidir."
 * Bildirim modülü yok → şantiye bazında audit (METER_READING_REMINDER) +
 * çağıran route WebSocket'te yayınlar.
 */
export async function remindMissingMeterReadings(
  periodLabel: string,
  meterType: MeterType | undefined,
  byUserId: string
): Promise<{ periodLabel: string; remindedSites: number; bySite: Array<{ siteName: string; missingCount: number; plates: string[] }> }> {
  return withTenant(async (client) => {
    const params: any[] = [periodLabel];
    let mtClause = '';
    if (meterType) { params.push(meterType); mtClause = `AND r.meter_type = $${params.length}`; }
    const res = await client.query(
      `SELECT v.plate, COALESCE(v.site_name, 'Tanımsız') AS site_name
         FROM vehicles v
        WHERE v.status <> 'PASİF'
          AND NOT EXISTS (SELECT 1 FROM vehicle_meter_readings r WHERE r.vehicle_id = v.id AND r.period_label = $1 ${mtClause})
        ORDER BY site_name, v.plate`,
      params
    );
    const bySiteMap = new Map<string, string[]>();
    for (const row of res.rows) {
      if (!bySiteMap.has(row.site_name)) bySiteMap.set(row.site_name, []);
      bySiteMap.get(row.site_name)!.push(row.plate);
    }
    const bySite = [...bySiteMap.entries()].map(([siteName, plates]) => ({ siteName, missingCount: plates.length, plates }));
    if (bySite.length > 0) {
      await writeAuditLog(client, {
        action: 'METER_READING_REMINDER',
        targetType: 'vehicle_meter_reading',
        targetId: periodLabel,
        afterValue: { periodLabel, meterType: meterType ?? 'ALL', sites: bySite.map((s) => ({ site: s.siteName, missing: s.missingCount })), by: byUserId }
      });
    }
    return { periodLabel, remindedSites: bySite.length, bySite };
  });
}

// ============================================================================
// FLEET-1405: L/100km VE L/MOTOR-SAAT TÜKETİM HESAP MOTORU
// ============================================================================

export interface VehicleConsumptionResult {
  vehicleId: string;
  vehiclePlate: string;
  vehicleType: string;
  siteName: string | null;
  meterType: MeterType;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  openingValue: number | null;
  closingValue: number | null;
  /** Dönemdeki sayaç artışı (km veya motor-saat). */
  usageAmount: number | null;
  fuelLiters: number;
  /** meterType='KM' ise dolu, 'MOTOR_SAAT' ise null. */
  consumptionPer100Unit: number | null;
  /** meterType='MOTOR_SAAT' ise dolu (L/saat), 'KM' ise null. */
  consumptionPerHour: number | null;
  // 'HESAPLANDI' | 'EKSIK_VERI' | 'GECERSIZ_VERI'
  status: 'HESAPLANDI' | 'EKSIK_VERI' | 'GECERSIZ_VERI';
  excludedReason?: string;
  /** Açılış/kapanış okumalarından biri RES-903 onaylı-şüpheli ise true — sonuç yine hesaplanır ama işaretlenir. */
  basedOnSuspiciousReading: boolean;
}

/**
 * FLEET-1405 çekirdeği — bir aracın bir dönemdeki L/100km (KM) veya L/saat
 * (MOTOR_SAAT) tüketimini hesaplar.
 *
 * Kritik Not: "Dönem başı/sonu km eksikse hesap YAPILMAMALI; '0' veya tahmini
 * değer üretmek raporu yanıltır." → eksik/geçersiz veri EKSIK_VERI/GECERSIZ_VERI
 * olarak işaretlenip hesaptan (ortalamalardan) DIŞLANIR, silinmez/tahmin
 * edilmez.
 *   - "Dönem başı" = bu dönemden ÖNCEKİ en son okuma (bir önceki dönemin
 *     kapanışı — sayaç değerleri kümülatiftir, her dönem sıfırlanmaz).
 *   - "Dönem sonu" = bu dönem PENCERESİ içindeki en son GİRİLEN (created_at'e
 *     göre — bir düzeltme aynı reading_at'i taşısa bile sonradan girilen kazanır)
 *     okuma.
 */
async function computeVehicleConsumption(
  client: any,
  vehicle: { id: string; plate: string; vehicle_type: string; meter_type: string | null; site_name: string | null },
  periodLabel: string
): Promise<VehicleConsumptionResult> {
  const meterType = resolveMeterType(vehicle.vehicle_type, vehicle.meter_type);
  const { periodStart, periodEnd } = periodWindowFor('MONTHLY', new Date(`${periodLabel}-15T00:00:00.000Z`));
  const base: Omit<VehicleConsumptionResult, 'status' | 'excludedReason' | 'openingValue' | 'closingValue' | 'usageAmount' | 'consumptionPer100Unit' | 'consumptionPerHour' | 'basedOnSuspiciousReading' | 'fuelLiters'> = {
    vehicleId: vehicle.id, vehiclePlate: vehicle.plate, vehicleType: vehicle.vehicle_type, siteName: vehicle.site_name,
    meterType, periodLabel, periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString()
  };

  const openingRes = await client.query(
    `SELECT reading_value, is_suspicious FROM vehicle_meter_readings
      WHERE vehicle_id = $1 AND meter_type = $2 AND reading_at < $3
      ORDER BY reading_at DESC, created_at DESC LIMIT 1`,
    [vehicle.id, meterType, periodStart.toISOString()]
  );
  const closingRes = await client.query(
    `SELECT reading_value, is_suspicious FROM vehicle_meter_readings
      WHERE vehicle_id = $1 AND meter_type = $2 AND reading_at >= $3 AND reading_at < $4
      ORDER BY created_at DESC LIMIT 1`,
    [vehicle.id, meterType, periodStart.toISOString(), periodEnd.toISOString()]
  );

  if (openingRes.rows.length === 0 || closingRes.rows.length === 0) {
    return {
      ...base, openingValue: openingRes.rows[0] ? Number(openingRes.rows[0].reading_value) : null,
      closingValue: closingRes.rows[0] ? Number(closingRes.rows[0].reading_value) : null,
      usageAmount: null, fuelLiters: 0, consumptionPer100Unit: null, consumptionPerHour: null,
      status: 'EKSIK_VERI', excludedReason: 'Dönem başı veya sonu sayaç okuması eksik.', basedOnSuspiciousReading: false
    };
  }

  const opening = Number(openingRes.rows[0].reading_value);
  const closing = Number(closingRes.rows[0].reading_value);
  const usageAmount = round2(closing - opening);
  const basedOnSuspiciousReading = !!openingRes.rows[0].is_suspicious || !!closingRes.rows[0].is_suspicious;

  if (usageAmount <= 0) {
    return {
      ...base, openingValue: opening, closingValue: closing, usageAmount, fuelLiters: 0,
      consumptionPer100Unit: null, consumptionPerHour: null, status: 'GECERSIZ_VERI',
      excludedReason: 'Dönem sonu değeri dönem başından büyük değil (sıfır/negatif kullanım).',
      basedOnSuspiciousReading
    };
  }

  const fuelRes = await client.query(
    `SELECT COALESCE(SUM(amount_liters), 0)::numeric AS l FROM transactions
      WHERE vehicle_plate = $1 AND created_at >= $2 AND created_at < $3`,
    [vehicle.plate, periodStart.toISOString(), periodEnd.toISOString()]
  );
  const fuelLiters = round2(Number(fuelRes.rows[0].l));

  return {
    ...base,
    openingValue: opening,
    closingValue: closing,
    usageAmount,
    fuelLiters,
    consumptionPer100Unit: meterType === 'KM' ? round2((fuelLiters / usageAmount) * 100) : null,
    consumptionPerHour: meterType === 'MOTOR_SAAT' ? round2(fuelLiters / usageAmount) : null,
    status: 'HESAPLANDI',
    basedOnSuspiciousReading
  };
}

export async function getFleetConsumptionReport(
  periodLabel: string,
  vehicleId?: string
): Promise<{ periodLabel: string; computed: number; excluded: number; vehicles: VehicleConsumptionResult[] }> {
  return withTenant(async (client) => {
    const vRes = vehicleId
      ? await client.query('SELECT id, plate, vehicle_type, meter_type, site_name FROM vehicles WHERE id = $1', [vehicleId])
      : await client.query("SELECT id, plate, vehicle_type, meter_type, site_name FROM vehicles WHERE status <> 'PASİF' ORDER BY plate");
    if (vehicleId && vRes.rows.length === 0) throw new NotFoundError('Araç bulunamadı.', { error: 'VEHICLE_NOT_FOUND' });

    const vehicles: VehicleConsumptionResult[] = [];
    for (const v of vRes.rows) vehicles.push(await computeVehicleConsumption(client, v, periodLabel));
    const computed = vehicles.filter((v) => v.status === 'HESAPLANDI').length;
    return { periodLabel, computed, excluded: vehicles.length - computed, vehicles };
  });
}

export interface ConsumptionGroupStat {
  group: string;
  meterType: MeterType;
  vehicleCount: number;
  average: number;
  stddev: number;
  min: number;
  max: number;
}

function stddev(values: number[], avg: number): number {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length;
  return Math.round(Math.sqrt(variance) * 100) / 100;
}

/**
 * FLEET-1405 AC: "Araç tipi ve şantiye bazında ortalama ve sapma hesapları."
 * `groupBy`: 'vehicle_type' | 'site_name'. Yalnızca HESAPLANDI (geçerli veri)
 * kayıtlar istatistiğe girer — Kritik Not gereği eksik/geçersiz dönemler
 * ortalamayı BOZMAZ.
 */
export async function getFleetConsumptionComparison(
  periodLabel: string,
  groupBy: 'vehicle_type' | 'site_name'
): Promise<{ periodLabel: string; groupBy: string; groups: ConsumptionGroupStat[] }> {
  const report = await getFleetConsumptionReport(periodLabel);
  const buckets = new Map<string, { meterType: MeterType; values: number[] }>();
  for (const v of report.vehicles) {
    if (v.status !== 'HESAPLANDI') continue;
    const value = v.meterType === 'KM' ? v.consumptionPer100Unit : v.consumptionPerHour;
    if (value === null || value === undefined) continue;
    const key = `${groupBy === 'vehicle_type' ? v.vehicleType : (v.siteName ?? 'Tanımsız')}::${v.meterType}`;
    if (!buckets.has(key)) buckets.set(key, { meterType: v.meterType, values: [] });
    buckets.get(key)!.values.push(value);
  }
  const groups: ConsumptionGroupStat[] = [];
  for (const [key, b] of buckets) {
    const groupName = key.split('::')[0];
    const avg = round2(b.values.reduce((s, x) => s + x, 0) / b.values.length);
    groups.push({
      group: groupName, meterType: b.meterType, vehicleCount: b.values.length,
      average: avg, stddev: stddev(b.values, avg), min: Math.min(...b.values), max: Math.max(...b.values)
    });
  }
  groups.sort((a, b) => a.group.localeCompare(b.group));
  return { periodLabel, groupBy, groups };
}

export interface ConsumptionTrendPoint {
  periodLabel: string;
  status: string;
  value: number | null;
  changePct: number | null;
}

/** FLEET-1405 AC: "Dönem karşılaştırması ve trend." Son `periodsCount` ayın peş peşe raporu. */
export async function getFleetConsumptionTrend(
  vehicleId: string,
  periodsCount: number
): Promise<{ vehicleId: string; meterType: MeterType; points: ConsumptionTrendPoint[] }> {
  return withTenant(async (client) => {
    const vRes = await client.query('SELECT id, plate, vehicle_type, meter_type, site_name FROM vehicles WHERE id = $1', [vehicleId]);
    if (vRes.rows.length === 0) throw new NotFoundError('Araç bulunamadı.', { error: 'VEHICLE_NOT_FOUND' });
    const vehicle = vRes.rows[0];
    const meterType = resolveMeterType(vehicle.vehicle_type, vehicle.meter_type);

    const now = new Date();
    const labels: string[] = [];
    for (let i = periodsCount - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 15));
      labels.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    }

    const points: ConsumptionTrendPoint[] = [];
    let prevValue: number | null = null;
    for (const label of labels) {
      const r = await computeVehicleConsumption(client, vehicle, label);
      const value = r.status === 'HESAPLANDI' ? (meterType === 'KM' ? r.consumptionPer100Unit : r.consumptionPerHour) : null;
      const changePct = value !== null && prevValue !== null && prevValue !== 0
        ? round2(((value - prevValue) / prevValue) * 100)
        : null;
      points.push({ periodLabel: label, status: r.status, value, changePct });
      if (value !== null) prevValue = value;
    }
    return { vehicleId, meterType, points };
  });
}

// ============================================================================
// AI-503: KM/MOTOR-SAAT BAZLI TÜKETİM ANOMALİSİ (L/100km SAPMASI)
// ============================================================================

const CONSUMPTION_ANOMALY_LOOKBACK_PERIODS = 6;
const CONSUMPTION_ANOMALY_MIN_HISTORY = 3; // AC: yetersiz veri (<3 dönem) → anomali üretilmez.
const CONSUMPTION_ANOMALY_ZSCORE_THRESHOLD = 2;
const CONSUMPTION_ANOMALY_PCT_THRESHOLD = 0.25;

function previousPeriodLabel(periodLabel: string, monthsBack: number): string {
  const [y, m] = periodLabel.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - monthsBack, 15));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function metricFor(r: VehicleConsumptionResult): number | null {
  return r.meterType === 'KM' ? r.consumptionPer100Unit : r.consumptionPerHour;
}

export interface VehicleConsumptionAnomalyResult {
  vehicleId: string;
  vehiclePlate: string;
  vehicleType: string;
  siteName: string | null;
  meterType: MeterType;
  periodLabel: string;
  currentStatus: string;
  currentValue: number | null;
  historyCount: number;
  insufficientHistory: boolean;
  historyMean: number | null;
  historyStddev: number | null;
  zScore: number | null;
  deviationPct: number | null;
  direction: 'YUKSEK' | 'DUSUK' | null;
  anomalous: boolean;
  peerAverage: number | null;
  peerVehicleCount: number;
  peerDeviationPct: number | null;
}

/**
 * AI-503 çekirdeği — bir aracın bu dönemki L/100km (veya L/saat) değerini
 * KENDİ geçmiş ortalamasına (z-score + %sapma) ve AYNI ARAÇ TİPİNDEKİ
 * benzerlerine (peer, bilgi amaçlı) göre değerlendirir.
 *
 * Kritik Notlar:
 *  - "Yetersiz veri (<3 dönem) olan araçlar için anomali üretilmemelidir" →
 *    insufficientHistory=true ise anomalous HER ZAMAN false.
 *  - "Km girişi hatalıysa anomali yanlış çıkar; RES-903 doğrulaması ön
 *    koşuldur" → hem cari hem geçmiş dönemler yalnızca computeVehicleConsumption
 *    HESAPLANDI (RES-903 onaylı/temiz sayaç + tutarlı kullanım) sonuçlarından
 *    alınır; EKSIK_VERI/GECERSIZ_VERI dönemler baseline'a KATILMAZ.
 *  - "Karşılaştırma aynı araç tipi içinde yapılmalıdır" → peer havuzu aynı
 *    vehicle_type ile sınırlıdır.
 */
async function computeVehicleConsumptionAnomaly(
  client: any,
  vehicle: { id: string; plate: string; vehicle_type: string; meter_type: string | null; site_name: string | null },
  periodLabel: string
): Promise<VehicleConsumptionAnomalyResult> {
  const current = await computeVehicleConsumption(client, vehicle, periodLabel);
  const currentValue = metricFor(current);

  const base: VehicleConsumptionAnomalyResult = {
    vehicleId: vehicle.id, vehiclePlate: vehicle.plate, vehicleType: vehicle.vehicle_type, siteName: vehicle.site_name,
    meterType: current.meterType, periodLabel, currentStatus: current.status, currentValue,
    historyCount: 0, insufficientHistory: true, historyMean: null, historyStddev: null,
    zScore: null, deviationPct: null, direction: null, anomalous: false,
    peerAverage: null, peerVehicleCount: 0, peerDeviationPct: null
  };

  if (current.status !== 'HESAPLANDI' || currentValue === null) return base;

  const history: number[] = [];
  for (let i = 1; i <= CONSUMPTION_ANOMALY_LOOKBACK_PERIODS; i++) {
    const label = previousPeriodLabel(periodLabel, i);
    const past = await computeVehicleConsumption(client, vehicle, label);
    const v = metricFor(past);
    if (past.status === 'HESAPLANDI' && v !== null) history.push(v);
  }
  base.historyCount = history.length;
  base.insufficientHistory = history.length < CONSUMPTION_ANOMALY_MIN_HISTORY;

  // Peer ortalaması — bilgi amaçlı, anomalous kararını ETKİLEMEZ (AC'nin
  // odağı "kendi geçmişi"; peer yalnızca aynı tip içinde karşılaştırma sunar).
  const peerRes = await client.query(
    `SELECT id, plate, vehicle_type, meter_type, site_name FROM vehicles
      WHERE vehicle_type = $1 AND id <> $2 AND status <> 'PASİF'`,
    [vehicle.vehicle_type, vehicle.id]
  );
  const peerValues: number[] = [];
  for (const p of peerRes.rows) {
    const pr = await computeVehicleConsumption(client, p, periodLabel);
    const v = metricFor(pr);
    if (pr.status === 'HESAPLANDI' && v !== null) peerValues.push(v);
  }
  if (peerValues.length > 0) {
    base.peerAverage = round2(peerValues.reduce((s, x) => s + x, 0) / peerValues.length);
    base.peerVehicleCount = peerValues.length;
    base.peerDeviationPct = base.peerAverage !== 0 ? round2(((currentValue - base.peerAverage) / base.peerAverage) * 100) : null;
  }

  if (base.insufficientHistory) return base;

  const mean = round2(history.reduce((s, x) => s + x, 0) / history.length);
  const sd = stddev(history, mean);
  const z = sd > 0 ? round2((currentValue - mean) / sd) : 0;
  const deviationPct = mean !== 0 ? round2(((currentValue - mean) / mean) * 100) : 0;

  base.historyMean = mean;
  base.historyStddev = sd;
  base.zScore = z;
  base.deviationPct = deviationPct;
  base.direction = currentValue >= mean ? 'YUKSEK' : 'DUSUK';
  // Eşik: 2 standart sapma VEYA %25 sapma (Kritik Not — "öneri").
  base.anomalous = Math.abs(z) >= CONSUMPTION_ANOMALY_ZSCORE_THRESHOLD || Math.abs(deviationPct) / 100 >= CONSUMPTION_ANOMALY_PCT_THRESHOLD;
  return base;
}

export async function getVehicleConsumptionAnomaly(
  vehicleId: string,
  periodLabel: string
): Promise<VehicleConsumptionAnomalyResult> {
  return withTenant(async (client) => {
    const vRes = await client.query('SELECT id, plate, vehicle_type, meter_type, site_name FROM vehicles WHERE id = $1', [vehicleId]);
    if (vRes.rows.length === 0) throw new NotFoundError('Araç bulunamadı.', { error: 'VEHICLE_NOT_FOUND' });
    return computeVehicleConsumptionAnomaly(client, vRes.rows[0], periodLabel);
  });
}

/**
 * AI-503 — tüm aktif filo için tarar; tespit edilen anomaliler AI-507
 * birleşik alarm yaşam döngüsüne (raiseAlarm) akar (alarmKey =
 * CONSUMPTION_ANOMALY:<vehicleId> → aynı araç tekrar anomali verirse
 * gruplanır, ayrı satır açmaz).
 */
export async function scanConsumptionAnomalies(
  periodLabel: string
): Promise<{ periodLabel: string; scanned: number; anomalies: number; insufficientData: number; results: VehicleConsumptionAnomalyResult[] }> {
  return withTenant(async (client, tenantId) => {
    const vRes = await client.query("SELECT id, plate, vehicle_type, meter_type, site_name FROM vehicles WHERE status <> 'PASİF' ORDER BY plate");
    const results: VehicleConsumptionAnomalyResult[] = [];
    let anomalies = 0;
    let insufficientData = 0;
    for (const v of vRes.rows) {
      const r = await computeVehicleConsumptionAnomaly(client, v, periodLabel);
      results.push(r);
      if (r.insufficientHistory) insufficientData++;
      if (r.anomalous) {
        anomalies++;
        const severity: AlarmSeverity = Math.abs(r.zScore ?? 0) >= 3 ? 'CRITICAL' : 'WARNING';
        const unit = r.meterType === 'KM' ? 'L/100km' : 'L/saat';
        await raiseAlarm(client, tenantId, {
          alarmKey: `CONSUMPTION_ANOMALY:${v.id}`,
          category: 'CONSUMPTION_ANOMALY',
          severity,
          title: `Anormal tüketim: ${v.plate} — ${r.currentValue} ${unit} (ortalama ${r.historyMean}, %${r.deviationPct} sapma)`,
          siteName: v.site_name,
          subjectType: 'VEHICLE',
          subjectId: v.plate,
          detail: {
            periodLabel, meterType: r.meterType, currentValue: r.currentValue, historyMean: r.historyMean,
            historyStddev: r.historyStddev, zScore: r.zScore, deviationPct: r.deviationPct, direction: r.direction,
            historyCount: r.historyCount, peerAverage: r.peerAverage, peerDeviationPct: r.peerDeviationPct
          },
          sourceRef: { table: 'vehicle_meter_readings', vehicleId: v.id, periodLabel }
        });
      }
    }
    if (anomalies > 0) {
      await writeAuditLog(client, {
        action: 'CONSUMPTION_ANOMALY_SCAN',
        targetType: 'vehicle_consumption_anomaly',
        targetId: tenantId,
        afterValue: { periodLabel, scanned: vRes.rows.length, anomalies, insufficientData }
      });
    }
    return { periodLabel, scanned: vRes.rows.length, anomalies, insufficientData, results };
  });
}

// ============================================================================
// FLEET-1406: ARAÇ BAZLI DÖNEMSEL YAKIT LİMİTİ
// ============================================================================

const VEHICLE_LIMIT_BALANCE_CACHE_TTL_SECONDS = 5;

export interface VehicleFuelLimitRecord {
  id: string;
  tenant_id: string;
  vehicle_id: string;
  vehicle_plate: string;
  period_type: QuotaPeriodType;
  limit_liters: string;
  enforcement: 'REJECT' | 'WARN';
  status: string;
  temp_increase_liters: string | null;
  temp_increase_until: string | null;
  temp_increase_reason: string | null;
  temp_increase_approved_by: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export async function setVehicleFuelLimit(
  vehicleId: string,
  data: { periodType: QuotaPeriodType; limitLiters: number; enforcement: 'REJECT' | 'WARN'; status?: string },
  byUserId: string
): Promise<VehicleFuelLimitRecord> {
  return withTenant(async (client, tenantId) => {
    const vRes = await client.query('SELECT id, plate FROM vehicles WHERE id = $1', [vehicleId]);
    if (vRes.rows.length === 0) throw new NotFoundError('Araç bulunamadı.', { error: 'VEHICLE_NOT_FOUND' });
    const vehicle = vRes.rows[0];

    const res = await client.query(
      `INSERT INTO vehicle_fuel_limits (id, tenant_id, vehicle_id, vehicle_plate, period_type, limit_liters, enforcement, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (tenant_id, vehicle_id) DO UPDATE SET
         period_type = EXCLUDED.period_type,
         limit_liters = EXCLUDED.limit_liters,
         enforcement = EXCLUDED.enforcement,
         status = EXCLUDED.status,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [generateId('vfl'), tenantId, vehicle.id, vehicle.plate, data.periodType, data.limitLiters, data.enforcement, data.status ?? 'AKTİF', byUserId]
    );
    await writeAuditLog(client, {
      action: 'VEHICLE_FUEL_LIMIT_SET',
      targetType: 'vehicle_fuel_limit',
      targetId: res.rows[0].id,
      afterValue: { vehicleId: vehicle.id, plate: vehicle.plate, ...data, by: byUserId }
    });
    await redisPool.cacheDel(`vehicle-limit:balance:${tenantId}:${vehicleId}`);
    return res.rows[0];
  });
}

export interface VehicleFuelLimitBalance {
  hasLimit: boolean;
  limit?: VehicleFuelLimitRecord;
  periodStart?: string;
  periodEnd?: string;
  consumedLiters?: number;
  effectiveLimitLiters?: number;
  remainingLiters?: number;
  usagePct?: number;
  temporaryIncreaseActive?: boolean;
  computedAt: string;
}

/** FLEET-1406 AC: "Limit kullanım oranının panelde gösterilmesi." 5 sn cache-aside (FUEL-402.1 kota bakiyesiyle AYNI desen). */
export async function getVehicleFuelLimitBalance(vehicleId: string): Promise<VehicleFuelLimitBalance> {
  return withTenant(async (client, tenantId) => {
    const cacheKey = `vehicle-limit:balance:${tenantId}:${vehicleId}`;
    const cached = await redisPool.cacheGetJson<VehicleFuelLimitBalance>(cacheKey);
    if (cached) return cached;

    const lRes = await client.query(`SELECT * FROM vehicle_fuel_limits WHERE vehicle_id = $1`, [vehicleId]);
    if (lRes.rows.length === 0) {
      const result: VehicleFuelLimitBalance = { hasLimit: false, computedAt: new Date().toISOString() };
      await redisPool.cacheSetJson(cacheKey, result, VEHICLE_LIMIT_BALANCE_CACHE_TTL_SECONDS);
      return result;
    }
    const limit = lRes.rows[0] as VehicleFuelLimitRecord;
    const { periodStart, periodEnd } = periodWindowFor(limit.period_type, new Date());
    const consRes = await client.query(
      `SELECT COALESCE(SUM(amount_liters), 0)::numeric AS c FROM transactions
        WHERE vehicle_plate = $1 AND created_at >= $2 AND created_at < $3`,
      [limit.vehicle_plate, periodStart.toISOString(), periodEnd.toISOString()]
    );
    const consumedLiters = round2(Number(consRes.rows[0].c));
    const tempActive = !!(limit.temp_increase_liters && limit.temp_increase_until && new Date(limit.temp_increase_until) >= new Date());
    const effectiveLimitLiters = round2(Number(limit.limit_liters) + (tempActive ? Number(limit.temp_increase_liters) : 0));
    const remainingLiters = round2(effectiveLimitLiters - consumedLiters);
    const usagePct = effectiveLimitLiters > 0 ? round2((consumedLiters / effectiveLimitLiters) * 100) : 0;

    const result: VehicleFuelLimitBalance = {
      hasLimit: true, limit, periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString(),
      consumedLiters, effectiveLimitLiters, remainingLiters, usagePct, temporaryIncreaseActive: tempActive,
      computedAt: new Date().toISOString()
    };
    await redisPool.cacheSetJson(cacheKey, result, VEHICLE_LIMIT_BALANCE_CACHE_TTL_SECONDS);
    return result;
  });
}

/**
 * FLEET-1406 AC: "Geçici limit artışı onay ve audit gerektirmelidir." Kalıcı
 * limit_liters'ı DEĞİŞTİRMEZ — yalnızca temp_increase_* alanlarını (süreli) ayarlar.
 */
export async function approveTemporaryFuelLimitIncrease(
  vehicleId: string,
  data: { additionalLiters: number; untilDate: string; reason: string },
  approvedByUserId: string
): Promise<VehicleFuelLimitRecord> {
  return withTenant(async (client, tenantId) => {
    const res = await client.query(
      `UPDATE vehicle_fuel_limits
          SET temp_increase_liters = $2, temp_increase_until = $3, temp_increase_reason = $4,
              temp_increase_approved_by = $5, updated_at = CURRENT_TIMESTAMP
        WHERE vehicle_id = $1 RETURNING *`,
      [vehicleId, data.additionalLiters, data.untilDate, data.reason, approvedByUserId]
    );
    if (res.rows.length === 0) throw new NotFoundError('Bu araç için tanımlı bir yakıt limiti yok.', { error: 'LIMIT_NOT_FOUND' });
    await writeAuditLog(client, {
      action: 'VEHICLE_FUEL_LIMIT_TEMP_INCREASE',
      targetType: 'vehicle_fuel_limit',
      targetId: res.rows[0].id,
      afterValue: { vehicleId, additionalLiters: data.additionalLiters, untilDate: data.untilDate, reason: data.reason, approvedBy: approvedByUserId }
    });
    await redisPool.cacheDel(`vehicle-limit:balance:${tenantId}:${vehicleId}`);
    return res.rows[0];
  });
}
