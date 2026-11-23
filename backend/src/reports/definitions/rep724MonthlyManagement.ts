import { registerReport } from '../reportRegistry';
import { ReportDefinition } from '../reportTypes';
import { BadRequestError } from '../../utils/errors';

/**
 * REP-724 (#210) — Aylık yönetim raporunun ÖLÇÜLEN VERİ bölümü (REP-703 kayıtlı raporu).
 *
 * Yönetim raporunun (services/monthlyManagementReportService.ts) iki katmanı vardır ve okuyucunun karıştırmaması
 * için AYRI tutulur:
 *   1) ÖLÇÜLEN VERİ  — bu rapor. Sistem kayıtlarından SQL ile hesaplanır. Yapay zekâ bu sayıları ÜRETMEZ.
 *   2) YAPAY ZEKÂ YORUMU — Gemini'nin bu sayılar üzerine yazdığı özet/bulgu/risk/öneri; her iddiası bu raporun
 *      verisiyle çapraz doğrulanır (bkz. verifyNarrative) ve ayrı bir kutuda "model yorumu" olarak gösterilir.
 * Yönetim raporunun sayıları (toplam, şantiye satırları) bu tanımın `runReport`/`streamReportExport` çıktısından ALINIR;
 * bu yüzden JSON, CSV, PDF, XLSX ve e-posta ekindeki PDF AYNI kaynaktan beslenir ("aynı veriyi tutarlı üretmeli").
 *
 * TANIMLAR:
 *  - Ay: `month=YYYY-MM` (varsayılan: bir ÖNCEKİ takvim ayı). Gün sınırı filtre motorunun `::date` kuralıyla AYNI
 *    (sunucu oturum saat dilimi) — rep-711'i aynı tarihlerle açan biri birebir aynı ikmalleri görür.
 *  - Litre/tutar/ikmal: ayın `transactions` satırları; tutar INV-1503'ün DONDURULMUŞ `total_cost`'u (fiyatsız ikmal 0 katkı).
 *  - Önceki ay: bir önceki takvim ayı (değişim % için); önceki ay 0 ise değişim yüzdesi TANIMSIZ (boş) — sonsuz yüzde uydurulmaz.
 *  - Alarm: ay içinde İLK görülen (`first_seen_at`) alarm sayısı (durumundan bağımsız). Şantiyesiz alarmlar '-' satırındadır ve
 *    yalnızca tenant geneli görüntüleyene (SITE_MANAGER kapsamı `site_name = kendi şantiyesi`) görünür.
 *
 * Excel çıktısı: bu ticketle REP-703 çatısına `format=xlsx` eklendi (reports/xlsxExport.ts) — CSV/PDF ile aynı satırlar.
 */
export const MONTH_FORMAT = /^\d{4}-(0[1-9]|1[0-2])$/;

export function assertValidMonth(month: unknown): asserts month is string {
  if (typeof month !== 'string' || !MONTH_FORMAT.test(month)) {
    throw new BadRequestError("month 'YYYY-MM' biçiminde olmalıdır (örn. 2026-02).", { error: 'INVALID_MONTH' });
  }
}

const ROLES: ReportDefinition['allowedRoles'] = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'];
const num2 = (v: unknown): string => (v === null || v === undefined ? '-' : Number(v).toFixed(2));
const pct1 = (v: unknown): string => (v === null || v === undefined ? '-' : Number(v).toFixed(1));

export const rep724MonthlyManagement: ReportDefinition = {
  id: 'rep-724',
  title: 'Aylık Yönetim Raporu — Ölçülen Veri (REP-724)',
  description: 'Şantiye başına ayın toplam litre/tutar/ikmal sayısı, önceki aya göre değişim ve alarm sayısı. month=YYYY-MM (varsayılan: önceki ay). Yapay zekâ yorumu bu rapora dahil DEĞİLDİR; ölçülen veridir.',
  table: `(
    WITH w AS (
      SELECT to_date({{month::text|to_char(date_trunc('month', now() - interval '1 month'), 'YYYY-MM')}} || '-01', 'YYYY-MM-DD') AS m_start
    ), win AS (
      SELECT m_start, (m_start + interval '1 month')::date AS m_end, (m_start - interval '1 month')::date AS p_start FROM w
    ),
    cur AS (
      SELECT COALESCE(t.site_name, '-') AS site_name, SUM(t.amount_liters) AS liters, SUM(t.total_cost) AS cost, COUNT(*)::int AS dispenses
      FROM transactions t, win WHERE t.created_at >= win.m_start AND t.created_at < win.m_end GROUP BY COALESCE(t.site_name, '-')
    ),
    prev AS (
      SELECT COALESCE(t.site_name, '-') AS site_name, SUM(t.amount_liters) AS liters, SUM(t.total_cost) AS cost
      FROM transactions t, win WHERE t.created_at >= win.p_start AND t.created_at < win.m_start GROUP BY COALESCE(t.site_name, '-')
    ),
    al AS (
      SELECT COALESCE(a.site_name, '-') AS site_name, COUNT(*)::int AS alarms
      FROM alarms a, win WHERE a.first_seen_at >= win.m_start AND a.first_seen_at < win.m_end GROUP BY COALESCE(a.site_name, '-')
    ),
    names AS (SELECT site_name FROM cur UNION SELECT site_name FROM prev UNION SELECT site_name FROM al)
    SELECT n.site_name AS id, n.site_name, to_char(win.m_start, 'YYYY-MM') AS period,
      COALESCE(cur.liters, 0) AS liters, COALESCE(cur.cost, 0) AS cost, COALESCE(cur.dispenses, 0) AS dispenses,
      COALESCE(prev.liters, 0) AS prev_liters, COALESCE(prev.cost, 0) AS prev_cost,
      CASE WHEN COALESCE(prev.liters, 0) > 0 THEN round((COALESCE(cur.liters, 0) - prev.liters) / prev.liters * 100, 1) END AS change_pct,
      COALESCE(al.alarms, 0) AS alarms
    FROM names n CROSS JOIN win
    LEFT JOIN cur ON cur.site_name = n.site_name LEFT JOIN prev ON prev.site_name = n.site_name LEFT JOIN al ON al.site_name = n.site_name
  ) c`,
  columns: [
    { key: 'id', header: 'ID' },
    { key: 'site_name', header: 'Şantiye', width: 18 },
    { key: 'period', header: 'Ay', width: 8 },
    { key: 'liters', header: 'Litre', width: 12, format: num2 },
    { key: 'cost', header: 'Tutar (₺)', width: 12, format: num2 },
    { key: 'dispenses', header: 'İkmal', width: 8 },
    { key: 'prev_liters', header: 'Önceki Ay Litre', width: 13, format: num2 },
    { key: 'prev_cost', header: 'Önceki Ay Tutar (₺)', width: 14, format: num2 },
    { key: 'change_pct', header: 'Değişim %', width: 10, format: pct1 },
    { key: 'alarms', header: 'Alarm', width: 8 }
  ],
  filters: [{ key: 'month', column: 'period', type: 'exact', label: 'Ay (YYYY-MM)', beforeAggregation: false }],
  aggregates: [
    { key: 'total_liters', column: 'liters', fn: 'SUM', label: 'Toplam Litre' },
    { key: 'total_cost', column: 'cost', fn: 'SUM', label: 'Toplam Tutar (₺)' },
    { key: 'total_dispenses', column: 'dispenses', fn: 'SUM', label: 'Toplam İkmal' },
    { key: 'total_prev_liters', column: 'prev_liters', fn: 'SUM', label: 'Önceki Ay Toplam Litre' },
    { key: 'total_prev_cost', column: 'prev_cost', fn: 'SUM', label: 'Önceki Ay Toplam Tutar (₺)' },
    { key: 'total_alarms', column: 'alarms', fn: 'SUM', label: 'Toplam Alarm' }
  ],
  allowedRoles: ROLES,
  defaultSort: { column: 'site_name', direction: 'ASC' },
  siteScopeColumn: 'site_name',
  validateQuery: (query) => { if (query.month !== undefined && query.month !== null && query.month !== '') assertValidMonth(query.month); }
};

registerReport(rep724MonthlyManagement);
