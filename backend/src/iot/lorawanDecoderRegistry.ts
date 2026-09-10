/**
 * IOT-302.1 — Sensör modeli bazlı decoder registry.
 *
 * Ticket notu: "Endianness sensör üreticisine göre değişir." Tek bir sabit
 * çözücü yerine, cihazın modeline (hardware_devices.model ya da webhook
 * zarfındaki `model` alanı) göre doğru çözücü seçilir. Yeni bir üretici
 * eklemek = buraya bir satır eklemek; çağıran kod (webhook servisi,
 * mqttClient) değişmez.
 *
 * Tüm çözücüler aynı sözleşmeyi paylaşır: hex/Buffer girdi + opsiyonel radyo
 * metadata → DecodedTankUplink; bozuk/eksik/mantıksız girdi →
 * CorruptedPayloadException (izole edilir, akışı durdurmaz).
 */

import {
  decodeLoRaWANPayload,
  type DecodedTankUplink,
  type LoRaWANRadioMeta
} from './lorawanDecoder';

export type SensorDecoder = (input: string | Buffer, meta?: LoRaWANRadioMeta) => DecodedTankUplink;

/** Model kimliği verilmediğinde / tanınmadığında kullanılan çözücü. */
export const DEFAULT_DECODER_MODEL = 'GENERIC-TANK-V1';

/**
 * Model kimliği → çözücü. Anahtarlar büyük harfe normalize edilerek
 * karşılaştırılır (resolveDecoder içinde).
 */
const DECODER_REGISTRY: Record<string, SensorDecoder> = {
  // Referans protokol — sensör alanları big-endian (ağ bayt sırası).
  'GENERIC-TANK-V1': (input, meta) => decodeLoRaWANPayload(input, meta, { byteOrder: 'BE' }),

  // Aynı 15 baytlık düzen ama tüm çok-baytlı sensör alanları little-endian
  // yazan bir üretici ailesi (batteryVoltage yine LE float). "Endianness
  // üreticiye göre değişir" notunun somut karşılığı.
  'ACME-ULTRASONIC-LE': (input, meta) => decodeLoRaWANPayload(input, meta, { byteOrder: 'LE' })
};

export function isKnownDecoderModel(model: string | null | undefined): boolean {
  return !!model && Object.prototype.hasOwnProperty.call(DECODER_REGISTRY, model.trim().toUpperCase());
}

/**
 * Bir model kimliğine karşılık gelen çözücüyü döndürür. Model verilmemişse
 * ya da tanınmıyorsa GENERIC-TANK-V1'e düşer (sessizce — bilinmeyen bir
 * model, "veriyi hiç işleme" demek değil; en yaygın düzenle denenir).
 * `resolvedModel` çağıranın loglayabilmesi/telemetriye ekleyebilmesi için
 * gerçekten kullanılan modeli belirtir.
 */
export function resolveDecoder(model?: string | null): { resolvedModel: string; decode: SensorDecoder } {
  const key = model?.trim().toUpperCase();
  if (key && DECODER_REGISTRY[key]) {
    return { resolvedModel: key, decode: DECODER_REGISTRY[key] };
  }
  return { resolvedModel: DEFAULT_DECODER_MODEL, decode: DECODER_REGISTRY[DEFAULT_DECODER_MODEL] };
}

export function listDecoderModels(): string[] {
  return Object.keys(DECODER_REGISTRY);
}
