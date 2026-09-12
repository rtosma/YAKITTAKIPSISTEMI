import { z } from 'zod';

export const createPersonnelSchema = z.object({
  fullName: z.string({ message: 'fullName zorunludur.' }).min(2, 'Ad Soyad en az 2 karakter olmalıdır.'),
  tcNo: z.string().regex(/^\d{11}$/, 'tcNo 11 haneli olmalıdır.').optional(),
  roleTitle: z.enum(['ŞOFÖR', 'ŞANTİYE_ŞEFİ', 'OPERATÖR', 'DİĞER']).optional(),
  siteName: z.string().optional(),
  driverId: z.string().optional(),
  annualLeaveEntitlementDays: z.number().positive().optional(),
  hireDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'hireDate YYYY-MM-DD biçiminde olmalıdır.').optional()
});

export const createLeaveRequestSchema = z.object({
  leaveType: z.enum(['YILLIK', 'MAZERET', 'ÜCRETSİZ'], { message: 'leaveType YILLIK/MAZERET/ÜCRETSİZ olmalıdır.' }),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'startDate YYYY-MM-DD biçiminde olmalıdır.'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'endDate YYYY-MM-DD biçiminde olmalıdır.'),
  reason: z.string().max(1000).optional()
});

export const rejectLeaveRequestSchema = z.object({
  rejectionReason: z.string({ message: 'rejectionReason zorunludur.' }).min(2)
});

export type CreatePersonnelDTO = z.infer<typeof createPersonnelSchema>;
export type CreateLeaveRequestDTO = z.infer<typeof createLeaveRequestSchema>;
