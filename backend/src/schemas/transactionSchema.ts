import { z } from 'zod';
import { TURKISH_PLATE_REGEX } from './vehicleSchema';

/**
 * POST /api/v1/dispense — bir ikmal (fuel dispense) kaydı oluşturur.
 * Önceden bu endpoint bir stub'dı (hiçbir şeyi DB'ye yazmadan
 * success:true dönüyordu); artık gerçek bir transactions satırı yazıp
 * ilgili tankın seviyesini düşürüyor (bkz. tenantDb.ts createTransaction).
 */
export const dispenseRequestSchema = z.object({
  siteName: z.string({ message: 'Şantiye adı zorunludur.' }).min(1, 'Şantiye adı zorunludur.'),
  vehiclePlate: z.string({ message: 'Araç plakası zorunludur.' })
    .regex(TURKISH_PLATE_REGEX, { message: 'Geçersiz Türkiye plaka formatı.' }),
  driverName: z.string().optional(),
  tankName: z.string().optional(),
  amountLiters: z.coerce.number({ message: 'Yakıt miktarı zorunludur.' })
    .gt(0, 'Yakıt miktarı 0\'dan büyük pozitif bir sayı olmalıdır.'),
  flowRateLpm: z.coerce.number().positive().optional(),
  pumpStatus: z.enum(['TAMAMLANTI', 'DURDURULDU', 'ANOMALİ']).optional(),
  type: z.enum(['Otomatik', 'Manuel', 'Çapraz Şantiye']).optional(),
  rfidAuth: z.boolean().optional()
});

export type DispenseRequestDTO = z.infer<typeof dispenseRequestSchema>;
