import { z } from 'zod';

/**
 * INV-1502 — tedarikçi kartı (unvan, VKN, iletişim, sözleşme bilgileri).
 * VKN'nin GİB algoritmasıyla (checksum) doğrulanması servis katmanında yapılır
 * (compliance/taxIdValidation.ts, COMP-605'te zaten var); burada yalnızca kaba
 * biçim (10 haneli VKN — tedarikçi bir şirkettir, TCKN değil).
 */
export const createSupplierSchema = z.object({
  name: z.string({ message: 'Tedarikçi unvanı zorunludur.' }).min(1).max(200),
  vkn: z.string({ message: 'VKN zorunludur.' }).min(10).max(20),
  contactPhone: z.string().min(1).max(32).optional(),
  contactEmail: z.string().email('Geçerli bir e-posta adresi olmalıdır.').max(160).optional(),
  contactAddress: z.string().min(1).max(500).optional(),
  contractInfo: z.string().max(4000).optional()
});
export type CreateSupplierDTO = z.infer<typeof createSupplierSchema>;

export const updateSupplierSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  vkn: z.string().min(10).max(20).optional(),
  contactPhone: z.string().min(1).max(32).nullable().optional(),
  contactEmail: z.string().email('Geçerli bir e-posta adresi olmalıdır.').max(160).nullable().optional(),
  contactAddress: z.string().min(1).max(500).nullable().optional(),
  contractInfo: z.string().max(4000).nullable().optional(),
  status: z.enum(['AKTİF', 'PASİF']).optional()
});
export type UpdateSupplierDTO = z.infer<typeof updateSupplierSchema>;

/**
 * INV-1502 — alım irsaliyesi BAŞLIĞI. AC: "Vergi kalemleri ayrı saklanmalıdır"
 * — subtotalAmount/kdvAmount/otvAmount/totalAmount BAĞIMSIZ girilir; hiçbiri
 * diğerinden TÜRETİLMEZ. .refine yalnızca veri-girişi hatasını yakalamak için
 * toplamla TUTARLILIK kontrolü yapar (±0.05 TL yuvarlama payı) — toplamı
 * geri hesaplayıp ÜZERİNE YAZMAZ.
 */
export const createFuelPurchaseWaybillSchema = z
  .object({
    supplierId: z.string({ message: 'supplierId zorunludur.' }).min(1).max(64),
    waybillNo: z.string({ message: 'waybillNo zorunludur.' }).min(1).max(64),
    deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'deliveryDate YYYY-AA-GG olmalıdır.'),
    subtotalAmount: z.coerce.number({ message: 'subtotalAmount zorunludur.' }).nonnegative().max(100_000_000),
    kdvAmount: z.coerce.number({ message: 'kdvAmount zorunludur.' }).nonnegative().max(100_000_000),
    otvAmount: z.coerce.number().nonnegative().max(100_000_000).optional(),
    totalAmount: z.coerce.number({ message: 'totalAmount zorunludur.' }).positive().max(100_000_000),
    waybillImageUrl: z.string().url('waybillImageUrl geçerli bir URL olmalıdır.').max(512).optional(),
    note: z.string().max(2000).optional()
  })
  .refine(
    (v) => Math.abs(v.subtotalAmount + v.kdvAmount + (v.otvAmount ?? 0) - v.totalAmount) <= 0.05,
    { message: 'totalAmount, subtotalAmount + kdvAmount + otvAmount toplamıyla eşleşmiyor.', path: ['totalAmount'] }
  );
export type CreateFuelPurchaseWaybillDTO = z.infer<typeof createFuelPurchaseWaybillSchema>;
