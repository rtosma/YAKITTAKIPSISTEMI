import { registerReport } from '../reportRegistry';
import { ReportDefinition } from '../reportTypes';

/**
 * REP-717 (#174) — Cihaz Sağlık ve Kesinti Raporu.
 *
 * KAYNAK: IOT-308'in veri katmanı — `device_presence_events` (ONLINE/OFFLINE
 * GEÇİŞ günlüğü, IOT-301.2), `device_health_scores` (append-only skor geçmişi),
 * `hardware_devices` (firmware/model/şantiye). Rapor hiçbir skoru yeniden
 * hesaplamaz; online oranı tenantDb.ts computeDeviceOfflineWindow'un (IOT-308
 * SLA) mantığının SQL karşılığıdır (parite testi test_rep717_device_health.ts).
 *
 * ÜÇ TANIM:
 *  - `rep-717`          : cihaz başına özet — firmware, online %, toplam kesinti,
 *                         kesinti sayısı, en uzun kesinti, offline biriken kayıt,
 *                         sağlık skoru + öncelik,
 *  - `rep-717-kesinti`  : kesinti dökümü (başlangıç – bitiş – süre),
 *  - `rep-717-firmware` : firmware sürüm dağılımı (şantiye × sürüm).
 *
 * PENCERE (`rep-717`): `startDate`/`endDate` (endDate DAHİL gün) parametre
 * jetonlarıyla (REP-703'e bu ticket'le eklenen `{{anahtar::tip|varsayılan}}`)
 * hesabın İÇİNE girer; verilmezse son 30 gün (IOT-308 SLA ile aynı varsayılan),
 * bitiş asla `now()`'dan ileri alınmaz. Cihazın İLK presence olayından önceki
 * aralık için veri İCAT EDİLMEZ (pencere o noktadan başlar; IOT-308 ile AYNI) —
 * hiç olayı olmayan cihazda online % NULL ('VERİ YOK'), %100 DEĞİL.
 * Gün sınırları filtre motorunun genel kuralıyla aynı (`::date` → oturum saat
 * dilimi, sunucuda UTC).
 *
 * KESİNTİ SAYISI: pencereyle KESİŞEN OFFLINE dilim sayısıdır (pencereden önce
 * başlayıp içeri uzanan da sayılır) — IOT-308'in offlineTransitionCount'u yalnız
 * pencere İÇİNDE başlayan geçişleri sayar; toplam kesinti süresi ve online % iki
 * yerde AYNIDIR.
 *
 * OFFLINE BİRİKEN KAYIT (Teknik Not: yalnız süre yetmez): cihazın pencerede
 * SENKRONLANAN type='Çevrimdışı Senkron' ikmal sayısı. transactions.created_at
 * senkron anıdır (cihazın orijinal zamanı saklanmıyor) — kayıt, çıkış
 * tarihine değil geri geldiği zamana göre sayılır.
 *
 * SAĞLIK SKORU: cihazın EN SON hesaplanmış skoru; kendi periyodu (period_days)
 * vardır ve rapor penceresinden BAĞIMSIZDIR. Öncelik: < 30 KRİTİK, < 50 DÜŞÜK
 * (tenantDb.ts DEVICE_HEALTH_ALARM_* eşikleriyle AYNI). Skoru olmayan cihaz
 * öncelikli sayılmaz. Öncelikleme: `sortBy=health_score&sortDir=asc` ve
 * `maxHealthScore` filtresi. Dışa aktarım varsayılan olarak cihaz_id sıralıdır
 * (keyset export NULL skorlu satırlarda güvenilir olmaz).
 *
 * Kesinti dökümü tarih filtresi kesintinin BAŞLANGICINA göredir (pencereye
 * sonradan uzanan eski kesintiler için filtresiz listeleyin). Süren kesinti:
 * bitiş 'DEVAM EDİYOR', süre now()'a kadar.
 *
 * Excel çıktısı: REP-711'deki KAPSAM UYARLAMASI geçerli (REP-703 CSV+PDF üretir).
 */

const fmtDate = (v: unknown): string => new Date(v as string).toLocaleString('tr-TR');
const dash = (v: unknown): string => (v === null || v === undefined || v === '' ? '-' : String(v));
const num2 = (v: unknown): string => (v === null || v === undefined ? '-' : Number(v).toFixed(2));
const ROLES: ReportDefinition['allowedRoles'] = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'];

/** Saniyeyi "Ng Nsa Ndk" biçimine çevirir (CSV/PDF için okunur süre). */
function fmtDuration(v: unknown): string {
  if (v === null || v === undefined) return '-';
  const total = Math.round(Number(v));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${d > 0 ? `${d}g ` : ''}${h}sa ${m}dk`;
}

export const rep717DeviceSummary: ReportDefinition = {
  id: 'rep-717',
  title: 'Cihaz Sağlık ve Kesinti Raporu',
  description: 'Cihaz başına: firmware, online süresi (%), toplam/en uzun kesinti, kesinti sayısı, offline biriken kayıt, sağlık skoru ve öncelik. startDate/endDate ile pencere seçilir (varsayılan son 30 gün).',
  table: `(
    WITH win AS (
      SELECT COALESCE({{startDate::date|NULL::date}}::timestamptz, now() - interval '30 days') AS w_start,
             LEAST(COALESCE(({{endDate::date|NULL::date}} + 1)::timestamptz, now()), now()) AS w_end
    ),
    seg AS (
      SELECT p.device_id, p.status, p.occurred_at AS s_start,
             LEAD(p.occurred_at) OVER (PARTITION BY p.device_id ORDER BY p.occurred_at) AS s_next
      FROM device_presence_events p
    ),
    first_ev AS (SELECT device_id, MIN(occurred_at) AS first_at FROM device_presence_events GROUP BY device_id),
    dev AS (
      SELECT d.device_id, d.name, d.site_name, d.model, d.firmware_version, f.first_at,
             GREATEST(win.w_start, f.first_at) AS eff_start, win.w_start, win.w_end
      FROM hardware_devices d CROSS JOIN win LEFT JOIN first_ev f ON f.device_id = d.device_id
    ),
    off AS (
      SELECT dv.device_id,
             EXTRACT(EPOCH FROM (LEAST(COALESCE(s.s_next, dv.w_end), dv.w_end) - GREATEST(s.s_start, dv.eff_start))) AS secs
      FROM dev dv
      JOIN seg s ON s.device_id = dv.device_id AND s.status = 'OFFLINE'
                AND s.s_start < dv.w_end AND COALESCE(s.s_next, dv.w_end) > dv.eff_start
    ),
    off_sum AS (
      SELECT device_id, round(SUM(secs))::bigint AS offline_seconds, COUNT(*)::int AS outage_count, round(MAX(secs))::bigint AS longest_outage_seconds
      FROM off GROUP BY device_id
    ),
    offrec AS (
      SELECT t.device_id, COUNT(*)::int AS offline_records
      FROM transactions t CROSS JOIN win
      WHERE t.type = 'Çevrimdışı Senkron' AND t.created_at >= win.w_start AND t.created_at < win.w_end
      GROUP BY t.device_id
    )
    SELECT dv.device_id AS id, dv.device_id, dv.name AS device_name, dv.site_name, dv.model, dv.firmware_version,
      dv.w_start, dv.w_end,
      CASE WHEN dv.first_at IS NOT NULL AND dv.eff_start < dv.w_end THEN round(EXTRACT(EPOCH FROM (dv.w_end - dv.eff_start)))::bigint END AS observed_seconds,
      CASE WHEN dv.first_at IS NOT NULL AND dv.eff_start < dv.w_end
           THEN round(100 - COALESCE(os.offline_seconds, 0)::numeric / NULLIF(round(EXTRACT(EPOCH FROM (dv.w_end - dv.eff_start))), 0) * 100, 2) END AS online_ratio_pct,
      CASE WHEN dv.first_at IS NOT NULL AND dv.eff_start < dv.w_end THEN COALESCE(os.offline_seconds, 0) END AS offline_seconds,
      CASE WHEN dv.first_at IS NOT NULL AND dv.eff_start < dv.w_end THEN COALESCE(os.outage_count, 0) END AS outage_count,
      CASE WHEN dv.first_at IS NOT NULL AND dv.eff_start < dv.w_end THEN COALESCE(os.longest_outage_seconds, 0) END AS longest_outage_seconds,
      COALESCE(orr.offline_records, 0) AS offline_records,
      hs.score AS health_score,
      CASE WHEN hs.score < 30 THEN 'KRİTİK' WHEN hs.score < 50 THEN 'DÜŞÜK' END AS priority
    FROM dev dv
    LEFT JOIN off_sum os ON os.device_id = dv.device_id
    LEFT JOIN offrec orr ON orr.device_id = dv.device_id
    LEFT JOIN LATERAL (
      SELECT h.score FROM device_health_scores h WHERE h.device_id = dv.device_id ORDER BY h.computed_at DESC LIMIT 1
    ) hs ON TRUE
  ) c`,
  columns: [
    { key: 'id', header: 'ID' },
    { key: 'device_id', header: 'Cihaz', width: 16 },
    { key: 'site_name', header: 'Şantiye', width: 16 },
    { key: 'model', header: 'Tip/Model', width: 12, format: dash },
    { key: 'firmware_version', header: 'Firmware', width: 10, format: (v) => (v ? String(v) : 'Bilinmiyor') },
    { key: 'online_ratio_pct', header: 'Online %', width: 9, format: (v) => (v === null || v === undefined ? 'VERİ YOK' : Number(v).toFixed(2)) },
    { key: 'observed_seconds', header: 'Gözlenen Süre', width: 11, format: (v) => (v === null || v === undefined ? '-' : fmtDuration(v)) },
    { key: 'offline_seconds', header: 'Toplam Kesinti', width: 12, format: fmtDuration },
    { key: 'outage_count', header: 'Kesinti Sayısı', width: 8, format: dash },
    { key: 'longest_outage_seconds', header: 'En Uzun Kesinti', width: 12, format: fmtDuration },
    { key: 'offline_records', header: 'Offline Biriken Kayıt', width: 10 },
    { key: 'health_score', header: 'Sağlık Skoru', width: 9, format: dash },
    { key: 'priority', header: 'Öncelik', width: 9, format: dash }
  ],
  filters: [
    { key: 'siteName', column: 'site_name', type: 'exact', label: 'Şantiye' },
    { key: 'deviceId', column: 'device_id', type: 'ilike', label: 'Cihaz (içerir)' },
    { key: 'firmwareVersion', column: 'firmware_version', type: 'exact', label: 'Firmware Sürümü' },
    { key: 'maxHealthScore', column: 'health_score', type: 'numberLte', label: 'En Çok Sağlık Skoru (düşük skorlular)' },
    { key: 'minOfflineRecords', column: 'offline_records', type: 'numberGte', label: 'En Az Offline Biriken Kayıt' }
  ],
  aggregates: [
    { key: 'device_count', column: 'id', fn: 'COUNT', label: 'Cihaz Sayısı' },
    { key: 'avg_online_ratio_pct', column: 'online_ratio_pct', fn: 'AVG', label: 'Ortalama Online % (verisi olanlar)' },
    { key: 'total_offline_records', column: 'offline_records', fn: 'SUM', label: 'Toplam Offline Biriken Kayıt' }
  ],
  allowedRoles: ROLES,
  defaultSort: { column: 'device_id', direction: 'ASC' },
  siteScopeColumn: 'site_name'
};

export const rep717Outages: ReportDefinition = {
  id: 'rep-717-kesinti',
  title: 'Cihaz Kesinti Dökümü (REP-717)',
  description: 'Her OFFLINE geçişi için başlangıç, bitiş ve süre; süren kesinti bitişi DEVAM EDİYOR olarak gösterilir.',
  table: `(
    SELECT e.id, e.device_id, COALESCE(e.site_name, d.site_name) AS site_name, e.occurred_at AS outage_start, nxt.occurred_at AS outage_end,
           round(EXTRACT(EPOCH FROM (COALESCE(nxt.occurred_at, now()) - e.occurred_at)))::bigint AS duration_seconds
    FROM device_presence_events e
    LEFT JOIN hardware_devices d ON d.device_id = e.device_id
    LEFT JOIN LATERAL (
      SELECT n.occurred_at FROM device_presence_events n
       WHERE n.device_id = e.device_id AND n.occurred_at > e.occurred_at
       ORDER BY n.occurred_at ASC LIMIT 1
    ) nxt ON TRUE
    WHERE e.status = 'OFFLINE'
  ) c`,
  columns: [
    { key: 'id', header: 'ID' },
    { key: 'device_id', header: 'Cihaz', width: 18 },
    { key: 'site_name', header: 'Şantiye', width: 18, format: dash },
    { key: 'outage_start', header: 'Başlangıç', width: 16, format: fmtDate },
    { key: 'outage_end', header: 'Bitiş', width: 16, format: (v) => (v === null || v === undefined ? 'DEVAM EDİYOR' : fmtDate(v)) },
    { key: 'duration_seconds', header: 'Süre', width: 12, format: fmtDuration }
  ],
  filters: [
    { key: 'startDate', column: 'outage_start', type: 'dateFrom', label: 'Başlangıç Tarihi (kesinti başlangıcı)' },
    { key: 'endDate', column: 'outage_start', type: 'dateToExclusiveNextDay', label: 'Bitiş Tarihi (kesinti başlangıcı)' },
    { key: 'deviceId', column: 'device_id', type: 'ilike', label: 'Cihaz (içerir)' },
    { key: 'ongoing', column: 'CASE WHEN outage_end IS NULL THEN 1 ELSE 0 END', type: 'numberGte', label: 'Yalnız süren kesintiler (1) — REP-723 "çevrimdışı cihaz" bağlantısı için' },
    { key: 'siteName', column: 'site_name', type: 'exact', label: 'Şantiye' }
  ],
  aggregates: [
    { key: 'outage_count', column: 'id', fn: 'COUNT', label: 'Kesinti Sayısı' },
    { key: 'total_outage_seconds', column: 'duration_seconds', fn: 'SUM', label: 'Toplam Kesinti (sn)' }
  ],
  allowedRoles: ROLES,
  defaultSort: { column: 'outage_start', direction: 'DESC' },
  siteScopeColumn: 'site_name'
};

export const rep717Firmware: ReportDefinition = {
  id: 'rep-717-firmware',
  title: 'Firmware Sürüm Dağılımı (REP-717)',
  description: 'Şantiye × firmware sürümü: cihaz sayısı ve ortalama (son) sağlık skoru. Sürümü bildirmemiş cihazlar "Bilinmiyor" grubundadır.',
  table: `(
    SELECT COALESCE(d.site_name, '-') || ':' || COALESCE(d.firmware_version, 'Bilinmiyor') AS id,
           d.site_name, COALESCE(d.firmware_version, 'Bilinmiyor') AS firmware_version,
           COUNT(*)::int AS device_count,
           COUNT(hs.score)::int AS scored_count,
           round(AVG(hs.score), 2) AS avg_health_score,
           MIN(hs.score) AS min_health_score
    FROM hardware_devices d
    LEFT JOIN LATERAL (
      SELECT h.score FROM device_health_scores h WHERE h.device_id = d.device_id ORDER BY h.computed_at DESC LIMIT 1
    ) hs ON TRUE
    GROUP BY d.site_name, COALESCE(d.firmware_version, 'Bilinmiyor')
  ) c`,
  columns: [
    { key: 'id', header: 'ID' },
    { key: 'site_name', header: 'Şantiye', width: 20, format: dash },
    { key: 'firmware_version', header: 'Firmware Sürümü', width: 16 },
    { key: 'device_count', header: 'Cihaz', width: 8 },
    { key: 'scored_count', header: 'Skoru Olan', width: 9 },
    { key: 'avg_health_score', header: 'Ort. Sağlık Skoru', width: 12, format: num2 },
    { key: 'min_health_score', header: 'En Düşük Skor', width: 11, format: dash }
  ],
  filters: [
    { key: 'siteName', column: 'site_name', type: 'exact', label: 'Şantiye' },
    { key: 'firmwareVersion', column: 'firmware_version', type: 'exact', label: 'Firmware Sürümü' }
  ],
  aggregates: [{ key: 'total_devices', column: 'device_count', fn: 'SUM', label: 'Toplam Cihaz' }],
  allowedRoles: ROLES,
  defaultSort: { column: 'device_count', direction: 'DESC' },
  siteScopeColumn: 'site_name'
};

registerReport(rep717DeviceSummary);
registerReport(rep717Outages);
registerReport(rep717Firmware);
