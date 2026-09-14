import { registerReport } from '../reportRegistry';
import { ReportDefinition } from '../reportTypes';

/**
 * REP-722 (#179) — Denetim (Audit) Raporu. REP-703 çatısının İKİNCİ kayıtlı
 * raporu — bilerek FARKLI bir tabloya (audit_logs) ve DAHA DAR bir rol
 * kümesine bağlanır (GET /audit-logs ile AYNI kısıtlama: SUPER_ADMIN +
 * COMPANY_OWNER — bkz. routes.ts AUTH-203 notu) ki hem "her rapor kendi
 * tanımıyla farklı bir tabloyu güvenle kapsayabilir" hem de "kullanıcı
 * yalnızca yetkili olduğu raporları görür" AC'si GERÇEK bir karşıtlıkla
 * (REP-711 dört rolde de görünür, REP-722 ikisinde) doğrulanabilsin.
 * `audit_logs` üzerinde `site_name` yok — `siteScopeColumn` KASITLI olarak
 * tanımlanmadı (bu rapor bir şantiye kavramı taşımaz).
 */
export const rep722AuditReport: ReportDefinition = {
  id: 'rep-722',
  title: 'Denetim (Audit) Raporu',
  description: 'Kritik işlemlerin (pompa açma, limit değiştirme, şantiye yetkisi vb.) değiştirilemez denetim izi.',
  table: 'audit_logs',
  columns: [
    { key: 'id', header: 'ID' },
    { key: 'created_at', header: 'Tarih', width: 20, format: (v) => new Date(v as string).toLocaleString('tr-TR') },
    { key: 'user_id', header: 'Kullanıcı', width: 20 },
    { key: 'action', header: 'İşlem', width: 24 },
    { key: 'target_type', header: 'Hedef Tipi', width: 18 },
    { key: 'target_id', header: 'Hedef ID', width: 20 },
    { key: 'ip_address', header: 'IP Adresi', width: 16 }
  ],
  filters: [
    { key: 'startDate', column: 'created_at', type: 'dateFrom', label: 'Başlangıç Tarihi' },
    { key: 'endDate', column: 'created_at', type: 'dateToExclusiveNextDay', label: 'Bitiş Tarihi' },
    { key: 'action', column: 'action', type: 'exact', label: 'İşlem' },
    { key: 'targetType', column: 'target_type', type: 'exact', label: 'Hedef Tipi' },
    { key: 'userId', column: 'user_id', type: 'exact', label: 'Kullanıcı' }
  ],
  allowedRoles: ['SUPER_ADMIN', 'COMPANY_OWNER'],
  defaultSort: { column: 'created_at', direction: 'DESC' }
};

registerReport(rep722AuditReport);
