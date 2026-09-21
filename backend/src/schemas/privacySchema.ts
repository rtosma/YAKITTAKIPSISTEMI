import { z } from 'zod';

export const createDsrSchema = z.object({
  requestType: z.enum(['ACCESS', 'ERASURE'], { message: "requestType 'ACCESS' veya 'ERASURE' olmalıdır." }),
  subjectType: z.enum(['DRIVER', 'PERSONNEL'], { message: "subjectType 'DRIVER' veya 'PERSONNEL' olmalıdır." }),
  subjectId: z.string().min(1).max(64),
  note: z.string().max(2000).optional()
});
export const dsrIdParamsSchema = z.object({ id: z.string().min(1).max(64) });
export const dsrRejectSchema = z.object({ reason: z.string().min(5, 'Ret gerekçesi en az 5 karakter olmalıdır.').max(2000) });
export const anonymizeExpiredSchema = z.object({
  dryRun: z.boolean().optional(),
  tenantId: z.string().min(1).max(64).optional()
});
