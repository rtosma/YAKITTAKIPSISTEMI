import crypto from 'crypto';
import { Client } from 'pg';
import Redis from 'ioredis';

/**
 * FLEET-1406 — araç bazlı dönemsel (günlük/haftalık/aylık) yakıt limiti.
 *
 * CANLI HTTP + HMAC donanım (request-auth) + doğrudan PG. Kobay: veh-1
 * (34 CTP 82, sürücü Ahmet Yılmaz / CARD-881201, cihaz ESP32-PUMP-01, tank
 * 'Gebze Ana Tank (T-1)'). Test SONUNDA veh-1 alanları + limit kaydı +
 * kontrollü işlemler + VEHICLE_LIMIT_EXCEEDED alarmı + audit temizlenir.
 */

const API_URL = 'http://localhost:5000/api/v1';
const DEVICE_ID = 'ESP32-PUMP-01';
const DEVICE_SECRET = process.env.HW_SECRET_ESP32_PUMP_01 || 'secret_gebze_pump_8849';
const CARD = 'CARD-881201';
const TANK = 'Gebze Ana Tank (T-1)';
const PLATE = '34 CTP 82';

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
const tomorrow = (): string => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

async function run() {
  console.log('===========================================================');
  console.log('🧪 [FLEET-1406] ARAÇ BAZLI DÖNEMSEL YAKIT LİMİTİ');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };

  const before = (await q("SELECT assigned_driver_name, fuel_type, status FROM vehicles WHERE id='veh-1'"))[0];
  const cleanup = async () => {
    await q("UPDATE vehicles SET assigned_driver_name=$1, fuel_type=$2, status=$3 WHERE id='veh-1'",
      [before?.assigned_driver_name ?? null, before?.fuel_type ?? null, before?.status ?? 'AKTİF']);
    await q("DELETE FROM audit_logs WHERE tenant_id='comp-camsa' AND action LIKE 'VEHICLE_FUEL_LIMIT_%' AND created_at > NOW() - INTERVAL '30 minutes'");
    await q("DELETE FROM alarm_events WHERE alarm_id IN (SELECT id FROM alarms WHERE tenant_id='comp-camsa' AND alarm_key = 'VEHICLE_LIMIT_EXCEEDED:veh-1')");
    await q("DELETE FROM alarms WHERE tenant_id='comp-camsa' AND alarm_key = 'VEHICLE_LIMIT_EXCEEDED:veh-1'");
    await q("DELETE FROM vehicle_fuel_limits WHERE vehicle_id IN ('veh-1','veh-6')");
    await q("DELETE FROM transactions WHERE id LIKE 'fleet1406-tx-%'");
    await clearSession();
  };
  await cleanup();
  await q("UPDATE vehicles SET assigned_driver_name='Ahmet Yılmaz', status='AKTİF', site_name='Gebze Ana Şantiye', fuel_type='Motorin' WHERE id='veh-1'");
  // Bugüne ait tüm '34 CTP 82' işlemlerini temizle — DAILY limit tam kontrollü olsun.
  await q("DELETE FROM transactions WHERE vehicle_plate = $1 AND created_at > NOW() - INTERVAL '30 hours'", [PLATE]);

  try {
    const owner = await login('camsa');       // COMPANY_OWNER — onaylayıcı
    const siteMgr = await login('gebze-santiye'); // SITE_MANAGER — limit tanımlayabilir ama onaylayamaz
    const pumpOp = await login('pompa-op-01');

    // ── Test 1: limit tanımla ────────────────────────────────
    const r1 = await call('PUT', '/vehicles/veh-1/fuel-limit', { token: owner, body: { periodType: 'DAILY', limitLiters: 100, enforcement: 'REJECT' } });
    check('Test 1: PUT /vehicles/veh-1/fuel-limit → 200, DAILY 100 L, REJECT',
      r1.status === 200 && Number(r1.body.data?.limit_liters) === 100 && r1.body.data?.enforcement === 'REJECT',
      `status=${r1.status}, limit=${r1.body.data?.limit_liters}, enforcement=${r1.body.data?.enforcement}`);

    // ── Test 2: kullanım oranı — 95/100 L tüketilmiş ─────────
    await q("INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, amount_liters, created_at) VALUES ('fleet1406-tx-1','comp-camsa','Gebze Ana Şantiye',$1,95,NOW())", [PLATE]);
    const r2 = await call('GET', '/vehicles/veh-1/fuel-limit', { token: owner });
    check('Test 2: GET balance → consumedLiters=95, effectiveLimitLiters=100, remainingLiters=5, usagePct=95',
      r2.status === 200 && r2.body.data?.hasLimit === true && r2.body.data?.consumedLiters === 95 &&
      r2.body.data?.effectiveLimitLiters === 100 && r2.body.data?.remainingLiters === 5 && r2.body.data?.usagePct === 95,
      `consumed=${r2.body.data?.consumedLiters}, remaining=${r2.body.data?.remainingLiters}, pct=${r2.body.data?.usagePct}`);

    // ── Test 3: kalan pay içinde ikmal → geçer, maxAllowedLiters limitli ─
    const r3 = await requestAuth(TANK);
    check('Test 3: 5 L kalan pay varken request-auth → 200, maxAllowedLiters ≤ 5',
      r3.status === 200 && r3.body.data?.maxAllowedLiters <= 5, `status=${r3.status}, maxAllowed=${r3.body.data?.maxAllowedLiters}`);
    await clearSession();

    // ── Test 4: limit tamamen dolunca (REJECT) → ikmal reddedilir (AC) ─
    await q("INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, amount_liters, created_at) VALUES ('fleet1406-tx-2','comp-camsa','Gebze Ana Şantiye',$1,5,NOW())", [PLATE]);
    const r4 = await requestAuth(TANK);
    check('Test 4: 100/100 L dolunca → 409 VEHICLE_FUEL_LIMIT_EXCEEDED',
      r4.status === 409 && r4.error === 'VEHICLE_FUEL_LIMIT_EXCEEDED', `status=${r4.status}, err=${r4.error}`);

    // ── Test 5: geçici artış onayı — kalıcı limiti DEĞİŞTİRMEZ (AC) ────
    const t5 = await call('POST', '/vehicles/veh-1/fuel-limit/temporary-increase', { token: owner, body: { additionalLiters: 50, untilDate: tomorrow(), reason: 'Acil sevkiyat için onaylı geçici artış' } });
    const r5 = await call('GET', '/vehicles/veh-1/fuel-limit', { token: owner });
    check('Test 5: onaylı geçici artış (+50) → effectiveLimitLiters=150, remainingLiters=50; kalıcı limit_liters HÂLÂ 100',
      t5.status === 200 && Number(t5.body.data?.limit_liters) === 100 &&
      r5.body.data?.effectiveLimitLiters === 150 && r5.body.data?.remainingLiters === 50 && r5.body.data?.temporaryIncreaseActive === true,
      `kalıcı=${t5.body.data?.limit_liters}, effective=${r5.body.data?.effectiveLimitLiters}, remaining=${r5.body.data?.remainingLiters}`);

    // ── Test 6: geçici artış sonrası ikmale yeniden izin verilir (AC) ──
    const r6 = await requestAuth(TANK);
    check('Test 6: geçici artıştan sonra request-auth → 200 (artık kalan pay var)', r6.status === 200, `status=${r6.status}`);
    await clearSession();

    // ── Test 7: WARN modu — limit (geçici artışla 150 L) dolsa da ikmal
    //    ENGELLENMEZ, AI-507'ye alarm düşer (AC: "yalnızca uyarı verilmesi") ─
    await call('PUT', '/vehicles/veh-1/fuel-limit', { token: owner, body: { periodType: 'DAILY', limitLiters: 100, enforcement: 'WARN' } });
    await q("INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, amount_liters, created_at) VALUES ('fleet1406-tx-3','comp-camsa','Gebze Ana Şantiye',$1,55,NOW())", [PLATE]); // toplam 155 > 150 efektif
    const r7 = await requestAuth(TANK);
    const alarmRow = (await q("SELECT * FROM alarms WHERE tenant_id='comp-camsa' AND alarm_key = 'VEHICLE_LIMIT_EXCEEDED:veh-1'"))[0];
    check('Test 7: WARN modunda efektif limit (150 L) aşılınca → ikmal YİNE 200 (engellenmez), alarms tablosuna VEHICLE_LIMIT_EXCEEDED/WARNING düşer',
      r7.status === 200 && !!alarmRow && alarmRow.category === 'VEHICLE_LIMIT_EXCEEDED' && alarmRow.severity === 'WARNING' && alarmRow.status === 'OPEN',
      `status=${r7.status}, alarm=${!!alarmRow}, category=${alarmRow?.category}, severity=${alarmRow?.severity}`);
    await clearSession();

    // ── Test 8: Zod + RBAC ─────────────────────────────────
    const z1 = await call('PUT', '/vehicles/veh-1/fuel-limit', { token: owner, body: { periodType: 'DAILY', limitLiters: -5 } });
    const z2 = await call('POST', '/vehicles/veh-1/fuel-limit/temporary-increase', { token: owner, body: { additionalLiters: 10, untilDate: tomorrow() } }); // reason yok
    const rb1 = await call('PUT', '/vehicles/veh-1/fuel-limit', { token: pumpOp, body: { periodType: 'DAILY', limitLiters: 50 } });
    const rb2 = await call('POST', '/vehicles/veh-1/fuel-limit/temporary-increase', { token: siteMgr, body: { additionalLiters: 10, untilDate: tomorrow(), reason: 'test' } });
    const rb3 = await call('GET', '/vehicles/veh-1/fuel-limit');
    check('Test 8: Zod (negatif limit / reasonsız artış → 400); RBAC (PUMP_OPERATOR PUT → 403, SITE_MANAGER onay → 403, tokensiz → 401)',
      z1.status === 400 && z2.status === 400 && rb1.status === 403 && rb2.status === 403 && rb3.status === 401,
      `zod=${z1.status}/${z2.status}, rbac=${rb1.status}/${rb2.status}/${rb3.status}`);

    // ── Test 9: 404'ler ────────────────────────────────────
    const r9a = await call('PUT', '/vehicles/yok-arac/fuel-limit', { token: owner, body: { periodType: 'DAILY', limitLiters: 50 } });
    const r9b = await call('POST', '/vehicles/veh-6/fuel-limit/temporary-increase', { token: owner, body: { additionalLiters: 10, untilDate: tomorrow(), reason: 'limit yokken deneme' } });
    check('Test 9: olmayan araç → 404 VEHICLE_NOT_FOUND; limiti olmayan araca geçici artış → 404 LIMIT_NOT_FOUND',
      r9a.status === 404 && r9a.body.details?.error === 'VEHICLE_NOT_FOUND' &&
      r9b.status === 404 && r9b.body.details?.error === 'LIMIT_NOT_FOUND',
      `vehicle=${r9a.status}/${r9a.body.details?.error}, limit=${r9b.status}/${r9b.body.details?.error}`);

    // ── Test 10: audit log ─────────────────────────────────
    {
      const rows = await q(
        `SELECT action, count(*)::int AS n FROM audit_logs
          WHERE tenant_id='comp-camsa' AND action LIKE 'VEHICLE_FUEL_LIMIT_%' AND created_at > NOW() - INTERVAL '10 minutes'
          GROUP BY action`
      );
      const m = Object.fromEntries(rows.map((x: any) => [x.action, x.n]));
      check('Test 10: audit_logs — VEHICLE_FUEL_LIMIT_SET (≥2) ve VEHICLE_FUEL_LIMIT_TEMP_INCREASE (≥1) yazıldı',
        (m['VEHICLE_FUEL_LIMIT_SET'] || 0) >= 2 && (m['VEHICLE_FUEL_LIMIT_TEMP_INCREASE'] || 0) >= 1, JSON.stringify(m));
    }

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
