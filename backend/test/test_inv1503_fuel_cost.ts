import crypto from 'crypto';
import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * INV-1503 (#153) — Birim fiyat geçmişi ve dönemsel maliyet hesabı.
 *
 * Fiyat GEÇMİŞİ zaten vardı (fuel_intake_receipts.unit_price, FUEL-408) —
 * eksik olan, her ikmal kaydının O ANDAKİ birim maliyetini DONDURMASI ve
 * bu maliyetin sonradan fiyat değişse de DEĞİŞMEMESİydi. Bu test:
 *  - varsayılan (ağırlıklı ortalama) yöntemle doğru maliyet hesabını,
 *  - maliyetin fiyat değişiminden SONRA da SABİT kaldığını,
 *  - FIFO yöntemine geçişte katman bazlı (lot-overlap) doğru hesabı,
 *  - geriye dönük (offline) bir kaydın KENDİ tarihindeki fiyatla
 *    maliyetlendiğini (şimdiki fiyatla DEĞİL),
 *  - yöntem değiştirme ucunun RBAC/doğrulamasını
 * doğrular.
 */

const API_URL = 'http://localhost:5000/api/v1';
const RUN = Date.now();
const TANK_ID = `tank-inv1503-${RUN}`;
const TANK_NAME = `INV1503-Tank-${RUN}`;
const SITE_NAME = 'Gebze Ana Şantiye';
const VEH_PLATE = `34 IV ${String(RUN).slice(-3)}`;
const VEH2_PLATE = `34 IW ${String(RUN).slice(-3)}`;

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

async function call(method: string, path: string, opts: { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${API_URL}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function login(username: string): Promise<string> {
  await resetLoginRateLimit();
  const res = await call('POST', '/auth/login', { body: { username, password: '123456' } });
  if (!res.body.accessToken) throw new Error(`'${username}' girişi başarısız: ${JSON.stringify(res.body)}`);
  return res.body.accessToken;
}

function signHmac(secret: string, timestamp: string, nonce: string, rawBody: string): string {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${nonce}.${rawBody}`).digest('hex');
}

async function hwPost(deviceId: string, secret: string, path: string, body: object): Promise<{ status: number; body: any }> {
  const rawBody = JSON.stringify(body);
  const timestamp = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Device-ID': deviceId,
      'X-Timestamp': timestamp,
      'X-Nonce': nonce,
      'X-Hardware-Signature': signHmac(secret, timestamp, nonce, rawBody)
    },
    body: rawBody
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function run() {
  console.log('===========================================================');
  console.log('💰 [INV-1503] BİRİM FİYAT GEÇMİŞİ VE DÖNEMSEL MALİYET TESTİ');
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

  try {
    await q(
      `INSERT INTO tanks (id, tenant_id, name, site_name, capacity_liters, current_level_liters, fuel_type)
       VALUES ($1, 'comp-camsa', $2, $3, 100000, 0, 'Motorin')`,
      [TANK_ID, TANK_NAME, SITE_NAME]
    );

    // --- Lot A: 1000 L @ 30 TL (2026-01-01), Lot B: 1000 L @ 40 TL (2026-01-10) ---
    const lotA = await call('POST', `/tanks/${TANK_ID}/intakes`, {
      token: owner,
      body: { supplierName: 'Tedarikçi A', waybillNo: `INV1503-A-${RUN}`, deliveryDate: '2026-01-01', declaredLiters: 1000, unitPrice: 30 }
    });
    const lotB = await call('POST', `/tanks/${TANK_ID}/intakes`, {
      token: owner,
      body: { supplierName: 'Tedarikçi B', waybillNo: `INV1503-B-${RUN}`, deliveryDate: '2026-01-10', declaredLiters: 1000, unitPrice: 40 }
    });
    check('Ön koşul: iki fiyatlı dolum (30 TL + 40 TL) başarıyla kaydedildi',
      lotA.status === 201 && lotB.status === 201, `lotA=${lotA.status}, lotB=${lotB.status}`);

    // === Test 1: varsayılan (ağırlıklı ortalama) yöntemle 500 L ikmal → (1000*30+1000*40)/2000 = 35 TL/L ===
    const dispense1 = await call('POST', '/dispense', {
      token: owner,
      body: { siteName: SITE_NAME, vehiclePlate: VEH_PLATE, tankName: TANK_NAME, amountLiters: 500 }
    });
    const cost1 = dispense1.body?.data;
    check(
      'Test 1: Varsayılan ağırlıklı ortalama — 500 L ikmal 35.0000 TL/L birim maliyet taşıyor (17500.00 TL)',
      dispense1.status === 200 && Number(cost1?.unit_cost_liters) === 35 && Number(cost1?.total_cost) === 17500,
      `status=${dispense1.status}, unit_cost_liters=${cost1?.unit_cost_liters}, total_cost=${cost1?.total_cost}`
    );
    const tx1Id = cost1?.id;

    // === Test 2: SONRADAN çok daha yüksek fiyatlı bir 3. lot eklensin — Test 1'in maliyeti DEĞİŞMEMELİ ===
    const lotC = await call('POST', `/tanks/${TANK_ID}/intakes`, {
      token: owner,
      body: { supplierName: 'Tedarikçi C', waybillNo: `INV1503-C-${RUN}`, deliveryDate: '2026-01-20', declaredLiters: 1000, unitPrice: 1000 }
    });
    const tx1AfterPriceChange = (await q('SELECT unit_cost_liters, total_cost FROM transactions WHERE id = $1', [tx1Id]))[0];
    check(
      "Test 2 (ASIL AC — 'sonradan fiyat değişince geçmiş maliyetler değişmemelidir'): lot C eklendikten SONRA Test 1'in maliyeti hâlâ 35.0000 TL/L",
      lotC.status === 201 && Number(tx1AfterPriceChange.unit_cost_liters) === 35 && Number(tx1AfterPriceChange.total_cost) === 17500,
      `lotC=${lotC.status}, tx1 SONRA=${JSON.stringify(tx1AfterPriceChange)}`
    );

    // === Test 3: RBAC — PUMP_OPERATOR maliyet yöntemi değiştiremez ===
    const pumpOpUsername = `inv1503-pump-${RUN}`;
    await q(`INSERT INTO users (id, tenant_id, username, password_hash, role) SELECT $1, 'comp-camsa', $2, password_hash, 'PUMP_OPERATOR' FROM users WHERE username = 'camsa'`, [`usr-${pumpOpUsername}`, pumpOpUsername]);
    const pumpOpToken = await login(pumpOpUsername);
    const rbacDenied = await call('PATCH', '/companies/me/fuel-cost-settings', { token: pumpOpToken, body: { method: 'FIFO' } });
    check('Test 3: PUMP_OPERATOR maliyet yöntemini değiştiremez (403)', rbacDenied.status === 403, `status=${rbacDenied.status}`);

    // === Test 4: geçersiz yöntem değeri 400 ile reddedilir ===
    const invalidMethod = await call('PATCH', '/companies/me/fuel-cost-settings', { token: owner, body: { method: 'ORTALAMA_YANLIŞ' } });
    check('Test 4: Geçersiz maliyet yöntemi 400 ile reddedilir', invalidMethod.status === 400, `status=${invalidMethod.status}`);

    // === Test 5: FIFO'ya geçiş ===
    const switchToFifo = await call('PATCH', '/companies/me/fuel-cost-settings', { token: owner, body: { method: 'FIFO' } });
    check('Test 5: COMPANY_OWNER maliyet yöntemini FIFO\'ya çevirebilir', switchToFifo.status === 200 && switchToFifo.body?.data?.method === 'FIFO', `status=${switchToFifo.status}, body=${JSON.stringify(switchToFifo.body)}`);

    // === Test 6: FIFO — şimdiye kadar 500 L tüketildi (lot A'nın 1000 L'sinden).
    // Kalan lot A: 500 L @ 30. Şimdi 700 L ikmal: 500 L @ 30 (lot A'nın kalanı) + 200 L @ 40 (lot B'den) = (500*30+200*40)/700 = (15000+8000)/700 = 32.857142... ===
    const dispense2 = await call('POST', '/dispense', {
      token: owner,
      body: { siteName: SITE_NAME, vehiclePlate: VEH_PLATE, tankName: TANK_NAME, amountLiters: 700 }
    });
    const cost2 = dispense2.body?.data;
    const expectedFifoUnitCost = Number((((500 * 30) + (200 * 40)) / 700).toFixed(4));
    check(
      'Test 6 (ASIL AC — FIFO katman-üstüste-binme): 700 L ikmal lot A kalanı+lot B\'yi doğru ağırlıklandırıyor',
      dispense2.status === 200 && Math.abs(Number(cost2?.unit_cost_liters) - expectedFifoUnitCost) < 0.0001,
      `beklenen=${expectedFifoUnitCost}, gelen=${cost2?.unit_cost_liters}, total_cost=${cost2?.total_cost}`
    );

    // === Test 7: geriye dönük (offline) kayıt — lot C'den (2026-01-20, 1000 TL) ÖNCEKİ bir tarihte
    // (2026-01-05) senkronlanan bir kayıt, o tarihte VAR OLAN TEK fiyatla (lot A, 30 TL) maliyetlendirilmeli
    // — lot B (2026-01-10) ve lot C (2026-01-20) O TARİHTE henüz gerçekleşmemişti. Yöntem hâlâ FIFO;
    // 2026-01-05 anında kümülatif tüketim 0 (bu senkron kaydından önce hiç dispense yoktu o tarihte) —
    // saf ağırlıklı-ortalama/FIFO ikisi de tek lot'a düştüğünden 30 TL/L vermeli. ===
    const claimCode = await call('POST', '/devices/claim-codes', { token: owner, body: { siteName: SITE_NAME, deviceName: `INV1503 Offline Test ${RUN}` } });
    const offlineDeviceId = `INV1503-OFFLINE-DEV-${RUN}`;
    const claimed = await call('POST', '/devices/claim', { body: { code: claimCode.body?.data?.code, deviceId: offlineDeviceId } });
    const offlineSecret: string = claimed.body?.data?.secret;

    const syncRes = await hwPost(offlineDeviceId, offlineSecret, '/telemetry/sync-batch', {
      records: [{
        localSequenceId: 1,
        deviceTimestamp: '2026-01-05T10:00:00.000Z',
        siteName: SITE_NAME,
        vehiclePlate: VEH_PLATE,
        tankName: TANK_NAME,
        amountLiters: 10
      }]
    });
    const offlineTx = (await q(
      `SELECT unit_cost_liters FROM transactions WHERE device_id = $1 AND local_sequence_id = 1`,
      [offlineDeviceId]
    ))[0];
    check(
      "Test 7 (ASIL AC — geriye dönük kayıt KENDİ tarihindeki fiyatla maliyetlendirilir): 2026-01-05 kaydı 30 TL/L (lot B/C'den ETKİLENMİYOR)",
      syncRes.status === 200 && Number(offlineTx?.unit_cost_liters) === 30,
      `syncStatus=${syncRes.status}, unit_cost_liters=${offlineTx?.unit_cost_liters}, syncBody=${JSON.stringify(syncRes.body)}`
    );

    // === Test 8: hiç dolum geçmişi olmayan bir tank → maliyet NULL (sessizce 0 SAYILMAZ) ===
    const emptyTankId = `tank-inv1503-empty-${RUN}`;
    const emptyTankName = `INV1503-Empty-Tank-${RUN}`;
    await q(`INSERT INTO tanks (id, tenant_id, name, site_name, capacity_liters, current_level_liters, fuel_type) VALUES ($1, 'comp-camsa', $2, $3, 5000, 5000, 'Motorin')`, [emptyTankId, emptyTankName, SITE_NAME]);
    const dispenseNoHistory = await call('POST', '/dispense', {
      token: owner,
      body: { siteName: SITE_NAME, vehiclePlate: VEH2_PLATE, tankName: emptyTankName, amountLiters: 50 }
    });
    check(
      "Test 8: Hiç fiyatlı dolum geçmişi olmayan bir tanktan ikmal → unit_cost_liters NULL (0 DEĞİL)",
      dispenseNoHistory.status === 200 && dispenseNoHistory.body?.data?.unit_cost_liters === null,
      `status=${dispenseNoHistory.status}, unit_cost_liters=${dispenseNoHistory.body?.data?.unit_cost_liters}`
    );

    // Temizlik için FIFO'yu varsayılana geri al.
    await call('PATCH', '/companies/me/fuel-cost-settings', { token: owner, body: { method: 'AGIRLIKLI_ORTALAMA' } });
  } finally {
    await q('DELETE FROM transactions WHERE vehicle_plate LIKE $1', [`INV1503-VEH%-${RUN}`]);
    await q('DELETE FROM fuel_intake_receipts WHERE tank_id = $1', [TANK_ID]);
    await q('DELETE FROM hardware_devices WHERE device_id = $1', [`INV1503-OFFLINE-DEV-${RUN}`]);
    await q('DELETE FROM device_claim_codes WHERE device_name = $1', [`INV1503 Offline Test ${RUN}`]);
    await q('DELETE FROM tanks WHERE id = ANY($1)', [[TANK_ID, `tank-inv1503-empty-${RUN}`]]);
    await q('DELETE FROM users WHERE username = $1', [`inv1503-pump-${RUN}`]);
    await q(`UPDATE companies SET fuel_cost_method = 'AGIRLIKLI_ORTALAMA' WHERE id = 'comp-camsa'`);
    await resetLoginRateLimit();
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
