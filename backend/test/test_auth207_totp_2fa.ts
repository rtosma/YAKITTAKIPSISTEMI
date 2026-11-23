import { Client } from 'pg';
import Redis from 'ioredis';
import { totpAt } from '../src/services/totpService'; // saf crypto — config yüklemez

/**
 * AUTH-207 — TOTP tabanlı 2FA. CANLI HTTP; kodlar totpService.totpAt ile
 * hesaplanır. Kobay: orman-santiye (usr-orman-mgr, SITE_MANAGER → rol
 * zorunluluğu yok, opt-in yolu). Test SONUNDA user_totp satırı + TOTP_* audit
 * kayıtları + refresh token izleri temizlenir.
 */

const API_URL = 'http://localhost:5000/api/v1';
const USER = 'orman-santiye';
const USER_ID = 'usr-orman-mgr';

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
  for (const p of ['rl:auth-login:*', 'rl:auth-refresh:*']) {
    const k = await redis.keys(p); if (k.length) await redis.del(...k);
  }
}
async function call(method: string, path: string, opts: { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
  if (path === '/auth/login') await resetLoginRl();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${API_URL}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function loginRaw(username: string): Promise<any> {
  return (await call('POST', '/auth/login', { body: { username, password: '123456' } })).body;
}
async function q(sql: string, params: any[] = []): Promise<any[]> {
  const c = pg(); await c.connect(); const r = await c.query(sql, params); await c.end(); return r.rows;
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [AUTH-207] TOTP TABANLI İKİ ADIMLI DOĞRULAMA (2FA)');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };

  await q("DELETE FROM user_totp WHERE user_id = $1", [USER_ID]);

  try {
    // ── Test 1: 2FA yokken normal login (regresyon) ────────────────
    const l1 = await loginRaw(USER);
    check('Test 1: 2FA kurulu değilken login → tam token çifti (özellik normal girişi bozmuyor)',
      l1.accessToken && l1.refreshToken && !l1.requires2fa, `access=${!!l1.accessToken}, requires2fa=${l1.requires2fa}`);
    let fullToken = l1.accessToken;

    // ── Test 2: kurulum ──────────────────────────────────────────
    const s2 = await call('POST', '/auth/2fa/setup', { token: fullToken });
    const secret = s2.body.data?.secretBase32;
    const recovery: string[] = s2.body.data?.recoveryCodes || [];
    check('Test 2: POST /auth/2fa/setup → secretBase32, otpauth:// URI, 10 kurtarma kodu (XXXX-XXXX)',
      s2.status === 200 && /^[A-Z2-7]{16,}$/.test(secret || '') &&
      (s2.body.data?.otpauthUri || '').startsWith('otpauth://totp/') &&
      recovery.length === 10 && recovery.every((c) => /^[0-9A-F]{4}-[0-9A-F]{4}$/.test(c)),
      `secret=${secret?.slice(0, 8)}…, uri=${(s2.body.data?.otpauthUri || '').slice(0, 24)}, codes=${recovery.length}`);

    // ── Test 3: yanlış kodla enable → 401 ────────────────────────
    const e3 = await call('POST', '/auth/2fa/enable', { token: fullToken, body: { code: '000000' } });
    check('Test 3: yanlış kodla enable → 401 INVALID_CODE',
      e3.status === 401 && e3.body.details?.error === 'INVALID_CODE', `status=${e3.status}, err=${e3.body.details?.error}`);

    // ── Test 4: doğru kodla enable ──────────────────────────────
    const e4 = await call('POST', '/auth/2fa/enable', { token: fullToken, body: { code: totpAt(secret) } });
    check('Test 4: doğru kodla enable → 200 enabled:true',
      e4.status === 200 && e4.body.enabled === true, `status=${e4.status}, enabled=${e4.body.enabled}`);

    // ── Test 5: status ─────────────────────────────────────────
    const st5 = await call('GET', '/auth/2fa/status', { token: fullToken });
    check('Test 5: GET /auth/2fa/status → enabled:true, recoveryCodesRemaining:10',
      st5.status === 200 && st5.body.data?.enabled === true && st5.body.data?.recoveryCodesRemaining === 10,
      `enabled=${st5.body.data?.enabled}, remaining=${st5.body.data?.recoveryCodesRemaining}`);

    // ── Test 6: login artık 2. adım ister ──────────────────────
    const l6 = await loginRaw(USER);
    check('Test 6: login → requires2fa:true, partialToken var, accessToken YOK',
      l6.requires2fa === true && !!l6.partialToken && !l6.accessToken,
      `requires2fa=${l6.requires2fa}, partial=${!!l6.partialToken}, access=${!!l6.accessToken}`);

    // ── Test 7: partialToken API token'ı olarak kullanılamaz ───
    const p7 = await call('GET', '/auth/me', { token: l6.partialToken });
    check('Test 7: partialToken ile /auth/me → 401 (erişim token\'ı değil)', p7.status === 401, `status=${p7.status}`);

    // ── Test 8: yanlış kodla verify → 401 ─────────────────────
    const v8 = await call('POST', '/auth/2fa/verify', { body: { partialToken: l6.partialToken, code: '000000' } });
    check('Test 8: yanlış kodla verify → 401 INVALID_CODE',
      v8.status === 401 && v8.body.details?.error === 'INVALID_CODE', `status=${v8.status}, err=${v8.body.details?.error}`);

    // ── Test 9: doğru kodla verify → tam token ────────────────
    const v9 = await call('POST', '/auth/2fa/verify', { body: { partialToken: l6.partialToken, code: totpAt(secret) } });
    const me9 = await call('GET', '/auth/me', { token: v9.body.accessToken });
    check('Test 9: doğru kodla verify → tam token çifti, access token API\'de çalışıyor',
      v9.status === 200 && !!v9.body.accessToken && !!v9.body.refreshToken && me9.status === 200,
      `status=${v9.status}, access=${!!v9.body.accessToken}, me=${me9.status}`);
    fullToken = v9.body.accessToken;

    // ── Test 10: ±1 zaman penceresi toleransı ─────────────────
    const l10 = await loginRaw(USER);
    const v10 = await call('POST', '/auth/2fa/verify', { body: { partialToken: l10.partialToken, code: totpAt(secret, Date.now() - 30_000) } });
    check('Test 10: bir önceki 30 sn\'lik pencerenin kodu da kabul edilir (±1 tolerans)',
      v10.status === 200 && !!v10.body.accessToken, `status=${v10.status}`);

    // ── Test 11: kurtarma kodu tek kullanımlık ────────────────
    const l11a = await loginRaw(USER);
    const v11a = await call('POST', '/auth/2fa/verify', { body: { partialToken: l11a.partialToken, recoveryCode: recovery[0] } });
    const l11b = await loginRaw(USER);
    const v11b = await call('POST', '/auth/2fa/verify', { body: { partialToken: l11b.partialToken, recoveryCode: recovery[0] } }); // aynı kod tekrar
    const l11c = await loginRaw(USER);
    const v11c = await call('POST', '/auth/2fa/verify', { body: { partialToken: l11c.partialToken, recoveryCode: recovery[1] } }); // farklı kod
    check('Test 11: kurtarma kodu ile giriş → tam token + remaining 9; AYNI kod tekrar → 401; farklı kod → 200 remaining 8',
      v11a.status === 200 && v11a.body.usedRecoveryCode === true && v11a.body.recoveryCodesRemaining === 9 &&
      v11b.status === 401 && v11b.body.details?.error === 'INVALID_RECOVERY_CODE' &&
      v11c.status === 200 && v11c.body.recoveryCodesRemaining === 8,
      `1.=${v11a.status}/${v11a.body.recoveryCodesRemaining}, tekrar=${v11b.status}, 2.=${v11c.status}/${v11c.body.recoveryCodesRemaining}`);

    // ── Test 12: disable (yeniden doğrulama ile) ──────────────
    const d12bad = await call('POST', '/auth/2fa/disable', { token: fullToken, body: { code: '000000' } });
    const d12 = await call('POST', '/auth/2fa/disable', { token: fullToken, body: { code: totpAt(secret) } });
    const st12 = await call('GET', '/auth/2fa/status', { token: fullToken });
    check('Test 12: disable — yanlış kod 401; doğru kod → enabled:false; status enabled:false',
      d12bad.status === 401 && d12.status === 200 && d12.body.enabled === false && st12.body.data?.enabled === false,
      `bad=${d12bad.status}, disable=${d12.status}, statusEnabled=${st12.body.data?.enabled}`);

    // ── Test 13: admin sıfırlama + tenant izolasyonu + RBAC ───
    // orman-santiye tekrar 2FA kursun
    const ot = (await loginRaw(USER)).accessToken;
    const s13 = await call('POST', '/auth/2fa/setup', { token: ot });
    await call('POST', '/auth/2fa/enable', { token: ot, body: { code: totpAt(s13.body.data.secretBase32) } });
    const admin = (await loginRaw('admin')).accessToken;
    const camsa = (await loginRaw('camsa')).accessToken;
    const r13reset = await call('DELETE', `/auth/2fa/users/${USER_ID}`, { token: admin });
    const r13again = await call('DELETE', `/auth/2fa/users/${USER_ID}`, { token: admin });          // artık yok
    const r13other = await call('DELETE', `/auth/2fa/users/usr-kusak-owner`, { token: admin });     // başka tenant
    const r13rbac = await call('DELETE', `/auth/2fa/users/${USER_ID}`, { token: camsa });           // COMPANY_OWNER yetkisiz
    const l13 = await loginRaw(USER);                                                               // artık 2FA yok
    check('Test 13: SUPER_ADMIN reset → 200; tekrar → 404; başka tenant → 404; COMPANY_OWNER → 403; sonrası login tam token',
      r13reset.status === 200 && r13again.status === 404 && r13other.status === 404 && r13rbac.status === 403 &&
      !!l13.accessToken && !l13.requires2fa,
      `reset=${r13reset.status}, again=${r13again.status}, other=${r13other.status}, rbac=${r13rbac.status}, login2fa=${l13.requires2fa}`);

    // ── Test 14: Zod ─────────────────────────────────────────
    const otok = l13.accessToken;
    await call('POST', '/auth/2fa/setup', { token: otok });
    const z1 = await call('POST', '/auth/2fa/enable', { token: otok, body: { code: '12' } });
    const z2 = await call('POST', '/auth/2fa/verify', { body: { partialToken: 'x'.repeat(20), code: '123456', recoveryCode: 'AAAA-BBBB' } });
    const z3 = await call('POST', '/auth/2fa/disable', { token: otok, body: {} });
    check('Test 14: Zod — enable kısa kod / verify hem code hem recoveryCode / disable kodsuz → 400',
      z1.status === 400 && z2.status === 400 && z3.status === 400, `enable=${z1.status}, verify=${z2.status}, disable=${z3.status}`);

    // ── Test 15: audit log ──────────────────────────────────
    {
      const rows = await q(
        `SELECT action, count(*)::int AS n FROM audit_logs
          WHERE tenant_id='comp-camsa' AND target_type='user_totp' AND created_at > NOW() - INTERVAL '10 minutes'
          GROUP BY action`
      );
      const m = Object.fromEntries(rows.map((x: any) => [x.action, x.n]));
      check('Test 15: audit_logs — SETUP_INITIATED / ENABLED / LOGIN / RECOVERY_USED / DISABLED / RESET_BY_ADMIN yazıldı',
        (m['TOTP_SETUP_INITIATED'] || 0) >= 2 && (m['TOTP_ENABLED'] || 0) >= 2 && (m['TOTP_LOGIN'] || 0) >= 1 &&
        (m['TOTP_RECOVERY_USED'] || 0) >= 2 && (m['TOTP_DISABLED'] || 0) >= 1 && (m['TOTP_RESET_BY_ADMIN'] || 0) >= 1,
        JSON.stringify(m));
    }

  } finally {
    const c = pg(); await c.connect();
    await c.query("DELETE FROM audit_logs WHERE tenant_id='comp-camsa' AND target_type='user_totp' AND created_at > NOW() - INTERVAL '30 minutes'");
    await c.query("DELETE FROM user_totp WHERE user_id = $1", [USER_ID]);
    await c.end();
    try {
      const idx = 'refresh_tokens_by_user:usr-orman-mgr';
      const ids: string[] = await redis.smembers(idx);
      if (ids.length) await redis.del(...ids.map((i) => `refresh_token:${i}`));
      await redis.del(idx);
    } catch { /* */ }
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  await redis.quit();
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => { console.error('💥', err); process.exit(1); });
