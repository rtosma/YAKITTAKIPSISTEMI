import { apiFetch } from '../utils/api';

/**
 * FLEET-1408 AC: "Geçmiş yükümlülükler dashboard'da kritik olarak
 * gösterilmelidir." Backend GET /fleet/compliance/dashboard ZATEN tamdı
 * (yaklaşan/geciken muayene-egzoz-sigorta + lastik değişimi) — frontend'de
 * hiç tüketilmiyordu.
 */
export interface FleetComplianceItem {
  type: 'DEADLINE' | 'TIRE';
  vehicleId: string;
  vehiclePlate: string;
  subKey: string;
  label: string;
  dueInfo: string;
  critical: boolean;
  severity: 'CRITICAL' | 'WARNING';
}

export async function fetchFleetComplianceDashboard(): Promise<FleetComplianceItem[]> {
  const response = await apiFetch('/fleet/compliance/dashboard');
  return response.data || [];
}
