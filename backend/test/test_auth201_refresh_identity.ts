import http from 'http';

/**
 * AUTH-201 regression suite for POST /auth/refresh.
 *
 * Covers two invariants that no other test covers and that both broke silently
 * in the past:
 *
 *  A) IDENTITY. The rotated access token must describe the refresh token's real
 *     owner. The original bug hard-coded usr-camsa-owner/comp-camsa into the
 *     route, so ANY tenant's user got a comp-camsa COMPANY_OWNER token.
 *     test_auth201.ts could not catch it because it only ever logs in as camsa.
 *
 *  B) SINGLE USE UNDER CONCURRENCY. Rotation must burn the token inside one
 *     synchronous turn. If a future refactor moves the DB read between the
 *     reuse check and the used/isRevoked assignment, N concurrent requests all
 *     pass the check and all mint tokens - disabling theft detection entirely.
 *     Only a parallel test catches that; a sequential one always passes.
 *
 * Run against a server whose process has NOT restarted since login: the token
 * store is an in-process Map, so a restart makes every refresh look like reuse.
 */

const HOST = process.env.TEST_HOST || 'localhost';
const PORT = parseInt(process.env.TEST_PORT || '5000', 10);

interface Res { status: number; data: any }

function postJson(path: string, body: any): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: HOST,
        port: PORT,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode || 0, data: raw });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** Decode a JWT payload without verifying - diagnostics only, never trust this. */
function claims(token: string): any {
  const part = token.split('.')[1];
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    console.log(`✅ ${name}: BAŞARILI (${detail})`);
  } else {
    failed++;
    console.error(`❌ ${name}: BAŞARISIZ (${detail})`);
  }
}

async function run(): Promise<void> {
  console.log('\n📋 [AUTH-201] REFRESH KİMLİK & EŞZAMANLILIK REGRESYON TESTİ\n');

  // --- A) Identity is preserved across rotation, for a NON-camsa tenant -------
  const login = await postJson('/api/v1/auth/login', { username: 'kusak', password: '123456' });
  if (login.status !== 200 || !login.data?.refreshToken) {
    console.error('❌ Ön koşul: kusak girişi başarısız. Seed uygulanmış mı?', login.status, login.data);
    process.exit(1);
  }
  const before = claims(login.data.accessToken);

  const rotated = await postJson('/api/v1/auth/refresh', { refreshToken: login.data.refreshToken });
  check(
    '1. Rotasyon başarılı',
    rotated.status === 200 && !!rotated.data?.accessToken,
    `Status ${rotated.status}`
  );
  if (rotated.status !== 200) {
    console.error('   Yanıt:', rotated.data);
    process.exit(1);
  }

  const after = claims(rotated.data.accessToken);
  check(
    '2. Kiracı korunuyor (çapraz-kiracı yükseltme yok)',
    after.tenantId === before.tenantId && after.tenantId === 'comp-kusak',
    `giriş=${before.tenantId} → rotasyon=${after.tenantId}`
  );
  check(
    '3. Kullanıcı kimliği korunuyor',
    after.userId === before.userId && after.userId === 'usr-kusak-owner',
    `giriş=${before.userId} → rotasyon=${after.userId}`
  );
  check(
    '4. Rol DB’den taze okunuyor',
    after.role === 'COMPANY_OWNER' && !!after.username,
    `role=${after.role}, username=${after.username}`
  );

  // --- B) Single use holds under concurrency ---------------------------------
  const fresh = await postJson('/api/v1/auth/login', { username: 'gebze-santiye', password: '123456' });
  if (fresh.status !== 200 || !fresh.data?.refreshToken) {
    console.error('❌ Ön koşul: gebze-santiye girişi başarısız.', fresh.status, fresh.data);
    process.exit(1);
  }

  const BURST = 20;
  const results = await Promise.all(
    Array.from({ length: BURST }, () => postJson('/api/v1/auth/refresh', { refreshToken: fresh.data.refreshToken }))
  );
  const accepted = results.filter((r) => r.status === 200).length;
  const reuse = results.filter((r) => r.data?.error === 'TOKEN_REUSE_DETECTED').length;

  check(
    '5. Eşzamanlı rotasyonda tek kullanımlık korunuyor',
    accepted === 1,
    `${BURST} eşzamanlı istekten ${accepted} tanesi 200 aldı (beklenen: 1)`
  );
  check(
    '6. Kalan istekler hırsızlık tespitine takıldı',
    reuse === BURST - 1,
    `${reuse}/${BURST - 1} istek TOKEN_REUSE_DETECTED aldı`
  );

  // --- C) The rotated token also carries the right site scope ----------------
  const okOne = results.find((r) => r.status === 200);
  if (okOne) {
    const mgr = claims(okOne.data.accessToken);
    check(
      '7. SITE_MANAGER kimliği ve şantiyesi korunuyor',
      mgr.tenantId === 'comp-camsa' && mgr.role === 'SITE_MANAGER' && mgr.siteName === 'Gebze Ana Şantiye',
      `tenant=${mgr.tenantId}, role=${mgr.role}, site=${mgr.siteName}`
    );
  }

  console.log('\n---------------------------------------------------------');
  if (failed === 0) {
    console.log('🎉 TÜM REGRESYON TESTLERİ BAŞARILI.');
  } else {
    console.error(`⚠️ ${failed} test başarısız.`);
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('❌ Test çalıştırılamadı:', err);
  process.exit(1);
});
