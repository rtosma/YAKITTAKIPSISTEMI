import * as XLSX from 'xlsx';

export interface ExportColumnConfig<T> {
  header: string;
  key: keyof T | ((row: T) => any);
  isTotalable?: boolean;
  width?: number;
  format?: 'number' | 'currency' | 'text';
}

export interface ExportOptions<T> {
  data: T[];
  columns: ExportColumnConfig<T>[];
  sheetName?: string;
  filename?: string;
  totalLabelColumnIndex?: number;
  totalLabel?: string;
}

/**
 * Reusable helper function to export tabular data to an Excel (.xlsx) file
 * with an automatically calculated "GENEL TOPLAM" (Grand Total) row at the bottom.
 */
export function exportToExcelWithTotals<T>(options: ExportOptions<T>) {
  const {
    data,
    columns,
    sheetName = 'Yakıt Raporu',
    filename = `yakit_raporu_${new Date().toISOString().split('T')[0]}.xlsx`,
    totalLabelColumnIndex = 0,
    totalLabel = 'GENEL TOPLAM'
  } = options;

  // 1. Build individual data rows
  const rawRows = data.map(item => {
    const rowObj: Record<string, any> = {};
    columns.forEach(col => {
      const value = typeof col.key === 'function' ? col.key(item) : item[col.key];
      rowObj[col.header] = value;
    });
    return rowObj;
  });

  // 2. Dynamically calculate totals for columns marked as `isTotalable`
  const totalsObj: Record<string, any> = {};

  columns.forEach((col, index) => {
    if (index === totalLabelColumnIndex) {
      totalsObj[col.header] = totalLabel;
    } else if (col.isTotalable) {
      const sum = data.reduce((acc, item) => {
        const val = typeof col.key === 'function' ? col.key(item) : item[col.key];
        const num = typeof val === 'number' ? val : parseFloat(val) || 0;
        return acc + num;
      }, 0);

      // Round to 2 decimal places
      const roundedSum = Math.round(sum * 100) / 100;

      if (col.format === 'currency') {
        totalsObj[col.header] = `${roundedSum.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺`;
      } else {
        totalsObj[col.header] = roundedSum;
      }
    } else {
      totalsObj[col.header] = '';
    }
  });

  // Combine rows + total summary row
  const fullExportData = [...rawRows, totalsObj];

  // 3. Create Worksheet & Workbook
  const worksheet = XLSX.utils.json_to_sheet(fullExportData);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);

  // 4. Auto-calculate / apply column widths
  const colWidths = columns.map(col => {
    const headerLen = col.header.length;
    return { wch: col.width || Math.max(headerLen + 4, 14) };
  });
  worksheet['!cols'] = colWidths;

  // 5. Trigger download
  XLSX.writeFile(workbook, filename);
}
