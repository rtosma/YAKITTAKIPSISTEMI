import { z } from 'zod';
import { isValidTCKN } from '../compliance/taxIdValidation';

export const createDriverSchema = z.object({
  name: z.string().min(3, 'Ad soyad en az 3 karakter olmalıdır.').max(128, 'Ad soyad çok uzun.'),
  // FLEET-1403 AC: "TC kimlik no algoritmik olarak doğrulanmalıdır." Önceden
  // yalnızca BİÇİM (11 haneli rakam) kontrol ediliyordu — "12345678901" gibi
  // kontrol hanesi tutmayan bir değer de kabul ediliyordu. COMP-605'in
  // GERÇEK TCKN algoritmasını (compliance/taxIdValidation.ts) YENİDEN
  // YAZMAK yerine burada da kullanıyor.
  tcNo: z.string()
    .regex(/^\d{11}$/, 'TC Kimlik No 11 haneli rakam olmalıdır.')
    .refine((v) => isValidTCKN(v), { message: 'Geçersiz TC Kimlik No (kontrol haneleri tutmuyor).' }),
  phone: z.string().min(10, 'Geçerli bir telefon numarası giriniz.'),
  licenseType: z.string().optional(),
  rfidCardId: z.string().min(1, 'RFID Kart ID zorunludur.'),
  siteName: z.string().optional(),
  status: z.string().optional(),
  // Serbest metin araç plakası — bkz. tenantDb.ts syncDriverVehicleAssignment.
  // 'Yok'/'Atanmadı' gibi sentinel değerler backend'de atamayı temizler.
  assignedVehiclePlate: z.string().optional()
});

export const updateDriverSchema = createDriverSchema.partial();
