import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * TEST_PLAN.md / GitHub #77 [FLEET-1401] — Araç ve iş makinesi kartı (CRUD).
 *
 * Bu ticket'ın kapsamı geniş taranmış (bkz. commit mesajı); burada test
 * edilen, GERÇEKTEN eklenen/düzeltilen üç parça:
 *  1. Plakasız iş makineleri (AC: "tanım koduyla kaydedilebilmelidir") —
 *     vehicleSchema.ts artık TURKISH_PLATE_REGEX YA DA EQUIPMENT_CODE_REGEX
 *     ("EKS-04" gibi) kabul ediyor.
 *  2. Şantiye atama geçmişi (AC: "atama geçmişi") — yeni
 *     `vehicle_site_assignments` tablosu, createVehicle'da İLK atamayı,
 *     updateVehicle'da site_name GERÇEKTEN değiştiğinde yeni bir satır yazar.
 *  3. GERÇEK bir bug: manuel/operatör-tetiklemeli ikmal (`POST /dispense` →
 *     createTransaction) aracın `status`'unu HİÇ kontrol etmiyordu — yalnızca
 *     RFID/cihaz-tetiklemeli otomatik akış (authorizeDispenseRequest) bunu
 *     yapıyordu. Bir PASİF/BLOKE araç manuel ikmal ile hâlâ yakıt
 *     alabiliyordu (canlı doğrulandı, AC "pasife alındığında yakıt
 *     alamamalı" ihlaliydi) — şimdi createTransaction'da da aynı kontrol var.
 *
 * BİLİNÇLİ KAPSAM DIŞI (kod içinde belgelendi, burada TEKRARLANMIYOR):
 *  - `deleteVehicle` hâlâ GERÇEK bir DELETE'tir (soft-delete'e çevrilmedi) —
 *    frontend'in ayrı, kasıtlı "Sil ve Kaldır" özelliği bu davranışa
 *    dayanıyor; "geçmiş korunmalı" AC'si PASİF durumuna geçiş yoluyla
 *    karşılanıyor, silme her zaman geri alınamaz bir aksiyon olarak kaldı.
 *  - Plaka üzerinde DB seviyesinde UNIQUE index YOK (TEST_PLAN §4'te ÖNCEDEN
 *    belgelenmiş, bilinçli bir karar — mevcut kopyalar temizlenmeden
 *    eklenirse deploy'daki şema adımı durur); uygulama seviyesi advisory-lock
 *    kontrolü (assertPlateAvailable, test_vehicle_plate_uniqueness.ts'te
 *    AYRICA test ediliyor) değişmedi.
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';
const RUN = Date.now();
const EQUIPMENT_CODE = `EKS-${String(RUN).slice(-4)}`;
const DISPENSE_PLATE = `34 FLT ${String(RUN).slice(-4)}`;

function pg(): Client {
  return new Client({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database: process.env.POSTGRES_DB || 'yakittakip_db'
  });
}

async function login(username: string): Promise<string> {
  await resetLoginRateLimit();
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: '123456' })
  });
  const body = await res.json();
  if (!body.accessToken) throw new Error(`'${username}' girişi başarısız: ${JSON.stringify(body)}`);
  return body.accessToken;
}

async function api(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [TEST_PLAN / GitHub #77] FLEET-1401 ARAÇ YAŞAM DÖNGÜSÜ');
  console.log('===========================================================\n');
  let passed = 0;
  let total = 0;
  const check = (name: string, condition: boolean, detail: string) => {
    total++;
    console.log(`${condition ? '✅ [PASS]' : '❌ [FAIL]'} ${name}\n   ${detail}\n`);
    if (condition) passed++;
  };

  const db = pg();
  await db.connect();
  const vehicleIds: string[] = [];
  const txIds: string[] = [];

  try {
    const owner = await login('camsa'); // COMPANY_OWNER, comp-camsa

    // --- AC: plakasız iş makinesi tanım koduyla kaydedilebilmelidir --------
    const equipRes = await api('POST', '/vehicles', owner, {
      plate: EQUIPMENT_CODE,
      brandModel: 'CAT 320 Ekskavatör',
      type: 'Ekskavatör',
      rfidTag: `TAG-FLT-${RUN}-1`,
      fuelCapacityLiters: 250,
      siteName: 'Gebze Ana Şantiye',
      meterType: 'MOTOR_SAAT',
      yearOfManufacture: 2020,
      avgConsumptionExpectation: 18.5
    });
    check(
      'Test 1: Plakasız iş makinesi tanım koduyla ("EKS-xxxx") kaydedilebilir',
      equipRes.status === 200 && equipRes.body?.data?.plate === EQUIPMENT_CODE,
      `status=${equipRes.status}, body=${JSON.stringify(equipRes.body)}`
    );
    const equipId: string = equipRes.body?.data?.id;
    if (equipId) vehicleIds.push(equipId);

    check(
      'Test 2: Yıl ve ortalama tüketim beklentisi doğru kaydedilir/döner',
      Number(equipRes.body?.data?.year_of_manufacture) === 2020 && Number(equipRes.body?.data?.avg_consumption_expectation) === 18.5,
      `year=${equipRes.body?.data?.year_of_manufacture}, avgConsumption=${equipRes.body?.data?.avg_consumption_expectation}`
    );

    const invalidPlateRes = await api('POST', '/vehicles', owner, {
      plate: '???', brandModel: 'Geçersiz Test', rfidTag: `TAG-FLT-${RUN}-invalid`, fuelCapacityLiters: 100
    });
    check('Test 3: Ne Türkiye plakası ne tanım kodu formatına uyan değer 400 ile reddedilir', invalidPlateRes.status === 400, `status=${invalidPlateRes.status}`);

    const blokeRes = await api('POST', '/vehicles', owner, {
      plate: `GRDR-${String(RUN).slice(-3)}`, brandModel: 'Greyder', type: 'Greyder', rfidTag: `TAG-FLT-${RUN}-2`,
      fuelCapacityLiters: 200, siteName: 'Gebze Ana Şantiye', status: 'BLOKE'
    });
    check('Test 4: Yeni "BLOKE" durumu (yakıt alımı bloke) kabul edilir', blokeRes.status === 200 && blokeRes.body?.data?.status === 'BLOKE', `status=${blokeRes.status}, durum=${blokeRes.body?.data?.status}`);
    if (blokeRes.body?.data?.id) vehicleIds.push(blokeRes.body.data.id);

    // --- AC: şantiye ataması ve atama geçmişi -------------------------------
    const historyAfterCreate = await api('GET', `/vehicles/${equipId}/assignment-history`, owner);
    check(
      'Test 5: Araç oluşturulunca atama geçmişine İLK satır (from:null → to:ilk şantiye) yazılır',
      historyAfterCreate.status === 200 && historyAfterCreate.body.data.length === 1 &&
        historyAfterCreate.body.data[0].fromSiteName === null && historyAfterCreate.body.data[0].toSiteName === 'Gebze Ana Şantiye',
      `status=${historyAfterCreate.status}, data=${JSON.stringify(historyAfterCreate.body.data)}`
    );

    const reassign = await api('PUT', `/vehicles/${equipId}`, owner, { siteName: 'Orman Şantiyesi' });
    check('Test 6: Şantiye değişikliği kabul edilir', reassign.status === 200 && reassign.body?.data?.site_name === 'Orman Şantiyesi', `status=${reassign.status}`);

    const historyAfterReassign = await api('GET', `/vehicles/${equipId}/assignment-history`, owner);
    const newest = historyAfterReassign.body.data?.[0];
    check(
      'Test 7: GERÇEK şantiye değişikliği geçmişe İKİNCİ bir satır (from:eski → to:yeni) ekler',
      historyAfterReassign.status === 200 && historyAfterReassign.body.data.length === 2 &&
        newest?.fromSiteName === 'Gebze Ana Şantiye' && newest?.toSiteName === 'Orman Şantiyesi',
      `data=${JSON.stringify(historyAfterReassign.body.data)}`
    );

    const noopUpdate = await api('PUT', `/vehicles/${equipId}`, owner, { brandModel: 'CAT 320 Ekskavatör (güncellendi)' });
    const historyAfterNoop = await api('GET', `/vehicles/${equipId}/assignment-history`, owner);
    check(
      'Test 8a: site_name İÇERMEYEN bir güncelleme geçmişe YENİ satır EKLEMEZ (hâlâ 2 satır)',
      noopUpdate.status === 200 && historyAfterNoop.body.data.length === 2,
      `güncelleme sonrası satır sayısı=${historyAfterNoop.body.data.length}`
    );

    // Frontend'in "Düzenle" formu (bkz. vehicleSchema.ts'teki status yorumu)
    // TÜM alanları HER ZAMAN gönderir — site_name AYNI değerle tekrar
    // gönderilse bile (gerçek bir değişiklik OLMADAN) geçmişe satır
    // eklenmemeli. Bu, Test 8a'dan FARKLI bir kod yolunu (previousSiteName
    // karşılaştırması) dener: 8a site_name'i HİÇ göndermez, bu ise AYNI
    // değerle gönderir.
    const sameValueUpdate = await api('PUT', `/vehicles/${equipId}`, owner, { siteName: 'Orman Şantiyesi' });
    const historyAfterSameValue = await api('GET', `/vehicles/${equipId}/assignment-history`, owner);
    check(
      'Test 8b: site_name AYNI değerle tekrar gönderilirse geçmişe YENİ satır EKLEMEZ (hâlâ 2 satır)',
      sameValueUpdate.status === 200 && historyAfterSameValue.body.data.length === 2,
      `güncelleme sonrası satır sayısı=${historyAfterSameValue.body.data.length}`
    );

    // --- GERÇEK BUG: manuel ikmalin araç durumunu kontrol etmemesi ---------
    const aktifVehicle = await api('POST', '/vehicles', owner, {
      plate: DISPENSE_PLATE, brandModel: 'İkmal Bloke Testi', rfidTag: `TAG-FLT-${RUN}-3`,
      fuelCapacityLiters: 300, siteName: 'Gebze Ana Şantiye', status: 'AKTİF'
    });
    const dispenseVehicleId: string = aktifVehicle.body?.data?.id;
    if (dispenseVehicleId) vehicleIds.push(dispenseVehicleId);

    const dispense = () => api('POST', '/dispense', owner, { siteName: 'Gebze Ana Şantiye', vehiclePlate: DISPENSE_PLATE, amountLiters: 10, type: 'Manuel' });

    const dispenseWhileAktif = await dispense();
    if (dispenseWhileAktif.body?.data?.id) txIds.push(dispenseWhileAktif.body.data.id);
    check('Test 9: AKTİF araca manuel ikmal İZİN VERİLİR (kontrol grubu)', dispenseWhileAktif.status === 200, `status=${dispenseWhileAktif.status}, body=${JSON.stringify(dispenseWhileAktif.body)}`);

    await api('PUT', `/vehicles/${dispenseVehicleId}`, owner, { status: 'PASİF' });
    const dispenseWhilePasif = await dispense();
    check(
      'Test 10: PASİF araca manuel ikmal REDDEDİLİR (403 VEHICLE_BLOCKED) — canlı yakalanan bug, düzeltildi',
      dispenseWhilePasif.status === 403 && dispenseWhilePasif.body?.details?.error === 'VEHICLE_BLOCKED',
      `status=${dispenseWhilePasif.status}, body=${JSON.stringify(dispenseWhilePasif.body)}`
    );

    await api('PUT', `/vehicles/${dispenseVehicleId}`, owner, { status: 'BLOKE' });
    const dispenseWhileBloke = await dispense();
    check(
      'Test 11: BLOKE araca manuel ikmal de REDDEDİLİR (403 VEHICLE_BLOCKED)',
      dispenseWhileBloke.status === 403 && dispenseWhileBloke.body?.details?.error === 'VEHICLE_BLOCKED',
      `status=${dispenseWhileBloke.status}, body=${JSON.stringify(dispenseWhileBloke.body)}`
    );

    await api('PUT', `/vehicles/${dispenseVehicleId}`, owner, { status: 'AKTİF' });
    const dispenseAfterReactivate = await dispense();
    if (dispenseAfterReactivate.body?.data?.id) txIds.push(dispenseAfterReactivate.body.data.id);
    check('Test 12: AKTİF\'e geri alınca ikmal tekrar İZİN VERİLİR (geri döndürülebilir, tek yönlü kilit DEĞİL)', dispenseAfterReactivate.status === 200, `status=${dispenseAfterReactivate.status}`);

    const unregisteredPlate = `35 XYZ ${String(RUN).slice(-4)}`;
    const dispenseUnregistered = await api('POST', '/dispense', owner, { siteName: 'Gebze Ana Şantiye', vehiclePlate: unregisteredPlate, amountLiters: 5, type: 'Manuel' });
    if (dispenseUnregistered.body?.data?.id) txIds.push(dispenseUnregistered.body.data.id);
    check(
      'Test 13: Kayıtlı OLMAYAN (serbest metin) plaka için durum kontrolü ATLANIR — mevcut tolerans deseni bozulmadı',
      dispenseUnregistered.status === 200,
      `status=${dispenseUnregistered.status}, body=${JSON.stringify(dispenseUnregistered.body)}`
    );
  } finally {
    for (const txId of txIds) {
      await db.query('DELETE FROM transactions WHERE id = $1', [txId]);
    }
    await db.query(`DELETE FROM transactions WHERE vehicle_plate = $1`, [`35 XYZ ${String(RUN).slice(-4)}`]);
    for (const vId of vehicleIds) {
      await db.query('DELETE FROM vehicles WHERE id = $1', [vId]); // vehicle_site_assignments CASCADE ile gider
    }
    await db.end();
    await resetLoginRateLimit();
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => {
  console.error('🔥 Test çalıştırılırken beklenmeyen hata:', err);
  process.exit(1);
});
