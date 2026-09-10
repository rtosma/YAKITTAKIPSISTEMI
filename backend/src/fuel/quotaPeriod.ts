/**
 * FUEL-402.1 — kota dönem sınırları + devir (carryover) matematiği. Saf,
 * I/O yok.
 *
 * Kritik Not: "Dönem sıfırlamaları tenant saat dilimini (Europe/Istanbul)
 * dikkate almalı." Türkiye 2016'dan beri kalıcı UTC+3 (yaz saati yok), bu
 * yüzden sabit +03:00 offset kullanılıyor — Intl/TZ veritabanı bağımlılığı
 * gereksiz. GÜNLÜK dönem = İstanbul gece yarısı; HAFTALIK = Pazartesi gece
 * yarısı; AYLIK = ayın 1'i gece yarısı (hepsi İstanbul yerel saatiyle).
 */

export type QuotaPeriodType = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'ONE_TIME';
export type CarryoverPolicy = 'NONE' | 'FULL' | 'CAPPED';

const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC+3, sabit

/** Bir UTC anını İstanbul yerel "duvar saati" bileşenlerine çevirir. */
function toIstanbulParts(d: Date): { y: number; m: number; day: number; weekday: number } {
  const local = new Date(d.getTime() + ISTANBUL_OFFSET_MS);
  return {
    y: local.getUTCFullYear(),
    m: local.getUTCMonth(),
    day: local.getUTCDate(),
    // 0 = Pazar ... 1 = Pazartesi
    weekday: local.getUTCDay()
  };
}

/** İstanbul yerel (y, m, day, 00:00) → UTC Date. */
function istanbulMidnightUtc(y: number, m: number, day: number): Date {
  return new Date(Date.UTC(y, m, day, 0, 0, 0) - ISTANBUL_OFFSET_MS);
}

export interface PeriodWindow {
  periodStart: Date;
  periodEnd: Date;
}

/**
 * `at` anını İÇEREN dönem penceresini döndürür. ONE_TIME için pencere
 * [validFrom, validUntil] aralığıdır (validUntil yoksa +100 yıl — pratikte
 * "süresiz").
 */
export function periodWindowFor(
  periodType: QuotaPeriodType,
  at: Date,
  oneTimeRange?: { validFrom: Date; validUntil?: Date | null }
): PeriodWindow {
  if (periodType === 'ONE_TIME') {
    const start = oneTimeRange?.validFrom ?? at;
    const end = oneTimeRange?.validUntil ?? new Date(Date.UTC(at.getUTCFullYear() + 100, 0, 1));
    return { periodStart: start, periodEnd: end };
  }

  const { y, m, day, weekday } = toIstanbulParts(at);

  if (periodType === 'DAILY') {
    const periodStart = istanbulMidnightUtc(y, m, day);
    const periodEnd = istanbulMidnightUtc(y, m, day + 1);
    return { periodStart, periodEnd };
  }

  if (periodType === 'WEEKLY') {
    // Pazartesi'ye geri git (weekday 1). Pazar (0) ise 6 gün geri.
    const daysSinceMonday = (weekday + 6) % 7;
    const periodStart = istanbulMidnightUtc(y, m, day - daysSinceMonday);
    const periodEnd = istanbulMidnightUtc(y, m, day - daysSinceMonday + 7);
    return { periodStart, periodEnd };
  }

  // MONTHLY
  const periodStart = istanbulMidnightUtc(y, m, 1);
  const periodEnd = istanbulMidnightUtc(y, m + 1, 1);
  return { periodStart, periodEnd };
}

/** Verilen pencereden BİR SONRAKİ dönem penceresi. */
export function nextPeriodWindow(periodType: QuotaPeriodType, current: PeriodWindow): PeriodWindow {
  if (periodType === 'ONE_TIME') return current; // tek seferlik — sıfırlanmaz
  // Bir sonraki pencere, mevcut pencerenin bitişini İÇEREN penceredir.
  return periodWindowFor(periodType, new Date(current.periodEnd.getTime() + 1));
}

/**
 * Dönem sonunda bir sonraki döneme devredilecek litre.
 *   NONE   → 0 (devir yok)
 *   FULL   → kalan (efektif limit − tüketilen), negatif olamaz
 *   CAPPED → kalan ama en fazla base limit kadar
 */
export function computeCarryover(
  policy: CarryoverPolicy,
  baseLimitLiters: number,
  effectiveLimitLiters: number,
  consumedLiters: number
): number {
  if (policy === 'NONE') return 0;
  const remaining = Math.max(0, effectiveLimitLiters - consumedLiters);
  if (policy === 'FULL') return round2(remaining);
  // CAPPED
  return round2(Math.min(baseLimitLiters, remaining));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
