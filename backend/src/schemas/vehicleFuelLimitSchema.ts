import { z } from 'zod';
import { isoDateString } from './common/dateString';

/**
 * FLEET-1406 — araç bazlı dönemsel yakıt limiti istek şemaları.
 * period_type FUEL-402.1'in QuotaPeriodType'ına uyar (ONE_TIME hariç —
 * bir araç limiti tanım gereği yinelenen bir dönem ister).
 */
export const setVehicleFuelLimitSchema = z.object({
  periodType: z.enum(['DAILY', 'WEEKLY', 'MONTHLY'], { message: 'periodType DAILY/WEEKLY/MONTHLY olmalıdır.' }),
  limitLiters: z.coerce.number({ message: 'limitLiters zorunludur.' }).positive().max(1_000_000),
  // 'REJECT' — limit dolunca ikmal reddedilir/kısılır. 'WARN' — yalnızca uyarı (alarm) üretilir.
  enforcement: z.enum(['REJECT', 'WARN']).default('REJECT'),
  status: z.enum(['AKTİF', 'PASİF']).optional()
});
export type SetVehicleFuelLimitDTO = z.infer<typeof setVehicleFuelLimitSchema>;

export const temporaryFuelLimitIncreaseSchema = z.object({
  additionalLiters: z.coerce.number({ message: 'additionalLiters zorunludur.' }).positive().max(1_000_000),
  untilDate: isoDateString('untilDate YYYY-AA-GG olmalıdır.'),
  reason: z.string().min(5, 'reason en az 5 karakter olmalıdır.').max(1000)
});
export type TemporaryFuelLimitIncreaseDTO = z.infer<typeof temporaryFuelLimitIncreaseSchema>;
