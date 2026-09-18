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
