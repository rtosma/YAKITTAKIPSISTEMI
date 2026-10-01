import { apiFetch } from '../utils/api';
import { CalibrationCommand, CalibrationTestIntake } from '../types';

/**
 * FE-814 — FUEL-404'ün zaten tam olan K-factor uzaktan kalibrasyon akışı
 * (komut/ack/zaman aşımı/geri alma/ikinci onay + test alımı sihirbazı
 * sapma/öneri hesabı) için önceden hiç frontend arayüzü yoktu.
 * useVehicleMaintenanceRecords.ts/useMeterReadings.ts İLE AYNI desen:
 * global AppContext state'ine YAZILMAZ, modal/sihirbaz kendi yaşam
 * döngüsünde doğrudan çağırır.
 */

function mapCalibrationCommand(c: any): CalibrationCommand {
  return {
    id: c.id,
    deviceId: c.device_id,
    previousKFactor: c.previous_k_factor !== null ? Number(c.previous_k_factor) : null,
    newKFactor: Number(c.new_k_factor),
    reason: c.reason,
    referenceMeasurement: c.reference_measurement,
    requestedBy: c.requested_by,
    requiresSecondApproval: c.requires_second_approval,
    approvedBy: c.approved_by,
    approvedAt: c.approved_at,
    status: c.status,
    sentAt: c.sent_at,
    ackedAt: c.acked_at,
    isRollback: c.is_rollback,
    createdAt: c.created_at
  };
}

function mapTestIntake(t: any): CalibrationTestIntake {
  return {
    id: t.id,
    deviceId: t.device_id,
    tankName: t.tank_name,
    referenceVolumeLiters: Number(t.reference_volume_liters),
    measuredLiters: Number(t.measured_liters),
    ambientTemperatureCelsius: t.ambient_temperature_celsius !== null ? Number(t.ambient_temperature_celsius) : null,
    kFactorAtTest: Number(t.k_factor_at_test),
    deviationRatio: Number(t.deviation_ratio),
    proposedKFactor: Number(t.proposed_k_factor),
    verifiesCalibrationCommandId: t.verifies_calibration_command_id,
    requestedBy: t.requested_by,
    createdAt: t.created_at
  };
}

export interface RequestCalibrationInput {
  newKFactor: number;
  reason: string;
  referenceMeasurement?: { referenceVolumeLiters?: number; measuredLiters?: number; ambientTemperatureCelsius?: number };
}

export async function requestCalibration(deviceId: string, input: RequestCalibrationInput): Promise<CalibrationCommand> {
  const response = await apiFetch(`/devices/${deviceId}/calibration`, { method: 'POST', body: JSON.stringify(input) });
  return mapCalibrationCommand(response.data);
}

export async function approveCalibration(deviceId: string, commandId: string): Promise<CalibrationCommand> {
  const response = await apiFetch(`/devices/${deviceId}/calibration/${commandId}/approve`, { method: 'POST' });
  return mapCalibrationCommand(response.data);
}

export async function rollbackCalibration(deviceId: string): Promise<CalibrationCommand> {
  const response = await apiFetch(`/devices/${deviceId}/calibration/rollback`, { method: 'POST' });
  return mapCalibrationCommand(response.data);
}

export async function fetchCalibrationHistory(deviceId: string): Promise<CalibrationCommand[]> {
  const response = await apiFetch(`/devices/${deviceId}/calibration-history`);
  return (response.data || []).map(mapCalibrationCommand);
}

export interface RecordTestIntakeInput {
  tankName: string;
  siteName: string;
  referenceVolumeLiters: number;
  measuredLiters: number;
  ambientTemperatureCelsius?: number;
  verifiesCalibrationCommandId?: string;
}

export async function recordTestIntake(deviceId: string, input: RecordTestIntakeInput): Promise<{ intake: CalibrationTestIntake; recommendedKFactor: number; basedOnSingleMeasurement: boolean }> {
  const response = await apiFetch(`/devices/${deviceId}/test-intake`, { method: 'POST', body: JSON.stringify(input) });
  return { intake: mapTestIntake(response.data), recommendedKFactor: Number(response.recommendedKFactor), basedOnSingleMeasurement: response.basedOnSingleMeasurement };
}

export async function fetchTestIntakes(deviceId: string): Promise<CalibrationTestIntake[]> {
  const response = await apiFetch(`/devices/${deviceId}/test-intakes`);
  return (response.data || []).map(mapTestIntake);
}

export const CALIBRATION_STATUS_LABELS: Record<string, string> = {
  IKINCI_ONAY_BEKLIYOR: 'İkinci Onay Bekliyor',
  BEKLIYOR: 'Gönderildi, Onay Bekliyor',
  ONAYLANDI: 'Uygulandı',
  REDDEDILDI: 'Cihaz Reddetti',
  ZAMAN_ASIMI: 'Cihaza Ulaşmadı'
};
