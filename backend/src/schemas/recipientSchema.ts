import { z } from 'zod';

/**
 * COMP-605 — mükellef (VKN/TCKN) doğrulama + alıcı bilgisi kayıt şemaları.
 * Algoritmik doğrulama serviste (compliance/taxIdValidation.ts); burada
 * yalnızca kaba biçim.
 */
export const validateTaxIdSchema = z.object({
  taxId: z.string().min(10, 'VKN 10, TCKN 11 haneli olmalıdır.').max(20)
});
export type ValidateTaxIdDTO = z.infer<typeof validateTaxIdSchema>;

export const createRecipientSchema = z.object({
  taxId: z.string().min(10).max(20),
  title: z.string().min(1).max(300).optional(),
  address: z.string().min(1).max(500).optional(),
  taxOffice: z.string().min(1).max(160).optional(),
  status: z.enum(['AKTİF', 'PASİF']).optional()
});
export type CreateRecipientDTO = z.infer<typeof createRecipientSchema>;
