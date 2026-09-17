import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * INV-1504 (#154) — Minimum stok eşiği ve otomatik sipariş uyarısı.
 *
 * Kapsanan AC'ler: tüketim hızına göre tahmini bitiş süresi hesabı (son 14
 * günün ortalaması), eşik altına inince VEYA tahmini bitişe reorder_lead_days
 * kala uyarı, "aynı tank için günde birden fazla uyarı gönderilmemesi"
 * (AI-507 alarm_key dedupe ile), panelde gösterilebilir liste.
 */

const API_URL = 'http://localhost:5000/api/v1';
const RUN = Date.now();
const SITE_NAME = 'Gebze Ana Şantiye';

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
  console.log('⛽ [INV-1504] MİNİMUM STOK EŞİĞİ VE OTOMATİK SİPARİŞ UYARISI TESTİ');
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
  const forecastTankId = `tank-inv1504-forecast-${RUN}`;
  const forecastTankName = `INV1504-Forecast-Tank-${RUN}`;
  const thresholdTankId = `tank-inv1504-threshold-${RUN}`;
  const thresholdTankName = `INV1504-Threshold-Tank-${RUN}`;
  const safeTankId = `tank-inv1504-safe-${RUN}`;
  const safeTankName = `INV1504-Safe-Tank-${RUN}`;
  const vehPlate = `34 IZ ${String(RUN).slice(-3)}`;

  try {
    // --- Tank 1 (forecast): 14 günde 1400 L tüketim (ort. 100 L/gün),
    // mevcut seviye 250 L → tahmini bitiş 2.5 gün, reorder_lead_days=3 → UYARI. ---
    await q(
      `INSERT INTO tanks (id, tenant_id, name, site_name, capacity_liters, current_level_liters, fuel_type, reorder_lead_days)
       VALUES ($1, 'comp-camsa', $2, $3, 10000, 250, 'Motorin', 3)`,
      [forecastTankId, forecastTankName, SITE_NAME]
    );
    // day=0..13 (14 kayıt, TAMAMEN 14 günlük pencerenin İÇİNDE, sınırda değil
    // — day=14 tam sınıra denk gelirdi ve sorgunun NOW()'ı INSERT'ten
    // MİLİSANİYELER sonra çalıştığından o kayıt bazen pencereden dışarı
    // taşabiliyordu, canlı yakalandı).
    for (let day = 0; day <= 13; day++) {
      await q(
        `INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, tank_name, amount_liters, type, created_at)
         VALUES ($1, 'comp-camsa', $2, $3, $4, 100, 'Manuel', NOW() - INTERVAL '${day} days')`,
        [`tx-inv1504-fc-${RUN}-${day}`, SITE_NAME, vehPlate, forecastTankName]
      );
    }

    // --- Tank 2 (threshold): hiç tüketim geçmişi yok ama mevcut seviye eşiğin altında. ---
    await q(
      `INSERT INTO tanks (id, tenant_id, name, site_name, capacity_liters, current_level_liters, fuel_type, low_stock_threshold_liters, reorder_lead_days)
       VALUES ($1, 'comp-camsa', $2, $3, 10000, 400, 'Motorin', 500, 3)`,
      [thresholdTankId, thresholdTankName, SITE_NAME]
    );

    // --- Tank 3 (safe): bol stok, eşik yok, tüketim yok → hiç uyarı üretilmemeli. ---
    await q(
      `INSERT INTO tanks (id, tenant_id, name, site_name, capacity_liters, current_level_liters, fuel_type)
       VALUES ($1, 'comp-camsa', $2, $3, 10000, 9000, 'Motorin')`,
      [safeTankId, safeTankName, SITE_NAME]
    );

    // === Test 1: GET /tanks/stock-forecast — forecast tankının ort. tüketimi ve tahmini bitişi doğru ===
    const forecastRes = await call('GET', '/tanks/stock-forecast', { token: owner });
    const fc = forecastRes.body?.data?.find((f: any) => f.tankId === forecastTankId);
    check(
      'Test 1: Tahmini tank için ort. günlük tüketim 100 L, tahmini bitiş 2.5 gün',
      forecastRes.status === 200 && fc?.avgDailyConsumptionLiters === 100 && fc?.estimatedDaysRemaining === 2.5,
      `status=${forecastRes.status}, forecast=${JSON.stringify(fc)}`
    );

    // === Test 2: nearingEmpty=true (2.5 <= reorder_lead_days=3), belowThreshold=false (eşik tanımsız) ===
    check(
      "Test 2: nearingEmpty=true (2.5 gün <= 3 gün eşiği), belowThreshold=false (litre eşiği tanımsız)",
      fc?.nearingEmpty === true && fc?.belowThreshold === false,
      `nearingEmpty=${fc?.nearingEmpty}, belowThreshold=${fc?.belowThreshold}`
    );

    // === Test 3: eşik tankı — hiç tüketim geçmişi olmasa da (estimatedDaysRemaining=null) belowThreshold=true ===
    const thresholdFc = forecastRes.body?.data?.find((f: any) => f.tankId === thresholdTankId);
    check(
      'Test 3: Eşik tankı — tüketim geçmişi olmadan (estimatedDaysRemaining=null) belowThreshold=true (400<=500)',
      thresholdFc?.estimatedDaysRemaining === null && thresholdFc?.belowThreshold === true,
      `forecast=${JSON.stringify(thresholdFc)}`
    );

    // === Test 4: güvenli tank — ne eşik ne tahmin uyarısı ===
    const safeFc = forecastRes.body?.data?.find((f: any) => f.tankId === safeTankId);
    check(
      'Test 4: Güvenli tank — belowThreshold=false, nearingEmpty=false',
      safeFc?.belowThreshold === false && safeFc?.nearingEmpty === false,
      `forecast=${JSON.stringify(safeFc)}`
    );

    // === Test 5: RBAC — PUMP_OPERATOR taramayı TETİKLEYEMEZ (yalnızca SUPER_ADMIN/COMPANY_OWNER) ===
    const pumpOpUsername = `inv1504-pump-${RUN}`;
    await q(`INSERT INTO users (id, tenant_id, username, password_hash, role) SELECT $1, 'comp-camsa', $2, password_hash, 'PUMP_OPERATOR' FROM users WHERE username = 'camsa'`, [`usr-${pumpOpUsername}`, pumpOpUsername]);
    const pumpOpToken = await login(pumpOpUsername);
    const scanDenied = await call('POST', '/tanks/stock-forecast-scan', { token: pumpOpToken });
    check('Test 5: PUMP_OPERATOR taramayı tetikleyemez (403)', scanDenied.status === 403, `status=${scanDenied.status}`);

    // === Test 6: tarama tetiklenir, forecast+threshold tankları için alarm üretilir, safe tank için üretilmez ===
    const scan1 = await call('POST', '/tanks/stock-forecast-scan', { token: owner });
    const alarmsAfterScan1 = await q(
      `SELECT subject_id, event_count FROM alarms WHERE tenant_id = 'comp-camsa' AND category = 'TANK_LOW_STOCK_FORECAST' AND subject_id = ANY($1)`,
      [[forecastTankId, thresholdTankId, safeTankId]]
    );
    const forecastAlarm = alarmsAfterScan1.find((a) => a.subject_id === forecastTankId);
    const thresholdAlarm = alarmsAfterScan1.find((a) => a.subject_id === thresholdTankId);
    const safeAlarm = alarmsAfterScan1.find((a) => a.subject_id === safeTankId);
    check(
      'Test 6: Tarama sonrası — forecast VE threshold tankı için alarm var, safe tankı için YOK',
      scan1.status === 200 && !!forecastAlarm && !!thresholdAlarm && !safeAlarm,
      `status=${scan1.status}, scanned=${scan1.body?.data?.scanned}, alarmsRaised=${scan1.body?.data?.alarmsRaised}, forecastAlarm=${!!forecastAlarm}, thresholdAlarm=${!!thresholdAlarm}, safeAlarm=${!!safeAlarm}`
    );

    // === Test 7 (ASIL AC — "günde birden fazla uyarı gönderilmemeli"): tarama İKİNCİ kez
    // çalıştırılır — AYNI alarm satırı (event_count artar) kullanılır, YENİ bir alarm YARATILMAZ. ===
    const scan2 = await call('POST', '/tanks/stock-forecast-scan', { token: owner });
    const alarmsAfterScan2 = await q(
      `SELECT id, subject_id, event_count FROM alarms WHERE tenant_id = 'comp-camsa' AND category = 'TANK_LOW_STOCK_FORECAST' AND subject_id = $1`,
      [forecastTankId]
    );
    check(
      "Test 7 (ASIL AC — 'günde birden fazla uyarı gönderilmemeli'): 2. tarama YENİ alarm YARATMADI (tek satır, event_count arttı), alarmsRaised=0",
      scan2.status === 200 && scan2.body?.data?.alarmsRaised === 0 && alarmsAfterScan2.length === 1 && Number(alarmsAfterScan2[0].event_count) > Number(forecastAlarm?.event_count ?? 0),
      `scan2.alarmsRaised=${scan2.body?.data?.alarmsRaised}, alarm satır sayısı=${alarmsAfterScan2.length}, event_count önce=${forecastAlarm?.event_count} sonra=${alarmsAfterScan2[0]?.event_count}`
    );

    // === Test 8: SITE_MANAGER forecast'i görebilir (view rolü) ===
    const siteManagerRes = await q(`SELECT username FROM users WHERE tenant_id = 'comp-camsa' AND role = 'SITE_MANAGER' LIMIT 1`);
    if (siteManagerRes.length > 0) {
      const smToken = await login(siteManagerRes[0].username);
      const smForecast = await call('GET', '/tanks/stock-forecast', { token: smToken });
      check('Test 8: SITE_MANAGER stok tahminini görebilir', smForecast.status === 200, `status=${smForecast.status}`);
    } else {
      console.log('   ⏭️  Test 8 atlandı — seed veride SITE_MANAGER kullanıcı bulunamadı.\n');
    }
  } finally {
    await q('DELETE FROM alarms WHERE tenant_id = $1 AND subject_id = ANY($2)', ['comp-camsa', [forecastTankId, thresholdTankId, safeTankId]]);
    await q('DELETE FROM transactions WHERE tank_name = $1', [forecastTankName]);
    await q('DELETE FROM tanks WHERE id = ANY($1)', [[forecastTankId, thresholdTankId, safeTankId]]);
    await q('DELETE FROM users WHERE username = $1', [`inv1504-pump-${RUN}`]);
    await resetLoginRateLimit();
    console.log('🧹 Test fixture verisi temizlendi.\n');
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  if (passed !== total) process.exit(1);
}

run().catch((err) => {
  console.error('🔥 Test çalıştırılırken beklenmeyen hata:', err);
  process.exit(1);
});
