// pdfkit saf JS'tir (native binding yok) ama standart font verilerini (.afm)
// paket dizinine göre RELATİF `fs.readFileSync` ile okur — esbuild ile
// bundle edilirse bu yol kırılır. backend/package.json'daki build script'i
// bu yüzden diğer "asset okuyan" paketlerle (swagger-jsdoc, libxmljs2) AYNI
// desende `--external:pdfkit` ile işaretlendi (bkz. o script'teki yorum).
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
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
 *
 * `bufferPages: true`: sayfa numaraları ("Sayfa X / Y") toplam sayfa
 * sayısını bilmeden yazılamaz — bu, pdfkit'in TÜM sayfaları belleğe alıp
 * `doc.end()`'den önce geriye dönüp her sayfaya damga basmasını gerektirir.
 * Bu satır sınırı (yukarıdaki not) YÜZÜNDEN zaten güvenli: rapor 2000
 * satırla sınırlı olduğu için buffer'lanan sayfa sayısı da sınırlı.
 */

// pdfkit'in gömülü standart-14 fontları (Helvetica vb.) WinAnsiEncoding
// kullanır — Türkçe'ye özgü ş/Ş/ğ/Ğ/ı/İ bu kodlamada YOK ve sessizce yanlış
// glif'lere dönüşüyordu (canlı doğrulandı, bkz. assets/fonts/ATTRIBUTION.md).
// Roboto (Apache-2.0, vendored) Latin Extended-A'yı kapsıyor.
const FONTS_DIR = path.join(process.cwd(), 'src', 'reports', 'assets', 'fonts');
const FONT_REGULAR = 'ReportRoboto';
const FONT_BOLD = 'ReportRoboto-Bold';
// `doc.registerFont()` bir PDFDocument ÖRNEĞİNE kayıtlıdır, süreç genelinde
// DEĞİL — her /export isteği YENİ bir `doc` oluşturur. İlk sürüm burada
// "bir kez kaydedildi mi" bayrağını YANLIŞLIKLA SÜREÇ genelinde tutuyordu:
// ilk PDF isteği fontu kendi doc'una kaydedip bayrağı true yapıyor, AYNI
// çalışan sunucudaki HER SONRAKİ istek bu yüzden kaydı ATLIYORDU — pdfkit
// tanımadığı font adını bir DOSYA YOLU sanıp `ENOENT` ile 500 patlıyordu
// (canlı doğrulandı: ilk istek OK, ikinci istek 500). Dosya OKUMASI (aşağıda,
// gerçekten süreç genelinde tekil) ile doc'a KAYIT (her doc için ayrı,
// aşağıda HER ÇAĞRIDA) birbirinden ayrılmalı.
let cachedFontBuffers: { regular: Buffer; bold: Buffer } | null = null;
function registerFontsOnDocument(doc: PDFKit.PDFDocument): void {
  if (!cachedFontBuffers) {
    cachedFontBuffers = {
      regular: fs.readFileSync(path.join(FONTS_DIR, 'Roboto-Regular.woff')),
      bold: fs.readFileSync(path.join(FONTS_DIR, 'Roboto-Bold.woff'))
    };
  }
  doc.registerFont(FONT_REGULAR, cachedFontBuffers.regular);
  doc.registerFont(FONT_BOLD, cachedFontBuffers.bold);
}

// Kurumsal bir logo dosyası YOK (repo genelinde arandı, bulunamadı — frontend
// de bir görsel değil, metin + Material Symbols glyph'i kullanıyor). Gerçek
// olmayan bir "kurumsal logo" dosyası icat etmek yerine, frontend'in KENDİ
// marka paletiyle (LoginPage.tsx amber teması #ffdca1/#412d00) pdfkit'in
// vektör çizim primitifleriyle üretilen basit bir monogram kullanılıyor —
// yeni bir görsel varlık eklemeden.
const BRAND_AMBER = '#ffdca1';
const BRAND_DARK = '#412d00';
const LOGO_SIZE = 26;

function drawLogo(doc: PDFKit.PDFDocument, x: number, y: number): void {
  doc.roundedRect(x, y, LOGO_SIZE, LOGO_SIZE, 6).fill(BRAND_AMBER);
  doc.font(FONT_BOLD).fontSize(11).fillColor(BRAND_DARK).text('AŞ', x, y + 7, { width: LOGO_SIZE, align: 'center' });
}

function drawHeader(doc: PDFKit.PDFDocument, def: ReportDefinition): void {
  const startX = doc.page.margins.left;
  const startY = doc.page.margins.top;
  drawLogo(doc, startX, startY);
  doc.font(FONT_BOLD).fontSize(16).fillColor('#000').text(def.title, startX + LOGO_SIZE + 10, startY + 2);
  doc.font(FONT_REGULAR).fontSize(9).fillColor('#555').text(`Akıllı Şantiye — Oluşturulma: ${new Date().toLocaleString('tr-TR')}`, startX + LOGO_SIZE + 10, startY + 20);
  doc.y = startY + LOGO_SIZE + 8;
  doc.x = startX;
}

/**
 * AC: "sayfa numarası" — bufferPages sayesinde toplam sayfa sayısı bilinir.
 *
 * `doc.page.margins.bottom` GEÇİCİ olarak 0'a çekiliyor: pdfkit `.text()`'in
 * hesapladığı y-konumu geçerli sayfanın maxY'sini (height - margins.bottom)
 * AŞARSA otomatik olarak YENİ bir sayfa ekliyor — alt kenar boşluğunun İÇİNE
 * (margins.bottom'un ayırdığı boş alana) bir altbilgi yazmak tam olarak bunu
 * tetikliyordu: `switchToPage(i)` + `.text()` her çağrıda son sayfanın
 * SONUNA yeni, neredeyse boş bir sayfa ekliyordu (5 içerik sayfası + 5
 * "Sayfa X / Y"-only sayfa → toplam 10 — canlı doğrulandı). margins.bottom'u
 * 0'a çekmek maxY kontrolünü etkisiz kılıyor, `lineBreak:false` ek bir
 * güvenlik önlemi.
 */
function stampPageNumbers(doc: PDFKit.PDFDocument): void {
  const range = doc.bufferedPageRange();
  const originalBottomMargin = doc.page.margins.bottom;
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    doc.font(FONT_REGULAR).fontSize(8).fillColor('#888').text(`Sayfa ${i - range.start + 1} / ${range.count}`, doc.page.margins.left, doc.page.height - 24, {
      width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
      align: 'center',
      lineBreak: false
    });
    doc.page.margins.bottom = originalBottomMargin;
  }
}

/** AC: "imza alanı" — dokümanın SONUNDA, tek bir "Hazırlayan/Onaylayan" bloğu. */
function drawSignatureBlock(doc: PDFKit.PDFDocument): void {
  const blockHeight = 60;
  if (doc.y > doc.page.height - doc.page.margins.bottom - blockHeight) {
    doc.addPage();
  }
  doc.moveDown(2);
  const y = doc.y;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidth = usableWidth / 2;
  const leftX = doc.page.margins.left;
  const rightX = leftX + colWidth;

  doc.font(FONT_REGULAR).fontSize(9).fillColor('#000');
  doc.moveTo(leftX, y + 24).lineTo(leftX + colWidth - 20, y + 24).strokeColor('#999').stroke();
  doc.text('Hazırlayan', leftX, y + 28);
  doc.moveTo(rightX, y + 24).lineTo(rightX + colWidth - 20, y + 24).strokeColor('#999').stroke();
  doc.text('Onaylayan', rightX, y + 28);
}

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

  const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape', bufferPages: true });
  doc.pipe(res);
  registerFontsOnDocument(doc);

  drawHeader(doc, def);
  doc.moveDown(0.5);

  const columns = def.columns.filter((c) => c.key !== 'id');
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const totalWidth = columns.reduce((sum, c) => sum + (c.width ?? 15), 0);
  const colWidths = columns.map((c) => ((c.width ?? 15) / totalWidth) * pageWidth);

  function drawRow(values: string[], opts: { header?: boolean } = {}) {
    const y = doc.y;
    doc.font(opts.header ? FONT_BOLD : FONT_REGULAR).fontSize(8).fillColor(opts.header ? '#000' : '#222');
    // `ellipsis:true` yalnızca `height` de VERİLİRSE tek satıra kısaltır —
    // aksi halde metin (özellikle uzun şantiye adları) sınırsız SATIR
    // sarıyor ve bir sonraki satırın ÜSTÜNE biniyordu (canlı doğrulandı).
    // Sabit `height` her hücreyi tek satıra kilitliyor — bu da her satırın
    // sabit yükseklikte olduğu (aşağıdaki moveDown(0.3) ile tutarlı) yoğun
    // bir tablo görünümü için doğru davranış.
    const cellHeight = doc.currentLineHeight();
    let x = doc.page.margins.left;
    values.forEach((v, i) => {
      doc.text(v, x, y, { width: colWidths[i], height: cellHeight, ellipsis: true });
      x += colWidths[i];
    });
    // Her hücre TEK satıra kilitli (height: cellHeight) — satırın gerçek
    // yüksekliği bu yüzden sabit ve bilinir; doc.y'yi satırın BAŞINA değil,
    // bu bilinen yüksekliğin SONUNA taşıyoruz (aradaki 0.3 satır boşluk için).
    doc.y = y + cellHeight;
    doc.moveDown(0.3);
    if (opts.header) doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#ccc').stroke();
  }

  drawRow(columns.map((c) => c.header), { header: true });

  let rowCount = 0;
  await streamReportExport(def, query, siteScope, (rows) => {
    for (const row of rows) {
      // Alt bilgi (sayfa numarası) için de yer bırak, aksi halde son satır üstüne biner.
      if (doc.y > doc.page.height - doc.page.margins.bottom - 30) {
        doc.addPage();
        drawHeader(doc, def);
        doc.moveDown(0.5);
        drawRow(columns.map((c) => c.header), { header: true });
      }
      drawRow(columns.map((c) => (c.format ? c.format(row[c.key]) : String(row[c.key] ?? ''))));
      rowCount++;
    }
  });

  if (rowCount === 0) {
    doc.moveDown(1).font(FONT_REGULAR).fontSize(10).fillColor('#888').text('Bu filtrelerle eşleşen kayıt bulunamadı.');
  }

  drawSignatureBlock(doc);
  stampPageNumbers(doc);
  doc.end();
}
