import { z } from 'zod';
import { isoDateString } from './common/dateString';

/**
 * AI-504 — mesai dışı / kısa aralıklı mükerrer alım tespiti.
 *
 * Bilinçli sapma: ticket "NestJS + ARCH-102 event handler + NOTIF-1601"
 * öneriyor. Bu yığında event bus/bildirim modülü yok → tespit index.ts'te
 * saatlik düz setInterval + manuel POST /anomaly-flags/scan; "bildirim"
 * audit_logs (ANOMALY_SCAN) + WebSocket 'anomaly:flagged' ile üretilir.
 */
export const setWorkingHoursSchema = z
  .object({
    startMinute: z.coerce.number().int().min(0).max(1439),
    endMinute: z.coerce.number().int().min(1).max(1440),
    // ISO haftagünü: 1=Pazartesi ... 7=Pazar.
    workingDays: z.array(z.coerce.number().int().min(1).max(7)).min(1).max(7),
    is247: z.boolean().default(false),
    rapidRepeatWindowMinutes: z.coerce.number().int().min(1).max(1440).default(30)
  })
  .refine((v) => v.is247 || v.startMinute < v.endMinute, {
    message: 'startMinute < endMinute olmalıdır (gece yarısını aşan vardiya için is247 kullanın).',
    path: ['endMinute']
  });
export type SetWorkingHoursDTO = z.infer<typeof setWorkingHoursSchema>;

export const scanAnomalySchema = z.object({
  sinceHours: z.coerce.number().int().min(1).max(2160).default(168)
});
export type ScanAnomalyDTO = z.infer<typeof scanAnomalySchema>;

export const listAnomalyFlagQuerySchema = z.object({
  type: z.enum(['MESAI_DISI', 'KISA_ARALIK_MUKERRER']).optional(),
  status: z.enum(['ACIK', 'INCELENDI', 'MUAF']).optional(),
  siteName: z.string().min(1).max(128).optional(),
  from: isoDateString('from YYYY-AA-GG olmalıdır.').optional(),
  to: isoDateString('to YYYY-AA-GG olmalıdır.').optional()
});
export type ListAnomalyFlagQueryDTO = z.infer<typeof listAnomalyFlagQuerySchema>;

export const reviewAnomalyFlagSchema = z.object({
  status: z.enum(['INCELENDI', 'MUAF'], { message: 'status INCELENDI veya MUAF olmalıdır.' }),
  reviewNote: z.string().max(2000).optional()
});
export type ReviewAnomalyFlagDTO = z.infer<typeof reviewAnomalyFlagSchema>;
