import { z } from 'zod';

/**
 * AI-503 — km/motor-saat bazlı tüketim anomalisi istek şemaları.
 * (consumptionAnomalySchema.ts adı AI-502'de zaten kullanılıyor — bu ayrı dosya.)
 */
const periodLabelRegex = /^\d{4}-\d{2}$/;

export const vehicleConsumptionAnomalyQuerySchema = z.object({
  periodLabel: z.string().regex(periodLabelRegex, 'periodLabel YYYY-AA olmalıdır.'),
  vehicleId: z.string().min(1).max(64)
});
export type VehicleConsumptionAnomalyQueryDTO = z.infer<typeof vehicleConsumptionAnomalyQuerySchema>;

export const consumptionAnomalyScanSchema = z.object({
  periodLabel: z.string().regex(periodLabelRegex, 'periodLabel YYYY-AA olmalıdır.')
});
export type ConsumptionAnomalyScanDTO = z.infer<typeof consumptionAnomalyScanSchema>;
