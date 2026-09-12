import { z } from 'zod';
import { isoDateString } from './common/dateString';

/**
 * FUEL-409 — teorik vs fiziksel stok mutabakatı.
 *
 * Bilinçli sapma: ticket "BullMQ repeatable job + NOTIF-1601" öneriyor. Bu
 * yığında BullMQ/bildirim modülü yok → günlük otomatik tetikleme index.ts'te
 * düz setInterval; alarm audit_logs + WebSocket ile bildirilir. `physicalLiters`
 * çağıran tarafından verilir (gerçek kurulumda sensör anlık görüntüsü).
 */
export const createReconciliationSchema = z
  .object({
    periodType: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'AD_HOC'], {
      message: 'periodType DAILY/WEEKLY/MONTHLY/AD_HOC olmalıdır.'
    }),
    physicalLiters: z.coerce.number({ message: 'physicalLiters zorunludur.' }).nonnegative().max(10_000_000),
    physicalTempC: z.coerce.number().min(-40).max(80).optional(),
    // ISO 8601 (tarih veya tam zaman damgası). AD_HOC için ikisi de zorunlu.
    periodStart: z.string().datetime({ offset: true }).optional(),
    periodEnd: z.string().datetime({ offset: true }).optional(),
    openingBookLiters: z.coerce.number().nonnegative().max(10_000_000).optional(),
    tolerancePct: z.coerce.number().positive().max(50).optional(),
    note: z.string().max(2000).optional()
  })
  .refine((v) => v.periodType !== 'AD_HOC' || (v.periodStart !== undefined && v.periodEnd !== undefined), {
    message: 'AD_HOC mutabakat için periodStart ve periodEnd zorunludur.',
    path: ['periodStart']
  })
  .refine((v) => (v.periodStart === undefined) === (v.periodEnd === undefined), {
    message: 'periodStart ve periodEnd birlikte verilmelidir.',
    path: ['periodEnd']
  });

export type CreateReconciliationDTO = z.infer<typeof createReconciliationSchema>;

export const listReconciliationQuerySchema = z.object({
  tankId: z.string().min(1).max(64).optional(),
  status: z.enum(['NORMAL', 'MUTABAKAT_ALARMI']).optional(),
  from: isoDateString('from YYYY-AA-GG olmalıdır.').optional(),
  to: isoDateString('to YYYY-AA-GG olmalıdır.').optional()
});
export type ListReconciliationQueryDTO = z.infer<typeof listReconciliationQuerySchema>;
