import { registerReport } from '../reportRegistry';
import { ReportDefinition } from '../reportTypes';

/**
 * REP-719 (#176) — Maliyet ve Bütçe Raporu.
 *
 * MALİYET (AC: "ikmal anındaki birim fiyata dayanmalı"): rapor HİÇBİR fiyat
 * çarpımı yapmaz — `transactions.total_cost` / `unit_cost_liters` (INV-1503'ün
 * ikmal ANINDA yazdığı, sonradan DEĞİŞMEYEN değerler) toplanır. Sonradan giren
 * daha pahalı bir dolum geçmiş dönem maliyetini değiştirmez (testte doğrulanır).
 * Fiyat geçmişi olmayan ikmaller (total_cost NULL) maliyete 0 katar ve
 * `unpriced_liters` ile AÇIKÇA sayılır — maliyet bu durumda EKSİK olabilir,
 * bütçe karşılaştırması yalnız FİYATLI litreye dayanır (gizlenmez).
 * Ortalama birim fiyat = toplam maliyet / FİYATLI litre (ağırlıklı ortalama).
 *
 * BÜTÇE: kod tabanında hiç yoktu — `fuel_budgets` (şantiye × ay, TL) bu ticket'le
 * eklendi (PUT/GET/DELETE /fuel-budgets, SUPER_ADMIN/COMPANY_OWNER). Bütçe yalnız
 * RAPORLAMADIR (ikmali engellemez). Sapma = maliyet − bütçe (pozitif = AŞIM),
 * sapma % = sapma / bütçe × 100. Aşım = maliyet > bütçe (`is_over_budget`).
 * "Aşım UYARISI": rapor düzeyinde vurgu + `overBudgetOnly` filtresi + aşım sayısı
 * özeti; AI-507 alarmı/bildirimi ÜRETİLMEZ (bu rapor ticket'ı yalnız rapora
 * özgüdür — otomatik alarm ayrı bir iştir). Bütçesi tanımlı olup harcaması
 * olmayan ay 0 maliyetle görünür.
 *
 * ÜÇ TANIM (hepsi ay granülaritesinde — Europe/Istanbul takvim ayı, sabit UTC+3):
 *  - `rep-719`             : şantiye × ay — litre, ort. fiyat, maliyet, bütçe, sapma,
 *                            aşım, önceki aya göre fiyat/maliyet değişimi (trend),
 *  - `rep-719-yakit-tipi`  : şantiye × yakıt tipi × ay kırılımı + fiyat trendi,
 *  - `rep-719-arac`        : araç × ikmal şantiyesi × ay maliyeti.
 * Tarih filtresi (startDate/endDate) ay başlangıcına göredir. Önceki-ay
 * karşılaştırması AYNI şantiye/yakıt tipi için TAKVİM olarak bir önceki ayla
 * yapılır (o ayda hareket yoksa NULL — 0'a uydurulmaz).
 *
 * Excel çıktısı: REP-711'deki KAPSAM UYARLAMASI geçerli (REP-703 CSV+PDF üretir).
 */

const fmt2 = (v: unknown): string => (v === null || v === undefined ? '-' : Number(v).toFixed(2));
const fmt4 = (v: unknown): string => (v === null || v === undefined ? '-' : Number(v).toFixed(4));
const signed = (v: unknown): string => (v === null || v === undefined ? '-' : `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}`);
const ROLES: ReportDefinition['allowedRoles'] = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'];
const MONTH = `date_trunc('month', (t.created_at AT TIME ZONE 'UTC') + interval '3 hours')`;

export const rep719SiteCost: ReportDefinition = {
  id: 'rep-719',
  title: 'Maliyet ve Bütçe Raporu',
  description: 'Şantiye × ay: litre, ortalama birim fiyat, toplam maliyet (ikmal anı fiyatı), bütçe, sapma, aşım ve önceki aya göre fiyat/maliyet değişimi.',
  table: `(
    WITH spend AS (
      SELECT t.site_name, ${MONTH} AS month_start,
        SUM(t.amount_liters) AS liters,
        COALESCE(SUM(t.amount_liters) FILTER (WHERE t.total_cost IS NOT NULL), 0) AS priced_liters,
        COALESCE(SUM(t.amount_liters) FILTER (WHERE t.total_cost IS NULL), 0) AS unpriced_liters,
        COALESCE(SUM(t.total_cost), 0) AS total_cost
      FROM transactions t GROUP BY 1, 2
    ),
    bud AS (
      SELECT b.site_name, to_date(b.month || '-01', 'YYYY-MM-DD')::timestamp AS month_start, b.amount_try FROM fuel_budgets b
    ),
    j AS (
      SELECT COALESCE(s.site_name, b.site_name) AS site_name, COALESCE(s.month_start, b.month_start) AS month_start,
        COALESCE(s.liters, 0) AS liters, COALESCE(s.priced_liters, 0) AS priced_liters, COALESCE(s.unpriced_liters, 0) AS unpriced_liters,
        COALESCE(s.total_cost, 0) AS total_cost, b.amount_try AS budget_amount,
        CASE WHEN COALESCE(s.priced_liters, 0) > 0 THEN round(s.total_cost / s.priced_liters, 4) END AS avg_unit_price
      FROM spend s FULL OUTER JOIN bud b ON b.site_name = s.site_name AND b.month_start = s.month_start
    )
    SELECT j.site_name || ':' || to_char(j.month_start, 'YYYY-MM') AS id, j.site_name, j.month_start, to_char(j.month_start, 'YYYY-MM') AS month_label,
      j.liters, j.unpriced_liters, j.avg_unit_price, j.total_cost, j.budget_amount,
      CASE WHEN j.budget_amount IS NOT NULL THEN j.total_cost - j.budget_amount END AS variance,
      CASE WHEN j.budget_amount IS NOT NULL THEN round((j.total_cost - j.budget_amount) / j.budget_amount * 100, 2) END AS variance_pct,
      COALESCE(j.total_cost > j.budget_amount, FALSE) AS is_over_budget,
      pv.avg_unit_price AS prev_avg_unit_price,
      CASE WHEN j.avg_unit_price IS NOT NULL AND pv.avg_unit_price > 0 THEN round((j.avg_unit_price - pv.avg_unit_price) / pv.avg_unit_price * 100, 2) END AS price_change_pct,
      pv.total_cost AS prev_total_cost,
      CASE WHEN pv.total_cost > 0 THEN round((j.total_cost - pv.total_cost) / pv.total_cost * 100, 2) END AS cost_change_pct
    FROM j
    LEFT JOIN LATERAL (
      SELECT p.avg_unit_price, p.total_cost FROM j p WHERE p.site_name = j.site_name AND p.month_start = j.month_start - interval '1 month'
    ) pv ON TRUE
  ) c`,
  columns: [
    { key: 'id', header: 'ID' },
    { key: 'month_label', header: 'Ay', width: 8 },
    { key: 'site_name', header: 'Şantiye', width: 18 },
    { key: 'liters', header: 'Litre', width: 10, format: fmt2 },
    { key: 'unpriced_liters', header: 'Fiyatsız Litre', width: 9, format: fmt2 },
    { key: 'avg_unit_price', header: 'Ort. Birim Fiyat', width: 10, format: fmt4 },
    { key: 'total_cost', header: 'Toplam Maliyet', width: 12, format: fmt2 },
    { key: 'budget_amount', header: 'Bütçe', width: 11, format: (v) => (v === null || v === undefined ? 'TANIMSIZ' : Number(v).toFixed(2)) },
    { key: 'variance', header: 'Sapma', width: 11, format: signed },
    { key: 'variance_pct', header: 'Sapma %', width: 8, format: signed },
    { key: 'is_over_budget', header: 'Bütçe Durumu', width: 11, format: (v) => (v ? 'AŞIM' : '-') },
    { key: 'prev_avg_unit_price', header: 'Önceki Ay Fiyat', width: 10, format: fmt4 },
    { key: 'price_change_pct', header: 'Fiyat Değişimi %', width: 9, format: signed },
    { key: 'cost_change_pct', header: 'Maliyet Değişimi %', width: 9, format: signed }
  ],
  filters: [
    { key: 'startDate', column: 'month_start', type: 'dateFrom', label: 'Başlangıç Ayı' },
    { key: 'endDate', column: 'month_start', type: 'dateToExclusiveNextDay', label: 'Bitiş Ayı' },
    { key: 'siteName', column: 'site_name', type: 'exact', label: 'Şantiye' },
    { key: 'overBudgetOnly', column: 'is_over_budget', type: 'exact', label: 'Yalnız Bütçe Aşımları (true)' },
    { key: 'minVariancePct', column: 'variance_pct', type: 'numberGte', label: 'Sapma En Az (%)' }
  ],
  aggregates: [
    { key: 'total_liters', column: 'liters', fn: 'SUM', label: 'Toplam Litre' },
    { key: 'total_cost', column: 'total_cost', fn: 'SUM', label: 'Toplam Maliyet' },
    { key: 'total_budget', column: 'budget_amount', fn: 'SUM', label: 'Toplam Bütçe (tanımlı aylar)' },
    { key: 'over_budget_count', column: 'CASE WHEN is_over_budget THEN 1 ELSE 0 END', fn: 'SUM', label: 'Bütçe Aşımı Sayısı' },
    { key: 'total_unpriced_liters', column: 'unpriced_liters', fn: 'SUM', label: 'Fiyatsız Litre' }
  ],
  allowedRoles: ROLES,
  defaultSort: { column: 'month_label', direction: 'DESC' },
  siteScopeColumn: 'site_name'
};

export const rep719FuelTypeCost: ReportDefinition = {
  id: 'rep-719-yakit-tipi',
  title: 'Yakıt Tipi Bazında Maliyet (REP-719)',
  description: 'Şantiye × yakıt tipi × ay: litre, ortalama birim fiyat, maliyet ve önceki aya göre fiyat trendi. Tipi bilinmeyen ikmaller "Bilinmiyor" grubundadır.',
  table: `(
    WITH g AS (
      SELECT t.site_name, COALESCE(t.fuel_type, 'Bilinmiyor') AS fuel_type, ${MONTH} AS month_start,
        SUM(t.amount_liters) AS liters,
        COALESCE(SUM(t.amount_liters) FILTER (WHERE t.total_cost IS NOT NULL), 0) AS priced_liters,
        COALESCE(SUM(t.total_cost), 0) AS total_cost
      FROM transactions t GROUP BY 1, 2, 3
    )
    SELECT g.site_name || ':' || g.fuel_type || ':' || to_char(g.month_start, 'YYYY-MM') AS id, g.site_name, g.fuel_type, g.month_start, to_char(g.month_start, 'YYYY-MM') AS month_label,
      g.liters, g.total_cost,
      CASE WHEN g.priced_liters > 0 THEN round(g.total_cost / g.priced_liters, 4) END AS avg_unit_price,
      CASE WHEN pv.priced_liters > 0 THEN round(pv.total_cost / pv.priced_liters, 4) END AS prev_avg_unit_price,
      CASE WHEN g.priced_liters > 0 AND pv.priced_liters > 0 AND pv.total_cost > 0
           THEN round(((g.total_cost / g.priced_liters) - (pv.total_cost / pv.priced_liters)) / (pv.total_cost / pv.priced_liters) * 100, 2) END AS price_change_pct
    FROM g
    LEFT JOIN LATERAL (
      SELECT p.priced_liters, p.total_cost FROM g p WHERE p.site_name = g.site_name AND p.fuel_type = g.fuel_type AND p.month_start = g.month_start - interval '1 month'
    ) pv ON TRUE
  ) c`,
  columns: [
    { key: 'id', header: 'ID' },
    { key: 'month_label', header: 'Ay', width: 8 },
    { key: 'site_name', header: 'Şantiye', width: 20 },
    { key: 'fuel_type', header: 'Yakıt Tipi', width: 12 },
    { key: 'liters', header: 'Litre', width: 10, format: fmt2 },
    { key: 'avg_unit_price', header: 'Ort. Birim Fiyat', width: 11, format: fmt4 },
    { key: 'total_cost', header: 'Toplam Maliyet', width: 12, format: fmt2 },
    { key: 'prev_avg_unit_price', header: 'Önceki Ay Fiyat', width: 11, format: fmt4 },
    { key: 'price_change_pct', header: 'Fiyat Değişimi %', width: 10, format: signed }
  ],
  filters: [
    { key: 'startDate', column: 'month_start', type: 'dateFrom', label: 'Başlangıç Ayı' },
    { key: 'endDate', column: 'month_start', type: 'dateToExclusiveNextDay', label: 'Bitiş Ayı' },
    { key: 'siteName', column: 'site_name', type: 'exact', label: 'Şantiye' },
    { key: 'fuelType', column: 'fuel_type', type: 'exact', label: 'Yakıt Tipi' }
  ],
  aggregates: [
    { key: 'total_liters', column: 'liters', fn: 'SUM', label: 'Toplam Litre' },
    { key: 'total_cost', column: 'total_cost', fn: 'SUM', label: 'Toplam Maliyet' }
  ],
  allowedRoles: ROLES,
  defaultSort: { column: 'month_label', direction: 'DESC' },
  siteScopeColumn: 'site_name'
};

export const rep719VehicleCost: ReportDefinition = {
  id: 'rep-719-arac',
  title: 'Araç Bazında Maliyet (REP-719)',
  description: 'Araç × ikmal şantiyesi × ay: litre, ortalama birim fiyat ve maliyet (ikmal anı fiyatı). Bir araç iki şantiyeden yakıt aldıysa her şantiye için ayrı satır gelir.',
  table: `(
    SELECT t.vehicle_plate || ':' || t.site_name || ':' || to_char(${MONTH}, 'YYYY-MM') AS id,
      t.vehicle_plate, t.site_name, ${MONTH} AS month_start, to_char(${MONTH}, 'YYYY-MM') AS month_label,
      SUM(t.amount_liters) AS liters,
      COALESCE(SUM(t.amount_liters) FILTER (WHERE t.total_cost IS NULL), 0) AS unpriced_liters,
      COALESCE(SUM(t.total_cost), 0) AS total_cost,
      CASE WHEN COALESCE(SUM(t.amount_liters) FILTER (WHERE t.total_cost IS NOT NULL), 0) > 0
           THEN round(SUM(t.total_cost) / SUM(t.amount_liters) FILTER (WHERE t.total_cost IS NOT NULL), 4) END AS avg_unit_price
    FROM transactions t
    GROUP BY t.vehicle_plate, t.site_name, ${MONTH}
  ) c`,
  columns: [
    { key: 'id', header: 'ID' },
    { key: 'month_label', header: 'Ay', width: 8 },
    { key: 'vehicle_plate', header: 'Araç', width: 14 },
    { key: 'site_name', header: 'İkmal Şantiyesi', width: 20 },
    { key: 'liters', header: 'Litre', width: 10, format: fmt2 },
    { key: 'unpriced_liters', header: 'Fiyatsız Litre', width: 10, format: fmt2 },
    { key: 'avg_unit_price', header: 'Ort. Birim Fiyat', width: 11, format: fmt4 },
    { key: 'total_cost', header: 'Toplam Maliyet', width: 12, format: fmt2 }
  ],
  filters: [
    { key: 'startDate', column: 'month_start', type: 'dateFrom', label: 'Başlangıç Ayı' },
    { key: 'endDate', column: 'month_start', type: 'dateToExclusiveNextDay', label: 'Bitiş Ayı' },
    { key: 'siteName', column: 'site_name', type: 'exact', label: 'İkmal Şantiyesi' },
    { key: 'vehiclePlate', column: 'vehicle_plate', type: 'ilike', label: 'Araç Plakası' }
  ],
  aggregates: [
    { key: 'total_liters', column: 'liters', fn: 'SUM', label: 'Toplam Litre' },
    { key: 'total_cost', column: 'total_cost', fn: 'SUM', label: 'Toplam Maliyet' }
  ],
  allowedRoles: ROLES,
  defaultSort: { column: 'month_label', direction: 'DESC' },
  siteScopeColumn: 'site_name'
};

registerReport(rep719SiteCost);
registerReport(rep719FuelTypeCost);
registerReport(rep719VehicleCost);
