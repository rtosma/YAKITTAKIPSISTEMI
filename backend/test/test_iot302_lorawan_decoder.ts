/**
 * IOT-302 — Binary LoRaWAN Payload Decoder birim testi.
 *
 * Saf fonksiyon testi — Docker/DB/route gerektirmez, doğrudan `tsx` ile çalışır:
 *   npx tsx backend/test/test_iot302_lorawan_decoder.ts
 *
 * Kapsanan Kabul Kriterleri:
 *  - Hexadecimal paketler JSON'a çözülür (ultrasonik mesafe, sıcaklık, batarya,
 *    RSSI/SNR, durum bayrakları, uplink sayacı).
 *  - Bozuk/eksik bayt içeren paketler `CorruptedPayloadException` olarak
 *    ayrıştırılır (izole edilir — çözüm akışını düşürmez).
 *  - Performans: on binlerce paket mikro-saniyeler mertebesinde çözülür.
 */

import {
  decodeLoRaWANPayload,
  encodeTankUplinkHex,
  CorruptedPayloadException,
  TANK_UPLINK_LENGTH_BYTES
} from '../src/iot/lorawanDecoder';

let passed = 0;
let total = 0;
function check(name: string, condition: boolean, detail = '') {
  total++;
  if (condition) {
    console.log(`✅ [PASS] ${name}${detail ? ` — ${detail}` : ''}`);
    passed++;
  } else {
    console.error(`❌ [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function expectCorrupted(name: string, fn: () => unknown, reasonSubstr?: string) {
  total++;
  try {
    fn();
    console.error(`❌ [FAIL] ${name} — istisna beklendi ama fırlatılmadı`);
  } catch (err) {
    if (err instanceof CorruptedPayloadException && (!reasonSubstr || err.reason.includes(reasonSubstr))) {
      console.log(`✅ [PASS] ${name} — "${err.reason}"`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${name} — yanlış hata: ${(err as Error).message}`);
    }
  }
}

console.log('=====================================================');
console.log('🛰️  [IOT-302] LoRaWAN BINARY PAYLOAD DECODER TESTİ');
console.log('=====================================================\n');

// --- 1. Geçerli paket → doğru JSON ---
const hex1 = encodeTankUplinkHex({
  distanceMm: 1234,
  temperatureC: 23.5,
  batteryVoltage: 3.62,
  lowBattery: false,
  uplinkCounter: 42
});
const d1 = decodeLoRaWANPayload(hex1);
check('1a: mesafe (mm) doğru çözüldü', d1.distanceMm === 1234, `distanceMm=${d1.distanceMm}`);
check('1b: sıcaklık (°C) doğru çözüldü', d1.temperatureC === 23.5, `temperatureC=${d1.temperatureC}`);
check('1c: batarya gerilimi (V, floatLE) doğru çözüldü', Math.abs(d1.batteryVoltage - 3.62) < 0.001, `batteryVoltage=${d1.batteryVoltage}`);
check('1d: uplink sayacı doğru çözüldü', d1.uplinkCounter === 42, `uplinkCounter=${d1.uplinkCounter}`);
check('1e: messageType çözüldü', d1.messageType === 'TANK_LEVEL', d1.messageType);
check('1f: durum bayrakları false', d1.lowBattery === false && d1.sensorFault === false && d1.tiltAlarm === false);
check('1g: decodedAt ISO damgası var', typeof d1.decodedAt === 'string' && d1.decodedAt.includes('T'));

// --- 2. İşaretli negatif sıcaklık (readInt16BE) ---
const d2 = decodeLoRaWANPayload(encodeTankUplinkHex({ distanceMm: 500, temperatureC: -12.75, batteryVoltage: 3.1, uplinkCounter: 1 }));
check('2: negatif sıcaklık (int16BE işaretli) doğru', d2.temperatureC === -12.75, `temperatureC=${d2.temperatureC}`);

// --- 3. Durum bayrakları (bit alanı) ---
const d3 = decodeLoRaWANPayload(encodeTankUplinkHex({
  distanceMm: 800, temperatureC: 20, batteryVoltage: 2.9,
  lowBattery: true, sensorFault: false, tiltAlarm: true, uplinkCounter: 7
}));
check('3: bit alanı ayrıştırma (lowBattery+tiltAlarm set, sensorFault değil)',
  d3.lowBattery === true && d3.tiltAlarm === true && d3.sensorFault === false);

// --- 4. Buffer girdisi (hex string değil) ---
const d4 = decodeLoRaWANPayload(Buffer.from(hex1, 'hex'));
check('4: Buffer girdisi de kabul ediliyor', d4.distanceMm === 1234 && d4.uplinkCounter === 42);

// --- 5. Radyo metadata birleştirme (rssi/snr cihaz payload'ında değil) ---
const d5 = decodeLoRaWANPayload(hex1, { rssi: -95, snr: 7.5, devEui: 'AA11BB22CC33DD44' });
check('5: rxInfo metadata (rssi/snr/devEui) çıktıya birleşti',
  d5.rssi === -95 && d5.snr === 7.5 && d5.devEui === 'AA11BB22CC33DD44');

// --- 6. "0x" öneki ve büyük/küçük harf hex toleransı ---
const d6 = decodeLoRaWANPayload('0x' + hex1.toUpperCase());
check('6: "0x" öneki ve büyük harf hex kabul ediliyor', d6.distanceMm === 1234);

// --- 7..12: BOZUK PAKETLER → CorruptedPayloadException (izolasyon) ---
expectCorrupted('7: tek sayıda hex karakter (eksik bayt)', () => decodeLoRaWANPayload('0101abc'), 'tek sayıda');
expectCorrupted('8: hex olmayan karakter', () => decodeLoRaWANPayload('0101zz33445566778899aabbccdd'), 'hex olmayan');
expectCorrupted('9: çok kısa payload (eksik bayt)', () => decodeLoRaWANPayload('010104d2'), 'bayt');
expectCorrupted('10: çok uzun payload (fazla bayt)', () => decodeLoRaWANPayload(hex1 + 'ffff'), 'bayt');
expectCorrupted('11: bilinmeyen protokol sürümü', () => {
  const b = Buffer.from(hex1, 'hex'); b.writeUInt8(0x09, 0); return decodeLoRaWANPayload(b);
}, 'protokol sürümü');
expectCorrupted('12: bilinmeyen mesaj tipi', () => {
  const b = Buffer.from(hex1, 'hex'); b.writeUInt8(0x7f, 1); return decodeLoRaWANPayload(b);
}, 'mesaj tipi');
expectCorrupted('13: NaN batarya (bozuk float baytları)', () => {
  const b = Buffer.from(hex1, 'hex'); b.writeUInt8(0xff, 6); b.writeUInt8(0xff, 7); b.writeUInt8(0xff, 8); b.writeUInt8(0xff, 9);
  return decodeLoRaWANPayload(b);
}, 'batarya');
expectCorrupted('14: fiziksel olarak imkânsız sıcaklık (aralık dışı)', () => {
  const b = Buffer.from(hex1, 'hex'); b.writeInt16BE(30000, 4); // 300.00 °C
  return decodeLoRaWANPayload(b);
}, 'sıcaklık');
expectCorrupted('15: boş payload', () => decodeLoRaWANPayload(''), 'boş');

// --- 16: İZOLASYON — bozuk bir paket, sonraki geçerli paketin çözümünü etkilemez ---
const stream = [hex1, 'zzzz', encodeTankUplinkHex({ distanceMm: 999, temperatureC: 5, batteryVoltage: 3.0, uplinkCounter: 2 })];
const results: Array<{ ok: boolean }> = [];
for (const pkt of stream) {
  try {
    decodeLoRaWANPayload(pkt);
    results.push({ ok: true });
  } catch (err) {
    results.push({ ok: err instanceof CorruptedPayloadException ? false : false });
  }
}
check('16: bozuk paket izole edildi, akıştaki diğer paketler çözülmeye devam etti',
  results[0].ok === true && results[1].ok === false && results[2].ok === true,
  JSON.stringify(results.map((r) => r.ok)));

// --- 17: Performans — 20.000 paket mikrosaniyeler mertebesinde ---
const perfHex = encodeTankUplinkHex({ distanceMm: 1500, temperatureC: 18.2, batteryVoltage: 3.55, uplinkCounter: 0 });
const N = 20_000;
const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) decodeLoRaWANPayload(perfHex);
const perPacketUs = Number(process.hrtime.bigint() - t0) / 1000 / N;
check('17: paket başına çözüm süresi < 20 µs', perPacketUs < 20, `${perPacketUs.toFixed(2)} µs/paket (${N} paket)`);

check('18: sabit payload uzunluğu 15 bayt', TANK_UPLINK_LENGTH_BYTES === 15);

console.log('\n=====================================================');
console.log(`📊 TEST SONUÇLARI: ${passed} / ${total} BAŞARILI`);
console.log('=====================================================');
if (passed !== total) process.exit(1);
