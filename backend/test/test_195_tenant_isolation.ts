/**
 * TEST-1003 — Multi-tenant izolasyon sızıntı testi (RLS negatif senaryolar).
 *
 * Ticket'ın "Teknik Yığın"ı vitest + Testcontainers + Swagger'dan otomatik
 * endpoint keşfi öneriyor — bu kod tabanında hiçbiri kurulu değil (test
 * paketinin tamamı zaten tsx ile çalışan, doğrudan HTTP çağıran düz
 * script'ler, bkz. test_auth201.ts vb.). Elle korunan bir "kritik uçlar"
 * listesiyle AYNI desende yazıldı — otomatik Swagger keşfi ayrı, daha büyük
 * bir altyapı işi (mevcut swaggerJsdoc kurulumu route JSDoc yorumlarından
 * üretiyor, programatik olarak "hangi route hangi repository fonksiyonunu
 * çağırıyor" bilgisini vermiyor).
 *
 * Kapsanmayan (bilinçli, ayrı bir iş): WebSocket odaları / MQTT topic'leri
 * üzerinden sızıntı — backend'de socket.io-client bağımlılığı yok; kod
 * incelemesiyle (socketServer.ts: oda adı JWT'deki tenantId'den üretiliyor,
 * mqttClient.ts: tenantId topic'ten ayrıştırılıp runWithTenant'a geçiyor)
 * doğrulandı ama gerçek bir istemci bağlantısıyla test edilmedi.
 */
import { Pool } from 'pg';

const API_URL = 'http://localhost:5000/api/v1';
const pgPool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  user: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || 'postgres',
  database: process.env.POSTGRES_DB || 'yakittakip_db'
});

interface CallResult { status: number; body: any; }
async function call(method: string, path: string, opts: { token?: string; body?: any } = {}): Promise<CallResult> {
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

async function login(username: string): Promise<{ token: string; tenantId: string }> {
  const res = await call('POST', '/auth/login', { body: { username, password: '123456' } });
  if (res.status !== 200) throw new Error(`Ön koşul: ${username} ile giriş başarısız (HTTP ${res.status})`);
  return { token: res.body.accessToken, tenantId: res.body.user.tenantId };
}

async function run() {
  console.log('===========================================================');
  console.log('🔒 [TEST-1003] MULTI-TENANT İZOLASYON SIZINTI TESTİ');
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

  const camsa = await login('camsa');
  const kusak = await login('kusak');
  const avrasya = await login('avrasya');

  // --- 1. Okuma uçlarında çapraz sızıntı yok mu? ---
  const readEndpoints = ['/vehicles', '/drivers', '/tanks', '/sites', '/cross-site-permissions', '/companies/me'];
  for (const endpoint of readEndpoints) {
    const [camsaRes, kusakRes] = await Promise.all([
      call('GET', endpoint, { token: camsa.token }),
      call('GET', endpoint, { token: kusak.token })
    ]);
    const camsaStr = JSON.stringify(camsaRes.body);
    const kusakStr = JSON.stringify(kusakRes.body);
    // Her yanıt SADECE kendi tenant_id'sini içermeli, diğerini asla.
    const camsaLeaksKusak = camsaStr.includes(kusak.tenantId);
    const kusakLeaksCamsa = kusakStr.includes(camsa.tenantId);
    check(
      `Sızıntı yok: GET ${endpoint} (camsa ⇄ kusak)`,
      !camsaLeaksKusak && !kusakLeaksCamsa,
      `camsaLeaksKusak=${camsaLeaksKusak}, kusakLeaksCamsa=${kusakLeaksCamsa}`
    );
  }

  // --- 2. Doğrudan ID tahmini: camsa'nın bir aracının gerçek ID'sini alıp
  // kusak'ın token'ıyla GÜNCELLEME/SİLME denemesi — RLS bu satırı kusak'ın
  // oturumuna hiç göstermemeli, işlem "bulunamadı" ile reddedilmeli. ---
  const camsaVehicles = await call('GET', '/vehicles', { token: camsa.token });
  const targetVehicleId = camsaVehicles.body.data?.[0]?.id;
  if (targetVehicleId) {
    // NOT: 'HACKED_BY_KUSAK' geçerli bir status enum değeri DEĞİL
    // (vehicleSchema.ts: 'AKTİF'|'BAKIMDA'|'PASİF') — Zod bunu RLS/tenant
    // katmanına hiç ulaşmadan 400 ile reddeder. RLS'in kendisini test etmek
    // için gövde GEÇERLİ bir enum değeri taşımalı; asıl doğrulanan şey
    // kusak'ın camsa'nın aracını GÖREMEMESİ (404), gönderilen değerin
    // reddedilmesi değil.
    const crossUpdateAttempt = await call('PUT', `/vehicles/${targetVehicleId}`, {
      token: kusak.token,
      body: { status: 'PASİF' }
    });
    check(
      "ID tahmini: kusak, camsa'nın aracını ID ile güncelleyemez",
      crossUpdateAttempt.status === 404,
      `HTTP ${crossUpdateAttempt.status} (RLS satırı görünmez kıldığı için "bulunamadı" beklenir)`
    );

    // Aracın GERÇEKTEN değişmediğini camsa'nın kendi oturumundan doğrula.
    const verifyUnchanged = await call('GET', '/vehicles', { token: camsa.token });
    const stillIntact = verifyUnchanged.body.data.find((v: any) => v.id === targetVehicleId)?.status !== 'PASİF';
    check(
      "ID tahmini sonrası: camsa'nın aracı GERÇEKTEN değişmemiş",
      stillIntact,
      `araç durumu: ${verifyUnchanged.body.data.find((v: any) => v.id === targetVehicleId)?.status}`
    );

    const crossDeleteAttempt = await call('DELETE', `/vehicles/${targetVehicleId}`, { token: kusak.token });
    check(
      "ID tahmini: kusak, camsa'nın aracını ID ile silemez",
      crossDeleteAttempt.status === 404,
      `HTTP ${crossDeleteAttempt.status}`
    );
    const verifyStillExists = await call('GET', '/vehicles', { token: camsa.token });
    check(
      "ID tahmini sonrası: camsa'nın aracı hâlâ mevcut (silinmemiş)",
      verifyStillExists.body.data.some((v: any) => v.id === targetVehicleId),
      `mevcut araç sayısı: ${verifyStillExists.body.data.length}`
    );
  } else {
    console.warn('⚠️  camsa hiç araç döndürmedi, ID-tahmini testleri atlandı.');
  }

  // --- 3. Doğrudan Postgres üzerinden (app_user rolüyle, HTTP katmanını
  // atlayarak) yanlış tenant_id ile INSERT denemesi — ARCH-101.3 AC'sinin
  // kendi test notu: "Yanlış tenant kimliğiyle yapılan INSERT denemesi
  // veritabanı seviyesinde reddedilmelidir." ---
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user;');
    // camsa'nın context'indeyiz ama kusak'ın tenant_id'siyle satır açmaya çalışıyoruz.
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [camsa.tenantId]);
    let insertRejected = false;
    try {
      await client.query(
        `INSERT INTO vehicles (id, tenant_id, plate, brand_model, vehicle_type, rfid_tag, site_name, status)
         VALUES ('test-cross-tenant-insert', $1, '00 XXX 00', 'Sahte', 'Kamyon', 'TAG-FAKE', 'Fake Site', 'AKTİF')`,
        [kusak.tenantId]
      );
    } catch (err: any) {
      insertRejected = /row-level security|permission denied/i.test(err.message);
    }
    check(
      "DB seviyesi: app.current_tenant_id=camsa iken kusak'ın tenant_id'siyle INSERT reddedilir (WITH CHECK)",
      insertRejected,
      'row-level security policy ihlali beklendi'
    );
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }

  // --- 4. Eşzamanlılık: 50 karışık-tenant isteği aynı anda atılıp her
  // yanıtın YALNIZCA kendi tenant'ının verisini taşıdığı doğrulanır
  // (AsyncLocalStorage context karışması testi). ---
  const users = [camsa, kusak, avrasya];
  const concurrentCalls = Array.from({ length: 51 }, (_, i) => users[i % users.length]);
  const results = await Promise.all(
    concurrentCalls.map((u) => call('GET', '/companies/me', { token: u.token }))
  );
  const allCorrect = results.every((r, i) => r.body?.data?.id === concurrentCalls[i].tenantId);
  const mismatches = results.filter((r, i) => r.body?.data?.id !== concurrentCalls[i].tenantId).length;
  check(
    '50 eşzamanlı karışık-tenant isteğinde AsyncLocalStorage context karışması yok',
    allCorrect,
    `${results.length} istek, ${mismatches} yanlış tenant_id döndü`
  );

  await pgPool.end();

  console.log('===========================================================');
  console.log(`📊 TEST SONUÇLARI: ${passed} / ${total} TEST BAŞARILI`);
  console.log('===========================================================');
  if (passed !== total) process.exit(1);
}

run();
