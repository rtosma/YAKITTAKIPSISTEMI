import { z } from 'zod';
import { isoDateString } from './common/dateString';

/**
 * FUEL-408 — tank dolum (alım irsaliyesi) girişi.
 *
 * Bilinçli sapma: ticket "NestJS + nesne depolama + INV-1502" öneriyor. Bu
 * yığında nesne depolama yok → irsaliye görseli yalnızca `waybillImageUrl`
 * referansı olarak saklanır. Sıcaklık düzeltmesi FUEL-403 motoru
 * (correctToStandardVolume, ASTM D1250) ile yapılır.
 *
 * `levelAfterLiters` verilirse (sensör/manuel ölçüm) fiziksel dolum miktarı
 * `levelAfter - levelBefore` olarak hesaplanır ve beyanla karşılaştırılır;
 * verilmezse stok doğrudan `declaredLiters` ile artırılır (measured_* NULL).
 *
 * INV-1502: `waybillId` verilirse (tedarikçi kartı + irsaliye başlığı YOLU —
 * bkz. supplierSchema.ts) `supplierName`/`waybillNo` İRSALİYE BAŞLIĞINDAN
 * türetilir ve BURADA TEKRAR GİRİLMEZ (aynı teslimatın birden çok tanka
 * bölünmesinde tek kaynak). `waybillId` yoksa ikisi de zorunludur — FUEL-408'in
 * eski, tedarikçi kartı olmadan hızlı manuel giriş davranışı GERİYE UYUMLU
 * korunuyor.
 */
export const createFuelIntakeSchema = z
  .object({
    supplierName: z.string().min(1, 'supplierName zorunludur.').max(160).optional(),
    waybillNo: z.string().min(1, 'waybillNo zorunludur.').max(64).optional(),
    waybillId: z.string().min(1).max(64).optional(),
    deliveryDate: isoDateString('deliveryDate YYYY-AA-GG olmalıdır.'),
    declaredLiters: z.coerce.number({ message: 'declaredLiters zorunludur.' }).positive().max(1_000_000),
    tankerPlate: z.string().min(1).max(32).optional(),
    unitPrice: z.coerce.number().nonnegative().max(1_000_000).optional(),
    temperatureC: z.coerce.number().min(-40).max(80).optional(),
    densityKgM3: z.coerce.number().positive().max(2000).optional(),
    levelBeforeLiters: z.coerce.number().nonnegative().max(10_000_000).optional(),
    levelAfterLiters: z.coerce.number().nonnegative().max(10_000_000).optional(),
    // ±% tolerans; aşılırsa EKSİK_TESLİMAT_UYARISI. Varsayılan %0.5.
    tolerancePct: z.coerce.number().positive().max(50).optional(),
    waybillImageUrl: z.string().url('waybillImageUrl geçerli bir URL olmalıdır.').max(512).optional(),
    note: z.string().max(2000).optional()
  })
  .refine((v) => v.levelAfterLiters === undefined || v.levelBeforeLiters !== undefined, {
    message: 'levelAfterLiters verildiğinde levelBeforeLiters de zorunludur.',
    path: ['levelBeforeLiters']
  })
  .refine((v) => v.levelAfterLiters === undefined || v.levelBeforeLiters === undefined || v.levelAfterLiters >= v.levelBeforeLiters, {
    message: 'levelAfterLiters, levelBeforeLiters değerinden küçük olamaz (dolum seviyeyi artırır).',
    path: ['levelAfterLiters']
  })
  .refine((v) => v.waybillId !== undefined || (v.supplierName !== undefined && v.waybillNo !== undefined), {
    message: 'waybillId verilmediyse supplierName ve waybillNo zorunludur.',
    path: ['waybillId']
  })
  .refine((v) => v.waybillId === undefined || (v.supplierName === undefined && v.waybillNo === undefined), {
    message: 'waybillId verildiğinde supplierName/waybillNo tekrar girilmez (irsaliye başlığından alınır).',
    path: ['waybillId']
  });

export type CreateFuelIntakeDTO = z.infer<typeof createFuelIntakeSchema>;

export const listFuelIntakeQuerySchema = z.object({
  tankId: z.string().min(1).max(64).optional(),
  status: z.enum(['KAYITLI', 'EKSİK_TESLİMAT_UYARISI']).optional(),
  from: isoDateString('from YYYY-AA-GG olmalıdır.').optional(),
  to: isoDateString('to YYYY-AA-GG olmalıdır.').optional()
});
export type ListFuelIntakeQueryDTO = z.infer<typeof listFuelIntakeQuerySchema>;
