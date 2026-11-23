/**
 * AUTH-201 — refresh token tek kullanımının KOD SEVİYESİNDE eşzamanlılık testi.
 *
 * test_auth201_refresh_identity.ts aynı şeyi HTTP üzerinden dener, ama istekler
 * nginx/middleware'den geçerken zaman içinde aralandığı için eski GET → kontrol
 * → SET yarışını yerelde YAKALAYAMIYORDU (düzeltmesiz kodla da geçiyordu). Bu
 * test rotateRefreshToken'ı doğrudan, aynı tick'te N kez çağırır: düzeltmesiz
 * kodda N çağrının N'i de yeni token alıyordu; atomik Lua script ile tam 1.
 *
 * Gerçek bir Redis ister (REDIS_HOST/REDIS_PORT) ve config/env'in zorunlu
 * kıldığı tüm değişkenlerin tanımlı olmasını bekler — CI'da AUTH-201 testleriyle
 * aynı job'da, aynı ortamla çalışır. Yalnızca kendi sahte kullanıcısının
 * anahtarlarına dokunur ve sonunda onları siler.
 */
import { generateRefreshToken, rotateRefreshToken, revokeAllUserTokens, type JwtUserPayload } from '../src/services/tokenService';
import { redisPool } from '../src/db/redisPool';

const USER_ID = `race-test-user-${process.pid}`;
const TENANT_ID = 'race-test-tenant';
const BURST = 10;
const ROUNDS = 5;

const payload: JwtUserPayload = { userId: USER_ID, tenantId: TENANT_ID, username: 'race-test', role: 'DRIVER' };

async function run(): Promise<void> {
  console.log('\n📋 [AUTH-201] REFRESH ROTASYONU — KOD SEVİYESİ EŞZAMANLILIK TESTİ\n');
  let failed = 0;

  for (let round = 1; round <= ROUNDS; round++) {
    const { token } = await generateRefreshToken(USER_ID, TENANT_ID);
    const results = await Promise.allSettled(
      Array.from({ length: BURST }, () => rotateRefreshToken(token, async () => payload))
    );
    const accepted = results.filter((r) => r.status === 'fulfilled').length;
    const reuse = results.filter(
      (r) => r.status === 'rejected' && String((r.reason as Error)?.message).includes('TOKEN_REUSE_DETECTED')
    ).length;

    const ok = accepted === 1 && reuse === BURST - 1;
    if (!ok) failed++;
    console.log(
      `${ok ? '✅' : '❌'} Tur ${round}: ${BURST} eşzamanlı rotasyondan ${accepted} tanesi yeni token aldı, ` +
        `${reuse} tanesi TOKEN_REUSE_DETECTED (beklenen: 1 / ${BURST - 1})`
    );
  }

  await revokeAllUserTokens(USER_ID);
  const leftovers = await redisPool.client.smembers(`refresh_tokens_by_user:${USER_ID}`);
  if (leftovers.length) await redisPool.client.del(...leftovers.map((jti) => `refresh_token:${jti}`));
  await redisPool.client.del(`refresh_tokens_by_user:${USER_ID}`);

  console.log('\n---------------------------------------------------------');
  if (failed === 0) {
    console.log('🎉 TEK KULLANIM EŞZAMANLILIKTA KORUNUYOR.');
  } else {
    console.error(`⚠️ ${failed}/${ROUNDS} turda tek kullanım ihlal edildi.`);
  }
  await redisPool.client.quit();
  process.exit(failed === 0 ? 0 : 1);
}

run().catch(async (err) => {
  console.error('❌ Test çalıştırılamadı:', err);
  await redisPool.client.quit().catch(() => undefined);
  process.exit(1);
});
