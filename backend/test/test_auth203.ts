import { Pool } from 'pg';
import Redis from 'ioredis';

/**
 * AUTH-203 — append-only denetim izi entegrasyon testi.
 *
 * İki katman test ediyor:
 *  1. HTTP üzerinden: kritik bir operasyon (şantiye+kullanıcı oluşturma)
 *     tetiklenip GET /audit-logs ile doğru kayıtların (SITE_CREATED,
 *     USER_PROVISIONED) doğru trace_id/user_id ile yazıldığı doğrulanır.
 *  2. Doğrudan Postgres üzerinden: app_user rolüyle audit_logs'a UPDATE/
 *     DELETE/TRUNCATE denemesi yapılıp veritabanı seviyesinde reddedildiği
 *     doğrulanır (ticket'ın kendi Test Notu: "doğrudan UPDATE denemesinin
 *     veritabanı hatası verdiği doğrulanır").
 */

const API_URL = 'http://localhost:5000/api/v1';
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10)
});
const pgPool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  user: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || 'postgres',
  database: process.env.POSTGRES_DB || 'yakittakip_db'
});

async function resetIpLoginRateLimit(): Promise<void> {
  const keys = await redis.keys('rl:auth-login:*');
  if (keys.length > 0) await redis.del(...keys);
}

interface CurlResult {
  status: number;
  body: any;
}

async function call(method: string, path: string, opts: { token?: string; body?: any } = {}): Promise<CurlResult> {
  if (path === '/auth/login') await resetIpLoginRateLimit();

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function runAuth203Tests() {
  console.log('===========================================================');
  console.log('📜 [AUTH-203] APPEND-ONLY DENETİM İZİ TESTİ');
  console.log('===========================================================\n');

  let passed = 0;
  let total = 0;

  function check(name: string, condition: boolean, detail: string) {
    total++;
    if (condition) {
      console.log(`✅ [PASS] ${name}`);
      console.log(`   ${detail}\n`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${name}`);
      console.error(`   ${detail}\n`);
    }
  }

  // --- Katman 1: HTTP üzerinden kritik operasyon + denetim kaydı okuma ---
  const ownerLogin = await call('POST', '/auth/login', { body: { username: 'camsa', password: '123456' } });
  const ownerToken = ownerLogin.body.accessToken;

  const siteName = `AUTH-203 Test Sahası ${Date.now()}`;
  const createRes = await call('POST', '/sites', { token: ownerToken, body: { siteName } });
  const managerUsername = createRes.body?.data?.manager?.username;

  const logsRes = await call('GET', '/audit-logs?limit=20', { token: ownerToken });
  const logs: any[] = logsRes.body?.data || [];

  const siteCreatedLog = logs.find((l) => l.action === 'SITE_CREATED' && l.target_id === createRes.body?.data?.site?.id);
  check(
    'Test 1: SITE_CREATED kaydı doğru target_id ile yazılmış',
    !!siteCreatedLog,
    siteCreatedLog ? `bulundu: user_id=${siteCreatedLog.user_id}, trace_id=${!!siteCreatedLog.trace_id}` : 'bulunamadı'
  );
  check(
    'Test 2: SITE_CREATED kaydında doğru actor (user_id) var',
    siteCreatedLog?.user_id === ownerLogin.body.user.userId,
    `user_id=${siteCreatedLog?.user_id}, beklenen=${ownerLogin.body.user.userId}`
  );

  const userProvisionedLog = logs.find((l) => l.action === 'USER_PROVISIONED' && l.after_value?.username === managerUsername);
  const temporaryPassword = createRes.body.data.manager.temporaryPassword;
  const afterValueStr = JSON.stringify(userProvisionedLog?.after_value ?? {});
  check(
    'Test 3: USER_PROVISIONED kaydı var ve after_value içinde gerçek geçici parola YOK',
    !!userProvisionedLog && afterValueStr.includes(managerUsername) && !afterValueStr.includes(temporaryPassword),
    `after_value=${afterValueStr}`
  );

  // Parola değişikliği de audit'e düşüyor mu ve parola içeriyor mu diye kontrol
  const tempLogin = await call('POST', '/auth/login', { body: { username: managerUsername, password: createRes.body.data.manager.temporaryPassword } });
  const changeRes = await call('POST', '/auth/change-password', {
    token: tempLogin.body.accessToken,
    body: { currentPassword: createRes.body.data.manager.temporaryPassword, newPassword: 'Auth203TestPass123' }
  });
  check('Ön koşul: parola değişikliği başarılı', changeRes.status === 200, `HTTP ${changeRes.status}`);

  const logsRes2 = await call('GET', '/audit-logs?limit=30', { token: ownerToken });
  const logs2: any[] = logsRes2.body?.data || [];
  const passwordChangedLog = logs2.find((l) => l.action === 'PASSWORD_CHANGED' && l.target_id === tempLogin.body.user.userId);
  const passwordChangedStr = JSON.stringify(passwordChangedLog ?? {});
  check(
    'Test 4: PASSWORD_CHANGED kaydı yazılmış ve HİÇBİR yerinde gerçek parola metni yok',
    !!passwordChangedLog &&
      !passwordChangedStr.includes('Auth203TestPass123') &&
      !passwordChangedStr.includes(createRes.body.data.manager.temporaryPassword),
    `bulundu=${!!passwordChangedLog}`
  );

  // --- Katman 2: Doğrudan Postgres üzerinden UPDATE/DELETE/TRUNCATE reddi ---
  // Her deneme KENDİ transaction'ında — Postgres bir hatadan sonra tüm
  // transaction'ı "aborted" durumuna sokar, aynı transaction içinde art
  // arda üç ayrı reddi test edemezsiniz (ikinci/üçüncü komut "current
  // transaction is aborted" alır, gerçek permission-denied testi değil).
  async function attemptAsAppUser(sql: string): Promise<{ rejected: boolean; message: string }> {
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user;');
      await client.query(sql);
      return { rejected: false, message: '(hata fırlatılmadı — BEKLENMEYEN)' };
    } catch (err: any) {
      return { rejected: /permission denied/i.test(err.message), message: err.message };
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  }

  const updateAttempt = await attemptAsAppUser(`UPDATE audit_logs SET action = 'TAMPERED' WHERE id = '${siteCreatedLog?.id ?? 'nonexistent'}'`);
  check('Test 5: app_user rolüyle UPDATE veritabanı seviyesinde reddedilir', updateAttempt.rejected, updateAttempt.message);

  const deleteAttempt = await attemptAsAppUser(`DELETE FROM audit_logs WHERE id = '${siteCreatedLog?.id ?? 'nonexistent'}'`);
  check('Test 6: app_user rolüyle DELETE veritabanı seviyesinde reddedilir', deleteAttempt.rejected, deleteAttempt.message);

  const truncateAttempt = await attemptAsAppUser('TRUNCATE audit_logs');
  check('Test 7: app_user rolüyle TRUNCATE veritabanı seviyesinde reddedilir', truncateAttempt.rejected, truncateAttempt.message);

  await resetIpLoginRateLimit();
  redis.disconnect();
  await pgPool.end();

  console.log('===========================================================');
  console.log(`📊 TEST SONUÇLARI: ${passed} / ${total} TEST BAŞARILI`);
  console.log('===========================================================');

  if (passed !== total) {
    process.exit(1);
  }
}

runAuth203Tests();
