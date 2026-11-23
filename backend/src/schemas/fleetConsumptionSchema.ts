import { z } from 'zod';

/** FLEET-1405 — L/100km ve L/motor-saat tüketim hesap motoru istek şemaları. */
const periodLabelRegex = /^\d{4}-\d{2}$/;

export const fleetConsumptionQuerySchema = z.object({
  periodLabel: z.string().regex(periodLabelRegex, 'periodLabel YYYY-AA olmalıdır.'),
  vehicleId: z.string().min(1).max(64).optional()
});
export type FleetConsumptionQueryDTO = z.infer<typeof fleetConsumptionQuerySchema>;

export const fleetComparisonQuerySchema = z.object({
  periodLabel: z.string().regex(periodLabelRegex, 'periodLabel YYYY-AA olmalıdır.'),
  groupBy: z.enum(['vehicle_type', 'site_name']).default('vehicle_type')
});
export type FleetComparisonQueryDTO = z.infer<typeof fleetComparisonQuerySchema>;

export const fleetTrendQuerySchema = z.object({
  vehicleId: z.string().min(1).max(64),
  periods: z.coerce.number().int().min(2).max(24).default(6)
});
export type FleetTrendQueryDTO = z.infer<typeof fleetTrendQuerySchema>;
