import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';
import { notifyEvent, runNotificationRetrySweepForCurrentTenant } from '../src/services/notificationService';
import { markNotificationFailed } from '../src/db/tenantDb';
import { runWithTenant } from '../src/context/tenantContext';

/**
 * NOTIF-1601 (#158) — Bildirim çekirdeği: olay → şablon → kanal yönlendirme.
 *
 * ARCH-102 (event-driven olay veri yolu, #14) bu depoda YOK — bu yüzden
 * `notifyEvent()` DÜZ bir fonksiyon çağrısı (test_auth206_password_reset.ts
 * ile AYNI desen: backend servis kodu doğrudan import edilip çağrılır,
 * HTTP üzerinden DEĞİL — gerçek bir "olay yayını" mekanizması yok).
 *
 * Kapsam: şablon render'ı, mükerrer bildirim engelleme (idempotency),
 * bilinmeyen tip → sessiz hata (ana işlemi etkilemez), teslim durumu +
 * yeniden deneme + kalıcı başarısızlık durum makinesi, okundu işaretleme,
 * tenant izolasyonu.
 */

const API_URL = 'http://localhost:5000/api/v1';
const RUN = Date.now();

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
  const c = pg();
  await c.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}

async function call(method: string, path: string, opts: { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${API_URL}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function login(username: string): Promise<string> {
  await resetLoginRateLimit();
  const res = await call('POST', '/auth/login', { body: { username, password: '123456' } });
  if (!res.body.accessToken) throw new Error(`'${username}' girişi başarısız: ${JSON.stringify(res.body)}`);
  return res.body.accessToken;
}

async function run() {
  console.log('===========================================================');
  console.log('📬 [NOTIF-1601] BİLDİRİM ÇEKİRDEĞİ TESTİ');
  console.log('===========================================================\n');

  let passed = 0;
  let total = 0;
  const check = (name: string, condition: boolean, detail: string) => {
    total++;
    if (condition) {
      console.log(`✅ [PASS] ${name}\n   ${detail}\n`);
      passed++;
    } else {
      console.log(`❌ [FAIL] ${name}\n   ${detail}\n`);
    }
  };

  const owner = await login('camsa');
  const kusakOwner = await login('kusak');
  const idempotencyKey = `test-idem-${RUN}`;
  const createdNotificationIds: string[] = [];
  const manualFixtureIds: string[] = [];

  try {
    // === Test 1: şablon render'ı + kalıcı kayıt + GET /notifications'ta görünür. ===
    const result1 = await notifyEvent(
      'comp-camsa',
      'TANK_LOW_STOCK_FORECAST',
      { tankName: `Test-Tank-${RUN}`, estimatedDaysRemaining: 2.5, currentLevelLiters: 250 },
      { idempotencyKey }
    );
    if (result1.notificationId) createdNotificationIds.push(result1.notificationId);
    const listAfter1 = await call('GET', '/notifications', { token: owner });
    const found1 = listAfter1.body?.data?.find((n: any) => n.id === result1.notificationId);
    check(
      'Test 1: notifyEvent şablonu doğru render eder (title/body değişken enjeksiyonu) ve GÖNDERILDI olarak kalıcılaşır',
      !!result1.notificationId &&
        found1?.title === `Test-Tank-${RUN} — stok uyarısı` &&
        found1?.body === 'Tahmini bitiş: 2.5 gün. Mevcut seviye: 250 L.' &&
        found1?.status === 'GÖNDERILDI',
      `notificationId=${result1.notificationId}, title=${found1?.title}, body=${found1?.body}, status=${found1?.status}`
    );

    // === Test 2 (ASIL AC — "aynı olay için mükerrer bildirim gitmemeli"): AYNI idempotencyKey
    // ile İKİNCİ çağrı YENİ bir satır YARATMAZ. ===
    const countBefore = (await q('SELECT COUNT(*) FROM notifications WHERE idempotency_key = $1', [idempotencyKey]))[0].count;
    const result2 = await notifyEvent(
      'comp-camsa',
      'TANK_LOW_STOCK_FORECAST',
      { tankName: 'FARKLI-tank-adı', estimatedDaysRemaining: 99 },
      { idempotencyKey }
    );
    const countAfter = (await q('SELECT COUNT(*) FROM notifications WHERE idempotency_key = $1', [idempotencyKey]))[0].count;
    check(
      "Test 2 (ASIL AC — mükerrer bildirim engelleme): AYNI idempotencyKey ile 2. çağrı skippedDuplicate=true, satır sayısı DEĞİŞMEDİ",
      result2.skippedDuplicate === true && result2.notificationId === null && countBefore === '1' && countAfter === '1',
      `skippedDuplicate=${result2.skippedDuplicate}, countBefore=${countBefore}, countAfter=${countAfter}`
    );

    // === Test 3 (ASIL AC — "gönderim hataları ana işlemi etkilememeli"): BİLİNMEYEN bir bildirim
    // tipi ne fırlatır ne de bir satır yaratır — notifyEvent SESSİZCE null döner. ===
    let threw = false;
    let result3: any;
    try {
      result3 = await notifyEvent('comp-camsa', `HİÇ_KAYITLI_OLMAYAN_TİP_${RUN}`, {});
    } catch {
      threw = true;
    }
    check(
      "Test 3 (ASIL AC — hata ana işlemi etkilemez): bilinmeyen bildirim tipi FIRLATMAZ, notificationId=null döner",
      !threw && result3?.notificationId === null,
      `threw=${threw}, result=${JSON.stringify(result3)}`
    );

    // === Test 4: bildirimi okundu işaretle. ===
    const readRes = await call('POST', `/notifications/${result1.notificationId}/read`, { token: owner });
    check(
      'Test 4 (AC — kullanıcı bazlı okundu bilgisi): bildirim okundu işaretlenince read_at dolar',
      readRes.status === 200 && !!readRes.body?.data?.read_at,
      `status=${readRes.status}, read_at=${readRes.body?.data?.read_at}`
    );

    // === Test 5 (ASIL AC — teslim durumu takibi + kalıcı başarısızlık): elle BAŞARISIZ,
    // attempts=2 bir kayıt oluşturulup markNotificationFailed(id, 3) çağrılırsa
    // (3. deneme de başarısız) KALICI_BAŞARISIZ'a düşer. ===
    const manualId = `notif-manual-${RUN}`;
    manualFixtureIds.push(manualId);
    await q(
      `INSERT INTO notifications (id, tenant_id, event_type, title, body, status, attempts)
       VALUES ($1, 'comp-camsa', 'TEST_EVENT', 'Test', 'Test body', 'BAŞARISIZ', 2)`,
      [manualId]
    );
    await runWithTenant({ tenantId: 'comp-camsa' }, () => markNotificationFailed(manualId, 3));
    const afterThirdFailure = await q('SELECT status, attempts FROM notifications WHERE id = $1', [manualId]);
    check(
      "Test 5 (ASIL AC — kalıcı başarısızlık): attempts=2 → 3. başarısız denemede status KALICI_BAŞARISIZ'a düşer",
      afterThirdFailure[0]?.status === 'KALICI_BAŞARISIZ' && afterThirdFailure[0]?.attempts === 3,
      `status=${afterThirdFailure[0]?.status}, attempts=${afterThirdFailure[0]?.attempts}`
    );

    // === Test 6 (ASIL AC — yeniden deneme): elle BAŞARISIZ (attempts=0) bir kayıt için
    // süpürücü çağrılınca YENİDEN teslim denenir ve GÖNDERILDI'ye döner. ===
    const retryId = `notif-retry-${RUN}`;
    manualFixtureIds.push(retryId);
    await q(
      `INSERT INTO notifications (id, tenant_id, event_type, title, body, status, attempts)
       VALUES ($1, 'comp-camsa', 'TEST_EVENT', 'Retry Test', 'Retry body', 'BAŞARISIZ', 0)`,
      [retryId]
    );
    const sweepResult = await runWithTenant({ tenantId: 'comp-camsa' }, () => runNotificationRetrySweepForCurrentTenant());
    const afterSweep = await q('SELECT status FROM notifications WHERE id = $1', [retryId]);
    check(
      'Test 6 (ASIL AC — yeniden deneme): süpürücü BAŞARISIZ kaydı yeniden dener, GÖNDERILDI olur',
      sweepResult.retried >= 1 && afterSweep[0]?.status === 'GÖNDERILDI',
      `retried=${sweepResult.retried}, status=${afterSweep[0]?.status}`
    );

    // === Test 7: unreadOnly filtresi — okunan Test 1 bildirimini DIŞLAR. ===
    const unreadList = await call('GET', '/notifications?unreadOnly=true', { token: owner });
    const stillHasTest1 = unreadList.body?.data?.some((n: any) => n.id === result1.notificationId);
    check('Test 7: ?unreadOnly=true filtresi okunmuş bildirimi listeden çıkarır', unreadList.status === 200 && !stillHasTest1, `status=${unreadList.status}, containsRead=${stillHasTest1}`);

    // === Test 8 (ASIL AC — tenant izolasyonu): comp-camsa için oluşturulan bildirim,
    // comp-kusak kullanıcısının listesinde HİÇ görünmez. ===
    const kusakList = await call('GET', '/notifications', { token: kusakOwner });
    const leaked = kusakList.body?.data?.some((n: any) => n.id === result1.notificationId);
    check('Test 8 (ASIL AC — RLS/tenant izolasyonu): comp-kusak kullanıcısı comp-camsa bildirimini GÖREMEZ', kusakList.status === 200 && !leaked, `status=${kusakList.status}, leaked=${leaked}`);
  } finally {
    await q('DELETE FROM notifications WHERE id = ANY($1) OR id = ANY($2)', [createdNotificationIds, manualFixtureIds]);
    await resetLoginRateLimit();
    console.log('🧹 Test fixture verisi temizlendi.\n');
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  // notificationService.ts/tenantDb.ts import'u kalıcı bir postgresPool/
  // redisPool bağlantısı açar; event loop'u canlı tutar (test_auth206_
  // password_reset.ts ile AYNI durum) — süreci AÇIKÇA sonlandır.
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => {
  console.error('🔥 Test çalıştırılırken beklenmeyen hata:', err);
  process.exit(1);
});
