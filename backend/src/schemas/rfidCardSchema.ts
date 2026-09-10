import { z } from 'zod';

/**
 * AUTH-210 — RFID kart kayıp/blokaj ve değiştirme akışı gövde şemaları.
 * Kart yaşam döngüsü durumları: ACTIVE (kara listede DEĞİL) | LOST | BLOCKED
 * | REPLACED. `POST /rfid-cards/:cardUid/block` yalnızca LOST/BLOCKED alır
 * (REPLACED yalnızca /replace akışından üretilir, ACTIVE ise /unblock).
 */

export const blockRfidCardSchema = z.object({
  status: z.enum(['LOST', 'BLOCKED'], { message: 'status LOST veya BLOCKED olmalıdır.' }),
  reason: z.string().max(256).optional()
});
export type BlockRfidCardDTO = z.infer<typeof blockRfidCardSchema>;

export const replaceRfidCardSchema = z.object({
  oldCardUid: z.string({ message: 'oldCardUid zorunludur.' }).min(1).max(64),
  newCardUid: z.string({ message: 'newCardUid zorunludur.' }).min(1).max(64)
}).refine((v) => v.oldCardUid !== v.newCardUid, {
  message: 'Yeni kart eskisiyle aynı olamaz.',
  path: ['newCardUid']
});
export type ReplaceRfidCardDTO = z.infer<typeof replaceRfidCardSchema>;
