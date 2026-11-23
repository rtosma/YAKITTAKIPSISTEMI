import { Response } from 'express';
import { ReportDefinition, ReportViewer } from './reportTypes';
import { streamReportExport, ReportQueryParams } from './reportEngine';

/**
 * REP-703 — CSV export, TÜM raporlar için ortak. RFC 4182/4180 kaçışı elle
 * yapılıyor: yeni bir bağımlılık (`csv-stringify` vb.) eklemeye değecek
 * kadar karmaşık değil (virgül/tırnak/satır sonu → tek kural: değeri
 * çift tırnağa al, içindeki `"`'ı `""` yap) ve REP-701'in "bellek dostu
 * stream" ilkesiyle aynı — satırlar DB'den geldikçe doğrudan response'a
 * yazılır, hiçbir yerde tüm sonuç kümesi biriktirilmez.
 */
function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function formatCsvRow(def: ReportDefinition, row: Record<string, unknown>): string {
  return def.columns.map((c) => csvEscape(c.format ? c.format(row[c.key], row) : row[c.key])).join(',');
}

export async function streamReportToCsv(res: Response, def: ReportDefinition, query: ReportQueryParams, siteScope: string | undefined, viewer?: ReportViewer): Promise<void> {
  const filenameDate = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${def.id}-${filenameDate}.csv"`);
  // Excel'in Türkçe karakterleri (İ, Ş, Ğ...) BOM olmadan bozması bilinen bir
  // sorundur — REP-701'in .xlsx'i bu soruna hiç girmez ama düz CSV girer.
  res.write('﻿');
  res.write(def.columns.map((c) => csvEscape(c.header)).join(',') + '\r\n');

  await streamReportExport(def, query, siteScope, (rows) => {
    for (const row of rows) {
      res.write(formatCsvRow(def, row) + '\r\n');
    }
  }, viewer);

  res.end();
}

/**
 * REP-702 — arşiv ZIP'i içine gömülecek CSV içeriğini bir Express `Response`
 * OLMADAN, doğrudan bellekte üretir (`streamReportToCsv`'nin akışlı yazma
 * hedefi burada yok — arşiv motoru içeriği archiver'a Buffer olarak verir).
 * Dönemsel arşivlerdeki satır sayısı (varsayılan 90 gün) `streamReportExport`'un
 * bellek-dostu keyset sayfalamasıyla zaten sınırlı olduğundan tüm çıktının
 * bir kerede biriktirilmesi (streamReportToCsv'nin bilerek YAPMADIĞI şey)
 * burada kabul edilebilir bir maliyettir.
 */
export async function buildReportCsvBuffer(def: ReportDefinition, query: ReportQueryParams, siteScope: string | undefined): Promise<Buffer> {
  const lines: string[] = [def.columns.map((c) => csvEscape(c.header)).join(',')];
  await streamReportExport(def, query, siteScope, (rows) => {
    for (const row of rows) lines.push(formatCsvRow(def, row));
  });
  return Buffer.from('﻿' + lines.join('\r\n') + '\r\n', 'utf-8');
}
