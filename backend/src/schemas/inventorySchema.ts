import { z } from 'zod';

/**
 * INV-1506 — yedek parça/sarf malzeme kartı + stok hareketleri.
 */
export const createInventoryItemSchema = z.object({
  code: z.string().trim().min(1, 'code zorunludur.').max(64),
  name: z.string().trim().min(1, 'name zorunludur.').max(200),
  unit: z.string().trim().min(1, 'unit zorunludur.').max(32),
  siteName: z.string().trim().max(128).optional(),
  storageLocation: z.string().trim().max(128).optional(),
  criticalStockLevel: z.coerce.number({ message: 'criticalStockLevel zorunludur.' }).nonnegative(),
  initialStock: z.coerce.number().nonnegative().optional()
});
export type CreateInventoryItemDTO = z.infer<typeof createInventoryItemSchema>;

export const recordInventoryMovementSchema = z.object({
  movementType: z.enum(['GİRİŞ', 'ÇIKIŞ'], { message: "movementType 'GİRİŞ' veya 'ÇIKIŞ' olmalıdır." }),
  quantity: z.coerce.number({ message: 'quantity zorunludur.' }).positive(),
  relatedVehicleId: z.string().trim().max(64).optional(),
  relatedMaintenanceRecordId: z.string().trim().max(64).optional(),
  note: z.string().trim().max(1000).optional()
});
export type RecordInventoryMovementDTO = z.infer<typeof recordInventoryMovementSchema>;

export const recordInventoryCountSchema = z.object({
  countedQuantity: z.coerce.number({ message: 'countedQuantity zorunludur.' }).nonnegative(),
  note: z.string().trim().max(1000).optional()
});
export type RecordInventoryCountDTO = z.infer<typeof recordInventoryCountSchema>;
