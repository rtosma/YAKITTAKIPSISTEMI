import { registerReport } from '../reportRegistry';
import { ReportDefinition } from '../reportTypes';

/**
 * REP-712 (#169) — Araç Bazlı Tüketim Raporu (L/100km, L/motor-saat).
 *
 * MİMARİ: REP-703 çatısı SQL-tanımlıdır (`table` + sütun/filtre/aggregate),
 * FLEET-1405 tüketim motoru ise JS'tir (tenantDb.ts computeVehicleConsumption
 * Window — araç başına ayrı sorgular). Çatıya HİÇ dokunmadan raporu üretmek
 * için aynı hesap SQL'de (schema.sql: vehicle_consumption_window +
 * resolve_vehicle_meter_type) yeniden ifade edildi ve `table` bunları
 * araç × son 13 ay üzerinde çağıran bir alt sorgudur. Çift kaynak riskine
 * karşı test_rep712_vehicle_consumption.ts rapor satırlarını JS motorunun
 * (getFleetConsumptionReport) çıktısıyla KARŞILAŞTIRIR (parite testi).
 * Dönem sınırları FLEET-1405 ile AYNI: Europe/Istanbul takvim ayı (sabit UTC+3).
 *
 * "Dönem" filtresi (period=YYYY-AA) verilmezse 13 ayın TÜMÜ araç başına
 * listelenir; verilince Postgres bu koşulu ay üretecine iter, yalnızca o
 * dönem hesaplanır.
 *
 * AC eşlemesi:
 *  - Eksik sayaç verisi AÇIKÇA belirtilir: data_status EKSIK_VERI /
 *    GECERSIZ_VERI ve ilgili metrik hücresi BOŞ değil 'VERİ EKSİK' /
 *    'GEÇERSİZ VERİ' yazar (Teknik Not: boş hücre sıfır tüketim sanılır).
 *    Sayaç tipine uygun OLMAYAN metrik (motor-saatli araçta L/100km) '-'dir.
 *  - Dönem karşılaştırması: change_pct = önceki takvim ayına göre değişim
 *    (her iki dönem de HESAPLANDI ise; aksi halde NULL — tahmin yok).
 *  - AI-503 vurgusu: o araç+dönem için CONSUMPTION_ANOMALY alarm olayı
 *    (alarm_events.detail.periodLabel) varsa anomaly_flagged. Anomali
 *    KARARI burada yeniden hesaplanmaz — tek doğruluk kaynağı
 *    scanConsumptionAnomalies (AI-503) → AI-507 alarmlarıdır.
 *  - "Toplam litre/tutar" sayaç verisinden bağımsız GERÇEK ikmal toplamıdır
 *    (JS motoru eksik/geçersiz dönemde fuelLiters=0 döner; raporda gerçek
 *    litre gösterilir — 0 göstermek yanıltıcı olurdu).
 *  - Excel çıktısı: REP-711'deki KAPSAM UYARLAMASI aynen geçerli (REP-703
 *    çatısı CSV+PDF üretir).
 */

const STATUS_TEXT: Record<string, string> = {
  HESAPLANDI: 'Hesaplandı',
  EKSIK_VERI: 'VERİ EKSİK',
  GECERSIZ_VERI: 'GEÇERSİZ VERİ'
};

/** Metrik yalnızca `applicableMeter` sayaç tipinde anlamlıdır; değilse '-'. Uygunsa ama hesaplanamadıysa AÇIK durum metni. */
function metricCell(applicableMeter: 'KM' | 'MOTOR_SAAT') {
  return (value: unknown, row?: Record<string, unknown>): string => {
    if (row && row.meter_type !== applicableMeter) return '-';
    if (value !== null && value !== undefined) return Number(value).toFixed(2);
    return STATUS_TEXT[String(row?.data_status)] ?? 'VERİ EKSİK';
  };
}

const CONSUMPTION_TABLE = `(
  SELECT x.*,
    CASE WHEN x.metric IS NOT NULL AND x.prev_metric IS NOT NULL AND x.prev_metric <> 0
         THEN round((x.metric - x.prev_metric) / x.prev_metric * 100, 2) END AS change_pct,
    CASE WHEN x.metric IS NOT NULL AND x.prev_metric IS NOT NULL AND x.prev_metric <> 0
         THEN abs(round((x.metric - x.prev_metric) / x.prev_metric * 100, 2)) END AS abs_change_pct
  FROM (
    SELECT
      v.id || ':' || m.period_label AS id,
      v.id AS vehicle_id, v.plate AS vehicle_plate, v.vehicle_type, v.site_name,
      m.period_label, mt.meter_type,
      cur.fuel_liters, cur.total_cost, cur.usage_amount, cur.data_status,
      CASE WHEN mt.meter_type = 'KM' AND cur.data_status = 'HESAPLANDI' THEN round(cur.fuel_liters / cur.usage_amount * 100, 2) END AS l_per_100km,
      CASE WHEN mt.meter_type = 'MOTOR_SAAT' AND cur.data_status = 'HESAPLANDI' THEN round(cur.fuel_liters / cur.usage_amount, 2) END AS l_per_hour,
      CASE WHEN cur.data_status = 'HESAPLANDI'
           THEN CASE WHEN mt.meter_type = 'KM' THEN round(cur.fuel_liters / cur.usage_amount * 100, 2) ELSE round(cur.fuel_liters / cur.usage_amount, 2) END END AS metric,
      CASE WHEN prev.data_status = 'HESAPLANDI'
           THEN CASE WHEN mt.meter_type = 'KM' THEN round(prev.fuel_liters / prev.usage_amount * 100, 2) ELSE round(prev.fuel_liters / prev.usage_amount, 2) END END AS prev_metric,
      EXISTS (
        SELECT 1 FROM alarm_events e JOIN alarms a ON a.id = e.alarm_id
         WHERE a.category = 'CONSUMPTION_ANOMALY' AND a.subject_id = v.plate AND e.detail->>'periodLabel' = m.period_label
      ) AS anomaly_flagged
    FROM vehicles v
    CROSS JOIN LATERAL (SELECT resolve_vehicle_meter_type(v.vehicle_type, v.meter_type) AS meter_type) mt
    CROSS JOIN (
      SELECT to_char(g, 'YYYY-MM') AS period_label,
             (g - interval '3 hours') AT TIME ZONE 'UTC' AS period_start,
             ((g + interval '1 month') - interval '3 hours') AT TIME ZONE 'UTC' AS period_end,
             ((g - interval '1 month') - interval '3 hours') AT TIME ZONE 'UTC' AS prev_start
        FROM generate_series(
               date_trunc('month', (now() AT TIME ZONE 'UTC') + interval '3 hours') - interval '12 months',
               date_trunc('month', (now() AT TIME ZONE 'UTC') + interval '3 hours'),
               interval '1 month') g
    ) m
    CROSS JOIN LATERAL vehicle_consumption_window(v.id, v.plate, mt.meter_type, m.period_start, m.period_end) cur
    CROSS JOIN LATERAL vehicle_consumption_window(v.id, v.plate, mt.meter_type, m.prev_start, m.period_start) prev
    WHERE v.status <> 'PASİF'
  ) x
) c`;

export const rep712VehicleConsumption: ReportDefinition = {
  id: 'rep-712',
  title: 'Araç Bazlı Tüketim Raporu',
  description: 'Araç × dönem L/100km ve L/motor-saat, önceki döneme göre değişim, eksik sayaç verisi ve AI-503 anomali işareti.',
  table: CONSUMPTION_TABLE,
  columns: [
    { key: 'id', header: 'ID' },
    { key: 'vehicle_plate', header: 'Araç', width: 14 },
    { key: 'vehicle_type', header: 'Tip', width: 16 },
    { key: 'site_name', header: 'Şantiye', width: 20 },
    { key: 'period_label', header: 'Dönem', width: 10 },
    { key: 'meter_type', header: 'Sayaç', width: 10, format: (v) => (v === 'MOTOR_SAAT' ? 'Motor-saat' : 'Km') },
    { key: 'fuel_liters', header: 'Toplam Litre', width: 12, format: (v) => Number(v).toFixed(2) },
    { key: 'total_cost', header: 'Tutar', width: 12, format: (v) => (v === null || v === undefined ? '-' : Number(v).toFixed(2)) },
    {
      key: 'usage_amount',
      header: 'Kat Edilen (km/saat)',
      width: 14,
      format: (v, row) => (v !== null && v !== undefined ? Number(v).toFixed(2) : STATUS_TEXT[String(row?.data_status)] ?? 'VERİ EKSİK')
    },
    { key: 'l_per_100km', header: 'L/100km', width: 12, format: metricCell('KM') },
    { key: 'l_per_hour', header: 'L/saat', width: 12, format: metricCell('MOTOR_SAAT') },
    { key: 'change_pct', header: 'Önceki Döneme Göre %', width: 14, format: (v) => (v === null || v === undefined ? '-' : `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}`) },
    { key: 'data_status', header: 'Veri Durumu', width: 14, format: (v) => STATUS_TEXT[String(v)] ?? String(v) },
    { key: 'anomaly_flagged', header: 'AI-503', width: 10, format: (v) => (v ? 'ANOMALİ' : '-') }
  ],
  filters: [
    { key: 'period', column: 'period_label', type: 'exact', label: 'Dönem (YYYY-AA)' },
    { key: 'vehicleType', column: 'vehicle_type', type: 'exact', label: 'Araç Tipi' },
    { key: 'siteName', column: 'site_name', type: 'exact', label: 'Şantiye' },
    { key: 'vehiclePlate', column: 'vehicle_plate', type: 'ilike', label: 'Araç Plakası' },
    { key: 'minDeviationPct', column: 'abs_change_pct', type: 'numberGte', label: 'Sapma Eşiği (%, önceki döneme göre)' }
  ],
  aggregates: [
    { key: 'total_liters', column: 'fuel_liters', fn: 'SUM', label: 'Toplam Litre' },
    { key: 'total_amount', column: 'total_cost', fn: 'SUM', label: 'Toplam Tutar' }
  ],
  allowedRoles: ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'],
  defaultSort: { column: 'vehicle_plate', direction: 'ASC' },
  siteScopeColumn: 'site_name'
};

registerReport(rep712VehicleConsumption);
