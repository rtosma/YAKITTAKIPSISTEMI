import crypto from 'crypto';
import { Client } from 'pg';
import Redis from 'ioredis';
import { resolveFuelType, areFuelTypesCompatible } from '../src/fuel/fuelTypes'; // saf — config yüklemez

/**
 * FUEL-407 — çoklu tank/pompa/yakıt tipi: yanlış yakıt reddi, pompa-tank
 * eşlemesi, yakıt tipi bazlı stok. CANLI HTTP + HMAC donanım + doğrudan PG.
 *
 * Kobay: cihaz ESP32-PUMP-01 (Gebze Ana Şantiye), kart CARD-881201
 * (drv-1 Ahmet Yılmaz), araç veh-1 (34 CTP 82). Test SONUNDA veh-1 alanları
 * ve cihaz tank eşlemesi seed değerlerine döndürülür.
 */

const API_URL = 'http://localhost:5000/api/v1';
const DEVICE_ID = 'ESP32-PUMP-01';
const DEVICE_SECRET = process.env.HW_SECRET_ESP32_PUMP_01 || 'secret_gebze_pump_8849';
const CARD = 'CARD-881201';
const TANK_MOTORIN = 'Gebze Ana Tank (T-1)';   // Motorin (Euro Diesel)
const TANK_MOTORIN_2 = 'Gebze Yedek Depo (T-2)'; // Motorin (Euro Diesel)

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
async function call(method: string, path: string, opts: { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
  if (path === '/auth/login') await resetLoginRl();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${API_URL}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function login(u: string): Promise<string> {
  const r = await call('POST', '/auth/login', { body: { username: u, password: '123456' } });
  if (!r.body.accessToken) throw new Error(`login ${u}: ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
}
function sign(ts: string, nonce: string, raw: string): string {
  return crypto.createHmac('sha256', DEVICE_SECRET).update(`${ts}.${nonce}.${raw}`).digest('hex');
}
async function requestAuth(tankName: string): Promise<{ status: number; error?: string; body: any }> {
  const body = { rfidCardId: CARD, tankName };
  const raw = JSON.stringify(body);
  const ts = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const res = await fetch(`${API_URL}/dispense/request-auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-ID': DEVICE_ID, 'X-Timestamp': ts, 'X-Nonce': nonce, 'X-Hardware-Signature': sign(ts, nonce, raw) },
    body: raw
  });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, error: j?.details?.error ?? j?.error, body: j };
}
async function clearSession(): Promise<void> {
  await redis.del(`dispense:session:${DEVICE_ID}`);
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [FUEL-407] ÇOKLU TANK/POMPA/YAKIT TİPİ + YANLIŞ YAKIT REDDİ');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };

  // Başlangıç durumunu sakla + kobay kurulumu.
  const before = (await q("SELECT assigned_driver_name, fuel_type, status FROM vehicles WHERE id='veh-1'"))[0];
  const tankBefore = (await q("SELECT current_level_liters, status FROM tanks WHERE id='tank-gebze-1'"))[0];
  await q("UPDATE vehicles SET assigned_driver_name='Ahmet Yılmaz', status='AKTİF', site_name='Gebze Ana Şantiye', fuel_type='Benzin' WHERE id='veh-1'");
  await q("UPDATE hardware_devices SET tank_name = NULL WHERE device_id=$1", [DEVICE_ID]);
  await clearSession();
  await q("DELETE FROM transactions WHERE id LIKE 'fuel407-tx-%'");
  await q("DELETE FROM vehicles WHERE plate = '34 XFT 407'");

  try {
    const owner = await login('camsa');
    const pumpOp = await login('pompa-op-01');

    // ── Test 1: saf yakıt tipi mantığı (unit) ────────────────────
    check('Test 1: resolveFuelType/areFuelTypesCompatible — grup eşleme + uyum kuralı doğru',
      resolveFuelType('Motorin (Euro Diesel)').group === 'MOTORIN' &&
      resolveFuelType('Kurşunsuz 95').group === 'BENZIN' &&
      resolveFuelType('AdBlue').group === 'ADBLUE' && resolveFuelType('AdBlue').isFuel === false &&
      !areFuelTypesCompatible('Benzin', 'Motorin (Euro Diesel)') &&
      areFuelTypesCompatible('Motorin', 'Motorin (Euro Diesel)') &&
      areFuelTypesCompatible(null, 'Motorin') && areFuelTypesCompatible('Bilinmeyen', 'Motorin'),
      `benzin↔motorin=${areFuelTypesCompatible('Benzin', 'Motorin')}, adblue.isFuel=${resolveFuelType('AdBlue').isFuel}`);

    // ── Test 2: yanlış yakıt tipi → request-auth reddi (AC) ──────
    const r2 = await requestAuth(TANK_MOTORIN);
    check('Test 2: Benzin aracı Motorin tankından ikmal isteyince → 403 FUEL_TYPE_MISMATCH',
      r2.status === 403 && r2.error === 'FUEL_TYPE_MISMATCH', `status=${r2.status}, err=${r2.error}`);

    // ── Test 3: uyumlu yakıt tipi → geçer ───────────────────────
    await q("UPDATE vehicles SET fuel_type='Motorin' WHERE id='veh-1'");
    await clearSession();
    const r3 = await requestAuth(TANK_MOTORIN);
    check('Test 3: araç Motorin olunca aynı istek → 200 (oturum açılır)',
      r3.status === 200 && r3.body.success === true, `status=${r3.status}`);

    // ── Test 4: araç yakıt tipi NULL → kısıt yok ────────────────
    await q("UPDATE vehicles SET fuel_type = NULL WHERE id='veh-1'");
    await clearSession();
    const r4 = await requestAuth(TANK_MOTORIN);
    check('Test 4: araç fuel_type NULL → uyum kontrolü atlanır, 200',
      r4.status === 200, `status=${r4.status}`);

    // ── Test 5: transactions.fuel_type tanktan kopyalanır ───────
    await q("UPDATE vehicles SET fuel_type='Motorin' WHERE id='veh-1'");
    const r5 = await call('POST', '/dispense', { token: owner, body: {
      siteName: 'Gebze Ana Şantiye', vehiclePlate: '34 CTP 82', driverName: 'Ahmet Yılmaz',
      tankName: TANK_MOTORIN, amountLiters: 40, type: 'Manuel'
    }});
    const txRow = (await q("SELECT fuel_type FROM transactions WHERE tank_name=$1 ORDER BY created_at DESC LIMIT 1", [TANK_MOTORIN]))[0];
    check('Test 5: POST /dispense → transactions.fuel_type = tankın yakıt tipi (Motorin (Euro Diesel))',
      r5.status === 200 && txRow?.fuel_type === 'Motorin (Euro Diesel)', `dispense=${r5.status}, txFuelType=${txRow?.fuel_type}`);

    // ── Test 6: pompa-tank eşlemesi ────────────────────────────
    const m6a = await call('PATCH', `/hardware-devices/${DEVICE_ID}/tank`, { token: owner, body: { tankName: TANK_MOTORIN } });
    await clearSession();
    const r6mismatch = await requestAuth(TANK_MOTORIN_2); // eşleme T-1, istek T-2
    await clearSession();
    const r6match = await requestAuth(TANK_MOTORIN);       // eşleme ile aynı
    const m6b = await call('PATCH', `/hardware-devices/${DEVICE_ID}/tank`, { token: owner, body: { tankName: null } });
    await clearSession();
    const r6cleared = await requestAuth(TANK_MOTORIN_2);   // eşleme yok → serbest
    check('Test 6: eşleme varken farklı tank → 409 DEVICE_TANK_MISMATCH; aynı tank → 200; eşleme kaldırılınca → 200',
      m6a.status === 200 && m6a.body.data?.tankName === TANK_MOTORIN &&
      r6mismatch.status === 409 && r6mismatch.error === 'DEVICE_TANK_MISMATCH' &&
      r6match.status === 200 && m6b.status === 200 && r6cleared.status === 200,
      `map=${m6a.status}, mismatch=${r6mismatch.status}/${r6mismatch.error}, match=${r6match.status}, cleared=${r6cleared.status}`);
    await clearSession();

    // ── Test 7: araç yakıt tipi API üzerinden ──────────────────
    const p7 = await call('PUT', '/vehicles/veh-1', { token: owner, body: { fuelType: 'Benzin' } });
    const g7 = await call('GET', '/vehicles', { token: owner });
    const veh1 = (g7.body.data || g7.body.vehicles || []).find((v: any) => v.id === 'veh-1');
    const c7 = await call('POST', '/vehicles', { token: owner, body: {
      plate: '34 XFT 407', brandModel: 'Test Kamyon', type: 'Kamyon', rfidTag: 'TAG-XFT-407',
      fuelCapacityLiters: 200, siteName: 'Gebze Ana Şantiye', fuelType: 'Motorin'
    }});
    check('Test 7: PUT /vehicles fuelType güncellenir (GET yansıtır); POST /vehicles fuelType ile oluşur',
      p7.status === 200 && veh1?.fuel_type === 'Benzin' &&
      c7.status === 200 && c7.body.data?.fuel_type === 'Motorin',
      `put=${p7.status}, get.fuelType=${veh1?.fuel_type}, post.fuelType=${c7.body.data?.fuel_type}`);

    // ── Test 8: yakıt tipi bazlı stok özeti ───────────────────
    const r8 = await call('GET', '/fuel-stock-summary?days=30', { token: owner });
    const motorin = (r8.body.data?.byFuelType || []).find((x: any) => x.fuelType === 'Motorin (Euro Diesel)');
    check('Test 8: GET /fuel-stock-summary → Motorin (Euro Diesel) satırı: grup MOTORIN, tankCount≥4, stok>0',
      r8.status === 200 && Array.isArray(r8.body.data?.byFuelType) && !!motorin &&
      motorin.group === 'MOTORIN' && motorin.tankCount >= 4 && motorin.currentStockLiters > 0 && motorin.dispensedLiters >= 40,
      `motorin=${JSON.stringify(motorin && { g: motorin.group, tanks: motorin.tankCount, stock: motorin.currentStockLiters, disp: motorin.dispensedLiters })}`);

    // ── Test 9: Zod + RBAC ────────────────────────────────────
    const z1 = await call('PATCH', `/hardware-devices/${DEVICE_ID}/tank`, { token: owner, body: {} });
    const z2 = await call('GET', '/fuel-stock-summary?days=0', { token: owner });
    const rb1 = await call('PATCH', `/hardware-devices/${DEVICE_ID}/tank`, { token: pumpOp, body: { tankName: TANK_MOTORIN } });
    const rb2 = await call('GET', '/fuel-stock-summary');
    check('Test 9: Zod (tankName eksik / days=0 → 400); RBAC (PUMP_OPERATOR PATCH → 403, tokensiz GET → 401)',
      z1.status === 400 && z2.status === 400 && rb1.status === 403 && rb2.status === 401,
      `zod=${z1.status}/${z2.status}, rbac=${rb1.status}/${rb2.status}`);

    // ── Test 10: audit log ────────────────────────────────────
    {
      const rows = await q("SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id='comp-camsa' AND action='DEVICE_TANK_MAPPED' AND created_at > NOW() - INTERVAL '10 minutes'");
      check('Test 10: pompa-tank eşleme değişiklikleri audit_logs’a DEVICE_TANK_MAPPED olarak yazılır',
        rows[0].n >= 2, `audit=${rows[0].n}`);
    }

  } finally {
    await q("UPDATE vehicles SET assigned_driver_name=$1, fuel_type=$2, status=$3 WHERE id='veh-1'",
      [before?.assigned_driver_name ?? null, before?.fuel_type ?? null, before?.status ?? 'AKTİF']);
    await q("UPDATE hardware_devices SET tank_name = NULL WHERE device_id=$1", [DEVICE_ID]);
    await q("DELETE FROM transactions WHERE tank_name=$1 AND type='Manuel' AND amount_liters=40 AND created_at > NOW() - INTERVAL '15 minutes'", [TANK_MOTORIN]);
    await q("UPDATE tanks SET current_level_liters=$1, status=$2 WHERE id='tank-gebze-1'", [tankBefore?.current_level_liters ?? 14830, tankBefore?.status ?? 'GÜVENLİ']);
    await q("DELETE FROM vehicles WHERE plate = '34 XFT 407'");
    await q("DELETE FROM audit_logs WHERE tenant_id='comp-camsa' AND action='DEVICE_TANK_MAPPED' AND created_at > NOW() - INTERVAL '30 minutes'");
    await clearSession();
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  await redis.quit();
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => { console.error('💥', err); process.exit(1); });
