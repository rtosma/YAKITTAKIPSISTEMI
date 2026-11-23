import { z } from 'zod';

/**
 * REP-705 (#167) — zamanlanmış rapor gönderimi.
 *
 * BİLİNÇLİ SAPMA: `format` şu an için yalnızca 'CSV' kabul eder. REP-701'in
 * Excel exportı Response-stream-only (Buffer döndüren bir varyantı yok),
 * REP-703'ün PDF exportı da yalnızca Response'a pipe ediyor (bkz.
 * reportEngine.ts/pdfExport.ts) — e-posta eki için ikisi de bir Buffer
 * üretici gerektirir ki bu bu ticket'ın (Efor: S) kapsamı dışında bırakıldı.
 * CSV zaten `buildReportCsvBuffer` ile Buffer döndürüyor, ek altyapı
 * gerektirmiyor.
 */
export const reportScheduleFormatSchema = z.literal('CSV', { message: "format şu an için yalnızca 'CSV' olabilir (Excel/PDF ekleri henüz desteklenmiyor)." });

export const createReportScheduleSchema = z.object({
  reportId: z.string().min(1).max(64),
  filters: z.record(z.string(), z.string().max(200)).optional().default({}),
  format: reportScheduleFormatSchema.optional().default('CSV'),
  periodType: z.enum(['DAILY', 'WEEKLY', 'MONTHLY'], { message: "periodType 'DAILY', 'WEEKLY' veya 'MONTHLY' olmalıdır." }),
  sendHourLocal: z.coerce.number().int().min(0).max(23).optional().default(7),
  dayOfWeek: z.coerce.number().int().min(0).max(6).optional(),
  dayOfMonth: z.coerce.number().int().min(1).max(28, 'dayOfMonth en fazla 28 olabilir (ay uzunluğu belirsizliğini önlemek için).').optional(),
  recipientUserIds: z.array(z.string().min(1).max(64)).min(1, 'En az bir alıcı gereklidir.').max(50),
  skipIfEmpty: z.boolean().optional().default(false)
});
export type CreateReportScheduleDTO = z.infer<typeof createReportScheduleSchema>;

export const updateReportScheduleSchema = z.object({
  filters: z.record(z.string(), z.string().max(200)).optional(),
  sendHourLocal: z.coerce.number().int().min(0).max(23).optional(),
  dayOfWeek: z.coerce.number().int().min(0).max(6).optional(),
  dayOfMonth: z.coerce.number().int().min(1).max(28).optional(),
  recipientUserIds: z.array(z.string().min(1).max(64)).min(1).max(50).optional(),
  skipIfEmpty: z.boolean().optional(),
  enabled: z.boolean().optional()
}).refine((data) => Object.keys(data).length > 0, { message: 'Güncellenecek en az bir alan gereklidir.' });
export type UpdateReportScheduleDTO = z.infer<typeof updateReportScheduleSchema>;

export const reportScheduleIdParamsSchema = z.object({
  scheduleId: z.string().min(1).max(64)
});

export const reportDeliveryDownloadParamsSchema = z.object({
  deliveryId: z.string().min(1).max(64),
  token: z.string().min(32).max(128)
});
