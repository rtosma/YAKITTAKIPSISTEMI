import { describe, it, expect } from 'vitest';
import { checkMeterReading, resolveMeterType, METER_DAILY_MAX } from '../../src/fleet/meterValidation';

const T0 = new Date('2026-03-01T08:00:00.000Z');
const plusDays = (d: number): Date => new Date(T0.getTime() + d * 86_400_000);

describe('resolveMeterType', () => {
  it('açık tip verilmişse o kullanılır (araç tipini ezer)', () => {
    expect(resolveMeterType('Kamyon', 'MOTOR_SAAT')).toBe('MOTOR_SAAT');
    expect(resolveMeterType('Ekskavatör', 'KM')).toBe('KM');
  });
  it('geçersiz açık tip yok sayılır → araç tipine bakılır', () => expect(resolveMeterType('Ekskavatör', 'BILINMEYEN')).toBe('MOTOR_SAAT'));
  it('iş makineleri motor saati, diğerleri km', () => {
    for (const t of ['Ekskavatör', 'Dozer', 'Loader', 'Yükleyici', 'Greyder', 'Forklift', 'Jeneratör', 'Kompresör', 'Beko']) expect(resolveMeterType(t)).toBe('MOTOR_SAAT');
    for (const t of ['Kamyon', 'Beton Mikseri', 'Otomobil', '', null, undefined]) expect(resolveMeterType(t as string)).toBe('KM');
  });
});

describe('checkMeterReading', () => {
  it('önceki okuma yoksa şüpheli değil; günlük limit araç tipine göre (KM 1000, saat 24)', () => {
    expect(checkMeterReading({ meterType: 'KM', newValue: 500, newAt: T0 })).toEqual({ suspicious: false, reasons: [], detail: { dailyMax: 1000 } });
    expect(checkMeterReading({ meterType: 'MOTOR_SAAT', newValue: 5, newAt: T0 }).detail.dailyMax).toBe(METER_DAILY_MAX.MOTOR_SAAT);
  });
  it('makul artış: 1 günde +500 km → günlük 500 ≤ 1000, şüpheli değil; ayrıntı hesaplanır', () => {
    const r = checkMeterReading({ meterType: 'KM', newValue: 1500, newAt: plusDays(1), previous: { value: 1000, at: T0 } });
    expect(r).toEqual({ suspicious: false, reasons: [], detail: { dailyMax: 1000, elapsedDays: 1, deltaValue: 500, impliedDaily: 500 } });
  });
  it('sınırda kabul, üstünde ABSURD_JUMP: tam 1000 km/gün geçer, 1000.01 km/gün şüpheli', () => {
    expect(checkMeterReading({ meterType: 'KM', newValue: 2000, newAt: plusDays(1), previous: { value: 1000, at: T0 } }).suspicious).toBe(false);
    expect(checkMeterReading({ meterType: 'KM', newValue: 2000.01, newAt: plusDays(1), previous: { value: 1000, at: T0 } }).reasons).toEqual(['ABSURD_JUMP']);
  });
  it('1 günde +2500 km → ABSURD_JUMP (günlük 2500 > 1000)', () => {
    const r = checkMeterReading({ meterType: 'KM', newValue: 3500, newAt: plusDays(1), previous: { value: 1000, at: T0 } });
    expect(r.reasons).toEqual(['ABSURD_JUMP']);
    expect(r.detail.impliedDaily).toBe(2500);
  });
  it('geriye gidiş BACKWARD (impliedDaily hesaplanmaz)', () => {
    const r = checkMeterReading({ meterType: 'KM', newValue: 900, newAt: plusDays(2), previous: { value: 1000, at: T0 } });
    expect(r.reasons).toEqual(['BACKWARD']);
    expect(r.detail).toEqual({ dailyMax: 1000, elapsedDays: 2, deltaValue: -100 });
  });
  it('sıfır/çok kısa süre en az 1 saate (1/24 gün) sabitlenir: 1 saatte +2 motor saati → günlük 48 > 24 şüpheli', () => {
    const r = checkMeterReading({ meterType: 'MOTOR_SAAT', newValue: 102, newAt: new Date(T0.getTime() + 3_600_000), previous: { value: 100, at: T0 } });
    expect(r.reasons).toEqual(['ABSURD_JUMP']);
    expect(r.detail).toMatchObject({ elapsedDays: 0.04, impliedDaily: 48 });
    // aynı an (süre 0) → yine 1 saate sabitlenir, sıfıra bölme yok
    const same = checkMeterReading({ meterType: 'KM', newValue: 110, newAt: T0, previous: { value: 100, at: T0 } });
    expect(same.detail.impliedDaily).toBe(240);
    expect(same.suspicious).toBe(false);
  });
  it('dailyMaxOverride varsayılanı ezer', () => {
    expect(checkMeterReading({ meterType: 'KM', newValue: 1200, newAt: plusDays(1), previous: { value: 1000, at: T0 }, dailyMaxOverride: 100 }).reasons).toEqual(['ABSURD_JUMP']);
    expect(checkMeterReading({ meterType: 'KM', newValue: 1200, newAt: plusDays(1), previous: { value: 1000, at: T0 }, dailyMaxOverride: 300 }).suspicious).toBe(false);
  });
  it('aynı dönemde ikinci okuma DUPLICATE_PERIOD; geriye gidişle birlikte iki neden de listelenir', () => {
    expect(checkMeterReading({ meterType: 'KM', newValue: 10, newAt: T0, duplicatePeriod: true }).reasons).toEqual(['DUPLICATE_PERIOD']);
    expect(checkMeterReading({ meterType: 'KM', newValue: 900, newAt: plusDays(1), previous: { value: 1000, at: T0 }, duplicatePeriod: true }).reasons).toEqual(['BACKWARD', 'DUPLICATE_PERIOD']);
  });
});
