import { registerReport } from '../reportRegistry';
import { ReportDefinition } from '../reportTypes';
import { SOURCE_WHERE_MARKER } from '../reportEngine';

/**
 * REP-721 (#178) — e-İrsaliye Durum Raporu.
 *
 * KAYNAK: COMP-601..603 belge tabloları — `despatch_advice_documents` (belge no /
 * ETTN / yıl+sıra), `despatch_advice_transmissions` (entegratöre TEKNİK gönderim:
 * QUEUED/SENDING/SENT/FAILED + xml_snapshot), `despatch_advice_documents_status`
 * (İŞ durumu: ISSUED/REJECTED/CANCELLED/SUPERSEDED; satır tembel yaratılır — yoksa
 * ISSUED sayılır), ikmal (litre/tutar — INV-1503'te DONDURULMUŞ `total_cost`) ve
 * alıcı (`recipient_taxpayers`, UNIQUE(tenant_id, tax_id) → fan-out yok).
 * Rapor hiçbir belgeyi/numarayı ÜRETMEZ veya değiştirmez, yalnızca okur.
 *
 * TEK DURUM (iki ayrı eksenin birleşimi; ilk eşleşen kazanır):
 *   SUPERSEDED → YERINE_YENISI | CANCELLED → IPTAL | REJECTED → REDDEDILDI |
 *   teslim KAGIT → KAGIT | iletim FAILED → GONDERIM_BASARISIZ | QUEUED → KUYRUKTA |
 *   SENDING → GONDERILIYOR | SENT → GONDERILDI | iletim yok → URETILDI.
 *
 * KAPSAM UYARLAMASI — "onaylanan" ve "GİB kodu": gerçek bir GİB/entegratör
 * onay geri bildirimi bu kod tabanında YOK (entegratör `MockGibIntegrator`;
 * bkz. COMP-602.1). Bu yüzden "onaylanan" = entegratöre başarıyla iletilmiş
 * (SENT, provider_reference alınmış) VE sonradan reddedilmemiş/iptal
 * edilmemiş belge (GONDERILDI) demektir; "GİB kodu" sütunu = entegratör
 * referansı (`provider_reference`), gönderilmemişse '-'. Gerçek entegratör
 * eklendiğinde bu iki tanım adaptörden gelen onay/kod ile daraltılmalıdır.
 *
 * DİKKAT (öne çıkarma): REDDEDİLEN (RED), iletimi kalıcı BAŞARISIZ olan
 * (GONDERIM_HATASI) ve kuyrukta 30 dakikadan (STUCK_MINUTES) uzun süredir bekleyen
 * (TAKILI; QUEUED/SENDING) belgeler `attention` sütununda işaretlenir,
 * `attention` filtresiyle listelenir ve özet sayaçlarında ayrı sayılır. (Çatı tek
 * sıralama sütunu destekler — varsayılan sıra tarihtir; öne çıkarma sütun+filtre+
 * sayaçla yapılır, `sortBy=attention_rank` ile dikkatli belgeler üste alınabilir.)
 *
 * NUMARA BOŞLUKLARI (AC): numara `IRS<yıl><9 hane sıra>`; sayaç belgeyle AYNI
 * transaction'da arttığı için normalde boşluksuzdur (COMP-601.1). Rapor yine de
 * DENETLER: her belgede `gap_before` = önceki belgeyle arasındaki EKSİK numara
 * sayısı (yıl bazında, filtrelerden BAĞIMSIZ — pencere alt sorguda hesaplanır),
 * `numbering_warning` eksik aralığı yazar; `rep-721-bosluk` ise tüm boşlukları
 * (BASLANGIC/ARA + sayaç belgelerden ilerideyse SON) ayrı listeler. Bu, tenant
 * genelinde bir numaralama konusu olduğundan yalnızca SUPER_ADMIN/COMPANY_OWNER'a açıktır.
 *
 * İNDİRME (AC): `xml_link` (yalnızca iletim kuyruğuna alınıp XML arşivlenmişse) ve
 * `pdf_link`, `GET /despatch-advice-documents/:id/download?format=xml|pdf` uç
 * noktasına işaret eder (bearer + şantiye kapsamı; her indirme audit'lenir).
 * PDF, belge özetidir (UBL'in görsel karşılığı DEĞİL; Şoför TC içermez).
 *
 * `rep-721-durum`: şantiye × durum kırılımı (sayaçlar: belge, litre, tutar).
 * Excel çıktısı: REP-711'deki KAPSAM UYARLAMASI geçerli (REP-703 CSV+PDF üretir).
 */

export const STUCK_MINUTES = 30;
const ROLES: ReportDefinition['allowedRoles'] = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'];
const ADMIN_ROLES: ReportDefinition['allowedRoles'] = ['SUPER_ADMIN', 'COMPANY_OWNER'];

const fmtDate = (v: unknown): string => (v === null || v === undefined ? '-' : new Date(v as string).toLocaleString('tr-TR'));
const dash = (v: unknown): string => (v === null || v === undefined || v === '' ? '-' : String(v));
const num2 = (v: unknown): string => (v === null || v === undefined ? '-' : Number(v).toFixed(2));

const STATUS_TEXT: Record<string, string> = {
  URETILDI: 'ÜRETİLDİ (gönderilmedi)',
  KUYRUKTA: 'KUYRUKTA',
  GONDERILIYOR: 'GÖNDERİLİYOR',
  GONDERILDI: 'GÖNDERİLDİ',
  GONDERIM_BASARISIZ: 'GÖNDERİM BAŞARISIZ',
  REDDEDILDI: 'REDDEDİLDİ',
  IPTAL: 'İPTAL',
  YERINE_YENISI: 'YERİNE YENİSİ KESİLDİ',
  KAGIT: 'KAĞIT SÜREÇ'
};
const ATTENTION_TEXT: Record<string, string> = { RED: 'RED', TAKILI: 'TAKILI', GONDERIM_HATASI: 'GÖNDERİM HATASI' };

const docNo = (yearExpr: string, seqExpr: string): string => `'IRS' || ${yearExpr} || lpad((${seqExpr})::text, 9, '0')`;

/** Belge başına TEK satır; pencere (gap_before) filtrelerden ÖNCE, tüm belgeler üzerinde hesaplanır. */
const DOC_QUERY = `
  SELECT x.*,
    CASE WHEN x.status_code = 'REDDEDILDI' THEN 'RED'
         WHEN x.status_code = 'GONDERIM_BASARISIZ' THEN 'GONDERIM_HATASI'
         WHEN x.status_code IN ('KUYRUKTA', 'GONDERILIYOR') AND x.queued_at < NOW() - INTERVAL '${STUCK_MINUTES} minutes' THEN 'TAKILI'
         ELSE '-' END AS attention
  FROM (
    SELECT d.id, d.document_number, d.ettn::text AS ettn, d.created_at, d.issue_year, d.sequence_no, d.transaction_id, d.delivery_mode,
      d.is_correction, tx.site_name, tx.vehicle_plate,
      COALESCE(NULLIF(r.title, ''), d.recipient_tax_id) AS recipient, d.recipient_tax_id,
      tx.amount_liters AS liters, tx.total_cost AS amount,
      COALESCE(s.status, 'ISSUED') AS disposition, t.status AS transmission_status, t.attempt_count, t.sent_at, t.queued_at,
      t.provider_reference AS gib_code, t.last_error,
      CASE WHEN COALESCE(s.status, 'ISSUED') = 'REJECTED' THEN s.reject_reason
           WHEN COALESCE(s.status, 'ISSUED') = 'CANCELLED' THEN s.cancel_reason END AS reason,
      CASE WHEN s.status = 'SUPERSEDED' THEN 'YERINE_YENISI'
           WHEN s.status = 'CANCELLED' THEN 'IPTAL'
           WHEN s.status = 'REJECTED' THEN 'REDDEDILDI'
           WHEN d.delivery_mode = 'KAGIT' THEN 'KAGIT'
           WHEN t.status = 'FAILED' THEN 'GONDERIM_BASARISIZ'
           WHEN t.status = 'QUEUED' THEN 'KUYRUKTA'
           WHEN t.status = 'SENDING' THEN 'GONDERILIYOR'
           WHEN t.status = 'SENT' THEN 'GONDERILDI'
           ELSE 'URETILDI' END AS status_code,
      d.sequence_no - COALESCE(LAG(d.sequence_no) OVER (PARTITION BY d.issue_year ORDER BY d.sequence_no), 0) - 1 AS gap_before,
      COALESCE(LAG(d.sequence_no) OVER (PARTITION BY d.issue_year ORDER BY d.sequence_no), 0) AS prev_seq,
      CASE WHEN t.xml_snapshot IS NOT NULL THEN '/api/v1/despatch-advice-documents/' || d.id || '/download?format=xml' END AS xml_link,
      '/api/v1/despatch-advice-documents/' || d.id || '/download?format=pdf' AS pdf_link
    FROM despatch_advice_documents d
    LEFT JOIN despatch_advice_documents_status s ON s.despatch_advice_document_id = d.id
    LEFT JOIN despatch_advice_transmissions t ON t.tenant_id = d.tenant_id AND t.despatch_advice_document_id = d.id
    LEFT JOIN transactions tx ON tx.id = d.transaction_id
    LEFT JOIN recipient_taxpayers r ON r.tenant_id = d.tenant_id AND r.tax_id = d.recipient_tax_id
  ) x`;

export const rep721DespatchStatus: ReportDefinition = {
  id: 'rep-721',
  title: 'e-İrsaliye Durum Raporu',
  description: 'Üretilen/gönderilen/onaylanan/reddedilen e-İrsaliyeler: belge no, UUID, tarih, alıcı, litre, tutar, durum, GİB (entegratör) kodu, red sebebi; reddedilen/takılı belge vurgusu, numara boşluğu uyarısı ve PDF/XML indirme bağlantıları.',
  table: `(
    SELECT y.*,
      CASE WHEN y.attention <> '-' THEN 1 ELSE 0 END AS attention_rank,
      CASE WHEN y.gap_before > 0 THEN 'BOŞLUK: ' || ${docNo('y.issue_year', 'y.prev_seq + 1')}
             || CASE WHEN y.gap_before > 1 THEN ' – ' || ${docNo('y.issue_year', 'y.sequence_no - 1')} ELSE '' END
             || ' eksik (' || y.gap_before || ')' END AS numbering_warning
    FROM (${DOC_QUERY}) y
  ) c`,
  columns: [
    { key: 'id', header: 'ID' },
    { key: 'document_number', header: 'Belge No', width: 15 },
    { key: 'ettn', header: 'UUID (ETTN)', width: 26 },
    { key: 'created_at', header: 'Tarih', width: 14, format: fmtDate },
    { key: 'site_name', header: 'Şantiye', width: 13, format: dash },
    { key: 'recipient', header: 'Alıcı', width: 16, format: dash },
    { key: 'liters', header: 'Litre', width: 7, format: num2 },
    { key: 'amount', header: 'Tutar', width: 9, format: num2 },
    { key: 'status_code', header: 'Durum', width: 14, format: (v) => STATUS_TEXT[String(v)] ?? String(v) },
    { key: 'gib_code', header: 'GİB / Entegratör Kodu', width: 18, format: dash },
    { key: 'reason', header: 'Red / İptal Sebebi', width: 18, format: dash },
    { key: 'attention', header: 'Dikkat', width: 9, format: (v) => ATTENTION_TEXT[String(v)] ?? '-' },
    { key: 'numbering_warning', header: 'Numara Uyarısı', width: 18, format: dash },
    { key: 'xml_link', header: 'XML', width: 10, format: dash },
    { key: 'pdf_link', header: 'PDF', width: 10, format: dash },
    { key: 'transmission_status', header: 'İletim', width: 9, format: dash },
    { key: 'attempt_count', header: 'Deneme', width: 6, format: dash },
    { key: 'attention_rank', header: 'Öncelik', width: 6 },
    { key: 'gap_before', header: 'Önceki Boşluk', width: 6 }
  ],
  filters: [
    { key: 'startDate', column: 'created_at', type: 'dateFrom', label: 'Başlangıç Tarihi' },
    { key: 'endDate', column: 'created_at', type: 'dateToExclusiveNextDay', label: 'Bitiş Tarihi' },
    { key: 'status', column: 'status_code', type: 'in', label: 'Durum (URETILDI/KUYRUKTA/GONDERILIYOR/GONDERILDI/GONDERIM_BASARISIZ/REDDEDILDI/IPTAL/YERINE_YENISI/KAGIT; virgülle çoklu)' },
    { key: 'attention', column: 'attention', type: 'exact', label: 'Dikkat (RED / TAKILI / GONDERIM_HATASI)' },
    { key: 'siteName', column: 'site_name', type: 'exact', label: 'Şantiye' },
    { key: 'recipient', column: 'recipient', type: 'ilike', label: 'Alıcı (içerir)' },
    { key: 'documentNumber', column: 'document_number', type: 'ilike', label: 'Belge No (içerir)' },
    { key: 'transactionId', column: 'transaction_id', type: 'in', label: 'İkmal ID (virgülle çoklu)' },
    { key: 'year', column: 'issue_year', type: 'exact', label: 'Belge Yılı' },
    { key: 'gapOnly', column: 'CASE WHEN gap_before > 0 THEN 1 ELSE 0 END', type: 'numberGte', label: 'Yalnız numara boşluğu olanlar (1)' }
  ],
  aggregates: [
    { key: 'total_documents', column: 'id', fn: 'COUNT', label: 'Üretilen Belge' },
    { key: 'sent_count', column: `CASE WHEN transmission_status = 'SENT' THEN 1 ELSE 0 END`, fn: 'SUM', label: 'Entegratöre İletilen' },
    { key: 'accepted_count', column: `CASE WHEN status_code = 'GONDERILDI' THEN 1 ELSE 0 END`, fn: 'SUM', label: 'Onaylanan (gönderildi, reddedilmedi)' },
    { key: 'rejected_count', column: `CASE WHEN status_code = 'REDDEDILDI' THEN 1 ELSE 0 END`, fn: 'SUM', label: 'Reddedilen' },
    { key: 'cancelled_count', column: `CASE WHEN status_code = 'IPTAL' THEN 1 ELSE 0 END`, fn: 'SUM', label: 'İptal Edilen' },
    { key: 'stuck_count', column: `CASE WHEN attention = 'TAKILI' THEN 1 ELSE 0 END`, fn: 'SUM', label: 'Takılı (kuyrukta uzun süre bekleyen)' },
    { key: 'failed_count', column: `CASE WHEN attention = 'GONDERIM_HATASI' THEN 1 ELSE 0 END`, fn: 'SUM', label: 'Gönderim Başarısız' },
    { key: 'missing_numbers', column: 'GREATEST(gap_before, 0)', fn: 'SUM', label: 'Eksik Belge Numarası (görünen belgelerden önceki)' },
    { key: 'total_liters', column: 'liters', fn: 'SUM', label: 'Toplam Litre' },
    { key: 'total_amount', column: 'amount', fn: 'SUM', label: 'Toplam Tutar' }
  ],
  allowedRoles: ROLES,
  defaultSort: { column: 'created_at', direction: 'DESC' },
  siteScopeColumn: 'site_name'
};

export const rep721StatusSummary: ReportDefinition = {
  id: 'rep-721-durum',
  title: 'e-İrsaliye Durum Sayaçları (REP-721)',
  description: 'Şantiye × durum kırılımı: belge sayısı, toplam litre ve tutar.',
  table: `(
    SELECT COALESCE(z.site_name, '-') || ':' || z.status_code AS id, z.site_name, z.status_code,
      COUNT(*)::int AS document_count, SUM(z.liters) AS liters, SUM(z.amount) AS amount, MAX(z.created_at) AS last_document_at
    FROM (${DOC_QUERY}) z
    WHERE TRUE ${SOURCE_WHERE_MARKER}
    GROUP BY z.site_name, z.status_code
  ) c`,
  columns: [
    { key: 'id', header: 'ID' },
    { key: 'status_code', header: 'Durum', width: 20, format: (v) => STATUS_TEXT[String(v)] ?? String(v) },
    { key: 'site_name', header: 'Şantiye', width: 18, format: dash },
    { key: 'document_count', header: 'Belge', width: 8 },
    { key: 'liters', header: 'Litre', width: 10, format: num2 },
    { key: 'amount', header: 'Tutar', width: 10, format: num2 },
    { key: 'last_document_at', header: 'Son Belge', width: 15, format: fmtDate }
  ],
  filters: [
    { key: 'startDate', column: 'z.created_at', type: 'dateFrom', label: 'Başlangıç Tarihi', beforeAggregation: true },
    { key: 'endDate', column: 'z.created_at', type: 'dateToExclusiveNextDay', label: 'Bitiş Tarihi', beforeAggregation: true },
    { key: 'transactionId', column: 'z.transaction_id', type: 'in', label: 'İkmal ID (virgülle çoklu)', beforeAggregation: true },
    { key: 'siteName', column: 'site_name', type: 'exact', label: 'Şantiye' },
    { key: 'status', column: 'status_code', type: 'in', label: 'Durum' }
  ],
  aggregates: [
    { key: 'total_documents', column: 'document_count', fn: 'SUM', label: 'Toplam Belge' },
    { key: 'total_liters', column: 'liters', fn: 'SUM', label: 'Toplam Litre' },
    { key: 'total_amount', column: 'amount', fn: 'SUM', label: 'Toplam Tutar' }
  ],
  allowedRoles: ROLES,
  defaultSort: { column: 'document_count', direction: 'DESC' },
  siteScopeColumn: 'site_name'
};

export const rep721NumberGaps: ReportDefinition = {
  id: 'rep-721-bosluk',
  title: 'e-İrsaliye Numara Boşlukları (REP-721)',
  description: 'Belge numarası sürekliliği denetimi: yıl bazında eksik numara aralıkları (başlangıç / ara / sayaç belgelerin ilerisindeyse son).',
  table: `(
    SELECT g.issue_year || ':' || g.from_seq AS id, g.issue_year, g.gap_type, g.from_seq, g.to_seq,
      g.to_seq - g.from_seq + 1 AS missing_count,
      ${docNo('g.issue_year', 'g.from_seq')} AS from_number, ${docNo('g.issue_year', 'g.to_seq')} AS to_number
    FROM (
      SELECT p.issue_year, p.prev_seq + 1 AS from_seq, p.sequence_no - 1 AS to_seq,
        CASE WHEN p.prev_seq = 0 THEN 'BASLANGIC' ELSE 'ARA' END AS gap_type
      FROM (
        SELECT d.issue_year, d.sequence_no, COALESCE(LAG(d.sequence_no) OVER (PARTITION BY d.issue_year ORDER BY d.sequence_no), 0) AS prev_seq
        FROM despatch_advice_documents d
      ) p
      WHERE p.sequence_no - p.prev_seq > 1
      UNION ALL
      SELECT c.issue_year, m.max_seq + 1, c.last_sequence, 'SON'
      FROM despatch_advice_counters c
      CROSS JOIN LATERAL (SELECT COALESCE(MAX(d.sequence_no), 0) AS max_seq FROM despatch_advice_documents d WHERE d.issue_year = c.issue_year) m
      WHERE c.last_sequence > m.max_seq
    ) g
  ) c`,
  columns: [
    { key: 'id', header: 'ID' },
    { key: 'issue_year', header: 'Yıl', width: 6 },
    { key: 'gap_type', header: 'Tür', width: 10, format: (v) => ({ BASLANGIC: 'BAŞLANGIÇ', ARA: 'ARA', SON: 'SON (sayaç ileride)' } as Record<string, string>)[String(v)] ?? String(v) },
    { key: 'from_number', header: 'İlk Eksik No', width: 16 },
    { key: 'to_number', header: 'Son Eksik No', width: 16 },
    { key: 'missing_count', header: 'Eksik Adet', width: 8 }
  ],
  filters: [{ key: 'year', column: 'issue_year', type: 'exact', label: 'Belge Yılı' }],
  aggregates: [
    { key: 'total_gaps', column: 'id', fn: 'COUNT', label: 'Boşluk Aralığı' },
    { key: 'total_missing', column: 'missing_count', fn: 'SUM', label: 'Toplam Eksik Numara' }
  ],
  allowedRoles: ADMIN_ROLES,
  defaultSort: { column: 'issue_year', direction: 'DESC' }
};

registerReport(rep721DespatchStatus);
registerReport(rep721StatusSummary);
registerReport(rep721NumberGaps);
