import { describe, it, expect } from 'vitest';
import { resolveFuelType, areFuelTypesCompatible } from '../../src/fuel/fuelTypes';

describe('resolveFuelType', () => {
  it.each([
    ['Motorin (Euro Diesel)', 'MOTORIN', true, 840, '2710194300'],
    ['DIESEL', 'MOTORIN', true, 840, '2710194300'],
    ['Kurşunsuz 95', 'BENZIN', true, 745, '2710124500'],
    ['Kursunsuz 98', 'BENZIN', true, 745, '2710124900'],
    ['LPG (Otogaz)', 'LPG', true, 540, '2711129700'],
    ['AdBlue', 'ADBLUE', false, 1090, '3808940000'],
    ['Üre çözeltisi', 'ADBLUE', false, 1090, '3808940000']
  ])('%s → grup %s, yakıt=%s, ρ15=%d, GTIP %s', (raw, group, isFuel, density, gtip) => {
    expect(resolveFuelType(raw)).toMatchObject({ group, isFuel, defaultDensity15: density, gtip });
  });
  it('AdBlue yakıt DEĞİLDİR (isFuel=false) ama takip edilir', () => expect(resolveFuelType('adblue').isFuel).toBe(false));
  it('tanınmayan / boş / null → DIGER, yakıt sayılır, motorin GTIP\'ine ve 840 yoğunluğa düşer', () => {
    for (const raw of ['Hidrojen', '', '   ', null, undefined]) {
      expect(resolveFuelType(raw as string)).toMatchObject({ group: 'DIGER', isFuel: true, gtip: '2710194300', defaultDensity15: 840 });
    }
  });
  it('AdBlue, motorin kuralından ÖNCE denenir ("DEF" kelimesi)', () => expect(resolveFuelType('DEF').group).toBe('ADBLUE'));
});

describe('areFuelTypesCompatible (yanlış yakıt hasarını önler)', () => {
  it('araç yakıt tipi tanımsız/boş → kısıt yok', () => {
    expect(areFuelTypesCompatible(null, 'Motorin')).toBe(true);
    expect(areFuelTypesCompatible(undefined, 'Benzin')).toBe(true);
    expect(areFuelTypesCompatible('   ', 'Benzin')).toBe(true);
  });
  it('aynı grup uyumlu (farklı yazımlar), iki taraf da tanınıp FARKLIYSA uyumsuz', () => {
    expect(areFuelTypesCompatible('Motorin', 'Euro Diesel')).toBe(true);
    expect(areFuelTypesCompatible('Kurşunsuz 95', 'Benzin')).toBe(true);
    expect(areFuelTypesCompatible('Benzin', 'Motorin')).toBe(false);
    expect(areFuelTypesCompatible('Motorin', 'AdBlue')).toBe(false);
    expect(areFuelTypesCompatible('LPG', 'Motorin')).toBe(false);
  });
  it('tanınmayan taraf (DIGER) yanlış-pozitif reddi engellemek için serbest bırakılır', () => {
    expect(areFuelTypesCompatible('Motorin', 'Hidrojen')).toBe(true);
    expect(areFuelTypesCompatible('Hidrojen', 'Motorin')).toBe(true);
    expect(areFuelTypesCompatible('Motorin', null)).toBe(true);
  });
});
