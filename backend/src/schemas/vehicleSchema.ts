import { z } from 'zod';

// Turkish License Plate Regex Validator (e.g., 34 CTP 82, 41 KCL 05, 06 A 1234)
export const TURKISH_PLATE_REGEX = /^(0[1-9]|[1-7][0-9]|8[0-1])\s?[A-Z]{1,3}\s?[0-9]{2,4}$/i;

// FLEET-1401 AC: "Plakasız iş makineleri tanım koduyla kaydedilebilmelidir"
// (jeneratör, greyder gibi plakası OLMAYAN iş makineleri için — örn. "EKS-04").
// `plate` alanı tek amaçlı kalıyor (transactions/cross_site_permissions ona
// plakayla bağlanır, bkz. tenantDb.ts assertPlateAvailable yorumu) — ayrı bir
// "tanım kodu" kolonu AÇMAK yerine aynı alana İKİNCİ, ayırt edici bir biçim
// kabul ediliyor: 2-6 harf + tire + 1-4 rakam (örn. "EKS-04", "GRDR-1234").
// Gerçek bir Türkiye plakasıyla YAPISAL olarak ÇAKIŞMAZ (plaka formatında
// tire yok) — iki regex'ten biri eşleşirse kabul.
export const EQUIPMENT_CODE_REGEX = /^[A-ZÇĞİÖŞÜ]{2,6}-[0-9]{1,4}$/i;

export const createVehicleSchema = z.object({
  plate: z.string({ message: 'Araç plakası zorunludur.' })
    .refine((v) => TURKISH_PLATE_REGEX.test(v) || EQUIPMENT_CODE_REGEX.test(v), {
      message: 'Geçersiz plaka/tanım kodu formatı. (Örn: "34 CTP 82" ya da plakasız iş makineleri için "EKS-04")'
    }),
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
  // FUEL-407: aracın alabileceği yakıt tipi (serbest metin — Motorin/Benzin/
  // AdBlue/...). Dolu ve tank yakıt tipiyle uyumsuzsa ikmal reddedilir.
  fuelType: z.string().min(1).max(64).optional(),
  // FLEET-1404: sayaç ölçüm birimi (araç tipinden türetilir, açıkça da verilebilir).
  meterType: z.enum(['KM', 'MOTOR_SAAT']).optional(),
  // FLEET-1401: ikisi de bilgilendirici/isteğe bağlı — hiçbir iş kuralı
  // bunlara dayanmaz (bkz. schema.sql yorumu).
  yearOfManufacture: z.number({ message: 'Üretim yılı geçerli bir sayı olmalıdır.' })
    .int('Üretim yılı tam sayı olmalıdır.')
    .min(1970, 'Üretim yılı 1970\'ten önce olamaz.')
    .max(new Date().getFullYear() + 1, 'Üretim yılı gelecekte olamaz.')
    .optional(),
  avgConsumptionExpectation: z.number({ message: 'Ortalama tüketim beklentisi geçerli bir sayı olmalıdır.' })
    .positive('Ortalama tüketim beklentisi 0\'dan büyük olmalıdır.')
    .optional(),
  // GERÇEK BİR HATA: bu alan önceden şemada hiç tanımlı değildi — Zod
  // (varsayılan olarak bilinmeyen alanları SESSİZCE siler) her PUT
  // /vehicles/:id isteğindeki status'u atıyordu. Frontend'in VehiclesPage.tsx
  // "Düzenle" formu status'u HER ZAMAN gönderiyor — bu da bir aracı
  // 'BAKIMDA' işaretlemenin arayüzde "başarılı" görünüp DB'de HİÇ
  // uygulanmadığı, sessiz bir veri kaybı hatasıydı (canlı ortamda
  // doğrulanıp düzeltildi).
  // FLEET-1401 AC: "Durum yönetimi: aktif, pasif, bakımda, yakıt alımı bloke."
  // BLOKE, PASİF'ten AYRI bir durum — PASİF genelde "artık filoda değil/emekli"
  // anlamına gelirken BLOKE aracın filoda AKTİF kalıp yalnızca yakıt alımının
  // (bir politika/şüpheli kullanım nedeniyle) geçici olarak durdurulduğu
  // durumdur. İkisi de fiilen AYNI teknik etkiyi taşır (bkz. tenantDb.ts
  // authorizeDispenseRequest/createTransaction — yalnızca 'AKTİF' dışındaki
  // HER durumu engeller), ayrım tamamen ANLAM/raporlama içindir.
  status: z.enum(['AKTİF', 'BAKIMDA', 'PASİF', 'BLOKE']).optional()
});

export const updateVehicleSchema = createVehicleSchema.partial();

export type CreateVehicleDTO = z.infer<typeof createVehicleSchema>;
export type UpdateVehicleDTO = z.infer<typeof updateVehicleSchema>;
