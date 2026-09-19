import { registerReport } from '../reportRegistry';
import { ReportDefinition } from '../reportTypes';

/**
 * REP-713 (#170) — Şantiye Bazlı Tüketim ve Stok Raporu.
 *
 * KAYNAK: FUEL-409'un `stock_reconciliations` satırları (tank × dönem başına
 * bir denetlenmiş kayıt: açılış, dolum, ikmal, test alımı, TEORİK kapanış,
 * ölçülen FİZİKSEL stok, fark). Rapor hiçbir bakiyeyi YENİDEN HESAPLAMAZ —
 * mutabakatın kendi kayıtlarını okur (tek doğruluk kaynağı; "giren/çıkan/
 * kalan tutarlı" AC'si bu yüzden yapısal olarak sağlanır: opening + dolum −
 * ikmal − test = teorik kapanış, mutabakat motorunun yazdığı formül).
 * Bunun sonucu: rapor yalnızca mutabakatı YAPILMIŞ dönemleri gösterir
 * (günlük süpürücü + manuel/AD_HOC mutabakatlar).
 *
 * İKİ TANIM (tek çatı, iki rapor): Ticket'ın sütun listesi şantiye
 * düzeyindedir ("şantiye, dönem başı stok, ...") ve "yakıt tipi kırılımı" +
 * "tank bazında detaya inebilme" ister →
 *  - `rep-713`      : şantiye × yakıt tipi × dönem ÖZET (tank toplamları),
 *  - `rep-713-tank` : tank × dönem DETAY (drill-down; siteName/fuelType/tankName
 *                     filtreleriyle özetten inilir).
 *
 * Fire: o tankın, dönem gün aralığına (İstanbul, sabit UTC+3) düşen ONAYLANMIŞ
 * (status='ONAYLANDI') KAYIP yönlü fire kayıtlarının toplamı (INV-1505).
 * BEKLIYOR/REDDEDİLDİ sayılmaz; FAZLA (fiziksel > defter) yönü fire değildir.
 * "Fark" ise ham fiziksel−teorik farktır — onaylı fire ile YAN YANA görünmesi
 * (henüz açıklanmamış fark ≠ onaylanmış fire) raporun amacıdır.
 *
 * Kritik tank (INV-1504): tanks.current_level_liters <= low_stock_threshold_
 * liters (eşik tanımlıysa). Eşiği hiç tanımlanmamış tank "kritik" sayılmaz —
 * bilinmeyen bir eşiğe göre kritik demek yanlış alarm olurdu. Bu, tankın
 * ŞU ANKİ durumudur (dönem sonu anlık görüntüsü değil).
 *
 * Excel çıktısı: REP-711'deki KAPSAM UYARLAMASI geçerli (REP-703 CSV+PDF üretir).
 */

const TANK_BASE = `
  SELECT
    r.id, r.tank_id, r.tank_name, r.site_name, COALESCE(t.fuel_type, 'Bilinmiyor') AS fuel_type,
    r.period_type, r.period_start, r.period_end,
    r.opening_book_liters, r.intake_liters, r.dispensed_liters, r.test_intake_liters,
    COALESCE((
      SELECT SUM(fr.quantity_liters) FROM fire_records fr
       WHERE fr.tank_id = r.tank_id AND fr.status = 'ONAYLANDI' AND fr.variance_direction = 'KAYIP'
         AND fr.record_date >= ((r.period_start AT TIME ZONE 'UTC') + interval '3 hours')::date
         AND fr.record_date <= ((r.period_end AT TIME ZONE 'UTC') - interval '1 second' + interval '3 hours')::date
    ), 0) AS fire_liters,
    r.closing_book_liters, r.physical_liters, r.variance_liters, r.variance_pct, r.classification,
    t.current_level_liters, t.low_stock_threshold_liters,
    COALESCE(t.low_stock_threshold_liters IS NOT NULL AND t.current_level_liters <= t.low_stock_threshold_liters, FALSE) AS is_critical
  FROM stock_reconciliations r
  LEFT JOIN tanks t ON t.id = r.tank_id
`;

const fmt2 = (v: unknown): string => (v === null || v === undefined ? '-' : Number(v).toFixed(2));
const fmtDate = (v: unknown): string => new Date(v as string).toLocaleString('tr-TR');

const COMMON_FILTERS: ReportDefinition['filters'] = [
  { key: 'startDate', column: 'period_start', type: 'dateFrom', label: 'Başlangıç Tarihi' },
  { key: 'endDate', column: 'period_end', type: 'dateToExclusiveNextDay', label: 'Bitiş Tarihi' },
  { key: 'siteName', column: 'site_name', type: 'exact', label: 'Şantiye' },
  { key: 'fuelType', column: 'fuel_type', type: 'exact', label: 'Yakıt Tipi' },
  { key: 'periodType', column: 'period_type', type: 'exact', label: 'Dönem Tipi' }
];

const STOCK_ROLES: ReportDefinition['allowedRoles'] = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'];

export const rep713SiteStock: ReportDefinition = {
  id: 'rep-713',
  title: 'Şantiye Bazlı Tüketim ve Stok Raporu',
  description: 'Şantiye × yakıt tipi × dönem: dönem başı stok, dolum, ikmal, fire, teorik kapanış, ölçülen fiziksel stok, fark ve kritik tank sayısı.',
  table: `(
    SELECT
      b.site_name || ':' || b.fuel_type || ':' || b.period_type || ':' || floor(extract(epoch FROM b.period_start))::bigint::text || ':' || floor(extract(epoch FROM b.period_end))::bigint::text AS id,
      b.site_name, b.fuel_type, b.period_type, b.period_start, b.period_end,
      COUNT(*)::int AS tank_count,
      SUM(b.opening_book_liters) AS opening_liters,
      SUM(b.intake_liters) AS intake_liters,
      SUM(b.dispensed_liters) AS dispensed_liters,
      SUM(b.test_intake_liters) AS test_intake_liters,
      SUM(b.fire_liters) AS fire_liters,
      SUM(b.closing_book_liters) AS closing_book_liters,
      SUM(b.physical_liters) AS physical_liters,
      SUM(b.variance_liters) AS variance_liters,
      COUNT(*) FILTER (WHERE b.is_critical)::int AS critical_tank_count
    FROM (${TANK_BASE}) b
    GROUP BY b.site_name, b.fuel_type, b.period_type, b.period_start, b.period_end
  ) c`,
  columns: [
    { key: 'id', header: 'ID' },
    { key: 'site_name', header: 'Şantiye', width: 20 },
    { key: 'fuel_type', header: 'Yakıt Tipi', width: 12 },
    { key: 'period_type', header: 'Dönem', width: 9 },
    { key: 'period_start', header: 'Dönem Başı', width: 15, format: fmtDate },
    { key: 'period_end', header: 'Dönem Sonu', width: 15, format: fmtDate },
    { key: 'tank_count', header: 'Tank', width: 6 },
    { key: 'opening_liters', header: 'Açılış Stok', width: 11, format: fmt2 },
    { key: 'intake_liters', header: 'Dolum', width: 10, format: fmt2 },
    { key: 'dispensed_liters', header: 'İkmal', width: 10, format: fmt2 },
    { key: 'test_intake_liters', header: 'Test Alımı', width: 10, format: fmt2 },
    { key: 'fire_liters', header: 'Onaylı Fire', width: 10, format: fmt2 },
    { key: 'closing_book_liters', header: 'Teorik Kapanış', width: 12, format: fmt2 },
    { key: 'physical_liters', header: 'Ölçülen Fiziksel', width: 12, format: fmt2 },
    { key: 'variance_liters', header: 'Fark', width: 10, format: fmt2 },
    { key: 'critical_tank_count', header: 'Kritik Tank', width: 9, format: (v) => (Number(v) > 0 ? `KRİTİK: ${v}` : '-') }
  ],
  filters: [...COMMON_FILTERS, { key: 'minCriticalTanks', column: 'critical_tank_count', type: 'numberGte', label: 'En Az Kritik Tank Sayısı' }],
  aggregates: [
    { key: 'total_intake', column: 'intake_liters', fn: 'SUM', label: 'Toplam Dolum' },
    { key: 'total_dispensed', column: 'dispensed_liters', fn: 'SUM', label: 'Toplam İkmal' },
    { key: 'total_variance', column: 'variance_liters', fn: 'SUM', label: 'Toplam Fark' }
  ],
  allowedRoles: STOCK_ROLES,
  defaultSort: { column: 'period_start', direction: 'DESC' },
  siteScopeColumn: 'site_name'
};

export const rep713TankStock: ReportDefinition = {
  id: 'rep-713-tank',
  title: 'Tank Bazlı Stok Detayı (REP-713)',
  description: 'REP-713 özetinin tank düzeyinde detayı: mutabakat dönemi başına açılış/dolum/ikmal/fire/teorik/fiziksel/fark ve kritik tank vurgusu.',
  table: `(${TANK_BASE}) c`,
  columns: [
    { key: 'id', header: 'ID' },
    { key: 'site_name', header: 'Şantiye', width: 16 },
    { key: 'tank_name', header: 'Tank', width: 16 },
    { key: 'fuel_type', header: 'Yakıt Tipi', width: 10 },
    { key: 'period_type', header: 'Dönem', width: 8 },
    { key: 'period_start', header: 'Dönem Başı', width: 14, format: fmtDate },
    { key: 'period_end', header: 'Dönem Sonu', width: 14, format: fmtDate },
    { key: 'opening_book_liters', header: 'Açılış Stok', width: 10, format: fmt2 },
    { key: 'intake_liters', header: 'Dolum', width: 9, format: fmt2 },
    { key: 'dispensed_liters', header: 'İkmal', width: 9, format: fmt2 },
    { key: 'test_intake_liters', header: 'Test Alımı', width: 9, format: fmt2 },
    { key: 'fire_liters', header: 'Onaylı Fire', width: 9, format: fmt2 },
    { key: 'closing_book_liters', header: 'Teorik Kapanış', width: 11, format: fmt2 },
    { key: 'physical_liters', header: 'Ölçülen Fiziksel', width: 11, format: fmt2 },
    { key: 'variance_liters', header: 'Fark', width: 9, format: fmt2 },
    { key: 'variance_pct', header: 'Fark %', width: 8, format: fmt2 },
    { key: 'classification', header: 'Sınıf', width: 12 },
    { key: 'is_critical', header: 'Kritik Stok', width: 9, format: (v) => (v ? 'KRİTİK' : '-') }
  ],
  filters: [
    ...COMMON_FILTERS,
    { key: 'tankName', column: 'tank_name', type: 'exact', label: 'Tank' },
    { key: 'isCritical', column: 'is_critical', type: 'exact', label: 'Yalnız Kritik Tanklar (true)' }
  ],
  aggregates: [
    { key: 'total_intake', column: 'intake_liters', fn: 'SUM', label: 'Toplam Dolum' },
    { key: 'total_dispensed', column: 'dispensed_liters', fn: 'SUM', label: 'Toplam İkmal' },
    { key: 'total_variance', column: 'variance_liters', fn: 'SUM', label: 'Toplam Fark' }
  ],
  allowedRoles: STOCK_ROLES,
  defaultSort: { column: 'period_start', direction: 'DESC' },
  siteScopeColumn: 'site_name'
};

registerReport(rep713SiteStock);
registerReport(rep713TankStock);
