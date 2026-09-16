import { parentPort } from 'worker_threads';
import { decodeLoRaWANPayload, CorruptedPayloadException, LoRaWANRadioMeta } from './lorawanDecoder';

/**
 * IOT-301.3 — MQTT telemetri payload'ının (JSON parse + LoRaWAN binary
 * decode) worker thread içinde çalışan kısmı. Bu dosya `payloadValidationPool.ts`
 * tarafından `new Worker()` ile ayrı bir thread'de başlatılır; ana thread'le
 * yalnızca `postMessage`/`on('message')` ile haberleşir, hiçbir paylaşılan
 * durumu (DB bağlantısı, Redis, tenant context) yoktur — saf bir hesaplama
 * birimidir. Bkz. payloadValidationPool.ts'teki AC/gerekçe yorumu.
 */

export interface ValidationRequest {
  id: number;
  deviceType: string;
  messageStr: string;
}

export interface ValidationSuccess {
  id: number;
  ok: true;
  data: Record<string, unknown>;
}

export interface ValidationFailure {
  id: number;
  ok: false;
  reason: 'CORRUPTED_LORAWAN' | 'INVALID_JSON' | 'INVALID_SHAPE';
  detail: string;
  rawHex?: string;
  byteLength?: number;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

/**
 * mqttClient.ts'in eski (worker'dan ÖNCEKİ) inline mantığıyla BİREBİR aynı
 * ayrıştırma deseni — yalnızca yürütüldüğü thread değişti. Ek olarak: JSON
 * dalı artık ayrıştırılan değerin düz bir NESNE olduğunu doğruluyor (AC:
 * "payload validation") — önceden `JSON.parse` sonucu hiç şekil kontrolünden
 * geçmeden doğrudan olay veri yoluna (ioTEventBus) gidiyordu.
 */
export function validate(req: ValidationRequest): ValidationResult {
  try {
    if (req.deviceType === 'lorawan') {
      let hexPayload = req.messageStr.trim();
      let meta: LoRaWANRadioMeta | undefined;
      if (hexPayload.startsWith('{')) {
        const env = JSON.parse(hexPayload) as Record<string, any>;
        hexPayload = String(env.data ?? env.payloadHex ?? env.frmPayload ?? '');
        const rx = env.rxInfo ?? env;
        meta = {
          rssi: typeof rx.rssi === 'number' ? rx.rssi : undefined,
          snr: typeof (rx.snr ?? rx.loRaSNR) === 'number' ? (rx.snr ?? rx.loRaSNR) : undefined,
          devEui: env.devEUI ?? env.devEui,
          fPort: typeof env.fPort === 'number' ? env.fPort : undefined,
          gatewayId: env.gatewayId ?? rx.gatewayId
        };
      }
      const data = decodeLoRaWANPayload(hexPayload, meta) as unknown as Record<string, unknown>;
      return { id: req.id, ok: true, data };
    }

    const raw = JSON.parse(req.messageStr);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return {
        id: req.id,
        ok: false,
        reason: 'INVALID_SHAPE',
        detail: `Beklenen JSON nesnesi, alınan: ${Array.isArray(raw) ? 'dizi' : typeof raw}`
      };
    }
    return { id: req.id, ok: true, data: raw as Record<string, unknown> };
  } catch (err) {
    if (err instanceof CorruptedPayloadException) {
      return { id: req.id, ok: false, reason: 'CORRUPTED_LORAWAN', detail: err.reason, rawHex: err.rawHex, byteLength: err.byteLength };
    }
    return { id: req.id, ok: false, reason: 'INVALID_JSON', detail: err instanceof Error ? err.message : String(err) };
  }
}

/* istanbul ignore else -- yalnızca gerçek bir worker_threads içinde çalışırken parentPort dolu olur */
if (parentPort) {
  const port = parentPort;
  port.on('message', (req: ValidationRequest) => {
    port.postMessage(validate(req));
  });
}
