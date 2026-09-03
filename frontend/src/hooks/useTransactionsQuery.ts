import { useEffect, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { apiFetch } from '../utils/api';
import { FuelTransaction } from '../types';

/**
 * FE-802 — GET /transactions sunucu taraflı sayfalama + filtreleme yapıyor
 * (bkz. backend/src/db/tenantDb.ts getTenantTransactionsPaginated). Bu dosya
 * TransactionsPage'in o uç noktayı TanStack Query ile tüketmesini sağlıyor:
 * eskiden tüm geçmiş (üst sınır 200) tek seferde çekilip filtreleme/sayfalama
 * tamamen istemci tarafında yapılıyordu — artık her filtre/sayfa değişimi
 * sunucuya ayrı, dar kapsamlı bir istek olarak gidiyor.
 */

export interface TransactionQueryFilters {
  page: number;
  pageSize: number;
  startDate?: string;
  endDate?: string;
  siteName?: string;
  driverName?: string;
  pumpStatus?: string;
  type?: string;
  search?: string;
}

export interface PaginatedTransactionsResult {
  transactions: FuelTransaction[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  totalLiters: number;
}

function mapTransaction(t: any): FuelTransaction {
  return {
    id: t.id,
    timestamp: new Date(t.created_at).toLocaleString('tr-TR').replace(',', ''),
    siteName: t.site_name,
    vehiclePlate: t.vehicle_plate,
    driverName: t.driver_name || '',
    tankName: t.tank_name || '',
    amountLiters: Number(t.amount_liters),
    flowRateLpm: t.flow_rate_lpm != null ? Number(t.flow_rate_lpm) : 0,
    pumpStatus: t.pump_status,
    type: t.type,
    rfidAuth: t.rfid_auth
  };
}

function buildQueryString(filters: TransactionQueryFilters | Omit<TransactionQueryFilters, 'page' | 'pageSize'> & { page: number; pageSize: number }): string {
  const params = new URLSearchParams();
  params.set('page', String(filters.page));
  params.set('pageSize', String(filters.pageSize));
  if (filters.startDate) params.set('startDate', filters.startDate);
  if (filters.endDate) params.set('endDate', filters.endDate);
  if (filters.siteName && filters.siteName !== 'TÜMÜ') params.set('siteName', filters.siteName);
  if (filters.driverName && filters.driverName !== 'TÜMÜ') params.set('driverName', filters.driverName);
  if (filters.pumpStatus && filters.pumpStatus !== 'TÜMÜ') params.set('pumpStatus', filters.pumpStatus);
  if (filters.type && filters.type !== 'TÜMÜ') params.set('type', filters.type);
  if (filters.search && filters.search.trim()) params.set('search', filters.search.trim());
  return params.toString();
}

async function fetchTransactionsPage(filters: TransactionQueryFilters): Promise<PaginatedTransactionsResult> {
  const qs = buildQueryString(filters);
  const response = await apiFetch(`/transactions?${qs}`);
  const rows: FuelTransaction[] = (response.data || []).map(mapTransaction);
  return {
    transactions: rows,
    page: response.pagination?.page ?? filters.page,
    pageSize: response.pagination?.pageSize ?? filters.pageSize,
    totalCount: response.pagination?.totalCount ?? rows.length,
    totalPages: response.pagination?.totalPages ?? 1,
    totalLiters: Number(response.pagination?.totalLiters ?? 0)
  };
}

export function useTransactionsQuery(filters: TransactionQueryFilters) {
  return useQuery<PaginatedTransactionsResult, Error>({
    queryKey: ['transactions', filters],
    queryFn: () => fetchTransactionsPage(filters),
    // Sayfa/filtre değişirken tablo anlık boşalıp yeniden dolmasın diye
    // önceki sayfanın verisi arka planda yeni istek dönene kadar gösterilir.
    placeholderData: keepPreviousData
  });
}

/**
 * Excel'e aktarım, ekranda görünen tek sayfayı değil filtreye uyan TÜM
 * kayıtları içermeli. Backend tek istekte en fazla 100 satır veriyor
 * (bkz. transactionQuerySchema pageSize max), bu yüzden burada tüm sayfalar
 * bitene kadar art arda isteniyor ve birleştiriliyor.
 */
export async function fetchAllFilteredTransactions(
  filters: Omit<TransactionQueryFilters, 'page' | 'pageSize'>
): Promise<FuelTransaction[]> {
  const EXPORT_PAGE_SIZE = 100;
  let page = 1;
  let all: FuelTransaction[] = [];

  // Güvenlik amaçlı üst sınır: sonsuz döngüye karşı en fazla 50 sayfa (5000 kayıt).
  for (let guard = 0; guard < 50; guard += 1) {
    const result = await fetchTransactionsPage({ ...filters, page, pageSize: EXPORT_PAGE_SIZE });
    all = all.concat(result.transactions);
    if (page >= result.totalPages || result.transactions.length === 0) break;
    page += 1;
  }

  return all;
}

/** Kullanıcı yazmayı bitirdikten ~gecikme sonra değeri günceller — arama
 * kutusunda her tuş vuruşunda ayrı bir sunucu isteği atılmasını önler. */
export function useDebouncedValue<T>(value: T, delayMs: number = 400): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
