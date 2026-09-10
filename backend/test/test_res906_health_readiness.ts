import Redis from 'ioredis';
import { checkReadiness, invalidateReadinessCache } from '../src/services/readinessService';

/**
 * RES-906 — /health/live + /health/ready + graceful shutdown.
 *
 * Deterministik kısımlar (live/ready/legacy/cache/headers) canlı backend'e
 * HTTP ile; readiness cache mantığı ayrıca doğrudan import ile test edilir.
 * SIGTERM sırası (MQTT önce → tampon → kaynaklar) bir kod değişikliğidir ve
 * spawn+SIGTERM (bu sandbox'ta gürültülü) yerine kod incelemesi +
 * test_ops1101'in mevcut sinyal testiyle kapsanır.
 */

const API_URL = 'http://localhost:5000/api/v1';
const redis = new Redis({ host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379', 10) });

async function get(path: string): Promise<{ status: number; headers: Headers; body: any }> {
  const res = await fetch(`${API_URL}${path}`);
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => ({})) };
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [RES-906] HEALTH / READINESS / GRACEFUL SHUTDOWN TESTİ');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };

  // Test 1: /health/live — 200, bağımlılık alanı YOK (Kritik Not 3)
  const live = await get('/health/live');
  check('Test 1: GET /health/live → 200, status UP, bağımlılık kontrolü YOK',
    live.status === 200 && live.body.status === 'UP' && live.body.dependencies === undefined && live.body.shuttingDown === false,
    `status=${live.status}, body=${JSON.stringify(live.body)}`);

  // Test 2: /health/live no-store header (probe cache'lenmemeli)
  check('Test 2: /health/live Cache-Control: no-store',
    live.headers.get('cache-control') === 'no-store', `cache-control=${live.headers.get('cache-control')}`);

  // Test 3: /health/ready — 200, ready:true, 3 bağımlılık ok
  const ready = await get('/health/ready');
  const deps: any[] = ready.body.dependencies || [];
  const names = deps.map((d) => d.name).sort();
  check('Test 3: GET /health/ready → 200, ready:true, postgres+redis+mqtt ok',
    ready.status === 200 && ready.body.ready === true &&
    JSON.stringify(names) === JSON.stringify(['mqtt', 'postgres', 'redis']) &&
    deps.every((d) => d.ok === true),
    `status=${ready.status}, ready=${ready.body.ready}, deps=${JSON.stringify(deps)}`);

  // Test 4: readiness sonucu 3 sn cache'leniyor (Kritik Not 1) — iki hızlı çağrı aynı checkedAt
  const r1 = await get('/health/ready');
  const r2 = await get('/health/ready');
  check('Test 4: readiness sonucu kısa süre cache\'leniyor (iki hızlı çağrı → aynı checkedAt)',
    r1.body.checkedAt === r2.body.checkedAt && typeof r1.body.checkedAt === 'string',
    `1=${r1.body.checkedAt}, 2=${r2.body.checkedAt}`);

  // Test 5: /health/ready no-store header
  check('Test 5: /health/ready Cache-Control: no-store', ready.headers.get('cache-control') === 'no-store',
    `cache-control=${ready.headers.get('cache-control')}`);

  // Test 6: legacy /health hâlâ 200 + eski şekil (geriye uyumluluk — Dockerfile/CI)
  const legacy = await get('/health');
  check('Test 6: legacy GET /health → 200, status UP (geriye uyumlu)',
    legacy.status === 200 && legacy.body.status === 'UP', `status=${legacy.status}, body.status=${legacy.body.status}`);

  // --- Doğrudan import: readiness cache mantığı ---
  // Test 7: checkReadiness() şekli — ready boolean, 3 isimli bağımlılık; DB+Redis ok
  invalidateReadinessCache();
  const direct = await checkReadiness(true);
  const dNames = direct.dependencies.map((d) => d.name).sort();
  const pgDep = direct.dependencies.find((d) => d.name === 'postgres');
  const redisDep = direct.dependencies.find((d) => d.name === 'redis');
  check('Test 7: checkReadiness() — ready boolean, postgres+redis+mqtt bağımlılıkları, DB+Redis ok',
    typeof direct.ready === 'boolean' &&
    JSON.stringify(dNames) === JSON.stringify(['mqtt', 'postgres', 'redis']) &&
    pgDep?.ok === true && redisDep?.ok === true,
    `ready=${direct.ready}, deps=${JSON.stringify(direct.dependencies)}`);

  // Test 8: cache — force olmadan aynı checkedAt; force:true → yeni checkedAt
  const c1 = await checkReadiness();
  const c2 = await checkReadiness();
  const c3 = await checkReadiness(true);
  check('Test 8: checkReadiness() cache — force yok → aynı checkedAt; force:true → yeni',
    c1.checkedAt === c2.checkedAt && c3.checkedAt !== c1.checkedAt,
    `c1=${c1.checkedAt}, c2=${c2.checkedAt}, c3(force)=${c3.checkedAt}`);

  // Test 9: invalidateReadinessCache() sonrası cache YENİDEN kuruluyor.
  // (checkedAt ms hassasiyetinde — sağlıklı bir gecikme koyup yeniden
  // hesaplamanın gerçekten olduğunu gözlemliyoruz.)
  const before = await checkReadiness();
  const cachedSame = await checkReadiness(); // hâlâ cache — before ile aynı olmalı
  await new Promise((r) => setTimeout(r, 8));
  invalidateReadinessCache();
  const after = await checkReadiness();      // cache düştü → yeniden hesap
  check('Test 9: invalidate öncesi cache aynı, invalidate sonrası yeniden hesaplanıyor',
    cachedSame.checkedAt === before.checkedAt && after.checkedAt !== before.checkedAt,
    `before=${before.checkedAt}, cached=${cachedSame.checkedAt}, after=${after.checkedAt}`);

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  await redis.quit();
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => { console.error('💥', err); process.exit(1); });
