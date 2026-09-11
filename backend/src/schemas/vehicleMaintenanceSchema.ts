import { z } from 'zod';

/**
 * FLEET-1407 — bakım-servis kaydı girişi.
 */
export const createVehicleMaintenanceRecordSchema = z.object({
  maintenanceType: z.enum(['PERİYODİK_BAKIM', 'LASTİK', 'YAĞ_DEĞİŞİMİ', 'ARIZA_ONARIMI', 'DİĞER'], {
    message: 'maintenanceType PERİYODİK_BAKIM/LASTİK/YAĞ_DEĞİŞİMİ/ARIZA_ONARIMI/DİĞER olmalıdır.'
  }),
  performedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'performedAt YYYY-AA-GG olmalıdır.'),
  odometerValue: z.coerce.number().nonnegative().optional(),
  costAmount: z.coerce.number({ message: 'costAmount zorunludur.' }).nonnegative(),
  operationsDescription: z.string().trim().min(3, 'operationsDescription en az 3 karakter olmalıdır.').max(2000),
  nextDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'nextDueDate YYYY-AA-GG olmalıdır.').optional(),
  nextDueMeterValue: z.coerce.number().positive().optional()
});
export type CreateVehicleMaintenanceRecordDTO = z.infer<typeof createVehicleMaintenanceRecordSchema>;

export const totalCostOfOwnershipQuerySchema = z.object({
  sinceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'sinceDate YYYY-AA-GG olmalıdır.').optional()
});
export type TotalCostOfOwnershipQueryDTO = z.infer<typeof totalCostOfOwnershipQuerySchema>;
