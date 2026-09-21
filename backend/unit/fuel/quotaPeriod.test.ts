import { describe, it, expect } from 'vitest';
import { periodWindowFor, nextPeriodWindow, computeCarryover } from '../../src/fuel/quotaPeriod';
import { istanbul } from '@test-support/factories';

/** FUEL-402.1: dönemler Europe/Istanbul (sabit UTC+3) gece yarısına göre. 2026-03-15 = Pazar. */
describe('periodWindowFor', () => {
  const at = new Date('2026-03-15T09:00:00.000Z'); // İstanbul 15 Mart 12:00, Pazar

  it('GÜNLÜK: İstanbul gece yarısından ertesi gece yarısına (14 Mart 21:00Z → 15 Mart 21:00Z)', () => {
    const w = periodWindowFor('DAILY', at);
    expect(w.periodStart.toISOString()).toBe('2026-03-14T21:00:00.000Z');
    expect(w.periodEnd.toISOString()).toBe('2026-03-15T21:00:00.000Z');
  });
  it('gün sınırı tam gece yarısında değişir: 21:00:00.000Z yeni gün, 20:59:59.999Z önceki gün', () => {
    expect(periodWindowFor('DAILY', new Date('2026-03-14T21:00:00.000Z')).periodStart.toISOString()).toBe('2026-03-14T21:00:00.000Z');
    expect(periodWindowFor('DAILY', new Date('2026-03-14T20:59:59.999Z')).periodStart.toISOString()).toBe('2026-03-13T21:00:00.000Z');
  });
  it('HAFTALIK: Pazartesi başlar — Pazar 15 Mart bir önceki Pazartesi 9 Mart\'a aittir (8 Mart 21:00Z → 15 Mart 21:00Z)', () => {
    const w = periodWindowFor('WEEKLY', at);
    expect(w.periodStart.toISOString()).toBe('2026-03-08T21:00:00.000Z');
    expect(w.periodEnd.toISOString()).toBe('2026-03-15T21:00:00.000Z');
  });
  it('HAFTALIK: Pazartesi 16 Mart yeni haftanın başıdır (15 Mart 21:00Z → 22 Mart 21:00Z)', () => {
    const w = periodWindowFor('WEEKLY', new Date('2026-03-16T09:00:00.000Z'));
    expect(w.periodStart.toISOString()).toBe('2026-03-15T21:00:00.000Z');
    expect(w.periodEnd.toISOString()).toBe('2026-03-22T21:00:00.000Z');
  });
  it('AYLIK: ayın 1\'i İstanbul gece yarısı (28 Şubat 21:00Z → 31 Mart 21:00Z); yıl sonunda Ocak\'a taşar', () => {
    const w = periodWindowFor('MONTHLY', at);
    expect(w.periodStart.toISOString()).toBe('2026-02-28T21:00:00.000Z');
    expect(w.periodEnd.toISOString()).toBe('2026-03-31T21:00:00.000Z');
    expect(periodWindowFor('MONTHLY', new Date('2026-12-15T09:00:00.000Z')).periodEnd.toISOString()).toBe('2026-12-31T21:00:00.000Z');
  });
  it('AYLIK: UTC\'de hâlâ Mart ama İstanbul\'da Nisan olan an (31 Mart 21:30Z) NİSAN dönemindedir', () => {
    const w = periodWindowFor('MONTHLY', new Date('2026-03-31T21:30:00.000Z'));
    expect(w.periodStart.toISOString()).toBe('2026-03-31T21:00:00.000Z');
    expect(w.periodEnd.toISOString()).toBe('2026-04-30T21:00:00.000Z');
  });
  it('ONE_TIME: verilen aralık aynen döner; validUntil yoksa +100 yıl ("süresiz"); aralık yoksa başlangıç = an', () => {
    const range = { validFrom: new Date('2026-01-01T00:00:00Z'), validUntil: new Date('2026-06-30T00:00:00Z') };
    expect(periodWindowFor('ONE_TIME', at, range)).toEqual({ periodStart: range.validFrom, periodEnd: range.validUntil });
    expect(periodWindowFor('ONE_TIME', at, { validFrom: range.validFrom, validUntil: null }).periodEnd.toISOString()).toBe('2126-01-01T00:00:00.000Z');
    expect(periodWindowFor('ONE_TIME', at)).toMatchObject({ periodStart: at });
  });
  it('istanbul() yardımcısı UTC+3 farkını doğru uygular', () => {
    expect(istanbul('2026-03-15T00:00').toISOString()).toBe('2026-03-14T21:00:00.000Z');
  });
});

describe('nextPeriodWindow', () => {
  it('günlük pencerenin sonrası bir sonraki gündür; aylık şubat→mart geçişi doğru', () => {
    const cur = periodWindowFor('DAILY', new Date('2026-03-15T09:00:00.000Z'));
    const next = nextPeriodWindow('DAILY', cur);
    expect(next.periodStart.toISOString()).toBe('2026-03-15T21:00:00.000Z');
    expect(next.periodEnd.toISOString()).toBe('2026-03-16T21:00:00.000Z');
    const feb = periodWindowFor('MONTHLY', new Date('2026-02-10T09:00:00.000Z'));
    expect(nextPeriodWindow('MONTHLY', feb).periodStart.toISOString()).toBe('2026-02-28T21:00:00.000Z');
    expect(nextPeriodWindow('MONTHLY', feb).periodEnd.toISOString()).toBe('2026-03-31T21:00:00.000Z');
  });
  it('ONE_TIME sıfırlanmaz: aynı pencere döner', () => {
    const w = { periodStart: new Date('2026-01-01T00:00:00Z'), periodEnd: new Date('2026-02-01T00:00:00Z') };
    expect(nextPeriodWindow('ONE_TIME', w)).toBe(w);
  });
});

describe('computeCarryover', () => {
  it('NONE her zaman 0', () => expect(computeCarryover('NONE', 100, 150, 20)).toBe(0));
  it('FULL: kalan = efektif limit − tüketilen (150 − 60 = 90); tüketim limiti aşmışsa 0', () => {
    expect(computeCarryover('FULL', 100, 150, 60)).toBe(90);
    expect(computeCarryover('FULL', 100, 150, 200)).toBe(0);
  });
  it('CAPPED: kalan en fazla taban limit kadar (kalan 200 → 100; kalan 40 → 40)', () => {
    expect(computeCarryover('CAPPED', 100, 300, 100)).toBe(100);
    expect(computeCarryover('CAPPED', 100, 140, 100)).toBe(40);
    expect(computeCarryover('CAPPED', 100, 140, 500)).toBe(0);
  });
  it('2 ondalığa yuvarlar (10.126 → 10.13)', () => expect(computeCarryover('FULL', 0, 10.126, 0)).toBe(10.13));
});
