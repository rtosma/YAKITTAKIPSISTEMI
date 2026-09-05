import { z } from 'zod';

/**
 * AUTH-202.3 — cihaz provisioning. deviceId, hardwareAuthMiddleware'in
 * X-Device-ID başlığında beklediği insan-okunur kimlikle birebir aynı
 * formatta olmalı (örn. ESP32-PUMP-02) — global olarak benzersizdir
 * (tenantDb.ts createHardwareDevice bunu ayrıca DB seviyesinde de doğrular).
 */
export const createHardwareDeviceSchema = z.object({
  deviceId: z.string({ message: 'deviceId zorunludur.' })
    .min(3, 'deviceId en az 3 karakter olmalıdır.')
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, 'deviceId yalnızca harf, rakam, tire ve alt çizgi içerebilir.'),
  name: z.string({ message: 'name zorunludur.' }).min(1, 'name boş olamaz.'),
  siteName: z.string({ message: 'siteName zorunludur.' }).min(1, 'siteName boş olamaz.')
});

export const relocateHardwareDeviceSchema = z.object({
  siteName: z.string({ message: 'siteName zorunludur.' }).min(1, 'siteName boş olamaz.')
});

/** IOT-304 — bir COMPANY_OWNER/SUPER_ADMIN'in yeni bir claim kodu üretmesi. */
export const createDeviceClaimCodeSchema = z.object({
  siteName: z.string({ message: 'siteName zorunludur.' }).min(1, 'siteName boş olamaz.'),
  deviceName: z.string({ message: 'deviceName zorunludur.' }).min(1, 'deviceName boş olamaz.'),
  expiresInMinutes: z.coerce.number().int().positive().max(1440, 'Claim kodu en fazla 24 saat geçerli olabilir.').optional()
});

/**
 * IOT-304 — sahadaki cihazın/teknisyenin bu kodu tüketmesi. JWT/HMAC YOK:
 * cihazın henüz bir secret'ı olmadığı için kimlik doğrulaması claim kodunun
 * KENDİSİDİR (yüksek entropili, tek kullanımlık, süreli).
 */
export const claimDeviceSchema = z.object({
  code: z.string({ message: 'code zorunludur.' }).min(1, 'code boş olamaz.'),
  deviceId: z.string({ message: 'deviceId zorunludur.' })
    .min(3, 'deviceId en az 3 karakter olmalıdır.')
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, 'deviceId yalnızca harf, rakam, tire ve alt çizgi içerebilir.'),
  serialNumber: z.string().max(128).optional(),
  macAddress: z.string().max(32).optional(),
  model: z.string().max(128).optional(),
  hardwareRevision: z.string().max(64).optional()
});
