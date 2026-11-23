import { z } from 'zod';

/**
 * FUEL-407 — pompa-tank eşlemesi + yakıt tipi stok özeti istek şemaları.
 */
export const setDeviceTankSchema = z.object({
  // null → eşlemeyi kaldır.
  tankName: z.string().min(1).max(128).nullable()
});
export type SetDeviceTankDTO = z.infer<typeof setDeviceTankSchema>;

export const fuelStockSummaryQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30)
});
export type FuelStockSummaryQueryDTO = z.infer<typeof fuelStockSummaryQuerySchema>;
