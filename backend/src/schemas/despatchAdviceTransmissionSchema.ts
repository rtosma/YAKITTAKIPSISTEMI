import { z } from 'zod';

/**
 * COMP-602.1 — iletim kuyruğuna alma isteği. recipientTaxId opsiyoneldir
 * (COMP-605 ile aynı davranış: verilmezse öz filo teslimi kabul edilir).
 */
export const enqueueDespatchAdviceTransmissionSchema = z.object({
  recipientTaxId: z
    .string()
    .trim()
    .regex(/^\d{10}$|^\d{11}$/, 'recipientTaxId 10 haneli VKN veya 11 haneli TCKN olmalıdır.')
    .optional()
});
export type EnqueueDespatchAdviceTransmissionDTO = z.infer<typeof enqueueDespatchAdviceTransmissionSchema>;

export const despatchAdviceTransmissionListQuerySchema = z.object({
  status: z.enum(['QUEUED', 'SENDING', 'SENT', 'FAILED']).optional(),
  transactionId: z.string().optional()
});
export type DespatchAdviceTransmissionListQueryDTO = z.infer<typeof despatchAdviceTransmissionListQuerySchema>;
