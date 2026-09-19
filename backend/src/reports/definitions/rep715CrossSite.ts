import { registerReport } from '../reportRegistry';
import { ReportDefinition } from '../reportTypes';

/**
 * REP-715 (#172) — Çapraz Alım ve Mahsuplaşma Raporu.
 *
 * "FİRMA" → ŞANTİYE UYARLAMASI: ticket "firma çiftleri / kaynak firma / çeken
 * firma" diyor, ama bu sistemde çapraz alım (FUEL-402, cross_site_permissions)
 * AYNI tenant'ın şantiyeleri arasındadır — tenantlar RLS ile birbirinden
 * yalıtıktır, tenantlar-arası yakıt hareketi yoktur. Bu yüzden mahsuplaşma
 * birimi ŞANTİYE ÇİFTİDİR ("kaynak" = yakıtın çekildiği tankın şantiyesi,
 * "çeken" = aracın O ANKİ bağlı olduğu şantiye).
 *
 * ÇAPRAZ ALIM: aracın (o andaki) bağlı şantiyesi ≠ ikmalin yapıldığı şantiye.
 * "O anki" bağlı şantiye vehicle_site_assignments geçmişinden çözülür (araç
 * sonradan başka şantiyeye atanmış olsa da eski alımlar YANLIŞ şantiyeye
 * yazılmaz); geçmiş yoksa vehicles.site_name.
 *
 * MAHSUPLAŞMA TUTARI (Teknik Not: "alım anındaki birim maliyet"):
 * transactions.total_cost — INV-1503'ün ikmal ANINDA yazdığı, sonradan
 * DEĞİŞMEYEN değer; güncel fiyat HİÇ kullanılmaz. Fiyat geçmişi olmayan
 * (NULL) ikmaller tutarı 0 katar ve `unpriced_count` ile AÇIKÇA sayılır
 * (net tutar bu durumda eksik olabilir — gizlenmez).
 *
 * ÜÇ TANIM:
 *  - `rep-715`        : çapraz alım hareketleri (kaynak/çeken şantiye, araç,
 *                       litre, tutar, izin kota kullanım oranı),
 *  - `rep-715-mahsup` : şantiye çifti × ay NET mahsuplaşma (kim kime borçlu) +
 *                       önceki aya göre karşılaştırma,
 *  - `rep-715-red`    : reddedilen çapraz alım denemeleri (izin yok / kota aşımı).
 *
 * Kota kullanım oranı: ikmal anında geçerli (en son oluşturulmuş) iznin
 * used/allowed oranı — iznin GÜNCEL doluluğudur, o ikmalin anlık görüntüsü değil
 * (cross_site_permissions.used_liters kümülatiftir, geçmişi tutulmaz).
 *
 * Reddedilen denemeler: FUEL-402 ret'leri yalnızca hata olarak fırlatıyordu;
 * bu ticket için `cross_site_denials` (schema.sql) eklendi ve iki ret noktası
 * (cihaz yolu + manuel yol) kaydı AYRI transaction'da yazar (best-effort).
 * Bu tablo yalnızca ticket SONRASI denemeleri içerir — geçmişe dönük yok.
 *
 * Kırılım/dönem: REP-714'teki gibi (filtre gruplamadan SONRA çalıştığı için
 * mahsuplaşma AY granülaritesindedir; bir çiftin aralık toplamı siteA+siteB
 * filtresi + `total_net_cost` toplamıyla alınır).
 *
 * SITE_MANAGER görünürlüğü: satırın İKİ şantiyesinden biri kendisininse görür
 * (`siteScopeAltColumns`, REP-703'e eklenen küçük genişletme).
 *
 * Excel çıktısı: REP-711'deki KAPSAM UYARLAMASI geçerli (REP-703 CSV+PDF üretir).
 */

const CROSS_SITE_PULLS = `
  SELECT t.id, t.created_at, t.site_name AS source_site, h.home_site, t.vehicle_plate, t.driver_name, t.tank_name,
    t.amount_liters, t.unit_cost_liters, t.total_cost,
    CASE WHEN p.allowed_liters > 0 THEN round(p.used_liters / p.allowed_liters * 100, 2) END AS quota_usage_pct
  FROM transactions t
  JOIN vehicles v ON v.plate = t.vehicle_plate
  CROSS JOIN LATERAL (
    SELECT COALESCE(
      (SELECT a.to_site_name FROM vehicle_site_assignments a WHERE a.vehicle_id = v.id AND a.changed_at <= t.created_at ORDER BY a.changed_at DESC LIMIT 1),
      (SELECT a.from_site_name FROM vehicle_site_assignments a WHERE a.vehicle_id = v.id AND a.changed_at > t.created_at ORDER BY a.changed_at ASC LIMIT 1),
      v.site_name
    ) AS home_site
  ) h
  LEFT JOIN LATERAL (
    SELECT cp.allowed_liters, cp.used_liters FROM cross_site_permissions cp
     WHERE cp.vehicle_plate = t.vehicle_plate AND cp.target_site = t.site_name AND cp.created_at <= t.created_at
     ORDER BY cp.created_at DESC LIMIT 1
  ) p ON TRUE
  WHERE h.home_site IS NOT NULL AND h.home_site <> t.site_name
`;

const fmt2 = (v: unknown): string => (v === null || v === undefined ? '-' : Number(v).toFixed(2));
const fmtDate = (v: unknown): string => new Date(v as string).toLocaleString('tr-TR');
const SIGNED = (v: unknown): string => (v === null || v === undefined ? '-' : `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}`);
const ROLES: ReportDefinition['allowedRoles'] = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'];

export const rep715CrossSite: ReportDefinition = {
  id: 'rep-715',
  title: 'Çapraz Alım Raporu',
  description: 'Bir aracın kendi şantiyesi dışındaki şantiyeden aldığı yakıt: kaynak/çeken şantiye, araç, litre, alım anı tutarı ve izin kota kullanım oranı.',
  table: `(${CROSS_SITE_PULLS}) c`,
  columns: [
    { key: 'id', header: 'ID' },
    { key: 'created_at', header: 'Tarih', width: 16, format: fmtDate },
    { key: 'source_site', header: 'Kaynak Şantiye', width: 18 },
    { key: 'home_site', header: 'Çeken Şantiye', width: 18 },
    { key: 'vehicle_plate', header: 'Araç', width: 12 },
    { key: 'driver_name', header: 'Sürücü', width: 14, format: (v) => (v ? String(v) : '-') },
    { key: 'amount_liters', header: 'Litre', width: 9, format: fmt2 },
    { key: 'unit_cost_liters', header: 'Birim Fiyat', width: 10, format: (v) => (v === null || v === undefined ? '-' : Number(v).toFixed(4)) },
    { key: 'total_cost', header: 'Tutar', width: 10, format: fmt2 },
    { key: 'quota_usage_pct', header: 'İzin Kota Kullanımı %', width: 11, format: fmt2 }
  ],
  filters: [
    { key: 'startDate', column: 'created_at', type: 'dateFrom', label: 'Başlangıç Tarihi' },
    { key: 'endDate', column: 'created_at', type: 'dateToExclusiveNextDay', label: 'Bitiş Tarihi' },
    { key: 'sourceSite', column: 'source_site', type: 'exact', label: 'Kaynak Şantiye' },
    { key: 'homeSite', column: 'home_site', type: 'exact', label: 'Çeken Şantiye' },
    { key: 'vehiclePlate', column: 'vehicle_plate', type: 'ilike', label: 'Araç Plakası' }
  ],
  aggregates: [
    { key: 'total_liters', column: 'amount_liters', fn: 'SUM', label: 'Toplam Litre' },
    { key: 'total_cost', column: 'total_cost', fn: 'SUM', label: 'Toplam Tutar' }
  ],
  allowedRoles: ROLES,
  defaultSort: { column: 'created_at', direction: 'DESC' },
  siteScopeColumn: 'source_site',
  siteScopeAltColumns: ['home_site']
};

export const rep715Settlement: ReportDefinition = {
  id: 'rep-715-mahsup',
  title: 'Şantiye Çiftleri Net Mahsuplaşma (REP-715)',
  description: 'Şantiye çifti × ay: A şantiyesinin B tanklarından, B şantiyesinin A tanklarından çektiği yakıt (alım anı tutarıyla), net borç/alacak ve önceki aya göre değişim.',
  table: `(
    WITH g AS (
      SELECT LEAST(b.home_site, b.source_site) AS site_a, GREATEST(b.home_site, b.source_site) AS site_b,
        date_trunc('month', (b.created_at AT TIME ZONE 'UTC') + interval '3 hours') AS month_start,
        COALESCE(SUM(b.amount_liters) FILTER (WHERE b.home_site < b.source_site), 0) AS liters_a_pulled_at_b,
        COALESCE(SUM(b.total_cost) FILTER (WHERE b.home_site < b.source_site), 0) AS cost_a_owes_b,
        COALESCE(SUM(b.amount_liters) FILTER (WHERE b.home_site > b.source_site), 0) AS liters_b_pulled_at_a,
        COALESCE(SUM(b.total_cost) FILTER (WHERE b.home_site > b.source_site), 0) AS cost_b_owes_a,
        COUNT(*)::int AS movement_count,
        COUNT(*) FILTER (WHERE b.total_cost IS NULL)::int AS unpriced_count
      FROM (${CROSS_SITE_PULLS}) b
      GROUP BY 1, 2, 3
    )
    SELECT
      g.site_a || ' <> ' || g.site_b || ':' || to_char(g.month_start, 'YYYY-MM') AS id,
      g.site_a, g.site_b, to_char(g.month_start, 'YYYY-MM') AS month_label, g.month_start,
      g.movement_count, g.unpriced_count,
      g.liters_a_pulled_at_b, g.cost_a_owes_b, g.liters_b_pulled_at_a, g.cost_b_owes_a,
      (g.cost_a_owes_b - g.cost_b_owes_a) AS net_cost,
      abs(g.cost_a_owes_b - g.cost_b_owes_a) AS net_amount,
      CASE WHEN g.cost_a_owes_b > g.cost_b_owes_a THEN g.site_a WHEN g.cost_a_owes_b < g.cost_b_owes_a THEN g.site_b END AS debtor,
      CASE WHEN g.cost_a_owes_b > g.cost_b_owes_a THEN g.site_b WHEN g.cost_a_owes_b < g.cost_b_owes_a THEN g.site_a END AS creditor,
      COALESCE(pv.prev_net_cost, 0) AS prev_net_cost,
      (g.cost_a_owes_b - g.cost_b_owes_a) - COALESCE(pv.prev_net_cost, 0) AS net_change
    FROM g
    LEFT JOIN LATERAL (
      SELECT (p.cost_a_owes_b - p.cost_b_owes_a) AS prev_net_cost FROM g p
       WHERE p.site_a = g.site_a AND p.site_b = g.site_b AND p.month_start = g.month_start - interval '1 month'
    ) pv ON TRUE
  ) c`,
  columns: [
    { key: 'id', header: 'ID' },
    { key: 'site_a', header: 'Şantiye A', width: 18 },
    { key: 'site_b', header: 'Şantiye B', width: 18 },
    { key: 'month_label', header: 'Ay', width: 8 },
    { key: 'movement_count', header: 'Hareket', width: 8 },
    { key: 'liters_a_pulled_at_b', header: 'A→B Litre', width: 10, format: fmt2 },
    { key: 'cost_a_owes_b', header: 'A→B Tutar', width: 11, format: fmt2 },
    { key: 'liters_b_pulled_at_a', header: 'B→A Litre', width: 10, format: fmt2 },
    { key: 'cost_b_owes_a', header: 'B→A Tutar', width: 11, format: fmt2 },
    { key: 'net_cost', header: 'Net (A−B)', width: 11, format: SIGNED },
    { key: 'debtor', header: 'Borçlu', width: 16, format: (v) => (v ? String(v) : '-') },
    { key: 'creditor', header: 'Alacaklı', width: 16, format: (v) => (v ? String(v) : '-') },
    { key: 'net_amount', header: 'Net Tutar', width: 11, format: fmt2 },
    { key: 'prev_net_cost', header: 'Önceki Ay Net', width: 11, format: SIGNED },
    { key: 'net_change', header: 'Aya Göre Değişim', width: 11, format: SIGNED },
    { key: 'unpriced_count', header: 'Fiyatsız İkmal', width: 9 }
  ],
  filters: [
    { key: 'startDate', column: 'month_start', type: 'dateFrom', label: 'Başlangıç Ayı' },
    { key: 'endDate', column: 'month_start', type: 'dateToExclusiveNextDay', label: 'Bitiş Ayı' },
    { key: 'siteA', column: 'site_a', type: 'exact', label: 'Şantiye A (alfabetik önce gelen)' },
    { key: 'siteB', column: 'site_b', type: 'exact', label: 'Şantiye B' }
  ],
  aggregates: [
    { key: 'total_net_cost', column: 'net_cost', fn: 'SUM', label: 'Toplam Net (A−B) — tek çift filtresiyle anlamlı' },
    { key: 'total_unpriced', column: 'unpriced_count', fn: 'SUM', label: 'Fiyatsız İkmal Sayısı' }
  ],
  allowedRoles: ROLES,
  defaultSort: { column: 'month_label', direction: 'DESC' },
  siteScopeColumn: 'site_a',
  siteScopeAltColumns: ['site_b']
};

export const rep715Denials: ReportDefinition = {
  id: 'rep-715-red',
  title: 'Reddedilen Çapraz Alım Denemeleri (REP-715)',
  description: 'Çapraz şantiye ikmal izni olmayan veya kotası tükenmiş araçların reddedilen denemeleri (cihaz + manuel yol).',
  table: `(
    SELECT d.id, d.occurred_at, d.reason, d.vehicle_plate, d.home_site, d.target_site, d.requested_liters,
      d.allowed_liters, d.used_liters,
      CASE WHEN d.allowed_liters IS NOT NULL THEN d.allowed_liters - d.used_liters END AS remaining_liters,
      CASE WHEN d.allowed_liters > 0 THEN round(d.used_liters / d.allowed_liters * 100, 2) END AS quota_usage_pct,
      d.source
    FROM cross_site_denials d
  ) c`,
  columns: [
    { key: 'id', header: 'ID' },
    { key: 'occurred_at', header: 'Tarih', width: 16, format: fmtDate },
    { key: 'reason', header: 'Ret Nedeni', width: 12, format: (v) => (v === 'QUOTA_EXHAUSTED' ? 'KOTA AŞIMI' : 'İZİN YOK') },
    { key: 'vehicle_plate', header: 'Araç', width: 12 },
    { key: 'home_site', header: 'Çeken Şantiye', width: 18, format: (v) => (v ? String(v) : '-') },
    { key: 'target_site', header: 'Kaynak Şantiye', width: 18 },
    { key: 'requested_liters', header: 'İstenen (L)', width: 10, format: fmt2 },
    { key: 'allowed_liters', header: 'İzin (L)', width: 9, format: fmt2 },
    { key: 'used_liters', header: 'Kullanılan (L)', width: 10, format: fmt2 },
    { key: 'remaining_liters', header: 'Kalan (L)', width: 9, format: fmt2 },
    { key: 'quota_usage_pct', header: 'Kota Kullanımı %', width: 10, format: fmt2 },
    { key: 'source', header: 'Kaynak', width: 8, format: (v) => (v === 'DEVICE' ? 'Cihaz' : 'Manuel') }
  ],
  filters: [
    { key: 'startDate', column: 'occurred_at', type: 'dateFrom', label: 'Başlangıç Tarihi' },
    { key: 'endDate', column: 'occurred_at', type: 'dateToExclusiveNextDay', label: 'Bitiş Tarihi' },
    { key: 'reason', column: 'reason', type: 'exact', label: 'Ret Nedeni (QUOTA_EXHAUSTED / NO_SITE_PERMISSION)' },
    { key: 'vehiclePlate', column: 'vehicle_plate', type: 'ilike', label: 'Araç Plakası' },
    { key: 'homeSite', column: 'home_site', type: 'exact', label: 'Çeken Şantiye' },
    { key: 'source', column: 'source', type: 'exact', label: 'Kaynak (DEVICE / MANUEL)' }
  ],
  aggregates: [
    { key: 'denial_count', column: 'id', fn: 'COUNT', label: 'Toplam Ret' },
    { key: 'quota_exhausted_count', column: "CASE WHEN reason = 'QUOTA_EXHAUSTED' THEN 1 ELSE 0 END", fn: 'SUM', label: 'Kota Aşımı Sayısı' }
  ],
  allowedRoles: ROLES,
  defaultSort: { column: 'occurred_at', direction: 'DESC' },
  siteScopeColumn: 'target_site',
  siteScopeAltColumns: ['home_site']
};

registerReport(rep715CrossSite);
registerReport(rep715Settlement);
registerReport(rep715Denials);
