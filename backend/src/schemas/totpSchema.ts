import { z } from 'zod';

/**
 * AUTH-207 — TOTP 2FA istek şemaları. `partialToken` (login'in 2. adım için
 * döndürdüğü kısmi token) gövdede taşınabilir; bilinmeyen alanlar zaten
 * strip edildiği için şemaya açıkça eklenir.
 */
const sixDigit = z.string().regex(/^\d{6}$/, '6 haneli doğrulama kodu gereklidir.');

export const totpSetupSchema = z.object({
  partialToken: z.string().min(10).optional()
});

export const totpEnableSchema = z.object({
  code: sixDigit,
  partialToken: z.string().min(10).optional()
});

export const totpVerifySchema = z
  .object({
    partialToken: z.string().min(10, 'partialToken zorunludur.'),
    code: sixDigit.optional(),
    recoveryCode: z.string().min(6).max(32).optional()
  })
  .refine((v) => !!v.code !== !!v.recoveryCode, {
    message: 'code veya recoveryCode alanlarından tam olarak biri verilmelidir.',
    path: ['code']
  });

export const totpDisableSchema = z.object({
  code: sixDigit
});

export type TotpVerifyDTO = z.infer<typeof totpVerifySchema>;
