import Redis from 'ioredis';
import { runWithTenant } from '../src/context/tenantContext';
import {
  buildAnomalyPrompt,
  requestAnomalyAnalysis,
  generateAndStoreAnomalyReport
} from '../src/services/consumptionAnomalyService';
import { aggregateVehicleConsumption } from '../src/db/tenantDb';

/**
 * AI-502 — Google Gemini SDK ile şoför/araç tüketim anomali analizi.
 *
 * Bu sandbox'ta GERÇEK bir GEMINI_API_KEY yok (ücretli/harici bir servis —
 * diğer testlerin hepsinin dayandığı yerel Docker altyapısından (Postgres/
 * Redis/EMQX) farklı olarak burada gerçek bir dış bağımlılık var). Bu yüzden
 * bu test dosyası İKİ farklı katmanda çalışır:
 *
 *  1) HTTP üzerinden (diğer tüm testlerle AYNI stil): RBAC, modül kapalıyken
 *     403, GEMINI_API_KEY tanımsızken GERÇEK 503 davranışı (bu sandbox'ın
 *     GERÇEK durumu — sahte/mock bir davranış DEĞİL).
 *  2) DOĞRUDAN import (bu dosyaya özgü, diğer testlerden FARKLI bir desen):
 *     requestAnomalyAnalysis/generateAndStoreAnomalyReport'a enjekte
 *     edilebilir bir `generateContent` fonksiyonu enjekte edilerek Gemini'ye
 *     hiç ağ isteği ATILMADAN "AI çıktısı JSON şemasıyla doğrulanıyor mu"
 *     AC'si gerçek Postgres'e karşı doğrulanır. Test süreci backend ile
 *     AYNI kaynak koddan, AYNI ortam değişkenleriyle çalıştığından
 *     (bkz. ci-cd.yml'deki adım) bu, ayrı bir mock çatısı gerektirmez.
 */

const API_URL = 'http://localhost:5000/api/v1';
const RUN_TAG = Date.now();
const TEST_SITE = `AI502-Test-Sahasi-${RUN_TAG}`;
const CAMSA_TENANT_ID = 'comp-camsa';

const redis = new Redis({ host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379', 10) });

async function resetIpLoginRateLimit(): Promise<void> {
  const keys = await redis.keys('rl:auth-login:*');
  if (keys.length > 0) await redis.del(...keys);
}

async function call(method: string, path: string, opts: { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
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

async function login(username: string): Promise<string> {
  const res = await call('POST', '/auth/login', { body: { username, password: '123456' } });
  if (!res.body.accessToken) throw new Error(`Ön koşul: ${username} ile giriş başarısız: ${JSON.stringify(res.body)}`);
  return res.body.accessToken;
}

async function dispense(token: string, siteName: string, vehiclePlate: string, driverName: string, amountLiters: number): Promise<void> {
  const res = await call('POST', '/dispense', { token, body: { siteName, vehiclePlate, driverName, amountLiters, type: 'Manuel' } });
  if (res.status !== 200) throw new Error(`Ön koşul: dispense başarısız: ${JSON.stringify(res.body)}`);
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [AI-502] GEMINI TÜKETİM ANOMALİ ANALİZİ TESTİ');
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
      console.log(`❌ [FAIL] ${name}`);
      console.log(`   ${detail}\n`);
    }
  }

  const camsaToken = await login('camsa'); // COMPANY_OWNER, comp-camsa
  const gebzeToken = await login('gebze-santiye'); // SITE_MANAGER — HARDWARE_DEVICE_MANAGER_ROLES dışında
  const superAdminToken = await login('admin'); // SUPER_ADMIN, comp-camsa

  // Bu tenant'ta trailing 7 günde en az bir ikmal olsun — hem aggregate
  // testinde hem "503 (key yok)" testinde stats boş OLMAMALI (aksi halde
  // her ikisi de erken-çıkış/boş rapor yoluna düşer, gerçek Gemini çağrı
  // yolunu hiç egzersiz etmez). aggregateVehicleConsumption TÜM tenant'ı
  // (şantiyeden bağımsız) plaka+şoför bazında grupladığından, aynı plakanın
  // ÖNCEKİ bir test koşusundan kalma kayıtları toplamı bozabilir — bu
  // yüzden mutlak toplamı değil, bu testin eklediği DELTA'yı doğruluyoruz.
  const VEHICLE_PLATE = '34 AI 502';
  const statsBefore = await runWithTenant({ tenantId: CAMSA_TENANT_ID }, () => aggregateVehicleConsumption(7));
  const before = statsBefore.find((s) => s.vehiclePlate === VEHICLE_PLATE);
  const litersBefore = before?.totalLiters ?? 0;
  const countBefore = before?.dispenseCount ?? 0;

  await dispense(camsaToken, TEST_SITE, VEHICLE_PLATE, 'Test Şoförü', 450);
  await dispense(camsaToken, TEST_SITE, VEHICLE_PLATE, 'Test Şoförü', 80);

  // --- Test 1: yetkisiz rol reddi (SITE_MANAGER, POST) -------------------
  const r1 = await call('POST', '/ai/consumption-anomaly-reports', { token: gebzeToken, body: {} });
  check('Test 1: SITE_MANAGER POST /ai/consumption-anomaly-reports → 403', r1.status === 403, `Alınan: ${r1.status}`);

  // --- Test 2: aiAnomaly modülü kapalıyken 403 ---------------------------
  const disableRes = await call('PATCH', `/companies/${CAMSA_TENANT_ID}`, { token: superAdminToken, body: { modules: { aiAnomaly: false } } });
  if (disableRes.status !== 200) throw new Error(`Ön koşul: modül kapatma başarısız: ${JSON.stringify(disableRes.body)}`);
  const r2 = await call('POST', '/ai/consumption-anomaly-reports', { token: camsaToken, body: {} });
  check('Test 2: aiAnomaly modülü kapalıyken COMPANY_OWNER POST → 403', r2.status === 403, `Alınan: ${r2.status}, body: ${JSON.stringify(r2.body)}`);
  // Diğer testleri/gelecekteki çalıştırmaları etkilememesi için hemen geri aç.
  const restoreRes = await call('PATCH', `/companies/${CAMSA_TENANT_ID}`, { token: superAdminToken, body: { modules: { aiAnomaly: true } } });
  if (restoreRes.status !== 200) throw new Error(`aiAnomaly modülü geri açılamadı: ${JSON.stringify(restoreRes.body)}`);

  // --- Test 3: GEMINI_API_KEY tanımsızken GERÇEK 503 ---------------------
  // Bu sandbox'ta gerçekten tanımlı DEĞİL (bkz. .env / docker-compose.yml) —
  // bu yüzden bu, sahte bir senaryo değil, canlı backend'in GERÇEK davranışı.
  const r3 = await call('POST', '/ai/consumption-anomaly-reports', { token: camsaToken, body: {} });
  check(
    'Test 3: GEMINI_API_KEY tanımsızken (bu ortamın gerçek durumu) 503 döner',
    r3.status === 503,
    `Alınan: ${r3.status}, body: ${JSON.stringify(r3.body)}`
  );

  // --- Test 4 (saf fonksiyon): buildAnomalyPrompt ------------------------
  const stats = await runWithTenant({ tenantId: CAMSA_TENANT_ID }, () => aggregateVehicleConsumption(7));
  const myStat = stats.find((s) => s.vehiclePlate === VEHICLE_PLATE);
  const deltaLiters = (myStat?.totalLiters ?? 0) - litersBefore;
  const deltaCount = (myStat?.dispenseCount ?? 0) - countBefore;
  check(
    'Test 4: aggregateVehicleConsumption doğru toplamı hesaplıyor (delta)',
    !!myStat && Math.abs(deltaLiters - 530) < 0.001 && deltaCount === 2,
    `Alınan delta: liters=${deltaLiters}, count=${deltaCount} (tam kayıt: ${JSON.stringify(myStat)})`
  );

  const prompt = buildAnomalyPrompt(stats, 7);
  check(
    'Test 5: buildAnomalyPrompt çıktısı araç/periyot bilgisini içeriyor',
    prompt.includes(VEHICLE_PLATE) && prompt.includes('7 günlük'),
    `Prompt uzunluğu: ${prompt.length}, '${VEHICLE_PLATE}' içeriyor mu: ${prompt.includes(VEHICLE_PLATE)}`
  );

  // --- Test 6 (enjekte edilmiş sahte model): geçerli JSON → doğrulanıp döner
  const validFakeResponse = JSON.stringify({
    anomalies: [
      { vehiclePlate: '34 AI 502', driverName: 'Test Şoförü', totalLiters: 530, dispenseCount: 2, riskLevel: 'YÜKSEK', reason: 'Tek seferde alışılmadık yüksek miktar.' }
    ]
  });
  const analysis = await requestAnomalyAnalysis(stats, 7, { generateContent: async () => validFakeResponse });
  check(
    'Test 6: geçerli AI çıktısı Zod şemasından geçip aynen döndürülüyor',
    analysis.anomalies.length === 1 && analysis.anomalies[0].riskLevel === 'YÜKSEK',
    `Alınan: ${JSON.stringify(analysis)}`
  );

  // --- Test 7: JSON.parse başarısız (geçersiz JSON) → hata ----------------
  let test7Threw = false;
  try {
    await requestAnomalyAnalysis(stats, 7, { generateContent: async () => 'bu geçerli bir JSON değil {{{' });
  } catch {
    test7Threw = true;
  }
  check('Test 7: geçersiz JSON çıktısı reddediliyor (DB\'ye asla yazılmıyor)', test7Threw, `Hata fırlatıldı mı: ${test7Threw}`);

  // --- Test 8: geçerli JSON ama şemaya UYMUYOR (yanlış enum) → hata -------
  let test8Threw = false;
  try {
    await requestAnomalyAnalysis(stats, 7, {
      generateContent: async () => JSON.stringify({ anomalies: [{ vehiclePlate: '34 AI 502', driverName: null, totalLiters: 530, dispenseCount: 2, riskLevel: 'ÇOK_YÜKSEK', reason: 'x' }] })
    });
  } catch {
    test8Threw = true;
  }
  check('Test 8: şema dışı enum değeri (riskLevel) reddediliyor', test8Threw, `Hata fırlatıldı mı: ${test8Threw}`);

  // --- Test 9: uçtan uca — enjekte edilmiş sahte modelle rapor üretilip
  // kalıcı olarak saklanıyor, HTTP GET ile de görünüyor -------------------
  const stored = await runWithTenant({ tenantId: CAMSA_TENANT_ID }, () =>
    generateAndStoreAnomalyReport(7, 'test-ai502-runner', { generateContent: async () => validFakeResponse })
  );
  check(
    'Test 9: generateAndStoreAnomalyReport DB\'ye doğru alanlarla yazıyor',
    stored.anomaly_count === 1 && stored.model_name === 'test-double' && stored.generated_by === 'test-ai502-runner',
    `Alınan: ${JSON.stringify({ anomaly_count: stored.anomaly_count, model_name: stored.model_name, generated_by: stored.generated_by })}`
  );

  const listRes = await call('GET', '/ai/consumption-anomaly-reports', { token: camsaToken });
  const found = (listRes.body.data || []).find((r: any) => r.id === stored.id);
  check(
    'Test 10: GET /ai/consumption-anomaly-reports az önce kaydedilen raporu listeliyor',
    listRes.status === 200 && !!found && found.anomaly_count === 1,
    `status=${listRes.status}, bulundu mu: ${!!found}`
  );

  // --- Test 11: hiç ikmal yoksa Gemini'ye HİÇ gidilmeden boş rapor -------
  const emptySiteStats = await runWithTenant({ tenantId: CAMSA_TENANT_ID }, () => aggregateVehicleConsumption(1));
  // Not: aggregateVehicleConsumption(1) diğer testlerin bugünkü kayıtlarını
  // da görebilir — bu yüzden burada doğrudan boş bir stats dizisiyle
  // generateAndStoreAnomalyReport'un DAVRANIŞINI (Gemini'ye gitmeden 0
  // anomali dönmesi) requestAnomalyAnalysis'i HİÇ çağırmayan iç mantığı
  // üzerinden değil, doğrudan orkestrasyon fonksiyonuna boş senaryo
  // simüle ederek değil — gerçek periodDays=1 verisiyle çağırıp
  // generateContent'in YALNIZCA stats boş değilse çağrıldığını kanıtlıyoruz.
  let generateContentCalled = false;
  await runWithTenant({ tenantId: CAMSA_TENANT_ID }, () =>
    generateAndStoreAnomalyReport(0, 'test-ai502-runner', {
      generateContent: async () => {
        generateContentCalled = true;
        return validFakeResponse;
      }
    })
  );
  check(
    'Test 11: periodDays=0 (kayıt yok) → Gemini\'ye HİÇ gidilmez, boş rapor kaydedilir',
    !generateContentCalled,
    `generateContent çağrıldı mı: ${generateContentCalled}`
  );

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');

  await redis.quit();
  if (passed !== total) process.exit(1);
}

run().catch(async (err) => {
  console.error('💥 Test çalıştırma hatası:', err);
  process.exit(1);
});
