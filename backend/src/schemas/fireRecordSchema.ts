import { z } from 'zod';

/**
 * INV-1505 — fire/kayıp kaydı ve sınıflandırması. `KAÇAK`/`HIRSIZLIK`
 * yalnızca bir insanın (onay/reclassify anında) atayabileceği sınıflardır —
 * otomatik aday üretimi (reconcileTankRow) bunları asla üretmez.
 */
const CLASSIFICATION_ENUM = z.enum(['BUHARLAŞMA', 'ÖLÇÜM_HATASI', 'KAÇAK', 'HIRSIZLIK', 'AÇIKLANAMAYAN']);

export const createFireRecordSchema = z.object({
  tankId: z.string().min(1, 'tankId zorunludur.').max(64),
  recordDate: z.string().date('recordDate YYYY-MM-DD biçiminde olmalıdır.'),
  quantityLiters: z.coerce.number({ message: 'quantityLiters zorunludur.' }).positive().max(1_000_000),
  varianceDirection: z.enum(['KAYIP', 'FAZLA']),
  classification: CLASSIFICATION_ENUM,
  description: z.string().max(2000).optional()
});
export type CreateFireRecordDTO = z.infer<typeof createFireRecordSchema>;

export const approveFireRecordSchema = z.object({
  reclassify: CLASSIFICATION_ENUM.optional(),
  description: z.string().max(2000).optional()
});
export type ApproveFireRecordDTO = z.infer<typeof approveFireRecordSchema>;

export const rejectFireRecordSchema = z.object({
  reason: z.string().min(5, 'reason en az 5 karakter olmalıdır.').max(1000)
});
export type RejectFireRecordDTO = z.infer<typeof rejectFireRecordSchema>;

export const listFireRecordQuerySchema = z.object({
  tankId: z.string().min(1).max(64).optional(),
  status: z.enum(['BEKLIYOR', 'ONAYLANDI', 'REDDEDİLDİ']).optional(),
  siteName: z.string().min(1).max(128).optional()
});
export type ListFireRecordQueryDTO = z.infer<typeof listFireRecordQuerySchema>;

export const fireRecordSiteComparisonQuerySchema = z.object({
  periodDays: z.coerce.number().int().positive().max(365).default(90)
});
export type FireRecordSiteComparisonQueryDTO = z.infer<typeof fireRecordSiteComparisonQuerySchema>;
