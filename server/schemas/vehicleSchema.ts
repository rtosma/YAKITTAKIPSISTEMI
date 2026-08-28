import { z } from 'zod';

// Turkish License Plate Regex Validator (e.g., 34 CTP 82, 41 KCL 05, 06 A 1234)
export const TURKISH_PLATE_REGEX = /^(0[1-9]|[1-7][0-9]|8[0-1])\s?[A-Z]{1,3}\s?[0-9]{2,4}$/i;

export const createVehicleSchema = z.object({
  plate: z.string({
    required_error: 'Araç plakası zorunludur.'
  }).regex(TURKISH_PLATE_REGEX, {
    message: 'Geçersiz Türkiye plaka formatı. (Örn: 34 CTP 82)'
  }),
  brandModel: z.string({
    required_error: 'Marka / Model bilgisi zorunludur.'
  }).min(2, 'Marka/Model en az 2 karakter olmalıdır.'),
  type: z.string().default('Kamyon'),
  rfidTag: z.string({
    required_error: 'RFID Etiketi (tag) zorunludur.'
  }).min(3, 'RFID tag en az 3 karakter olmalıdır.'),
  fuelCapacityLiters: z.number({
    required_error: 'Yakıt kapasitesi zorunludur.',
    invalid_type_error: 'Yakıt kapasitesi sayı olmalıdır.'
  }).positive('Yakıt kapasitesi 0\'dan büyük bir sayı olmalıdır.')
});

export type CreateVehicleDTO = z.infer<typeof createVehicleSchema>;
