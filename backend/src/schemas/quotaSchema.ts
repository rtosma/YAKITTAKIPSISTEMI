import { z } from 'zod';

/**
 * FUEL-402.1 — yakıt kotası tanımı. Kapsam alanları (vehiclePlate/siteName)
 * opsiyoneldir; ikisi de verilmezse kota tenant genelidir.
 */
export const createQuotaSchema = z.object({
  vehiclePlate: z.string().min(1).max(32).optional(),
  siteName: z.string().min(1).max(128).optional(),
  periodType: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'ONE_TIME'], { message: 'periodType DAILY/WEEKLY/MONTHLY/ONE_TIME olmalıdır.' }),
  limitLiters: z.coerce.number({ message: 'limitLiters zorunludur.' }).positive().max(10_000_000),
  carryoverPolicy: z.enum(['NONE', 'FULL', 'CAPPED']).default('NONE'),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'validFrom YYYY-AA-GG olmalıdır.').optional(),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'validUntil YYYY-AA-GG olmalıdır.').optional()
});
export type CreateQuotaDTO = z.infer<typeof createQuotaSchema>;

export const updateQuotaSchema = z.object({
  limitLiters: z.coerce.number().positive().max(10_000_000).optional(),
  carryoverPolicy: z.enum(['NONE', 'FULL', 'CAPPED']).optional(),
  status: z.enum(['AKTİF', 'PASİF']).optional()
}).refine((v) => Object.keys(v).length > 0, { message: 'Güncellenecek en az bir alan verilmelidir.' });
export type UpdateQuotaDTO = z.infer<typeof updateQuotaSchema>;
