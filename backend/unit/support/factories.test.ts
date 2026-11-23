import { describe, it, expect, beforeEach } from 'vitest';
import {
  defineFactory, resetFactorySequence, nextSeq, vehicleFactory, driverFactory, tankFactory, transactionFactory, tenantFactory, hardwareDeviceFactory, telemetryFactory, userFactory,
  validTckn, validVkn, strappingTable, toCamel, istanbul, FIXED_NOW
} from '@test-support/factories';
import { isValidVKN, isValidTCKN } from '../../src/compliance/taxIdValidation';
import { interpolateStrappingVolume } from '../../src/fuel/tankVolume';

describe('test veri fabrikaları (TEST-1006 AC: ortak kullanılabilir)', () => {
  beforeEach(() => resetFactorySequence());

  it('varsayılan GEÇERLİ nesne üretir; ezme yalnızca verilen alanı değiştirir', () => {
    const v = vehicleFactory.build();
    expect(v).toMatchObject({ id: 'veh-1', plate: '34 TST 01', status: 'AKTİF', tenant_id: 'tenant-1' });
    expect(vehicleFactory.build({ status: 'PASİF', plate: '06 ABC 99' })).toMatchObject({ id: 'veh-2', status: 'PASİF', plate: '06 ABC 99', brand_model: 'Test Kamyon' });
  });
  it('buildMany: n adet, her biri farklı kimlik; each() ile bireysel ezme', () => {
    const list = tankFactory.buildMany(3, (i) => ({ current_level_liters: (i + 1) * 1000 }));
    expect(list.map((t) => t.id)).toEqual(['tank-1', 'tank-2', 'tank-3']);
    expect(list.map((t) => t.current_level_liters)).toEqual([1000, 2000, 3000]);
    expect(new Set(list.map((t) => t.name)).size).toBe(3);
  });
  it('sayaç sıfırlanır (deterministik çıktı) ve defineFactory özel şekil kurar', () => {
    nextSeq(); nextSeq(); resetFactorySequence();
    const f = defineFactory<{ n: number }>((s) => ({ n: s }));
    expect(f.build()).toEqual({ n: 1 });
    expect(f.build({ n: 9 })).toEqual({ n: 9 });
  });
  it('kimlik numaraları doğrulayıcıdan GEÇER (sürücü TCKN, firma VKN) — uydurma sayı değil', () => {
    for (const d of driverFactory.buildMany(25)) expect(isValidTCKN(d.tc_no)).toBe(true);
    for (const t of tenantFactory.buildMany(25)) expect(isValidVKN(t.tax_number)).toBe(true);
    expect(isValidTCKN(validTckn())).toBe(true); expect(isValidVKN(validVkn())).toBe(true);
  });
  it('diğer fabrikalar şeması dolu nesne döner (işlem, cihaz, telemetri, kullanıcı)', () => {
    expect(transactionFactory.build()).toMatchObject({ amount_liters: 50, verification_status: 'DOĞRULANDI' });
    expect(hardwareDeviceFactory.build()).toMatchObject({ status: 'AKTİF' });
    expect(telemetryFactory.build().data).toEqual({ levelLiters: 1000 });
    expect(userFactory.build()).toMatchObject({ role: 'COMPANY_OWNER' });
  });
  it('strappingTable doğrusal cetvel üretir ve motorla uyumludur', () => {
    const t = strappingTable(4, 50, 100);
    expect(t).toEqual([{ levelMm: 0, volumeLiters: 0 }, { levelMm: 50, volumeLiters: 100 }, { levelMm: 100, volumeLiters: 200 }, { levelMm: 150, volumeLiters: 300 }]);
    expect(interpolateStrappingVolume(t, 75).observedLiters).toBe(150);
  });
  it('toCamel: snake_case → camelCase, iç içe/dizi; Date ve ilkeller korunur', () => {
    const d = new Date('2026-01-01');
    expect(toCamel({ tank_name: 'a', nested_obj: { current_level_liters: 5 }, list_items: [{ site_name: 'x' }], created_at: d, n: null })).toEqual({ tankName: 'a', nestedObj: { currentLevelLiters: 5 }, listItems: [{ siteName: 'x' }], createdAt: d, n: null });
  });
  it('sabit saat yardımcıları', () => {
    expect(FIXED_NOW.toISOString()).toBe('2026-03-15T09:00:00.000Z');
    expect(istanbul('2026-03-15T12:00').toISOString()).toBe('2026-03-15T09:00:00.000Z');
  });
});
