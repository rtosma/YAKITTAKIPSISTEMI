import { z } from 'zod';
import { TURKISH_PLATE_REGEX } from './vehicleSchema';

export const dispenseRequestSchema = z.object({
  vehiclePlate: z.string({ message: 'Araç plakası zorunludur.' })
    .regex(TURKISH_PLATE_REGEX, { message: 'Geçersiz Türkiye plaka formatı.' }),
  rfidTag: z.string({ message: 'RFID etiketi zorunludur.' })
    .min(3, 'RFID etiketi en az 3 karakter olmalıdır.'),
  amountLiters: z.coerce.number({ message: 'Yakıt miktarı zorunludur.' })
    .gt(0, 'Yakıt miktarı 0\'dan büyük pozitif bir sayı olmalıdır.'),
  pumpCode: z.string().optional()
});

export type DispenseRequestDTO = z.infer<typeof dispenseRequestSchema>;
