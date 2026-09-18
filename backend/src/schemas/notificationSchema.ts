import { z } from 'zod';

/** NOTIF-1601 — bildirim geçmişi listeleme. */
export const listNotificationQuerySchema = z.object({
  unreadOnly: z.coerce.boolean().optional()
});
export type ListNotificationQueryDTO = z.infer<typeof listNotificationQuerySchema>;
