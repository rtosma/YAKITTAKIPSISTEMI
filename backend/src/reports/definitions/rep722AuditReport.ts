import { registerReport } from '../reportRegistry';
import { ReportDefinition } from '../reportTypes';

/**
 * REP-722 (#179) — Denetim (Audit) Raporu. REP-703 çatısının İKİNCİ kayıtlı
 * raporu (ilk sürümü çatının "farklı tablo + dar rol kümesi" karşıtlığını
 * doğrulamak içindi); REP-722 ticket'ıyla ticket'ın tüm sütunlarına genişletildi.
 *
 * KAYNAK: AUTH-203 `audit_logs` (append-only: app_user'dan UPDATE/DELETE/TRUNCATE
 * geri alınmıştır — rapor YALNIZCA okur, hiçbir satırı değiştirmez/filtrelemeyle
 * gizlemez: LEFT JOIN ile sistem kayıtları (user_id NULL) ve silinmiş kullanıcıların
 * kayıtları da görünür → "tam kapsam").
 *
 * SÜTUNLAR: tarih-saat, kullanıcı (kullanıcı adı; silinmişse kimliği), ROL, IP,
 * işlem tipi, hedef (tip + id), öncesi/sonrası ÖZETİ, trace_id.
 *  - Rol: audit_logs'ta rol saklanmaz; `users.role`'den okunur → ROLÜN ŞU ANKİ değeridir
 *    (kullanıcının rolü sonradan değiştiyse eski kayıtlar güncel rolle görünür; silinmiş
 *    kullanıcı için '-').
 *  - Öncesi/sonrası özeti: JSON nesnelerinde YALNIZCA DEĞİŞEN anahtarlar "anahtar: eski → yeni"
 *    (∅ = yok), en fazla 300 karakter; nesne olmayan (dizi/skaler) değerlerde ham metin kırpılır.
 *    Parola/secret/token alanları zaten yazım anında maskelenir (utils/auditLog.ts).
 *
 * KRİTİK İŞLEMLER (öne çıkarma): `critical_category` — KALIBRASYON (CALIBRATION_*),
 * LIMIT (VEHICLE_FUEL_LIMIT_*, FUEL_QUOTA_*), MANUEL_IKMAL (MANUAL_DISPENSE_*),
 * KART_BLOKAJI (RFID_CARD_*). Sütun + `critical`/`criticalOnly` filtreleri + özet sayaçları.
 *
 * RAPOR ERİŞİM KAYDI (AC): `auditAccess` + `auditExport` — bu raporun HER görüntülenmesi
 * (REPORT_VIEW) ve dışa aktarımı (REPORT_EXPORT) kim/ne zaman/hangi filtrelerle audit_logs'a
 * yazılır (çatı, kaydı veri ÇIKMADAN önce yazar; yazılamazsa veri verilmez). Kayıt sorgudan
 * ÖNCE yazıldığı için erişimin kendisi de aynı raporda görünür.
 *
 * ERİŞİM: SUPER_ADMIN + COMPANY_OWNER (GET /audit-logs ile AYNI kısıt). Ticket "SITE_MANAGER
 * yalnızca kendi şantiyesini görür" der; ancak `audit_logs`'ta şantiye alanı yoktur ve denetim
 * izi şantiyeler arası eylemleri (ör. çapraz şantiye izinleri, yetki değişiklikleri) de kapsar —
 * şantiye bazlı kısmi bir denetim izi "tam kapsam" garantisini bozar. Bu yüzden SITE_MANAGER'a
 * AÇILMADI (bilinçli uyarlama).
 *
 * Excel çıktısı: REP-711'deki KAPSAM UYARLAMASI geçerli (REP-703 CSV+PDF üretir).
 */

const fmtDate = (v: unknown): string => new Date(v as string).toLocaleString('tr-TR');
const dash = (v: unknown): string => (v === null || v === undefined || v === '' ? '-' : String(v));
const CATEGORY_TEXT: Record<string, string> = {
  KALIBRASYON: 'KALİBRASYON',
  LIMIT: 'LİMİT DEĞİŞİKLİĞİ',
  MANUEL_IKMAL: 'MANUEL İKMAL',
  KART_BLOKAJI: 'KART BLOKAJI'
};

export const rep722AuditReport: ReportDefinition = {
  id: 'rep-722',
  title: 'Denetim (Audit) Raporu',
  description: 'Kritik işlemlerin (kalibrasyon, limit değişikliği, manuel ikmal, kart blokajı vb.) değiştirilemez denetim izi: kim, ne zaman, hangi IP/trace ile, hangi kayıtta, neyi değiştirdi. Raporun kendi görüntüleme/indirme erişimleri de kayda alınır.',
  table: `(
    SELECT a.id, a.created_at, a.user_id, COALESCE(u.username, a.user_id) AS username, u.role AS user_role, a.ip_address,
      a.action, a.target_type, a.target_id, a.trace_id,
      CASE WHEN starts_with(a.action, 'CALIBRATION_') THEN 'KALIBRASYON'
           WHEN starts_with(a.action, 'VEHICLE_FUEL_LIMIT_') OR starts_with(a.action, 'FUEL_QUOTA_') THEN 'LIMIT'
           WHEN starts_with(a.action, 'MANUAL_DISPENSE_') THEN 'MANUEL_IKMAL'
           WHEN starts_with(a.action, 'RFID_CARD_') THEN 'KART_BLOKAJI' END AS critical_category,
      COALESCE(s.summary, left(COALESCE(a.after_value::text, a.before_value::text), 300)) AS change_summary
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.user_id
    LEFT JOIN LATERAL (
      SELECT left(string_agg(ks.k || ': ' || COALESCE(a.before_value ->> ks.k, '∅') || ' → ' || COALESCE(a.after_value ->> ks.k, '∅'), '; ' ORDER BY ks.k), 300) AS summary
      FROM (
        SELECT jsonb_object_keys(
          COALESCE(CASE WHEN jsonb_typeof(a.before_value) = 'object' THEN a.before_value END, '{}'::jsonb) ||
          COALESCE(CASE WHEN jsonb_typeof(a.after_value) = 'object' THEN a.after_value END, '{}'::jsonb)
        ) AS k
      ) ks
      WHERE (a.before_value ->> ks.k) IS DISTINCT FROM (a.after_value ->> ks.k)
    ) s ON TRUE
  ) c`,
  columns: [
    { key: 'id', header: 'ID' },
    { key: 'created_at', header: 'Tarih-Saat', width: 16, format: fmtDate },
    { key: 'username', header: 'Kullanıcı', width: 14, format: dash },
    { key: 'user_role', header: 'Rol', width: 12, format: dash },
    { key: 'ip_address', header: 'IP Adresi', width: 12, format: dash },
    { key: 'action', header: 'İşlem', width: 22 },
    { key: 'critical_category', header: 'Kritik', width: 12, format: (v) => (v ? CATEGORY_TEXT[String(v)] ?? String(v) : '-') },
    { key: 'target_type', header: 'Hedef Tipi', width: 14, format: dash },
    { key: 'target_id', header: 'Hedef ID', width: 16, format: dash },
    { key: 'change_summary', header: 'Öncesi → Sonrası', width: 30, format: dash },
    { key: 'trace_id', header: 'Trace ID', width: 14, format: dash },
    { key: 'user_id', header: 'Kullanıcı ID', width: 12, format: dash }
  ],
  filters: [
    { key: 'startDate', column: 'created_at', type: 'dateFrom', label: 'Başlangıç Tarihi' },
    { key: 'endDate', column: 'created_at', type: 'dateToExclusiveNextDay', label: 'Bitiş Tarihi' },
    { key: 'action', column: 'action', type: 'in', label: 'İşlem Tipi (virgülle çoklu)' },
    { key: 'targetType', column: 'target_type', type: 'exact', label: 'Hedef Tipi' },
    { key: 'targetId', column: 'target_id', type: 'exact', label: 'Hedef Kayıt ID' },
    { key: 'userId', column: 'user_id', type: 'exact', label: 'Kullanıcı ID' },
    { key: 'username', column: 'username', type: 'exact', label: 'Kullanıcı Adı' },
    { key: 'userRole', column: 'user_role', type: 'exact', label: 'Rol' },
    { key: 'traceId', column: 'trace_id', type: 'exact', label: 'Trace ID' },
    { key: 'critical', column: 'critical_category', type: 'exact', label: 'Kritik Kategori (KALIBRASYON / LIMIT / MANUEL_IKMAL / KART_BLOKAJI)' },
    { key: 'criticalOnly', column: 'CASE WHEN critical_category IS NOT NULL THEN 1 ELSE 0 END', type: 'numberGte', label: 'Yalnız kritik işlemler (1)' }
  ],
  aggregates: [
    { key: 'total_events', column: 'id', fn: 'COUNT', label: 'Toplam Kayıt' },
    { key: 'critical_events', column: 'CASE WHEN critical_category IS NOT NULL THEN 1 ELSE 0 END', fn: 'SUM', label: 'Kritik İşlem' },
    { key: 'report_accesses', column: `CASE WHEN action IN ('REPORT_VIEW', 'REPORT_EXPORT') THEN 1 ELSE 0 END`, fn: 'SUM', label: 'Rapor Erişimi (görüntüleme/indirme)' }
  ],
  allowedRoles: ['SUPER_ADMIN', 'COMPANY_OWNER'],
  auditExport: true,
  auditAccess: true,
  defaultSort: { column: 'created_at', direction: 'DESC' }
};

registerReport(rep722AuditReport);
