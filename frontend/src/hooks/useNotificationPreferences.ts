import { apiFetch } from '../utils/api';
import { NotificationChannel, UserNotificationPreference, UserNotificationMute } from '../types';

/**
 * FE-815 Kapsam: "Bildirim tercihleri ekranı: kanal × olay tipi matrisi."
 * NOTIF-1605 zaten tamdı — self-servis (userId oturumdan okunur, body'de
 * GÖNDERİLMEZ). `eventType` backend'de SERBEST METİN (kapalı enum değil) —
 * gerçek değerler notifications/templateRegistry.ts'teki kayıtlı
 * şablonlardır (yeni bir tip İCAT EDİLMEDİ, var olan 5 tanesi kullanıldı).
 */

export const NOTIFICATION_EVENT_TYPES = [
  'LICENSE_EXPIRY_WARNING',
  'TANK_LOW_STOCK_FORECAST',
  'FIRE_RECORD_HIGH_VALUE',
  'THEFT_DETECTED',
  'ALARM_ESCALATED'
] as const;

export const NOTIFICATION_EVENT_TYPE_LABELS: Record<string, string> = {
  LICENSE_EXPIRY_WARNING: 'Lisans Süresi Doluyor',
  TANK_LOW_STOCK_FORECAST: 'Tank Stok Uyarısı',
  FIRE_RECORD_HIGH_VALUE: 'Yüksek Değerli Fire Kaydı',
  THEFT_DETECTED: 'Hırsızlık Şüphesi',
  ALARM_ESCALATED: 'Alarm Eskalasyonu'
};

export const NOTIFICATION_CHANNELS: NotificationChannel[] = ['IN_APP', 'EMAIL', 'SMS', 'TELEGRAM', 'WEBHOOK'];
export const NOTIFICATION_CHANNEL_LABELS: Record<NotificationChannel, string> = {
  IN_APP: 'Uygulama İçi',
  EMAIL: 'E-posta',
  SMS: 'SMS',
  TELEGRAM: 'Telegram',
  WEBHOOK: 'Webhook'
};

function mapPreference(p: any): UserNotificationPreference {
  return { id: p.id, eventType: p.event_type, channel: p.channel, enabled: p.enabled, updatedAt: p.updated_at };
}
function mapMute(m: any): UserNotificationMute {
  return { id: m.id, eventType: m.event_type, mutedUntil: m.muted_until, createdAt: m.created_at };
}

export async function fetchNotificationPreferences(): Promise<UserNotificationPreference[]> {
  const response = await apiFetch('/notifications/preferences');
  return (response.data || []).map(mapPreference);
}

export async function setNotificationPreference(eventType: string, channel: NotificationChannel, enabled: boolean): Promise<UserNotificationPreference> {
  const response = await apiFetch('/notifications/preferences', { method: 'PUT', body: JSON.stringify({ eventType, channel, enabled }) });
  return mapPreference(response.data);
}

export async function fetchActiveMutes(): Promise<UserNotificationMute[]> {
  const response = await apiFetch('/notifications/mute');
  return (response.data || []).map(mapMute);
}

export async function createMute(eventType: string | null, durationMinutes: number): Promise<UserNotificationMute> {
  const response = await apiFetch('/notifications/mute', { method: 'POST', body: JSON.stringify({ eventType: eventType ?? undefined, durationMinutes }) });
  return mapMute(response.data);
}
