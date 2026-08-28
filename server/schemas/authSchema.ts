import { z } from 'zod';

export const loginSchema = z.object({
  username: z.string({
    required_error: 'Kullanıcı adı zorunludur.'
  }).min(3, 'Kullanıcı adı en az 3 karakter olmalıdır.'),
  password: z.string({
    required_error: 'Parola zorunludur.'
  }).min(6, 'Parola en az 6 karakter olmalıdır.')
});

export type LoginDTO = z.infer<typeof loginSchema>;
