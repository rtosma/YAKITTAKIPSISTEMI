import { z } from 'zod';

/**
 * FUEL-401.1 — POST /dispense/request-auth. Cihazın kendisi (deviceId/site)
 * hardwareAuthMiddleware'den (HMAC doğrulaması) gelir; burada yalnızca
 * kartın okuttuğu RFID UID ve pompanın bağlı olduğu tank adı gönderilir.
 */
export const dispenseRequestAuthSchema = z.object({
  rfidCardId: z.string({ message: 'rfidCardId zorunludur.' }).min(1, 'rfidCardId boş olamaz.'),
  tankName: z.string({ message: 'tankName zorunludur.' }).min(1, 'tankName boş olamaz.')
});

/**
 * FUEL-401.3 — POST /dispense/heartbeat. `totalizerLiters` cihazın debimetre
 * totalizatöründen okuduğu KÜMÜLATİF (sıfırlanmayan) toplam — sahte bir
 * "bu heartbeat'te akan miktar" değil, ticket'ın istediği "start/end
 * totalizatör farkı" hesabının girdisi budur.
 */
export const dispenseHeartbeatSchema = z.object({
  sessionId: z.string({ message: 'sessionId zorunludur.' }).min(1),
  totalizerLiters: z.coerce.number({ message: 'totalizerLiters zorunludur.' }).nonnegative(),
  flowRateLpm: z.coerce.number().nonnegative().default(0)
});

/**
 * FUEL-401.4 — POST /dispense/finalize. `reportedLiters`, cihazın KENDİ
 * hesapladığı toplam (doğrulama için start/end totalizatör farkıyla
 * KARŞILAŞTIRILIR, doğrudan güvenilmez). `idempotencyKey` cihaz tarafından
 * üretilir ve ağ kesintisi sonrası aynı finalize'ı güvenle tekrar
 * gönderebilmek için sabit kalır.
 */
export const dispenseFinalizeSchema = z.object({
  sessionId: z.string({ message: 'sessionId zorunludur.' }).min(1),
  endTotalizerLiters: z.coerce.number({ message: 'endTotalizerLiters zorunludur.' }).nonnegative(),
  reportedLiters: z.coerce.number({ message: 'reportedLiters zorunludur.' }).nonnegative(),
  idempotencyKey: z.string({ message: 'idempotencyKey zorunludur.' }).min(1).max(128)
});
