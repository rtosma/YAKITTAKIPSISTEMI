import { apiFetch } from '../utils/api';
import {
  ReportCatalogEntry, ReportRunResult, ExecutiveDashboard, ReportSchedule, ReportDelivery, ReportSchedulePeriod
} from '../types';

/**
 * FE-816 — REP-703/705/723 backend'leri zaten tamdı (bkz. reports/reportEngine.ts,
 * services/reportScheduleService.ts, services/executiveDashboardService.ts);
 * önceden hiç frontend yüzeyi yoktu (frontend/src/pages altında "rapor"
 * geçen tek şey TransactionsPage'in bespoke rep-711 export butonuydu).
 * useAlarms.ts/useMeterReadings.ts İLE AYNI desen: düz `apiFetch` sarmalayıcı
 * fonksiyonlar, global AppContext state'ine yazılmaz.
 */

export async function fetchReportCatalog(): Promise<ReportCatalogEntry[]> {
  const response = await apiFetch('/reports');
  return response.data || [];
}

export interface ReportRunParams {
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  filters?: Record<string, string>;
}

function buildReportQuery(params: ReportRunParams): URLSearchParams {
  const qs = new URLSearchParams();
  if (params.page) qs.set('page', String(params.page));
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  if (params.sortBy) qs.set('sortBy', params.sortBy);
  if (params.sortDir) qs.set('sortDir', params.sortDir);
  Object.entries(params.filters ?? {}).forEach(([k, v]) => { if (v !== undefined && v !== '') qs.set(k, v); });
  return qs;
}

export async function fetchReport(reportId: string, params: ReportRunParams = {}): Promise<ReportRunResult> {
  const qs = buildReportQuery(params).toString();
  const response = await apiFetch(`/reports/${reportId}${qs ? `?${qs}` : ''}`);
  return { data: response.data, pagination: response.pagination, aggregates: response.aggregates, sort: response.sort };
}

/** CSV/PDF/XLSX indirme bağlantısı — `downloadAuthenticatedFile`'a verilecek endpoint. */
export function reportExportEndpoint(reportId: string, format: 'csv' | 'pdf' | 'xlsx', filters: Record<string, string> = {}): string {
  const qs = buildReportQuery({ filters });
  qs.set('format', format);
  return `/reports/${reportId}/export?${qs.toString()}`;
}

export async function fetchExecutiveDashboard(days: number): Promise<ExecutiveDashboard> {
  const response = await apiFetch(`/dashboard/executive?days=${days}`);
  return response.data;
}

function mapSchedule(s: any): ReportSchedule {
  return {
    id: s.id,
    reportId: s.report_id,
    filters: s.filters ?? {},
    format: s.format,
    periodType: s.period_type,
    sendHourLocal: s.send_hour_local,
    dayOfWeek: s.day_of_week,
    dayOfMonth: s.day_of_month,
    recipientUserIds: s.recipient_user_ids ?? [],
    skipIfEmpty: s.skip_if_empty,
    siteScope: s.site_scope,
    enabled: s.enabled,
    nextRunAt: s.next_run_at,
    createdAt: s.created_at,
    updatedAt: s.updated_at
  };
}

function mapDelivery(d: any): ReportDelivery {
  return {
    id: d.id,
    status: d.status,
    attempts: d.attempts,
    rowCount: d.row_count,
    deliveryMode: d.delivery_mode,
    fileSizeBytes: d.file_size_bytes,
    expiresAt: d.expires_at,
    lastError: d.last_error,
    sentAt: d.sent_at,
    createdAt: d.created_at
  };
}

export async function fetchReportSchedules(): Promise<ReportSchedule[]> {
  const response = await apiFetch('/report-schedules');
  return (response.data || []).map(mapSchedule);
}

export interface CreateReportScheduleInput {
  reportId: string;
  filters?: Record<string, string>;
  periodType: ReportSchedulePeriod;
  sendHourLocal: number;
  dayOfWeek?: number;
  dayOfMonth?: number;
  recipientUserIds: string[];
  skipIfEmpty?: boolean;
}

export async function createReportSchedule(input: CreateReportScheduleInput): Promise<ReportSchedule> {
  const response = await apiFetch('/report-schedules', { method: 'POST', body: JSON.stringify({ format: 'CSV', ...input }) });
  return mapSchedule(response.data);
}

export async function updateReportSchedule(id: string, patch: { enabled?: boolean }): Promise<ReportSchedule> {
  const response = await apiFetch(`/report-schedules/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  return mapSchedule(response.data);
}

export async function deleteReportSchedule(id: string): Promise<void> {
  await apiFetch(`/report-schedules/${id}`, { method: 'DELETE' });
}

export async function fetchReportDeliveries(scheduleId: string): Promise<ReportDelivery[]> {
  const response = await apiFetch(`/report-schedules/${scheduleId}/deliveries`);
  return (response.data || []).map(mapDelivery);
}

export const REPORT_SCHEDULE_PERIOD_LABELS: Record<ReportSchedulePeriod, string> = {
  DAILY: 'Günlük',
  WEEKLY: 'Haftalık',
  MONTHLY: 'Aylık'
};

export const REPORT_DELIVERY_STATUS_LABELS: Record<string, string> = {
  BEKLIYOR: 'Bekliyor',
  'GÖNDERILDI': 'Gönderildi',
  'BAŞARISIZ': 'Başarısız (yeniden denenecek)',
  'KALICI_BAŞARISIZ': 'Kalıcı Başarısız',
  'ATLANDI_BOŞ': 'Atlandı (Boş Rapor)'
};

/** backend `computeNextRunAt`'ın `getUTCDay()` karşılaştırmasıyla aynı sabit kodlu haritalama (bkz. reportScheduleService.ts). */
export function dayOfWeekLabel(dow: number): string {
  // computeNextRunAt JS Date.getUTCDay() (0=Pazar) ile karşılaştırır; ancak
  // şema dayOfWeek'i 0-6 aralığında sunarken dokümante bir sabit nokta
  // tanımlamıyor — burada backend'in varsayılanı (dayOfWeek ?? 1 = Pazartesi)
  // ile tutarlı, 0=Pazar başlayan JS haftasına göre etiketleniyor.
  const jsOrder = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
  return jsOrder[dow] ?? String(dow);
}
