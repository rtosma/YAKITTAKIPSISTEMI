/**
 * FE-819 (backend tarafı) — rapor/PDF/CSV/Excel çıktılarındaki tarih-saatler.
 *
 * Süreç bilinçli olarak UTC'de çalışır (config/env.ts). Önceden raporlar
 * `new Date(v).toLocaleString('tr-TR')` kullanıyordu: saat dilimi verilmediği
 * için süreç saatiyle (UTC) basılıyor, kullanıcı İstanbul saatinin 3 saat
 * GERİSİNİ görüyordu (14:05'teki ikmal raporda 11:05). Çıktılar her zaman
 * Europe/Istanbul'a çevrilir; metin deterministik olarak parçalardan kurulur
 * (frontend utils/format.ts ile aynı kalıp: `gg.aa.yyyy SS:dd:ss`).
 */
export const REPORT_TIME_ZONE = 'Europe/Istanbul';

const parts = new Intl.DateTimeFormat('tr-TR', {
  timeZone: REPORT_TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23'
});

function toDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v as string | number);
  return Number.isNaN(d.getTime()) ? null : d;
}

function istanbulParts(d: Date): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of parts.formatToParts(d)) if (p.type !== 'literal') out[p.type] = p.value;
  return out;
}

/** İstanbul saatiyle `gg.aa.yyyy SS:dd:ss`; boş/geçersiz → `-` (raporlardaki mevcut gösterim). */
export function formatIstanbulDateTime(v: unknown): string {
  const d = toDate(v);
  if (!d) return '-';
  const p = istanbulParts(d);
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

/** İstanbul saatiyle `gg.aa.yyyy`; boş/geçersiz → `-`. */
export function formatIstanbulDate(v: unknown): string {
  const d = toDate(v);
  if (!d) return '-';
  const p = istanbulParts(d);
  return `${p.day}.${p.month}.${p.year}`;
}
