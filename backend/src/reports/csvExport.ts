import { Response } from 'express';
import { ReportDefinition } from './reportTypes';
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

export async function streamReportToCsv(res: Response, def: ReportDefinition, query: ReportQueryParams, siteScope: string | undefined): Promise<void> {
  const filenameDate = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${def.id}-${filenameDate}.csv"`);
  // Excel'in Türkçe karakterleri (İ, Ş, Ğ...) BOM olmadan bozması bilinen bir
  // sorundur — REP-701'in .xlsx'i bu soruna hiç girmez ama düz CSV girer.
  res.write('﻿');
  res.write(def.columns.map((c) => csvEscape(c.header)).join(',') + '\r\n');

  await streamReportExport(def, query, siteScope, (rows) => {
    for (const row of rows) {
      const line = def.columns.map((c) => csvEscape(c.format ? c.format(row[c.key]) : row[c.key])).join(',');
      res.write(line + '\r\n');
    }
  });

  res.end();
}
