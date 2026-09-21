import { describe, it, expect } from 'vitest';
import { isValidTcNo, pseudonym, scrubString, scrubValue, scrubLogArgs } from '../../src/privacy/piiScrub';
import { validTckn } from '@test-support/factories';

// Sahte JWT: parçalar birleştirilerek kurulur (gerçek bir sır değildir; gitleaks kuralına takılmasın diye literal tek parça yazılmaz).
const FAKE_JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ0ZXN0LXVzZXIifQ', 'c2ln-fake-signature'].join('.'); // gitleaks:allow

describe('isValidTcNo', () => {
  it('geçerli TCKN geçer; sağlama tutmayan/ilk hane 0/yanlış uzunluk geçmez', () => {
    expect(isValidTcNo('10000000146')).toBe(true);
    expect(isValidTcNo('12345678901')).toBe(false);
    expect(isValidTcNo('01234567890')).toBe(false);
    expect(isValidTcNo('1000000014')).toBe(false);
    expect(isValidTcNo('1000000014a')).toBe(false);
  });
});

describe('pseudonym', () => {
  it('deterministik: sha256(değer)[0..8] — aynı ad aynı takma ad ("ahmet" → pii:2f77bb1b), farklı ad farklı', () => {
    expect(pseudonym('ahmet')).toBe('pii:2f77bb1b');
    expect(pseudonym('ahmet')).toBe(pseudonym('ahmet'));
    expect(pseudonym('mehmet')).not.toBe(pseudonym('ahmet'));
  });
});

describe('scrubString', () => {
  it('7 karakterden kısa metin değişmeden döner (hızlı yol); 7 karakter ve üstü taranır', () => {
    expect(scrubString('a@b.cc')).toBe('a@b.cc');
    expect(scrubString('a@bb.cc')).toBe('[EMAIL]');
  });
  it('JWT, Bearer belirteci ve e-posta maskelenir', () => {
    expect(scrubString(`token ${FAKE_JWT} bitti`)).toBe('token [JWT] bitti');
    expect(scrubString('Authorization: Bearer abcDEF1234567890xyz')).toBe('Authorization: Bearer [TOKEN]');
    expect(scrubString('mail: ahmet.yilmaz@firma.com.tr gönderildi')).toBe('mail: [EMAIL] gönderildi');
  });
  it('TCKN yalnızca sağlaması TUTUYORSA maskelenir (rastgele 11 haneli sayı — örn. sipariş no — korunur)', () => {
    expect(scrubString('kimlik 10000000146 kayıtlı')).toBe('kimlik [TCKN] kayıtlı');
    expect(scrubString('sipariş 12345678901 kayıtlı')).toBe('sipariş 12345678901 kayıtlı');
    expect(scrubString(`tc ${validTckn(345678901)}`)).toBe('tc [TCKN]');
  });
  it('Türk cep telefonu biçimleri maskelenir', () => {
    for (const p of ['0532 998 12 34', '05329981234', '+90 532 998 12 34', '0 (532) 998-12-34']) expect(scrubString(`ara ${p} şimdi`)).toBe('ara [TEL] şimdi');
  });
  it('telefona benzemeyen sayılar korunur (rakam öbeğinin içinden eşleşme yok)', () => expect(scrubString('litre 5329981234567 toplam')).toBe('litre 5329981234567 toplam'));
});

describe('scrubValue', () => {
  it('PII anahtarları [PII] olur (büyük/küçük harf duyarsız), takma-ad anahtarları pseudonym olur, diğerleri dizge taranır', () => {
    const out = scrubValue({ tc_no: '10000000146', Phone: '0532 998 12 34', password: 'x', username: 'ahmet', driverName: 'ahmet', note: 'ara 0532 998 12 34', ok: 5 }) as Record<string, unknown>;
    expect(out).toEqual({ tc_no: '[PII]', Phone: '[PII]', password: '[PII]', username: 'pii:2f77bb1b', driverName: 'pii:2f77bb1b', note: 'ara [TEL]', ok: 5 });
  });
  it('iç içe nesne ve dizi dolaşılır; null/undefined/sayı korunur', () => {
    expect(scrubValue({ a: [{ email: 'x@y.zz' }, 'mail a@b.cc ok'], b: null, c: undefined, d: 0 })).toEqual({ a: [{ email: '[PII]' }, 'mail [EMAIL] ok'], b: null, c: undefined, d: 0 });
  });
  it('Date ve Buffer aynen korunur', () => {
    const d = new Date('2026-01-01'); const b = Buffer.from('x');
    const out = scrubValue({ d, b }) as { d: Date; b: Buffer };
    expect(out.d).toBe(d); expect(out.b).toBe(b);
  });
  it('döngüsel referans [Circular], derinlik ≥ 6 [Truncated]', () => {
    const o: Record<string, unknown> = { name: 'x' }; o.self = o;
    expect((scrubValue(o) as Record<string, unknown>).self).toBe('[Circular]');
    const deep = { l1: { l2: { l3: { l4: { l5: { l6: { l7: 1 } } } } } } };
    expect(JSON.stringify(scrubValue(deep))).toContain('[Truncated]');
  });
  it('Error: mesaj ve stack maskelenir, ek alanlar anahtarına göre işlenir, prototip korunur', () => {
    class MyErr extends Error { constructor(m: string, public token = 'gizli', public code = 'E1') { super(m); } }
    const out = scrubValue(new MyErr('kullanıcı a@b.cc hata')) as MyErr;
    expect(out).toBeInstanceOf(MyErr);
    expect(out.message).toBe('kullanıcı [EMAIL] hata');
    expect(out.token).toBe('[PII]');
    expect(out.code).toBe('E1');
    expect(out.stack ?? '').not.toContain('a@b.cc');
  });
  it('scrubLogArgs her argümanı ayrı ayrı temizler', () => {
    expect(scrubLogArgs(['giriş a@b.cc', { token: 't' }, 7])).toEqual(['giriş [EMAIL]', { token: '[PII]' }, 7]);
  });
});
