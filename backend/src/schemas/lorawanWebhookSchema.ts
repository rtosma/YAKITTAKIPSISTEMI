import { z } from 'zod';

/**
 * IOT-302.1 — POST /api/v1/lorawan/uplink gövde şeması.
 *
 * ChirpStack v4 ve TTN v3 uplink event gövdeleri BİRBİRİNDEN ÇOK FARKLI ve
 * derin iç içe. İntegratörü tek bir "normalize" şekle zorlamak yerine, şema
 * `z.preprocess` ile üç durumu da (ChirpStack v4 zarfı, TTN v3 zarfı, zaten
 * düz normalize gövde) tanıyıp aşağıdaki DÜZ şekle indirger:
 *
 *   {
 *     deviceId: string,          // ağ sunucusunda platform device_id'sine set edilmeli
 *     payload: string,           // hex ya da base64
 *     payloadEncoding?: 'hex'|'base64',   // yoksa otomatik saptanır
 *     model?: string,            // decoder registry seçimi (hardware_devices.model'i ezmez, ek seçenek)
 *     rssi?: number, snr?: number,
 *     fCnt?: number, fPort?: number, devEui?: string, gatewayId?: string
 *   }
 *
 * Kapsam sapması: cihaz kimliği DevEUI ile DEĞİL, ağ sunucusundaki cihaz
 * adının platform `device_id`'sine eşitlenmesiyle çözülür (üretimde bir
 * `dev_eui` eşleme kolonu daha sağlam olurdu — ayrı iş).
 */

function firstOf(...vals: unknown[]): unknown {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function normalizeEnvelope(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const b = raw as Record<string, any>;

  // ChirpStack v4 uplink event
  if (b.deviceInfo && typeof b.deviceInfo === 'object') {
    const rx = Array.isArray(b.rxInfo) ? b.rxInfo[0] ?? {} : {};
    return {
      deviceId: firstOf(b.deviceInfo.deviceName, b.deviceName, b.deviceId),
      payload: firstOf(b.data, b.payloadHex, b.frmPayload),
      payloadEncoding: b.data ? 'base64' : undefined,
      model: firstOf(b.model, b.deviceInfo.deviceProfileName),
      rssi: typeof rx.rssi === 'number' ? rx.rssi : undefined,
      snr: typeof (rx.snr ?? rx.loraSnr) === 'number' ? (rx.snr ?? rx.loraSnr) : undefined,
      fCnt: typeof b.fCnt === 'number' ? b.fCnt : undefined,
      fPort: typeof b.fPort === 'number' ? b.fPort : undefined,
      devEui: firstOf(b.deviceInfo.devEui, b.devEui),
      gatewayId: firstOf(rx.gatewayId, b.gatewayId)
    };
  }

  // TTN v3 uplink message
  if (b.end_device_ids && b.uplink_message) {
    const um = b.uplink_message as Record<string, any>;
    const md = Array.isArray(um.rx_metadata) ? um.rx_metadata[0] ?? {} : {};
    return {
      deviceId: firstOf(b.end_device_ids.device_id, b.deviceId),
      payload: firstOf(um.frm_payload, b.payload),
      payloadEncoding: um.frm_payload ? 'base64' : undefined,
      model: firstOf(b.model, um.version_ids?.model_id),
      rssi: typeof md.rssi === 'number' ? md.rssi : undefined,
      snr: typeof md.snr === 'number' ? md.snr : undefined,
      fCnt: typeof um.f_cnt === 'number' ? um.f_cnt : undefined,
      fPort: typeof um.f_port === 'number' ? um.f_port : undefined,
      devEui: firstOf(b.end_device_ids.dev_eui, b.devEui),
      gatewayId: firstOf(md.gateway_ids?.gateway_id, b.gatewayId)
    };
  }

  // Zaten düz normalize gövde — payloadHex/data eş anlamlılarını topla
  return {
    deviceId: firstOf(b.deviceId, b.deviceName),
    payload: firstOf(b.payload, b.payloadHex, b.data, b.frmPayload),
    payloadEncoding: firstOf(b.payloadEncoding, b.data && !b.payload && !b.payloadHex ? 'base64' : undefined),
    model: b.model,
    rssi: typeof b.rssi === 'number' ? b.rssi : undefined,
    snr: typeof b.snr === 'number' ? b.snr : undefined,
    fCnt: typeof b.fCnt === 'number' ? b.fCnt : undefined,
    fPort: typeof b.fPort === 'number' ? b.fPort : undefined,
    devEui: b.devEui,
    gatewayId: b.gatewayId
  };
}

export const lorawanUplinkSchema = z.preprocess(
  normalizeEnvelope,
  z.object({
    deviceId: z.string({ message: 'deviceId zorunludur (ağ sunucusundaki cihaz adı platform device_id\'sine eşitlenmeli).' }).min(1).max(64),
    payload: z.string({ message: 'payload (hex veya base64) zorunludur.' }).min(2).max(2048),
    payloadEncoding: z.enum(['hex', 'base64']).optional(),
    model: z.string().min(1).max(128).optional(),
    rssi: z.number().finite().optional(),
    snr: z.number().finite().optional(),
    fCnt: z.number().int().nonnegative().optional(),
    fPort: z.number().int().nonnegative().optional(),
    devEui: z.string().min(1).max(32).optional(),
    gatewayId: z.string().min(1).max(64).optional()
  })
);

export type LoRaWANUplinkDTO = z.infer<typeof lorawanUplinkSchema>;
