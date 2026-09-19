import { registerReport } from '../reportRegistry';
import { ReportDefinition } from '../reportTypes';
import { SOURCE_WHERE_MARKER } from '../reportEngine';
import { DRIVER_SCORE_WEIGHTS } from '../../db/tenantDb';

/**
 * REP-720 (#177) — Sürücü Bazlı Rapor.
 *
 * KAYNAK: `transactions` (ikmal istatistikleri) + AI-504 `transaction_anomaly_flags`
 * (mesai dışı) + AI-506 `driver_behavior_scores` (davranış skoru). Rapor hiçbir
 * skoru yeniden HESAPLAMAZ — en son AI-506 hesaplama turunun kaydını gösterir.
 *
 * İKİ TANIM:
 *  - `rep-720`      : sürücü × şantiye satırı: alım sayısı, toplam/ortalama litre,
 *                     mesai dışı alım sayısı, davranış skoru,
 *  - `rep-720-skor` : skor BİLEŞENLERİ (AC "detayına inebilme") — sürücü başına
 *                     her AI-506 hesaplama turu: 5 bileşenin oranı (%) ve skordan
 *                     düşürdüğü PUAN (oran × ağırlık; ağırlıklar AI-506'nın sabitidir,
 *                     buraya kopyalanmaz — `DRIVER_SCORE_WEIGHTS` import edilir).
 *
 * SÜRÜCÜ × ŞANTİYE: bir sürücü birden çok şantiyede ikmal alabilir. Satır
 * (sürücü, şantiye) çiftidir — böylece SITE_MANAGER'ın şantiye kapsamı, başka
 * şantiyelerdeki alımları toplamına KATMADAN doğru uygulanır. Davranış skoru ise
 * AI-506 gereği SÜRÜCÜ düzeyindedir (tüm şantiyeler üzerinden hesaplanır) ve
 * her şantiye satırında aynı gösterilir — bu bilinçli bir sınırdır.
 *
 * DÖNEM = ikmal tarihi (`created_at`) aralığı; gruplamadan ÖNCE uygulanır
 * (`beforeAggregation`), mesai dışı sayısı da AYNI pencerede sayılır. Skor
 * dönemden BAĞIMSIZDIR (skor kendi `period_days` penceresiyle hesaplanmıştır;
 * `score_computed_at` yanında verilir). Skor yoksa (AI-506: minimum işlem eşiği
 * altında skor üretilmez) hücre 'SKOR YOK' yazar — "0" DEĞİL, ve skor aralığı
 * filtresi bu satırları dışarıda bırakır.
 *
 * Mesai dışı alım = AI-504'ün MESAI_DISI bayrağı olan ikmal (bir ikmalin bayrağı
 * en fazla bir MESAI_DISI kaydıdır — UNIQUE(transaction_id, anomaly_type) — ve
 * EXISTS ile sayıldığından fan-out YOKTUR). Bayraklar AI-504 taramasıyla üretilir;
 * henüz taranmamış ikmaller sayıma girmez.
 *
 * KİŞİSEL VERİ (AC): sürücü adı `pii: 'name'` — yalnızca SUPER_ADMIN/COMPANY_OWNER
 * maskesiz görür; SITE_MANAGER (kendi şantiyesi) maskeli görür ("A*** Y***").
 * Maske motorda uygulandığı için JSON/CSV/PDF tutarlıdır. Maskeli görüntüleyici
 * sürücüyü ADIYLA filtreleyemez (orakül — 403), ama opak `driverKey`
 * (md5 türevi sahte anahtar; satırda görünür) ile skor detayına inebilir.
 * Zamanlanmış gönderim/arşiv yolunda görüntüleyici bilinmediğinden çıktı
 * HER ZAMAN maskelidir. Dışa aktarımlar audit'lenir (`auditExport`).
 *
 * ERİŞİM: ticket "COMPANY_OWNER ve üzeriyle sınırlı" der AMA aynı ticket
 * "SITE_MANAGER yalnızca kendi şantiyesini görür" ve "yetkisiz rollere maskeleme"
 * de der. İkisi şöyle birleştirildi: PII'yi görme yetkisi COMPANY_OWNER ve
 * üstüne aittir; SITE_MANAGER şantiye kapsamıyla ve MASKELİ görür;
 * PUMP_OPERATOR/diğer roller 403 alır.
 *
 * `driverKey` = md5(sürücü adı) ilk 12 hex — sözlük saldırısıyla bilinen bir
 * ad doğrulanabilir (SITE_MANAGER, "X adlı sürücü bu listede mi?" sorabilir);
 * sürücü adı tenant içinde zaten şantiye personelince bilinen bir bilgi olduğundan
 * bu kabul edilen bir artık risktir (HMAC'li anahtar için SQL'de gizli anahtar gerekirdi).
 *
 * Excel çıktısı: REP-711'deki KAPSAM UYARLAMASI geçerli (REP-703 CSV+PDF üretir).
 */

const ROLES: ReportDefinition['allowedRoles'] = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'];
const PII_ROLES: ReportDefinition['allowedRoles'] = ['SUPER_ADMIN', 'COMPANY_OWNER'];
const fmtDate = (v: unknown): string => (v === null || v === undefined ? '-' : new Date(v as string).toLocaleString('tr-TR'));
const dash = (v: unknown): string => (v === null || v === undefined || v === '' ? '-' : String(v));
const num2 = (v: unknown): string => (v === null || v === undefined ? '-' : Number(v).toFixed(2));
const W = DRIVER_SCORE_WEIGHTS;

export const rep720DriverReport: ReportDefinition = {
  id: 'rep-720',
  title: 'Sürücü Bazlı Rapor',
  description: 'Sürücü × şantiye: alım sayısı, toplam ve ortalama litre, mesai dışı alım sayısı ve şüpheli davranış skoru. Sürücü adı yetkisiz rollere maskelenir; indirmeler denetim kaydına yazılır.',
  table: `(
    SELECT a.driver_key || ':' || left(md5(COALESCE(a.site_name, '')), 6) AS id, a.driver_key, a.driver_name, a.site_name,
      a.tx_count, a.total_liters, round(a.total_liters / a.tx_count, 2) AS avg_liters,
      a.offhours_count, a.last_tx_at, s.score AS behavior_score, s.computed_at AS score_computed_at
    FROM (
      SELECT left(md5(t.driver_name), 12) AS driver_key, t.driver_name, t.site_name,
        COUNT(*)::int AS tx_count, SUM(t.amount_liters) AS total_liters,
        COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM transaction_anomaly_flags f WHERE f.transaction_id = t.id AND f.anomaly_type = 'MESAI_DISI'
        ))::int AS offhours_count,
        MAX(t.created_at) AS last_tx_at
      FROM transactions t
      WHERE t.driver_name IS NOT NULL AND t.driver_name <> '' ${SOURCE_WHERE_MARKER}
      GROUP BY t.driver_name, t.site_name
    ) a
    LEFT JOIN LATERAL (
      SELECT b.score, b.computed_at FROM driver_behavior_scores b
       WHERE b.driver_name = a.driver_name ORDER BY b.computed_at DESC LIMIT 1
    ) s ON TRUE
  ) c`,
  columns: [
    { key: 'id', header: 'ID' },
    { key: 'driver_key', header: 'Sürücü Anahtarı', width: 12 },
    { key: 'driver_name', header: 'Sürücü', width: 16, pii: 'name' },
    { key: 'site_name', header: 'Şantiye', width: 16, format: dash },
    { key: 'tx_count', header: 'Alım Sayısı', width: 8 },
    { key: 'total_liters', header: 'Toplam Litre', width: 10, format: num2 },
    { key: 'avg_liters', header: 'Ortalama Alım (L)', width: 10, format: num2 },
    { key: 'offhours_count', header: 'Mesai Dışı Alım', width: 9 },
    { key: 'behavior_score', header: 'Davranış Skoru', width: 9, format: (v) => (v === null || v === undefined ? 'SKOR YOK' : String(v)) },
    { key: 'score_computed_at', header: 'Skor Tarihi', width: 15, format: fmtDate },
    { key: 'last_tx_at', header: 'Son Alım', width: 15, format: fmtDate }
  ],
  filters: [
    { key: 'startDate', column: 't.created_at', type: 'dateFrom', label: 'Başlangıç Tarihi', beforeAggregation: true },
    { key: 'endDate', column: 't.created_at', type: 'dateToExclusiveNextDay', label: 'Bitiş Tarihi', beforeAggregation: true },
    { key: 'siteName', column: 'site_name', type: 'exact', label: 'Şantiye' },
    { key: 'driverKey', column: 'driver_key', type: 'exact', label: 'Sürücü Anahtarı (opak)' },
    { key: 'driverName', column: 'driver_name', type: 'ilike', label: 'Sürücü Adı (içerir)', requiresPiiAccess: true },
    { key: 'minScore', column: 'behavior_score', type: 'numberGte', label: 'Skor En Az' },
    { key: 'maxScore', column: 'behavior_score', type: 'numberLte', label: 'Skor En Çok' }
  ],
  aggregates: [
    { key: 'total_rows', column: 'id', fn: 'COUNT', label: 'Sürücü × Şantiye Satırı' },
    { key: 'total_transactions', column: 'tx_count', fn: 'SUM', label: 'Toplam Alım' },
    { key: 'total_liters', column: 'total_liters', fn: 'SUM', label: 'Toplam Litre' },
    { key: 'total_offhours', column: 'offhours_count', fn: 'SUM', label: 'Toplam Mesai Dışı Alım' }
  ],
  allowedRoles: ROLES,
  piiViewerRoles: PII_ROLES,
  auditExport: true,
  defaultSort: { column: 'total_liters', direction: 'DESC' },
  siteScopeColumn: 'site_name'
};

const pct = (v: unknown): string => (v === null || v === undefined ? '-' : `${Number(v).toFixed(2)}`);

export const rep720ScoreComponents: ReportDefinition = {
  id: 'rep-720-skor',
  title: 'Sürücü Skor Bileşenleri (REP-720)',
  description: 'AI-506 davranış skorunun bileşenleri: her hesaplama turu için beş girdinin oranı (%) ve skordan düşürdüğü puan; skor geçmişi dahil.',
  table: `(
    SELECT b.id, b.computed_at, left(md5(b.driver_name), 12) AS driver_key, b.driver_name, b.site_name,
      b.period_days, b.transaction_count, b.score,
      b.offhours_ratio_pct, round(b.offhours_ratio_pct / 100 * ${W.offhours}, 2) AS offhours_penalty,
      b.rapid_repeat_ratio_pct, round(b.rapid_repeat_ratio_pct / 100 * ${W.rapidRepeat}, 2) AS rapid_repeat_penalty,
      b.consumption_deviation_ratio_pct, round(b.consumption_deviation_ratio_pct / 100 * ${W.consumptionDeviation}, 2) AS consumption_deviation_penalty,
      b.cancelled_ratio_pct, round(b.cancelled_ratio_pct / 100 * ${W.cancelled}, 2) AS cancelled_penalty,
      b.manual_entry_ratio_pct, round(b.manual_entry_ratio_pct / 100 * ${W.manualEntry}, 2) AS manual_entry_penalty
    FROM driver_behavior_scores b
  ) c`,
  columns: [
    { key: 'id', header: 'ID' },
    { key: 'computed_at', header: 'Hesaplama', width: 15, format: fmtDate },
    { key: 'driver_key', header: 'Sürücü Anahtarı', width: 12 },
    { key: 'driver_name', header: 'Sürücü', width: 14, pii: 'name' },
    { key: 'site_name', header: 'Şantiye', width: 14, format: dash },
    { key: 'period_days', header: 'Pencere (gün)', width: 8 },
    { key: 'transaction_count', header: 'İşlem', width: 7 },
    { key: 'score', header: 'Skor', width: 6 },
    { key: 'offhours_ratio_pct', header: `Mesai Dışı % (×${W.offhours})`, width: 10, format: pct },
    { key: 'offhours_penalty', header: 'Mesai Dışı Puan', width: 8, format: num2 },
    { key: 'rapid_repeat_ratio_pct', header: `Mükerrer % (×${W.rapidRepeat})`, width: 10, format: pct },
    { key: 'rapid_repeat_penalty', header: 'Mükerrer Puan', width: 8, format: num2 },
    { key: 'consumption_deviation_ratio_pct', header: `Miktar Sapması % (×${W.consumptionDeviation})`, width: 11, format: pct },
    { key: 'consumption_deviation_penalty', header: 'Sapma Puan', width: 8, format: num2 },
    { key: 'cancelled_ratio_pct', header: `İptal/Red % (×${W.cancelled})`, width: 10, format: pct },
    { key: 'cancelled_penalty', header: 'İptal Puan', width: 8, format: num2 },
    { key: 'manual_entry_ratio_pct', header: `Manuel Giriş % (×${W.manualEntry})`, width: 11, format: pct },
    { key: 'manual_entry_penalty', header: 'Manuel Puan', width: 8, format: num2 }
  ],
  filters: [
    { key: 'startDate', column: 'computed_at', type: 'dateFrom', label: 'Hesaplama Başlangıç' },
    { key: 'endDate', column: 'computed_at', type: 'dateToExclusiveNextDay', label: 'Hesaplama Bitiş' },
    { key: 'siteName', column: 'site_name', type: 'exact', label: 'Şantiye' },
    { key: 'driverKey', column: 'driver_key', type: 'exact', label: 'Sürücü Anahtarı (opak)' },
    { key: 'driverName', column: 'driver_name', type: 'ilike', label: 'Sürücü Adı (içerir)', requiresPiiAccess: true },
    { key: 'minScore', column: 'score', type: 'numberGte', label: 'Skor En Az' },
    { key: 'maxScore', column: 'score', type: 'numberLte', label: 'Skor En Çok' }
  ],
  aggregates: [
    { key: 'total_scores', column: 'id', fn: 'COUNT', label: 'Skor Kaydı' },
    { key: 'avg_score', column: 'score', fn: 'AVG', label: 'Ortalama Skor' }
  ],
  allowedRoles: ROLES,
  piiViewerRoles: PII_ROLES,
  auditExport: true,
  defaultSort: { column: 'computed_at', direction: 'DESC' },
  siteScopeColumn: 'site_name'
};

registerReport(rep720DriverReport);
registerReport(rep720ScoreComponents);
