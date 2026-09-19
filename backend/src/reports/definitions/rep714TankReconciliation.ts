import { registerReport } from '../reportRegistry';
import { ReportDefinition } from '../reportTypes';

/**
 * REP-714 (#171) — Tank Mutabakat ve Fire Raporu.
 *
 * KAYNAK: FUEL-409 `stock_reconciliations` (REP-713 ile AYNI gerekçe: rapor
 * bakiye/fark YENİDEN HESAPLAMAZ, denetlenmiş mutabakat kayıtlarını okur).
 * İKİ TANIM:
 *  - `rep-714`             : tank × dönem DETAY (litre + % fark, tolerans
 *                            vurgusu, önceki döneme göre trend sütunu),
 *  - `rep-714-fire-sinifi` : fire SINIFINA göre kırılım (şantiye × sınıf × ay).
 *
 * TOLERANS DIŞI: satırın KENDİ `tolerance_pct`'i (mutabakat başına ezilebilir)
 * esas alınır: |fark %| > tolerans. Bu, sistemin "alarm" kararından AYRIDIR:
 * BUHARLAŞMA sınıfı literal olarak toleransın dışındadır ama doğal buharlaşma
 * payı içinde açıklandığı için status=NORMAL'dir (bkz. tenantDb.ts reconcileTank
 * Row). İkisi de görünür: `out_of_tolerance` (vurgu) + `status` + `classification`.
 *
 * Teknik Not ("% mutlak litre kadar önemlidir; küçük tankta 50 L büyük tanktakinden
 * ciddidir"): hem litre hem % gösterilir; `minAbsVarianceLiters` ve
 * `minAbsVariancePct` filtreleri (numberGte) ikisine AYRI AYRI eşik koyar.
 *
 * Trend: `prev_variance_pct` = AYNI tank + AYNI dönem tipi için bir önceki
 * mutabakatın fark %'si (LAG; filtrelerden ÖNCE hesaplanır → filtre uygulansa da
 * "önceki" gerçek önceki dönemdir). Grafik verisi = aynı uç
 * `?tankName=..&sortBy=period_start&sortDir=asc`; sütun `variance_pct_change`
 * (yüzde puan) iki dönem arası değişimi hazır verir.
 *
 * Kırılım sınırı (REP-703 aggregate'leri yalnızca genel toplamdır, filtre
 * GRUPLAMADAN SONRA uygulanır): tarih filtresinin gruplamadan önce
 * çalışabilmesi için kırılım AY granülaritesindedir (dönem başlangıcının
 * İstanbul ayı). Aralık birden çok ayı kapsıyorsa sınıf başına ay sayısı kadar
 * satır gelir; tek sınıfın aralık toplamı `classification` filtresi + rapor
 * toplamlarıyla alınır.
 *
 * Excel çıktısı: REP-711'deki KAPSAM UYARLAMASI geçerli (REP-703 CSV+PDF üretir).
 */

const fmt2 = (v: unknown): string => (v === null || v === undefined ? '-' : Number(v).toFixed(2));
const fmtDate = (v: unknown): string => new Date(v as string).toLocaleString('tr-TR');
const STOCK_ROLES: ReportDefinition['allowedRoles'] = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'];

export const rep714TankReconciliation: ReportDefinition = {
  id: 'rep-714',
  title: 'Tank Mutabakat ve Fire Raporu',
  description: 'Tank × dönem: açılış, dolum, çıkış, teorik kapanış, ölçülen kapanış, fark (litre ve %), fire sınıfı, tolerans vurgusu ve önceki döneme göre trend.',
  table: `(
    SELECT s.*,
      COALESCE(abs(s.variance_pct) > s.tolerance_pct, FALSE) AS out_of_tolerance,
      s.variance_pct - s.prev_variance_pct AS variance_pct_change
    FROM (
      SELECT r.id, r.tank_id, r.tank_name, r.site_name, r.period_type, r.period_start, r.period_end,
        r.opening_book_liters, r.intake_liters,
        (r.dispensed_liters + r.test_intake_liters) AS outflow_liters,
        r.closing_book_liters, r.physical_liters, r.variance_liters, r.variance_pct,
        abs(r.variance_liters) AS abs_variance_liters, abs(r.variance_pct) AS abs_variance_pct,
        r.tolerance_pct, r.classification, r.status,
        LAG(r.variance_pct) OVER (PARTITION BY r.tank_id, r.period_type ORDER BY r.period_start) AS prev_variance_pct
      FROM stock_reconciliations r
    ) s
  ) c`,
  columns: [
    { key: 'id', header: 'ID' },
    { key: 'tank_name', header: 'Tank', width: 16 },
    { key: 'site_name', header: 'Şantiye', width: 16 },
    { key: 'period_type', header: 'Dönem', width: 8 },
    { key: 'period_start', header: 'Dönem Başı', width: 14, format: fmtDate },
    { key: 'period_end', header: 'Dönem Sonu', width: 14, format: fmtDate },
    { key: 'opening_book_liters', header: 'Açılış', width: 9, format: fmt2 },
    { key: 'intake_liters', header: 'Dolum', width: 9, format: fmt2 },
    { key: 'outflow_liters', header: 'Çıkış', width: 9, format: fmt2 },
    { key: 'closing_book_liters', header: 'Teorik Kapanış', width: 10, format: fmt2 },
    { key: 'physical_liters', header: 'Ölçülen Kapanış', width: 10, format: fmt2 },
    { key: 'variance_liters', header: 'Fark (L)', width: 9, format: fmt2 },
    { key: 'variance_pct', header: 'Fark %', width: 8, format: fmt2 },
    { key: 'prev_variance_pct', header: 'Önceki Dönem Fark %', width: 9, format: fmt2 },
    { key: 'variance_pct_change', header: 'Önceki Döneme Göre (puan)', width: 10, format: (v) => (v === null || v === undefined ? '-' : `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}`) },
    { key: 'classification', header: 'Fire Sınıfı', width: 13 },
    { key: 'status', header: 'Durum', width: 12 },
    { key: 'out_of_tolerance', header: 'Tolerans', width: 10, format: (v) => (v ? 'TOLERANS DIŞI' : 'İçinde') }
  ],
  filters: [
    { key: 'startDate', column: 'period_start', type: 'dateFrom', label: 'Başlangıç Tarihi' },
    { key: 'endDate', column: 'period_end', type: 'dateToExclusiveNextDay', label: 'Bitiş Tarihi' },
    { key: 'siteName', column: 'site_name', type: 'exact', label: 'Şantiye' },
    { key: 'tankName', column: 'tank_name', type: 'exact', label: 'Tank' },
    { key: 'periodType', column: 'period_type', type: 'exact', label: 'Dönem Tipi' },
    { key: 'classification', column: 'classification', type: 'exact', label: 'Fire Sınıfı' },
    { key: 'status', column: 'status', type: 'exact', label: 'Durum (NORMAL / MUTABAKAT_ALARMI)' },
    { key: 'outOfTolerance', column: 'out_of_tolerance', type: 'exact', label: 'Yalnız Tolerans Dışı (true)' },
    { key: 'minAbsVarianceLiters', column: 'abs_variance_liters', type: 'numberGte', label: 'Mutlak Fark En Az (L)' },
    { key: 'minAbsVariancePct', column: 'abs_variance_pct', type: 'numberGte', label: 'Mutlak Fark En Az (%)' }
  ],
  aggregates: [
    { key: 'total_variance_liters', column: 'variance_liters', fn: 'SUM', label: 'Toplam Fark (L)' },
    { key: 'total_out_of_tolerance', column: 'CASE WHEN out_of_tolerance THEN 1 ELSE 0 END', fn: 'SUM', label: 'Tolerans Dışı Dönem Sayısı' }
  ],
  allowedRoles: STOCK_ROLES,
  defaultSort: { column: 'period_start', direction: 'DESC' },
  siteScopeColumn: 'site_name'
};

export const rep714FireClassBreakdown: ReportDefinition = {
  id: 'rep-714-fire-sinifi',
  title: 'Fire Sınıfına Göre Kırılım (REP-714)',
  description: 'Şantiye × fire sınıfı (buharlaşma, ölçüm hatası, açıklanamayan, tolerans içi) × ay: mutabakat sayısı, kayıp/fazla litre ve ortalama fark %.',
  table: `(
    SELECT
      r.site_name || ':' || r.classification || ':' || to_char(m.month_start, 'YYYY-MM') AS id,
      r.site_name, r.classification, m.month_start, to_char(m.month_start, 'YYYY-MM') AS month_label,
      COUNT(*)::int AS reconciliation_count,
      COALESCE(SUM(-r.variance_liters) FILTER (WHERE r.variance_liters < 0), 0) AS loss_liters,
      COALESCE(SUM(r.variance_liters) FILTER (WHERE r.variance_liters > 0), 0) AS surplus_liters,
      SUM(r.variance_liters) AS net_variance_liters,
      round(AVG(r.variance_pct), 4) AS avg_variance_pct
    FROM stock_reconciliations r
    CROSS JOIN LATERAL (SELECT date_trunc('month', (r.period_start AT TIME ZONE 'UTC') + interval '3 hours') AS month_start) m
    GROUP BY r.site_name, r.classification, m.month_start
  ) c`,
  columns: [
    { key: 'id', header: 'ID' },
    { key: 'site_name', header: 'Şantiye', width: 20 },
    { key: 'month_label', header: 'Ay', width: 10 },
    { key: 'classification', header: 'Fire Sınıfı', width: 16 },
    { key: 'reconciliation_count', header: 'Mutabakat', width: 10 },
    { key: 'loss_liters', header: 'Kayıp (L)', width: 12, format: fmt2 },
    { key: 'surplus_liters', header: 'Fazla (L)', width: 12, format: fmt2 },
    { key: 'net_variance_liters', header: 'Net Fark (L)', width: 12, format: fmt2 },
    { key: 'avg_variance_pct', header: 'Ort. Fark %', width: 11, format: fmt2 }
  ],
  filters: [
    { key: 'startDate', column: 'month_start', type: 'dateFrom', label: 'Başlangıç Ayı' },
    { key: 'endDate', column: 'month_start', type: 'dateToExclusiveNextDay', label: 'Bitiş Ayı' },
    { key: 'siteName', column: 'site_name', type: 'exact', label: 'Şantiye' },
    { key: 'classification', column: 'classification', type: 'exact', label: 'Fire Sınıfı' }
  ],
  aggregates: [
    { key: 'total_loss_liters', column: 'loss_liters', fn: 'SUM', label: 'Toplam Kayıp (L)' },
    { key: 'total_surplus_liters', column: 'surplus_liters', fn: 'SUM', label: 'Toplam Fazla (L)' },
    { key: 'total_reconciliations', column: 'reconciliation_count', fn: 'SUM', label: 'Toplam Mutabakat' }
  ],
  allowedRoles: STOCK_ROLES,
  defaultSort: { column: 'month_label', direction: 'DESC' },
  siteScopeColumn: 'site_name'
};

registerReport(rep714TankReconciliation);
registerReport(rep714FireClassBreakdown);
