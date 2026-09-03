import { pool } from './postgresPool';
import { getTenantId } from '../context/tenantContext';

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
}

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
 */
export async function getTenantCompanyProfile(opts?: { role?: string; siteName?: string }): Promise<CompanyProfile> {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('TENANT_CONTEXT_MISSING');

  const companyRes = await pool.query(
    `SELECT id, name, tax_number, code, city, license_status, license_expiry, modules
     FROM companies WHERE id = $1`,
    [tenantId]
  );
  if (companyRes.rows.length === 0) throw new Error('COMPANY_NOT_FOUND');
  const c = companyRes.rows[0];

  const restrictSite = opts?.role === 'SITE_MANAGER' && opts?.siteName ? opts.siteName : null;

  const sitesRes = await pool.query(
    `SELECT s.id, s.name, s.location,
       (SELECT COUNT(*)::int FROM tanks t   WHERE t.tenant_id = $1 AND t.site_name = s.name)   AS active_tanks_count,
       (SELECT COUNT(*)::int FROM vehicles v WHERE v.tenant_id = $1 AND v.site_name = s.name) AS active_vehicles_count
     FROM sites s
     WHERE s.tenant_id = $1 AND ($2::text IS NULL OR s.name = $2)
     ORDER BY s.name ASC`,
    [tenantId, restrictSite]
  );

  const vehRes = await pool.query(
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
}

export async function getTenantSites(): Promise<string[]> {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('TENANT_CONTEXT_MISSING');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user;');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    
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
    
    await client.query('COMMIT');
    return result.rows.map(row => row.site_name);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function createTenantSite(siteName: string, location: string = 'Türkiye'): Promise<SiteRecord> {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('TENANT_CONTEXT_MISSING');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user;');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);

    const id = `site-${Date.now()}`;
    const result = await client.query(
      `INSERT INTO sites (id, tenant_id, name, location)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, name) DO UPDATE SET location = EXCLUDED.location
       RETURNING *`,
      [id, tenantId, siteName, location]
    );

    await client.query('COMMIT');
    return result.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteTenantSite(siteName: string): Promise<boolean> {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('TENANT_CONTEXT_MISSING');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user;');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);

    // Delete from sites table
    await client.query('DELETE FROM sites WHERE name = $1', [siteName]);

    // Disassociate site_name from vehicles, drivers, tanks, users
    await client.query("UPDATE vehicles SET site_name = 'Atanmadı' WHERE site_name = $1", [siteName]);
    await client.query("UPDATE drivers SET site_name = 'Atanmadı' WHERE site_name = $1", [siteName]);
    await client.query("UPDATE tanks SET site_name = 'Atanmadı' WHERE site_name = $1", [siteName]);
    await client.query("UPDATE users SET site_name = NULL WHERE site_name = $1", [siteName]);

    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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
  const tenantId = getTenantId();
  if (!tenantId) {
    throw new Error('TENANT_CONTEXT_MISSING: DB işlemi için aktif tenantId bulunamadı.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user;');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    const result = await client.query('SELECT * FROM vehicles ORDER BY created_at DESC');
    await client.query('COMMIT');
    return result.rows.map(row => ({
      id: row.id,
      tenant_id: row.tenant_id,
      plate: row.plate,
      brand_model: row.brand_model,
      vehicle_type: row.vehicle_type,
      rfid_tag: row.rfid_tag,
      site_name: row.site_name,
      status: row.status,
      fuel_capacity_liters: row.fuel_capacity_liters !== null ? Number(row.fuel_capacity_liters) : null
    }));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function createVehicle(data: Omit<VehicleRecord, 'id' | 'tenant_id'>): Promise<VehicleRecord> {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('TENANT_CONTEXT_MISSING');
  const id = 'veh-' + Date.now(); // In production, use UUID or better ID generation
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user;');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    const result = await client.query(
      `INSERT INTO vehicles (id, tenant_id, plate, brand_model, vehicle_type, rfid_tag, site_name, status, fuel_capacity_liters)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [id, tenantId, data.plate, data.brand_model, data.vehicle_type, data.rfid_tag, data.site_name, data.status, data.fuel_capacity_liters ?? null]
    );
    await client.query('COMMIT');
    return result.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function updateVehicle(id: string, data: Partial<VehicleRecord>): Promise<VehicleRecord> {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('TENANT_CONTEXT_MISSING');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user;');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    const fields = [];
    const values = [];
    let queryIdx = 1;

    for (const [key, value] of Object.entries(data)) {
      if (['plate', 'brand_model', 'vehicle_type', 'rfid_tag', 'site_name', 'status', 'fuel_capacity_liters'].includes(key) && value !== undefined) {
        fields.push(`${key} = $${queryIdx}`);
        values.push(value);
        queryIdx++;
      }
    }

    if (fields.length === 0) {
      await client.query('ROLLBACK');
      throw new Error('Güncellenecek alan bulunamadı.');
    }

    values.push(id);
    const result = await client.query(
      `UPDATE vehicles SET ${fields.join(', ')} WHERE id = $${queryIdx} RETURNING *`,
      values
    );
    await client.query('COMMIT');
    if (result.rows.length === 0) throw new Error('Araç bulunamadı veya yetkiniz yok.');
    return result.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteVehicle(id: string): Promise<void> {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('TENANT_CONTEXT_MISSING');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user;');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    await client.query('DELETE FROM vehicles WHERE id = $1', [id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ============================================================================
// DRIVERS CRUD
// ============================================================================

export async function getTenantDrivers(): Promise<DriverRecord[]> {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('TENANT_CONTEXT_MISSING');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user;');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    const result = await client.query('SELECT * FROM drivers ORDER BY created_at DESC');
    await client.query('COMMIT');
    return result.rows;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function createDriver(data: Omit<DriverRecord, 'id' | 'tenant_id'>): Promise<DriverRecord> {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('TENANT_CONTEXT_MISSING');
  const id = 'drv-' + Date.now();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user;');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    const result = await client.query(
      `INSERT INTO drivers (id, tenant_id, name, tc_no, phone, license_type, rfid_card_id, site_name, status) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [id, tenantId, data.name, data.tc_no, data.phone, data.license_type, data.rfid_card_id, data.site_name, data.status]
    );
    await client.query('COMMIT');
    return result.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function updateDriver(id: string, data: Partial<DriverRecord>): Promise<DriverRecord> {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('TENANT_CONTEXT_MISSING');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user;');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
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

    if (fields.length === 0) {
      await client.query('ROLLBACK');
      throw new Error('Güncellenecek alan bulunamadı.');
    }

    values.push(id);
    const result = await client.query(
      `UPDATE drivers SET ${fields.join(', ')} WHERE id = $${queryIdx} RETURNING *`,
      values
    );
    await client.query('COMMIT');
    if (result.rows.length === 0) throw new Error('Şoför bulunamadı veya yetkiniz yok.');
    return result.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteDriver(id: string): Promise<void> {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('TENANT_CONTEXT_MISSING');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user;');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    await client.query('DELETE FROM drivers WHERE id = $1', [id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ============================================================================
// TANKS CRUD
// ============================================================================

export async function getTenantTanks(): Promise<TankRecord[]> {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('TENANT_CONTEXT_MISSING');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user;');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    const result = await client.query('SELECT * FROM tanks ORDER BY created_at DESC');
    await client.query('COMMIT');
    return result.rows;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function createTank(data: Omit<TankRecord, 'id' | 'tenant_id'>): Promise<TankRecord> {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('TENANT_CONTEXT_MISSING');
  const id = 'tnk-' + Date.now();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user;');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    const result = await client.query(
      `INSERT INTO tanks (id, tenant_id, name, capacity_liters, current_level_liters, fuel_type, site_name, status) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [id, tenantId, data.name, data.capacity_liters, data.current_level_liters, data.fuel_type, data.site_name, data.status]
    );
    await client.query('COMMIT');
    return result.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function updateTank(id: string, data: Partial<TankRecord>): Promise<TankRecord> {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('TENANT_CONTEXT_MISSING');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user;');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
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
      await client.query('ROLLBACK');
      throw new Error('Güncellenecek alan bulunamadı.');
    }

    values.push(id);
    const result = await client.query(
      `UPDATE tanks SET ${fields.join(', ')} WHERE id = $${queryIdx} RETURNING *`,
      values
    );
    await client.query('COMMIT');
    if (result.rows.length === 0) throw new Error('Tank bulunamadı veya yetkiniz yok.');
    return result.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteTank(id: string): Promise<void> {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('TENANT_CONTEXT_MISSING');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user;');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    await client.query('DELETE FROM tanks WHERE id = $1', [id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
