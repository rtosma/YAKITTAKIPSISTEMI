import { resolveGtip } from '../compliance/despatchAdviceXmlService';

/**
 * FUEL-407 — serbest metin yakıt tipini normalize eden yardımcı. Şantiyelerde
 * tank/pompa/araç yakıt tipi (Motorin, Benzin, AdBlue) serbest metin
 * giriliyor; ikmal öncesi araç-tank uyumu ve yakıt tipi bazlı stok/rapor için
 * kararlı bir gruba indirgemek gerekir.
 *
 * Kritik Not: "Benzinli araca motorin verilmesi ciddi maddi hasardır" →
 * araç kartındaki yakıt tipi ikmal yetkilendirmesinde denetlenir. "AdBlue
 * yakıt değildir ama aynı altyapıyla takip edilir" → isFuel=false.
 */

export type FuelGroup = 'MOTORIN' | 'BENZIN' | 'ADBLUE' | 'LPG' | 'DIGER';

export interface FuelTypeInfo {
  group: FuelGroup;
  /** AdBlue gibi kalemler yakıt DEĞİLDİR (e-İrsaliye/GTIP tarafı farklı). */
  isFuel: boolean;
  gtip: string;
  label: string;
  /** 15 °C referans yoğunluk (kg/m³) — sıcaklık düzeltmesi/hacim için. */
  defaultDensity15: number;
}

const GROUP_RULES: Array<{ match: RegExp; group: FuelGroup; isFuel: boolean; density: number }> = [
  { match: /adblue|üre\s*çöz|urea|def\b/i, group: 'ADBLUE', isFuel: false, density: 1090 },
  { match: /motorin|diesel|dizel|euro\s*diesel|eurodiesel/i, group: 'MOTORIN', isFuel: true, density: 840 },
  { match: /benzin|kur[şs]uns?uz|unleaded|gasoline|petrol|95|97/i, group: 'BENZIN', isFuel: true, density: 745 },
  { match: /lpg|otogaz|autogas/i, group: 'LPG', isFuel: true, density: 540 }
];

export function resolveFuelType(raw: string | null | undefined): FuelTypeInfo {
  const text = (raw ?? '').trim();
  const hit = GROUP_RULES.find((r) => r.match.test(text));
  const g = resolveGtip(text);
  if (hit) {
    return { group: hit.group, isFuel: hit.isFuel, gtip: g.gtip, label: g.label, defaultDensity15: hit.density };
  }
  return { group: 'DIGER', isFuel: true, gtip: g.gtip, label: g.label, defaultDensity15: 840 };
}

/**
 * Araç yakıt tipi ile tank yakıt tipi uyumlu mu?
 *  - Araç yakıt tipi tanımsız (NULL) → kısıt yok (geriye uyumluluk).
 *  - Aynı grup → uyumlu.
 *  - 'DIGER' grubu (tanınmayan) → çift taraflı serbest bırakılır (yanlış
 *    pozitif reddi engellemek için); yalnızca İKİ TARAF DA tanınıp
 *    FARKLIYSA reddedilir.
 */
export function areFuelTypesCompatible(vehicleFuelType: string | null | undefined, tankFuelType: string | null | undefined): boolean {
  if (!vehicleFuelType || !vehicleFuelType.trim()) return true;
  const v = resolveFuelType(vehicleFuelType).group;
  const t = resolveFuelType(tankFuelType).group;
  if (v === 'DIGER' || t === 'DIGER') return true;
  return v === t;
}
