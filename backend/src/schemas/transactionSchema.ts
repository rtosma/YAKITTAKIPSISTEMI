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
  // 'Çevrimdışı Senkron' burada YOK — bu manuel/operatör tetiklemeli
  // formun kendi type'ı, bir insan operatör "offline sync" iddia edemez;
  // o değer yalnızca tenantDb.ts syncOfflineDispenseBatch'in kendi INSERT'i
  // tarafından, bu şemadan hiç geçmeden yazılıyor (bkz. IOT-303.1).
  type: z.enum(['Otomatik', 'Manuel', 'Çapraz Şantiye']).optional(),
  rfidAuth: z.boolean().optional()
});

export type DispenseRequestDTO = z.infer<typeof dispenseRequestSchema>;

/**
 * FE-802 — GET /transactions artık tüm geçmişi (eskiden sabit LIMIT 200)
 * tek seferde döndürmek yerine sunucu taraflı sayfalama + filtreleme
 * yapıyor. Filtre alanlarının hepsi opsiyonel; boş/gönderilmemiş bir alan
 * o kritere göre daraltma uygulamaz.
 */
export const transactionQuerySchema = z.object({
  page: z.coerce.number({ message: 'Sayfa numarası geçerli bir sayı olmalıdır.' })
    .int().positive().default(1),
  pageSize: z.coerce.number({ message: 'Sayfa boyutu geçerli bir sayı olmalıdır.' })
    .int().positive().max(100, 'Sayfa boyutu en fazla 100 olabilir.').default(10),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Başlangıç tarihi YYYY-AA-GG formatında olmalıdır.').optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Bitiş tarihi YYYY-AA-GG formatında olmalıdır.').optional(),
  siteName: z.string().min(1).optional(),
  driverName: z.string().min(1).optional(),
  pumpStatus: z.enum(['TAMAMLANTI', 'DURDURULDU', 'ANOMALİ']).optional(),
  type: z.enum(['Otomatik', 'Manuel', 'Çapraz Şantiye', 'Çevrimdışı Senkron']).optional(),
  search: z.string().min(1).max(128).optional()
});

export type TransactionQueryDTO = z.infer<typeof transactionQuerySchema>;

/**
 * IOT-303.1 — POST /telemetry/sync-batch. Cihaz bağlantısı kesikken
 * biriktirdiği ikmalleri, bağlantı geri geldiğinde tek istekte gönderir.
 * deviceTimestamp, dispense'in GERÇEKTEN gerçekleştiği an (cihazın RTC'si) —
 * X-Timestamp HMAC header'ı (bu isteğin KENDİSİNİN ne zaman gönderildiği,
 * AUTH-202.2'nin 30sn'lik replay penceresiyle) ile KARIŞTIRILMAMALI; ikisi
 * tamamen farklı zaman kavramları, hardwareAuthMiddleware'de hiçbir
 * değişiklik/muafiyet gerekmiyor.
 */
export const syncBatchRecordSchema = z.object({
  localSequenceId: z.coerce.number({ message: 'localSequenceId zorunludur.' }).int().positive(),
  deviceTimestamp: z.string({ message: 'deviceTimestamp zorunludur.' }).datetime({ message: 'deviceTimestamp ISO-8601 formatında olmalıdır.' }),
  siteName: z.string({ message: 'siteName zorunludur.' }).min(1),
  vehiclePlate: z.string({ message: 'vehiclePlate zorunludur.' })
    .regex(TURKISH_PLATE_REGEX, { message: 'Geçersiz Türkiye plaka formatı.' }),
  driverName: z.string().optional(),
  tankName: z.string({ message: 'tankName zorunludur.' }).min(1),
  amountLiters: z.coerce.number({ message: 'amountLiters zorunludur.' }).gt(0, 'amountLiters 0\'dan büyük olmalıdır.'),
  flowRateLpm: z.coerce.number().nonnegative().optional()
});

export const syncBatchSchema = z.object({
  // Ticket'ın stres testi 5.000 kayıt öneriyor — üst sınır bu, tek bir HTTP
  // isteğinin bellek/işleme süresini sınırlamak için.
  records: z.array(syncBatchRecordSchema).min(1, 'En az bir kayıt gönderilmelidir.').max(5000, 'Tek istekte en fazla 5000 kayıt gönderilebilir.')
});

export type SyncBatchDTO = z.infer<typeof syncBatchSchema>;
