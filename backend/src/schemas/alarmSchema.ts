import { z } from 'zod';

/**
 * AI-507 — birleşik alarm yaşam döngüsü istek şemaları.
 *
 * Bilinçli sapma: ticket "NestJS + Drizzle + NOTIF-1601/1606" öneriyor;
 * bildirim modülü yok → eskalasyon index.ts saatlik süpürücüsü + WebSocket
 * 'alarm:escalated' + audit_logs ile bildirilir.
 */
const ALARM_STATUS = ['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED', 'FALSE_POSITIVE'] as const;

export const updateAlarmSchema = z
  .object({
    status: z.enum(ALARM_STATUS).optional(),
    assigneeId: z.string().min(1).max(64).nullable().optional(),
    resolutionNote: z.string().max(2000).optional()
  })
  .refine((v) => v.status !== undefined || v.assigneeId !== undefined || v.resolutionNote !== undefined, {
    message: 'status, assigneeId veya resolutionNote alanlarından en az biri verilmelidir.'
  });
export type UpdateAlarmDTO = z.infer<typeof updateAlarmSchema>;

export const snoozeAlarmSchema = z.object({
  // 1 dk – 30 gün.
  minutes: z.coerce.number().int().min(1).max(43_200)
});
export type SnoozeAlarmDTO = z.infer<typeof snoozeAlarmSchema>;

export const listAlarmQuerySchema = z.object({
  status: z.enum(ALARM_STATUS).optional(),
  category: z.string().min(1).max(40).optional(),
  severity: z.enum(['INFO', 'WARNING', 'CRITICAL']).optional(),
  siteName: z.string().min(1).max(128).optional(),
  assigneeId: z.string().min(1).max(64).optional(),
  includeSnoozed: z.string().optional().transform((v) => v === 'true' || v === '1'),
  includeResolved: z.string().optional().transform((v) => v === 'true' || v === '1')
});
export type ListAlarmQueryDTO = z.infer<typeof listAlarmQuerySchema>;
