import { Client } from 'pg';
import Redis from 'ioredis';

/**
 * FUEL-408 — tank dolum (alım irsaliyesi) girişi + stok artışı.
 *
 * CANLI HTTP + doğrudan PG (src import YOK). Kobay tank: 'Gebze Yedek Depo
 * (T-2)' (tank-gebze-2, kapasite 15000). Test SONUNDA (finally) tankın
 * seviyesi/durumu başlangıç değerine geri yazılır ve yaratılan tüm
 * fuel_intake_receipts + audit_logs satırları silinir.
 */

const API_URL = 'http://localhost:5000/api/v1';
const TANK_ID = 'tank-gebze-2';

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
async function tankLevel(): Promise<number> {
  const c = pg(); await c.connect();
  const r = await c.query('SELECT current_level_liters FROM tanks WHERE id = $1', [TANK_ID]);
  await c.end();
  return Number(r.rows[0].current_level_liters);
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [FUEL-408] TANK DOLUM (ALIM İRSALİYESİ) + STOK ARTIŞI');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };

  let startLevel = 0;
  let startStatus = 'GÜVENLİ';
  {
    const c = pg(); await c.connect();
    const r = await c.query('SELECT current_level_liters, status FROM tanks WHERE id = $1', [TANK_ID]);
    startLevel = Number(r.rows[0].current_level_liters);
    startStatus = r.rows[0].status;
    await c.end();
  }
  const createdIds: string[] = [];

  try {
    const owner = await login('camsa');       // COMPANY_OWNER
    const pumpOp = await login('pompa-op-01'); // PUMP_OPERATOR — dolum yetkisi YOK

    // ── Test 1: ölçümsüz dolum → stok beyanla artar, status KAYITLI ─────
    const before1 = await tankLevel();
    const r1 = await call('POST', `/tanks/${TANK_ID}/intakes`, { token: owner, body: {
      supplierName: 'Petrol A.Ş.', waybillNo: 'IRS-408-1', deliveryDate: '2026-09-10', declaredLiters: 1200
    }});
    if (r1.body.data?.receipt?.id) createdIds.push(r1.body.data.receipt.id);
    const after1 = await tankLevel();
    check('Test 1: ölçümsüz dolum (1200 L) → stok +1200, status KAYITLI, measured_* NULL',
      r1.status === 201 && r1.body.data?.receipt?.status === 'KAYITLI' &&
      Math.abs(after1 - (before1 + 1200)) < 0.01 &&
      r1.body.data.receipt.measured_liters === null &&
      Number(r1.body.data.receipt.added_liters) === 1200,
      `status=${r1.status}, önce=${before1}, sonra=${after1}, added=${r1.body.data?.receipt?.added_liters}`);

    // ── Test 2: ölçümlü dolum, beyan≈ölçüm → KAYITLI, fark ~0 ──────────
    const before2 = await tankLevel();
    const r2 = await call('POST', `/tanks/${TANK_ID}/intakes`, { token: owner, body: {
      supplierName: 'Petrol A.Ş.', waybillNo: 'IRS-408-2', deliveryDate: '2026-09-10',
      declaredLiters: 1000, levelBeforeLiters: before2, levelAfterLiters: before2 + 1000
    }});
    if (r2.body.data?.receipt?.id) createdIds.push(r2.body.data.receipt.id);
    const after2 = await tankLevel();
    check('Test 2: ölçümlü dolum, beyan=ölçüm=1000 → KAYITLI, discrepancy≈0, stok +1000',
      r2.status === 201 && r2.body.data?.receipt?.status === 'KAYITLI' &&
      r2.body.data.compared === true &&
      Math.abs(Number(r2.body.data.receipt.measured_liters) - 1000) < 0.01 &&
      Math.abs(Number(r2.body.data.receipt.discrepancy_liters)) < 0.01 &&
      Math.abs(after2 - (before2 + 1000)) < 0.01,
      `status=${r2.status}, measured=${r2.body.data?.receipt?.measured_liters}, disc=${r2.body.data?.receipt?.discrepancy_liters}`);

    // ── Test 3: EKSİK TESLİMAT — ölçüm beyandan %5 az → uyarı ─────────
    const before3 = await tankLevel();
    const r3 = await call('POST', `/tanks/${TANK_ID}/intakes`, { token: owner, body: {
      supplierName: 'Şüpheli Nakliyat', waybillNo: 'IRS-408-3', deliveryDate: '2026-09-10',
      declaredLiters: 3000, levelBeforeLiters: before3, levelAfterLiters: before3 + 2850
    }});
    if (r3.body.data?.receipt?.id) createdIds.push(r3.body.data.receipt.id);
    const after3 = await tankLevel();
    check('Test 3: ölçüm 2850 < beyan 3000 (%-5) → EKSİK_TESLİMAT_UYARISI, stok fiziksel farkla (+2850) artar',
      r3.status === 201 && r3.body.data?.receipt?.status === 'EKSİK_TESLİMAT_UYARISI' &&
      r3.body.data.shortDeliveryAlert === true &&
      Math.abs(Number(r3.body.data.receipt.discrepancy_liters) - (-150)) < 1 &&
      Math.abs(Number(r3.body.data.receipt.discrepancy_pct) - (-5)) < 0.1 &&
      Math.abs(after3 - (before3 + 2850)) < 0.01,
      `status=${r3.body.data?.receipt?.status}, disc=${r3.body.data?.receipt?.discrepancy_liters}, pct=${r3.body.data?.receipt?.discrepancy_pct}, stok Δ=${(after3 - before3).toFixed(2)}`);

    // ── Test 4: küçük fark toleransta → KAYITLI (uyarı YOK) ───────────
    const before4 = await tankLevel();
    const r4 = await call('POST', `/tanks/${TANK_ID}/intakes`, { token: owner, body: {
      supplierName: 'Petrol A.Ş.', waybillNo: 'IRS-408-4', deliveryDate: '2026-09-10',
      declaredLiters: 1000, levelBeforeLiters: before4, levelAfterLiters: before4 + 997, tolerancePct: 0.5
    }});
    if (r4.body.data?.receipt?.id) createdIds.push(r4.body.data.receipt.id);
    check('Test 4: fark %-0.3, tolerans %0.5 → KAYITLI (eksik teslimat uyarısı YOK)',
      r4.status === 201 && r4.body.data?.receipt?.status === 'KAYITLI' && r4.body.data.shortDeliveryAlert === false,
      `status=${r4.body.data?.receipt?.status}, alert=${r4.body.data?.shortDeliveryAlert}`);

    // ── Test 5: sıcaklık düzeltmesi — 25°C beyan 15°C'de DAHA AZ ──────
    const before5 = await tankLevel();
    const r5 = await call('POST', `/tanks/${TANK_ID}/intakes`, { token: owner, body: {
      supplierName: 'Petrol A.Ş.', waybillNo: 'IRS-408-5', deliveryDate: '2026-09-10',
      declaredLiters: 2000, temperatureC: 25
    }});
    if (r5.body.data?.receipt?.id) createdIds.push(r5.body.data.receipt.id);
    const d15 = Number(r5.body.data?.receipt?.declared_liters_15c);
    check('Test 5: 25°C → declared_liters_15c < 2000 (ASTM D1250 VCF<1), ~%1 aralığında',
      r5.status === 201 && d15 < 2000 && d15 > 1960,
      `declared_15c=${d15} (2000 gözlenen, ~1980 beklenir)`);

    // ── Test 6: sıcaklıksız → 15c == beyan (düzeltme yok) ────────────
    const r6 = await call('POST', `/tanks/${TANK_ID}/intakes`, { token: owner, body: {
      supplierName: 'Petrol A.Ş.', waybillNo: 'IRS-408-6', deliveryDate: '2026-09-10', declaredLiters: 500
    }});
    if (r6.body.data?.receipt?.id) createdIds.push(r6.body.data.receipt.id);
    check('Test 6: sıcaklık verilmedi → declared_liters_15c == declared_liters (500)',
      r6.status === 201 && Math.abs(Number(r6.body.data.receipt.declared_liters_15c) - 500) < 0.01,
      `declared_15c=${r6.body.data?.receipt?.declared_liters_15c}`);

    // ── Test 7: kapasite aşımı → 409 TANK_OVERFLOW, stok DEĞİŞMEZ ─────
    const before7 = await tankLevel();
    const r7 = await call('POST', `/tanks/${TANK_ID}/intakes`, { token: owner, body: {
      supplierName: 'Petrol A.Ş.', waybillNo: 'IRS-408-7', deliveryDate: '2026-09-10', declaredLiters: 999999
    }});
    const after7 = await tankLevel();
    check('Test 7: kapasiteyi aşan dolum → 409 TANK_OVERFLOW, tank seviyesi değişmedi',
      r7.status === 409 && r7.body.details?.error === 'TANK_OVERFLOW' && Math.abs(after7 - before7) < 0.01,
      `status=${r7.status}, err=${r7.body.details?.error}, stok Δ=${(after7 - before7).toFixed(2)}`);

    // ── Test 8: listeleme + filtre ──────────────────────────────────
    const r8a = await call('GET', `/tanks/${TANK_ID}/intakes`, { token: owner });
    const r8b = await call('GET', '/fuel-intakes?status=EKSİK_TESLİMAT_UYARISI', { token: owner });
    check('Test 8: GET /tanks/:id/intakes tüm kayıtları, /fuel-intakes?status=... yalnızca uyarılıları döndürür',
      r8a.status === 200 && r8a.body.data.length >= 6 &&
      r8b.status === 200 && r8b.body.data.length >= 1 &&
      r8b.body.data.every((x: any) => x.status === 'EKSİK_TESLİMAT_UYARISI'),
      `tümü=${r8a.body.totalCount}, uyarılı=${r8b.body.totalCount}`);

    // ── Test 9: tekil getirme ──────────────────────────────────────
    const r9 = await call('GET', `/fuel-intakes/${createdIds[0]}`, { token: owner });
    check('Test 9: GET /fuel-intakes/:id kaydı döndürür',
      r9.status === 200 && r9.body.data?.id === createdIds[0] && r9.body.data?.waybill_no === 'IRS-408-1',
      `status=${r9.status}, waybill=${r9.body.data?.waybill_no}`);

    // ── Test 10: Zod doğrulama ─────────────────────────────────────
    const r10a = await call('POST', `/tanks/${TANK_ID}/intakes`, { token: owner, body: { supplierName: 'X', deliveryDate: '2026-09-10', declaredLiters: 100 } });
    const r10b = await call('POST', `/tanks/${TANK_ID}/intakes`, { token: owner, body: { supplierName: 'X', waybillNo: 'W', deliveryDate: '2026-09-10', declaredLiters: 100, levelAfterLiters: 5000 } });
    const r10c = await call('POST', `/tanks/${TANK_ID}/intakes`, { token: owner, body: { supplierName: 'X', waybillNo: 'W', deliveryDate: '10-09-2026', declaredLiters: 100 } });
    check('Test 10: Zod — eksik waybillNo / levelAfter’sız levelBefore / hatalı tarih → 400 VALIDATION_ERROR',
      r10a.status === 400 && r10a.body.error === 'VALIDATION_ERROR' &&
      r10b.status === 400 && r10b.body.error === 'VALIDATION_ERROR' &&
      r10c.status === 400 && r10c.body.error === 'VALIDATION_ERROR',
      `eksikWaybill=${r10a.status}, levelBeforeYok=${r10b.status}, tarih=${r10c.status}`);

    // ── Test 11: RBAC ─────────────────────────────────────────────
    const r11a = await call('POST', `/tanks/${TANK_ID}/intakes`, { token: pumpOp, body: { supplierName: 'X', waybillNo: 'W', deliveryDate: '2026-09-10', declaredLiters: 100 } });
    const r11b = await call('GET', `/tanks/${TANK_ID}/intakes`);
    check('Test 11: RBAC — PUMP_OPERATOR POST → 403, token yok GET → 401',
      r11a.status === 403 && r11b.status === 401,
      `pumpOp=${r11a.status}, tokensiz=${r11b.status}`);

    // ── Test 12: audit log ────────────────────────────────────────
    {
      const c = pg(); await c.connect();
      const r = await c.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id='comp-camsa' AND action='FUEL_INTAKE_RECORDED' AND target_id = ANY($1::text[])",
        [createdIds]
      );
      await c.end();
      check('Test 12: her dolum kaydı için audit_logs’a FUEL_INTAKE_RECORDED yazılır',
        r.rows[0].n === createdIds.length,
        `audit satırı=${r.rows[0].n}, beklenen=${createdIds.length}`);
    }

  } finally {
    const c = pg();
    await c.connect();
    if (createdIds.length) {
      await c.query('DELETE FROM audit_logs WHERE target_id = ANY($1::text[]) AND action = $2', [createdIds, 'FUEL_INTAKE_RECORDED']);
      await c.query('DELETE FROM fuel_intake_receipts WHERE id = ANY($1::text[])', [createdIds]);
    }
    await c.query('DELETE FROM fuel_intake_receipts WHERE waybill_no LIKE $1', ['IRS-408-%']);
    await c.query('UPDATE tanks SET current_level_liters = $1, status = $2 WHERE id = $3', [startLevel, startStatus, TANK_ID]);
    await c.end();
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  await redis.quit();
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => { console.error('💥', err); process.exit(1); });
