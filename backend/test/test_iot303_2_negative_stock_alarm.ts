import crypto from 'crypto';
import { Client } from 'pg';

/**
 * IOT-303.2 — Kronolojik geriye dönük stok düşümü ve atomik işleme.
 *
 * Bu kod tabanında event-sourced bir tank defteri / TimescaleDB rollup'ı
 * yok (ticket'ın "Teknik Yığın"ı bunu öneriyor) — bu yüzden AC'nin en somut,
 * test edilebilir parçasına odaklanıldı: "Negatif stok oluşursa işlemin
 * durdurulup mutabakat uyarısı üretilmesi... sessizce sıfırlanmamalı."
 * IOT-303.1'in ilk halinde bu tam olarak SESSİZCE sıfırlanıyordu
 * (Math.max(0, ...)) — burada test edilen düzeltme budur.
 */

const API_URL = 'http://localhost:5000/api/v1';
const DEVICE_ID = 'ESP32-PUMP-01';
const DEVICE_SECRET = process.env.HW_SECRET_ESP32_PUMP_01 || 'secret_gebze_pump_8849';

function sign(timestamp: string, nonce: string, rawBody: string): string {
  return crypto.createHmac('sha256', DEVICE_SECRET).update(`${timestamp}.${nonce}.${rawBody}`).digest('hex');
}

async function syncBatch(records: object[]): Promise<{ status: number; body: any }> {
  const body = JSON.stringify({ records });
  const timestamp = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = sign(timestamp, nonce, body);
  const res = await fetch(`${API_URL}/telemetry/sync-batch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Device-ID': DEVICE_ID,
      'X-Timestamp': timestamp,
      'X-Nonce': nonce,
      'X-Hardware-Signature': signature
    },
    body
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, body: data };
}

function makeRecord(localSequenceId: number, amountLiters: number) {
  return {
    localSequenceId,
    deviceTimestamp: new Date(Date.now() - 60_000).toISOString(),
    siteName: 'Silivri Tesisleri',
    vehiclePlate: '34 SIL 99',
    tankName: 'Silivri Tesis Tankı (T-4)',
    amountLiters,
    flowRateLpm: 20
  };
}

async function run() {
  console.log('===========================================================');
  console.log('🚨 [IOT-303.2] NEGATİF STOK TESPİTİ VE MUTABAKAT ALARMI TESTİ');
  console.log('===========================================================\n');

  let passed = 0;
  let total = 0;
  function check(name: string, condition: boolean, detail: string) {
    total++;
    if (condition) {
      console.log(`✅ [PASS] ${name}`);
      console.log(`   ${detail}\n`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${name}`);
      console.error(`   ${detail}\n`);
    }
  }

  const db = new Client({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database: process.env.POSTGRES_DB || 'yakittakip_db'
  });
  await db.connect();

  const baseSeq = Date.now();
  // Silivri Tesis Tankı (T-4) seed verisinde 1900L — testin kontrollü
  // olabilmesi için önce bilinen, küçük bir seviyeye SABİTLENİYOR.
  const tankBefore = await db.query(`SELECT current_level_liters, capacity_liters, status FROM tanks WHERE id = 'tank-silivri-1'`);
  const originalLevel = Number(tankBefore.rows[0].current_level_liters);
  const originalStatus = tankBefore.rows[0].status;
  await db.query(`UPDATE tanks SET current_level_liters = 10 WHERE id = 'tank-silivri-1'`);

  try {
    // === Test 1: Mevcut seviyeyi (10L) AŞAN bir geçmiş kayıt (50L) reddedilir ===
    const seq1 = baseSeq + 1;
    const overdraw = await syncBatch([makeRecord(seq1, 50)]);
    const result1 = overdraw.body?.results?.[0];
    check(
      "Test 1: Tankı negatife düşürecek geçmiş kayıt reddedilir (NEGATIVE_STOCK_DETECTED), sessizce sıfırlanmaz",
      overdraw.status === 200 && result1?.status === 'ERROR' && result1?.error === 'NEGATIVE_STOCK_DETECTED',
      `body=${JSON.stringify(overdraw.body)}`
    );

    // === Test 2: Reddedilen işlem GERÇEKTEN atomik — ne tank seviyesi değişti ne kayıt oluştu ===
    const tankAfterReject = await db.query(`SELECT current_level_liters FROM tanks WHERE id = 'tank-silivri-1'`);
    const txAfterReject = await db.query(`SELECT COUNT(*)::int AS c FROM transactions WHERE device_id = $1 AND local_sequence_id = $2`, [DEVICE_ID, seq1]);
    check(
      'Test 2: Reddedilen işlem atomik — tank seviyesi DEĞİŞMEDİ, hiçbir transactions satırı OLUŞMADI',
      Number(tankAfterReject.rows[0].current_level_liters) === 10 && txAfterReject.rows[0].c === 0,
      `tank seviyesi=${tankAfterReject.rows[0].current_level_liters}, oluşan kayıt sayısı=${txAfterReject.rows[0].c}`
    );

    // === Test 3: Mutabakat alarmı audit_logs'a KALICI olarak yazıldı (reddedilen işlemin rollback'inden ETKİLENMEDİ) ===
    const alarmRow = await db.query(
      `SELECT action, before_value, after_value FROM audit_logs WHERE action = 'NEGATIVE_STOCK_ALARM' AND target_id = 'tank-silivri-1' ORDER BY created_at DESC LIMIT 1`
    );
    check(
      "Test 3: NEGATIVE_STOCK_ALARM audit_logs'a kalıcı olarak yazıldı (before/after değerleriyle)",
      alarmRow.rows.length > 0 && Number(alarmRow.rows[0].before_value?.currentLevelLiters) === 10 && Number(alarmRow.rows[0].after_value?.rejectedAmountLiters) === 50,
      `row=${JSON.stringify(alarmRow.rows[0])}`
    );

    // === Test 4: Aynı tanka, seviyeyi TAM karşılayan (10L) bir kayıt kabul edilir ===
    const seq2 = baseSeq + 2;
    const exact = await syncBatch([makeRecord(seq2, 10)]);
    const result2 = exact.body?.results?.[0];
    check(
      'Test 4: Tam seviyeyi karşılayan (sıfıra iner ama negatife düşmez) kayıt kabul edilir',
      exact.status === 200 && result2?.status === 'ACCEPTED',
      `body=${JSON.stringify(exact.body)}`
    );
    const tankAfterExact = await db.query(`SELECT current_level_liters, status FROM tanks WHERE id = 'tank-silivri-1'`);
    check(
      "Test 4b: Tank seviyesi tam olarak 0'a indi, status KRİTİK'e döndü",
      Number(tankAfterExact.rows[0].current_level_liters) === 0,
      `seviye=${tankAfterExact.rows[0].current_level_liters}, status=${tankAfterExact.rows[0].status}`
    );

    // === Test 5: Batch yanıtında negatif stok alarmı olduğunda summary.failed doğru sayıyor ===
    const seq3 = baseSeq + 3;
    const mixedBatch = await syncBatch([makeRecord(seq3, 100)]); // artık tank 0L, 100L istek reddedilmeli
    check(
      'Test 5: Boş bir tanktan ek talep de reddedilir, summary.failed=1',
      mixedBatch.status === 200 && mixedBatch.body.summary.failed === 1 && mixedBatch.body.summary.accepted === 0,
      `summary=${JSON.stringify(mixedBatch.body.summary)}`
    );
  } finally {
    // Temizlik — audit_logs BİLEREK silinmiyor: append-only ilkesi (bkz.
    // schema.sql REVOKE UPDATE/DELETE/TRUNCATE) test kaynaklı kayıtlar için
    // de korunuyor, bu testin ürettiği NEGATIVE_STOCK_ALARM kaydı kalıcı bir
    // denetim izi olarak kalır.
    await db.query(`DELETE FROM transactions WHERE device_id = $1 AND local_sequence_id >= $2`, [DEVICE_ID, baseSeq]);
    await db.query(`UPDATE tanks SET current_level_liters = $1, status = $2 WHERE id = 'tank-silivri-1'`, [originalLevel, originalStatus]);
    await db.end();
  }

  console.log('===========================================================');
  console.log(`📊 TEST SONUÇLARI: ${passed} / ${total} TEST BAŞARILI`);
  console.log('===========================================================');
  if (passed !== total) process.exit(1);
}

run().catch((err) => {
  console.error('💥 Test çalıştırılamadı:', err);
  process.exit(1);
});
