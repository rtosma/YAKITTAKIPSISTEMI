/**
 * IOT-302 — Binary LoRaWAN Payload Decoder (saf Node.js Buffer parser).
 *
 * ChirpStack / TTN üzerinden gelen ultrasonik yakıt tankı probu uplink'lerini
 * (hex string ya da Buffer) yüksek hızda JSON'a çözer. Hiçbir DB/route/IO
 * bağımlılığı yok — tamamen saf ve senkron, bu yüzden mikro-saniyeler
 * mertebesinde çalışır (bkz. test_iot302_lorawan_decoder.ts performans testi).
 *
 * ── Uplink payload düzeni (sürüm 1, TANK_LEVEL) — sabit 15 bayt ──────────────
 *   Ofset  Alan               Okuma            Anlam
 *   0      protocolVersion    readUInt8        0x01
 *   1      messageType        readUInt8        0x01 = TANK_LEVEL
 *   2-3    distanceMm         readUInt16BE     probdan yakıt yüzeyine mesafe (mm)
 *   4-5    temperatureCentiC  readInt16BE      sıcaklık, 0.01 °C (işaretli; -327.68..327.67)
 *   6-9    batteryVoltage     readFloatLE      batarya gerilimi (V, IEEE-754 32-bit LE)
 *   10     statusFlags        readUInt8        bit0 lowBattery, bit1 sensorFault, bit2 tiltAlarm
 *   11-14  uplinkCounter      readUInt32BE     cihaz frame sayacı (fCnt) — dedup/boşluk tespiti
 *
 * Sensör alanları big-endian (ağ bayt sırası, `readInt16BE`/`readUInt16BE`);
 * batarya gerilimi ise cihaz firmware'inin doğal olarak yazdığı little-endian
 * IEEE-754 float (`readFloatLE`) — ticket'ın "Teknik Yığın" alanında bu iki
 * Buffer API'si birlikte belirtildiği için düzen bilerek bu şekilde.
 *
 * Radyo metadata (rssi/snr) cihaz payload'ında DEĞİL, ağ sunucusunun (ChirpStack/
 * TTN) uplink zarfında gelir — `decodeLoRaWANPayload`'a `meta` ile geçilirse
 * çıktıya birleştirilir.
 */

export const LORAWAN_PROTOCOL_VERSION = 1;
export const TANK_UPLINK_LENGTH_BYTES = 15;

export const MESSAGE_TYPES: Record<number, string> = {
  0x01: 'TANK_LEVEL'
};

const STATUS_FLAG_LOW_BATTERY = 0b0000_0001;
const STATUS_FLAG_SENSOR_FAULT = 0b0000_0010;
const STATUS_FLAG_TILT_ALARM = 0b0000_0100;

// Fiziksel makullük sınırları — bunların dışındaki değerler "çözüldü ama saçma"
// demektir ve bozuk paketle aynı kovaya konur (AC: bozuk/eksik bayt izole edilmeli).
const MAX_PLAUSIBLE_DISTANCE_MM = 20_000; // 20 m'lik tank probu menzili üst sınırı
const MIN_PLAUSIBLE_TEMP_C = -60;
const MAX_PLAUSIBLE_TEMP_C = 90;
const MIN_PLAUSIBLE_BATTERY_V = 0;
const MAX_PLAUSIBLE_BATTERY_V = 20;

export interface LoRaWANRadioMeta {
  rssi?: number;
  snr?: number;
  devEui?: string;
  fPort?: number;
  gatewayId?: string;
}

export interface DecodedTankUplink {
  protocolVersion: number;
  messageType: string;
  distanceMm: number;
  temperatureC: number;
  batteryVoltage: number;
  lowBattery: boolean;
  sensorFault: boolean;
  tiltAlarm: boolean;
  uplinkCounter: number;
  rssi?: number;
  snr?: number;
  devEui?: string;
  fPort?: number;
  gatewayId?: string;
  decodedAt: string;
}

/**
 * IOT-302 AC — bozuk/eksik bayt içeren paketler bu istisna ile ayrıştırılıp
 * izole edilir. Çağıran (mqttClient.ts) bunu yakalayıp SADECE o paketi düşürür;
 * aynı akıştaki diğer cihazların paketleri etkilenmez.
 */
export class CorruptedPayloadException extends Error {
  public readonly reason: string;
  public readonly rawHex: string;
  public readonly byteLength: number;

  constructor(reason: string, rawHex: string, byteLength: number) {
    super(`CorruptedPayloadException: ${reason}`);
    this.name = 'CorruptedPayloadException';
    this.reason = reason;
    this.rawHex = rawHex;
    this.byteLength = byteLength;
    Object.setPrototypeOf(this, CorruptedPayloadException.prototype);
  }
}

const HEX_RE = /^[0-9a-fA-F]+$/;

/** Hex string ya da Buffer girdisini doğrulanmış bir Buffer'a çevirir. */
function toBuffer(input: string | Buffer): { buf: Buffer; rawHex: string } {
  if (Buffer.isBuffer(input)) {
    return { buf: input, rawHex: input.toString('hex') };
  }
  if (typeof input !== 'string') {
    throw new CorruptedPayloadException('girdi bir hex string veya Buffer olmalı', String(input), 0);
  }
  const hex = input.trim().replace(/^0x/i, '');
  if (hex.length === 0) {
    throw new CorruptedPayloadException('boş payload', hex, 0);
  }
  if (hex.length % 2 !== 0) {
    throw new CorruptedPayloadException(`tek sayıda hex karakter (${hex.length}) — eksik bayt`, hex, Math.ceil(hex.length / 2));
  }
  if (!HEX_RE.test(hex)) {
    throw new CorruptedPayloadException('hex olmayan karakter içeriyor', hex, hex.length / 2);
  }
  return { buf: Buffer.from(hex, 'hex'), rawHex: hex.toLowerCase() };
}

/**
 * Bir LoRaWAN uplink payload'ını (hex string ya da Buffer) çözer.
 * Bozuk/eksik/mantıksız her durumda `CorruptedPayloadException` fırlatır.
 */
export function decodeLoRaWANPayload(input: string | Buffer, meta?: LoRaWANRadioMeta): DecodedTankUplink {
  const { buf, rawHex } = toBuffer(input);

  if (buf.length !== TANK_UPLINK_LENGTH_BYTES) {
    throw new CorruptedPayloadException(
      `beklenen ${TANK_UPLINK_LENGTH_BYTES} bayt, gelen ${buf.length} bayt`,
      rawHex,
      buf.length
    );
  }

  const protocolVersion = buf.readUInt8(0);
  if (protocolVersion !== LORAWAN_PROTOCOL_VERSION) {
    throw new CorruptedPayloadException(`bilinmeyen protokol sürümü 0x${protocolVersion.toString(16)}`, rawHex, buf.length);
  }

  const messageTypeByte = buf.readUInt8(1);
  const messageType = MESSAGE_TYPES[messageTypeByte];
  if (!messageType) {
    throw new CorruptedPayloadException(`bilinmeyen mesaj tipi 0x${messageTypeByte.toString(16)}`, rawHex, buf.length);
  }

  const distanceMm = buf.readUInt16BE(2);
  const temperatureC = buf.readInt16BE(4) / 100;
  const batteryVoltage = buf.readFloatLE(6);
  const statusFlags = buf.readUInt8(10);
  const uplinkCounter = buf.readUInt32BE(11);

  // "Çözüldü ama fiziksel olarak imkânsız" — bozuk baytların sessizce geçmesini önler.
  if (!Number.isFinite(batteryVoltage) || batteryVoltage < MIN_PLAUSIBLE_BATTERY_V || batteryVoltage > MAX_PLAUSIBLE_BATTERY_V) {
    throw new CorruptedPayloadException(`batarya gerilimi aralık dışı/NaN (${batteryVoltage})`, rawHex, buf.length);
  }
  if (distanceMm > MAX_PLAUSIBLE_DISTANCE_MM) {
    throw new CorruptedPayloadException(`ultrasonik mesafe aralık dışı (${distanceMm} mm)`, rawHex, buf.length);
  }
  if (temperatureC < MIN_PLAUSIBLE_TEMP_C || temperatureC > MAX_PLAUSIBLE_TEMP_C) {
    throw new CorruptedPayloadException(`sıcaklık aralık dışı (${temperatureC} °C)`, rawHex, buf.length);
  }

  const decoded: DecodedTankUplink = {
    protocolVersion,
    messageType,
    distanceMm,
    temperatureC: Number(temperatureC.toFixed(2)),
    batteryVoltage: Number(batteryVoltage.toFixed(3)),
    lowBattery: (statusFlags & STATUS_FLAG_LOW_BATTERY) !== 0,
    sensorFault: (statusFlags & STATUS_FLAG_SENSOR_FAULT) !== 0,
    tiltAlarm: (statusFlags & STATUS_FLAG_TILT_ALARM) !== 0,
    uplinkCounter,
    decodedAt: new Date().toISOString()
  };

  if (meta) {
    if (typeof meta.rssi === 'number' && Number.isFinite(meta.rssi)) decoded.rssi = meta.rssi;
    if (typeof meta.snr === 'number' && Number.isFinite(meta.snr)) decoded.snr = meta.snr;
    if (meta.devEui) decoded.devEui = meta.devEui;
    if (typeof meta.fPort === 'number') decoded.fPort = meta.fPort;
    if (meta.gatewayId) decoded.gatewayId = meta.gatewayId;
  }

  return decoded;
}

/**
 * Test/simülasyon yardımcıları — geçerli bir uplink payload'ını hex olarak
 * kodlar. Üretim kodu bunu kullanmaz; yalnızca test_iot302 ve manuel MQTT
 * yayınları için.
 */
export function encodeTankUplinkHex(fields: {
  distanceMm: number;
  temperatureC: number;
  batteryVoltage: number;
  lowBattery?: boolean;
  sensorFault?: boolean;
  tiltAlarm?: boolean;
  uplinkCounter: number;
  messageType?: number;
  protocolVersion?: number;
}): string {
  const buf = Buffer.alloc(TANK_UPLINK_LENGTH_BYTES);
  buf.writeUInt8(fields.protocolVersion ?? LORAWAN_PROTOCOL_VERSION, 0);
  buf.writeUInt8(fields.messageType ?? 0x01, 1);
  buf.writeUInt16BE(Math.round(fields.distanceMm), 2);
  buf.writeInt16BE(Math.round(fields.temperatureC * 100), 4);
  buf.writeFloatLE(fields.batteryVoltage, 6);
  const flags =
    (fields.lowBattery ? STATUS_FLAG_LOW_BATTERY : 0) |
    (fields.sensorFault ? STATUS_FLAG_SENSOR_FAULT : 0) |
    (fields.tiltAlarm ? STATUS_FLAG_TILT_ALARM : 0);
  buf.writeUInt8(flags, 10);
  buf.writeUInt32BE(fields.uplinkCounter, 11);
  return buf.toString('hex');
}
