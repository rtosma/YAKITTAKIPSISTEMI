/**
 * COMP-605 — Türkiye VKN (10 hane) ve TCKN (11 hane) algoritmik doğrulaması.
 * Saf, I/O yok. AC: "Geçersiz VKN/TCKN belge üretimini engellemelidir."
 */

export type TaxIdKind = 'VKN' | 'TCKN';

export interface TaxIdValidationResult {
  ok: boolean;
  kind: TaxIdKind | null;
  normalized: string;
  reason?: string;
}

/** Rakam dışı her şeyi atar. */
function digitsOnly(raw: string): string {
  return (raw || '').replace(/\D/g, '');
}

/**
 * VKN (Vergi Kimlik Numarası) — GİB algoritması.
 * İlk 9 hane veri, 10. hane kontrol hanesidir.
 */
export function isValidVKN(raw: string): boolean {
  const s = digitsOnly(raw);
  if (s.length !== 10) return false;
  if (/^0{10}$/.test(s)) return false;
  const d = s.split('').map(Number);
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const c1 = (d[i] + (9 - i)) % 10;
    let c2 = (c1 * 2 ** (9 - i)) % 9;
    if (c1 !== 0 && c2 === 0) c2 = 9;
    sum += c2;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === d[9];
}

/**
 * TCKN (T.C. Kimlik Numarası) — 11 hane, 10. ve 11. haneler kontrol.
 *  d10 = ((d1+d3+d5+d7+d9)*7 - (d2+d4+d6+d8)) mod 10
 *  d11 = (d1+..+d10) mod 10
 *  d1 != 0
 */
export function isValidTCKN(raw: string): boolean {
  const s = digitsOnly(raw);
  if (s.length !== 11) return false;
  const d = s.split('').map(Number);
  if (d[0] === 0) return false;
  const oddSum = d[0] + d[2] + d[4] + d[6] + d[8];
  const evenSum = d[1] + d[3] + d[5] + d[7];
  const d10 = ((oddSum * 7) - evenSum) % 10;
  if (((d10 % 10) + 10) % 10 !== d[9]) return false;
  let total = 0;
  for (let i = 0; i < 10; i++) total += d[i];
  return total % 10 === d[10];
}

export function validateTaxId(raw: string): TaxIdValidationResult {
  const s = digitsOnly(raw);
  if (s.length === 0) return { ok: false, kind: null, normalized: s, reason: 'VKN/TCKN boş.' };
  if (s.length === 10) {
    return isValidVKN(s)
      ? { ok: true, kind: 'VKN', normalized: s }
      : { ok: false, kind: 'VKN', normalized: s, reason: 'VKN kontrol hanesi tutmuyor (geçersiz Vergi Kimlik Numarası).' };
  }
  if (s.length === 11) {
    return isValidTCKN(s)
      ? { ok: true, kind: 'TCKN', normalized: s }
      : { ok: false, kind: 'TCKN', normalized: s, reason: 'TCKN kontrol haneleri tutmuyor (geçersiz T.C. Kimlik Numarası).' };
  }
  return { ok: false, kind: null, normalized: s, reason: 'VKN 10, TCKN 11 haneli olmalıdır.' };
}
