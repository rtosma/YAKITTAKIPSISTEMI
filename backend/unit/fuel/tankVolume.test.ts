import { describe, it, expect } from 'vitest';
import { strappingTable } from '@test-support/factories';
import {
  interpolateStrappingVolume, cylinderVolume, resolveProductGroup, thermalExpansionCoefficient, volumeCorrectionFactor, correctToStandardVolume
} from '../../src/fuel/tankVolume';

/** FUEL-403.2 hesap motoru. Beklenen değerler el ile hesaplanmıştır (yorumlarda). */
describe('interpolateStrappingVolume (daldırma cetveli, lineer interpolasyon)', () => {
  const table = strappingTable(5, 100, 250); // (0,0) (100,250) (200,500) (300,750) (400,1000)

  it('cetvel noktasında tam değer, iki nokta arasında lineer: 150 mm → 375 L', () => {
    expect(interpolateStrappingVolume(table, 100).observedLiters).toBe(250);
    expect(interpolateStrappingVolume(table, 150)).toEqual({ observedLiters: 375, outOfRange: false, method: 'STRAPPING_INTERPOLATION' });
  });
  it('doğrusal OLMAYAN cetvelde bracket doğru seçilir: (0,0)(100,100)(200,400) 150 mm → 100 + 0.5×300 = 250 L', () => {
    expect(interpolateStrappingVolume([{ levelMm: 0, volumeLiters: 0 }, { levelMm: 100, volumeLiters: 100 }, { levelMm: 200, volumeLiters: 400 }], 150).observedLiters).toBe(250);
  });
  it('3 basamağa yuvarlar: 33.3333 mm → 250 × 0.333333 = 83.333 L', () => {
    expect(interpolateStrappingVolume([{ levelMm: 0, volumeLiters: 0 }, { levelMm: 100, volumeLiters: 250 }], 100 / 3).observedLiters).toBe(83.333);
  });
  it('uç noktalar aralık İÇİ sayılır (0 mm ve 400 mm outOfRange=false)', () => {
    expect(interpolateStrappingVolume(table, 0)).toMatchObject({ observedLiters: 0, outOfRange: false });
    expect(interpolateStrappingVolume(table, 400)).toMatchObject({ observedLiters: 1000, outOfRange: false });
  });
  it('aralık dışı en yakın uca KIRPILIR ve işaretlenir (-10 mm → 0 L, 450 mm → 1000 L, outOfRange=true)', () => {
    expect(interpolateStrappingVolume(table, -10)).toMatchObject({ observedLiters: 0, outOfRange: true });
    expect(interpolateStrappingVolume(table, 450)).toMatchObject({ observedLiters: 1000, outOfRange: true });
  });
  it('2 noktadan az cetvel hata verir', () => {
    expect(() => interpolateStrappingVolume([{ levelMm: 0, volumeLiters: 0 }], 10)).toThrow(/en az 2 nokta/);
    expect(() => interpolateStrappingVolume([], 10)).toThrow();
  });
});

describe('cylinderVolume (silindirik tank kapalı form)', () => {
  it('DİKEY: π·r²·h — çap 2000, boy 3000; 1500 mm → 4712.389 L, tam dolu 9424.778 L', () => {
    const cfg = { diameterMm: 2000, lengthMm: 3000, orientation: 'VERTICAL' as const };
    expect(cylinderVolume(cfg, 1500)).toEqual({ observedLiters: 4712.389, outOfRange: false, method: 'CYLINDER_FORMULA' });
    expect(cylinderVolume(cfg, 3000).observedLiters).toBe(9424.778);
  });
  it('YATAY: yarı dolu = π·r²·L/2 (6283.185 L), çeyrek yükseklik (500 mm) = 2456.739 L, boş 0, tam dolu 12566.371 L', () => {
    const cfg = { diameterMm: 2000, lengthMm: 4000, orientation: 'HORIZONTAL' as const };
    expect(cylinderVolume(cfg, 1000).observedLiters).toBe(6283.185);
    expect(cylinderVolume(cfg, 500).observedLiters).toBe(2456.739);
    expect(cylinderVolume(cfg, 0).observedLiters).toBe(0);
    expect(cylinderVolume(cfg, 2000).observedLiters).toBe(12566.371);
  });
  it('sınır dışı yükseklik kırpılır ve işaretlenir (yatay: çapı aşan; dikey: boyu aşan; negatif → 0)', () => {
    expect(cylinderVolume({ diameterMm: 2000, lengthMm: 4000, orientation: 'HORIZONTAL' }, 2500)).toMatchObject({ observedLiters: 12566.371, outOfRange: true });
    expect(cylinderVolume({ diameterMm: 2000, lengthMm: 3000, orientation: 'VERTICAL' }, 3500)).toMatchObject({ observedLiters: 9424.778, outOfRange: true });
    expect(cylinderVolume({ diameterMm: 2000, lengthMm: 3000, orientation: 'VERTICAL' }, -5)).toMatchObject({ observedLiters: 0, outOfRange: true });
  });
  it('PRİZMATİK (INV-1501): taban alanı × dolu yükseklik — 2000×1500 mm taban, 1000 mm yükseklik; 500 mm → 1500 L, tam dolu (1000 mm) → 3000 L, boş → 0 L', () => {
    const cfg = { diameterMm: 0, lengthMm: 2000, widthMm: 1500, heightMm: 1000, orientation: 'PRISMATIC' as const };
    expect(cylinderVolume(cfg, 500)).toEqual({ observedLiters: 1500, outOfRange: false, method: 'CYLINDER_FORMULA' });
    expect(cylinderVolume(cfg, 1000).observedLiters).toBe(3000);
    expect(cylinderVolume(cfg, 0).observedLiters).toBe(0);
  });
  it('PRİZMATİK: sınır dışı yükseklik toplam yüksekliğe KIRPILIR ve işaretlenir (silindirle AYNI kural); negatif → 0', () => {
    const cfg = { diameterMm: 0, lengthMm: 2000, widthMm: 1500, heightMm: 1000, orientation: 'PRISMATIC' as const };
    expect(cylinderVolume(cfg, 1200)).toMatchObject({ observedLiters: 3000, outOfRange: true });
    expect(cylinderVolume(cfg, -10)).toMatchObject({ observedLiters: 0, outOfRange: true });
  });
  it('PRİZMATİK: widthMm/heightMm hiç verilmemişse (eksik yapılandırma) 0 L döner, hata FIRLATMAZ (aynı "geçersiz girdi → 0" toleransı)', () => {
    expect(cylinderVolume({ diameterMm: 0, lengthMm: 2000, orientation: 'PRISMATIC' }, 500).observedLiters).toBe(0);
  });
});

describe('ASTM D1250 sıcaklık düzeltmesi', () => {
  it('serbest metin yakıt tipi ürün grubuna çevrilir; tanınmayan/boş → DIESEL', () => {
    expect(resolveProductGroup('Motorin (Euro Diesel)')).toBe('DIESEL');
    expect(resolveProductGroup('Kurşunsuz 95')).toBe('GASOLINE');
    expect(resolveProductGroup('Unleaded')).toBe('GASOLINE');
    expect(resolveProductGroup('Jet A1')).toBe('JET');
    expect(resolveProductGroup('Crude oil')).toBe('CRUDE');
    expect(resolveProductGroup('Madeni yağ')).toBe('LUBE');
    expect(resolveProductGroup('AdBlue')).toBe('DIESEL');
    expect(resolveProductGroup(null)).toBe('DIESEL');
    expect(resolveProductGroup(undefined)).toBe('DIESEL');
    expect(resolveProductGroup('')).toBe('DIESEL');
  });
  it('α15: dizel varsayılan ρ=840 → 186.9696/840² + 0.4862/840 = 0.00084379; benzin 745 → 0.00121315; yağ ρ=900 (özel yoğunluk) → 0.6278/900', () => {
    expect(thermalExpansionCoefficient('DIESEL')).toBeCloseTo(0.00084379, 8);
    expect(thermalExpansionCoefficient('GASOLINE')).toBeCloseTo(0.00121315, 8);
    expect(thermalExpansionCoefficient('LUBE', 900)).toBeCloseTo(0.6278 / 900, 10);
    expect(thermalExpansionCoefficient('DIESEL', 0)).toBeCloseTo(0.00084379, 8); // 0/negatif yoğunluk → varsayılan
    expect(thermalExpansionCoefficient('DIESEL', -5)).toBeCloseTo(0.00084379, 8);
  });
  it('VCF: 15 °C\'de tam 1; sıcakta <1 (25 °C dizel 0.991541), soğukta >1 (5 °C dizel 1.008416)', () => {
    expect(volumeCorrectionFactor(15, 'DIESEL')).toBe(1);
    expect(volumeCorrectionFactor(25, 'DIESEL')).toBeCloseTo(0.991541, 6);
    expect(volumeCorrectionFactor(5, 'DIESEL')).toBeCloseTo(1.008416, 6);
    expect(volumeCorrectionFactor(30, 'GASOLINE')).toBeCloseTo(0.981707, 6);
  });
  it('sıcaklık VARSA düzeltilir: 10000 L @25 °C dizel → 9915.411 L standart, düzeltme bayrağı true', () => {
    expect(correctToStandardVolume(10000, 25, 'Motorin')).toEqual({ observedLiters: 10000, standardLiters: 9915.411, temperatureCorrected: true, vcf: 0.991541, observedTempC: 25, productGroup: 'DIESEL' });
  });
  it('sıcaklık YOKSA (null/undefined/NaN/Infinity) düzeltme YAPILMAZ ve "uncorrected" işaretlenir', () => {
    for (const t of [null, undefined, NaN, Infinity]) {
      expect(correctToStandardVolume(1234.5678, t as number, 'Benzin')).toEqual({ observedLiters: 1234.568, standardLiters: 1234.568, temperatureCorrected: false, vcf: 1, observedTempC: null, productGroup: 'GASOLINE' });
    }
  });
  it('0 °C\'de sıcaklık VARDIR (falsy tuzağı): düzeltme uygulanır', () => {
    const r = correctToStandardVolume(1000, 0, 'Motorin');
    expect(r.temperatureCorrected).toBe(true);
    expect(r.standardLiters).toBeGreaterThan(1000);
  });
});
