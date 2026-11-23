import { z } from 'zod';

/** REP-719 — şantiye × ay yakıt bütçesi (TL). */
export const setFuelBudgetSchema = z.object({
  siteName: z.string().min(1).max(128),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month 'YYYY-AA' biçiminde olmalıdır."),
  amountTry: z.coerce.number({ message: 'Bütçe tutarı zorunludur.' }).positive('Bütçe tutarı 0\'dan büyük olmalıdır.').max(1_000_000_000_000)
});
export type SetFuelBudgetDTO = z.infer<typeof setFuelBudgetSchema>;

export const listFuelBudgetsQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  siteName: z.string().min(1).max(128).optional()
});

export const fuelBudgetIdParamsSchema = z.object({ budgetId: z.string().min(1).max(64) });
