import { describe, it, expect, vi, afterEach } from 'vitest';
import { redactSensitiveFields } from '../../src/utils/redaction';
import { generateId } from '../../src/utils/id';
import { AppError, BadRequestError, UnauthorizedError, ForbiddenError, NotFoundError, ConflictError, ServiceUnavailableError, MissingTenantContextException, getZodIssues } from '../../src/utils/errors';

describe('redactSensitiveFields', () => {
  it('pass/secret/token/hash/pepper içeren anahtarlar (büyük/küçük harf duyarsız) maskelenir, iç içe ve dizide de', () => {
    expect(redactSensitiveFields({ user: 'a', Password: 'x', apiSecret: 'y', accessToken: 'z', password_hash: 'h', pepperValue: 'p', nested: { authToken: 't', keep: 1 }, list: [{ secret: 's' }, 5] }))
      .toEqual({ user: 'a', Password: '***MASKED***', apiSecret: '***MASKED***', accessToken: '***MASKED***', password_hash: '***MASKED***', pepperValue: '***MASKED***', nested: { authToken: '***MASKED***', keep: 1 }, list: [{ secret: '***MASKED***' }, 5] });
  });
  it('ilkel değerler ve null olduğu gibi döner', () => {
    expect(redactSensitiveFields('metin')).toBe('metin'); expect(redactSensitiveFields(3)).toBe(3); expect(redactSensitiveFields(null)).toBeNull(); expect(redactSensitiveFields(undefined)).toBeUndefined();
  });
  it('derinlik sınırı (5) aşılınca alt ağaç OLDUĞU GİBİ döner (bilinen sınır — çok derin yapıya sır koymayın)', () => {
    const deep = { a: { b: { c: { d: { e: { f: { password: 'x' } } } } } } };
    const out = redactSensitiveFields(deep) as any;
    expect(out.a.b.c.d.e.f).toEqual({ password: 'x' });
  });
});

describe('generateId', () => {
  afterEach(() => vi.useRealTimers());
  it('biçim: önek-epochMs-8hex', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-03-15T09:00:00.000Z'));
    expect(generateId('tx')).toMatch(/^tx-1773565200000-[0-9a-f]{8}$/);
  });
  it('aynı milisaniyede bile benzersiz (5000 üretimde çakışma yok)', () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    expect(new Set(Array.from({ length: 5000 }, () => generateId('x'))).size).toBe(5000);
  });
});

describe('hata sınıfları', () => {
  it.each([
    [BadRequestError, 400, 'Geçersiz istek', true], [UnauthorizedError, 401, 'Kimlik doğrulaması başarısız', true], [ForbiddenError, 403, 'Bu işlem için yetkiniz bulunmamaktadır', true],
    [NotFoundError, 404, 'Aranan kaynak bulunamadı', true], [ConflictError, 409, 'Çakışma oluştu', true], [ServiceUnavailableError, 503, 'Servis şu anda kullanılamıyor', true],
    [MissingTenantContextException, 500, 'DB işlemi için aktif tenant context bulunamadı.', false]
  ])('%o → HTTP %i, varsayılan mesaj, operasyonel=%s', (Cls, status, msg, operational) => {
    const e = new (Cls as any)();
    expect(e).toBeInstanceOf(AppError); expect(e).toBeInstanceOf(Error); expect(e).toBeInstanceOf(Cls);
    expect(e.statusCode).toBe(status); expect(e.message).toBe(msg); expect(e.isOperational).toBe(operational);
  });
  it('özel mesaj ve detay taşınır; AppError varsayılanı 500/operasyonel', () => {
    const e = new NotFoundError('yok', { error: 'X' });
    expect(e.message).toBe('yok'); expect(e.details).toEqual({ error: 'X' });
    expect(new AppError('m')).toMatchObject({ statusCode: 500, isOperational: true });
    expect(new AppError('m', 418, false, { a: 1 })).toMatchObject({ statusCode: 418, isOperational: false, details: { a: 1 } });
  });
  it('getZodIssues issues → errors → [] sırasıyla okur', () => {
    expect(getZodIssues({ issues: [1] })).toEqual([1]); expect(getZodIssues({ errors: [2] })).toEqual([2]); expect(getZodIssues({})).toEqual([]); expect(getZodIssues(null)).toEqual([]);
  });
});
