// Node ESM'de exceljs'in (saf CJS) `import * as ExcelJS` ile namespace
// import'u statik analizle isimlendirilmiş export'ları YAKALAYAMIYOR —
// `ExcelJS.Workbook` undefined kalıyor. `esModuleInterop`'un ürettiği
// senkron default import ise CJS module.exports'un TAMAMINI taşıyor,
// bu yüzden yalnızca bu biçim kullanılmalı.
import ExcelJS from 'exceljs';
import { Response } from 'express';
import {
  TransactionFilters,
  TransactionRecord,
  getTransactionExportAggregate,
  streamTenantTransactionsForExport
} from '../db/tenantDb';

/**
 * REP-701 — sunucu belleğini tüketmeden ikmal geçmişini .xlsx olarak dışa
 * aktarma.
 *
 * `ExcelJS.stream.xlsx.WorkbookWriter` satırları oluşturuldukça (tek tek
 * `.commit()` ile) doğrudan HTTP response'una yazar; tüm workbook hiçbir
 * zaman bellekte tutulmaz. `useStyles`/`useSharedStrings` kapalı — hiçbir
 * hücrede özel biçim veya tekrarlayan string havuzu kullanılmıyor, ikisi de
 * yalnızca ekstra bellek/CPU maliyeti getirirdi. Satırlar kendisi de
 * `streamTenantTransactionsForExport` tarafından DB'den zaten
 * EXPORT_BATCH_SIZE'lık gruplar halinde (tüm sonuç kümesi tek seferde değil)
 * geliyor — bu iki katman birlikte AC'nin "100.000 satırda 150 MB'ı
 * aşmamalı" şartını sağlıyor.
 *
 * Bilinçli sapma: ticket'ın AC'si "Toplam Tutar" (para birimi) sütunu için
 * de dinamik bir GENEL TOPLAM istiyor; ancak bu sistemde (schema.sql,
 * tenantDb.ts) hiçbir yerde bir yakıt birim fiyatı / faturalama alanı yok —
 * platform şu an yalnızca lojistik/telemetri takibi yapıyor, bir
 * faturalama modeli içermiyor. Bu yüzden GENEL TOPLAM satırı yalnızca
 * "Alınan Miktar (Litre)" için üretiliyor; "Toplam Tutar" ayrı bir
 * fiyatlandırma/faturalama epic'i (örn. COMP-601/602 civarı) gerektirir ve
 * bu ticket'ın kapsamı dışında bırakılmıştır.
 */

const EXPORT_COLUMNS: Array<{ header: string; key: string; width: number }> = [
  { header: 'Tarih', key: 'created_at', width: 20 },
  { header: 'Şantiye', key: 'site_name', width: 22 },
  { header: 'Araç Plakası', key: 'vehicle_plate', width: 14 },
  { header: 'Sürücü', key: 'driver_name', width: 20 },
  { header: 'Tank', key: 'tank_name', width: 16 },
  { header: 'Alınan Miktar (Litre)', key: 'amount_liters', width: 20 },
  { header: 'Pompa Durumu', key: 'pump_status', width: 16 },
  { header: 'Tip', key: 'type', width: 18 }
];

function toExportRow(row: TransactionRecord): Record<string, unknown> {
  return {
    created_at: new Date(row.created_at).toLocaleString('tr-TR'),
    site_name: row.site_name,
    vehicle_plate: row.vehicle_plate,
    driver_name: row.driver_name ?? '-',
    tank_name: row.tank_name ?? '-',
    amount_liters: Number(row.amount_liters),
    pump_status: row.pump_status,
    type: row.type
  };
}

export async function streamTransactionsToExcel(
  res: Response,
  filters: TransactionFilters,
  siteRestriction: string | undefined
): Promise<void> {
  // AC: dinamik GENEL TOPLAM satırı — filtreye uyan TÜM kayıtlar üzerinden
  // (yalnızca akışa giren sayfa değil), akış başlamadan önce tek sorguda
  // hesaplanıyor.
  const aggregate = await getTransactionExportAggregate(filters, siteRestriction);

  const filenameDate = new Date().toISOString().slice(0, 10);
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="ikmal-gecmisi-${filenameDate}.xlsx"`
  );

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: res,
    useStyles: false,
    useSharedStrings: false
  });
  const worksheet = workbook.addWorksheet('İkmal Geçmişi');
  worksheet.columns = EXPORT_COLUMNS;

  await streamTenantTransactionsForExport(filters, siteRestriction, async (rows: TransactionRecord[]) => {
    for (const row of rows) {
      worksheet.addRow(toExportRow(row)).commit();
    }
  });

  worksheet.addRow({ created_at: 'GENEL TOPLAM', amount_liters: aggregate.totalLiters }).commit();

  worksheet.commit();
  await workbook.commit();
}
