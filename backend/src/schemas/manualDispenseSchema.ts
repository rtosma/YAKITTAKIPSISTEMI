import { z } from 'zod';

/**
 * FUEL-405 — cihaz arızası / elle pompa kullanımı için manuel ikmal girişi.
 *
 * Bilinçli sapma: ticket "NestJS + nesne depolama (belge) + NOTIF-1601"
 * öneriyor. Nesne depolama yok → belge yalnızca `documentUrl` referansı;
 * bildirim modülü yok → oran uyarısı yanıtın kendisinde + audit_logs. Çift
 * onay (iki farklı yetkili: bir SITE_MANAGER + bir COMPANY_OWNER/SUPER_ADMIN)
 * kaydı kesinleştirir; ikinci onayda gerçek transactions kaydı üretilir.
 */
export const createManualDispenseSchema = z.object({
  tankId: z.string().min(1, 'tankId zorunludur.').max(64),
  vehiclePlate: z.string().min(1, 'vehiclePlate zorunludur.').max(32),
  driverName: z.string().min(1).max(128).optional(),
  liters: z.coerce.number({ message: 'liters zorunludur.' }).positive().max(100_000),
  // ISO 8601 (offset'li). Geçmişe dönük sınır ve gelecek tarih kontrolü serviste.
  dispensedAt: z.string().datetime({ offset: true }),
  reason: z.string().min(5, 'reason en az 5 karakter olmalıdır.').max(2000),
  documentUrl: z.string().url('documentUrl geçerli bir URL olmalıdır.').max(512).optional()
});
export type CreateManualDispenseDTO = z.infer<typeof createManualDispenseSchema>;

export const rejectManualDispenseSchema = z.object({
  reason: z.string().min(5, 'reason en az 5 karakter olmalıdır.').max(1000)
});
export type RejectManualDispenseDTO = z.infer<typeof rejectManualDispenseSchema>;

export const listManualDispenseQuerySchema = z.object({
  status: z.enum(['ONAY_BEKLIYOR', 'ONAYLANDI', 'REDDEDİLDİ', 'İPTAL']).optional(),
  siteName: z.string().min(1).max(128).optional()
});
export type ListManualDispenseQueryDTO = z.infer<typeof listManualDispenseQuerySchema>;

export const manualDispenseRatioQuerySchema = z.object({
  siteName: z.string().min(1).max(128).optional(),
  days: z.coerce.number().int().positive().max(365).default(30),
  thresholdPct: z.coerce.number().positive().max(100).default(10)
});
export type ManualDispenseRatioQueryDTO = z.infer<typeof manualDispenseRatioQuerySchema>;
