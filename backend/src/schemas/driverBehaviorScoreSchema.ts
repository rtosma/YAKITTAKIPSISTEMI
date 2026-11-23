import { z } from 'zod';

/**
 * AI-506 — şoför davranış skorlama motoru.
 *
 * Bilinçli sapma: bu ticket için ayrı bir "worker/cron" kütüphanesi yok —
 * AI-503/AI-504 ile AYNI desen: manuel POST /drivers/behavior-scores/compute
 * + index.ts'te düz bir günlük setInterval süpürücüsü.
 */
export const computeDriverBehaviorScoresSchema = z.object({
  periodDays: z.coerce.number().int().min(1).max(365).default(90),
  // AC: "minimum işlem eşiği altında skor üretilmemeli."
  minTransactions: z.coerce.number().int().min(1).max(1000).default(5),
  driverName: z.string().min(1).max(128).optional()
});
export type ComputeDriverBehaviorScoresDTO = z.infer<typeof computeDriverBehaviorScoresSchema>;

export const listDriverBehaviorScoresQuerySchema = z.object({
  siteName: z.string().min(1).max(128).optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  maxScore: z.coerce.number().int().min(0).max(100).optional()
});
export type ListDriverBehaviorScoresQueryDTO = z.infer<typeof listDriverBehaviorScoresQuerySchema>;

export const driverBehaviorScoreHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(30)
});
export type DriverBehaviorScoreHistoryQueryDTO = z.infer<typeof driverBehaviorScoreHistoryQuerySchema>;
