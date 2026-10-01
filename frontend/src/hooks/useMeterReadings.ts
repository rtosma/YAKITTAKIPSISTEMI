import { apiFetch } from '../utils/api';
import { MeterReading, MeterType, BulkMeterResultRow, MissingMeterReadings, MeterReadingSuspicionDetail } from '../types';

/**
 * FE-813 — FLEET-1404/RES-903'ün zaten tam olan backend'i (/vehicles/:id/
 * meter-readings, /meter-readings/bulk, /meter-readings/missing) için
 * önceden hiç frontend arayüzü yoktu. useVehicleMaintenanceRecords.ts
 * (FLEET-1407) İLE AYNI desen: global AppContext state'ine YAZILMAZ, bu
 * sayfanın kendi yaşam döngüsünde doğrudan çağrılır.
 */

function mapMeterReading(r: any): MeterReading {
  return {
    id: r.id,
    vehicleId: r.vehicle_id,
    vehiclePlate: r.vehicle_plate,
    meterType: r.meter_type,
    value: Number(r.reading_value),
    readingAt: r.reading_at,
    periodLabel: r.period_label,
    source: r.source,
    isSuspicious: r.is_suspicious,
    suspicionReasons: r.suspicion_reasons || [],
    overrideApproved: r.override_approved,
    overrideReason: r.override_reason,
    approvedBy: r.approved_by,
    correctsReadingId: r.corrects_reading_id,
    note: r.note,
    enteredBy: r.entered_by,
    createdAt: r.created_at
  };
}

export async function fetchVehicleMeterReadings(vehicleId: string): Promise<MeterReading[]> {
  const response = await apiFetch(`/vehicles/${vehicleId}/meter-readings`);
  return (response.data || []).map(mapMeterReading);
}

export interface RecordMeterReadingInput {
  value: number;
  meterType?: MeterType;
  readingAt?: string;
  periodLabel?: string;
  note?: string;
  overrideReason?: string;
  correctsReadingId?: string;
}

/**
 * RES-903: backend şüpheli bir girişi (geri giden/absürt sıçrama/mükerrer
 * dönem) `overrideReason` olmaksızın 409 ile REDDEDER — bu fonksiyon o
 * hatayı YUTMAZ, olduğu gibi fırlatır (çağıran taraf `err.details` içindeki
 * MeterReadingSuspicionDetail'i okuyup onay diyaloğu gösterir, sonra AYNI
 * fonksiyonu overrideReason doldurulmuş olarak tekrar çağırır).
 */
export async function recordMeterReading(vehicleId: string, input: RecordMeterReadingInput): Promise<{ reading: MeterReading; warnings: string[] }> {
  const response = await apiFetch(`/vehicles/${vehicleId}/meter-readings`, {
    method: 'POST',
    body: JSON.stringify(input)
  });
  return { reading: mapMeterReading(response.data.reading), warnings: response.data.warnings || [] };
}

export interface BulkMeterReadingItem {
  vehiclePlate: string;
  value: number;
  meterType?: MeterType;
  readingAt?: string;
  periodLabel?: string;
  note?: string;
  overrideReason?: string;
}

export async function recordMeterReadingsBulk(items: BulkMeterReadingItem[]): Promise<{ total: number; accepted: number; failed: number; rows: BulkMeterResultRow[] }> {
  const response = await apiFetch('/meter-readings/bulk', {
    method: 'POST',
    body: JSON.stringify({ items })
  });
  return response.data;
}

export async function fetchMissingMeterReadings(periodLabel: string, meterType?: MeterType): Promise<MissingMeterReadings> {
  const qs = new URLSearchParams({ periodLabel, ...(meterType ? { meterType } : {}) }).toString();
  const response = await apiFetch(`/meter-readings/missing?${qs}`);
  return response.data;
}

export async function remindMissingMeterReadings(periodLabel: string, meterType?: MeterType): Promise<{ periodLabel: string; remindedSites: number }> {
  const response = await apiFetch('/meter-readings/missing/remind', {
    method: 'POST',
    body: JSON.stringify({ periodLabel, ...(meterType ? { meterType } : {}) })
  });
  return response.data;
}

// Backend fleet/meterValidation.ts'teki resolveMeterType İLE AYNI karar —
// burada Vehicle.type'ın KAPALI union'ı üzerinden (regex yerine) basitçe.
const MOTOR_SAAT_VEHICLE_TYPES = ['Ekskavatör', 'Dozer', 'Silindir'];
export function resolveMeterTypeForVehicleType(vehicleType: string): MeterType {
  return MOTOR_SAAT_VEHICLE_TYPES.includes(vehicleType) ? 'MOTOR_SAAT' : 'KM';
}

/** Europe/Istanbul farkı burada göz ardı edilebilir (dönem etiketi sadece YYYY-AA) — yerel tarih yeterli. */
export function currentPeriodLabel(): string {
  return new Date().toISOString().slice(0, 7);
}

/**
 * Backend'in 409 METER_READING_SUSPICIOUS'ının `detail` alanı bir metin
 * DEĞİL, yapılandırılmış bir nesnedir (bkz. backend/src/fleet/
 * meterValidation.ts MeterCheckResult) — React'te doğrudan {detail} olarak
 * render etmek "Objects are not valid as a React child" ile ÇÖKER (canlı
 * yakalanan bug). Bu, o nesneyi okunabilir bir cümleye çevirir.
 */
export function formatSuspicionDetail(detail: MeterReadingSuspicionDetail['detail']): string {
  const parts: string[] = [];
  if (detail.deltaValue !== undefined) parts.push(`fark: ${detail.deltaValue}`);
  if (detail.impliedDaily !== undefined) parts.push(`günlük ${detail.impliedDaily} (sınır: ${detail.dailyMax})`);
  if (detail.elapsedDays !== undefined) parts.push(`${detail.elapsedDays} gün aralıkla`);
  return parts.length > 0 ? parts.join(', ') : `günlük sınır: ${detail.dailyMax}`;
}
