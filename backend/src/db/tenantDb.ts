import { ForbiddenError, ConflictError } from '../utils/errors';
import { withTenant } from './withTenant';

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

export interface HardwareLogRecord {
  id: string;
  tenant_id: string;
  device_code: string;
  tag: string;
  message: string;
  site_name: string;
  created_at: Date;
}

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

export async function createTenantSite(siteName: string, location: string = 'Türkiye'): Promise<SiteRecord> {
  return withTenant(async (client, tenantId) => {
    const id = `site-${Date.now()}`;
    const result = await client.query(
      `INSERT INTO sites (id, tenant_id, name, location)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, name) DO UPDATE SET location = EXCLUDED.location
       RETURNING *`,
      [id, tenantId, siteName, location]
    );

    return result.rows[0];
  });
}

export async function deleteTenantSite(siteName: string): Promise<boolean> {
  return withTenant(async (client) => {
    // Delete from sites table
    await client.query('DELETE FROM sites WHERE name = $1', [siteName]);

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
export async function getTenantVehicles(): Promise<VehicleRecord[]> {
  return withTenant(async (client) => {
    const result = await client.query('SELECT * FROM vehicles ORDER BY created_at DESC');
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
    const id = 'veh-' + Date.now(); // In production, use UUID or better ID generation
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
    const fields = [];
    const values = [];
    let queryIdx = 1;

    for (const [key, value] of Object.entries(data)) {
      if (['plate', 'brand_model', 'vehicle_type', 'rfid_tag', 'site_name', 'status', 'fuel_capacity_liters'].includes(key) && value !== undefined) {
        fields.push(`${key} = $${queryIdx}`);
        values.push(value);
        queryIdx++;
      }
      if (key === 'assigned_driver_name' && value !== undefined) {
        fields.push(`assigned_driver_name = $${queryIdx}`);
        values.push(typeof value === 'string' && !UNASSIGNED_SENTINELS.has(value) ? value : null);
        queryIdx++;
      }
    }

    if (fields.length === 0) {
      throw new Error('Güncellenecek alan bulunamadı.');
    }

    values.push(id);
    const result = await client.query(
      `UPDATE vehicles SET ${fields.join(', ')} WHERE id = $${queryIdx} RETURNING *`,
      values
    );
    if (result.rows.length === 0) throw new Error('Araç bulunamadı veya yetkiniz yok.');
    return result.rows[0];
  });
}

export async function deleteVehicle(id: string): Promise<void> {
  return withTenant(async (client) => {
    await client.query('DELETE FROM vehicles WHERE id = $1', [id]);
  });
}

// ============================================================================
// DRIVERS CRUD
// ============================================================================

export async function getTenantDrivers(): Promise<DriverRecord[]> {
  return withTenant(async (client) => {
    // assigned_vehicle_plate gerçek bir kolon değil — vehicles.assigned_driver_name
    // eşleşmesinden korele bir alt sorguyla türetiliyor (LIMIT 1: bir şoföre
    // birden fazla araç atanmışsa — normal akışta olmamalı — çift satır yerine
    // rastgele birini gösterir).
    const result = await client.query(`
      SELECT d.*,
        (SELECT v.plate FROM vehicles v WHERE v.assigned_driver_name = d.name AND v.tenant_id = d.tenant_id LIMIT 1) AS assigned_vehicle_plate
      FROM drivers d
      ORDER BY d.created_at DESC
    `);
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
    const id = 'drv-' + Date.now();
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
    const fields = [];
    const values = [];
    let queryIdx = 1;

    for (const [key, value] of Object.entries(data)) {
      if (['name', 'tc_no', 'phone', 'license_type', 'rfid_card_id', 'site_name', 'status'].includes(key) && value !== undefined) {
        fields.push(`${key} = $${queryIdx}`);
        values.push(value);
        queryIdx++;
      }
    }

    if (fields.length === 0 && data.assigned_vehicle_plate === undefined) {
      throw new Error('Güncellenecek alan bulunamadı.');
    }

    let updatedDriver: any;
    if (fields.length > 0) {
      values.push(id);
      const result = await client.query(
        `UPDATE drivers SET ${fields.join(', ')} WHERE id = $${queryIdx} RETURNING *`,
        values
      );
      if (result.rows.length === 0) throw new Error('Şoför bulunamadı veya yetkiniz yok.');
      updatedDriver = result.rows[0];
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
    await client.query('DELETE FROM drivers WHERE id = $1', [id]);
  });
}

// ============================================================================
// TANKS CRUD
// ============================================================================

export async function getTenantTanks(): Promise<TankRecord[]> {
  return withTenant(async (client) => {
    const result = await client.query('SELECT * FROM tanks ORDER BY created_at DESC');
    return result.rows;
  });
}

export async function createTank(data: Omit<TankRecord, 'id' | 'tenant_id'>): Promise<TankRecord> {
  return withTenant(async (client, tenantId) => {
    const id = 'tnk-' + Date.now();
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
    const fields = [];
    const values = [];
    let queryIdx = 1;

    for (const [key, value] of Object.entries(data)) {
      if (['name', 'capacity_liters', 'current_level_liters', 'fuel_type', 'site_name', 'status'].includes(key) && value !== undefined) {
        fields.push(`${key} = $${queryIdx}`);
        values.push(value);
        queryIdx++;
      }
    }

    if (fields.length === 0) {
      throw new Error('Güncellenecek alan bulunamadı.');
    }

    values.push(id);
    const result = await client.query(
      `UPDATE tanks SET ${fields.join(', ')} WHERE id = $${queryIdx} RETURNING *`,
      values
    );
    if (result.rows.length === 0) throw new Error('Tank bulunamadı veya yetkiniz yok.');
    return result.rows[0];
  });
}

export async function deleteTank(id: string): Promise<void> {
  return withTenant(async (client) => {
    await client.query('DELETE FROM tanks WHERE id = $1', [id]);
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
export async function getTenantTransactionsPaginated(
  filters: TransactionFilters = {}
): Promise<PaginatedTransactions> {
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
  if (filters.siteName) {
    params.push(filters.siteName);
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
  data: Omit<TransactionRecord, 'id' | 'tenant_id' | 'created_at'>
): Promise<TransactionRecord> {
  return withTenant(async (client, tenantId) => {
    const id = 'tx-' + Date.now();

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
    const id = 'csp-' + Date.now();
    const result = await client.query(
      `INSERT INTO cross_site_permissions (id, tenant_id, vehicle_plate, driver_name, home_site, target_site, allowed_liters, expiry_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [id, tenantId, data.vehicle_plate, data.driver_name ?? null, data.home_site, data.target_site, data.allowed_liters, data.expiry_date]
    );
    return result.rows[0];
  });
}

export async function updateCrossSitePermissionStatus(id: string, status: string): Promise<CrossSitePermissionRecord> {
  return withTenant(async (client) => {
    const result = await client.query(
      'UPDATE cross_site_permissions SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );
    if (result.rows.length === 0) throw new Error('Çapraz şantiye yetkisi bulunamadı veya yetkiniz yok.');
    return result.rows[0];
  });
}
