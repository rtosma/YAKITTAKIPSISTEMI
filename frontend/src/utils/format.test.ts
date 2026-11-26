import { describe, expect, it } from 'vitest';
import { EMPTY, formatCurrency, formatDate, formatDateTime, formatLiters, formatNumber, formatRelative, formatTime } from './format';

/**
 * FE-819 — biçimlendiriciler. Saat dilimi testleri tarayıcının/test sürecinin
 * saat diliminden BAĞIMSIZ olmalı: dönüşüm her zaman Europe/Istanbul'a (UTC+3).
 */
describe('formatNumber / formatLiters / formatCurrency', () => {
  it('binlik ayracı nokta, ondalık virgül; varsayılan en fazla 2 ondalık', () => {
    expect(formatNumber(1234567.891)).toBe('1.234.567,89');
    expect(formatNumber(1500)).toBe('1.500');
    expect(formatNumber(0.5)).toBe('0,5');
  });
  it('sabit ondalık (K-faktörü gibi teknik değerler)', () => {
    expect(formatNumber(1.02345, { digits: 4 })).toBe('1,0235');
    expect(formatNumber(12, { digits: 0 })).toBe('12');
  });
  it('litre her zaman tutarlı ondalıkla ve birimiyle', () => {
    expect(formatLiters(1234.5)).toBe('1.234,50 L');
    expect(formatLiters(20000, 0)).toBe('20.000 L');
  });
  it('para birimi TRY', () => {
    expect(formatCurrency(1234.5)).toBe('₺1.234,50');
  });
  it('sayı olmayan/eksik değerler çökmeden tire döner', () => {
    for (const v of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatNumber(v as number)).toBe(EMPTY);
      expect(formatLiters(v as number)).toBe(EMPTY);
      expect(formatCurrency(v as number)).toBe(EMPTY);
    }
  });
});

describe('tarih/saat — UTC → Europe/Istanbul', () => {
  const lateUtc = '2026-11-23T21:30:05.000Z'; // İstanbul'da ERTESİ gün 00:30:05

  it('gün sınırında doğru güne çevirir (tarayıcı saat diliminden bağımsız)', () => {
    expect(formatDate(lateUtc)).toBe('24.11.2026');
    expect(formatTime(lateUtc)).toBe('00:30');
    expect(formatTime(lateUtc, { seconds: true })).toBe('00:30:05');
  });

  it('tarih-saat metni sabit kalıpta: "gg.aa.yyyy SS:dd(:ss)" — tarih ile saat arasında yalnız bir boşluk', () => {
    const s = formatDateTime(lateUtc, { seconds: true });
    expect(s).toBe('24.11.2026 00:30:05');
    // TransactionsPage Excel sütunları boşluktan böler, OverviewPage saati regex'le okur
    expect(s.split(' ')).toEqual(['24.11.2026', '00:30:05']);
    expect(s.match(/(\d{1,2}):\d{2}/)?.[1]).toBe('00');
    expect(formatDateTime('2026-06-01T09:05:00Z')).toBe('01.06.2026 12:05');
  });

  it('Date nesnesi ve epoch milisaniye de kabul edilir; geçersiz/eksik girdi tire döner', () => {
    expect(formatDate(new Date(lateUtc))).toBe('24.11.2026');
    expect(formatDate(Date.parse(lateUtc))).toBe('24.11.2026');
    for (const v of [null, undefined, '', 'tarih-değil']) {
      expect(formatDate(v)).toBe(EMPTY);
      expect(formatDateTime(v)).toBe(EMPTY);
    }
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  it('Türkçe göreli ifadeler', () => {
    expect(formatRelative(now - 3 * 60_000, now)).toBe('3 dakika önce');
    expect(formatRelative(now - 2 * 3600_000, now)).toBe('2 saat önce');
    expect(formatRelative(now - 24 * 3600_000, now)).toBe('dün');
    expect(formatRelative(now + 2 * 3600_000, now)).toBe('2 saat sonra');
    expect(formatRelative(now, now)).toBe('şimdi');
  });
  it('geçersiz girdi tire döner', () => {
    expect(formatRelative(null, now)).toBe(EMPTY);
  });
});
