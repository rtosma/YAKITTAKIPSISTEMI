import { z } from 'zod';

// Turkish License Plate Regex Validator (e.g., 34 CTP 82, 41 KCL 05, 06 A 1234)
export const TURKISH_PLATE_REGEX = /^(0[1-9]|[1-7][0-9]|8[0-1])\s?[A-Z]{1,3}\s?[0-9]{2,4}$/i;

export const createVehicleSchema = z.object({
  plate: z.string({ message: 'Araç plakası zorunludur.' })
    .regex(TURKISH_PLATE_REGEX, { message: 'Geçersiz Türkiye plaka formatı. (Örn: 34 CTP 82)' }),
  brandModel: z.string({ message: 'Marka / Model bilgisi zorunludur.' })
    .min(2, 'Marka/Model en az 2 karakter olmalıdır.'),
  // BİLEREK .default('Kamyon') DEĞİL: updateVehicleSchema bu şemadan
  // .partial() ile türetiliyor ve Zod'da bir alanın .default()'u, .partial()
  // SONRASINDA bile geçerli kalıyor — 'type' güncelleme isteğinde hiç
  // gönderilmese bile Zod onu SESSİZCE 'Kamyon' ile dolduruyordu, bu da
  // örn. yalnızca plaka güncellenen bir Ekskavatör'ün TİPİNİ sessizce
  // Kamyon'a çeviren gerçek bir veri bozulması hatasıydı (canlı ortamda
  // doğrulanıp düzeltildi). Varsayılan artık POST /vehicles route'unda
  // (status alanıyla AYNI `|| 'Kamyon'` deseniyle) uygulanıyor.
  type: z.string().optional(),
  rfidTag: z.string({ message: 'RFID Etiketi (tag) zorunludur.' })
    .min(3, 'RFID tag en az 3 karakter olmalıdır.'),
  fuelCapacityLiters: z.number({ message: 'Yakıt kapasitesi zorunludur.' })
    .positive('Yakıt kapasitesi 0\'dan büyük bir sayı olmalıdır.'),
  siteName: z.string().optional(),
  // Serbest metin şoför adı — bkz. tenantDb.ts vehicles.assigned_driver_name.
  // 'Atanmadı' gibi sentinel değerler backend'de NULL'a normalize edilir.
  assignedDriver: z.string().optional(),
  // GERÇEK BİR HATA: bu alan önceden şemada hiç tanımlı değildi — Zod
  // (varsayılan olarak bilinmeyen alanları SESSİZCE siler) her PUT
  // /vehicles/:id isteğindeki status'u atıyordu. Frontend'in VehiclesPage.tsx
  // "Düzenle" formu status'u HER ZAMAN gönderiyor — bu da bir aracı
  // 'BAKIMDA' işaretlemenin arayüzde "başarılı" görünüp DB'de HİÇ
  // uygulanmadığı, sessiz bir veri kaybı hatasıydı (canlı ortamda
  // doğrulanıp düzeltildi).
  status: z.enum(['AKTİF', 'BAKIMDA', 'PASİF']).optional()
});

export const updateVehicleSchema = createVehicleSchema.partial();

export type CreateVehicleDTO = z.infer<typeof createVehicleSchema>;
export type UpdateVehicleDTO = z.infer<typeof updateVehicleSchema>;
