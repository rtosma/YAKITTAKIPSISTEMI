/**
 * RES-903 — araç sayaç (km / motor-saat) giriş mantık doğrulaması. Saf, I/O yok.
 * "Tüketim hesabını bozan veri kalitesi hatalarının kaynağında yakalanması."
 */

export type MeterType = 'KM' | 'MOTOR_SAAT';

// Kritik Not: "Makul günlük üst sınır araç tipine göre farklıdır: kamyon
// ~1.000 km, ekskavatör ~24 motor-saat."
export const METER_DAILY_MAX: Record<MeterType, number> = { KM: 1000, MOTOR_SAAT: 24 };

/** Araç tipine göre sayaç birimi (açık verilmişse o kullanılır). */
export function resolveMeterType(vehicleType: string | null | undefined, explicit?: string | null): MeterType {
  if (explicit === 'KM' || explicit === 'MOTOR_SAAT') return explicit;
  const t = (vehicleType ?? '').toLowerCase();
  if (/ekskavat|dozer|loader|y[üu]kleyici|greyder|silindir|vin[çc]|forklift|i[şs]\s*makine|kep[çc]e|beko|kompres[öo]r|jenerat[öo]r/.test(t)) {
    return 'MOTOR_SAAT';
  }
  return 'KM';
}

export interface MeterCheckInput {
  meterType: MeterType;
  newValue: number;
  newAt: Date;
  previous?: { value: number; at: Date } | null;
  /** Aynı dönem için başka bir okuma zaten var mı (düzeltme değilse). */
  duplicatePeriod?: boolean;
  dailyMaxOverride?: number;
}

export type MeterSuspicionReason = 'BACKWARD' | 'ABSURD_JUMP' | 'DUPLICATE_PERIOD';

export interface MeterCheckResult {
  suspicious: boolean;
  reasons: MeterSuspicionReason[];
  detail: {
    dailyMax: number;
    elapsedDays?: number;
    deltaValue?: number;
    impliedDaily?: number;
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function checkMeterReading(input: MeterCheckInput): MeterCheckResult {
  const dailyMax = input.dailyMaxOverride ?? METER_DAILY_MAX[input.meterType];
  const reasons: MeterSuspicionReason[] = [];
  const detail: MeterCheckResult['detail'] = { dailyMax };

  if (input.previous) {
    const elapsedMs = input.newAt.getTime() - input.previous.at.getTime();
    // En az 1 saatlik pencere — aynı gün iki okuma absürt sıçrama sanılmasın.
    const elapsedDays = Math.max(elapsedMs / 86_400_000, 1 / 24);
    const delta = input.newValue - input.previous.value;
    detail.elapsedDays = round2(elapsedDays);
    detail.deltaValue = round2(delta);

    if (delta < 0) {
      reasons.push('BACKWARD');
    } else {
      const impliedDaily = delta / elapsedDays;
      detail.impliedDaily = round2(impliedDaily);
      if (impliedDaily > dailyMax) reasons.push('ABSURD_JUMP');
    }
  }

  if (input.duplicatePeriod) reasons.push('DUPLICATE_PERIOD');

  return { suspicious: reasons.length > 0, reasons, detail };
}
