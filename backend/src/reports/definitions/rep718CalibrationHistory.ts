import { registerReport } from '../reportRegistry';
import { ReportDefinition } from '../reportTypes';

/**
 * REP-718 (#175) — Kalibrasyon Geçmişi Raporu.
 *
 * KAYNAK: FUEL-404'ün `calibration_commands` tablosu (append-only: geri alma da
 * YENİ bir komuttur, satır silinmez/değişmez) + `calibration_test_intakes`
 * (doğrulama alımı). Rapor hiçbir K-factor'ü yeniden hesaplamaz.
 *
 * - Değişim % = (yeni − eski) / eski × 100. İlk kalibrasyonda (eski yok/0) NULL —
 *   raporda 'İLK' yazar (sıfıra bölme/uydurma yok).
 * - Kullanıcı = talep eden kullanıcının adı (silinmişse kimliği); "kim" AC'si için
 *   ikinci onaylayan da ayrı sütunda (±%20 üstü değişiklikler ikinci onay ister).
 * - Ack durumu = komut durumunun okunur karşılığı: ONAYLANDI → ACK ALINDI,
 *   BEKLIYOR → ACK BEKLİYOR, REDDEDILDI → CİHAZ REDDETTİ (NACK),
 *   ZAMAN_ASIMI → ACK GELMEDİ, IKINCI_ONAY_BEKLIYOR → İKİNCİ ONAY BEKLİYOR.
 * - Test alımı sapması = bu komuta bağlı (verifies_calibration_command_id) EN
 *   SON doğrulama alımının |ölçülen − referans| / referans oranı (%). Doğrulama
 *   alımı yapılmamışsa '-' (sapma "0" DEĞİL — ölçülmemiş).
 *
 * SIK KALİBRASYON (Teknik Not: donanım arızası VEYA manipülasyon): satırın kendi
 * anında biten 30 günlük kayan pencerede AYNI cihaz için komut sayısı
 * (`calibrations_30d`); ≥ 3 ise satır SIK işaretlenir (yani ÜÇÜNCÜ ve sonraki
 * komut). Tüm komutlar sayılır (durum/geri alma ayırt etmeden — her biri bir
 * K-factor değişikliği DENEMESİdir). Eşik (3/30 gün) bu dosyada sabittir.
 * Pencere filtrelerden ÖNCE hesaplanır: tarih filtresi uygulansa da sayı gerçektir.
 *
 * Şantiye = cihazın ŞU ANKİ şantiyesi (hardware_devices; cihaz silinmişse NULL —
 * SITE_MANAGER görmez, SUPER_ADMIN/COMPANY_OWNER görür).
 *
 * GÖRÜNÜRLÜK NOTU: mevcut GET /devices/:id/calibration-history yalnızca
 * SUPER_ADMIN/COMPANY_OWNER'a açıktır; bu rapor ticket'ın "SITE_MANAGER yalnızca
 * kendi şantiyesini görür" kuralı gereği SITE_MANAGER'a da (şantiye kapsamıyla) açıktır.
 *
 * Excel çıktısı: REP-711'deki KAPSAM UYARLAMASI geçerli (REP-703 CSV+PDF üretir).
 */

const FREQUENT_THRESHOLD = 3;
const FREQUENT_WINDOW_DAYS = 30;

const fmtDate = (v: unknown): string => new Date(v as string).toLocaleString('tr-TR');
const dash = (v: unknown): string => (v === null || v === undefined || v === '' ? '-' : String(v));
const kf = (v: unknown): string => (v === null || v === undefined ? '-' : Number(v).toFixed(4));
const STATUS_TEXT: Record<string, string> = {
  ONAYLANDI: 'ACK ALINDI',
  BEKLIYOR: 'ACK BEKLİYOR',
  REDDEDILDI: 'CİHAZ REDDETTİ (NACK)',
  ZAMAN_ASIMI: 'ACK GELMEDİ',
  IKINCI_ONAY_BEKLIYOR: 'İKİNCİ ONAY BEKLİYOR'
};

export const rep718CalibrationHistory: ReportDefinition = {
  id: 'rep-718',
  title: 'Kalibrasyon Geçmişi Raporu',
  description: 'K-factor değişiklikleri: cihaz, tarih, eski/yeni K-factor, değişim %, kullanıcı, gerekçe, doğrulama alımı sapması, ack durumu ve sık kalibrasyon vurgusu.',
  table: `(
    SELECT x.*, abs(x.change_pct) AS abs_change_pct, (x.calibrations_30d >= ${FREQUENT_THRESHOLD}) AS is_frequent
    FROM (
      SELECT c.id, c.created_at, c.device_id, d.site_name, c.previous_k_factor, c.new_k_factor,
        CASE WHEN c.previous_k_factor IS NOT NULL AND c.previous_k_factor <> 0
             THEN round((c.new_k_factor - c.previous_k_factor) / c.previous_k_factor * 100, 2) END AS change_pct,
        COALESCE(u.username, c.requested_by) AS requested_by_name,
        c.reason, vi.deviation_pct AS verification_deviation_pct, c.status, c.acked_at, c.is_rollback,
        c.requires_second_approval, COALESCE(ua.username, c.approved_by) AS approved_by_name,
        COUNT(*) OVER (PARTITION BY c.device_id ORDER BY c.created_at RANGE BETWEEN INTERVAL '${FREQUENT_WINDOW_DAYS} days' PRECEDING AND CURRENT ROW)::int AS calibrations_30d
      FROM calibration_commands c
      LEFT JOIN hardware_devices d ON d.device_id = c.device_id
      LEFT JOIN users u ON u.id = c.requested_by
      LEFT JOIN users ua ON ua.id = c.approved_by
      LEFT JOIN LATERAL (
        SELECT round(t.deviation_ratio * 100, 2) AS deviation_pct FROM calibration_test_intakes t
         WHERE t.verifies_calibration_command_id = c.id ORDER BY t.created_at DESC LIMIT 1
      ) vi ON TRUE
    ) x
  ) c`,
  columns: [
    { key: 'id', header: 'ID' },
    { key: 'created_at', header: 'Tarih', width: 15, format: fmtDate },
    { key: 'device_id', header: 'Cihaz', width: 16 },
    { key: 'site_name', header: 'Şantiye', width: 14, format: dash },
    { key: 'previous_k_factor', header: 'Eski K', width: 8, format: kf },
    { key: 'new_k_factor', header: 'Yeni K', width: 8, format: kf },
    { key: 'change_pct', header: 'Değişim %', width: 9, format: (v) => (v === null || v === undefined ? 'İLK' : `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}`) },
    { key: 'requested_by_name', header: 'Kullanıcı', width: 12 },
    { key: 'approved_by_name', header: 'İkinci Onay', width: 11, format: dash },
    { key: 'reason', header: 'Gerekçe', width: 22 },
    { key: 'verification_deviation_pct', header: 'Test Alımı Sapması %', width: 10, format: (v) => (v === null || v === undefined ? '-' : Number(v).toFixed(2)) },
    { key: 'status', header: 'Ack Durumu', width: 14, format: (v) => STATUS_TEXT[String(v)] ?? String(v) },
    { key: 'is_rollback', header: 'Geri Alma', width: 8, format: (v) => (v ? 'EVET' : '-') },
    { key: 'calibrations_30d', header: `Son ${FREQUENT_WINDOW_DAYS}g Kalibrasyon`, width: 9 },
    { key: 'is_frequent', header: 'Sık Kalibrasyon', width: 10, format: (v) => (v ? 'SIK' : '-') }
  ],
  filters: [
    { key: 'startDate', column: 'created_at', type: 'dateFrom', label: 'Başlangıç Tarihi' },
    { key: 'endDate', column: 'created_at', type: 'dateToExclusiveNextDay', label: 'Bitiş Tarihi' },
    { key: 'deviceId', column: 'device_id', type: 'ilike', label: 'Cihaz (içerir)' },
    { key: 'siteName', column: 'site_name', type: 'exact', label: 'Şantiye' },
    { key: 'requestedBy', column: 'requested_by_name', type: 'exact', label: 'Kullanıcı (kullanıcı adı)' },
    { key: 'status', column: 'status', type: 'exact', label: 'Ack Durumu (ONAYLANDI / BEKLIYOR / REDDEDILDI / ZAMAN_ASIMI / IKINCI_ONAY_BEKLIYOR)' },
    { key: 'minChangePct', column: 'abs_change_pct', type: 'numberGte', label: 'Mutlak Değişim En Az (%)' },
    { key: 'frequentOnly', column: 'is_frequent', type: 'exact', label: 'Yalnız Sık Kalibrasyon (true)' }
  ],
  aggregates: [
    { key: 'total_changes', column: 'id', fn: 'COUNT', label: 'Toplam Değişiklik' },
    { key: 'frequent_count', column: 'CASE WHEN is_frequent THEN 1 ELSE 0 END', fn: 'SUM', label: 'Sık Kalibrasyon İşaretli' },
    { key: 'second_approval_count', column: 'CASE WHEN requires_second_approval THEN 1 ELSE 0 END', fn: 'SUM', label: 'İkinci Onay Gerektiren' }
  ],
  allowedRoles: ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'],
  defaultSort: { column: 'created_at', direction: 'DESC' },
  siteScopeColumn: 'site_name'
};

registerReport(rep718CalibrationHistory);
