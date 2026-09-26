import { Client } from 'pg';
import Redis from 'ioredis';

/**
 * INV-1502 (#152) — Tedarikçi tanımı ve yakıt alım (dolum) irsaliyesi kaydı.
 *
 * Kapsanan AC'ler:
 *  - Tedarikçi kartı: unvan, VKN (GİB algoritmasıyla doğrulanır), iletişim, sözleşme.
 *  - Alım irsaliyesi BAŞLIĞI: tedarikçi, tarih, irsaliye no, KDV/ÖTV/toplam AYRI saklanır.
 *  - "İrsaliye kaydı bir veya birden çok dolumla ilişkilendirilebilmelidir" —
 *    aynı waybillId ile İKİ FARKLI tanka dolum yapılabildiği doğrulanır.
 *  - "Aynı tedarikçide mükerrer irsaliye numarası reddedilmelidir" — supplier
 *    bazlı benzersizlik (tank bazlı DEĞİL — FUEL-408'in DUPLICATE_WAYBILL'i
 *    farklı bir kapsam, o da regresyon olarak ayrıca test edilir).
 *  - Tedarikçi bazlı alım geçmişi ve fiyat karşılaştırması (ortalama birim fiyat).
 */

const API_URL = 'http://localhost:5000/api/v1';
const RUN = Date.now();
const SITE_NAME = 'Gebze Ana Şantiye';

const redis = new Redis({ host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379', 10) });

function pg(): Client {
  return new Client({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database: process.env.POSTGRES_DB || 'yakittakip_db'
  });
}
async function q(sql: string, params: any[] = []): Promise<any[]> {
  const c = pg();
  await c.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}
async function resetLoginRl(): Promise<void> {
  const keys = await redis.keys('rl:auth-login:*');
  if (keys.length) await redis.del(...keys);
}
async function call(method: string, path: string, opts: { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
  if (path === '/auth/login') await resetLoginRl();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${API_URL}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function login(username: string): Promise<string> {
  const r = await call('POST', '/auth/login', { body: { username, password: '123456' } });
  if (!r.body.accessToken) throw new Error(`login ${username}: ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
}

// Gerçek bir VKN (GİB checksum algoritmasını geçen, kamuya açık test değeri —
// compliance/taxIdValidation.ts'nin kendi unit testlerinde de kullanılan türden).
function computeValidVkn(seedDigits: string): string {
  // İlk 9 haneyi seedDigits'ten türet (9 haneye tamamla/kırp), kontrol hanesini
  // GİB algoritmasıyla hesapla (isValidVKN'in TERSİ) — böylece her çalıştırmada
  // BENZERSİZ ama GEÇERLİ bir VKN üretilir (RUN damgasına göre çakışmasız).
  const nine = (seedDigits + '000000000').slice(0, 9).split('').map(Number);
  let sum = 0;
  const partial: number[] = [];
  for (let i = 0; i < 9; i++) {
    const c1 = (nine[i] + (9 - i)) % 10;
    let c2 = (c1 * 2 ** (9 - i)) % 9;
    if (c1 !== 0 && c2 === 0) c2 = 9;
    partial.push(c2);
    sum += c2;
  }
  const check = (10 - (sum % 10)) % 10;
  return nine.join('') + check;
}

async function run() {
  console.log('===========================================================');
  console.log('🧾 [INV-1502] TEDARİKÇİ TANIMI VE ALIM İRSALİYESİ TESTİ');
  console.log('===========================================================\n');

  let passed = 0;
  let total = 0;
  const check = (name: string, condition: boolean, detail: string) => {
    total++;
    if (condition) {
      console.log(`✅ [PASS] ${name}\n   ${detail}\n`);
      passed++;
    } else {
      console.log(`❌ [FAIL] ${name}\n   ${detail}\n`);
    }
  };

  const owner = await login('camsa');
  const vknA = computeValidVkn(String(RUN).slice(-9));
  const vknB = computeValidVkn(String(RUN + 1).slice(-9));

  const createdSupplierIds: string[] = [];
  const createdWaybillIds: string[] = [];
  const createdTankIds: string[] = [];
  const createdIntakeIds: string[] = [];

  try {
    // === Test 1: geçersiz VKN (checksum tutmuyor) → 400 INVALID_VKN ===
    const badVknRes = await call('POST', '/suppliers', {
      // 1234567891 — '1234567890'nin kontrol hanesi GİB algoritmasına göre GEÇERLİDİR
      // (elle doğrulandı); burada bilerek YANLIŞ kontrol hanesi (...91) kullanılıyor.
      token: owner,
      body: { name: `INV1502-BadVkn-${RUN}`, vkn: '1234567891' }
    });
    check(
      'Test 1: Checksum tutmayan VKN reddedilir (400 INVALID_VKN)',
      badVknRes.status === 400 && badVknRes.body?.details?.error === 'INVALID_VKN',
      `status=${badVknRes.status}, body=${JSON.stringify(badVknRes.body)}`
    );

    // === Test 2: geçerli VKN ile tedarikçi oluşturulur ===
    const createA = await call('POST', '/suppliers', {
      token: owner,
      body: {
        name: `INV1502-Tedarikci-A-${RUN}`,
        vkn: vknA,
        contactPhone: '+90 262 555 00 00',
        contactEmail: 'tedarikci-a@example.com',
        contactAddress: 'Gebze OSB, Kocaeli',
        contractInfo: 'Yıllık çerçeve sözleşme, KDV hariç birim fiyat sabit.'
      }
    });
    if (createA.body?.data?.id) createdSupplierIds.push(createA.body.data.id);
    const supplierAId = createA.body?.data?.id;
    check(
      'Test 2 (ASIL AC — tedarikçi kartı): unvan/VKN/iletişim/sözleşme ile oluşturulur',
      createA.status === 201 && createA.body?.data?.vkn === vknA && createA.body?.data?.contact_email === 'tedarikci-a@example.com',
      `status=${createA.status}, body=${JSON.stringify(createA.body)}`
    );

    // === Test 3: aynı VKN ile ikinci tedarikçi → 409 SUPPLIER_VKN_TAKEN ===
    const dupVkn = await call('POST', '/suppliers', { token: owner, body: { name: `INV1502-Dup-${RUN}`, vkn: vknA } });
    check(
      'Test 3: Aynı VKN ile ikinci tedarikçi reddedilir (409 SUPPLIER_VKN_TAKEN)',
      dupVkn.status === 409 && dupVkn.body?.details?.error === 'SUPPLIER_VKN_TAKEN',
      `status=${dupVkn.status}, body=${JSON.stringify(dupVkn.body)}`
    );

    // === Test 4: tedarikçi güncellenir ===
    const updateA = await call('PUT', `/suppliers/${supplierAId}`, { token: owner, body: { contactPhone: '+90 262 555 11 11' } });
    check(
      'Test 4: Tedarikçi güncellenir',
      updateA.status === 200 && updateA.body?.data?.contact_phone === '+90 262 555 11 11',
      `status=${updateA.status}, body=${JSON.stringify(updateA.body)}`
    );

    // === Test 5: GET /suppliers listede görünür ===
    const listRes = await call('GET', '/suppliers', { token: owner });
    check(
      'Test 5: GET /suppliers listesinde tedarikçi görünür',
      listRes.status === 200 && listRes.body?.data?.some((s: any) => s.id === supplierAId),
      `status=${listRes.status}, totalCount=${listRes.body?.totalCount}`
    );

    // === Test 6: ikinci (farklı VKN) tedarikçi oluşturulur — Test 9/AC-scope için ===
    const createB = await call('POST', '/suppliers', { token: owner, body: { name: `INV1502-Tedarikci-B-${RUN}`, vkn: vknB } });
    if (createB.body?.data?.id) createdSupplierIds.push(createB.body.data.id);
    const supplierBId = createB.body?.data?.id;
    check('Test 6: İkinci tedarikçi (farklı VKN) oluşturulur', createB.status === 201, `status=${createB.status}`);

    // === Test 7 (ASIL AC — vergi kalemleri ayrı): tutarsız toplam reddedilir ===
    const badTotal = await call('POST', '/fuel-waybills', {
      token: owner,
      body: {
        supplierId: supplierAId, waybillNo: `WB-BADTOTAL-${RUN}`, deliveryDate: '2026-01-15',
        subtotalAmount: 10000, kdvAmount: 2000, otvAmount: 500, totalAmount: 99999
      }
    });
    check(
      'Test 7 (ASIL AC — vergi kalemleri ayrı): subtotal+kdv+otv toplamla eşleşmezse 400',
      badTotal.status === 400,
      `status=${badTotal.status}, body=${JSON.stringify(badTotal.body)}`
    );

    // === Test 8: geçerli irsaliye başlığı oluşturulur (KDV/ÖTV/toplam AYRI saklanır) ===
    const waybillNo = `WB-${RUN}`;
    const createWb = await call('POST', '/fuel-waybills', {
      token: owner,
      body: {
        supplierId: supplierAId, waybillNo, deliveryDate: '2026-01-15',
        subtotalAmount: 10000, kdvAmount: 2000, otvAmount: 500, totalAmount: 12500,
        note: 'İki tanka bölünecek teslimat.'
      }
    });
    if (createWb.body?.data?.id) createdWaybillIds.push(createWb.body.data.id);
    const waybillId = createWb.body?.data?.id;
    check(
      'Test 8 (ASIL AC — vergi kalemleri ayrı): irsaliye başlığı subtotal/kdv/otv/total BAĞIMSIZ saklanır',
      createWb.status === 201 &&
        Number(createWb.body?.data?.subtotal_amount) === 10000 &&
        Number(createWb.body?.data?.kdv_amount) === 2000 &&
        Number(createWb.body?.data?.otv_amount) === 500 &&
        Number(createWb.body?.data?.total_amount) === 12500,
      `status=${createWb.status}, body=${JSON.stringify(createWb.body)}`
    );

    // === Test 9 (ASIL AC — mükerrer irsaliye no reddi, SUPPLIER bazlı): aynı tedarikçide aynı no → 409 ===
    const dupWb = await call('POST', '/fuel-waybills', {
      token: owner,
      body: { supplierId: supplierAId, waybillNo, deliveryDate: '2026-01-16', subtotalAmount: 100, kdvAmount: 20, totalAmount: 120 }
    });
    check(
      'Test 9 (ASIL AC — mükerrer irsaliye no): AYNI tedarikçide aynı waybillNo reddedilir (409 DUPLICATE_SUPPLIER_WAYBILL)',
      dupWb.status === 409 && dupWb.body?.details?.error === 'DUPLICATE_SUPPLIER_WAYBILL',
      `status=${dupWb.status}, body=${JSON.stringify(dupWb.body)}`
    );

    // === Test 10: FARKLI tedarikçide AYNI waybillNo kabul edilir (benzersizlik supplier bazlı, global değil) ===
    const sameNoOtherSupplier = await call('POST', '/fuel-waybills', {
      token: owner,
      body: { supplierId: supplierBId, waybillNo, deliveryDate: '2026-01-16', subtotalAmount: 100, kdvAmount: 20, totalAmount: 120 }
    });
    if (sameNoOtherSupplier.body?.data?.id) createdWaybillIds.push(sameNoOtherSupplier.body.data.id);
    check(
      'Test 10: Farklı tedarikçide AYNI irsaliye no kabul edilir (benzersizlik tedarikçi bazlı, global değil)',
      sameNoOtherSupplier.status === 201,
      `status=${sameNoOtherSupplier.status}, body=${JSON.stringify(sameNoOtherSupplier.body)}`
    );

    // === Test kobayları: iki ayrı tank oluştur (çoklu tank dolumu senaryosu için) ===
    const tank1Id = `tank-inv1502-a-${RUN}`;
    const tank1Name = `INV1502-Tank-A-${RUN}`;
    const tank2Id = `tank-inv1502-b-${RUN}`;
    const tank2Name = `INV1502-Tank-B-${RUN}`;
    await q(
      `INSERT INTO tanks (id, tenant_id, name, site_name, capacity_liters, current_level_liters, fuel_type)
       VALUES ($1, 'comp-camsa', $2, $3, 20000, 1000, 'Motorin'), ($4, 'comp-camsa', $5, $3, 20000, 1000, 'Motorin')`,
      [tank1Id, tank1Name, SITE_NAME, tank2Id, tank2Name]
    );
    createdTankIds.push(tank1Id, tank2Id);

    // === Test 11 (ASIL AC — çoklu tank): waybillId ile İLK tanka dolum, supplierName/waybillNo TEKRAR GİRİLMEZ ===
    const intake1 = await call('POST', `/tanks/${tank1Id}/intakes`, {
      token: owner,
      body: { waybillId, deliveryDate: '2026-01-15', declaredLiters: 6000, unitPrice: 42.5 }
    });
    if (intake1.body?.data?.receipt?.id) createdIntakeIds.push(intake1.body.data.receipt.id);
    check(
      'Test 11 (ASIL AC — çoklu tank dolumu): waybillId ile dolum — supplier_name/waybill_no İRSALİYE BAŞLIĞINDAN türetilir',
      intake1.status === 201 &&
        intake1.body?.data?.receipt?.supplier_name === `INV1502-Tedarikci-A-${RUN}` &&
        intake1.body?.data?.receipt?.waybill_no === waybillNo &&
        intake1.body?.data?.receipt?.waybill_id === waybillId,
      `status=${intake1.status}, body=${JSON.stringify(intake1.body)}`
    );

    // === Test 12 (ASIL AC): AYNI waybillId ile İKİNCİ (farklı) tanka dolum yapılabilir ===
    const intake2 = await call('POST', `/tanks/${tank2Id}/intakes`, {
      token: owner,
      body: { waybillId, deliveryDate: '2026-01-15', declaredLiters: 4000, unitPrice: 43.0 }
    });
    if (intake2.body?.data?.receipt?.id) createdIntakeIds.push(intake2.body.data.receipt.id);
    check(
      "Test 12 (ASIL AC — 'İrsaliye kaydı bir veya birden çok dolumla ilişkilendirilebilmelidir'): aynı waybillId İKİNCİ bir tanka da dolum yapabilir",
      intake2.status === 201 && intake2.body?.data?.receipt?.waybill_id === waybillId,
      `status=${intake2.status}, body=${JSON.stringify(intake2.body)}`
    );

    // === Test 13: AYNI waybillId + AYNI tanka TEKRAR dolum → 409 DUPLICATE_WAYBILL (idempotency, waybill_id bazlı) ===
    const dupIntake = await call('POST', `/tanks/${tank1Id}/intakes`, {
      token: owner,
      body: { waybillId, deliveryDate: '2026-01-15', declaredLiters: 100 }
    });
    check(
      'Test 13: Aynı waybillId + aynı tanka tekrar dolum reddedilir (409 DUPLICATE_WAYBILL, waybill_id bazlı denetim)',
      dupIntake.status === 409 && dupIntake.body?.details?.error === 'DUPLICATE_WAYBILL',
      `status=${dupIntake.status}, body=${JSON.stringify(dupIntake.body)}`
    );

    // === Test 14: GET /fuel-waybills/:id → başlık + HER İKİ dolum satırı görünür ===
    const wbDetail = await call('GET', `/fuel-waybills/${waybillId}`, { token: owner });
    check(
      "Test 14 (ASIL AC): GET /fuel-waybills/:id — başlığa bağlı İKİ dolum satırı da (2 farklı tank) listelenir",
      wbDetail.status === 200 && wbDetail.body?.data?.intakes?.length === 2,
      `status=${wbDetail.status}, intakeCount=${wbDetail.body?.data?.intakes?.length}`
    );

    // === Test 15: waybillId hem supplierName hem de kendisi verilirse → 400 (şema refine) ===
    const bothGiven = await call('POST', `/tanks/${tank1Id}/intakes`, {
      token: owner,
      body: { waybillId, supplierName: 'Elle Girilen', deliveryDate: '2026-01-15', declaredLiters: 100 }
    });
    check(
      'Test 15: waybillId İLE supplierName birlikte verilirse 400 (biri veya diğeri, ikisi birden değil)',
      bothGiven.status === 400,
      `status=${bothGiven.status}, body=${JSON.stringify(bothGiven.body)}`
    );

    // === Test 16: ne waybillId ne supplierName/waybillNo verilirse → 400 ===
    const neitherGiven = await call('POST', `/tanks/${tank1Id}/intakes`, {
      token: owner,
      body: { deliveryDate: '2026-01-15', declaredLiters: 100 }
    });
    check(
      'Test 16: Ne waybillId ne de supplierName/waybillNo verilmezse 400',
      neitherGiven.status === 400,
      `status=${neitherGiven.status}, body=${JSON.stringify(neitherGiven.body)}`
    );

    // === Test 17 (regresyon): waybillId OLMADAN eski/serbest-metin yol hâlâ çalışır (FUEL-408 geriye uyumluluk) ===
    const legacyIntake = await q(`SELECT current_level_liters FROM tanks WHERE id = $1`, [tank1Id]);
    const legacy = await call('POST', `/tanks/${tank1Id}/intakes`, {
      token: owner,
      body: { supplierName: `INV1502-Serbest-Metin-${RUN}`, waybillNo: `LEGACY-${RUN}`, deliveryDate: '2026-01-16', declaredLiters: 50 }
    });
    if (legacy.body?.data?.receipt?.id) createdIntakeIds.push(legacy.body.data.receipt.id);
    check(
      'Test 17 (regresyon): waybillId olmadan serbest-metin tedarikçi adıyla eski FUEL-408 akışı hâlâ çalışır',
      legacy.status === 201 && legacy.body?.data?.receipt?.waybill_id === null && legacy.body?.data?.receipt?.supplier_name === `INV1502-Serbest-Metin-${RUN}`,
      `status=${legacy.status}, body=${JSON.stringify(legacy.body)}`
    );

    // === Test 18 (ASIL AC — fiyat karşılaştırması): tedarikçi bazlı alım geçmişi, ortalama birim fiyat ===
    // (42.5 + 43.0) / 2 = 42.75
    const history = await call('GET', `/suppliers/${supplierAId}/purchase-history`, { token: owner });
    const wbInHistory = history.body?.data?.waybills?.find((w: any) => w.id === waybillId);
    check(
      'Test 18 (ASIL AC — tedarikçi bazlı alım geçmişi ve fiyat karşılaştırması): ortalama birim fiyat (42.5, 43.0) → 42.75',
      history.status === 200 && wbInHistory?.intakeCount === 2 && Math.abs(wbInHistory?.avgUnitPrice - 42.75) < 0.01,
      `status=${history.status}, waybill=${JSON.stringify(wbInHistory)}`
    );

    // === Test 19: RBAC — PUMP_OPERATOR tedarikçi oluşturamaz (403) ===
    const pumpOpUsername = `inv1502-pump-${RUN}`;
    await q(`INSERT INTO users (id, tenant_id, username, password_hash, role) SELECT $1, 'comp-camsa', $2, password_hash, 'PUMP_OPERATOR' FROM users WHERE username = 'camsa'`, [`usr-${pumpOpUsername}`, pumpOpUsername]);
    const pumpToken = await login(pumpOpUsername);
    const pumpCreate = await call('POST', '/suppliers', { token: pumpToken, body: { name: 'X', vkn: vknA } });
    check('Test 19: PUMP_OPERATOR tedarikçi oluşturamaz (403)', pumpCreate.status === 403, `status=${pumpCreate.status}`);
  } finally {
    await q(`DELETE FROM fuel_intake_receipts WHERE id = ANY($1)`, [createdIntakeIds]).catch(() => {});
    await q(`DELETE FROM tanks WHERE id = ANY($1)`, [createdTankIds]).catch(() => {});
    await q(`DELETE FROM fuel_purchase_waybills WHERE id = ANY($1)`, [createdWaybillIds]).catch(() => {});
    await q(`DELETE FROM suppliers WHERE id = ANY($1)`, [createdSupplierIds]).catch(() => {});
    await q(`DELETE FROM users WHERE username = $1`, [`inv1502-pump-${RUN}`]).catch(() => {});
    await q(`DELETE FROM audit_logs WHERE target_id = ANY($1)`, [[...createdSupplierIds, ...createdWaybillIds]]).catch(() => {});
    await resetLoginRl();
    redis.disconnect();
    console.log('🧹 Test fixture verisi temizlendi.\n');
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  if (passed !== total) process.exit(1);
}

run().catch((err) => {
  console.error('🔥 Test çalıştırılırken beklenmeyen hata:', err);
  process.exit(1);
});
