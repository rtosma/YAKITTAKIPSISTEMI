import { z } from 'zod';

/**
 * FUEL-404.1 — POST /devices/:deviceId/calibration. `reason` zorunlu (AC:
 * her değişiklik kim/ne zaman/eski/yeni değer VE gerekçeyle kayıt altına
 * alınmalı) — elle girilen serbest metin, FUEL-404.2'nin referans kap
 * ölçümü henüz yapılmadıysa da kalibrasyon isteğinin neden yapıldığını
 * açıklamak için gerekli.
 */
export const requestCalibrationSchema = z.object({
  newKFactor: z.coerce.number({ message: 'newKFactor zorunludur.' }).positive('newKFactor 0\'dan büyük olmalıdır.'),
  reason: z.string({ message: 'reason zorunludur.' }).min(1, 'reason boş olamaz.'),
  referenceMeasurement: z.object({
    referenceVolumeLiters: z.coerce.number().positive().optional(),
    measuredLiters: z.coerce.number().positive().optional(),
    ambientTemperatureCelsius: z.coerce.number().optional()
  }).optional()
});

/**
 * FUEL-404.1 — POST /telemetry/calibration-ack. Cihazın kendisi (HMAC ile
 * doğrulanmış) gönderir — `status: 'ACK'` ise appliedKFactor ZORUNLU
 * (cihazın FİİLEN uyguladığı değer, sunucunun gönderdiği değerle aynı
 * olmalı ama cihaz kendi ölçtüğünü bildirir — bu, FUEL-401.4'ün "cihazın
 * kendi bildirdiğine körü körüne güvenme" temkinliliğiyle aynı ruhta).
 */
export const calibrationAckSchema = z.object({
  commandId: z.string({ message: 'commandId zorunludur.' }).min(1),
  status: z.enum(['ACK', 'NACK']),
  appliedKFactor: z.coerce.number().positive().optional(),
  reason: z.string().optional()
}).refine(
  (data) => data.status === 'NACK' || data.appliedKFactor !== undefined,
  { message: 'ACK durumunda appliedKFactor zorunludur.', path: ['appliedKFactor'] }
);

/**
 * FUEL-404.2 — POST /devices/:deviceId/test-intake. Teknisyen panelden
 * elle giriyor (referans kabı fiziksel olarak tarttı/ölçtü) — bu yüzden
 * HMAC değil, normal JWT ile korunuyor (AUTH-202.3'ün cihaz akışlarından
 * farklı olarak burada "cihaz" değil bir İNSAN istek atıyor).
 */
export const testIntakeSchema = z.object({
  tankName: z.string({ message: 'tankName zorunludur.' }).min(1),
  siteName: z.string({ message: 'siteName zorunludur.' }).min(1),
  referenceVolumeLiters: z.coerce.number({ message: 'referenceVolumeLiters zorunludur.' }).positive(),
  measuredLiters: z.coerce.number({ message: 'measuredLiters zorunludur.' }).positive(),
  ambientTemperatureCelsius: z.coerce.number().optional(),
  // Bu alım, daha önce ONAYLANMIŞ bir kalibrasyon komutunun sapmayı
  // GERÇEKTEN düzelttiğini doğrulamak için yapılan bir "doğrulama alımı"ysa.
  verifiesCalibrationCommandId: z.string().optional()
});
