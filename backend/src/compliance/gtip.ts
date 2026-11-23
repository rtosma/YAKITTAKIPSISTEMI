/**
 * Yakıt tipi → GTIP eşlemesi (saf, I/O yok). Önceden despatchAdviceXmlService.ts içindeydi; native XML kütüphanesine bağımlı olmadan
 * birim test edilebilsin ve fuel/fuelTypes.ts hafif kalsın diye ayrıldı (TEST-1006).
 */

// COMP-601.1 AC: "GTIP kodu yakıt tipine göre değişir ve sabit kodlanmamalı."
// tanks.fuel_type serbest metindir ("Motorin (Euro Diesel)", "Kurşunsuz 95",
// "LPG (Otogaz)"...) — anahtar kelime eşleşmesiyle Türkiye Gümrük Tarife
// Cetveli (GTIP) koduna çeviriyoruz. Eşleşme yoksa motorin varsayılanına
// düşülür (platformun baskın yakıt tipi).
const FUEL_TYPE_GTIP: Array<{ match: RegExp; gtip: string; label: string }> = [
  { match: /motorin|diesel|dizel/i, gtip: '2710194300', label: 'Motorin (kükürt ≤ 10 ppm)' },
  { match: /kur[şs]uns?uz\s*9[5]|benzin\s*9[5]|unleaded\s*9[5]/i, gtip: '2710124500', label: 'Kurşunsuz benzin 95 oktan' },
  { match: /kur[şs]uns?uz\s*98|benzin\s*98|unleaded\s*98/i, gtip: '2710124900', label: 'Kurşunsuz benzin 98 oktan' },
  { match: /lpg|otogaz|otogas/i, gtip: '2711129700', label: 'LPG (otogaz)' },
  { match: /gaz\s*ya[ğg]|kerosene|jet\s*a1?/i, gtip: '2710192100', label: 'Gazyağı / jet yakıtı' },
  { match: /fuel[\s-]*oil|kalorifer/i, gtip: '2710196400', label: 'Fuel oil / kalorifer yakıtı' },
  { match: /adblue|üre\s*çöz|urea/i, gtip: '3808940000', label: 'AdBlue (üre çözeltisi)' }
];
const DEFAULT_GTIP = { gtip: '2710194300', label: 'Motorin (varsayılan)' };

export function resolveGtip(fuelType: string | null | undefined): { gtip: string; label: string } {
  if (fuelType) {
    const hit = FUEL_TYPE_GTIP.find((e) => e.match.test(fuelType));
    if (hit) return { gtip: hit.gtip, label: hit.label };
  }
  return DEFAULT_GTIP;
}
