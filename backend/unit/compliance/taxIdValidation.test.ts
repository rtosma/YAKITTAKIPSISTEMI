import { describe, it, expect } from 'vitest';
import { isValidVKN, isValidTCKN, validateTaxId } from '../../src/compliance/taxIdValidation';
import { validVkn, validTckn } from '@test-support/factories';

describe('isValidVKN (GİB algoritması)', () => {
  it('algoritmaya uyan VKN\'ler geçer (1234567890; fabrika: 238109283 → geçerli kontrol hanesi)', () => {
    for (const v of ['1234567890', validVkn(238109283)]) expect(isValidVKN(v)).toBe(true);
  });
  it('NOT: tohum firmalarının VKN\'leri (2381092831 vb.) uydurmadır — algoritmadan GEÇMEZ (e-İrsaliye alıcı doğrulaması için gerçek VKN gerekir)', () => {
    for (const v of ['2381092831', '4820193841', '9182301928']) expect(isValidVKN(v)).toBe(false);
  });
  it('biçim toleransı: boşluk/tire/nokta temizlenir', () => expect(isValidVKN('123 456-789.0')).toBe(true));
  it('kontrol hanesi tutmayan, kısa/uzun ve tamamen sıfır VKN geçmez', () => {
    expect(isValidVKN('1234567891')).toBe(false);
    expect(isValidVKN('238109283')).toBe(false);
    expect(isValidVKN('23810928311')).toBe(false);
    expect(isValidVKN('0000000000')).toBe(false);
    expect(isValidVKN('')).toBe(false);
  });
  it('fabrika üretimi VKN\'ler (200 farklı tohum) hep geçerli; son hane bozulunca hep geçersiz', () => {
    for (let i = 0; i < 200; i++) {
      const v = validVkn(100000000 + i * 7919);
      expect(isValidVKN(v)).toBe(true);
      expect(isValidVKN(v.slice(0, 9) + String((Number(v[9]) + 1) % 10))).toBe(false);
    }
  });
});

describe('isValidTCKN', () => {
  it('geçerli TCKN\'ler geçer (10000000146)', () => expect(isValidTCKN('10000000146')).toBe(true));
  it('ilk hane 0, kısa/uzun, 10. veya 11. hane hatalı geçmez', () => {
    expect(isValidTCKN('01234567890')).toBe(false);
    expect(isValidTCKN('1000000014')).toBe(false);
    expect(isValidTCKN('100000001466')).toBe(false);
    expect(isValidTCKN('10000000156')).toBe(false); // 10. hane bozuk
    expect(isValidTCKN('10000000145')).toBe(false); // 11. hane bozuk
    expect(isValidTCKN('12345678901')).toBe(false);
  });
  it('fabrika üretimi TCKN\'ler hep geçerli; 10. hane bozulunca hep geçersiz', () => {
    for (let i = 0; i < 200; i++) {
      const t = validTckn(100000000 + i * 104729);
      expect(isValidTCKN(t)).toBe(true);
      expect(isValidTCKN(t.slice(0, 9) + String((Number(t[9]) + 1) % 10) + t[10])).toBe(false);
    }
  });
});

describe('validateTaxId (uzunluğa göre tür seçer)', () => {
  it('10 hane VKN, 11 hane TCKN; normalize edilmiş rakamlar döner', () => {
    expect(validateTaxId('123 456 7890')).toEqual({ ok: true, kind: 'VKN', normalized: '1234567890' });
    expect(validateTaxId('100.000.001-46')).toEqual({ ok: true, kind: 'TCKN', normalized: '10000000146' });
  });
  it('hatalı VKN/TCKN nedeniyle reddedilir', () => {
    expect(validateTaxId('1234567891')).toMatchObject({ ok: false, kind: 'VKN', reason: expect.stringMatching(/VKN kontrol hanesi/) });
    expect(validateTaxId('10000000145')).toMatchObject({ ok: false, kind: 'TCKN', reason: expect.stringMatching(/TCKN kontrol/) });
  });
  it('boş ve yanlış uzunluk türsüz reddedilir', () => {
    expect(validateTaxId('')).toEqual({ ok: false, kind: null, normalized: '', reason: 'VKN/TCKN boş.' });
    expect(validateTaxId('abc')).toMatchObject({ ok: false, kind: null });
    expect(validateTaxId('123456789')).toMatchObject({ ok: false, kind: null, reason: 'VKN 10, TCKN 11 haneli olmalıdır.' });
    expect(validateTaxId('123456789012')).toMatchObject({ ok: false, kind: null });
  });
});
