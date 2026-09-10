import { Client } from 'pg';
import Redis from 'ioredis';

/**
 * FUEL-409 — teorik vs fiziksel stok mutabakatı + fire hesabı.
 *
 * CANLI HTTP + doğrudan PG (src import YOK). Kobay tank: 'Orman Depo Tankı
 * (T-3)' (tank-orman-1). Ledger (dolum/ikmal/test alımı) satırları geçmiş
 * tarihli pencerelere kontrollü biçimde eklenir; test SONUNDA (finally)
 * yaratılan tüm satırlar temizlenir. Bu test tank seviyesini DEĞİŞTİRMEZ
 * (mutabakat yalnızca okur + stock_reconciliations'a yazar).
 */

const API_URL = 'http://localhost:5000/api/v1';
const TANK_ID = 'tank-orman-1';
const TANK_NAME = 'Orman Depo Tankı (T-3)';
const SITE = 'Orman Şantiyesi';

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
async function resetLoginRl(): Promise<void> {
  const keys = await redis.keys('rl:auth-login:*');
  if (keys.length) await redis.del(...keys);
}
async function call(method: string, path: string, opts: { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
  if (path === '/auth/login') await resetLoginRl();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${API_URL}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function login(username: string): Promise<string> {
  const r = await call('POST', '/auth/login', { body: { username, password: '123456' } });
  if (!r.body.accessToken) throw new Error(`login ${username}: ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [FUEL-409] TEORİK vs FİZİKSEL STOK MUTABAKATI + FİRE');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };
  const createdReconIds: string[] = [];

  // Kontrollü ledger satırlarını 2022-06-01 penceresine ekle.
  const W_START = '2022-06-01T00:00:00.000Z';
  const W_END = '2022-06-02T00:00:00.000Z';
  const W_MID = '2022-06-01T12:00:00.000Z';
  {
    const c = pg(); await c.connect();
    // Önceki (yarım kalmış) koşulardan artıkları temizle — Test 1 "önceki
    // mutabakat yok" varsayımına dayanır.
    await c.query('DELETE FROM stock_reconciliations WHERE tank_id = $1', [TANK_ID]);
    await c.query("DELETE FROM fuel_intake_receipts WHERE id = 'recontest-in-1'");
    await c.query("DELETE FROM transactions WHERE id = 'recontest-tx-1'");
    await c.query("DELETE FROM calibration_test_intakes WHERE id = 'recontest-ti-1'");
    await c.query(
      `INSERT INTO fuel_intake_receipts
        (id, tenant_id, tank_id, tank_name, site_name, supplier_name, waybill_no, delivery_date,
         declared_liters, declared_liters_15c, added_liters, status, created_by, created_at)
       VALUES ('recontest-in-1','comp-camsa',$1,$2,$3,'Petrol A.Ş.','REC-IRS-1','2022-06-01',
               1000,1000,1000,'KAYITLI','usr-camsa-owner',$4)`,
      [TANK_ID, TANK_NAME, SITE, W_MID]
    );
    await c.query(
      `INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, tank_name, amount_liters, created_at)
       VALUES ('recontest-tx-1','comp-camsa',$1,'34 CTP 82',$2,300,$3)`,
      [SITE, TANK_NAME, W_MID]
    );
    await c.query(
      `INSERT INTO calibration_test_intakes
        (id, tenant_id, device_id, tank_name, reference_volume_liters, measured_liters, k_factor_at_test,
         deviation_ratio, proposed_k_factor, requested_by, created_at)
       VALUES ('recontest-ti-1','comp-camsa','ESP32-PUMP-01',$1,20,20,1.0,0.0,1.0,'usr-camsa-owner',$2)`,
      [TANK_NAME, W_MID]
    );
    await c.end();
  }

  try {
    const owner = await login('camsa');
    const pumpOp = await login('pompa-op-01');

    // ── Test 1: önceki mutabakat yok + openingBookLiters yok → 400 ──────
    const r1 = await call('POST', `/tanks/${TANK_ID}/reconciliations`, { token: owner, body: {
      periodType: 'AD_HOC', periodStart: W_START, periodEnd: W_END, physicalLiters: 5680
    }});
    check('Test 1: ilk mutabakat, openingBookLiters verilmedi → 400 OPENING_BOOK_REQUIRED',
      r1.status === 400 && (r1.body.details?.error === 'OPENING_BOOK_REQUIRED' || r1.body.error === 'VALIDATION_ERROR'),
      `status=${r1.status}, err=${r1.body.details?.error || r1.body.error}`);

    // ── Test 2: tam ledger matematiği — 5000 + 1000 − 300 − 20 = 5680 ──
    const r2 = await call('POST', `/tanks/${TANK_ID}/reconciliations`, { token: owner, body: {
      periodType: 'AD_HOC', periodStart: W_START, periodEnd: W_END, physicalLiters: 5680, openingBookLiters: 5000
    }});
    const d2 = r2.body.data?.reconciliation;
    if (d2?.id) createdReconIds.push(d2.id);
    check('Test 2: teorik = 5000 + 1000(dolum) − 300(ikmal) − 20(test) = 5680, fiziksel 5680 → TOLERANS_İÇİ/NORMAL',
      r2.status === 201 &&
      Number(d2.intake_liters) === 1000 && Number(d2.dispensed_liters) === 300 && Number(d2.test_intake_liters) === 20 &&
      Number(d2.closing_book_liters) === 5680 && Number(d2.variance_liters) === 0 &&
      d2.classification === 'TOLERANS_İÇİ' && d2.status === 'NORMAL' && r2.body.data.alarm === false,
      `closing=${d2?.closing_book_liters}, var=${d2?.variance_liters}, sınıf=${d2?.classification}`);

    // ── Test 3: doğal buharlaşma — 30 günlük dönemde %-1.15 kayıp ─────
    const r3 = await call('POST', `/tanks/${TANK_ID}/reconciliations`, { token: owner, body: {
      periodType: 'MONTHLY',
      periodStart: '2023-01-01T00:00:00.000Z', periodEnd: '2023-01-31T00:00:00.000Z',
      openingBookLiters: 5000, physicalLiters: 4942.5  // -1.15% → tolerans %1 + buharlaşma payı %0.2
    }});
    const d3 = r3.body.data?.reconciliation;
    if (d3?.id) createdReconIds.push(d3.id);
    check('Test 3: 30 günde %-1.15 kayıp (tolerans %1 + buharlaşma payı %0.2 içinde) → BUHARLAŞMA/NORMAL',
      r3.status === 201 && Math.abs(Number(d3.variance_pct) - (-1.15)) < 0.02 &&
      Math.abs(Number(d3.evaporation_allowance_pct) - 0.2) < 0.001 &&
      d3.classification === 'BUHARLAŞMA' && d3.status === 'NORMAL',
      `var%=${d3?.variance_pct}, buharlaşma payı=${d3?.evaporation_allowance_pct}, sınıf=${d3?.classification}`);

    // ── Test 4: açıklanamayan kayıp — 1 günde %-5 → ALARM ────────────
    const r4 = await call('POST', `/tanks/${TANK_ID}/reconciliations`, { token: owner, body: {
      periodType: 'DAILY',
      periodStart: '2023-02-01T00:00:00.000Z', periodEnd: '2023-02-02T00:00:00.000Z',
      openingBookLiters: 5000, physicalLiters: 4750  // -5%
    }});
    const d4 = r4.body.data?.reconciliation;
    if (d4?.id) createdReconIds.push(d4.id);
    check('Test 4: 1 günde %-5 kayıp (buharlaşma payını çok aşar) → AÇIKLANAMAYAN/MUTABAKAT_ALARMI',
      r4.status === 201 && Math.abs(Number(d4.variance_pct) - (-5)) < 0.01 &&
      d4.classification === 'AÇIKLANAMAYAN' && d4.status === 'MUTABAKAT_ALARMI' && r4.body.data.alarm === true,
      `var%=${d4?.variance_pct}, sınıf=${d4?.classification}, status=${d4?.status}`);

    // ── Test 5: fiziksel > teorik → ÖLÇÜM_HATASI/ALARM ──────────────
    const r5 = await call('POST', `/tanks/${TANK_ID}/reconciliations`, { token: owner, body: {
      periodType: 'DAILY',
      periodStart: '2023-03-01T00:00:00.000Z', periodEnd: '2023-03-02T00:00:00.000Z',
      openingBookLiters: 5000, physicalLiters: 5200  // +4% — yakıt kazanılamaz
    }});
    const d5 = r5.body.data?.reconciliation;
    if (d5?.id) createdReconIds.push(d5.id);
    check('Test 5: fiziksel 5200 > teorik 5000 → ÖLÇÜM_HATASI/MUTABAKAT_ALARMI',
      r5.status === 201 && Number(d5.variance_liters) === 200 &&
      d5.classification === 'ÖLÇÜM_HATASI' && d5.status === 'MUTABAKAT_ALARMI',
      `var=${d5?.variance_liters}, sınıf=${d5?.classification}`);

    // ── Test 6: önceki mutabakat zinciri — opening otomatik seçilir ──
    const rA = await call('POST', `/tanks/${TANK_ID}/reconciliations`, { token: owner, body: {
      periodType: 'AD_HOC', periodStart: '2024-01-01T00:00:00.000Z', periodEnd: '2024-01-02T00:00:00.000Z',
      openingBookLiters: 6000, physicalLiters: 6000
    }});
    if (rA.body.data?.reconciliation?.id) createdReconIds.push(rA.body.data.reconciliation.id);
    const rB = await call('POST', `/tanks/${TANK_ID}/reconciliations`, { token: owner, body: {
      periodType: 'AD_HOC', periodStart: '2024-01-02T00:00:00.000Z', periodEnd: '2024-01-03T00:00:00.000Z',
      physicalLiters: 6000  // openingBookLiters YOK → önceki mutabakatın fizikselinden (6000)
    }});
    const dB = rB.body.data?.reconciliation;
    if (dB?.id) createdReconIds.push(dB.id);
    check('Test 6: openingBookLiters verilmedi → bir önceki mutabakatın physical_liters (6000) açılış olur',
      rB.status === 201 && Number(dB.opening_book_liters) === 6000 && Number(dB.closing_book_liters) === 6000 &&
      dB.classification === 'TOLERANS_İÇİ',
      `opening=${dB?.opening_book_liters}, closing=${dB?.closing_book_liters}`);

    // ── Test 7: 15°C düzeltmesi raporlanır, VARYANS gözlenen bazda ──
    const r7 = await call('POST', `/tanks/${TANK_ID}/reconciliations`, { token: owner, body: {
      periodType: 'AD_HOC', periodStart: '2024-02-01T00:00:00.000Z', periodEnd: '2024-02-02T00:00:00.000Z',
      openingBookLiters: 5000, physicalLiters: 5000, physicalTempC: 25
    }});
    const d7 = r7.body.data?.reconciliation;
    if (d7?.id) createdReconIds.push(d7.id);
    check('Test 7: tempC=25 → physical_liters_15c < 5000 (ASTM D1250) ama varyans gözlenen bazda 0 → TOLERANS_İÇİ',
      r7.status === 201 && Number(d7.physical_liters_15c) < 5000 && Number(d7.physical_liters_15c) > 4900 &&
      Number(d7.variance_liters) === 0 && d7.classification === 'TOLERANS_İÇİ',
      `phys15c=${d7?.physical_liters_15c}, var=${d7?.variance_liters}`);

    // ── Test 8: listeleme + alarm filtresi ─────────────────────────
    const r8a = await call('GET', `/tanks/${TANK_ID}/reconciliations`, { token: owner });
    const r8b = await call('GET', '/stock-reconciliations?status=MUTABAKAT_ALARMI', { token: owner });
    check('Test 8: GET /tanks/:id/reconciliations tümünü, ?status=MUTABAKAT_ALARMI yalnızca alarmları döndürür',
      r8a.status === 200 && r8a.body.data.length >= 7 &&
      r8b.status === 200 && r8b.body.data.length >= 2 &&
      r8b.body.data.every((x: any) => x.status === 'MUTABAKAT_ALARMI'),
      `tümü=${r8a.body.totalCount}, alarm=${r8b.body.totalCount}`);

    // ── Test 9: tekil getirme ─────────────────────────────────────
    const r9 = await call('GET', `/stock-reconciliations/${createdReconIds[0]}`, { token: owner });
    check('Test 9: GET /stock-reconciliations/:id kaydı döndürür',
      r9.status === 200 && r9.body.data?.id === createdReconIds[0] && r9.body.data?.tank_id === TANK_ID,
      `status=${r9.status}, tank=${r9.body.data?.tank_id}`);

    // ── Test 10: Zod ─────────────────────────────────────────────
    const r10a = await call('POST', `/tanks/${TANK_ID}/reconciliations`, { token: owner, body: { periodType: 'YEARLY', physicalLiters: 100 } });
    const r10b = await call('POST', `/tanks/${TANK_ID}/reconciliations`, { token: owner, body: { periodType: 'AD_HOC', physicalLiters: 100 } });
    const r10c = await call('POST', `/tanks/${TANK_ID}/reconciliations`, { token: owner, body: { periodType: 'DAILY' } });
    check('Test 10: Zod — geçersiz periodType / AD_HOC pencere yok / physicalLiters yok → 400 VALIDATION_ERROR',
      r10a.status === 400 && r10a.body.error === 'VALIDATION_ERROR' &&
      r10b.status === 400 && r10b.body.error === 'VALIDATION_ERROR' &&
      r10c.status === 400 && r10c.body.error === 'VALIDATION_ERROR',
      `periodType=${r10a.status}, adhoc=${r10b.status}, physYok=${r10c.status}`);

    // ── Test 11: RBAC ───────────────────────────────────────────
    const r11a = await call('POST', `/tanks/${TANK_ID}/reconciliations`, { token: pumpOp, body: {
      periodType: 'DAILY', openingBookLiters: 5000, physicalLiters: 5000
    }});
    const r11b = await call('GET', '/stock-reconciliations');
    check('Test 11: RBAC — PUMP_OPERATOR POST → 403, token yok GET → 401',
      r11a.status === 403 && r11b.status === 401, `pumpOp=${r11a.status}, tokensiz=${r11b.status}`);

    // ── Test 12: audit log ──────────────────────────────────────
    {
      const c = pg(); await c.connect();
      const r = await c.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id='comp-camsa' AND action='STOCK_RECONCILIATION' AND target_id = ANY($1::text[])",
        [createdReconIds]
      );
      await c.end();
      check('Test 12: her mutabakat kaydı için audit_logs’a STOCK_RECONCILIATION yazılır',
        r.rows[0].n === createdReconIds.length, `audit=${r.rows[0].n}, beklenen=${createdReconIds.length}`);
    }

  } finally {
    const c = pg();
    await c.connect();
    if (createdReconIds.length) {
      await c.query('DELETE FROM audit_logs WHERE action = $1 AND target_id = ANY($2::text[])', ['STOCK_RECONCILIATION', createdReconIds]);
      await c.query('DELETE FROM stock_reconciliations WHERE id = ANY($1::text[])', [createdReconIds]);
    }
    await c.query("DELETE FROM stock_reconciliations WHERE tank_id = $1 AND created_by = 'system-daily-reconciler'", [TANK_ID]);
    await c.query("DELETE FROM fuel_intake_receipts WHERE id = 'recontest-in-1'");
    await c.query("DELETE FROM transactions WHERE id = 'recontest-tx-1'");
    await c.query("DELETE FROM calibration_test_intakes WHERE id = 'recontest-ti-1'");
    await c.end();
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  await redis.quit();
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => { console.error('💥', err); process.exit(1); });
