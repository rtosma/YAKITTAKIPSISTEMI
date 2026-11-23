import { z } from 'zod';

/** NOTIF-1601 — bildirim geçmişi listeleme. */
export const listNotificationQuerySchema = z.object({
  unreadOnly: z.coerce.boolean().optional()
});
export type ListNotificationQueryDTO = z.infer<typeof listNotificationQuerySchema>;

/** NOTIF-1604 — Telegram/webhook kanal yapılandırması. Tüm alanlar opsiyonel (kısmi güncelleme). */
export const updateNotificationChannelsSchema = z.object({
  telegramBotToken: z.string().min(1).max(200).optional(),
  telegramChatId: z.string().min(1).max(64).optional(),
  webhookUrl: z.string().url('webhookUrl geçerli bir URL olmalıdır.').max(512).optional(),
  webhookSecret: z.string().min(16, 'webhookSecret en az 16 karakter olmalıdır.').max(200).optional()
});
export type UpdateNotificationChannelsDTO = z.infer<typeof updateNotificationChannelsSchema>;

export const sendTestNotificationSchema = z.object({
  channel: z.enum(['EMAIL', 'SMS', 'TELEGRAM', 'WEBHOOK']),
  userId: z.string().min(1).max(64).optional()
});
export type SendTestNotificationDTO = z.infer<typeof sendTestNotificationSchema>;

/** NOTIF-1605 — kullanıcının kendi tercihi (event tipi × kanal). Self-servis: userId route/body'den GELMEZ, req.user'dan okunur. */
export const setUserNotificationPreferenceSchema = z.object({
  eventType: z.string().min(1).max(64),
  channel: z.enum(['IN_APP', 'EMAIL', 'SMS', 'TELEGRAM', 'WEBHOOK']),
  enabled: z.boolean()
});
export type SetUserNotificationPreferenceDTO = z.infer<typeof setUserNotificationPreferenceSchema>;

/** NOTIF-1605 — zaman sınırlı sessize alma. `eventType` boşsa TÜM bildirim tipleri için geçerlidir. */
export const createUserNotificationMuteSchema = z.object({
  eventType: z.string().min(1).max(64).optional(),
  durationMinutes: z.number().int().min(1, 'durationMinutes en az 1 olmalıdır.').max(10080, 'durationMinutes en fazla 10080 (7 gün) olmalıdır.')
});
export type CreateUserNotificationMuteDTO = z.infer<typeof createUserNotificationMuteSchema>;
