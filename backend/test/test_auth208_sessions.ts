import { Client } from 'pg';
import Redis from 'ioredis';

/**
 * AUTH-208 — aktif oturum/cihaz listesi + uzaktan oturum kapatma.
 *
 * CANLI HTTP (src import YOK). Kobay kullanıcı: orman-santiye (usr-orman-mgr,
 * SITE_MANAGER). Test SONUNDA (finally) bu kullanıcının refresh token
 * anahtarları ve testte üretilen SESSION_REVOKED audit satırları temizlenir.
 */

const API_URL = 'http://localhost:5000/api/v1';
const ORMAN_UID = 'usr-orman-mgr';
const KUSAK_UID = 'usr-kusak-owner'; // farklı tenant

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
  const rk = await redis.keys('rl:auth-refresh:*');
  if (rk.length) await redis.del(...rk);
}
async function call(
  method: string, path: string,
  opts: { token?: string; body?: any; ua?: string } = {}
): Promise<{ status: number; body: any }> {
  if (path === '/auth/login') await resetLoginRl();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (opts.ua) headers['User-Agent'] = opts.ua;
  const res = await fetch(`${API_URL}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function login(username: string, ua?: string): Promise<{ access: string; refresh: string }> {
  const r = await call('POST', '/auth/login', { body: { username, password: '123456' }, ua });
  if (!r.body.accessToken) throw new Error(`login ${username}: ${JSON.stringify(r.body)}`);
  return { access: r.body.accessToken, refresh: r.body.refreshToken };
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [AUTH-208] AKTİF OTURUM LİSTESİ + UZAKTAN OTURUM KAPATMA');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };

  // Önceki test koşularından / başka testlerin orman-santiye login'lerinden
  // kalan refresh token izlerini temizle — Test 1 tam olarak 2 oturum bekler.
  try {
    const idxKey = 'refresh_tokens_by_user:usr-orman-mgr';
    const stale: string[] = await redis.smembers(idxKey);
    if (stale.length) await redis.del(...stale.map((i) => `refresh_token:${i}`));
    await redis.del(idxKey);
  } catch { /* */ }

  try {
    // İki farklı "cihaz"dan giriş.
    const devA = await login('orman-santiye', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0 Safari/537.36');
    const devB = await login('orman-santiye', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1');

    // ── Test 1: iki aktif oturum, cihaz etiketleri, tek current ─────────
    const r1 = await call('GET', '/auth/sessions', { token: devA.access });
    const labels = (r1.body.data || []).map((s: any) => s.deviceLabel).sort();
    const currents = (r1.body.data || []).filter((s: any) => s.current);
    check('Test 1: GET /auth/sessions → 2 oturum, cihaz etiketleri çözülür, tam 1 tanesi current',
      r1.status === 200 && r1.body.data.length === 2 &&
      labels.some((l: string) => l.includes('Chrome')) && labels.some((l: string) => l.includes('Safari')) &&
      currents.length === 1,
      `count=${r1.body.data?.length}, labels=${JSON.stringify(labels)}, current=${currents.length}`);

    const sidA = (r1.body.data || []).find((s: any) => s.current)?.sessionId;
    const sidB = (r1.body.data || []).find((s: any) => !s.current)?.sessionId;

    // ── Test 2: rotasyon yeni satır EKLEMEZ (oturum = aile) ────────────
    const ref = await call('POST', '/auth/refresh', { body: { refreshToken: devB.refresh } });
    devB.refresh = ref.body.refreshToken;
    devB.access = ref.body.accessToken;
    const r2 = await call('GET', '/auth/sessions', { token: devA.access });
    check('Test 2: devB refresh sonrası liste HÂLÂ 2 oturum (rotasyon aynı sessionId)',
      ref.status === 200 && r2.status === 200 && r2.body.data.length === 2 &&
      r2.body.data.some((s: any) => s.sessionId === sidB),
      `refresh=${ref.status}, count=${r2.body.data?.length}`);

    // ── Test 3: uzaktan oturum kapatma ───────────────────────────────
    const r3 = await call('DELETE', `/auth/sessions/${sidB}`, { token: devA.access });
    check('Test 3: DELETE /auth/sessions/:sidB → 200, revokedTokenCount ≥ 1',
      r3.status === 200 && r3.body.data?.revokedTokenCount >= 1,
      `status=${r3.status}, count=${r3.body.data?.revokedTokenCount}`);

    // ── Test 4: kapatılan oturum refresh YAPAMAZ (AC) ────────────────
    const r4 = await call('POST', '/auth/refresh', { body: { refreshToken: devB.refresh } });
    check('Test 4: kapatılan oturumun refresh token’ı → 401 (yenileme reddedilir)',
      r4.status === 401, `status=${r4.status}, err=${r4.body.error}`);

    // ── Test 5: kapatılan oturumun ACCESS token’ı da deny-list’te ────
    const r5 = await call('GET', '/auth/me', { token: devB.access });
    check('Test 5: kapatılan oturumun (hâlâ süresi geçmemiş) access token’ı → 401 SESSION_REVOKED',
      r5.status === 401 && r5.body.error === 'SESSION_REVOKED', `status=${r5.status}, err=${r5.body.error}`);

    // ── Test 6: mevcut oturum etkilenmez ────────────────────────────
    const r6 = await call('GET', '/auth/me', { token: devA.access });
    const r6s = await call('GET', '/auth/sessions', { token: devA.access });
    check('Test 6: devA oturumu çalışmaya devam eder, liste artık 1 oturum',
      r6.status === 200 && r6s.status === 200 && r6s.body.data.length === 1 && r6s.body.data[0].sessionId === sidA,
      `me=${r6.status}, listCount=${r6s.body.data?.length}`);

    // ── Test 7: "diğer tüm oturumları kapat" ────────────────────────
    const devC = await login('orman-santiye', 'okhttp/4.9.0');
    const r7 = await call('POST', '/auth/sessions/logout-others', { token: devA.access });
    const r7ref = await call('POST', '/auth/refresh', { body: { refreshToken: devC.refresh } });
    const r7me = await call('GET', '/auth/me', { token: devA.access });
    check('Test 7: logout-others → devC kapanır (refresh 401), devA çalışır, closedCount ≥ 1',
      r7.status === 200 && r7.body.data?.closedCount >= 1 && r7ref.status === 401 && r7me.status === 200,
      `closed=${r7.body.data?.closedCount}, devC refresh=${r7ref.status}, devA me=${r7me.status}`);

    // ── Test 8: yetkili başka kullanıcının oturumlarını görür/kapatır ─
    const owner = (await login('camsa')).access;
    const dev2 = await login('orman-santiye', 'curl/8.4.0');
    const r8list = await call('GET', `/auth/sessions?userId=${ORMAN_UID}`, { token: owner });
    // devA (sidA) DIŞINDAKİ oturumu (dev2) hedefle — deterministik olsun.
    const targetSid = (r8list.body.data || []).find((s: any) => s.sessionId !== sidA)?.sessionId;
    const r8del = await call('DELETE', `/auth/sessions/${targetSid}?userId=${ORMAN_UID}`, { token: owner });
    const r8ref = await call('POST', '/auth/refresh', { body: { refreshToken: dev2.refresh } });
    check('Test 8: COMPANY_OWNER ?userId= ile orman-santiye oturumunu görür + kapatır (refresh 401)',
      r8list.status === 200 && r8list.body.data.length >= 1 && r8del.status === 200 && r8ref.status === 401,
      `list=${r8list.status}/${r8list.body.data?.length}, del=${r8del.status}, ref=${r8ref.status}`);

    // ── Test 9: RBAC + tenant izolasyonu + 404 ─────────────────────
    const pumpOp = (await login('pompa-op-01')).access;
    const r9a = await call('GET', `/auth/sessions?userId=${ORMAN_UID}`, { token: pumpOp });      // yetkisiz
    const r9b = await call('GET', `/auth/sessions?userId=${KUSAK_UID}`, { token: owner });        // başka tenant
    const r9c = await call('GET', '/auth/sessions');                                             // tokensiz
    const r9d = await call('DELETE', '/auth/sessions/yok-boyle-bir-oturum', { token: owner });    // yok
    check('Test 9: PUMP_OPERATOR ?userId= → 403, başka tenant → 404, tokensiz → 401, olmayan oturum → 404',
      r9a.status === 403 && r9b.status === 404 && r9c.status === 401 && r9d.status === 404,
      `yetkisiz=${r9a.status}, baskaTenant=${r9b.status}, tokensiz=${r9c.status}, yok=${r9d.status}`);

    // ── Test 10: audit log ────────────────────────────────────────
    {
      const c = pg(); await c.connect();
      const r = await c.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id='comp-camsa' AND action='SESSION_REVOKED' AND created_at > NOW() - INTERVAL '3 minutes'"
      );
      await c.end();
      check('Test 10: oturum kapatma işlemleri audit_logs’a SESSION_REVOKED olarak yazılır (AC)',
        r.rows[0].n >= 3, `SESSION_REVOKED satırı=${r.rows[0].n} (≥3 bekleniyor: Test3 + Test7 + Test8)`);
    }

  } finally {
    // orman-santiye'nin tüm refresh token izlerini temizle.
    try {
      const idxKey = 'refresh_tokens_by_user:usr-orman-mgr';
      const ids: string[] = await redis.smembers(idxKey);
      if (ids.length) await redis.del(...ids.map((i) => `refresh_token:${i}`));
      await redis.del(idxKey);
      const denied = await redis.keys('denied_session:*');
      if (denied.length) await redis.del(...denied);
    } catch { /* */ }
    const c = pg();
    await c.connect();
    await c.query("DELETE FROM audit_logs WHERE tenant_id='comp-camsa' AND action='SESSION_REVOKED' AND created_at > NOW() - INTERVAL '10 minutes'");
    await c.end();
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  await redis.quit();
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => { console.error('💥', err); process.exit(1); });
