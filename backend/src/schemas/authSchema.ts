import { z } from 'zod';

export const loginSchema = z.object({
  username: z.string({ message: 'Kullanıcı adı zorunludur.' })
    .min(3, 'Kullanıcı adı en az 3 karakter olmalıdır.'),
  password: z.string({ message: 'Parola zorunludur.' })
    .min(6, 'Parola en az 6 karakter olmalıdır.')
});

export type LoginDTO = z.infer<typeof loginSchema>;

// AUTH-204: hem "ilk girişte zorunlu değiştirme" hem "kullanıcı kendi
// isteğiyle değiştirme" aynı uçtan (POST /auth/change-password) geçer.
export const changePasswordSchema = z.object({
  currentPassword: z.string({ message: 'Mevcut parola zorunludur.' })
    .min(1, 'Mevcut parola zorunludur.'),
  newPassword: z.string({ message: 'Yeni parola zorunludur.' })
    .min(8, 'Yeni parola en az 8 karakter olmalıdır.')
}).refine((data) => data.currentPassword !== data.newPassword, {
  message: 'Yeni parola mevcut parolayla aynı olamaz.',
  path: ['newPassword']
});

export type ChangePasswordDTO = z.infer<typeof changePasswordSchema>;

// AUTH-206 — şifremi unuttum / şifre sıfırlama.
export const forgotPasswordSchema = z.object({
  username: z.string({ message: 'Kullanıcı adı zorunludur.' }).min(3).max(64)
});
export type ForgotPasswordDTO = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  // requestPasswordReset randomBytes(32).toString('hex') → tam 64 hex karakter.
  token: z.string({ message: 'Sıfırlama token\'ı zorunludur.' })
    .regex(/^[0-9a-fA-F]{64}$/, 'Geçersiz sıfırlama token\'ı biçimi.'),
  newPassword: z.string({ message: 'Yeni parola zorunludur.' })
    .min(8, 'Yeni parola en az 8 karakter olmalıdır.')
    .max(128, 'Yeni parola en fazla 128 karakter olabilir.')
});
export type ResetPasswordDTO = z.infer<typeof resetPasswordSchema>;
