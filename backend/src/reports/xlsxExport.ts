// exceljs saf CJS: `import * as` ile namespace import'u ESM'de isimlendirilmiş export'ları yakalayamaz — bkz. services/transactionExportService.ts.
import ExcelJS from 'exceljs';
import { Response } from 'express';
import { ReportDefinition, ReportViewer } from './reportTypes';
import { streamReportExport, ReportQueryParams } from './reportEngine';

/**
 * REP-703 çatısına REP-724 ile eklenen Excel (.xlsx) çıktısı — TÜM raporlar için ortak.
 *
 * TUTARLILIK (AC: "Excel, PDF ve CSV aynı veriyi tutarlı üretmelidir"): satırlar CSV/PDF ile AYNI kaynaktan
 * (`streamReportExport` — aynı filtre/kapsam/PII maskesi/sıralama) ve AYNI `column.format` fonksiyonundan geçer; fark yalnızca
 * hücre TİPİdir: biçimlenmiş değer düz ondalık bir sayıysa ("1234.50") Excel'de SAYI hücresi olur (toplanabilir/sıralanabilir),
 * değilse metin kalır. Sayı hücresinin değeri CSV'deki metinle aynı sayıdır (1234.50 → 1234.5).
 *
 * BELLEK: `stream.xlsx.WorkbookWriter` satırları yazıldıkça response'a akıtır (REP-701 ile aynı gerekçe); tüm sonuç kümesi
 * bellekte tutulmaz. Buffer üreticisi (`buildReportXlsxBuffer`) e-posta eki/test içindir ve sonucu biriktirir.
 */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;
const MAX_HEADER_WIDTH = 40;

export function xlsxCellValue(def: ReportDefinition, colIdx: number, row: Record<string, unknown>): string | number | null {
  const c = def.columns[colIdx];
  const raw = row[c.key];
  const formatted = c.format ? c.format(raw, row) : raw;
  if (formatted === null || formatted === undefined) return null;
  const text = String(formatted);
  return PLAIN_NUMBER.test(text) ? Number(text) : text;
}

function addSheet(wb: ExcelJS.stream.xlsx.WorkbookWriter | ExcelJS.Workbook, def: ReportDefinition) {
  const sheet = wb.addWorksheet(def.id.slice(0, 31));
  sheet.columns = def.columns.map((c) => ({ header: c.header, key: c.key, width: Math.min(MAX_HEADER_WIDTH, Math.max(10, c.width ?? 14)) }));
  sheet.getRow(1).font = { bold: true };
  return sheet;
}

export async function streamReportToXlsx(res: Response, def: ReportDefinition, query: ReportQueryParams, siteScope: string | undefined, viewer?: ReportViewer): Promise<void> {
  const filenameDate = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${def.id}-${filenameDate}.xlsx"`);

  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true, useSharedStrings: false });
  const sheet = addSheet(wb, def);
  await streamReportExport(def, query, siteScope, (rows) => {
    for (const row of rows) sheet.addRow(def.columns.map((_c, i) => xlsxCellValue(def, i, row))).commit();
  }, viewer);
  sheet.commit();
  await wb.commit();
}

export async function buildReportXlsxBuffer(def: ReportDefinition, query: ReportQueryParams, siteScope: string | undefined, viewer?: ReportViewer): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = addSheet(wb, def);
  await streamReportExport(def, query, siteScope, (rows) => {
    for (const row of rows) sheet.addRow(def.columns.map((_c, i) => xlsxCellValue(def, i, row)));
  }, viewer);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
