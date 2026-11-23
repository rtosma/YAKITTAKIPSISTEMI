import PDFDocument from 'pdfkit';
import { registerFontsOnDocument, drawLogo } from './pdfExport';

/**
 * REP-724 — aylık yönetim raporu PDF şablonu (pdfkit; ticket "pdfmake" öneriyor ama REP-703 çatısı pdfkit kullanır ve Türkçe
 * karakterli Roboto fontu onunla vendored — ikinci bir PDF kütüphanesi eklenmedi).
 *
 * İKİ KATMAN, GÖRSEL OLARAK AYRI (AC: "Model yorumları ile ölçülen veriler ayrı gösterilmelidir"):
 *   MEASURED — beyaz zemin, koyu başlık şeridi "ÖLÇÜLEN VERİ — sistem kayıtları".
 *   MODEL    — krem zemin + amber sol çizgi + her blokta "MODEL YORUMU" etiketi, başlık şeridi "YAPAY ZEKÂ YORUMU — ölçüm değildir".
 * Ayrım yalnızca renk DEĞİL, metindir (siyah-beyaz yazdırmada da okunur).
 *
 * TEST EDİLEBİLİRLİK: poppler'sız ortamlarda (CI) PDF'ten metin okumak güvenilir değildir. Bu yüzden içerik önce SAF bir "blok modeli"ne
 * (`buildMonthlyReportPdfModel`) çevrilir — her blok kaynağını (`origin`) taşır — ve PDF yalnızca bu modeli çizer. Testler modeli
 * (hangi sayı hangi katmanda) ve PDF'in geçerli üretildiğini doğrular; yerelde `pdftotext -layout` ile de aynı içerik okunur (elle doğrulandı).
 */
export type BlockOrigin = 'MEASURED' | 'MODEL';

export type PdfBlock =
  | { kind: 'banner'; origin: BlockOrigin; text: string }
  | { kind: 'kv'; origin: BlockOrigin; label: string; value: string }
  | { kind: 'table'; origin: BlockOrigin; headers: string[]; rows: string[][]; widths: number[] }
  | { kind: 'item'; origin: BlockOrigin; heading: string; text: string; evidence: string[] }
  | { kind: 'note'; origin: BlockOrigin; text: string };

export interface MonthlyReportPdfModel {
  title: string;
  subtitle: string;
  blocks: PdfBlock[];
}

const nfmt = (v: number, d = 2): string => v.toLocaleString('tr-TR', { minimumFractionDigits: d, maximumFractionDigits: d });

export interface PdfFacts {
  month: string;
  scope: 'TENANT' | 'SITE';
  site: string | null;
  totals: { liters: number; cost: number; dispenses: number; alarms: number; prevLiters: number; prevCost: number; litersChangePct: number | null; costChangePct: number | null; vehicleCount: number };
  sites: Array<{ site: string; liters: number; cost: number; dispenses: number; prevLiters: number; prevCost: number; changePct: number | null; alarms: number }>;
  topVehicles: Array<{ plate: string; liters: number; dispenses: number }>;
}

export interface PdfNarrative {
  summary: string | null;
  findings: Array<{ text: string; evidence: string[] }>;
  risks: Array<{ text: string; evidence: string[] }>;
  recommendations: Array<{ text: string; evidence: string[] }>;
}

export interface MonthlyReportPdfInput {
  companyName: string;
  facts: PdfFacts;
  /** MODEL katmanı; null → yorum bu raporda YOK (neden `aiNotice`'te). */
  narrative: PdfNarrative | null;
  aiNotice: string | null;
  rejectedCount: number;
  generatedAt: Date;
}

const pct = (v: number | null): string => (v === null ? 'tanımsız' : `${v > 0 ? '+' : ''}${nfmt(v, 1)} %`);

export function buildMonthlyReportPdfModel(input: MonthlyReportPdfInput): MonthlyReportPdfModel {
  const { facts } = input;
  const t = facts.totals;
  const blocks: PdfBlock[] = [];

  blocks.push({ kind: 'banner', origin: 'MEASURED', text: 'A. ÖLÇÜLEN VERİ — sistem kayıtlarından hesaplanmıştır' });
  if (facts.scope === 'SITE') blocks.push({ kind: 'note', origin: 'MEASURED', text: `Bu rapor yalnızca "${facts.site}" şantiyesini kapsar.` });
  blocks.push({ kind: 'kv', origin: 'MEASURED', label: 'Toplam yakıt', value: `${nfmt(t.liters)} L` });
  blocks.push({ kind: 'kv', origin: 'MEASURED', label: 'Toplam tutar', value: `${nfmt(t.cost)} ₺` });
  blocks.push({ kind: 'kv', origin: 'MEASURED', label: 'İkmal sayısı', value: String(t.dispenses) });
  blocks.push({ kind: 'kv', origin: 'MEASURED', label: 'Farklı araç', value: String(t.vehicleCount) });
  blocks.push({ kind: 'kv', origin: 'MEASURED', label: 'Alarm sayısı', value: String(t.alarms) });
  blocks.push({ kind: 'kv', origin: 'MEASURED', label: 'Önceki aya göre litre değişimi', value: `${pct(t.litersChangePct)} (önceki ay ${nfmt(t.prevLiters)} L)` });
  blocks.push({ kind: 'kv', origin: 'MEASURED', label: 'Önceki aya göre tutar değişimi', value: `${pct(t.costChangePct)} (önceki ay ${nfmt(t.prevCost)} ₺)` });
  blocks.push({
    kind: 'table', origin: 'MEASURED',
    headers: ['Şantiye', 'Litre', 'Tutar (₺)', 'İkmal', 'Önceki ay L', 'Değişim %', 'Alarm'],
    widths: [30, 14, 14, 8, 14, 12, 8],
    rows: facts.sites.map((s) => [s.site, nfmt(s.liters), nfmt(s.cost), String(s.dispenses), nfmt(s.prevLiters), s.changePct === null ? '-' : nfmt(s.changePct, 1), String(s.alarms)])
  });
  if (facts.topVehicles.length > 0) {
    blocks.push({
      kind: 'table', origin: 'MEASURED', headers: ['En çok tüketen araç', 'Litre', 'İkmal'], widths: [50, 25, 25],
      rows: facts.topVehicles.map((v) => [v.plate, nfmt(v.liters), String(v.dispenses)])
    });
  }

  blocks.push({ kind: 'banner', origin: 'MODEL', text: 'B. YAPAY ZEKÂ YORUMU — model çıktısıdır, ölçüm değildir' });
  if (!input.narrative) {
    blocks.push({ kind: 'note', origin: 'MODEL', text: input.aiNotice ?? 'Bu ay için yapay zekâ yorumu bulunmuyor.' });
    blocks.push({ kind: 'note', origin: 'MODEL', text: 'A bölümündeki ölçülen veriler eksiksizdir; yorum bölümünün yokluğu veriyi etkilemez.' });
  } else {
    const n = input.narrative;
    if (n.summary) blocks.push({ kind: 'item', origin: 'MODEL', heading: 'Özet', text: n.summary, evidence: [] });
    const add = (heading: string, items: PdfNarrative['findings']) => items.forEach((i, idx) => blocks.push({ kind: 'item', origin: 'MODEL', heading: `${heading} ${idx + 1}`, text: i.text, evidence: i.evidence }));
    add('Bulgu', n.findings);
    add('Risk', n.risks);
    add('Öneri', n.recommendations);
    if (input.rejectedCount > 0) blocks.push({ kind: 'note', origin: 'MODEL', text: `${input.rejectedCount} model ifadesi sistem verisiyle doğrulanamadığı için bu rapordan çıkarıldı.` });
    blocks.push({ kind: 'note', origin: 'MODEL', text: 'Her bulgu/risk, dayandığı ölçüm sistem verisiyle karşılaştırılarak doğrulanmıştır; öneriler modelin görüşüdür.' });
  }

  return {
    title: `Aylık Yönetim Raporu — ${facts.month}`,
    subtitle: `${input.companyName} — Oluşturulma: ${input.generatedAt.toLocaleString('tr-TR')}`,
    blocks
  };
}

const BAND_MEASURED = '#1f2d3d';
const BAND_MODEL = '#8a5a00';
const MODEL_BG = '#fff7e0';
const MODEL_BAR = '#f0a500';

export async function renderMonthlyReportPdf(model: MonthlyReportPdfModel): Promise<Buffer> {
  const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });
  registerFontsOnDocument(doc);
  const REG = 'ReportRoboto';
  const BOLD = 'ReportRoboto-Bold';
  const x0 = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const ensure = (h: number) => { if (doc.y + h > bottom()) doc.addPage(); };

  drawLogo(doc, x0, doc.page.margins.top);
  doc.font(BOLD).fontSize(16).fillColor('#000').text(model.title, x0 + 36, doc.page.margins.top + 2, { width: width - 36 });
  doc.font(REG).fontSize(9).fillColor('#555').text(model.subtitle, x0 + 36, doc.page.margins.top + 22, { width: width - 36 });
  doc.y = doc.page.margins.top + 44;
  doc.x = x0;

  for (const b of model.blocks) {
    if (b.kind === 'banner') {
      ensure(40);
      doc.moveDown(0.6);
      const y = doc.y;
      doc.rect(x0, y, width, 20).fill(b.origin === 'MODEL' ? BAND_MODEL : BAND_MEASURED);
      doc.font(BOLD).fontSize(10).fillColor('#fff').text(b.text, x0 + 8, y + 5, { width: width - 16, lineBreak: false });
      doc.y = y + 26; doc.x = x0;
    } else if (b.kind === 'kv') {
      ensure(16);
      const y = doc.y;
      doc.font(BOLD).fontSize(10).fillColor('#000').text(`${b.label}:`, x0, y, { width: 210, continued: false });
      doc.font(REG).fontSize(10).fillColor('#222').text(b.value, x0 + 215, y, { width: width - 215 });
      doc.y = Math.max(doc.y, y + 15); doc.x = x0;
    } else if (b.kind === 'table') {
      const total = b.widths.reduce((a, c) => a + c, 0);
      const cols = b.widths.map((w) => (w / total) * width);
      const rowH = 16;
      const drawRow = (cells: string[], bold: boolean, fill?: string) => {
        ensure(rowH + 2);
        const y = doc.y;
        if (fill) doc.rect(x0, y, width, rowH).fill(fill);
        let cx = x0;
        cells.forEach((c, i) => {
          doc.font(bold ? BOLD : REG).fontSize(8.5).fillColor('#000').text(c, cx + 3, y + 4, { width: cols[i] - 6, lineBreak: false, ellipsis: true });
          cx += cols[i];
        });
        doc.y = y + rowH; doc.x = x0;
      };
      doc.moveDown(0.4);
      drawRow(b.headers, true, '#e8edf2');
      b.rows.forEach((r, i) => drawRow(r, false, i % 2 === 1 ? '#f6f8fa' : undefined));
      doc.moveDown(0.3);
    } else if (b.kind === 'item') {
      const evText = b.evidence.length > 0 ? `Dayanak (doğrulandı): ${b.evidence.join(' · ')}` : '';
      const textH = doc.font(REG).fontSize(10).heightOfString(b.text, { width: width - 24 });
      const evH = evText ? doc.font(REG).fontSize(8).heightOfString(evText, { width: width - 24 }) + 3 : 0;
      const h = 12 + textH + evH + 8;
      ensure(h + 4);
      const y = doc.y;
      doc.rect(x0, y, width, h).fill(MODEL_BG);
      doc.rect(x0, y, 4, h).fill(MODEL_BAR);
      doc.font(BOLD).fontSize(8).fillColor(BAND_MODEL).text(`MODEL YORUMU · ${b.heading}`, x0 + 12, y + 4, { width: width - 24, lineBreak: false });
      doc.font(REG).fontSize(10).fillColor('#222').text(b.text, x0 + 12, y + 16, { width: width - 24 });
      if (evText) doc.font(REG).fontSize(8).fillColor('#666').text(evText, x0 + 12, y + 16 + textH + 2, { width: width - 24 });
      doc.y = y + h + 4; doc.x = x0;
    } else {
      const h = doc.font(REG).fontSize(9).heightOfString(b.text, { width: width - 24 }) + 10;
      ensure(h + 4);
      const y = doc.y;
      if (b.origin === 'MODEL') { doc.rect(x0, y, width, h).fill(MODEL_BG); doc.rect(x0, y, 4, h).fill(MODEL_BAR); }
      doc.font(REG).fontSize(9).fillColor('#444').text(b.text, x0 + 12, y + 5, { width: width - 24 });
      doc.y = y + h + 2; doc.x = x0;
    }
  }

  const range = doc.bufferedPageRange();
  const originalBottom = doc.page.margins.bottom;
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    doc.font(REG).fontSize(8).fillColor('#888').text(`Sayfa ${i - range.start + 1} / ${range.count}`, x0, doc.page.height - 24, { width, align: 'center', lineBreak: false });
    doc.page.margins.bottom = originalBottom;
  }
  doc.end();
  return done;
}

export async function buildMonthlyReportPdfBuffer(input: MonthlyReportPdfInput): Promise<Buffer> {
  return renderMonthlyReportPdf(buildMonthlyReportPdfModel(input));
}
