import crypto from 'crypto';
import { Client } from 'pg';

/**
 * FUEL-401 — RFID-Tetiklemeli Otomatik İkmal Oturumu (request-auth →
 * heartbeat → finalize) uçtan uca testi. Gerçek Docker Compose (Postgres +
 * Redis) üzerinden, testHardwareAuth.ts'teki AYNI HMAC imzalama deseniyle.
 */

// CI'da (ci-cd.yml) backend bare bir process olarak 5000 portunda ayağa
// kalkar — diğer tüm test dosyalarıyla (testHardwareAuth.ts, test_auth201.ts
// vb.) AYNI sabit URL. Yerel docker-compose ortamında (OPS-1102: host'a 5000
// yayınlanmıyor, bkz. docker-compose.yml) bu dosyayı elle çalıştırırken ya
// `docker run --network container:<backend>` ile aynı ağ isim alanını
// paylaşan bir konteynerden, ya da geçici bir port yönlendirmesiyle çalıştırın.
const API_URL = 'http://localhost:5000/api/v1';
const DEVICE_ID = 'ESP32-PUMP-01';
const DEVICE_SECRET = process.env.HW_SECRET_ESP32_PUMP_01 || 'secret_gebze_pump_8849';

function generateNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

function sign(timestamp: string, nonce: string, rawBody: string): string {
  return crypto.createHmac('sha256', DEVICE_SECRET).update(`${timestamp}.${nonce}.${rawBody}`).digest('hex');
}

async function hwPost(path: string, body: object): Promise<{ status: number; data: any }> {
  const rawBody = JSON.stringify(body);
  const timestamp = Date.now().toString();
  const nonce = generateNonce();
  const signature = sign(timestamp, nonce, rawBody);
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Device-ID': DEVICE_ID,
      'X-Timestamp': timestamp,
      'X-Nonce': nonce,
      'X-Hardware-Signature': signature
    },
    body: rawBody
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  console.log('===========================================================');
  console.log('⛽ [FUEL-401] RFID DİSPENSE SESSION STATE MACHINE TESTİ');
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

  // --- Ön koşul: veh-1'i drv-1'e ata (seed veride hiçbir araç önceden
  // atanmamış), test sonunda geri al. ---
  await db.query(`UPDATE vehicles SET assigned_driver_name = 'Ahmet Yılmaz' WHERE id = 'veh-1'`);
  await db.query(`DELETE FROM transactions WHERE idempotency_key LIKE 'fuel401-test-%'`);
  const tankBefore = await db.query(`SELECT current_level_liters FROM tanks WHERE id = 'tank-gebze-1'`);
  const levelBefore = Number(tankBefore.rows[0].current_level_liters);

  try {
    // === Test 1: Bilinmeyen kart → CARD_UNKNOWN ===
    const unknownCard = await hwPost('/dispense/request-auth', { rfidCardId: 'CARD-NOPE', tankName: 'Gebze Ana Tank (T-1)' });
    check(
      'Test 1: Bilinmeyen RFID kartı reddedilir (CARD_UNKNOWN)',
      unknownCard.status === 403 && unknownCard.data?.details?.error === 'CARD_UNKNOWN',
      `status=${unknownCard.status}, body=${JSON.stringify(unknownCard.data)}`
    );

    // === Test 2: İzinli sürücünün kartı → DRIVER_INACTIVE ===
    const onLeaveCard = await hwPost('/dispense/request-auth', { rfidCardId: 'CARD-881205', tankName: 'Orman Depo Tankı (T-3)' });
    check(
      "Test 2: İZİNLİ durumundaki sürücünün kartı reddedilir (DRIVER_INACTIVE)",
      onLeaveCard.status === 403 && onLeaveCard.data?.details?.error === 'DRIVER_INACTIVE',
      `status=${onLeaveCard.status}, body=${JSON.stringify(onLeaveCard.data)}`
    );

    // === Test 3: Aracı olmayan bir sürücü (drv-2, henüz atanmamış) → NO_VEHICLE_ASSIGNED ===
    const noVehicle = await hwPost('/dispense/request-auth', { rfidCardId: 'CARD-881202', tankName: 'Gebze Ana Tank (T-1)' });
    check(
      'Test 3: Aracı atanmamış sürücü reddedilir (NO_VEHICLE_ASSIGNED)',
      noVehicle.status === 403 && noVehicle.data?.details?.error === 'NO_VEHICLE_ASSIGNED',
      `status=${noVehicle.status}, body=${JSON.stringify(noVehicle.data)}`
    );

    // === Test 4: Başarılı request-auth → AUTHORIZED oturum ===
    const auth = await hwPost('/dispense/request-auth', { rfidCardId: 'CARD-881201', tankName: 'Gebze Ana Tank (T-1)' });
    check(
      'Test 4: Geçerli kart + atanmış araç + yeterli tank → oturum AUTHORIZED açılır',
      auth.status === 200 && auth.data?.data?.state === 'AUTHORIZED' && auth.data?.data?.vehiclePlate === '34 CTP 82',
      `status=${auth.status}, body=${JSON.stringify(auth.data)}`
    );
    const sessionId = auth.data?.data?.sessionId;

    // === Test 5: Aynı pompada ikinci bir oturum açılamaz ===
    const secondAuth = await hwPost('/dispense/request-auth', { rfidCardId: 'CARD-881201', tankName: 'Gebze Ana Tank (T-1)' });
    check(
      'Test 5: Aynı pompada (deviceId) eşzamanlı ikinci oturum reddedilir (SESSION_ALREADY_ACTIVE)',
      secondAuth.status === 409 && secondAuth.data?.details?.error === 'SESSION_ALREADY_ACTIVE',
      `status=${secondAuth.status}, body=${JSON.stringify(secondAuth.data)}`
    );

    // === Test 6: İlk heartbeat → AUTHORIZED'dan PUMPING'e geçer ===
    const hb1 = await hwPost('/dispense/heartbeat', { sessionId, totalizerLiters: 1000.0, flowRateLpm: 25 });
    check(
      'Test 6: İlk heartbeat oturumu PUMPING\'e geçirir',
      hb1.status === 200 && hb1.data?.command === 'CONTINUE' && hb1.data?.state === 'PUMPING',
      `status=${hb1.status}, body=${JSON.stringify(hb1.data)}`
    );

    // === Test 7: İkinci heartbeat (totalizatör ilerledi) ===
    const hb2 = await hwPost('/dispense/heartbeat', { sessionId, totalizerLiters: 1050.0, flowRateLpm: 24 });
    check(
      'Test 7: Sonraki heartbeat PUMPING durumunda kalır',
      hb2.status === 200 && hb2.data?.command === 'CONTINUE' && hb2.data?.state === 'PUMPING',
      `status=${hb2.status}, body=${JSON.stringify(hb2.data)}`
    );

    // === Test 8: Geçersiz durum geçişi — bitmiş bir sessionId'ye finalize sonrası tekrar heartbeat ===
    const idempotencyKey = `fuel401-test-${Date.now()}`;
    const finalize1 = await hwPost('/dispense/finalize', {
      sessionId, endTotalizerLiters: 1050.0, reportedLiters: 50.0, idempotencyKey
    });
    check(
      'Test 8: Finalize — totalizatör farkı (50L) doğru hesaplanıp DOĞRULANDI olarak kaydedilir',
      finalize1.status === 200 &&
        Number(finalize1.data?.data?.amount_liters) === 50 &&
        finalize1.data?.data?.verification_status === 'DOĞRULANDI' &&
        !!finalize1.data?.data?.hash_signature,
      `status=${finalize1.status}, body=${JSON.stringify(finalize1.data)}`
    );

    // === Test 9: Tank seviyesi gerçekten 50L düştü mü? ===
    const tankAfter = await db.query(`SELECT current_level_liters FROM tanks WHERE id = 'tank-gebze-1'`);
    const levelAfter = Number(tankAfter.rows[0].current_level_liters);
    check(
      'Test 9: Tank seviyesi finalize sonrası gerçekten 50L düştü',
      Math.abs(levelBefore - levelAfter - 50) < 0.01,
      `önce=${levelBefore}, sonra=${levelAfter}, fark=${levelBefore - levelAfter}`
    );

    // === Test 10: Aynı idempotencyKey ile tekrar finalize → yeni kayıt YARATILMAZ ===
    const finalize2 = await hwPost('/dispense/finalize', {
      sessionId, endTotalizerLiters: 1050.0, reportedLiters: 50.0, idempotencyKey
    });
    const txCountRes = await db.query(`SELECT COUNT(*)::int AS c FROM transactions WHERE idempotency_key = $1`, [idempotencyKey]);
    check(
      'Test 10: Aynı idempotencyKey ile tekrar finalize — İKİNCİ bir kayıt yaratılmaz, mevcut döner',
      finalize2.status === 200 && finalize2.data?.data?.id === finalize1.data?.data?.id && txCountRes.rows[0].c === 1,
      `finalize1.id=${finalize1.data?.data?.id}, finalize2.id=${finalize2.data?.data?.id}, DB'deki kayıt sayısı=${txCountRes.rows[0].c}`
    );

    // === Test 11: COMPLETED bir oturuma tekrar heartbeat → INVALID_STATE_TRANSITION ===
    const hbAfterComplete = await hwPost('/dispense/heartbeat', { sessionId, totalizerLiters: 1060.0, flowRateLpm: 10 });
    check(
      'Test 11: Tamamlanmış (COMPLETED) bir oturuma heartbeat reddedilir (INVALID_STATE_TRANSITION)',
      hbAfterComplete.status === 409 && hbAfterComplete.data?.details?.error === 'INVALID_STATE_TRANSITION',
      `status=${hbAfterComplete.status}, body=${JSON.stringify(hbAfterComplete.data)}`
    );

    // === Test 12: Yeni oturum aç → sunucu tarafı max-litre aşımı FORCE_CUTOFF üretir ===
    const auth2 = await hwPost('/dispense/request-auth', { rfidCardId: 'CARD-881201', tankName: 'Gebze Ana Tank (T-1)' });
    const sessionId2 = auth2.data?.data?.sessionId;
    const maxAllowed = Number(auth2.data?.data?.maxAllowedLiters);
    await hwPost('/dispense/heartbeat', { sessionId: sessionId2, totalizerLiters: 2000.0, flowRateLpm: 40 });
    const overLimitHb = await hwPost('/dispense/heartbeat', { sessionId: sessionId2, totalizerLiters: 2000 + maxAllowed + 5, flowRateLpm: 40 });
    check(
      'Test 12: maxAllowedLiters aşıldığında sunucu FORCE_CUTOFF döner (MAX_LITERS_EXCEEDED)',
      overLimitHb.status === 200 && overLimitHb.data?.command === 'FORCE_CUTOFF' && overLimitHb.data?.reason === 'MAX_LITERS_EXCEEDED',
      `maxAllowed=${maxAllowed}, status=${overLimitHb.status}, body=${JSON.stringify(overLimitHb.data)}`
    );

    // === Test 13: FORCE_CUTOFF sonrası oturum TIMED_OUT'a düştü, finalize KURTARMA yoluyla mümkün ve DOĞRULAMA_BEKLIYOR ===
    const idempotencyKey2 = `fuel401-test-recovery-${Date.now()}`;
    const finalizeAfterCutoff = await hwPost('/dispense/finalize', {
      sessionId: sessionId2, endTotalizerLiters: 2000 + maxAllowed + 5, reportedLiters: maxAllowed + 5, idempotencyKey: idempotencyKey2
    });
    check(
      'Test 13: FORCE_CUTOFF sonrası (TIMED_OUT) finalize kurtarma yolundan geçer ve DOĞRULAMA_BEKLIYOR işaretlenir',
      finalizeAfterCutoff.status === 200 && finalizeAfterCutoff.data?.data?.verification_status === 'DOĞRULAMA_BEKLIYOR',
      `status=${finalizeAfterCutoff.status}, body=${JSON.stringify(finalizeAfterCutoff.data)}`
    );

    // === Test 14: %1'den fazla sapma olan bir finalize → DOĞRULAMA_BEKLIYOR ===
    const auth3 = await hwPost('/dispense/request-auth', { rfidCardId: 'CARD-881201', tankName: 'Gebze Ana Tank (T-1)' });
    const sessionId3 = auth3.data?.data?.sessionId;
    await hwPost('/dispense/heartbeat', { sessionId: sessionId3, totalizerLiters: 5000.0, flowRateLpm: 20 });
    const idempotencyKey3 = `fuel401-test-discrepancy-${Date.now()}`;
    // Gerçek totalizatör farkı = 100L ama cihaz 80L bildiriyor → %25 sapma
    const finalizeDiscrepancy = await hwPost('/dispense/finalize', {
      sessionId: sessionId3, endTotalizerLiters: 5100.0, reportedLiters: 80.0, idempotencyKey: idempotencyKey3
    });
    check(
      'Test 14: %1 eşiğini aşan totalizatör/cihaz-bildirim sapması DOĞRULAMA_BEKLIYOR olarak işaretlenir',
      finalizeDiscrepancy.status === 200 &&
        Number(finalizeDiscrepancy.data?.data?.amount_liters) === 100 &&
        finalizeDiscrepancy.data?.data?.verification_status === 'DOĞRULAMA_BEKLIYOR',
      `status=${finalizeDiscrepancy.status}, body=${JSON.stringify(finalizeDiscrepancy.data)}`
    );
  } finally {
    // Temizlik
    await db.query(`DELETE FROM transactions WHERE idempotency_key LIKE 'fuel401-test-%'`);
    await db.query(`UPDATE tanks SET current_level_liters = $1, status = 'GÜVENLİ' WHERE id = 'tank-gebze-1'`, [levelBefore]);
    await db.query(`UPDATE vehicles SET assigned_driver_name = NULL WHERE id = 'veh-1'`);
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
