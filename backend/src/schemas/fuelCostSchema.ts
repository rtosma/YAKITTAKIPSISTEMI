import { z } from 'zod';

/**
 * INV-1503 — companies.fuel_cost_method'un kabul ettiği KÜMEyle (schema.sql
 * DEFAULT değeriyle) BİREBİR aynı iki değer.
 */
export const fuelCostSettingsSchema = z.object({
  method: z.enum(['AGIRLIKLI_ORTALAMA', 'FIFO'], { message: "Maliyet yöntemi 'AGIRLIKLI_ORTALAMA' veya 'FIFO' olmalıdır." })
});
