import { z } from 'zod';

/**
 * COMP-603 — e-İrsaliye red/iptal gerekçe şemaları. AC: "Red sebepleri
 * kaydedilip kullanıcıya anlaşılır biçimde gösterilmelidir" — bu yüzden
 * gerekçe zorunlu ve anlamlı bir minimum uzunlukta olmalı.
 */
export const rejectDespatchAdviceSchema = z.object({
  reason: z.string().trim().min(5, 'reason en az 5 karakter olmalıdır.').max(1000)
});
export type RejectDespatchAdviceDTO = z.infer<typeof rejectDespatchAdviceSchema>;

export const cancelDespatchAdviceSchema = z.object({
  reason: z.string().trim().min(5, 'reason en az 5 karakter olmalıdır.').max(1000)
});
export type CancelDespatchAdviceDTO = z.infer<typeof cancelDespatchAdviceSchema>;
