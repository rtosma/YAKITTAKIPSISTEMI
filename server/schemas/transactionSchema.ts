import { z } from 'zod';
import { TURKISH_PLATE_REGEX } from './vehicleSchema';

export const dispenseRequestSchema = z.object({
  vehiclePlate: z.string({
    required_error: 'Araç plakası zorunludur.'
  }).regex(TURKISH_PLATE_REGEX, {
    message: 'Geçersiz Türkiye plaka formatı.'
  }),
  rfidTag: z.string({
    required_error: 'RFID etiketi zorunludur.'
  }).min(3, 'RFID etiketi en az 3 karakter olmalıdır.'),
  amountLiters: z.coerce.number({
    required_error: 'Yakıt miktarı zorunludur.',
    invalid_type_error: 'Yakıt miktarı geçerli bir sayı olmalıdır.'
  }).gt(0, 'Yakıt miktarı 0\'dan büyük pozitif bir sayı olmalıdır.'),
  pumpCode: z.string().optional()
});

export type DispenseRequestDTO = z.infer<typeof dispenseRequestSchema>;
