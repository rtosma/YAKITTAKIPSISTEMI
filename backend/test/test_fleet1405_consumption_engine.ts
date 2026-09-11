import { Client } from 'pg';
import Redis from 'ioredis';

/**
 * FLEET-1405 — L/100km ve L/motor-saat tüketim hesap motoru.
 *
 * CANLI HTTP + doğrudan PG. Kobaylar: veh-1 (34 CTP 82, Kamyon→KM),
 * veh-2 (34 BKT 19, Ekskavatör→MOTOR_SAAT). "Şimdi" ne olursa olsun trend
 * testinin kaymaması için son 3 takvim ayı (bu ay ve önceki 2 ay) kullanılır.
 * Test SONUNDA yaratılan tüm sayaç okumaları + işlemler temizlenir.
 */

const API_URL = 'http://localhost:5000/api/v1';
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
  const c = pg(); await c.connect(); const r = await c.query(sql, params); await c.end(); return r.rows;
}
async function resetLoginRl(): Promise<void> {
  const k = await redis.keys('rl:auth-login:*'); if (k.length) await redis.del(...k);
}
async function call(method: string, path: string, opts: { token?: string } = {}): Promise<{ status: number; body: any }> {
  if (path === '/auth/login') await resetLoginRl();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${API_URL}${path}`, { method, headers });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function login(u: string): Promise<string> {
  const r = await fetch(`${API_URL}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: '123456' }) });
  await resetLoginRl();
  const j = await r.json();
  if (!j.accessToken) throw new Error(`login ${u}: ${JSON.stringify(j)}`);
  return j.accessToken;
}

// "Şimdi"ye göre N ay önce, 'YYYY-MM'.
function monthLabel(monthsAgo: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 15));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function isoAt(monthsAgo: number, day: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, day, 0, 0, 0)).toISOString();
}

const M2 = monthLabel(2); // 2 ay önce ("Haziran")
const M1 = monthLabel(1); // 1 ay önce ("Temmuz")
const M0 = monthLabel(0); // bu ay ("Ağustos"/şimdi)
const M_NEXT = monthLabel(-1); // önceki ayın bir sonrası — veri girilmeyecek dönem

async function run() {
  console.log('===========================================================');
  console.log('🧪 [FLEET-1405] L/100km VE L/MOTOR-SAAT TÜKETİM HESAP MOTORU');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };

  const cleanup = async () => {
    await q("DELETE FROM vehicle_meter_readings WHERE vehicle_id IN ('veh-1','veh-2') AND id LIKE 'fleet1405-%'");
    await q("DELETE FROM transactions WHERE id LIKE 'fleet1405-tx-%'");
  };
  await cleanup();

  // ── Kurulum: veh-1 (KM) — 2 ay önce 200000, 1 ay önce 200300 (+300),
  //    bu ay 200800 (+500). veh-2 (MOTOR_SAAT) — 2 ay önce 500, bu ay 540 (+40).
  await q(
    `INSERT INTO vehicle_meter_readings (id, tenant_id, vehicle_id, vehicle_plate, meter_type, reading_value, reading_at, period_label, source, entered_by)
     VALUES
       ('fleet1405-v1-m2','comp-camsa','veh-1','34 CTP 82','KM',200000,$1,$2,'MANUEL','usr-camsa-owner'),
       ('fleet1405-v1-m1','comp-camsa','veh-1','34 CTP 82','KM',200300,$3,$4,'MANUEL','usr-camsa-owner'),
       ('fleet1405-v1-m0','comp-camsa','veh-1','34 CTP 82','KM',200800,$5,$6,'MANUEL','usr-camsa-owner'),
       ('fleet1405-v2-m2','comp-camsa','veh-2','34 BKT 19','MOTOR_SAAT',500,$1,$2,'MANUEL','usr-camsa-owner'),
       ('fleet1405-v2-m0','comp-camsa','veh-2','34 BKT 19','MOTOR_SAAT',540,$5,$6,'MANUEL','usr-camsa-owner')`,
    [isoAt(2, 15), M2, isoAt(1, 20), M1, isoAt(0, 20), M0]
  );
  await q(
    `INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, amount_liters, created_at) VALUES
       ('fleet1405-tx-v1-m1a','comp-camsa','Gebze Ana Şantiye','34 CTP 82',20,$1),
       ('fleet1405-tx-v1-m1b','comp-camsa','Gebze Ana Şantiye','34 CTP 82',10,$1),
       ('fleet1405-tx-v1-m0','comp-camsa','Gebze Ana Şantiye','34 CTP 82',25,$2),
       ('fleet1405-tx-v2-m0','comp-camsa','Gebze Ana Şantiye','34 BKT 19',80,$2)`,
    [isoAt(1, 22), isoAt(0, 22)]
  );

  try {
    const owner = await login('camsa');
    const siteMgr = await login('gebze-santiye');
    const pumpOp = await login('pompa-op-01');

    // ── Test 1: tek araç, KM — L/100km doğru hesaplanır (AC) ─────
    const r1 = await call('GET', `/fleet/consumption?periodLabel=${M0}&vehicleId=veh-1`, { token: owner });
    const v1 = r1.body.data?.vehicles?.[0];
    check('Test 1: veh-1, bu ay: +500 km, 25 L → 5.0 L/100km, status HESAPLANDI',
      r1.status === 200 && v1?.status === 'HESAPLANDI' && v1?.usageAmount === 500 && v1?.fuelLiters === 25 && v1?.consumptionPer100Unit === 5,
      `status=${v1?.status}, usage=${v1?.usageAmount}, fuel=${v1?.fuelLiters}, L100=${v1?.consumptionPer100Unit}`);

    // ── Test 2: tek araç, MOTOR_SAAT — L/saat doğru hesaplanır (AC) ─
    const r2 = await call('GET', `/fleet/consumption?periodLabel=${M0}&vehicleId=veh-2`, { token: owner });
    const v2 = r2.body.data?.vehicles?.[0];
    check('Test 2: veh-2 (Ekskavatör), bu ay: +40 motor-saat, 80 L → 2.0 L/saat',
      r2.status === 200 && v2?.meterType === 'MOTOR_SAAT' && v2?.usageAmount === 40 && v2?.consumptionPerHour === 2 && v2?.consumptionPer100Unit === null,
      `meterType=${v2?.meterType}, usage=${v2?.usageAmount}, L/saat=${v2?.consumptionPerHour}`);

    // ── Test 3: geçen ay (1 ay önce) da doğru hesaplanır ─────────
    const r3 = await call('GET', `/fleet/consumption?periodLabel=${M1}&vehicleId=veh-1`, { token: owner });
    const v3 = r3.body.data?.vehicles?.[0];
    check('Test 3: veh-1, geçen ay: +300 km, 30 L (20+10) → 10.0 L/100km',
      r3.status === 200 && v3?.usageAmount === 300 && v3?.fuelLiters === 30 && v3?.consumptionPer100Unit === 10,
      `usage=${v3?.usageAmount}, fuel=${v3?.fuelLiters}, L100=${v3?.consumptionPer100Unit}`);

    // ── Test 4: eksik sayaç verisi → EKSIK_VERI, hesaba katılmaz (AC) ─
    const r4 = await call('GET', `/fleet/consumption?periodLabel=${M_NEXT}&vehicleId=veh-1`, { token: owner });
    const v4 = r4.body.data?.vehicles?.[0];
    check('Test 4: gelecek ay için sayaç girilmedi → EKSIK_VERI, consumptionPer100Unit=null, dışlanmış',
      r4.status === 200 && v4?.status === 'EKSIK_VERI' && v4?.consumptionPer100Unit === null,
      `status=${v4?.status}`);

    // ── Test 5: sıfır/negatif kullanım → GECERSIZ_VERI ──────────
    await q(
      `INSERT INTO vehicle_meter_readings (id, tenant_id, vehicle_id, vehicle_plate, meter_type, reading_value, reading_at, period_label, source, entered_by)
       VALUES ('fleet1405-v1-next','comp-camsa','veh-1','34 CTP 82','KM',200800,$1,$2,'MANUEL','usr-camsa-owner')`,
      [isoAt(-1, 5), M_NEXT]
    );
    const r5 = await call('GET', `/fleet/consumption?periodLabel=${M_NEXT}&vehicleId=veh-1`, { token: owner });
    const v5 = r5.body.data?.vehicles?.[0];
    check('Test 5: dönem sonu = dönem başı (Δ=0) → GECERSIZ_VERI, tahmini değer üretilmez',
      r5.status === 200 && v5?.status === 'GECERSIZ_VERI' && v5?.usageAmount === 0 && v5?.consumptionPer100Unit === null,
      `status=${v5?.status}, usage=${v5?.usageAmount}`);
    await q("DELETE FROM vehicle_meter_readings WHERE id = 'fleet1405-v1-next'");

    // ── Test 6: filo geneli rapor (vehicleId'siz) ───────────────
    const r6 = await call('GET', `/fleet/consumption?periodLabel=${M0}`, { token: siteMgr });
    check('Test 6: vehicleId verilmeden → tüm aktif filo, veh-1/veh-2 arasında computed sayılır',
      r6.status === 200 && Array.isArray(r6.body.data?.vehicles) && r6.body.data.computed >= 2 &&
      r6.body.data.vehicles.some((v: any) => v.vehicleId === 'veh-1' && v.status === 'HESAPLANDI') &&
      r6.body.data.vehicles.some((v: any) => v.vehicleId === 'veh-2' && v.status === 'HESAPLANDI'),
      `computed=${r6.body.data?.computed}, excluded=${r6.body.data?.excluded}`);

    // ── Test 7: araç tipi bazında ortalama + sapma (AC) ─────────
    const r7 = await call('GET', `/fleet/consumption/comparison?periodLabel=${M0}&groupBy=vehicle_type`, { token: owner });
    const kamyon = (r7.body.data?.groups || []).find((g: any) => g.group === 'Kamyon');
    const ekskavator = (r7.body.data?.groups || []).find((g: any) => g.group === 'Ekskavatör');
    check('Test 7: groupBy=vehicle_type → Kamyon ort=5.0 (veh-1), Ekskavatör ort=2.0 (veh-2)',
      r7.status === 200 && kamyon?.average === 5 && kamyon?.meterType === 'KM' &&
      ekskavator?.average === 2 && ekskavator?.meterType === 'MOTOR_SAAT',
      `kamyon=${JSON.stringify(kamyon)}, ekskavator=${JSON.stringify(ekskavator)}`);

    // ── Test 8: trend — son 3 ay, eksik dönem null, % değişim ───
    const r8 = await call('GET', `/fleet/consumption/trend?vehicleId=veh-1&periods=3`, { token: owner });
    const pts = r8.body.data?.points || [];
    const pM1 = pts.find((p: any) => p.periodLabel === M1);
    const pM0 = pts.find((p: any) => p.periodLabel === M0);
    check('Test 8: trend[geçen ay]=10.0, trend[bu ay]=5.0 (%-50 değişim), 3 nokta sırayla',
      r8.status === 200 && pts.length === 3 && pM1?.value === 10 && pM0?.value === 5 && pM0?.changePct === -50,
      `points=${JSON.stringify(pts)}`);

    // ── Test 9: Zod + RBAC ──────────────────────────────────
    const z1 = await call('GET', '/fleet/consumption?periodLabel=2026', { token: owner });
    const z2 = await call('GET', '/fleet/consumption/trend?vehicleId=veh-1&periods=1', { token: owner });
    const z3 = await call('GET', '/fleet/consumption/trend', { token: owner });
    const rb1 = await call('GET', `/fleet/consumption?periodLabel=${M0}`, { token: pumpOp });
    const rb2 = await call('GET', '/fleet/consumption');
    check('Test 9: Zod (bozuk periodLabel / periods=1 / vehicleId yok → 400); RBAC (PUMP_OPERATOR → 403, tokensiz → 401)',
      z1.status === 400 && z2.status === 400 && z3.status === 400 && rb1.status === 403 && rb2.status === 401,
      `zod=${z1.status}/${z2.status}/${z3.status}, rbac=${rb1.status}/${rb2.status}`);

    // ── Test 10: olmayan araç → 404 ─────────────────────────
    const r10 = await call('GET', `/fleet/consumption?periodLabel=${M0}&vehicleId=yok-boyle-arac`, { token: owner });
    check('Test 10: olmayan vehicleId → 404 VEHICLE_NOT_FOUND', r10.status === 404 && r10.body.details?.error === 'VEHICLE_NOT_FOUND', `status=${r10.status}`);

  } finally {
    await cleanup();
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  await redis.quit();
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => { console.error('💥', err); process.exit(1); });
