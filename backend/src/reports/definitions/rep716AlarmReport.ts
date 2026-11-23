import { registerReport } from '../reportRegistry';
import { ReportDefinition } from '../reportTypes';
import { SOURCE_WHERE_MARKER } from '../reportEngine';

/**
 * REP-716 (#173) — Anomali ve Alarm Raporu.
 *
 * KAYNAK: AI-507 birleşik alarm yaşam döngüsü (`alarms`). Tekrar eden olaylar
 * ZATEN gruplanmıştır (aynı kök neden = tek alarm satırı + event_count, bkz.
 * tenantDb.ts raiseAlarm) — "tekrar eden olaylar gruplanmış gösterilmeli" AC'si
 * bu yüzden yapısal olarak sağlanır: satır başına `event_count` (Tekrar) +
 * ilk/son görülme.
 *
 * İKİ TANIM:
 *  - `rep-716`     : alarm başına DETAY (tip, konu/şantiye, şiddet, durum, atanan,
 *                    çözüm süresi, tekrar sayısı) + özet metrikler (aggregate'ler),
 *  - `rep-716-tip` : şantiye × alarm TİPİ (kategori) kırılımı — "en sık tekrar
 *                    eden anomali tipleri" (varsayılan sıra: toplam tekrar azalan).
 *
 * ÖZET METRİKLERİ (Teknik Not: raporun özetinde öne çıkarılmalı):
 *  - Yanlış pozitif oranı = FALSE_POSITIVE / (RESOLVED + FALSE_POSITIVE) —
 *    AI-507'nin getFalsePositiveFeedback'iyle AYNI tanım (kapatılmış alarmlar
 *    üzerinden); açık alarmlar paydaya girmez.
 *  - Ortalama çözüm süresi = kapatılmış (RESOLVED/FALSE_POSITIVE) alarmların
 *    resolved_at − first_seen_at ortalaması (saat). Yeniden açılıp kapatılan bir
 *    alarm ilk görülmesinden itibaren sayılır (grup ömrü).
 *  - Hiç kapatılmış alarm yoksa iki ortalama da 0 döner (aggregate 0'a
 *    sarılır) — bu yüzden `closed_count` HER ZAMAN yanında verilir: 0 ise oran
 *    "bilinmiyor" demektir, "%0 yanlış pozitif" DEĞİL.
 *  - Açık alarmın çözüm süresi hücresi boş değil 'AÇIK' yazar.
 *
 * Kırılım filtresi (`rep-716-tip`): tarih aralığı GRUPLAMADAN ÖNCE uygulanır
 * (`beforeAggregation` — REP-703'e bu ticket'le eklenen genişletme), böylece
 * "en sık tekrar eden tipler" seçilen aralık için doğru sıralanır.
 *
 * SITE_MANAGER yalnızca kendi şantiyesinin alarmlarını görür (Teknik Not);
 * şantiyesi olmayan (tenant geneli) alarmlar yalnızca SUPER_ADMIN/COMPANY_OWNER'a
 * görünür. (Mevcut GET /alarms ucu şantiye kapsamı UYGULAMAZ — bu rapor
 * ticket'ın kuralını uygular.)
 *
 * Excel çıktısı: REP-711'deki KAPSAM UYARLAMASI geçerli (REP-703 CSV+PDF üretir).
 */

const fmtDate = (v: unknown): string => new Date(v as string).toLocaleString('tr-TR');
const dash = (v: unknown): string => (v === null || v === undefined || v === '' ? '-' : String(v));
const num2 = (v: unknown): string => (v === null || v === undefined ? '-' : Number(v).toFixed(2));
const ROLES: ReportDefinition['allowedRoles'] = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'];
const CLOSED = `('RESOLVED', 'FALSE_POSITIVE')`;

export const rep716AlarmDetail: ReportDefinition = {
  id: 'rep-716',
  title: 'Anomali ve Alarm Raporu',
  description: 'Alarm başına: tarih, tip, şantiye/konu, şiddet, durum, atanan, çözüm süresi ve tekrar sayısı; özet: yanlış pozitif oranı ve ortalama çözüm süresi.',
  table: `(
    SELECT a.id, a.first_seen_at, a.last_seen_at, a.category, a.severity, a.title, a.site_name,
      CASE WHEN a.subject_id IS NOT NULL THEN COALESCE(a.subject_type, '') || ': ' || a.subject_id END AS subject,
      a.subject_id, a.status, u.username AS assignee, a.event_count, a.escalation_level, a.resolved_at,
      CASE WHEN a.status IN ${CLOSED} AND a.resolved_at IS NOT NULL
           THEN round(EXTRACT(EPOCH FROM (a.resolved_at - a.first_seen_at)) / 3600, 2) END AS resolution_hours,
      CASE WHEN a.status = 'FALSE_POSITIVE' THEN 100.0 WHEN a.status = 'RESOLVED' THEN 0.0 END AS fp_indicator,
      CASE WHEN a.status IN ${CLOSED} THEN 1 ELSE 0 END AS is_closed
    FROM alarms a
    LEFT JOIN users u ON u.id = a.assignee_id
  ) c`,
  columns: [
    { key: 'id', header: 'ID' },
    { key: 'first_seen_at', header: 'Tarih', width: 15, format: fmtDate },
    { key: 'category', header: 'Tip', width: 18 },
    { key: 'severity', header: 'Şiddet', width: 9 },
    { key: 'title', header: 'Başlık', width: 26 },
    { key: 'site_name', header: 'Şantiye', width: 16, format: dash },
    { key: 'subject', header: 'Konu (tank/araç)', width: 16, format: dash },
    { key: 'status', header: 'Durum', width: 12 },
    { key: 'assignee', header: 'Atanan', width: 12, format: dash },
    { key: 'resolution_hours', header: 'Çözüm Süresi (saat)', width: 10, format: (v) => (v === null || v === undefined ? 'AÇIK' : Number(v).toFixed(2)) },
    { key: 'event_count', header: 'Tekrar', width: 7 },
    { key: 'last_seen_at', header: 'Son Görülme', width: 15, format: fmtDate }
  ],
  filters: [
    { key: 'startDate', column: 'first_seen_at', type: 'dateFrom', label: 'Başlangıç Tarihi' },
    { key: 'endDate', column: 'first_seen_at', type: 'dateToExclusiveNextDay', label: 'Bitiş Tarihi' },
    { key: 'category', column: 'category', type: 'exact', label: 'Alarm Tipi' },
    { key: 'status', column: 'status', type: 'in', label: 'Durum (virgülle çoklu — REP-723 "açık alarm" bağlantısı için)' },
    { key: 'severity', column: 'severity', type: 'exact', label: 'Şiddet' },
    { key: 'siteName', column: 'site_name', type: 'exact', label: 'Şantiye' },
    { key: 'assignee', column: 'assignee', type: 'exact', label: 'Atanan (kullanıcı adı)' },
    { key: 'subjectId', column: 'subject_id', type: 'exact', label: 'Konu (tank id / plaka)' }
  ],
  aggregates: [
    { key: 'total_alarms', column: 'id', fn: 'COUNT', label: 'Toplam Alarm' },
    { key: 'total_events', column: 'event_count', fn: 'SUM', label: 'Toplam Olay (tekrar dahil)' },
    { key: 'closed_count', column: 'is_closed', fn: 'SUM', label: 'Kapatılmış Alarm (oranların paydası)' },
    { key: 'false_positive_rate_pct', column: 'fp_indicator', fn: 'AVG', label: 'Yanlış Pozitif Oranı (%)' },
    { key: 'avg_resolution_hours', column: 'resolution_hours', fn: 'AVG', label: 'Ortalama Çözüm Süresi (saat)' }
  ],
  allowedRoles: ROLES,
  defaultSort: { column: 'first_seen_at', direction: 'DESC' },
  siteScopeColumn: 'site_name'
};

export const rep716AlarmTypes: ReportDefinition = {
  id: 'rep-716-tip',
  title: 'Alarm Tipi Kırılımı (REP-716)',
  description: 'Şantiye × alarm tipi: alarm sayısı, toplam tekrar, açık/kapalı, yanlış pozitif oranı ve ortalama çözüm süresi — en sık tekrar eden tipler önce.',
  table: `(
    SELECT COALESCE(a.site_name, '-') || ':' || a.category AS id, a.site_name, a.category,
      COUNT(*)::int AS alarm_count,
      SUM(a.event_count)::int AS total_events,
      COUNT(*) FILTER (WHERE a.status NOT IN ${CLOSED})::int AS open_count,
      COUNT(*) FILTER (WHERE a.status IN ${CLOSED})::int AS closed_count,
      COUNT(*) FILTER (WHERE a.status = 'FALSE_POSITIVE')::int AS false_positive_count,
      round(AVG(CASE WHEN a.status = 'FALSE_POSITIVE' THEN 100.0 WHEN a.status = 'RESOLVED' THEN 0.0 END), 2) AS false_positive_rate_pct,
      round(AVG(EXTRACT(EPOCH FROM (a.resolved_at - a.first_seen_at)) / 3600) FILTER (WHERE a.status IN ${CLOSED} AND a.resolved_at IS NOT NULL), 2) AS avg_resolution_hours,
      MAX(a.last_seen_at) AS last_seen_at
    FROM alarms a
    WHERE TRUE ${SOURCE_WHERE_MARKER}
    GROUP BY a.site_name, a.category
  ) c`,
  columns: [
    { key: 'id', header: 'ID' },
    { key: 'category', header: 'Alarm Tipi', width: 22 },
    { key: 'site_name', header: 'Şantiye', width: 18, format: dash },
    { key: 'alarm_count', header: 'Alarm', width: 8 },
    { key: 'total_events', header: 'Toplam Tekrar', width: 10 },
    { key: 'open_count', header: 'Açık', width: 7 },
    { key: 'closed_count', header: 'Kapalı', width: 7 },
    { key: 'false_positive_count', header: 'Yanlış Pozitif', width: 10 },
    { key: 'false_positive_rate_pct', header: 'YP Oranı %', width: 9, format: num2 },
    { key: 'avg_resolution_hours', header: 'Ort. Çözüm (saat)', width: 11, format: num2 },
    { key: 'last_seen_at', header: 'Son Görülme', width: 15, format: fmtDate }
  ],
  filters: [
    { key: 'startDate', column: 'a.first_seen_at', type: 'dateFrom', label: 'Başlangıç Tarihi (ilk görülme)', beforeAggregation: true },
    { key: 'endDate', column: 'a.first_seen_at', type: 'dateToExclusiveNextDay', label: 'Bitiş Tarihi (ilk görülme)', beforeAggregation: true },
    { key: 'category', column: 'category', type: 'exact', label: 'Alarm Tipi' },
    { key: 'siteName', column: 'site_name', type: 'exact', label: 'Şantiye' }
  ],
  aggregates: [
    { key: 'total_alarms', column: 'alarm_count', fn: 'SUM', label: 'Toplam Alarm' },
    { key: 'total_events', column: 'total_events', fn: 'SUM', label: 'Toplam Tekrar' }
  ],
  allowedRoles: ROLES,
  defaultSort: { column: 'total_events', direction: 'DESC' },
  siteScopeColumn: 'site_name'
};

registerReport(rep716AlarmDetail);
registerReport(rep716AlarmTypes);
