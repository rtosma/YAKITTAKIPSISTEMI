import { z } from 'zod';

// BILL-1701: adlandırılmış paket kademesi (bkz. adminDb.ts PACKAGE_MODULE_DEFAULTS).
const packageTierSchema = z.enum(['TEMEL', 'PROFESYONEL', 'KURUMSAL']);

export const createCompanySchema = z.object({
  name: z.string({ message: 'Firma ünvanı zorunludur.' }).min(2, 'Firma ünvanı en az 2 karakter olmalıdır.'),
  city: z.string().optional(),
  taxNumber: z.string().regex(/^\d{10}$/, 'Vergi numarası 10 haneli olmalıdır.').optional(),
  package: packageTierSchema.optional()
});

export const updateCompanySchema = z.object({
  licenseStatus: z.enum(['AKTİF', 'ASKIDA', 'DENEME']).optional(),
  // BILL-1701: lisansın sona erdiği tarih — geçmişte bir tarih olması
  // BİLİNÇLİ olarak reddedilmiyor (SUPER_ADMIN'in "süresi dolmuş" durumu
  // test etmek/simüle etmek için geçmiş bir tarih girmesi geçerli bir kullanım).
  licenseExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Lisans bitiş tarihi YYYY-MM-DD biçiminde olmalıdır.').nullable().optional(),
  package: packageTierSchema.optional(),
  modules: z.object({
    aiAnomaly: z.boolean().optional(),
    eInvoice: z.boolean().optional(),
    smartWarehouse: z.boolean().optional(),
    maintenanceTrack: z.boolean().optional(),
    driverScore: z.boolean().optional(),
    crossSiteAuth: z.boolean().optional()
  }).optional()
});

export type CreateCompanyDTO = z.infer<typeof createCompanySchema>;
export type UpdateCompanyDTO = z.infer<typeof updateCompanySchema>;
