import { z } from 'zod';

export const createDriverSchema = z.object({
  name: z.string().min(3, 'Ad soyad en az 3 karakter olmalıdır.').max(128, 'Ad soyad çok uzun.'),
  tcNo: z.string().regex(/^\d{11}$/, 'TC Kimlik No 11 haneli rakam olmalıdır.'),
  phone: z.string().min(10, 'Geçerli bir telefon numarası giriniz.'),
  licenseType: z.string().optional(),
  rfidCardId: z.string().min(1, 'RFID Kart ID zorunludur.'),
  siteName: z.string().optional(),
  status: z.string().optional()
});

export const updateDriverSchema = createDriverSchema.partial();
