import { withTenant } from '../db/withTenant';
import { writeAuditLog } from '../utils/auditLog';
import { ReportDefinition, ReportViewer } from './reportTypes';
import { isPiiVisible } from './piiMask';
import { ReportQueryParams } from './reportEngine';

/**
 * REP-720 (#177) AC: "Rapor indirmeleri audit log'a yazılmalıdır."
 *
 * `def.auditExport` olan raporların HER dışa aktarımı (CSV/PDF) AUTH-203'ün
 * `audit_logs` tablosuna `REPORT_EXPORT` olarak düşer: kim (tenant context'ten
 * user_id/ip/trace), hangi rapor, hangi format, hangi filtreler ve çıktının
 * PII'sinin maskeli olup olmadığı. Rol de yazılır (denetçi, "maskesiz indiren"
 * ile "maskeli indireni" ayırt edebilsin).
 *
 * Çağrı akış BAŞLAMADAN yapılır ve bilerek await edilir: kayıt yazılamazsa
 * hata fırlar, HİÇ veri gönderilmez (AUTH-203: "audit yazılamazsa işlem
 * başarısız"). Yalnızca `def.filters`'ta tanımlı anahtarlar kaydedilir —
 * istemcinin gönderdiği rastgele parametreler denetim kaydına sızmaz.
 * REP-722: `format: 'view'` (JSON görüntüleme) `REPORT_VIEW` olarak yazılır (`def.auditAccess`).
 * Zamanlanmış gönderim/arşiv yolu (viewer yok → her zaman MASKELİ) bu kayda
 * dahil DEĞİLDİR: kişisel veri içermeyen çıktı için ayrı bir iz gerekmez.
 */
export async function auditReportExport(
  def: ReportDefinition,
  viewer: ReportViewer,
  format: 'csv' | 'pdf' | 'xlsx' | 'view',
  query: ReportQueryParams
): Promise<void> {
  const filters: Record<string, string> = {};
  for (const f of def.filters) {
    const v = query[f.key];
    if (v !== undefined && v !== null && v !== '') filters[f.key] = String(v).slice(0, 200);
  }
  await withTenant(async (client) => {
    await writeAuditLog(client, {
      action: format === 'view' ? 'REPORT_VIEW' : 'REPORT_EXPORT',
      targetType: 'report',
      targetId: def.id,
      afterValue: { format, filters, role: viewer.role, piiMasked: def.columns.some((c) => c.pii) ? !isPiiVisible(def, viewer) : false }
    });
  });
}
