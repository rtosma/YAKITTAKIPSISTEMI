import { apiFetch } from '../utils/api';
import { Alarm, AlarmStatus, TenantUser } from '../types';

/**
 * FE-815 — AI-507'nin zaten tam olan /alarms backend'i için önceden hiç
 * frontend arayüzü yoktu. useMeterReadings.ts/useCalibration.ts İLE AYNI
 * desen: global AppContext state'ine YAZILMAZ (yalnızca "canlı alarm
 * geldi" sayacı/toast'u AppContext'te — bkz. orada 'alarm:raised' dinleyici).
 */

function mapAlarm(a: any): Alarm {
  return {
    id: a.id,
    alarmKey: a.alarm_key,
    category: a.category,
    severity: a.severity,
    title: a.title,
    siteName: a.site_name,
    subjectType: a.subject_type,
    subjectId: a.subject_id,
    status: a.status,
    assigneeId: a.assignee_id,
    eventCount: a.event_count,
    firstSeenAt: a.first_seen_at,
    lastSeenAt: a.last_seen_at,
    snoozedUntil: a.snoozed_until,
    escalationLevel: a.escalation_level,
    escalatedAt: a.escalated_at,
    resolutionNote: a.resolution_note,
    resolvedBy: a.resolved_by,
    resolvedAt: a.resolved_at,
    sourceRef: a.source_ref,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
    events: a.events ? a.events.map((e: any) => ({ id: e.id, detail: e.detail, occurredAt: e.occurred_at })) : undefined
  };
}

export interface AlarmListFilters {
  status?: AlarmStatus;
  category?: string;
  severity?: string;
  siteName?: string;
  assigneeId?: string;
  includeSnoozed?: boolean;
  includeResolved?: boolean;
}

export async function fetchAlarms(filters: AlarmListFilters = {}): Promise<Alarm[]> {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => { if (v !== undefined && v !== '') params.set(k, String(v)); });
  const qs = params.toString();
  const response = await apiFetch(`/alarms${qs ? `?${qs}` : ''}`);
  return (response.data || []).map(mapAlarm);
}

export async function fetchAlarm(id: string): Promise<Alarm> {
  const response = await apiFetch(`/alarms/${id}`);
  return mapAlarm(response.data);
}

export interface UpdateAlarmInput {
  status?: AlarmStatus;
  assigneeId?: string | null;
  resolutionNote?: string;
}

export async function updateAlarm(id: string, input: UpdateAlarmInput): Promise<Alarm> {
  const response = await apiFetch(`/alarms/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
  return mapAlarm(response.data);
}

export async function snoozeAlarm(id: string, minutes: number): Promise<Alarm> {
  const response = await apiFetch(`/alarms/${id}/snooze`, { method: 'POST', body: JSON.stringify({ minutes }) });
  return mapAlarm(response.data);
}

export async function fetchFalsePositiveFeedback(): Promise<Array<{ category: string; total: number; falsePositives: number; rate: number }>> {
  const response = await apiFetch('/alarms/false-positive-feedback');
  return response.data;
}

export async function runAlarmEscalation(): Promise<{ escalatedCount: number }> {
  const response = await apiFetch('/alarms/run-escalation', { method: 'POST' });
  return response.data;
}

export async function fetchTenantUsers(): Promise<TenantUser[]> {
  const response = await apiFetch('/users');
  return (response.data || []).map((u: any) => ({ id: u.id, username: u.username, role: u.role, siteName: u.site_name }));
}

export const ALARM_STATUS_LABELS: Record<AlarmStatus, string> = {
  OPEN: 'Açık',
  ACKNOWLEDGED: 'Onaylandı',
  INVESTIGATING: 'İnceleniyor',
  RESOLVED: 'Çözüldü',
  FALSE_POSITIVE: 'Yanlış Pozitif'
};

export const ALARM_CATEGORY_LABELS: Record<string, string> = {
  THEFT: 'Hırsızlık Şüphesi',
  CONSUMPTION_ANOMALY: 'Tüketim Anomalisi',
  STOCK_RECONCILIATION: 'Stok Mutabakatı',
  OFFHOURS_DISPENSE: 'Mesai Dışı İkmal',
  RAPID_REPEAT: 'Hızlı Tekrarlı İkmal',
  NEGATIVE_STOCK: 'Negatif Stok',
  CALIBRATION_DRIFT: 'Kalibrasyon Sapması',
  MANUAL_ENTRY_RATIO: 'Manuel Giriş Oranı',
  UNAUTHORIZED_FLOW: 'Yetkisiz Akış',
  VEHICLE_LIMIT_EXCEEDED: 'Araç Yakıt Limiti Aşımı',
  LICENSE_EXPIRY: 'Lisans Süresi Doluyor',
  MAINTENANCE_DUE: 'Bakım Zamanı Geldi',
  COMPLIANCE_DEADLINE: 'Muayene/Belge Son Tarihi',
  TIRE_REPLACEMENT_DUE: 'Lastik Değişimi Gerekli',
  INVENTORY_LOW_STOCK: 'Envanter Kritik Stok',
  LAB_NONCONFORMING_RESULT: 'Uygunsuz Lab Sonucu',
  DRIVER_BEHAVIOR_SCORE_LOW: 'Şoför Performans Skoru Düşük',
  TANK_LOW_STOCK_FORECAST: 'Tank Stok Tahmini',
  DEVICE_HEALTH_SCORE_LOW: 'Cihaz Sağlık Skoru Düşük',
  SMS_MONTHLY_LIMIT_EXCEEDED: 'Aylık SMS Limiti Aşıldı',
  WEBHOOK_AUTO_DISABLED: 'Webhook Otomatik Devre Dışı',
  DEVICE_CLOCK_DRIFT: 'Cihaz Saat Sapması',
  DESPATCH_INTEGRATOR_CIRCUIT_OPEN: 'e-İrsaliye Entegratör Devresi Açık',
  DESPATCH_ADVICE_TRANSMISSION_STUCK: 'e-İrsaliye Takılı Kaldı',
  OTHER: 'Diğer'
};

export function categoryLabel(category: string): string {
  return ALARM_CATEGORY_LABELS[category] || category;
}
