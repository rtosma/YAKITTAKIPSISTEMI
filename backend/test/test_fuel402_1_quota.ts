import { Client } from 'pg';
import Redis from 'ioredis';

/**
 * FUEL-402.1 — araç/şantiye/dönem bazlı yakıt kotası, dönemsel sıfırlama
 * (devir politikasıyla), kalan kota sorgusu (kalan = tanımlı − tamamlanan −
 * rezerve), Europe/Istanbul dönem sınırları, uzlaşma için geçmiş saklama.
 *
 * Tümü CANLI HTTP + doğrudan PG/Redis ile doğrulanır (src import YOK).
 *  - Dönemi bitmiş kotaların sıfırlanması index.ts'te SAATLİK bir süpürücüyle
 *    olur; testte beklememek için aynı işi tetikleyen SUPER_ADMIN uçtan
 *    (`POST /quotas/reset-due`) yararlanılır.
 *  - Kobay kapsam: yalnızca bu testin kullandığı, hiçbir transaction'ın
 *    eşleşmeyeceği plakalar (TEST-QUOTA-PLATE-402*). Test SONUNDA (finally)
 *    yarattığı tüm kota/geçmiş/transaction satırları ve Redis anahtarları
 *    temizlenir.
 */

const API_URL = 'http://localhost:5000/api/v1';
const PLATE_A = 'TEST-QUOTA-PLATE-402A';
const PLATE_B = 'TEST-QUOTA-PLATE-402B';
const PLATE_C = 'TEST-QUOTA-PLATE-402C';
const CACHE_WAIT_MS = 5500; // QUOTA_BALANCE_CACHE_TTL_SECONDS (5 sn) + pay

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
async function call(method: string, path: string, opts: { token?: string; body?: any } = {}): Promise<{ status: number; body: any; headers: Headers }> {
  if (path === '/auth/login') await resetLoginRl();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${API_URL}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})), headers: res.headers };
}
async function login(username: string): Promise<string> {
  const r = await call('POST', '/auth/login', { body: { username, password: '123456' } });
  if (!r.body.accessToken) throw new Error(`login ${username}: ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run() {
  console.log('===========================================================');
  console.log('🧪 [FUEL-402.1] YAKIT KOTASI + DÖNEMSEL SIFIRLAMA + KALAN KOTA');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };

  const createdQuotaIds: string[] = [];

  try {
    const owner = await login('camsa');      // COMPANY_OWNER — kota yöneticisi
    const admin = await login('admin');      // SUPER_ADMIN — reset-due yetkisi
    const pumpOp = await login('pompa-op-01'); // PUMP_OPERATOR — yetkisiz

    // ── Test 1: GÜNLÜK kota tanımı + Europe/Istanbul dönem penceresi ──────
    const r1 = await call('POST', '/quotas', { token: owner, body: { vehiclePlate: PLATE_A, periodType: 'DAILY', limitLiters: 500, carryoverPolicy: 'NONE' } });
    const q1 = r1.body.data;
    if (q1?.id) createdQuotaIds.push(q1.id);
    const winMs = q1 ? new Date(q1.period_end).getTime() - new Date(q1.period_start).getTime() : 0;
    check('Test 1: POST /quotas GÜNLÜK kota → 201, dönem penceresi tam 24 saat',
      r1.status === 201 && !!q1?.id && q1.period_type === 'DAILY' && Number(q1.limit_liters) === 500 && winMs === 24 * 60 * 60 * 1000,
      `status=${r1.status}, id=${q1?.id}, pencere=${winMs / 3600000}h, start=${q1?.period_start}`);

    // ── Test 2: listede görünüyor ───────────────────────────────────────
    const r2 = await call('GET', '/quotas', { token: owner });
    check('Test 2: GET /quotas yeni kotayı listeliyor',
      r2.status === 200 && Array.isArray(r2.body.data) && r2.body.data.some((x: any) => x.id === q1.id),
      `status=${r2.status}, totalCount=${r2.body.totalCount}`);

    // ── Test 3: tekil getirme ──────────────────────────────────────────
    const r3 = await call('GET', `/quotas/${q1.id}`, { token: owner });
    check('Test 3: GET /quotas/:id kotayı döndürüyor',
      r3.status === 200 && r3.body.data?.id === q1.id && r3.body.data?.vehicle_plate === PLATE_A,
      `status=${r3.status}, plaka=${r3.body.data?.vehicle_plate}`);

    // ── Test 4: kalan kota — taze kota, tüketim/rezerve yok ─────────────
    const r4 = await call('GET', `/quotas/${q1.id}/balance`, { token: owner });
    const b4 = r4.body.data;
    check('Test 4: GET /quotas/:id/balance — kalan = 500, no-store header',
      r4.status === 200 && b4?.baseLimitLiters === 500 && b4?.carriedOverLiters === 0 &&
      b4?.effectiveLimitLiters === 500 && b4?.consumedLiters === 0 && b4?.reservedLiters === 0 &&
      b4?.remainingLiters === 500 && (r4.headers.get('cache-control') || '').includes('no-store'),
      `status=${r4.status}, remaining=${b4?.remainingLiters}, cache-control=${r4.headers.get('cache-control')}`);

    // ── Test 5: cache (AC: "with cache") — tüketim eklendi ama 5 sn cache ─
    {
      const c = pg(); await c.connect();
      await c.query(
        `INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, amount_liters, created_at)
         VALUES ('tx-fuel402-test-1', 'comp-camsa', 'Gebze Ana Şantiye', $1, 120, NOW())`, [PLATE_A]
      );
      await c.end();
    }
    const r5 = await call('GET', `/quotas/${q1.id}/balance`, { token: owner });
    check('Test 5: 120 L tüketim eklendi — cache TTL içinde kalan HÂLÂ 500 (bayat okuma)',
      r5.status === 200 && r5.body.data?.remainingLiters === 500 && r5.body.data?.consumedLiters === 0,
      `remaining=${r5.body.data?.remainingLiters}, consumed=${r5.body.data?.consumedLiters}`);

    // ── Test 6: cache süresi dolunca CANLI tüketim yansıyor ─────────────
    await sleep(CACHE_WAIT_MS);
    const r6 = await call('GET', `/quotas/${q1.id}/balance`, { token: owner });
    check('Test 6: cache dolduktan sonra consumed=120, kalan=380 (500 − 120)',
      r6.status === 200 && r6.body.data?.consumedLiters === 120 && r6.body.data?.remainingLiters === 380,
      `consumed=${r6.body.data?.consumedLiters}, remaining=${r6.body.data?.remainingLiters}`);

    // ── Test 7: kapsam izolasyonu — başka plakanın tüketimi sayılmaz ────
    {
      const c = pg(); await c.connect();
      await c.query(
        `INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, amount_liters, created_at)
         VALUES ('tx-fuel402-test-2', 'comp-camsa', 'Gebze Ana Şantiye', '34 CTP 82', 999, NOW())`
      );
      await c.end();
    }
    await sleep(CACHE_WAIT_MS);
    const r7 = await call('GET', `/quotas/${q1.id}/balance`, { token: owner });
    check('Test 7: farklı plakanın (34 CTP 82) 999 L tüketimi bu kotaya YAZILMIYOR',
      r7.status === 200 && r7.body.data?.consumedLiters === 120,
      `consumed=${r7.body.data?.consumedLiters} (120 bekleniyor)`);

    // ── Test 8: PATCH limit — cache invalidasyonu ile anında yansır ─────
    const r8 = await call('PATCH', `/quotas/${q1.id}`, { token: owner, body: { limitLiters: 800 } });
    const r8b = await call('GET', `/quotas/${q1.id}/balance`, { token: owner });
    check('Test 8: PATCH limitLiters=800 → cache düşer, kalan anında 680 (800 − 120)',
      r8.status === 200 && Number(r8.body.data?.limit_liters) === 800 &&
      r8b.body.data?.baseLimitLiters === 800 && r8b.body.data?.remainingLiters === 680,
      `patch=${r8.status}, base=${r8b.body.data?.baseLimitLiters}, remaining=${r8b.body.data?.remainingLiters}`);

    // ── Test 9: rezerve — AKTİF dispense oturumu "kullanımda" sayılır ───
    await redis.set('dispense:session:fuel402-test', JSON.stringify({
      sessionId: 'fuel402-test', tenantId: 'comp-camsa', vehiclePlate: PLATE_A, siteName: 'Gebze Ana Şantiye',
      deviceId: 'X', state: 'PUMPING', maxAllowedLiters: 50
    }));
    await sleep(CACHE_WAIT_MS);
    const r9 = await call('GET', `/quotas/${q1.id}/balance`, { token: owner });
    check('Test 9: AKTİF dispense oturumu (50 L) rezerve sayılıyor → kalan = 800 − 120 − 50 = 630',
      r9.status === 200 && r9.body.data?.reservedLiters === 50 && r9.body.data?.remainingLiters === 630,
      `reserved=${r9.body.data?.reservedLiters}, remaining=${r9.body.data?.remainingLiters}`);

    // ── Test 10: Zod doğrulama ─────────────────────────────────────────
    const r10a = await call('POST', '/quotas', { token: owner, body: { vehiclePlate: PLATE_A, periodType: 'YEARLY', limitLiters: 100 } });
    const r10b = await call('PATCH', `/quotas/${q1.id}`, { token: owner, body: {} });
    const r10c = await call('POST', '/quotas', { token: owner, body: { periodType: 'DAILY', limitLiters: -5 } });
    check('Test 10: Zod — geçersiz periodType / boş PATCH / negatif limit → 400 VALIDATION_ERROR',
      r10a.status === 400 && r10a.body.error === 'VALIDATION_ERROR' &&
      r10b.status === 400 && r10b.body.error === 'VALIDATION_ERROR' &&
      r10c.status === 400 && r10c.body.error === 'VALIDATION_ERROR',
      `periodType=${r10a.status}, boşPATCH=${r10b.status}, negatif=${r10c.status}`);

    // ── Test 11: dönemsel sıfırlama + FULL devir + geçmiş arşivi ────────
    const r11c = await call('POST', '/quotas', { token: owner, body: { vehiclePlate: PLATE_B, periodType: 'WEEKLY', limitLiters: 1000, carryoverPolicy: 'FULL' } });
    const q11 = r11c.body.data;
    if (q11?.id) createdQuotaIds.push(q11.id);
    {
      // pencereyi tamamen geçmişe it (dönemi bitmiş AKTİF kota)
      const c = pg(); await c.connect();
      await c.query(
        `UPDATE fuel_quotas SET period_start = period_start - INTERVAL '7 days', period_end = period_end - INTERVAL '7 days' WHERE id = $1`,
        [q11.id]
      );
      await c.end();
    }
    const r11reset = await call('POST', '/quotas/reset-due', { token: admin });
    const r11after = await call('GET', `/quotas/${q11.id}`, { token: owner });
    const r11hist = await call('GET', `/quotas/${q11.id}/history`, { token: owner });
    const histRow = (r11hist.body.data || [])[0];
    const nowMs = Date.now();
    check('Test 11: reset-due → dönem kapandı, FULL devir=1000, yeni pencere şimdiyi kapsıyor, geçmişe 1 satır',
      r11reset.status === 200 && r11reset.body.data?.reset >= 1 &&
      Number(r11after.body.data?.carried_over_liters) === 1000 &&
      new Date(r11after.body.data?.period_start).getTime() <= nowMs &&
      new Date(r11after.body.data?.period_end).getTime() > nowMs &&
      r11hist.body.data?.length >= 1 &&
      Number(histRow?.effective_limit_liters) === 1000 && Number(histRow?.consumed_liters) === 0 &&
      Number(histRow?.carried_over_to_next_liters) === 1000,
      `reset=${JSON.stringify(r11reset.body.data)}, devir=${r11after.body.data?.carried_over_liters}, hist=${r11hist.body.data?.length}, histRow=${JSON.stringify(histRow)}`);

    // ── Test 12: devir sonrası kalan kota efektif limiti kullanıyor ────
    await sleep(CACHE_WAIT_MS);
    const r12 = await call('GET', `/quotas/${q11.id}/balance`, { token: owner });
    check('Test 12: devir sonrası effective = 1000 + 1000 = 2000, kalan = 2000',
      r12.status === 200 && r12.body.data?.baseLimitLiters === 1000 && r12.body.data?.carriedOverLiters === 1000 &&
      r12.body.data?.effectiveLimitLiters === 2000 && r12.body.data?.remainingLiters === 2000,
      `base=${r12.body.data?.baseLimitLiters}, carried=${r12.body.data?.carriedOverLiters}, remaining=${r12.body.data?.remainingLiters}`);

    // ── Test 13: ONE_TIME kota — süresi geçince PASİF (sıfırlanmaz) ─────
    const r13c = await call('POST', '/quotas', { token: owner, body: { vehiclePlate: PLATE_C, periodType: 'ONE_TIME', limitLiters: 300, validFrom: '2020-01-01', validUntil: '2020-12-31' } });
    const q13 = r13c.body.data;
    if (q13?.id) createdQuotaIds.push(q13.id);
    const r13reset = await call('POST', '/quotas/reset-due', { token: admin });
    const r13after = await call('GET', `/quotas/${q13.id}`, { token: owner });
    check('Test 13: süresi geçmiş ONE_TIME kota → reset-due sonrası status=PASİF, expired sayacı arttı',
      r13c.status === 201 && r13reset.status === 200 && r13reset.body.data?.expired >= 1 &&
      r13after.body.data?.status === 'PASİF',
      `create=${r13c.status}, expired=${r13reset.body.data?.expired}, status=${r13after.body.data?.status}`);

    // ── Test 14: RBAC ─────────────────────────────────────────────────
    const r14a = await call('POST', '/quotas', { token: pumpOp, body: { vehiclePlate: PLATE_A, periodType: 'DAILY', limitLiters: 100 } });
    const r14b = await call('GET', '/quotas');
    const r14c = await call('POST', '/quotas/reset-due', { token: owner }); // COMPANY_OWNER ≠ SUPER_ADMIN
    check('Test 14: RBAC — PUMP_OPERATOR POST /quotas → 403, token yok → 401, reset-due sadece SUPER_ADMIN → 403',
      r14a.status === 403 && r14b.status === 401 && r14c.status === 403,
      `pumpOp=${r14a.status}, tokensiz=${r14b.status}, ownerReset=${r14c.status}`);

  } finally {
    const c = pg();
    await c.connect();
    await c.query("DELETE FROM transactions WHERE id LIKE 'tx-fuel402-test-%'");
    if (createdQuotaIds.length) {
      await c.query('DELETE FROM fuel_quota_history WHERE quota_id = ANY($1::text[])', [createdQuotaIds]);
      await c.query('DELETE FROM fuel_quotas WHERE id = ANY($1::text[])', [createdQuotaIds]);
    }
    await c.query("DELETE FROM fuel_quotas WHERE tenant_id = 'comp-camsa' AND vehicle_plate LIKE 'TEST-QUOTA-PLATE-402%'");
    await c.end();
    try {
      await redis.del('dispense:session:fuel402-test');
      const bk = await redis.keys('quota:balance:*');
      if (bk.length) await redis.del(...bk);
    } catch { /* */ }
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  await redis.quit();
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => { console.error('💥', err); process.exit(1); });
