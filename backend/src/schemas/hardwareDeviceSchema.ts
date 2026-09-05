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
