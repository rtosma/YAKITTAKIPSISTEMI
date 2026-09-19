import PDFDocument from 'pdfkit';
import { withTenant } from '../db/withTenant';
import { writeAuditLog } from '../utils/auditLog';
import { BadRequestError, NotFoundError } from '../utils/errors';
import { drawLogo, registerFontsOnDocument } from '../reports/pdfExport';

/**
 * REP-721 (#178) AC: "Belge dosyaları rapordan indirilebilmelidir."
 *
 * XML: COMP-602.1'in `despatch_advice_transmissions.xml_snapshot`'ı — belge
 * iletim kuyruğuna alındığı andaki XSD-doğrulanmış, DEĞİŞMEZ arşiv. Kuyruğa hiç
 * alınmamış belgenin arşivlenmiş XML'i yoktur → 404 XML_NOT_ARCHIVED (indirme
 * SIRASINDA belge no/XML ÜRETİLMEZ — okuma yolu yan etkisiz kalır; rapordaki
 * `xml_link` de yalnızca arşiv varsa dolar).
 * PDF: belge ÖZETİ (belge no, ETTN, tarih, alıcı, litre, tutar, durum, entegratör
 * kodu, sebep). UBL'in görsel karşılığı (GİB şablonu) DEĞİLDİR ve Şoför TC içermez.
 *
 * Yetki: rota rol kontrolü + `siteRestriction` (SITE_MANAGER yalnızca kendi
 * şantiyesinin ikmaline ait belgeyi indirir; başka şantiyedeki/olmayan belge
 * AYNI 404'ü verir — belge varlığı sızmaz). XML Şoför TC içerdiğinden HER indirme
 * `audit_logs`'a (DESPATCH_ADVICE_DOWNLOAD) AYNI transaction'da yazılır: kayıt
 * yazılamazsa dosya verilmez.
 */
export type DespatchAdviceDownloadFormat = 'xml' | 'pdf';

export interface DespatchAdviceDownload {
  contentType: string;
  filename: string;
  body: Buffer | string;
}

const STATUS_TEXT: Record<string, string> = {
  ISSUED: 'Düzenlendi', REJECTED: 'Reddedildi', CANCELLED: 'İptal edildi', SUPERSEDED: 'Yerine yenisi kesildi'
};

export async function downloadDespatchAdviceDocument(
  documentId: string,
  format: DespatchAdviceDownloadFormat,
  siteRestriction?: string
): Promise<DespatchAdviceDownload> {
  if (format !== 'xml' && format !== 'pdf') {
    throw new BadRequestError("format 'xml' veya 'pdf' olmalıdır.", { error: 'INVALID_FORMAT' });
  }

  const row = await withTenant(async (client) => {
    const res = await client.query(
      `SELECT d.id, d.document_number, d.ettn::text AS ettn, d.created_at, d.recipient_tax_id, d.delivery_mode,
              tx.site_name, tx.amount_liters, tx.total_cost, tx.vehicle_plate,
              COALESCE(NULLIF(r.title, ''), d.recipient_tax_id) AS recipient,
              COALESCE(s.status, 'ISSUED') AS disposition, s.reject_reason, s.cancel_reason,
              t.status AS transmission_status, t.provider_reference, t.xml_snapshot
         FROM despatch_advice_documents d
         LEFT JOIN despatch_advice_documents_status s ON s.despatch_advice_document_id = d.id
         LEFT JOIN despatch_advice_transmissions t ON t.tenant_id = d.tenant_id AND t.despatch_advice_document_id = d.id
         LEFT JOIN transactions tx ON tx.id = d.transaction_id
         LEFT JOIN recipient_taxpayers r ON r.tenant_id = d.tenant_id AND r.tax_id = d.recipient_tax_id
        WHERE d.id = $1`,
      [documentId]
    );
    const found = res.rows[0];
    // Kapsam dışı belge, olmayan belgeyle AYNI yanıtı verir.
    if (!found || (siteRestriction !== undefined && found.site_name !== siteRestriction)) {
      throw new NotFoundError('e-İrsaliye belgesi bulunamadı.', { error: 'DESPATCH_ADVICE_NOT_FOUND' });
    }
    if (format === 'xml' && !found.xml_snapshot) {
      throw new NotFoundError('Bu belgenin arşivlenmiş XML çıktısı yok (belge henüz iletim kuyruğuna alınmamış).', { error: 'XML_NOT_ARCHIVED' });
    }
    await writeAuditLog(client, {
      action: 'DESPATCH_ADVICE_DOWNLOAD',
      targetType: 'despatch_advice_document',
      targetId: found.id,
      afterValue: { format, documentNumber: found.document_number }
    });
    return found;
  });

  if (format === 'xml') {
    return { contentType: 'application/xml; charset=utf-8', filename: `e-irsaliye-${row.document_number}.xml`, body: row.xml_snapshot as string };
  }
  return { contentType: 'application/pdf', filename: `e-irsaliye-${row.document_number}.pdf`, body: await buildSummaryPdf(row) };
}

async function buildSummaryPdf(row: any): Promise<Buffer> {
  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });
  registerFontsOnDocument(doc);

  const x = doc.page.margins.left;
  const y = doc.page.margins.top;
  drawLogo(doc, x, y);
  doc.font('ReportRoboto-Bold').fontSize(16).fillColor('#000').text('e-İrsaliye Belge Özeti', x + 36, y + 2);
  doc.font('ReportRoboto').fontSize(9).fillColor('#555').text(`Oluşturulma: ${new Date().toLocaleString('tr-TR')}`, x + 36, y + 20);
  doc.y = y + 50;
  doc.x = x;

  const line = (label: string, value: unknown) => {
    doc.font('ReportRoboto-Bold').fontSize(10).fillColor('#000').text(label, x, doc.y, { continued: true, width: 460 });
    doc.font('ReportRoboto').fillColor('#222').text(`  ${value === null || value === undefined || value === '' ? '-' : value}`);
    doc.moveDown(0.4);
  };
  line('Belge No:', row.document_number);
  line('UUID (ETTN):', row.ettn);
  line('Tarih:', new Date(row.created_at).toLocaleString('tr-TR'));
  line('Şantiye:', row.site_name);
  line('Araç Plakası:', row.vehicle_plate);
  line('Alıcı:', row.recipient);
  line('Alıcı VKN/TCKN:', row.recipient_tax_id);
  line('Litre:', row.amount_liters === null || row.amount_liters === undefined ? null : Number(row.amount_liters).toFixed(2));
  line('Tutar:', row.total_cost === null || row.total_cost === undefined ? null : Number(row.total_cost).toFixed(2));
  line('Teslim Yöntemi:', row.delivery_mode === 'KAGIT' ? 'Kağıt süreç' : 'Elektronik');
  line('Belge Durumu:', STATUS_TEXT[row.disposition] ?? row.disposition);
  line('İletim Durumu:', row.transmission_status ?? 'Kuyruğa alınmadı');
  line('GİB / Entegratör Kodu:', row.provider_reference);
  line('Red / İptal Sebebi:', row.reject_reason ?? row.cancel_reason);
  doc.moveDown(1);
  doc.font('ReportRoboto').fontSize(8).fillColor('#888').text(
    'Bu doküman belgenin özetidir; UBL-TR XML çıktısının görsel karşılığı (GİB şablonu) değildir. Yasal kayıt için XML arşivini kullanın.',
    { width: 460 }
  );
  doc.end();
  return done;
}
