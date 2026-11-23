import { apiFetch } from '../utils/api';
import { VehicleMaintenanceRecord } from '../types';

/**
 * FLEET-1407 AC: "Bakım kayıtları araç kartında listelenmelidir." Backend
 * GET/POST /vehicles/:id/maintenance-records ZATEN vardı ama frontend'de
 * hiç tüketilmiyordu. fetchAllFilteredTransactions (useTransactionsQuery.ts)
 * İLE AYNI desen — global AppContext state'ine YAZILMAZ (yalnızca bir
 * modal açıkken gereken, sık değişmeyen bir alt-kaynak), doğrudan çağrılıp
 * döndürülür.
 */

function mapMaintenanceRecord(r: any): VehicleMaintenanceRecord {
  return {
    id: r.id,
    vehicleId: r.vehicleId,
    vehiclePlate: r.vehiclePlate,
    maintenanceType: r.maintenanceType,
    performedAt: r.performedAt,
    odometerValue: r.odometerValue,
    costAmount: Number(r.costAmount),
    operationsDescription: r.operationsDescription,
    nextDueDate: r.nextDueDate,
    nextDueMeterValue: r.nextDueMeterValue,
    createdBy: r.createdBy,
    createdAt: r.createdAt
  };
}

export async function fetchVehicleMaintenanceRecords(vehicleId: string): Promise<VehicleMaintenanceRecord[]> {
  const response = await apiFetch(`/vehicles/${vehicleId}/maintenance-records`);
  return (response.data || []).map(mapMaintenanceRecord);
}

export interface CreateMaintenanceRecordInput {
  maintenanceType: string;
  performedAt: string;
  odometerValue?: number;
  costAmount: number;
  operationsDescription: string;
  nextDueDate?: string;
  nextDueMeterValue?: number;
}

export async function createVehicleMaintenanceRecord(vehicleId: string, data: CreateMaintenanceRecordInput): Promise<VehicleMaintenanceRecord> {
  const response = await apiFetch(`/vehicles/${vehicleId}/maintenance-records`, {
    method: 'POST',
    body: JSON.stringify(data)
  });
  return mapMaintenanceRecord(response.data);
}
