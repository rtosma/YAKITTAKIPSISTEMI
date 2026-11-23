import { z } from 'zod';

/**
 * FLEET-1404 + RES-903 — araç sayaç (km / motor-saat) giriş şemaları.
 * RES-903 mantık doğrulaması (geri giden / absürt / mükerrer) serviste
 * (fleet/meterValidation.ts); burada yalnızca kaba biçim.
 */
const meterTypeEnum = z.enum(['KM', 'MOTOR_SAAT']);

export const recordMeterReadingSchema = z.object({
  meterType: meterTypeEnum.optional(),
  value: z.coerce.number({ message: 'value zorunludur.' }).nonnegative().max(100_000_000),
  readingAt: z.string().datetime({ offset: true }).optional(),
  // 'YYYY-MM' veya 'AD_HOC'.
  periodLabel: z.string().regex(/^(\d{4}-\d{2}|AD_HOC)$/, 'periodLabel YYYY-AA veya AD_HOC olmalıdır.').optional(),
  note: z.string().max(1000).optional(),
  overrideReason: z.string().min(3).max(1000).optional(),
  correctsReadingId: z.string().min(1).max(64).optional()
});
export type RecordMeterReadingDTO = z.infer<typeof recordMeterReadingSchema>;

export const bulkMeterReadingSchema = z.object({
  items: z.array(z.object({
    vehiclePlate: z.string().min(1).max(32),
    value: z.coerce.number().nonnegative().max(100_000_000),
    meterType: meterTypeEnum.optional(),
    readingAt: z.string().datetime({ offset: true }).optional(),
    periodLabel: z.string().regex(/^(\d{4}-\d{2}|AD_HOC)$/).optional(),
    note: z.string().max(1000).optional(),
    overrideReason: z.string().min(3).max(1000).optional()
  })).min(1, 'En az bir kayıt gerekli.').max(50, 'Tek işlemde en fazla 50 araç.')
});
export type BulkMeterReadingDTO = z.infer<typeof bulkMeterReadingSchema>;

export const missingMeterQuerySchema = z.object({
  periodLabel: z.string().regex(/^(\d{4}-\d{2}|AD_HOC)$/, 'periodLabel YYYY-AA veya AD_HOC olmalıdır.'),
  meterType: meterTypeEnum.optional()
});
export type MissingMeterQueryDTO = z.infer<typeof missingMeterQuerySchema>;

export const remindMeterSchema = z.object({
  periodLabel: z.string().regex(/^(\d{4}-\d{2}|AD_HOC)$/),
  meterType: meterTypeEnum.optional()
});
export type RemindMeterDTO = z.infer<typeof remindMeterSchema>;
