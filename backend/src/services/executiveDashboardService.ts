import { withTenant } from '../db/withTenant';
import { getReportDefinition } from '../reports';
import { runReport } from '../reports/reportEngine';
import { ReportViewer } from '../reports/reportTypes';

/**
 * REP-723 (#180) — Yönetici Özet Dashboard'u (KPI, trend, ilk 10, tank görseli).
 *
 * TEK DOĞRULUK KAYNAĞI: KPI kartları `rep-723`, tank görseli `rep-723-tank` REP-703
 * tanımlarından `runReport` ile üretilir (bkz. reports/definitions/rep723ExecutiveSummary.ts)
 * — dashboard ile CSV/PDF export'u aynı SQL'i ve AYNI rol/şantiye kapsamını paylaşır.
 * Yalnızca trend ve ilk-10 araç listesi bu dosyada, aynı kapsam kuralıyla ayrı SQL'dir.
 *
 * KAPSAM (rol/şantiye): `siteScope` (SITE_MANAGER → kendi şantiyesi) her sorguya uygulanır;
 * SUPER_ADMIN/COMPANY_OWNER tüm şantiyeleri görür. Tenant izolasyonu withTenant/RLS'tedir.
 *
 * KAPSAM UYARLAMASI — "rollup" (ARCH-103.3) ve "Socket.io canlı güncelleme" (FE-816):
 *  - Bu kod tabanında bir rollup/materialized-view katmanı YOK. Ham veri taraması yerine
 *    tüm sorgular indeksli ve PENCERELİDİR: transactions yalnızca içinde bulunulan ay /
 *    `days` penceresi (idx_transactions_tenant_created_at), diğerleri tank/cihaz/açık alarm
 *    gibi küçük tablolardır. Hedef < 1 sn testte ÖLÇÜLÜR; tenant büyüdüğünde rollup
 *    (ARCH-103.3) bu servisin sorgularının altına eklenir, sözleşme değişmez.
 *  - Canlı güncelleme için yeni bir olay EKLENMEDİ: mevcut tenant odası olayları
 *    (`dispense:completed`, alarm/uyarı yayınları) zaten yayınlanıyor; istemci (FE-816) bunları
 *    bu uca yeniden çekme tetikleyicisi olarak kullanır. Uç `Cache-Control: no-store` döner.
 *
 * Gün sınırları filtre motorunun `::date` kuralıyla AYNI (sunucu oturum saat dilimi): kartın
 * `drilldown`'ıyla açılan detay raporu birebir aynı kayıtları kapsar.
 */

export interface DashboardDrilldown {
  reportId: string;
  query: Record<string, string>;
  /** İstemcinin doğrudan açabileceği yol (`/reports/...`). */
  path: string;
}

export interface DashboardKpi {
  value: number;
  unit: string;
  label: string;
  drilldown: DashboardDrilldown;
}

const OPEN_ALARM_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING'];

function drilldown(reportId: string, query: Record<string, string | undefined>): DashboardDrilldown {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') clean[k] = v;
  return { reportId, query: clean, path: `/reports/${reportId}?${new URLSearchParams(clean).toString()}` };
}

export async function getExecutiveDashboard(siteScope: string | undefined, viewer: ReportViewer, days: number) {
  const started = Date.now();
  const kpiDef = getReportDefinition('rep-723')!;
  const tankDef = getReportDefinition('rep-723-tank')!;

  const kpiRes = await runReport(kpiDef, { page: 1, pageSize: 10, sortBy: 'month_liters', sortDir: 'desc' }, siteScope, viewer);
  const tankRes = await runReport(tankDef, { page: 1, pageSize: 100, sortBy: 'fill_pct', sortDir: 'asc' }, siteScope, viewer);

  const extra = await withTenant(async (client) => {
    const dates = (await client.query(`SELECT NOW()::date::text AS today, date_trunc('month', NOW())::date::text AS month_start`)).rows[0];
    const siteParam = siteScope !== undefined ? [siteScope] : [];
    const siteAnd = siteScope !== undefined ? 'AND site_name = $2' : '';

    // Günlük trend: gün serisi ile LEFT JOIN — ikmalsiz gün 0 olarak görünür (grafikte boşluk yok).
    const daily = await client.query(
      `SELECT d.day::date::text AS date, COALESCE(a.liters, 0) AS liters, COALESCE(a.cost, 0) AS cost, COALESCE(a.tx_count, 0)::int AS tx_count
         FROM generate_series(NOW()::date - ($1::int - 1), NOW()::date, INTERVAL '1 day') AS d(day)
         LEFT JOIN (
           SELECT created_at::date AS day, SUM(amount_liters) AS liters, SUM(total_cost) AS cost, COUNT(*) AS tx_count
             FROM transactions WHERE created_at >= NOW()::date - ($1::int - 1) ${siteAnd} GROUP BY created_at::date
         ) a ON a.day = d.day::date
        ORDER BY d.day`,
      [days, ...siteParam]
    );

    // Stok trendi: gün başına her tankın o günkü SON günlük mutabakatı (FUEL-409) — fiziksel ölçüm, tanklar toplanır.
    const stock = await client.query(
      `SELECT x.day::text AS date, SUM(x.physical_liters) AS liters
         FROM (
           SELECT DISTINCT ON (tank_id, period_end::date) tank_id, period_end::date AS day, physical_liters
             FROM stock_reconciliations
            WHERE period_type = 'DAILY' AND period_end >= NOW()::date - ($1::int - 1) ${siteAnd}
            ORDER BY tank_id, period_end::date, period_end DESC
         ) x GROUP BY x.day ORDER BY x.day`,
      [days, ...siteParam]
    );

    const topVehicles = await client.query(
      `SELECT vehicle_plate, SUM(amount_liters) AS liters, SUM(total_cost) AS cost, COUNT(*)::int AS tx_count
         FROM transactions WHERE created_at >= NOW()::date - ($1::int - 1) ${siteAnd}
        GROUP BY vehicle_plate ORDER BY SUM(amount_liters) DESC, vehicle_plate LIMIT 10`,
      [days, ...siteParam]
    );

    return { dates, daily: daily.rows, stock: stock.rows, topVehicles: topVehicles.rows };
  });

  const a = kpiRes.aggregates;
  const today = extra.dates.today as string;
  const monthStart = extra.dates.month_start as string;
  const scopeQ = siteScope !== undefined ? { siteName: siteScope } : {};

  const kpis: Record<string, DashboardKpi> = {
    dailyConsumptionLiters: { value: a.today_liters, unit: 'L', label: 'Bugünkü Tüketim', drilldown: drilldown('rep-711', { startDate: today, endDate: today, ...scopeQ }) },
    monthlyConsumptionLiters: { value: a.month_liters, unit: 'L', label: 'Aylık Tüketim', drilldown: drilldown('rep-711', { startDate: monthStart, endDate: today, ...scopeQ }) },
    monthlyCost: { value: a.month_cost, unit: 'TL', label: 'Aylık Maliyet', drilldown: drilldown('rep-711', { startDate: monthStart, endDate: today, ...scopeQ }) },
    openAlarms: { value: a.open_alarms, unit: 'adet', label: 'Açık Alarm', drilldown: drilldown('rep-716', { status: OPEN_ALARM_STATUSES.join(','), ...scopeQ }) },
    criticalTanks: { value: a.critical_tanks, unit: 'adet', label: 'Kritik Stoktaki Tank', drilldown: drilldown('rep-723-tank', { isCritical: 'true', ...scopeQ }) },
    offlineDevices: { value: a.offline_devices, unit: 'adet', label: 'Çevrimdışı Cihaz', drilldown: drilldown('rep-717-kesinti', { ongoing: '1', ...scopeQ }) }
  };

  const currentStock = tankRes.aggregates.total_level_liters;
  return {
    generatedAt: new Date().toISOString(),
    windowDays: days,
    scope: { siteName: siteScope ?? null },
    dayBoundary: 'server-session-timezone',
    kpis,
    trends: {
      dailyConsumption: extra.daily.map((r: any) => ({ date: r.date, liters: Number(r.liters), transactions: r.tx_count })),
      dailyCost: extra.daily.map((r: any) => ({ date: r.date, cost: Number(r.cost) })),
      stockLevel: extra.stock.map((r: any) => ({ date: r.date, liters: Number(r.liters) })),
      currentStockLiters: currentStock
    },
    topVehicles: extra.topVehicles.map((r: any) => ({
      vehiclePlate: r.vehicle_plate, liters: Number(r.liters), cost: Number(r.cost), transactions: r.tx_count,
      drilldown: drilldown('rep-711', { vehiclePlate: r.vehicle_plate, startDate: dateNDaysBefore(today, days - 1), endDate: today, ...scopeQ })
    })),
    topSites: kpiRes.data.map((r: any) => ({
      siteName: r.site_name, monthLiters: Number(r.month_liters), monthCost: Number(r.month_cost), todayLiters: Number(r.today_liters),
      drilldown: drilldown('rep-711', { siteName: r.site_name, startDate: monthStart, endDate: today })
    })),
    tanks: tankRes.data.map((r: any) => ({
      id: r.id, siteName: r.site_name, tankName: r.tank_name, fuelType: r.fuel_type, capacityLiters: Number(r.capacity_liters),
      levelLiters: Number(r.current_level_liters), fillPct: r.fill_pct === null ? null : Number(r.fill_pct), isCritical: r.is_critical
    })),
    exports: { csv: '/reports/rep-723/export?format=csv', pdf: '/reports/rep-723/export?format=pdf', tanksCsv: '/reports/rep-723-tank/export?format=csv' },
    meta: { durationMs: Date.now() - started }
  };
}

/** 'YYYY-MM-DD' - n gün (takvim aritmetiği; saat dilimi kaymasına açık DEĞİL — UTC üzerinde). */
function dateNDaysBefore(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}
