// pdfkit saf JS'tir (native binding yok) ama standart font verilerini (.afm)
// paket dizinine göre RELATİF `fs.readFileSync` ile okur — esbuild ile
// bundle edilirse bu yol kırılır. backend/package.json'daki build script'i
// bu yüzden diğer "asset okuyan" paketlerle (swagger-jsdoc, libxmljs2) AYNI
// desende `--external:pdfkit` ile işaretlendi (bkz. o script'teki yorum).
import PDFDocument from 'pdfkit';
import { Response } from 'express';
import { ReportDefinition } from './reportTypes';
import { streamReportExport, ReportQueryParams, assertPdfRowLimit, runReport } from './reportEngine';

/**
 * REP-703 — PDF export, TÜM raporlar için ortak.
 *
 * BİLİNÇLİ SAPMA (ticket'ın kendi notu): "PDF üretimi CPU yoğundur; büyük
 * raporlar kuyruğa alınmalıdır." Bu projede BullMQ/Redis Streams tabanlı bir
 * arka plan iş kuyruğu YOK (ARCH-102 EPIC henüz kurulmadı — bkz. #14).
 * Kuyruksuz bir Express sürecinde sınırsız satırlı bir PDF üretimi event
 * loop'u uzun süre bloklayabilir; bunun yerine `maxPdfRows` (varsayılan
 * 2000) üzerindeki raporlar KASITLI olarak 400 ile reddedilir ve kullanıcı
 * CSV'ye yönlendirilir (CSV akışı sabit bellekli ve satır sayısından
 * BAĞIMSIZ ucuzdur). ARCH-102 kurulduğunda bu sınır bir kuyruklu-job'a
 * dönüştürülebilir — bkz. TEST_PLAN.md'ye eklenen not.
 */
export async function streamReportToPdf(res: Response, def: ReportDefinition, query: ReportQueryParams, siteScope: string | undefined): Promise<void> {
  // Satır sınırını, akışı BAŞLATMADAN önce (aggregate sorgusuyla) kontrol et
  // — aksi halde HTTP başlıkları gönderildikten SONRA 400 döndürmeye
  // çalışırdık (imkânsız, response zaten commit edilmiş olur). Bu, aynı
  // COUNT(*) sorgusunu (aşağıdaki streamReportExport'un içinde) iki kez
  // çalıştırır — kabul edilen bir maliyet: indeksli bir COUNT ms
  // mertebesindedir, PDF'in kendisi zaten dakikalar sürebilecek bir işlem.
  const preflight = await runReport(def, { ...query, page: 1, pageSize: 1 }, siteScope);
  assertPdfRowLimit(def, preflight.totalCount);

  const filenameDate = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${def.id}-${filenameDate}.pdf"`);

  const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape' });
  doc.pipe(res);

  doc.fontSize(16).text(def.title, { align: 'left' });
  doc.fontSize(9).fillColor('#555').text(`Oluşturulma: ${new Date().toLocaleString('tr-TR')}`, { align: 'left' });
  doc.moveDown(0.5);

  const columns = def.columns.filter((c) => c.key !== 'id');
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const totalWidth = columns.reduce((sum, c) => sum + (c.width ?? 15), 0);
  const colWidths = columns.map((c) => ((c.width ?? 15) / totalWidth) * pageWidth);

  function drawRow(values: string[], opts: { header?: boolean } = {}) {
    const y = doc.y;
    doc.fontSize(8).fillColor(opts.header ? '#000' : '#222');
    let x = doc.page.margins.left;
    values.forEach((v, i) => {
      doc.text(v, x, y, { width: colWidths[i], ellipsis: true });
      x += colWidths[i];
    });
    doc.moveDown(0.3);
    if (opts.header) doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#ccc').stroke();
  }

  drawRow(columns.map((c) => c.header), { header: true });

  let rowCount = 0;
  await streamReportExport(def, query, siteScope, (rows) => {
    for (const row of rows) {
      if (doc.y > doc.page.height - doc.page.margins.bottom - 20) {
        doc.addPage();
        drawRow(columns.map((c) => c.header), { header: true });
      }
      drawRow(columns.map((c) => (c.format ? c.format(row[c.key]) : String(row[c.key] ?? ''))));
      rowCount++;
    }
  });

  if (rowCount === 0) {
    doc.moveDown(1).fontSize(10).fillColor('#888').text('Bu filtrelerle eşleşen kayıt bulunamadı.');
  }

  doc.end();
}
