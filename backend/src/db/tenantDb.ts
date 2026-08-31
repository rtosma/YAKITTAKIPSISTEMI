import { pool } from './postgresPool';
import { getTenantId } from '../context/tenantContext';

export interface VehicleRecord {
  id: string;
  tenant_id: string;
  plate: string;
  brand_model: string;
  vehicle_type: string;
  rfid_tag: string;
  status: string;
}

export interface DriverRecord {
  id: string;
  tenant_id: string;
  name: string;
  tc_no: string;
  phone: string;
  license_type: string;
  rfid_card_id: string;
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
      status: row.status
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
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    const result = await client.query(
      `INSERT INTO vehicles (id, tenant_id, plate, brand_model, vehicle_type, rfid_tag, status) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [id, tenantId, data.plate, data.brand_model, data.vehicle_type, data.rfid_tag, data.status]
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
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    const fields = [];
    const values = [];
    let queryIdx = 1;

    for (const [key, value] of Object.entries(data)) {
      if (['plate', 'brand_model', 'vehicle_type', 'rfid_tag', 'status'].includes(key) && value !== undefined) {
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
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    const result = await client.query(
      `INSERT INTO drivers (id, tenant_id, name, tc_no, phone, license_type, rfid_card_id, status) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [id, tenantId, data.name, data.tc_no, data.phone, data.license_type, data.rfid_card_id, data.status]
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
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    const fields = [];
    const values = [];
    let queryIdx = 1;

    for (const [key, value] of Object.entries(data)) {
      if (['name', 'tc_no', 'phone', 'license_type', 'rfid_card_id', 'status'].includes(key) && value !== undefined) {
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
