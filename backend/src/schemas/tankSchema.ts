import { z } from 'zod';

// INV-1501 (#101): 'AKTİF' (ikmale açık) | 'BAKIMDA' | 'DEVRE_DIŞI' (ikisi de ikmale KAPALI —
// authorizeDispenseRequest'te zorunlu kılınır). Mevcut `status` alanıyla (stok göstergesi:
// GÜVENLİ/UYARI/KRİTİK, otomatik hesaplanır) KARIŞTIRILMAMALI.
export const tankOperationalStatusSchema = z.enum(['AKTİF', 'BAKIMDA', 'DEVRE_DIŞI'], {
  message: "Tank durumu 'AKTİF', 'BAKIMDA' veya 'DEVRE_DIŞI' olmalıdır."
});

// LoRaWAN DevEUI: EUI-64, 16 hex karakter (8 bayt). Ayraç kabul edilir (ör. "70-B3-D5-...";
// ChirpStack/TTN konsollarının kopyala-yapıştır biçimi) ve normalize edilerek (büyük harf,
// ayraçsız) saklanır — schema.sql'deki UNIQUE indeks aynı normalize edilmiş değere göre çalışır.
export const devEuiSchema = z.string()
  .transform((v) => v.replace(/[-:\s]/g, '').toUpperCase())
  .refine((v) => /^[0-9A-F]{16}$/.test(v), { message: 'DevEUI 16 haneli onaltılık (hex) bir EUI-64 olmalıdır (ör. 70B3D57ED0012345).' });

const tankPhysicalFields = {
  // AC: "kullanılabilir stok, ölü hacim düşülerek gösterilmelidir." — capacityLiters'la kıyas
  // (dead volume kapasiteyi aşamaz) her iki şemada da .refine ile ayrıca denetlenir.
  deadVolumeLiters: z.number({ message: 'Ölü hacim bir sayı olmalıdır.' }).nonnegative('Ölü hacim negatif olamaz.').optional(),
  sensorDevEui: devEuiSchema.nullable().optional(),
  sensorMountHeightMm: z.number({ message: 'Sensör montaj yüksekliği bir sayı olmalıdır.' }).positive('Sensör montaj yüksekliği 0\'dan büyük olmalıdır.').nullable().optional(),
  operationalStatus: tankOperationalStatusSchema.optional()
};

export const createTankSchema = z.object({
  name: z.string({ message: 'Tank adı zorunludur.' })
    .min(2, 'Tank adı en az 2 karakter olmalıdır.')
    .max(128, 'Tank adı çok uzun.'),
  capacityLiters: z.number({ message: 'Tank kapasitesi zorunludur.' })
    .positive('Tank kapasitesi 0\'dan büyük bir sayı olmalıdır.'),
  currentLevelLiters: z.number({ message: 'Güncel seviye zorunludur.' })
    .nonnegative('Güncel seviye negatif olamaz.'),
  fuelType: z.string().optional(),
  siteName: z.string().optional(),
  status: z.string().optional(),
  ...tankPhysicalFields
}).refine(
  (data) => data.currentLevelLiters <= data.capacityLiters,
  {
    message: 'Güncel seviye, tank kapasitesini aşamaz.',
    path: ['currentLevelLiters']
  }
).refine(
  (data) => data.deadVolumeLiters === undefined || data.deadVolumeLiters <= data.capacityLiters,
  {
    message: 'Ölü hacim, tank kapasitesini aşamaz.',
    path: ['deadVolumeLiters']
  }
);

export const updateTankSchema = z.object({
  name: z.string().min(2, 'Tank adı en az 2 karakter olmalıdır.').max(128, 'Tank adı çok uzun.').optional(),
  capacityLiters: z.number().positive('Tank kapasitesi 0\'dan büyük bir sayı olmalıdır.').optional(),
  currentLevelLiters: z.number().nonnegative('Güncel seviye negatif olamaz.').optional(),
  fuelType: z.string().optional(),
  siteName: z.string().optional(),
  status: z.string().optional(),
  // INV-1504 AC: "Tank bazında kritik ve minimum stok eşikleri." null →
  // eşik kaldırılır (yalnızca tahmini bitiş süresi kontrolü kalır).
  lowStockThresholdLiters: z.number().nonnegative('Eşik negatif olamaz.').nullable().optional(),
  reorderLeadDays: z.number().int().positive('Sipariş süresi 0\'dan büyük bir tam sayı olmalıdır.').optional(),
  ...tankPhysicalFields
}).refine(
  (data) => data.capacityLiters === undefined || data.currentLevelLiters === undefined || data.currentLevelLiters <= data.capacityLiters,
  {
    message: 'Güncel seviye, tank kapasitesini aşamaz.',
    path: ['currentLevelLiters']
  }
).refine(
  (data) => data.deadVolumeLiters === undefined || data.capacityLiters === undefined || data.deadVolumeLiters <= data.capacityLiters,
  {
    message: 'Ölü hacim, tank kapasitesini aşamaz.',
    path: ['deadVolumeLiters']
  }
);

export type CreateTankDTO = z.infer<typeof createTankSchema>;
export type UpdateTankDTO = z.infer<typeof updateTankSchema>;
