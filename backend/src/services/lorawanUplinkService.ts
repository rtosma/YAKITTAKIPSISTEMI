import { getHardwareDeviceByDeviceId } from '../db/adminDb';
import { redisPool } from '../db/redisPool';
import { runWithTenant } from '../context/tenantContext';
import { ioTEventBus } from '../iot/mqttClient';
import { CorruptedPayloadException, type DecodedTankUplink, type LoRaWANRadioMeta } from '../iot/lorawanDecoder';
import { resolveDecoder } from '../iot/lorawanDecoderRegistry';
import { logger } from '../utils/logger';
import type { LoRaWANUplinkDTO } from '../schemas/lorawanWebhookSchema';

/**
 * IOT-302.1 — ChirpStack/TTN webhook'undan gelen tek bir LoRaWAN uplink'ini
 * çözer ve mevcut telemetri hattına (ioTEventBus 'telemetryData' + Redis
 * presence + 'deviceStatusChanged') aktarır — mqttClient.ts'teki `data`
 * dalıyla AYNI davranış.
 *
 * "Beklenen" başarısızlıklar (kayıtsız/bloke cihaz, bozuk paket) FIRLATMAZ —
 * `{ accepted: false, reason }` döner ki webhook 2xx dönüp ChirpStack'in
 * sonsuza kadar retry etmesini önlesin ve tek bir bozuk paket hattı
 * DURDURMASIN (AC: "izole edilir, hattı durdurmaz"). Yalnızca beklenmeyen
 * hatalar route'un catch'ine kadar çıkar.
 */

export type UplinkIngestResult =
  | { accepted: true; deviceId: string; resolvedModel: string; decoded: DecodedTankUplink }
  | {
      accepted: false;
      deviceId: string;
      reason: 'DEVICE_NOT_REGISTERED' | 'DEVICE_BLOCKED' | 'CORRUPTED_PAYLOAD';
      detail?: string;
    };

const HEX_ONLY = /^[0-9a-fA-F]+$/;

/** payload alanını Buffer'a çevirir; hex ya da base64 (ipucu yoksa saptanır). */
function payloadToBuffer(payload: string, encoding?: 'hex' | 'base64'): Buffer {
  const trimmed = payload.trim().replace(/\s+/g, '');
  const looksHex = HEX_ONLY.test(trimmed) && trimmed.length % 2 === 0;
  const useHex = encoding === 'hex' || (encoding === undefined && looksHex);
  if (useHex) return Buffer.from(trimmed.replace(/^0x/i, ''), 'hex');
  return Buffer.from(trimmed, 'base64');
}

export async function ingestLoRaWANUplink(envelope: LoRaWANUplinkDTO): Promise<UplinkIngestResult> {
  const { deviceId } = envelope;

  const device = await getHardwareDeviceByDeviceId(deviceId);
  if (!device) {
    logger.warn({ deviceId }, '🚫 [IOT-302.1] Kayıtlı olmayan cihazdan LoRaWAN webhook uplink\'i reddedildi.');
    return { accepted: false, deviceId, reason: 'DEVICE_NOT_REGISTERED' };
  }
  if (device.status === 'BLOKE') {
    logger.warn({ deviceId }, '🚫 [IOT-302.1] Bloke edilmiş cihazdan LoRaWAN webhook uplink\'i reddedildi.');
    return { accepted: false, deviceId, reason: 'DEVICE_BLOCKED' };
  }

  const meta: LoRaWANRadioMeta = {
    rssi: envelope.rssi,
    snr: envelope.snr,
    devEui: envelope.devEui,
    fPort: envelope.fPort,
    gatewayId: envelope.gatewayId
  };

  // Model önceliği: webhook zarfındaki `model` > cihazın kayıtlı modeli.
  const { resolvedModel, decode } = resolveDecoder(envelope.model ?? device.model);

  let decoded: DecodedTankUplink;
  try {
    const buf = payloadToBuffer(envelope.payload, envelope.payloadEncoding);
    decoded = decode(buf, meta);
  } catch (err) {
    if (err instanceof CorruptedPayloadException) {
      // AC: bozuk paket İZOLE edilir — yalnızca bu uplink düşürülür, presence'a
      // yansımaz, telemetryData olayı üretilmez, hat durmaz.
      logger.warn(
        { deviceId, resolvedModel, reason: err.reason, rawHex: err.rawHex, byteLength: err.byteLength },
        `🛰️ [IOT-302.1] Bozuk LoRaWAN webhook paketi izole edildi: ${err.reason}`
      );
      return { accepted: false, deviceId, reason: 'CORRUPTED_PAYLOAD', detail: err.reason };
    }
    throw err;
  }

  // ARCH-101.4 ile aynı gerekçe (bkz. mqttClient.ts): webhook bir HTTP isteği
  // ama authenticateJWT'den geçmiyor — tenant context'i cihazın KENDİ kayıtlı
  // tenant'ıyla açıkça kuruluyor ki 'telemetryData' aboneleri (socketServer,
  // theftDetectionService) doğru kiracıyı görsün.
  await runWithTenant({ tenantId: device.tenant_id }, async () => {
    ioTEventBus.emit('telemetryData', {
      tenantId: device.tenant_id,
      siteId: device.site_name,
      deviceType: 'lorawan',
      deviceId,
      data: { ...decoded, sensorModel: resolvedModel, source: 'lorawan-webhook' } as Record<string, unknown>,
      timestamp: new Date().toISOString()
    });

    const changed = await redisPool.setDeviceState(deviceId, 'ONLINE');
    if (changed) {
      ioTEventBus.emit('deviceStatusChanged', {
        tenantId: device.tenant_id,
        siteId: device.site_name,
        deviceType: 'lorawan',
        deviceId,
        status: 'ONLINE'
      });
    }
  });

  logger.debug({ deviceId, resolvedModel }, '📩 [IOT-302.1] LoRaWAN webhook uplink\'i çözüldü ve telemetri hattına aktarıldı.');
  return { accepted: true, deviceId, resolvedModel, decoded };
}
