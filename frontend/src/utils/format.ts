/**
 * FE-819 — sayı/para/tarih biçimlendirmenin TEK merkezi.
 *
 * Kurallar (ticket):
 *  - Sayılar Türkçe: binlik ayracı nokta, ondalık virgül (1.234,56).
 *  - Litre değerleri tutarlı ondalıkla (varsayılan 2 basamak).
 *  - Para: Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }) → ₺1.234,56.
 *  - Backend UTC gönderir; arayüz HER ZAMAN Europe/Istanbul'a çevirir — kullanıcının
 *    tarayıcısı başka bir saat dilimindeyse bile (önceden `toLocaleString('tr-TR')`
 *    tarayıcının saat dilimini kullanıyordu). Dönüşüm yalnızca burada yapılır.
 *
 * Tarih-saat metni deterministik olarak parçalardan kurulur: `gg.aa.yyyy SS:dd(:ss)`.
 * Bazı motorlar tr-TR'de tarih ile saat arasına virgül koyar; mevcut kod bu metni
 * boşluktan bölüp (TransactionsPage Excel sütunları) saatini regex'le okuyor
 * (OverviewPage saatlik grafik) — biçim sabit kalmalı.
 */

export const APP_TIME_ZONE = 'Europe/Istanbul';
export const EMPTY = '—';

type DateInput = string | number | Date | null | undefined;

function toDate(v: DateInput): Date | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

const numberFormatters = new Map<string, Intl.NumberFormat>();
function numberFormatter(min: number, max: number): Intl.NumberFormat {
  const key = `${min}:${max}`;
  let f = numberFormatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: min, maximumFractionDigits: max });
    numberFormatters.set(key, f);
  }
  return f;
}

/**
 * Sayı: varsayılan en fazla 2 ondalık (gereksiz sıfır yok). Sabit ondalık için
 * `{ digits }` verin (ör. K-faktörü 4 basamak).
 */
export function formatNumber(v: number | null | undefined, opts: { digits?: number; maxDigits?: number } = {}): string {
  if (!isFiniteNumber(v)) return EMPTY;
  if (opts.digits !== undefined) return numberFormatter(opts.digits, opts.digits).format(v);
  return numberFormatter(0, opts.maxDigits ?? 2).format(v);
}

/** Litre: sabit ondalık (varsayılan 2) + " L". Tank kapasitesi gibi tam sayılar için digits: 0. */
export function formatLiters(v: number | null | undefined, digits = 2): string {
  if (!isFiniteNumber(v)) return EMPTY;
  return `${numberFormatter(digits, digits).format(v)} L`;
}

const currencyFormatter = new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' });
/** Para (TL): ₺1.234,56 */
export function formatCurrency(v: number | null | undefined): string {
  if (!isFiniteNumber(v)) return EMPTY;
  return currencyFormatter.format(v);
}

const partsFormatter = new Intl.DateTimeFormat('tr-TR', {
  timeZone: APP_TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23'
});

function istanbulParts(d: Date): Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', string> {
  const out: Record<string, string> = {};
  for (const p of partsFormatter.formatToParts(d)) if (p.type !== 'literal') out[p.type] = p.value;
  return out as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', string>;
}

/** İstanbul saatiyle `gg.aa.yyyy`. */
export function formatDate(v: DateInput): string {
  const d = toDate(v);
  if (!d) return EMPTY;
  const p = istanbulParts(d);
  return `${p.day}.${p.month}.${p.year}`;
}

/** İstanbul saatiyle `SS:dd` (seconds: true → `SS:dd:ss`). */
export function formatTime(v: DateInput, opts: { seconds?: boolean } = {}): string {
  const d = toDate(v);
  if (!d) return EMPTY;
  const p = istanbulParts(d);
  return opts.seconds ? `${p.hour}:${p.minute}:${p.second}` : `${p.hour}:${p.minute}`;
}

/** İstanbul saatiyle `gg.aa.yyyy SS:dd` (seconds: true → `… SS:dd:ss`). */
export function formatDateTime(v: DateInput, opts: { seconds?: boolean } = {}): string {
  const d = toDate(v);
  if (!d) return EMPTY;
  return `${formatDate(d)} ${formatTime(d, opts)}`;
}

const relativeFormatter = new Intl.RelativeTimeFormat('tr', { numeric: 'auto' });
const RELATIVE_STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['second', 60], ['minute', 60], ['hour', 24], ['day', 30], ['month', 12], ['year', Number.POSITIVE_INFINITY]
];
/** Göreli zaman: "3 dakika önce", "dün", "2 saat sonra". */
export function formatRelative(v: DateInput, now: DateInput = Date.now()): string {
  const d = toDate(v);
  const n = toDate(now);
  if (!d || !n) return EMPTY;
  let delta = (d.getTime() - n.getTime()) / 1000;
  for (const [unit, size] of RELATIVE_STEPS) {
    if (Math.abs(delta) < size) return relativeFormatter.format(Math.round(delta), unit);
    delta /= size;
  }
  return formatDate(d);
}
