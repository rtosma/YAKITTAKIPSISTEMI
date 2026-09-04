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
