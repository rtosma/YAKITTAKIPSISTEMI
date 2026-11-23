import { z } from 'zod';
import { isoDateString } from './common/dateString';

/**
 * INV-1507 — şantiye laboratuvar numunesi + test sonucu.
 */
export const createLabSampleSchema = z.object({
  sampleType: z.enum(['BETON', 'AGREGA', 'ZEMİN', 'YAKIT', 'DİĞER'], {
    message: 'sampleType BETON/AGREGA/ZEMİN/YAKIT/DİĞER olmalıdır.'
  }),
  siteName: z.string().trim().min(1, 'siteName zorunludur.').max(128),
  location: z.string().trim().max(200).optional(),
  referenceNo: z.string().trim().max(64).optional(),
  collectedAt: isoDateString('collectedAt YYYY-AA-GG olmalıdır.'),
  note: z.string().trim().max(1000).optional()
});
export type CreateLabSampleDTO = z.infer<typeof createLabSampleSchema>;

export const cancelLabSampleSchema = z.object({
  reason: z.string().trim().min(5, 'reason en az 5 karakter olmalıdır.').max(1000)
});
export type CancelLabSampleDTO = z.infer<typeof cancelLabSampleSchema>;

/**
 * `conformity` doğrudan verilebilir (kalitatif test) VEYA `resultValue` +
 * en az bir spec sınırı (specMin/specMax) verilip sistemin türetmesi
 * sağlanabilir — ikisi de yoksa (uygunluk belirlenemez) 400 döner.
 */
export const recordLabTestResultSchema = z
  .object({
    testType: z.string().trim().min(1, 'testType zorunludur.').max(64),
    testedAt: isoDateString('testedAt YYYY-AA-GG olmalıdır.'),
    resultValue: z.coerce.number().optional(),
    unit: z.string().trim().max(32).optional(),
    specMin: z.coerce.number().optional(),
    specMax: z.coerce.number().optional(),
    conformity: z.enum(['UYGUN', 'UYGUNSUZ']).optional(),
    note: z.string().trim().max(1000).optional()
  })
  .refine(
    (data) => !!data.conformity || (data.resultValue !== undefined && (data.specMin !== undefined || data.specMax !== undefined)),
    { message: 'conformity belirtilmeli VEYA resultValue + en az bir spec sınırı (specMin/specMax) verilmelidir.' }
  );
export type RecordLabTestResultDTO = z.infer<typeof recordLabTestResultSchema>;
