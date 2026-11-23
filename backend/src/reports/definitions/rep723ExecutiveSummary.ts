import { registerReport } from '../reportRegistry';
import { ReportDefinition } from '../reportTypes';

/**
 * REP-723 (#180) — Yönetici Özet Dashboard'unun REP-703 kayıtlı raporları.
 *
 * Dashboard (GET /dashboard/executive, executiveDashboardService.ts) KPI kartlarını ve
 * ilk-10 şantiye listesini DOĞRUDAN bu iki tanımdan (runReport) üretir: kart değeri =
 * `rep-723` özetinin aggregate'i, tank görseli = `rep-723-tank` satırları. Böylece
 * "KPI ↔ CSV/PDF export" tutarlılığı yapısaldır (aynı SQL, aynı kapsam filtresi); "KPI ↔
 * detay raporu" tutarlılığı ise her KPI'nın `drilldown`'ıyla gösterilen mevcut rapora (rep-711
 * ikmal/tutar, rep-716 alarm, rep-723-tank kritik stok, rep-717-kesinti cihaz) aynı filtrelerle
 * gidildiğinde birebir aynı sayıyı vermesiyle test edilir.
 *
 * `rep-723`  : şantiye başına KPI satırı — bugün/ay litre, ay tutarı, açık alarm, kritik tank,
 *              çevrimdışı cihaz (şantiye adı kaynak tablolarının BİRLEŞİMİDİR; ayın hareketi,
 *              tank, cihaz, açık alarm — hiçbir kaynak şantiye görünmeden kalmaz).
 * `rep-723-tank`: tank başına doluluk (yüzde), kritik eşik durumu (rep-713'teki tanım: eşik
 *              tanımlıysa ve seviye <= eşik; eşiği olmayan tank kritik sayılmaz).
 *
 * TANIMLAR (dashboard kartlarıyla AYNI):
 *  - Bugün / Ay: gün sınırı filtre motorunun `::date` kuralıyla AYNI (sunucu oturum saat
 *    dilimi) — böylece kartın drill-down'ıyla açılan rep-711 (startDate=bugün / ay başı)
 *    birebir aynı satırları kapsar. Ay = içinde bulunulan takvim ayının başından şimdiye.
 *  - Tutar: INV-1503'ün DONDURULMUŞ `total_cost`'u (fiyatsız ikmal 0 katkı, dışlanmaz).
 *  - Açık alarm: durumu RESOLVED/FALSE_POSITIVE olmayan her alarm (ertelenmiş dahil).
 *    Şantiyesiz (tenant geneli) alarmlar '-' satırındadır; yalnızca SUPER_ADMIN/COMPANY_OWNER
 *    görür (SITE_MANAGER kapsamı `site_name = kendi şantiyesi`).
 *  - Çevrimdışı cihaz: son presence olayı OFFLINE olan cihaz (rep-717-kesinti'deki süren
 *    kesinti, `ongoing=1`); hiç presence olayı olmayan cihaz çevrimdışı SAYILMAZ (bilinmiyor).
 *
 * Excel çıktısı: REP-711'deki KAPSAM UYARLAMASI geçerli (REP-703 CSV+PDF üretir).
 */

const ROLES: ReportDefinition['allowedRoles'] = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'];
const num2 = (v: unknown): string => (v === null || v === undefined ? '-' : Number(v).toFixed(2));
const fmt1 = (v: unknown): string => (v === null || v === undefined ? '-' : Number(v).toFixed(1));

/** Kritik tank tanımı — rep-713'teki `is_critical` ile AYNI. */
export const CRITICAL_TANK_SQL = 't.low_stock_threshold_liters IS NOT NULL AND t.current_level_liters <= t.low_stock_threshold_liters';

export const rep723SiteKpis: ReportDefinition = {
  id: 'rep-723',
  title: 'Yönetici Özeti — Şantiye KPI (REP-723)',
  description: 'Şantiye başına bugünkü/aylık tüketim, aylık maliyet, açık alarm, kritik stoktaki tank ve çevrimdışı cihaz sayısı.',
  table: `(
    WITH tx AS (
      SELECT site_name,
        SUM(amount_liters) FILTER (WHERE created_at >= NOW()::date) AS today_liters,
        SUM(amount_liters) AS month_liters,
        SUM(total_cost) AS month_cost
      FROM transactions WHERE created_at >= date_trunc('month', NOW())::date GROUP BY site_name
    ), al AS (
      SELECT COALESCE(site_name, '-') AS site_name, COUNT(*)::int AS open_alarms
      FROM alarms WHERE status NOT IN ('RESOLVED', 'FALSE_POSITIVE') GROUP BY COALESCE(site_name, '-')
    ), tk AS (
      SELECT t.site_name, COUNT(*) FILTER (WHERE ${CRITICAL_TANK_SQL})::int AS critical_tanks, COUNT(*)::int AS tank_count
      FROM tanks t GROUP BY t.site_name
    ), dv AS (
      SELECT COALESCE(e.site_name, d.site_name, '-') AS site_name, COUNT(*)::int AS offline_devices
      FROM device_presence_events e
      LEFT JOIN hardware_devices d ON d.device_id = e.device_id
      WHERE e.status = 'OFFLINE'
        AND NOT EXISTS (SELECT 1 FROM device_presence_events n WHERE n.device_id = e.device_id AND n.occurred_at > e.occurred_at)
      GROUP BY COALESCE(e.site_name, d.site_name, '-')
    ), names AS (
      SELECT site_name FROM tx UNION SELECT site_name FROM al UNION SELECT site_name FROM tk UNION SELECT site_name FROM dv
      UNION SELECT name FROM sites
    )
    SELECT n.site_name AS id, n.site_name,
      COALESCE(tx.today_liters, 0) AS today_liters, COALESCE(tx.month_liters, 0) AS month_liters, COALESCE(tx.month_cost, 0) AS month_cost,
      COALESCE(al.open_alarms, 0) AS open_alarms, COALESCE(tk.critical_tanks, 0) AS critical_tanks, COALESCE(tk.tank_count, 0) AS tank_count,
      COALESCE(dv.offline_devices, 0) AS offline_devices
    FROM names n
    LEFT JOIN tx ON tx.site_name = n.site_name LEFT JOIN al ON al.site_name = n.site_name
    LEFT JOIN tk ON tk.site_name = n.site_name LEFT JOIN dv ON dv.site_name = n.site_name
  ) c`,
  columns: [
    { key: 'id', header: 'ID' },
    { key: 'site_name', header: 'Şantiye', width: 20 },
    { key: 'today_liters', header: 'Bugün (L)', width: 10, format: num2 },
    { key: 'month_liters', header: 'Ay (L)', width: 11, format: num2 },
    { key: 'month_cost', header: 'Ay Tutarı', width: 11, format: num2 },
    { key: 'open_alarms', header: 'Açık Alarm', width: 8 },
    { key: 'critical_tanks', header: 'Kritik Tank', width: 8 },
    { key: 'tank_count', header: 'Tank', width: 6 },
    { key: 'offline_devices', header: 'Çevrimdışı Cihaz', width: 9 }
  ],
  filters: [{ key: 'siteName', column: 'site_name', type: 'exact', label: 'Şantiye' }],
  aggregates: [
    { key: 'today_liters', column: 'today_liters', fn: 'SUM', label: 'Bugünkü Tüketim (L)' },
    { key: 'month_liters', column: 'month_liters', fn: 'SUM', label: 'Aylık Tüketim (L)' },
    { key: 'month_cost', column: 'month_cost', fn: 'SUM', label: 'Aylık Maliyet' },
    { key: 'open_alarms', column: 'open_alarms', fn: 'SUM', label: 'Açık Alarm' },
    { key: 'critical_tanks', column: 'critical_tanks', fn: 'SUM', label: 'Kritik Stoktaki Tank' },
    { key: 'offline_devices', column: 'offline_devices', fn: 'SUM', label: 'Çevrimdışı Cihaz' }
  ],
  allowedRoles: ROLES,
  defaultSort: { column: 'month_liters', direction: 'DESC' },
  siteScopeColumn: 'site_name'
};

export const rep723TankFill: ReportDefinition = {
  id: 'rep-723-tank',
  title: 'Tank Doluluk Durumu (REP-723)',
  description: 'Tank başına anlık seviye, kapasite, doluluk yüzdesi ve kritik stok durumu.',
  table: `(
    SELECT t.id, t.site_name, t.name AS tank_name, t.fuel_type, t.capacity_liters, t.current_level_liters,
      CASE WHEN t.capacity_liters > 0 THEN round(t.current_level_liters / t.capacity_liters * 100, 1) END AS fill_pct,
      t.low_stock_threshold_liters, COALESCE(${CRITICAL_TANK_SQL}, FALSE) AS is_critical
    FROM tanks t
  ) c`,
  columns: [
    { key: 'id', header: 'ID' },
    { key: 'site_name', header: 'Şantiye', width: 16 },
    { key: 'tank_name', header: 'Tank', width: 18 },
    { key: 'fuel_type', header: 'Yakıt', width: 12 },
    { key: 'capacity_liters', header: 'Kapasite (L)', width: 10, format: num2 },
    { key: 'current_level_liters', header: 'Seviye (L)', width: 10, format: num2 },
    { key: 'fill_pct', header: 'Doluluk %', width: 8, format: fmt1 },
    { key: 'low_stock_threshold_liters', header: 'Kritik Eşik (L)', width: 10, format: num2 },
    { key: 'is_critical', header: 'Durum', width: 8, format: (v) => (v ? 'KRİTİK' : 'NORMAL') }
  ],
  filters: [
    { key: 'siteName', column: 'site_name', type: 'exact', label: 'Şantiye' },
    { key: 'fuelType', column: 'fuel_type', type: 'exact', label: 'Yakıt Tipi' },
    { key: 'isCritical', column: 'is_critical', type: 'exact', label: 'Yalnız Kritik Tanklar (true)' }
  ],
  aggregates: [
    { key: 'tank_count', column: 'id', fn: 'COUNT', label: 'Tank' },
    { key: 'total_level_liters', column: 'current_level_liters', fn: 'SUM', label: 'Toplam Seviye (L)' },
    { key: 'total_capacity_liters', column: 'capacity_liters', fn: 'SUM', label: 'Toplam Kapasite (L)' },
    { key: 'critical_tanks', column: 'CASE WHEN is_critical THEN 1 ELSE 0 END', fn: 'SUM', label: 'Kritik Tank' }
  ],
  allowedRoles: ROLES,
  defaultSort: { column: 'fill_pct', direction: 'ASC' },
  siteScopeColumn: 'site_name'
};

registerReport(rep723SiteKpis);
registerReport(rep723TankFill);
