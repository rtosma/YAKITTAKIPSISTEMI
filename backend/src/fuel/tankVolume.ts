/**
 * FUEL-403.2 — Tank seviye→hacim matematiği (saf, I/O yok).
 *
 * İki bağımsız hesap:
 *  1) Ham hacim: ya bir daldırma cetveli (strapping table) üzerinde LİNEER
 *     İNTERPOLASYON, ya da silindirik tank için KAPALI FORM formül.
 *  2) Standart hacim: ASTM D1250 hacim düzeltme faktörü (VCF) ile gözlenen
 *     sıcaklıktan 15 °C'ye düzeltme. Sıcaklık yoksa düzeltme YAPILMAZ ve
 *     sonuç "corrected: false" olarak işaretlenir (AC: ölçülmeyen sıcaklık
 *     açıkça işaretlenmeli — ham ölçüm "uncorrected" damgasıyla saklanmalı).
 *
 * Bilinçli sapma: ASTM D1250'nin tam VCF tabloları (binlerce satır, lisanslı)
 * yerine, sektörde standart olan API/ASTM D1250-04 KAPALI FORM yaklaşımı
 * kullanıldı: VCF = exp(-α15·ΔT·(1 + 0.8·α15·ΔT)), α15 = K0/ρ15² + K1/ρ15,
 * ürün grubu sabitleriyle. ±35 °C aralığında ±%0.5 doğruluk hedefinin çok
 * içinde (AC 1).
 */

export interface StrappingPoint {
  levelMm: number;
  volumeLiters: number;
}

export interface CylinderConfig {
  diameterMm: number;
  lengthMm: number;
  orientation: 'HORIZONTAL' | 'VERTICAL';
}

export interface RawVolumeResult {
  observedLiters: number;
  /** Ölçüm cetvelin/tankın kapsadığı aralığın DIŞINDA kaldıysa true (uçlara kırpıldı). */
  outOfRange: boolean;
  method: 'STRAPPING_INTERPOLATION' | 'CYLINDER_FORMULA';
}

// ── Lineer interpolasyon ────────────────────────────────────────────────────

/**
 * Verilen mm seviyesi için cetvel üzerinde lineer interpolasyonla litre.
 * `points` levelMm'e göre KESİN ARTAN sıralı olmalı (setTankStrappingTable
 * bunu doğrular). Aralık dışı seviyeler en yakın uç noktaya KIRPILIR ve
 * `outOfRange: true` döner — bir okumanın son kalibrasyon noktasının biraz
 * üstünde olması tüm hesabı düşürmemeli, ama "tahmin edildi" bilinmeli.
 */
export function interpolateStrappingVolume(points: StrappingPoint[], levelMm: number): RawVolumeResult {
  if (points.length < 2) {
    throw new Error('Strapping cetveli en az 2 nokta içermeli.');
  }
  const first = points[0];
  const last = points[points.length - 1];

  if (levelMm <= first.levelMm) {
    return {
      observedLiters: round3(first.volumeLiters),
      outOfRange: levelMm < first.levelMm,
      method: 'STRAPPING_INTERPOLATION'
    };
  }
  if (levelMm >= last.levelMm) {
    return {
      observedLiters: round3(last.volumeLiters),
      outOfRange: levelMm > last.levelMm,
      method: 'STRAPPING_INTERPOLATION'
    };
  }

  // Bracket'leyen iki noktayı bul (points küçük — düzinelerce/yüzlerce satır —
  // lineer tarama yeterli; gerekirse ikili aramaya çevrilebilir).
  for (let i = 0; i < points.length - 1; i++) {
    const lo = points[i];
    const hi = points[i + 1];
    if (levelMm >= lo.levelMm && levelMm <= hi.levelMm) {
      const ratio = (levelMm - lo.levelMm) / (hi.levelMm - lo.levelMm);
      const volume = lo.volumeLiters + ratio * (hi.volumeLiters - lo.volumeLiters);
      return { observedLiters: round3(volume), outOfRange: false, method: 'STRAPPING_INTERPOLATION' };
    }
  }
  // Sıralı ve aralık içi bir seviye için buraya asla düşülmez.
  throw new Error(`İnterpolasyon için bracket bulunamadı (levelMm=${levelMm}).`);
}

// ── Silindirik tank kapalı form ─────────────────────────────────────────────

/**
 * Silindirik tankta `fillHeightMm` yüksekliğine kadar sıvı hacmi (litre).
 * Yatay: dairesel kesit segment alanı × uzunluk.
 * Dikey: taban alanı × yükseklik.
 */
export function cylinderVolume(cfg: CylinderConfig, fillHeightMm: number): RawVolumeResult {
  const rMm = cfg.diameterMm / 2;
  const h = clamp(fillHeightMm, 0, cfg.orientation === 'HORIZONTAL' ? cfg.diameterMm : cfg.lengthMm);
  const outOfRange = fillHeightMm < 0 || fillHeightMm > (cfg.orientation === 'HORIZONTAL' ? cfg.diameterMm : cfg.lengthMm);

  let volumeMm3: number;
  if (cfg.orientation === 'HORIZONTAL') {
    // Segment alanı A = r²·acos((r-h)/r) - (r-h)·sqrt(2rh - h²)
    const rMinusH = rMm - h;
    const acosArg = clamp(rMinusH / rMm, -1, 1);
    const segArea = rMm * rMm * Math.acos(acosArg) - rMinusH * Math.sqrt(Math.max(0, 2 * rMm * h - h * h));
    volumeMm3 = segArea * cfg.lengthMm;
  } else {
    volumeMm3 = Math.PI * rMm * rMm * h;
  }
  // mm³ → litre (1 L = 1e6 mm³)
  return { observedLiters: round3(volumeMm3 / 1_000_000), outOfRange, method: 'CYLINDER_FORMULA' };
}

// ── ASTM D1250 sıcaklık düzeltmesi ─────────────────────────────────────────

export type PetroleumProductGroup = 'DIESEL' | 'GASOLINE' | 'JET' | 'CRUDE' | 'LUBE';

/** ASTM D1250-04 ürün grubu sabitleri (α15 = K0/ρ15² + K1/ρ15 + K2). */
const PRODUCT_GROUP_CONSTANTS: Record<PetroleumProductGroup, { K0: number; K1: number; K2: number; defaultDensity15: number }> = {
  DIESEL: { K0: 186.9696, K1: 0.4862, K2: 0, defaultDensity15: 840 },
  GASOLINE: { K0: 346.4228, K1: 0.4388, K2: 0, defaultDensity15: 745 },
  JET: { K0: 594.5418, K1: 0, K2: 0, defaultDensity15: 800 },
  CRUDE: { K0: 613.9723, K1: 0, K2: 0, defaultDensity15: 855 },
  LUBE: { K0: 0, K1: 0.6278, K2: 0, defaultDensity15: 875 }
};

const FUEL_TYPE_GROUP: Array<{ match: RegExp; group: PetroleumProductGroup }> = [
  { match: /motorin|diesel|dizel/i, group: 'DIESEL' },
  { match: /benzin|kur[şs]uns?uz|unleaded|gasoline|petrol/i, group: 'GASOLINE' },
  { match: /jet|gaz\s*ya[ğg]|kerosene/i, group: 'JET' },
  { match: /ham\s*petrol|crude/i, group: 'CRUDE' },
  { match: /ya[ğg]|lube|madeni/i, group: 'LUBE' }
];

/** Serbest metin yakıt tipini ASTM ürün grubuna çevirir (eşleşme yoksa DIESEL). */
export function resolveProductGroup(fuelType: string | null | undefined): PetroleumProductGroup {
  if (fuelType) {
    const hit = FUEL_TYPE_GROUP.find((e) => e.match.test(fuelType));
    if (hit) return hit.group;
  }
  return 'DIESEL';
}

export function thermalExpansionCoefficient(group: PetroleumProductGroup, density15?: number): number {
  const c = PRODUCT_GROUP_CONSTANTS[group];
  const rho = density15 && density15 > 0 ? density15 : c.defaultDensity15;
  return c.K0 / (rho * rho) + c.K1 / rho + c.K2;
}

/** ASTM D1250 hacim düzeltme faktörü (gözlenen → 15 °C). */
export function volumeCorrectionFactor(observedTempC: number, group: PetroleumProductGroup, density15?: number): number {
  const alpha = thermalExpansionCoefficient(group, density15);
  const dT = observedTempC - 15;
  return Math.exp(-alpha * dT * (1 + 0.8 * alpha * dT));
}

export interface StandardVolumeResult {
  observedLiters: number;
  standardLiters: number;
  temperatureCorrected: boolean;
  vcf: number;
  observedTempC: number | null;
  productGroup: PetroleumProductGroup;
}

/**
 * Gözlenen (ham) hacmi 15 °C standart hacmine düzeltir. `observedTempC`
 * null/undefined ise (sensör yok/arızalı) DÜZELTME YAPILMAZ: standardLiters =
 * observedLiters, temperatureCorrected: false, vcf: 1 (AC: "uncorrected"
 * damgası).
 */
export function correctToStandardVolume(
  observedLiters: number,
  observedTempC: number | null | undefined,
  fuelType: string | null | undefined,
  density15?: number
): StandardVolumeResult {
  const productGroup = resolveProductGroup(fuelType);
  if (observedTempC === null || observedTempC === undefined || !Number.isFinite(observedTempC)) {
    return {
      observedLiters: round3(observedLiters),
      standardLiters: round3(observedLiters),
      temperatureCorrected: false,
      vcf: 1,
      observedTempC: null,
      productGroup
    };
  }
  const vcf = volumeCorrectionFactor(observedTempC, productGroup, density15);
  return {
    observedLiters: round3(observedLiters),
    standardLiters: round3(observedLiters * vcf),
    temperatureCorrected: true,
    vcf: Number(vcf.toFixed(6)),
    observedTempC,
    productGroup
  };
}

// ── yardımcılar ────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
