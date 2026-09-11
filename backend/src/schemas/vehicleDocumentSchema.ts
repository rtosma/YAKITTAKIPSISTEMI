import { z } from 'zod';

/**
 * FLEET-1409 — araç doküman/ruhsat arşivi. Dosya, JSON gövdesinde base64
 * olarak taşınır (multipart/form-data yerine — bu kod tabanındaki HİÇBİR
 * uç multipart kullanmıyor, tutarlılık için). Gerçek boyut kontrolü
 * (10MB, base64 şişmesi hesaba katılarak) vehicleDocumentService.ts'te
 * decode edildikten SONRA yapılır — burada yalnızca temel şekil doğrulanır.
 */
export const uploadVehicleDocumentSchema = z.object({
  documentType: z.enum(['RUHSAT', 'MUAYENE_RAPORU', 'EGZOZ_RAPORU', 'SIGORTA_POLICESI', 'DIGER'], {
    message: 'documentType RUHSAT/MUAYENE_RAPORU/EGZOZ_RAPORU/SIGORTA_POLICESI/DIGER olmalıdır.'
  }),
  fileName: z.string({ message: 'fileName zorunludur.' }).min(1).max(255),
  mimeType: z.enum(['application/pdf', 'image/jpeg', 'image/png'], {
    message: 'mimeType application/pdf, image/jpeg veya image/png olmalıdır.'
  }),
  fileContentBase64: z.string({ message: 'fileContentBase64 zorunludur.' }).min(1),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expiryDate YYYY-MM-DD biçiminde olmalıdır.').optional()
});

export type UploadVehicleDocumentDTO = z.infer<typeof uploadVehicleDocumentSchema>;
