import { getTenantId } from '../context/tenantContext';

// Simulated DB / In-memory RLS emulation table data for fallback/demo
export interface VehicleRecord {
  id: string;
  tenant_id: string;
  plate: string;
  brand_model: string;
  vehicle_type: string;
  rfid_tag: string;
  status: string;
}

const MOCK_VEHICLES_DB: VehicleRecord[] = [
  { id: 'v1', tenant_id: 'comp-camsa', plate: '34 CTP 82', brand_model: 'Volvo FMX 460', vehicle_type: 'Kamyon', rfid_tag: 'TAG-882910', status: 'AKTİF' },
  { id: 'v2', tenant_id: 'comp-camsa', plate: '34 BKT 19', brand_model: 'CAT 349D Excavator', vehicle_type: 'Ekskavatör', rfid_tag: 'TAG-882911', status: 'AKTİF' },
  { id: 'v3', tenant_id: 'comp-kusak', plate: '41 KCL 05', brand_model: 'MAN TGS 33.420', vehicle_type: 'Beton Mikseri', rfid_tag: 'TAG-882913', status: 'AKTİF' },
  { id: 'v4', tenant_id: 'comp-avrasya', plate: '16 ORM 12', brand_model: 'Ford Transit', vehicle_type: 'Hizmet', rfid_tag: 'TAG-882915', status: 'BAKIMDA' }
];

/**
 * Execute DB Query within Transaction setting `SET LOCAL app.current_tenant_id = $1`.
 * Prevents session variable leaks when PgBouncer / Connection Pooling is used.
 */
export async function withTenantDb<T>(callback: (context: { tenantId: string }) => Promise<T>): Promise<T> {
  const tenantId = getTenantId();

  if (!tenantId) {
    throw new Error('TENANT_CONTEXT_MISSING: DB işlemi için aktif tenantId bulunamadı.');
  }

  // Transaction simulation: Set local tenant session variable for RLS
  const sessionVar = { 'app.current_tenant_id': tenantId };

  // Run user callback with RLS context guarantee
  const result = await callback({ tenantId: sessionVar['app.current_tenant_id'] });

  return result;
}

/**
 * Helper to fetch vehicles enforcing RLS (Row-Level Security)
 */
export async function getTenantVehicles(): Promise<VehicleRecord[]> {
  return withTenantDb(async ({ tenantId }) => {
    // Equivalent to: SELECT * FROM vehicles WHERE (RLS policy check matches tenant_id)
    return MOCK_VEHICLES_DB.filter(v => v.tenant_id === tenantId);
  });
}
