import { describe, it, expect } from 'vitest';
import { canViewFullPii, maskTcNo, maskPhone, maskEmail, maskDriverForRole, maskPersonnelForRole, FULL_PII_ROLES } from '../../src/privacy/piiPolicy';
import { driverFactory } from '@test-support/factories';

describe('canViewFullPii (fail-closed)', () => {
  it('yalnızca kaydı düzenleyebilen roller tam görür', () => {
    expect([...FULL_PII_ROLES]).toEqual(['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER']);
    for (const r of FULL_PII_ROLES) expect(canViewFullPii(r)).toBe(true);
  });
  it('diğer HER rol, bilinmeyen rol ve rolsüz görüntüleyici maskeli görür', () => {
    for (const r of ['PUMP_OPERATOR', 'DRIVER', 'ILERIDE_EKLENECEK', '', undefined]) expect(canViewFullPii(r)).toBe(false);
  });
});

describe('maskeleme biçimleri', () => {
  it('TCKN: ilk 3 + 6 yıldız + son 2', () => expect(maskTcNo('10000000146')).toBe('100******46'));
  it('TCKN: 11 hane değilse/boşsa dokunulmaz (null/undefined/kısa)', () => {
    expect(maskTcNo('123')).toBe('123'); expect(maskTcNo(null)).toBeNull(); expect(maskTcNo(undefined)).toBeUndefined(); expect(maskTcNo('')).toBe('');
  });
  it('telefon: son 2 karakter hariç yıldız (biçim karakterleri dahil uzunluk korunur)', () => {
    expect(maskPhone('0532 998 12 34')).toBe('************34');
    expect(maskPhone('ab')).toBe('**'); expect(maskPhone('a')).toBe('*'); expect(maskPhone('')).toBe(''); expect(maskPhone(null)).toBeNull();
  });
  it('e-posta: ilk harf + *** + alan adı; @ yok ya da başta ise ***', () => {
    expect(maskEmail('ahmet@firma.com')).toBe('a***@firma.com');
    expect(maskEmail('@firma.com')).toBe('***'); expect(maskEmail('adres-yok')).toBe('***'); expect(maskEmail('')).toBe(''); expect(maskEmail(undefined)).toBeUndefined();
  });
});

describe('rol bazlı sürücü/personel maskesi', () => {
  const driver = driverFactory.build({ tc_no: '10000000146', phone: '0532 998 12 34' });
  it('tam yetkili rol aynı nesneyi (kopyasız) alır', () => expect(maskDriverForRole(driver, 'COMPANY_OWNER')).toBe(driver));
  it('yetkisiz rol maskeli KOPYA alır; özgün nesne değişmez; diğer alanlar korunur', () => {
    const m = maskDriverForRole(driver, 'PUMP_OPERATOR');
    expect(m).not.toBe(driver);
    expect(m.tc_no).toBe('100******46'); expect(m.phone).toBe('************34');
    expect(m.name).toBe(driver.name);
    expect(driver.tc_no).toBe('10000000146');
  });
  it('rol bilinmiyorsa maskeli (fail-closed)', () => expect(maskDriverForRole(driver, undefined).tc_no).toBe('100******46'));
  it('personel: tcNo maskelenir/tam yetkide aynen', () => {
    const p = { tcNo: '10000000146', fullName: 'Ayşe' };
    expect(maskPersonnelForRole(p, 'DRIVER').tcNo).toBe('100******46');
    expect(maskPersonnelForRole(p, 'SITE_MANAGER')).toBe(p);
  });
});
