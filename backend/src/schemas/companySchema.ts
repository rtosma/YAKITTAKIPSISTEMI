import { z } from 'zod';

export const createCompanySchema = z.object({
  name: z.string({ message: 'Firma ünvanı zorunludur.' }).min(2, 'Firma ünvanı en az 2 karakter olmalıdır.'),
  city: z.string().optional(),
  taxNumber: z.string().regex(/^\d{10}$/, 'Vergi numarası 10 haneli olmalıdır.').optional()
});

export const updateCompanySchema = z.object({
  licenseStatus: z.enum(['AKTİF', 'ASKIDA', 'DENEME']).optional(),
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
