import { z } from 'zod';

/**
 * AI-502 AC: "Yapay zeka çıktıları JSON schema formatında doğrulanıp
 * dashboard'a sunulmalıdır." Bu şema Gemini'ye TALEP edilen JSON şeklini
 * (config.responseSchema) TANIMLAMAK için değil (Gemini'nin kendi şema
 * formatı ayrı, bkz. consumptionAnomalyService.ts GEMINI_RESPONSE_SCHEMA) —
 * modelin DÖNDÜRDÜĞÜ metnin JSON.parse'tan SONRA gerçekten beklenen şekilde
 * olduğunu doğrulamak için. Bir LLM'in çıktısına asla kör güvenilmez: model
 * yanlış alan adı, eksik alan veya beklenmeyen bir enum değeri üretebilir —
 * bu şema o durumlarda raporun DB'ye yazılmasını engeller.
 */
export const anomalyRiskLevelSchema = z.enum(['DÜŞÜK', 'ORTA', 'YÜKSEK']);

export const anomalyItemSchema = z.object({
  vehiclePlate: z.string().min(1),
  driverName: z.string().nullable(),
  totalLiters: z.number().nonnegative(),
  dispenseCount: z.number().int().nonnegative(),
  riskLevel: anomalyRiskLevelSchema,
  reason: z.string().min(1)
});

export const anomalyAnalysisResultSchema = z.object({
  anomalies: z.array(anomalyItemSchema)
});

export type AnomalyItem = z.infer<typeof anomalyItemSchema>;
export type AnomalyAnalysisResult = z.infer<typeof anomalyAnalysisResultSchema>;

/**
 * POST /ai/consumption-anomaly-reports — periodDays opsiyonel, varsayılan
 * ticket'ın kendi ifadesi olan "haftalık" (7 gün).
 */
export const generateAnomalyReportSchema = z.object({
  periodDays: z.coerce.number({ message: 'periodDays geçerli bir sayı olmalıdır.' })
    .int().positive().max(90, 'periodDays en fazla 90 olabilir.').default(7)
});

export type GenerateAnomalyReportDTO = z.infer<typeof generateAnomalyReportSchema>;
