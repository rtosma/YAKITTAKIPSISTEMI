import { PoolClient } from 'pg';

/**
 * INV-1503 (#153) — Birim fiyat geçmişi ve dönemsel maliyet hesabı.
 *
 * Fiyat GEÇMİŞİ zaten `fuel_intake_receipts.unit_price` (FUEL-408, append-
 * only) üzerinden vardı — eksik olan, o geçmişten bir DİSPENSE ANI için tek
 * bir "birim maliyet" türetip transactions satırına DONDURMAKTI (AC: "her
 * ikmal kaydı kendi anındaki birim maliyeti taşımalıdır... sonradan fiyat
 * değişince geçmiş maliyetler değişmemelidir"). Bu servis SADECE o türetmeyi
 * yapar; DB'ye hiçbir şey YAZMAZ — çağıran (tenantDb.ts'teki createTransaction/
 * finalizeDispenseSession/syncSingleOfflineRecord) sonucu KENDİ INSERT'ine
 * gömer.
 *
 * `atDate`, "şu an" DEĞİL, ikmalin GERÇEKTEN gerçekleştiği zamandır — IOT-303.2
 * (çevrimdışı toplu senkronizasyon) AC'sinin "geriye dönük kayıtlar doğru
 * tarihteki fiyatla maliyetlendirilmelidir" gereksinimi tam olarak budur:
 * o tarihten SONRAKİ bir dolum/fiyat, o tarihteki bir dispense'i asla
 * etkilememelidir.
 */

export type FuelCostMethod = 'AGIRLIKLI_ORTALAMA' | 'FIFO';

export interface FuelCostResult {
  unitCostLiters: number;
  totalCost: number;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/**
 * Ağırlıklı ortalama (varsayılan yöntem) — `atDate`'e kadarki (dahil) TÜM
 * fiyatlı dolumların declared_liters_15c ile ağırlıklandırılmış ortalaması.
 * Hiç fiyatlı dolum yoksa `null` döner (maliyetlendirilemez — sessizce 0
 * SAYILMAZ, AC'nin "maliyet bilinmiyor" ayrımı raporlarda önemli).
 */
async function computeWeightedAverageCost(
  client: PoolClient,
  tankId: string,
  litersDispensed: number,
  atDate: Date
): Promise<FuelCostResult | null> {
  const res = await client.query(
    `SELECT COALESCE(SUM(declared_liters_15c * unit_price), 0)::numeric AS weighted_sum,
            COALESCE(SUM(declared_liters_15c), 0)::numeric AS total_liters
       FROM fuel_intake_receipts
      WHERE tank_id = $1 AND delivery_date <= $2::date AND unit_price IS NOT NULL`,
    [tankId, atDate.toISOString().slice(0, 10)]
  );
  const totalLiters = Number(res.rows[0].total_liters);
  if (totalLiters <= 0) return null;
  const unitCostLiters = round4(Number(res.rows[0].weighted_sum) / totalLiters);
  return { unitCostLiters, totalCost: round2(unitCostLiters * litersDispensed) };
}

/**
 * FIFO — bu dispense'in kapsadığı kümülatif hacim aralığını ([öncekiToplam,
 * öncekiToplam+bu]) dolum LOT'larının (delivery_date sırasına göre kümülatif
 * aralıkları) ile kesiştirir; her lot'un ÇAKIŞAN kısmı kendi fiyatıyla
 * ağırlıklandırılır. Klasik FIFO envanter maliyetlendirmesinin SQL pencere
 * fonksiyonlarıyla ifadesi. Eşleşen lot toplamı bu dispense'in miktarından
 * AZSA (geçmiş tarihte yetersiz dolum kaydı — örn. veri geçmişi bu tarihten
 * sonra başlıyor), maliyet EŞLEŞEN kısım üzerinden normalize edilir (ağırlıklı
 * ortalamanın SUM/SUM deseniyle aynı ruh) — hiç eşleşme yoksa `null`.
 */
async function computeFifoCost(
  client: PoolClient,
  tankId: string,
  litersDispensed: number,
  atDate: Date,
  cumulativeDispensedBefore: number
): Promise<FuelCostResult | null> {
  const cumulativeAfter = cumulativeDispensedBefore + litersDispensed;
  const res = await client.query(
    `WITH lots AS (
       SELECT unit_price, declared_liters_15c,
              SUM(declared_liters_15c) OVER (ORDER BY delivery_date, id) AS cum_after,
              SUM(declared_liters_15c) OVER (ORDER BY delivery_date, id) - declared_liters_15c AS cum_before
         FROM fuel_intake_receipts
        WHERE tank_id = $1 AND delivery_date <= $2::date AND unit_price IS NOT NULL
     )
     SELECT
       COALESCE(SUM(GREATEST(0, LEAST(cum_after, $4) - GREATEST(cum_before, $3)) * unit_price), 0)::numeric AS weighted_sum,
       COALESCE(SUM(GREATEST(0, LEAST(cum_after, $4) - GREATEST(cum_before, $3))), 0)::numeric AS matched_liters
     FROM lots`,
    [tankId, atDate.toISOString().slice(0, 10), cumulativeDispensedBefore, cumulativeAfter]
  );
  const matchedLiters = Number(res.rows[0].matched_liters);
  if (matchedLiters <= 0) return null;
  const unitCostLiters = round4(Number(res.rows[0].weighted_sum) / matchedLiters);
  return { unitCostLiters, totalCost: round2(unitCostLiters * litersDispensed) };
}

/**
 * Tek giriş noktası — çağıran tenant'ın `fuel_cost_method`'unu (companies
 * tablosu) okuyup uygun hesaba yönlendirir. FIFO için gereken "bu dispense'ten
 * ÖNCEKİ kümülatif tüketim" burada, tankın `transactions` geçmişinden
 * hesaplanır (aynı tank_name+site_name deseni — transactions'ta tank_id yok).
 */
export async function computeFuelCost(
  client: PoolClient,
  method: FuelCostMethod,
  tankId: string,
  tankName: string,
  siteName: string,
  litersDispensed: number,
  atDate: Date
): Promise<FuelCostResult | null> {
  if (litersDispensed <= 0) return null;

  if (method === 'FIFO') {
    const priorRes = await client.query(
      `SELECT COALESCE(SUM(amount_liters), 0)::numeric AS c
         FROM transactions
        WHERE tank_name = $1 AND site_name = $2 AND created_at <= $3`,
      [tankName, siteName, atDate.toISOString()]
    );
    return computeFifoCost(client, tankId, litersDispensed, atDate, Number(priorRes.rows[0].c));
  }
  return computeWeightedAverageCost(client, tankId, litersDispensed, atDate);
}
