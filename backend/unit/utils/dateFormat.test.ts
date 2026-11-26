import { describe, expect, it } from 'vitest';
import { formatIstanbulDate, formatIstanbulDateTime } from '../../src/utils/dateFormat';

/** FE-819 (backend): rapor çıktıları UTC süreçte de İstanbul saatini basar (vitest.config TZ=UTC). */
describe('formatIstanbulDateTime / formatIstanbulDate', () => {
  it('UTC zaman damgasını İstanbul saatine çevirir (eskiden 3 saat geride basılıyordu)', () => {
    expect(formatIstanbulDateTime('2026-11-23T11:05:07Z')).toBe('23.11.2026 14:05:07');
    expect(formatIstanbulDateTime(new Date('2026-06-01T00:00:00Z'))).toBe('01.06.2026 03:00:00');
  });
  it('gün sınırında doğru güne geçer', () => {
    expect(formatIstanbulDateTime('2026-11-23T21:30:00Z')).toBe('24.11.2026 00:30:00');
    expect(formatIstanbulDate('2026-11-23T21:30:00Z')).toBe('24.11.2026');
  });
  it('epoch ms kabul eder; boş/geçersiz değer raporlardaki gibi "-"', () => {
    expect(formatIstanbulDate(Date.parse('2026-11-23T08:00:00Z'))).toBe('23.11.2026');
    for (const v of [null, undefined, '', 'tarih-değil']) {
      expect(formatIstanbulDateTime(v)).toBe('-');
      expect(formatIstanbulDate(v)).toBe('-');
    }
  });
});
