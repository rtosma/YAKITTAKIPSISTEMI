import crypto from 'crypto';
import { Client } from 'pg';

/**
 * IOT-303.1 — Çevrimdışı toplu senkronizasyon (sync-batch) testi.
 *
 * Kapsanan AC'ler: (device_id, localSequenceId) ile mükerrer önleme, kayıt
 * bazlı kabul/atla/hata yanıtı, 1000 kayıt < 30sn, kısmen bozuk batch.
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

function makeRecord(localSequenceId: number, overrides: Partial<Record<string, any>> = {}) {
  return {
    localSequenceId,
    // Sabit bir geçmiş an — sıralamayı özel olarak test eden Test 7 kendi
    // deviceTimestamp'ini explicit override eder, diğerleri bu değerle ilgilenmez.
    deviceTimestamp: new Date(Date.now() - 60_000).toISOString(),
    siteName: 'Gebze Ana Şantiye',
    vehiclePlate: '34 CTP 82',
    tankName: 'Gebze Ana Tank (T-1)',
    amountLiters: 5,
    flowRateLpm: 20,
    ...overrides
  };
}

async function run() {
  console.log('===========================================================');
  console.log('📦 [IOT-303.1] ÇEVRİMDIŞI TOPLU SENKRONİZASYON (SYNC-BATCH) TESTİ');
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

  const baseSeq = Date.now(); // her koşuda benzersiz localSequenceId aralığı
  const tankBefore = await db.query(`SELECT current_level_liters FROM tanks WHERE id = 'tank-gebze-1'`);
  const levelBefore = Number(tankBefore.rows[0].current_level_liters);

  try {
    // === Test 1: Boş kayıt dizisi reddedilir (Zod min(1)) ===
    const empty = await syncBatch([]);
    check('Test 1: Boş records dizisi reddedilir', empty.status === 400, `status=${empty.status}`);

    // === Test 2: 3 kayıtlık normal bir batch — hepsi ACCEPTED ===
    const records3 = [makeRecord(baseSeq + 1), makeRecord(baseSeq + 2), makeRecord(baseSeq + 3)];
    const first = await syncBatch(records3);
    const allAccepted = first.body?.results?.every((r: any) => r.status === 'ACCEPTED');
    check(
      'Test 2: 3 kayıtlık batch — hepsi ACCEPTED, summary doğru',
      first.status === 200 && allAccepted && first.body.summary.accepted === 3 && first.body.summary.totalReceived === 3,
      `status=${first.status}, summary=${JSON.stringify(first.body.summary)}`
    );

    // === Test 3: Tank seviyesi gerçekten 15L (3x5L) düştü ===
    const tankAfterFirst = await db.query(`SELECT current_level_liters FROM tanks WHERE id = 'tank-gebze-1'`);
    const levelAfterFirst = Number(tankAfterFirst.rows[0].current_level_liters);
    check(
      'Test 3: Tank seviyesi 3 kayıt için toplam 15L düştü',
      Math.abs(levelBefore - levelAfterFirst - 15) < 0.01,
      `önce=${levelBefore}, sonra=${levelAfterFirst}`
    );

    // === Test 4: AYNI batch TEKRAR gönderilir — hepsi DUPLICATE_SKIPPED, tank BİR DAHA düşmez ===
    const resend = await syncBatch(records3);
    const allDuplicate = resend.body?.results?.every((r: any) => r.status === 'DUPLICATE_SKIPPED');
    check(
      'Test 4: Aynı batch tekrar gönderilince hepsi DUPLICATE_SKIPPED',
      resend.status === 200 && allDuplicate && resend.body.summary.duplicateSkipped === 3 && resend.body.summary.accepted === 0,
      `summary=${JSON.stringify(resend.body.summary)}`
    );
    const tankAfterResend = await db.query(`SELECT current_level_liters FROM tanks WHERE id = 'tank-gebze-1'`);
    check(
      'Test 4b: Tekrar gönderim tank seviyesini BİR DAHA düşürmedi',
      Math.abs(Number(tankAfterResend.rows[0].current_level_liters) - levelAfterFirst) < 0.01,
      `seviye: ${tankAfterResend.rows[0].current_level_liters}`
    );

    // === Test 5: Kısmen bozuk batch — biri var olmayan bir tank, diğerleri geçerli ===
    const mixedSeqA = baseSeq + 100;
    const mixedSeqB = baseSeq + 101;
    const mixed = await syncBatch([
      makeRecord(mixedSeqA),
      makeRecord(mixedSeqB, { tankName: 'Hiç Var Olmayan Tank XYZ' })
    ]);
    const okResult = mixed.body?.results?.find((r: any) => r.localSequenceId === mixedSeqA);
    const badResult = mixed.body?.results?.find((r: any) => r.localSequenceId === mixedSeqB);
    check(
      'Test 5: Kısmen bozuk batch — geçerli kayıt ACCEPTED, geçersiz kayıt ERROR (diğerini etkilemiyor)',
      mixed.status === 200 && okResult?.status === 'ACCEPTED' && badResult?.status === 'ERROR' && badResult?.error === 'TANK_NOT_FOUND',
      `summary=${JSON.stringify(mixed.body.summary)}, okResult=${JSON.stringify(okResult)}, badResult=${JSON.stringify(badResult)}`
    );

    // === Test 6: 1000 kayıtlık batch < 30sn işlenir ===
    const bigBatchSeqStart = baseSeq + 10_000;
    const bigRecords = Array.from({ length: 1000 }, (_, i) => makeRecord(bigBatchSeqStart + i, { amountLiters: 0.01 }));
    const bigStart = Date.now();
    const bigResult = await syncBatch(bigRecords);
    const bigElapsedMs = Date.now() - bigStart;
    check(
      'Test 6: 1000 kayıtlık batch 30 saniyenin altında ve hepsi ACCEPTED işlendi',
      bigResult.status === 200 && bigElapsedMs < 30_000 && bigResult.body.summary.accepted === 1000,
      `süre=${bigElapsedMs}ms, summary=${JSON.stringify(bigResult.body.summary)}`
    );

    // === Test 7: Kronolojik sıralama — kayıtlar deviceTimestamp'e göre SIRALI uygulanıyor mu? ===
    // (Ters sırada gönderilen 2 kayıt, DB'de created_at'i deviceTimestamp'e eşit olmalı — sıralamanın
    // kendisi zaten INSERT edilen created_at değerinden doğrulanabilir.)
    const chronoOld = baseSeq + 200;
    const chronoNew = baseSeq + 201;
    const oldTs = new Date(Date.now() - 100_000).toISOString();
    const newTs = new Date(Date.now() - 50_000).toISOString();
    // Kasıtlı olarak TERS sırada gönderiliyor (yeni önce, eski sonra).
    await syncBatch([makeRecord(chronoNew, { deviceTimestamp: newTs }), makeRecord(chronoOld, { deviceTimestamp: oldTs })]);
    const chronoRows = await db.query(
      `SELECT local_sequence_id, created_at FROM transactions WHERE device_id = $1 AND local_sequence_id IN ($2, $3) ORDER BY created_at ASC`,
      [DEVICE_ID, chronoOld, chronoNew]
    );
    check(
      'Test 7: Ters sırada gönderilen kayıtlar deviceTimestamp\'e göre doğru kronolojik sırada kaydedildi',
      chronoRows.rows.length === 2 && Number(chronoRows.rows[0].local_sequence_id) === chronoOld,
      `sıra: ${chronoRows.rows.map((r: any) => r.local_sequence_id).join(', ')}`
    );

    // === Test 8: verification_status varsayılan olarak DOĞRULAMA_BEKLIYOR (canlı yetkilendirmeden geçmedi) ===
    const verifyStatusRow = await db.query(
      `SELECT verification_status, type FROM transactions WHERE device_id = $1 AND local_sequence_id = $2`,
      [DEVICE_ID, mixedSeqA]
    );
    check(
      "Test 8: sync-batch kaydı verification_status='DOĞRULAMA_BEKLIYOR' ve type='Çevrimdışı Senkron' ile işaretlendi",
      verifyStatusRow.rows[0]?.verification_status === 'DOĞRULAMA_BEKLIYOR' && verifyStatusRow.rows[0]?.type === 'Çevrimdışı Senkron',
      `row=${JSON.stringify(verifyStatusRow.rows[0])}`
    );
  } finally {
    // Temizlik
    await db.query(`DELETE FROM transactions WHERE device_id = $1 AND local_sequence_id >= $2`, [DEVICE_ID, baseSeq]);
    await db.query(`UPDATE tanks SET current_level_liters = $1, status = 'GÜVENLİ' WHERE id = 'tank-gebze-1'`, [levelBefore]);
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
