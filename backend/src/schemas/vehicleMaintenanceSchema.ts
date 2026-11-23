import { z } from 'zod';
import { isoDateString } from './common/dateString';

/**
 * FLEET-1407 — bakım-servis kaydı girişi.
 */
export const createVehicleMaintenanceRecordSchema = z.object({
  maintenanceType: z.enum(['PERİYODİK_BAKIM', 'LASTİK', 'YAĞ_DEĞİŞİMİ', 'ARIZA_ONARIMI', 'DİĞER'], {
    message: 'maintenanceType PERİYODİK_BAKIM/LASTİK/YAĞ_DEĞİŞİMİ/ARIZA_ONARIMI/DİĞER olmalıdır.'
  }),
  performedAt: isoDateString('performedAt YYYY-AA-GG olmalıdır.'),
  odometerValue: z.coerce.number().nonnegative().optional(),
  costAmount: z.coerce.number({ message: 'costAmount zorunludur.' }).nonnegative(),
  operationsDescription: z.string().trim().min(3, 'operationsDescription en az 3 karakter olmalıdır.').max(2000),
  nextDueDate: isoDateString('nextDueDate YYYY-AA-GG olmalıdır.').optional(),
  nextDueMeterValue: z.coerce.number().positive().optional()
});
export type CreateVehicleMaintenanceRecordDTO = z.infer<typeof createVehicleMaintenanceRecordSchema>;

export const totalCostOfOwnershipQuerySchema = z.object({
  sinceDate: isoDateString('sinceDate YYYY-AA-GG olmalıdır.').optional()
});
export type TotalCostOfOwnershipQueryDTO = z.infer<typeof totalCostOfOwnershipQuerySchema>;
