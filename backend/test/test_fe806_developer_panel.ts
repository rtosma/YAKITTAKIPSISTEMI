import { Client } from 'pg';
import Redis from 'ioredis';

/**
 * FE-806 (#82) — Geliştirici Paneli: cihaz sağlığı, canlı log ve sistem metrikleri.
 *
 * Kapsam notu: FE-806 esas olarak bir FRONTEND biletidir. Araştırmada
 * DevicesPage.tsx/LiveLogsPage.tsx/SystemHealthPage.tsx'in büyük ölçüde
 * SAHTE/statik veri (uydurma "UPTIME %99.98", hiç bağlanmamış WebSocket
 * log akışı, hiçbir zaman dolmayan firmware/RSSI alanları) gösterdiği
 * bulundu. Bu test yalnızca bu dosyada değişen İKİ backend yüzeyini
 * doğrular:
 *  1. GET /devices — artık IOT-308'in ZATEN yazdığı gerçek verilere
 *     (last_seen_at, firmware_version, last_reported_rssi, health score)
 *     bakıyor, önceden bu 4 alan hiç dönmüyordu.
 *  2. GET /admin/system-metrics (YENİ uç) — OPS-1107'nin Prometheus
 *     registry'sinden gerçek bir özet.
 * Canlı log akışının gerçek WebSocket olaylarından beslenmesi, 500 satır
 * tamponu, duraklat düğmesi ve filtreler saf istemci tarafı state'tir —
 * Playwright'ta (e2e/tenant-and-crud.spec.ts) kapsanır.
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';
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
  const c = pg(); await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}
const redis = new Redis({ host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379', 10) });
async function resetLoginRl(): Promise<void> {
  const k = await redis.keys('rl:auth-login:*'); if (k.length) await redis.del(...k);
}
async function call(method: string, path: string, token?: string): Promise<{ status: number; body: any }> {
  if (path === '/auth/login') await resetLoginRl();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${path}`, { method, headers });
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('application/json') ? await res.json().catch(() => ({})) : {};
  return { status: res.status, body };
}
async function login(username: string, password = '123456'): Promise<string> {
  await resetLoginRl();
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();
  if (!data.accessToken) throw new Error(`login ${username}: ${JSON.stringify(data)}`);
  return data.accessToken;
}

const deviceId = `fe806-dev-${RUN}`;
const healthScoreId = `fe806-dhs-${RUN}`;

async function cleanup(): Promise<void> {
  await q('DELETE FROM device_health_scores WHERE id = $1', [healthScoreId]).catch(() => {});
  await q('DELETE FROM hardware_devices WHERE device_id = $1', [deviceId]).catch(() => {});
}

async function run() {
  console.log('===========================================================');
  console.log('🩺 [FE-806] GELİŞTİRİCİ PANELİ — CİHAZ SAĞLIĞI + SİSTEM METRİKLERİ');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };

  try {
    const adminToken = await login('admin');

    // === Ön koşul: gerçek IOT-308 alanlarıyla bir test cihazı ===
    const lastSeenAt = new Date(Date.now() - 5 * 60_000); // 5 dk önce
    await q(
      `INSERT INTO hardware_devices (id, tenant_id, device_id, name, site_name, encrypted_secret, status, firmware_version, last_seen_at, last_reported_rssi)
       VALUES ($1, 'comp-camsa', $2, $3, 'Gebze Ana Şantiye', 'x', 'AKTİF', '2.3.1', $4, -58)`,
      [`hwd-${deviceId}`, deviceId, `FE806 Test Cihazı`, lastSeenAt.toISOString()]
    );
    await q(
      `INSERT INTO device_health_scores (id, tenant_id, device_id, site_name, period_days, sample_count, score, computed_at)
       VALUES ($1, 'comp-camsa', $2, 'Gebze Ana Şantiye', 30, 12, 87, NOW())`,
      [healthScoreId, deviceId]
    );

    // === Test 1 (ASIL AC): GET /devices — firmware/heartbeat/RSSI/sağlık skoru artık GERÇEK ===
    const list = await call('GET', '/devices', adminToken);
    const row = (list.body?.data || []).find((d: any) => d.deviceCode === deviceId);
    check(
      'Test 1 (ASIL AC): GET /devices artık firmwareVersion/lastHeartbeatAt/signalRssi/healthScore döner (IOT-308 verisi)',
      list.status === 200 && !!row && row.firmwareVersion === '2.3.1' && row.signalRssi === -58 && row.healthScore === 87 &&
        row.lastHeartbeatAt && Math.abs(new Date(row.lastHeartbeatAt).getTime() - lastSeenAt.getTime()) < 2000,
      `satır=${JSON.stringify(row)}`
    );

    // === Test 2 (regresyon): hiçbir IOT-308 verisi olmayan bir cihaz için alanlar null (uydurma değer YOK) ===
    const noDataId = `fe806-nodata-${RUN}`;
    await q(
      `INSERT INTO hardware_devices (id, tenant_id, device_id, name, site_name, encrypted_secret, status)
       VALUES ($1, 'comp-camsa', $2, 'FE806 Veri Yok', 'Gebze Ana Şantiye', 'x', 'AKTİF')`,
      [`hwd-${noDataId}`, noDataId]
    );
    const list2 = await call('GET', '/devices', adminToken);
    const row2 = (list2.body?.data || []).find((d: any) => d.deviceCode === noDataId);
    check(
      'Test 2 (regresyon — dürüst boş alan): hiç veri göndermemiş cihazda firmwareVersion/healthScore/lastHeartbeatAt/signalRssi hepsi null',
      !!row2 && row2.firmwareVersion === null && row2.healthScore === null && row2.lastHeartbeatAt === null && row2.signalRssi === null,
      `satır=${JSON.stringify(row2)}`
    );
    await q('DELETE FROM hardware_devices WHERE device_id = $1', [noDataId]);

    // === Test 3: RBAC — GET /devices SUPER_ADMIN dışına kapalı (regresyon, önceden de böyleydi) ===
    const ownerToken = await login('camsa');
    const rbacDevices = await call('GET', '/devices', ownerToken);
    check('Test 3 (regresyon): RBAC — COMPANY_OWNER GET /devices çağıramaz (403)', rbacDevices.status === 403, `status=${rbacDevices.status}`);

    // === Test 4 (ASIL AC — YENİ uç): GET /admin/system-metrics — beklenen şekil + niceliklerin negatif olmaması ===
    const metrics = await call('GET', '/admin/system-metrics', adminToken);
    const d = metrics.body?.data;
    check(
      'Test 4 (ASIL AC): GET /admin/system-metrics 200 döner; mqtt/devices/despatchQueue/notifications/http/dbPool alanları var, hiçbir sayı negatif değil',
      metrics.status === 200 && !!d &&
        typeof d.mqtt?.messagesTotal === 'number' && d.mqtt.messagesTotal >= 0 &&
        typeof d.mqtt?.errorsTotal === 'number' && d.mqtt.errorsTotal >= 0 &&
        typeof d.devices === 'object' &&
        typeof d.despatchQueue?.oldestQueuedAgeSeconds === 'number' &&
        typeof d.notifications?.retryQueue === 'number' && d.notifications.retryQueue >= 0 &&
        typeof d.despatchIntegratorCircuitOpen === 'boolean' &&
        typeof d.http?.totalRequests === 'number' && d.http.totalRequests >= 0 &&
        typeof d.http?.errorRatePct === 'number' && d.http.errorRatePct >= 0 &&
        typeof d.dbPool === 'object',
      `data=${JSON.stringify(d)}`
    );

    // === Test 5: GET /admin/system-metrics'in KENDİ isteği bile http.totalRequests'i İLERİ taşımalı (gerçek sayaç, sabit değil) ===
    const metrics2 = await call('GET', '/admin/system-metrics', adminToken);
    check(
      'Test 5 (ASIL AC — gerçek sayaç): iki ardışık çağrı arasında http.totalRequests ARTAR (sabit/uydurma bir değer değil)',
      metrics2.body?.data?.http?.totalRequests > d.http.totalRequests,
      `önce=${d.http.totalRequests}, sonra=${metrics2.body?.data?.http?.totalRequests}`
    );

    // === Test 6: RBAC — GET /admin/system-metrics SUPER_ADMIN dışına kapalı ===
    const rbacMetrics = await call('GET', '/admin/system-metrics', ownerToken);
    check('Test 6 (ASIL AC): RBAC — COMPANY_OWNER GET /admin/system-metrics çağıramaz (403)', rbacMetrics.status === 403, `status=${rbacMetrics.status}`);

    // === Test 7: kimliksiz erişim 401 ===
    const noAuth = await call('GET', '/admin/system-metrics');
    check('Test 7 (regresyon): Kimliksiz GET /admin/system-metrics 401', noAuth.status === 401, `status=${noAuth.status}`);
  } finally {
    await cleanup();
    await resetLoginRl();
    redis.disconnect();
    console.log('🧹 Test fixture verisi temizlendi.\n');
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => { console.error('💥 Beklenmeyen hata:', err); process.exit(1); });
