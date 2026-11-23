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

/**
 * COMP-604 — toplu yeniden gönderim. AC: "yalnızca hatalı durumdakiler
 * seçilebilmelidir" — biçim denetimi burada (1-100 arası id); FAILED-dışı
 * bir id'nin reddi servis katmanında (tenantDb.ts) yapılır, çünkü durumu
 * bilmek için DB'ye bakmak gerekir.
 */
export const bulkResendDespatchAdviceTransmissionSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, 'En az bir id gereklidir.').max(100, 'Tek seferde en fazla 100 belge yeniden gönderilebilir.')
});
export type BulkResendDespatchAdviceTransmissionDTO = z.infer<typeof bulkResendDespatchAdviceTransmissionSchema>;
