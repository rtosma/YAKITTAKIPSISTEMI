import { z } from 'zod';

/**
 * IOT-308 — cihaz sağlık skoru, sürüm envanteri, online SLA.
 *
 * Bilinçli sapma: AI-506 (driverBehaviorScoreSchema.ts) ile AYNI 3 parçalı
 * şekil (compute-body / list-query / history-query) — bu yığında
 * NestJS/@nestjs/schedule yok, manuel bir hesaplama endpoint'i + index.ts
 * süpürücüsü kullanılıyor.
 */
export const computeDeviceHealthScoresSchema = z.object({
  periodDays: z.coerce.number().int().min(1).max(365).default(30),
  // AC: "yetersiz veri" — cihazın TÜM ZAMANLARDA ürettiği presence olayı
  // sayısı (bkz. tenantDb.ts DEVICE_HEALTH_MIN_SAMPLES_DEFAULT notu).
  minSamples: z.coerce.number().int().min(1).max(1000).default(1),
  deviceId: z.string().min(1).max(64).optional()
});
export type ComputeDeviceHealthScoresDTO = z.infer<typeof computeDeviceHealthScoresSchema>;

export const listDeviceHealthScoresQuerySchema = z.object({
  siteName: z.string().min(1).max(128).optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  maxScore: z.coerce.number().int().min(0).max(100).optional()
});
export type ListDeviceHealthScoresQueryDTO = z.infer<typeof listDeviceHealthScoresQuerySchema>;

export const deviceHealthScoreHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(30)
});
export type DeviceHealthScoreHistoryQueryDTO = z.infer<typeof deviceHealthScoreHistoryQuerySchema>;

export const deviceOnlineSlaQuerySchema = z.object({
  months: z.coerce.number().int().min(1).max(12).default(1)
});
export type DeviceOnlineSlaQueryDTO = z.infer<typeof deviceOnlineSlaQuerySchema>;
