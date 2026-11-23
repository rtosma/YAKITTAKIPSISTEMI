import { z } from 'zod';

/** ARCH-107 — sınıf adı yalnızca yol parametresidir; katalogda ARANIR, SQL'e girmez (retentionService.ts). */
export const retentionClassParamsSchema = z.object({
  dataClass: z.string().min(1).max(64)
});

/** `null` → tenant özelleştirmesini kaldır (varsayılana dön). Alt/üst sınır sınıfa özeldir, serviste doğrulanır. */
export const retentionPolicyUpdateSchema = z.object({
  retentionDays: z.number({ message: 'retentionDays sayı olmalıdır.' }).int('retentionDays tam sayı olmalıdır.').positive().nullable()
});

export const retentionRunSchema = z.object({
  dryRun: z.boolean().optional(),
  tenantId: z.string().min(1).max(64).optional(),
  batchSize: z.number().int().min(1).max(10000).optional()
});
