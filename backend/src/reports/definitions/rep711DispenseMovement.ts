import { registerReport } from '../reportRegistry';
import { ReportDefinition } from '../reportTypes';

/**
 * REP-711 (#168) — İkmal Hareket Raporu. REP-703 çatısının İLK kayıtlı
 * raporu: "yeni bir rapor yalnızca tanım eklenerek üretilebilmeli" AC'sinin
 * kanıtı — burada hiçbir yeni route/SQL/pagination kodu YOK, sadece bir
 * tanım. `transactions` tablosu ve filtre kümesi REP-701'in
 * `buildTransactionFilterClause`'ıyla (tenantDb.ts) BİLİNÇLİ olarak aynı
 * alanları kapsar — iki farklı raporun aynı veriye farklı sunumlarla
 * (REP-701: tam Excel dökümü + GENEL TOPLAM; REP-711: sayfalı/filtrelenmiş
 * + CSV/PDF) erişmesi beklenen bir durumdur.
 */
export const rep711DispenseMovement: ReportDefinition = {
  id: 'rep-711',
  title: 'İkmal Hareket Raporu',
  description: 'Tarih, şantiye, araç, sürücü ve tip filtreleriyle ikmal hareketleri.',
  table: 'transactions',
  columns: [
    { key: 'id', header: 'ID' },
    { key: 'created_at', header: 'Tarih', width: 20, format: (v) => new Date(v as string).toLocaleString('tr-TR') },
    { key: 'site_name', header: 'Şantiye', width: 22 },
    { key: 'vehicle_plate', header: 'Araç Plakası', width: 14 },
    { key: 'driver_name', header: 'Sürücü', width: 20 },
    { key: 'tank_name', header: 'Tank', width: 16 },
    { key: 'amount_liters', header: 'Alınan Miktar (Litre)', width: 18, format: (v) => Number(v).toFixed(2) },
    { key: 'pump_status', header: 'Pompa Durumu', width: 16 },
    { key: 'type', header: 'Tip', width: 18 }
  ],
  filters: [
    { key: 'startDate', column: 'created_at', type: 'dateFrom', label: 'Başlangıç Tarihi' },
    { key: 'endDate', column: 'created_at', type: 'dateToExclusiveNextDay', label: 'Bitiş Tarihi' },
    { key: 'siteName', column: 'site_name', type: 'exact', label: 'Şantiye' },
    { key: 'vehiclePlate', column: 'vehicle_plate', type: 'ilike', label: 'Araç Plakası' },
    { key: 'driverName', column: 'driver_name', type: 'exact', label: 'Sürücü' },
    { key: 'pumpStatus', column: 'pump_status', type: 'exact', label: 'Pompa Durumu' },
    { key: 'type', column: 'type', type: 'exact', label: 'Tip' }
  ],
  aggregates: [{ key: 'total_liters', column: 'amount_liters', fn: 'SUM', label: 'Toplam Litre' }],
  allowedRoles: ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER', 'PUMP_OPERATOR'],
  defaultSort: { column: 'created_at', direction: 'DESC' },
  siteScopeColumn: 'site_name'
};

registerReport(rep711DispenseMovement);
