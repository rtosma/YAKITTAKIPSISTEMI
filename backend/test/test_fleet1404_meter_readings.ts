import { Client } from 'pg';
import Redis from 'ioredis';
import { checkMeterReading, resolveMeterType } from '../src/fleet/meterValidation'; // saf — config yüklemez

/**
 * FLEET-1404 + RES-903 — araç sayaç (km / motor-saat) girişi + doğrulama.
 * CANLI HTTP + doğrudan PG. Kobaylar: veh-1 (34 CTP 82, Kamyon→KM),
 * veh-2 (34 BKT 19, Ekskavatör→MOTOR_SAAT), veh-4/5 (toplu giriş).
 * Test SONUNDA comp-camsa'nın tüm sayaç okumaları + METER_* audit temizlenir.
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
async function cleanup(): Promise<void> {
  await q("DELETE FROM audit_logs WHERE tenant_id='comp-camsa' AND action LIKE 'METER_READING_%' AND created_at > NOW() - INTERVAL '30 minutes'");
  await q("DELETE FROM vehicle_meter_readings WHERE tenant_id='comp-camsa'");
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [FLEET-1404 + RES-903] ARAÇ SAYAÇ GİRİŞİ + DOĞRULAMA');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };

  await cleanup();
  try {
    // ── Test 1: saf doğrulama mantığı (unit) ─────────────────────
    const noPrev = checkMeterReading({ meterType: 'KM', newValue: 1000, newAt: new Date('2026-01-02') });
    const back = checkMeterReading({ meterType: 'KM', newValue: 900, newAt: new Date('2026-01-02'), previous: { value: 1000, at: new Date('2026-01-01') } });
    const absurd = checkMeterReading({ meterType: 'KM', newValue: 5000, newAt: new Date('2026-01-02'), previous: { value: 1000, at: new Date('2026-01-01') } });
    const ok = checkMeterReading({ meterType: 'KM', newValue: 1500, newAt: new Date('2026-01-02'), previous: { value: 1000, at: new Date('2026-01-01') } });
    check('Test 1: resolveMeterType + checkMeterReading — birim türetme, BACKWARD, ABSURD_JUMP tespiti',
      resolveMeterType('Ekskavatör') === 'MOTOR_SAAT' && resolveMeterType('Kamyon') === 'KM' && resolveMeterType('X', 'KM') === 'KM' &&
      !noPrev.suspicious && back.reasons.includes('BACKWARD') && absurd.reasons.includes('ABSURD_JUMP') && !ok.suspicious,
      `ekskavator=${resolveMeterType('Ekskavatör')}, back=${back.reasons}, absurd=${absurd.reasons}, ok=${ok.suspicious}`);

    const owner = await login('camsa');       // COMPANY_OWNER
    const siteMgr = await login('gebze-santiye'); // SITE_MANAGER
    const pumpOp = await login('pompa-op-01'); // PUMP_OPERATOR

    // ── Test 2: tekil giriş — birim araç tipinden türetilir ──────
    const r2 = await call('POST', '/vehicles/veh-1/meter-readings', { token: owner, body: { value: 100000, periodLabel: '2026-01', readingAt: '2026-01-15T00:00:00.000Z' } });
    check('Test 2: POST /vehicles/veh-1/meter-readings → 201, meter_type=KM (Kamyon), şüpheli değil',
      r2.status === 201 && r2.body.data.reading.meter_type === 'KM' && r2.body.data.reading.is_suspicious === false,
      `status=${r2.status}, meter=${r2.body.data?.reading?.meter_type}, susp=${r2.body.data?.reading?.is_suspicious}`);

    // ── Test 3: makul artış → temiz ────────────────────────────
    const r3 = await call('POST', '/vehicles/veh-1/meter-readings', { token: owner, body: { value: 100800, periodLabel: '2026-02', readingAt: '2026-02-15T00:00:00.000Z' } });
    const r3id = r3.body.data?.reading?.id;
    check('Test 3: 31 günde +800 km (≈26/gün) → 201, şüpheli değil',
      r3.status === 201 && r3.body.data.reading.is_suspicious === false, `status=${r3.status}, susp=${r3.body.data?.reading?.is_suspicious}`);

    // ── Test 4: geri giden değer → onaysız 409 (RES-903 AC) ─────
    const r4 = await call('POST', '/vehicles/veh-1/meter-readings', { token: owner, body: { value: 99000, periodLabel: 'AD_HOC', readingAt: '2026-03-01T00:00:00.000Z' } });
    check('Test 4: geri giden km, gerekçesiz → 409 METER_READING_SUSPICIOUS + reasons BACKWARD + requiresOverride',
      r4.status === 409 && r4.body.details?.error === 'METER_READING_SUSPICIOUS' &&
      (r4.body.details?.reasons || []).includes('BACKWARD') && r4.body.details?.requiresOverride === true,
      `status=${r4.status}, reasons=${JSON.stringify(r4.body.details?.reasons)}`);

    // ── Test 5: gerekçeli onayla kaydedilir ────────────────────
    const r5 = await call('POST', '/vehicles/veh-1/meter-readings', { token: owner, body: { value: 99000, periodLabel: 'AD_HOC', readingAt: '2026-03-01T00:00:00.000Z', overrideReason: 'Sayaç arızalandı, yenisi takıldı' } });
    check('Test 5: overrideReason ile → 201, is_suspicious=true, override_approved=true, approved_by dolu',
      r5.status === 201 && r5.body.data.reading.is_suspicious === true &&
      r5.body.data.reading.override_approved === true && !!r5.body.data.reading.approved_by,
      `status=${r5.status}, susp=${r5.body.data?.reading?.is_suspicious}, approvedBy=${r5.body.data?.reading?.approved_by}`);

    // ── Test 6: absürt sıçrama → 409, override ile geçer ───────
    const r6a = await call('POST', '/vehicles/veh-1/meter-readings', { token: owner, body: { value: 500000, periodLabel: 'AD_HOC', readingAt: '2026-03-02T00:00:00.000Z' } });
    const r6b = await call('POST', '/vehicles/veh-1/meter-readings', { token: owner, body: { value: 500000, periodLabel: 'AD_HOC', readingAt: '2026-03-02T00:00:00.000Z', overrideReason: 'Manuel sayım tutanağı ektedir' } });
    check('Test 6: 1 günde +400.000 km → 409 ABSURD_JUMP; override ile 201',
      r6a.status === 409 && (r6a.body.details?.reasons || []).includes('ABSURD_JUMP') && r6b.status === 201,
      `absurd=${r6a.status}/${JSON.stringify(r6a.body.details?.reasons)}, override=${r6b.status}`);

    // ── Test 7: aynı dönem mükerrer giriş → 409 ────────────────
    const r7a = await call('POST', '/vehicles/veh-1/meter-readings', { token: owner, body: { value: 100900, periodLabel: '2026-02', readingAt: '2026-02-20T00:00:00.000Z' } });
    check('Test 7: 2026-02 dönemi için ikinci giriş → 409 reasons DUPLICATE_PERIOD',
      r7a.status === 409 && (r7a.body.details?.reasons || []).includes('DUPLICATE_PERIOD'),
      `status=${r7a.status}, reasons=${JSON.stringify(r7a.body.details?.reasons)}`);

    // ── Test 8: düzeltme = yeni satır (append-only) ────────────
    const histBefore = (await call('GET', '/vehicles/veh-1/meter-readings', { token: owner })).body.totalCount;
    const r8 = await call('POST', '/vehicles/veh-1/meter-readings', { token: owner, body: {
      value: 100750, periodLabel: '2026-02', readingAt: '2026-02-16T00:00:00.000Z',
      correctsReadingId: r3id, overrideReason: 'İlk giriş yanlış okunmuş, tutanakla düzeltildi'
    }});
    const histAfter = await call('GET', '/vehicles/veh-1/meter-readings', { token: owner });
    const oldStillThere = (histAfter.body.data || []).some((x: any) => x.id === r3id && Number(x.reading_value) === 100800);
    const correction = (histAfter.body.data || []).find((x: any) => x.id === r8.body.data?.reading?.id);
    check('Test 8: correctsReadingId ile düzeltme → yeni satır; ESKİ satır silinmez, corrects_reading_id dolu',
      r8.status === 201 && histAfter.body.totalCount === histBefore + 1 &&
      oldStillThere && correction?.corrects_reading_id === r3id,
      `önce=${histBefore}, sonra=${histAfter.body.totalCount}, eskiVar=${oldStillThere}, corrects=${correction?.corrects_reading_id}`);

    // ── Test 9: iş makinesi → MOTOR_SAAT birimi + absürt ───────
    const r9a = await call('POST', '/vehicles/veh-2/meter-readings', { token: owner, body: { value: 1200, periodLabel: '2026-01', readingAt: '2026-01-10T00:00:00.000Z' } });
    const r9b = await call('POST', '/vehicles/veh-2/meter-readings', { token: owner, body: { value: 1210, periodLabel: 'AD_HOC', readingAt: '2026-01-11T00:00:00.000Z' } });
    const r9c = await call('POST', '/vehicles/veh-2/meter-readings', { token: owner, body: { value: 1400, periodLabel: 'AD_HOC', readingAt: '2026-01-11T06:00:00.000Z' } });
    check('Test 9: Ekskavatör → meter_type MOTOR_SAAT; +10 saat/gün temiz; 6 saatte +190 → 409 ABSURD_JUMP',
      r9a.status === 201 && r9a.body.data.reading.meter_type === 'MOTOR_SAAT' &&
      r9b.status === 201 && r9c.status === 409 && (r9c.body.details?.reasons || []).includes('ABSURD_JUMP'),
      `birim=${r9a.body.data?.reading?.meter_type}, temiz=${r9b.status}, absurd=${r9c.status}`);

    // ── Test 10: toplu giriş — 50 sınırı + satır bazlı sonuç ───
    const r10 = await call('POST', '/meter-readings/bulk', { token: owner, body: { items: [
      { vehiclePlate: '41 KCL 05', value: 50000, periodLabel: '2026-01', readingAt: '2026-01-20T00:00:00.000Z' },
      { vehiclePlate: '34 SIL 99', value: 60000, periodLabel: '2026-01', readingAt: '2026-01-20T00:00:00.000Z' },
      { vehiclePlate: 'YOK-BOYLE-PLAKA', value: 1 }
    ]}});
    const r10big = await call('POST', '/meter-readings/bulk', { token: owner, body: { items: new Array(51).fill(0).map((_, i) => ({ vehiclePlate: 'X ' + i, value: 1 })) } });
    check('Test 10: bulk → 2 ok + 1 VEHICLE_NOT_FOUND; 51 kayıt → 400 (50 sınırı)',
      r10.status === 200 && r10.body.data.accepted === 2 && r10.body.data.failed === 1 &&
      r10.body.data.rows.some((x: any) => x.vehiclePlate === 'YOK-BOYLE-PLAKA' && x.error === 'VEHICLE_NOT_FOUND') &&
      r10big.status === 400,
      `accepted=${r10.body.data?.accepted}, failed=${r10.body.data?.failed}, big=${r10big.status}`);

    // ── Test 11: eksik giriş listesi ──────────────────────────
    const r11 = await call('GET', '/meter-readings/missing?periodLabel=2099-01', { token: siteMgr });
    check('Test 11: GET /meter-readings/missing?periodLabel=2099-01 → tüm aktif araçlar eksik, şantiye bazında gruplu',
      r11.status === 200 && r11.body.data.missingCount >= 5 && Array.isArray(r11.body.data.bySite) &&
      r11.body.data.bySite.every((s: any) => Array.isArray(s.plates) && s.plates.length > 0),
      `missing=${r11.body.data?.missingCount}, sites=${r11.body.data?.bySite?.length}`);

    // ── Test 12: hatırlatma ─────────────────────────────────
    const r12 = await call('POST', '/meter-readings/missing/remind', { token: owner, body: { periodLabel: '2099-01' } });
    check('Test 12: POST /meter-readings/missing/remind → 200, remindedSites ≥ 1',
      r12.status === 200 && r12.body.data.remindedSites >= 1 && r12.body.data.bySite.length >= 1,
      `remindedSites=${r12.body.data?.remindedSites}`);

    // ── Test 13: Zod + RBAC ────────────────────────────────
    const z1 = await call('POST', '/vehicles/veh-1/meter-readings', { token: owner, body: { value: -5 } });
    const z2 = await call('POST', '/meter-readings/bulk', { token: owner, body: { items: [] } });
    const z3 = await call('GET', '/meter-readings/missing', { token: owner });
    const rb1 = await call('POST', '/vehicles/veh-1/meter-readings', { token: pumpOp, body: { value: 1 } });
    const rb2 = await call('POST', '/meter-readings/missing/remind', { token: siteMgr, body: { periodLabel: '2099-01' } });
    const rb3 = await call('GET', '/vehicles/veh-1/meter-readings');
    check('Test 13: Zod (negatif / boş bulk / periodLabel yok → 400); RBAC (PUMP_OPERATOR → 403, SITE_MANAGER remind → 403, tokensiz → 401)',
      z1.status === 400 && z2.status === 400 && z3.status === 400 && rb1.status === 403 && rb2.status === 403 && rb3.status === 401,
      `zod=${z1.status}/${z2.status}/${z3.status}, rbac=${rb1.status}/${rb2.status}/${rb3.status}`);

    // ── Test 14: audit log ─────────────────────────────────
    {
      const rows = await q(
        `SELECT action, count(*)::int AS n FROM audit_logs
          WHERE tenant_id='comp-camsa' AND action LIKE 'METER_READING_%' AND created_at > NOW() - INTERVAL '10 minutes'
          GROUP BY action`
      );
      const m = Object.fromEntries(rows.map((x: any) => [x.action, x.n]));
      check('Test 14: audit_logs — METER_READING_RECORDED / _OVERRIDE / _REMINDER yazıldı',
        (m['METER_READING_RECORDED'] || 0) >= 3 && (m['METER_READING_OVERRIDE'] || 0) >= 3 && (m['METER_READING_REMINDER'] || 0) >= 1,
        JSON.stringify(m));
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
