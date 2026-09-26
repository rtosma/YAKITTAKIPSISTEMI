import crypto from 'crypto';
import { Client } from 'pg';
import Redis from 'ioredis';
import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * INV-1501 (#101) — Tank tanımı, kapasite ve sensör eşleştirme.
 *
 * Kapsanan AC'ler:
 *  - Tank tanımı: kapasite, ölü hacim, LoRaWAN sensör (DevEUI) eşleştirmesi,
 *    montaj yüksekliği, operasyonel durum (AKTİF/BAKIMDA/DEVRE_DIŞI).
 *  - "Entegrasyon: sensör eşleştirme çakışması" — DevEUI GLOBAL olarak benzersiz
 *    (aynı fiziksel sensör iki tanka bağlanamaz), tenant sınırını AŞAR.
 *  - "Kullanılabilir stok, ölü hacim düşülerek gösterilmelidir" — hem GET
 *    /tanks listesinde (usable_stock_liters) hem GET /tanks/:id/volume'de
 *    (usableLiters), hem de otomatik ikmalde İZİN VERİLEN üst sınırın kendisinde.
 *  - "Ölü hacim hesabı" — prizmatik geometri (yeni CylinderConfig.orientation
 *    seçeneği) dahil, tankın FİZİKSEL doluluk hesabına dead volume dahil değildir.
 *  - Kapsam DIŞI (bilinçli): LoRaWAN mesafe→seviye telemetrisinin CANLI
 *    işlenmesi (decoder zaten distanceMm üretiyor ama hiçbir yerde tüketilmiyor
 *    — ayrı bir takip konusu) ve manuel/operatör ikmali (createTransactionCore),
 *    o yol insan gözetimi altında olduğundan operational_status/dead-volume
 *    denetimini BİLEREK taşımıyor.
 */

// OPS-1102: backend host'a port yayınlamıyor (zero-downtime deploy ölçeklemesi
// için container_name yok) — CI'da bare process 5000'de dinler, ama yerel
// docker-compose'ta yalnızca frontend nginx'i (3000→80) /api'yi backend'e proxy'ler.
const API_URL = (process.env.INV1501_API_URL || 'http://localhost:5000/api/v1');
const RUN = Date.now();
const SITE_NAME = 'Gebze Ana Şantiye';
const DEVICE_ID = 'ESP32-PUMP-01';
const DEVICE_SECRET = process.env.HW_SECRET_ESP32_PUMP_01 || 'secret_gebze_pump_8849';

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

// dispenseSessionService bir oturumu Postgres'te DEĞİL, Redis'te
// `dispense:session:{deviceId}` anahtarıyla tutar (TTL'li) — bu yüzden test
// senaryoları arasında oturumu SIFIRLAMAK için doğrudan bu anahtar silinir
// (gerçek finalize akışı burada test edilmiyor, yalnızca yetkilendirme ucu).
async function clearDeviceDispenseSession(deviceId: string): Promise<void> {
  const redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    connectTimeout: 1000,
    maxRetriesPerRequest: 1,
    lazyConnect: false
  });
  try {
    await redis.del(`dispense:session:${deviceId}`);
  } finally {
    redis.disconnect();
  }
}

async function login(username: string): Promise<string> {
  await resetLoginRateLimit();
  const res = await call('POST', '/auth/login', { body: { username, password: '123456' } });
  if (!res.body.accessToken) throw new Error(`'${username}' girişi başarısız: ${JSON.stringify(res.body)}`);
  return res.body.accessToken;
}

function generateNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}
function sign(timestamp: string, nonce: string, rawBody: string): string {
  return crypto.createHmac('sha256', DEVICE_SECRET).update(`${timestamp}.${nonce}.${rawBody}`).digest('hex');
}
async function hwPost(path: string, body: object): Promise<{ status: number; data: any }> {
  const rawBody = JSON.stringify(body);
  const timestamp = Date.now().toString();
  const nonce = generateNonce();
  const signature = sign(timestamp, nonce, rawBody);
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Device-ID': DEVICE_ID,
      'X-Timestamp': timestamp,
      'X-Nonce': nonce,
      'X-Hardware-Signature': signature
    },
    body: rawBody
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function run() {
  console.log('===========================================================');
  console.log('🛢️  [INV-1501] TANK TANIMI, KAPASİTE VE SENSÖR EŞLEŞTİRME TESTİ');
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
  const devEui1 = `70B3D5${RUN.toString(16).toUpperCase().padStart(10, '0').slice(-10)}`;
  const devEui2 = `70B3D5${(RUN + 1).toString(16).toUpperCase().padStart(10, '0').slice(-10)}`;

  const createdTankIds: string[] = [];
  const dispenseTankName = `INV1501-Dispense-Tank-${RUN}`;
  const dispenseTankId = `tank-inv1501-dispense-${RUN}`;

  try {
    // === Test 1: Tank oluşturma — dead volume, DevEUI, mount height, operational status ===
    const create1 = await call('POST', '/tanks', {
      token: owner,
      body: {
        name: `INV1501-Tank-A-${RUN}`,
        capacityLiters: 10000,
        currentLevelLiters: 4000,
        siteName: SITE_NAME,
        deadVolumeLiters: 150,
        sensorDevEui: devEui1,
        sensorMountHeightMm: 2500,
        operationalStatus: 'AKTİF'
      }
    });
    if (create1.body?.data?.id) createdTankIds.push(create1.body.data.id);
    check(
      'Test 1: Tank fiziksel alanlarla oluşturulur (dead volume, DevEUI, mount height, status)',
      create1.status === 200 &&
        Number(create1.body?.data?.dead_volume_liters) === 150 &&
        create1.body?.data?.sensor_dev_eui === devEui1 &&
        Number(create1.body?.data?.sensor_mount_height_mm) === 2500 &&
        create1.body?.data?.operational_status === 'AKTİF',
      `status=${create1.status}, tank=${JSON.stringify(create1.body?.data)}`
    );

    // === Test 2: DevEUI normalize edilir (ayraçlı/küçük harf girdi → büyük harf, ayraçsız saklanır) ===
    const rawEui2 = devEui2.match(/.{1,2}/g)!.join('-').toLowerCase();
    const create2 = await call('POST', '/tanks', {
      token: owner,
      body: {
        name: `INV1501-Tank-B-${RUN}`,
        capacityLiters: 5000,
        currentLevelLiters: 1000,
        siteName: SITE_NAME,
        sensorDevEui: rawEui2
      }
    });
    if (create2.body?.data?.id) createdTankIds.push(create2.body.data.id);
    check(
      'Test 2: DevEUI ayraçlı/küçük harf girilse de normalize edilip (büyük harf, ayraçsız) saklanır',
      create2.status === 200 && create2.body?.data?.sensor_dev_eui === devEui2,
      `status=${create2.status}, sensorDevEui=${create2.body?.data?.sensor_dev_eui}, girilen=${rawEui2}`
    );

    // === Test 3 (ASIL AC — "sensör eşleştirme çakışması"): AYNI DevEUI ikinci bir tanka bağlanamaz ===
    const conflictCreate = await call('POST', '/tanks', {
      token: owner,
      body: {
        name: `INV1501-Tank-C-${RUN}`,
        capacityLiters: 5000,
        currentLevelLiters: 1000,
        siteName: SITE_NAME,
        sensorDevEui: devEui1
      }
    });
    check(
      "Test 3 (ASIL AC — sensör eşleştirme çakışması): Aynı DevEUI ikinci tanka bağlanamaz (409 SENSOR_DEV_EUI_TAKEN)",
      conflictCreate.status === 409 && conflictCreate.body?.details?.error === 'SENSOR_DEV_EUI_TAKEN',
      `status=${conflictCreate.status}, body=${JSON.stringify(conflictCreate.body)}`
    );
    check(
      "Test 3b: Çakışma mesajı çakışan tankın adını İFŞA ETMEZ (global benzersizlik, tenant'lar arası bilgi sızıntısı önlenir)",
      typeof conflictCreate.body?.message === 'string' && !conflictCreate.body.message.includes(`INV1501-Tank-A-${RUN}`),
      `message=${conflictCreate.body?.message}`
    );

    // === Test 4: aynı DevEUI ile UPDATE de reddedilir (Tank B'yi Tank A'nın DevEUI'siyle güncelle) ===
    const conflictUpdate = await call('PUT', `/tanks/${create2.body.data.id}`, {
      token: owner,
      body: { sensorDevEui: devEui1 }
    });
    check(
      'Test 4: UPDATE ile de aynı çakışma engellenir (409 SENSOR_DEV_EUI_TAKEN)',
      conflictUpdate.status === 409 && conflictUpdate.body?.details?.error === 'SENSOR_DEV_EUI_TAKEN',
      `status=${conflictUpdate.status}, body=${JSON.stringify(conflictUpdate.body)}`
    );

    // === Test 5: sensörü SÖKME (null) — mapping kaldırılır, sonra AYNI DevEUI başka tanka bağlanabilir ===
    const detach = await call('PUT', `/tanks/${create1.body.data.id}`, { token: owner, body: { sensorDevEui: null } });
    check(
      'Test 5: sensorDevEui: null gönderilince eşleştirme kaldırılır (sensör söküldü senaryosu)',
      detach.status === 200 && detach.body?.data?.sensor_dev_eui === null,
      `status=${detach.status}, sensorDevEui=${detach.body?.data?.sensor_dev_eui}`
    );
    const reattach = await call('PUT', `/tanks/${create2.body.data.id}`, { token: owner, body: { sensorDevEui: devEui1 } });
    check(
      'Test 5b: Sökülen DevEUI artık BAŞKA bir tanka bağlanabilir',
      reattach.status === 200 && reattach.body?.data?.sensor_dev_eui === devEui1,
      `status=${reattach.status}, body=${JSON.stringify(reattach.body)}`
    );

    // === Test 6 (ASIL AC — "kullanılabilir stok, ölü hacim düşülerek gösterilmelidir"): GET /tanks ===
    const listRes = await call('GET', '/tanks', { token: owner });
    const tankAInList = listRes.body?.data?.find((t: any) => t.id === create1.body.data.id);
    check(
      "Test 6 (ASIL AC): GET /tanks — usable_stock_liters = current_level_liters - dead_volume_liters (4000-150=3850)",
      listRes.status === 200 && Number(tankAInList?.usable_stock_liters) === 3850,
      `status=${listRes.status}, tankA=${JSON.stringify(tankAInList)}`
    );

    // === Test 7: dead volume >= current level → usable_stock_liters TABANA (0) kırpılır, negatif OLMAZ ===
    const lowTank = await call('POST', '/tanks', {
      token: owner,
      body: { name: `INV1501-LowTank-${RUN}`, capacityLiters: 1000, currentLevelLiters: 50, siteName: SITE_NAME, deadVolumeLiters: 80 }
    });
    if (lowTank.body?.data?.id) createdTankIds.push(lowTank.body.data.id);
    check(
      'Test 7: Ölü hacim mevcut seviyeyi aşınca usable_stock_liters 0 (negatif değil)',
      lowTank.status === 200 && Number(lowTank.body?.data?.usable_stock_liters) === 0,
      `status=${lowTank.status}, tank=${JSON.stringify(lowTank.body?.data)}`
    );

    // === Test 8: kapasiteyi aşan ölü hacim reddedilir (şema doğrulaması) ===
    const overCapacity = await call('POST', '/tanks', {
      token: owner,
      body: { name: `INV1501-BadDeadVol-${RUN}`, capacityLiters: 1000, currentLevelLiters: 500, siteName: SITE_NAME, deadVolumeLiters: 1500 }
    });
    check(
      "Test 8: Ölü hacim > kapasite → 400 (şema doğrulaması reddeder)",
      overCapacity.status === 400,
      `status=${overCapacity.status}, body=${JSON.stringify(overCapacity.body)}`
    );

    // === Test 9: geçersiz operationalStatus reddedilir ===
    const badStatus = await call('POST', '/tanks', {
      token: owner,
      body: { name: `INV1501-BadStatus-${RUN}`, capacityLiters: 1000, currentLevelLiters: 500, siteName: SITE_NAME, operationalStatus: 'GARIP_DURUM' }
    });
    check(
      "Test 9: Geçersiz operationalStatus (enum dışı) → 400",
      badStatus.status === 400,
      `status=${badStatus.status}, body=${JSON.stringify(badStatus.body)}`
    );

    // === Test 10: geçersiz DevEUI formatı (17 hane) reddedilir ===
    const badEui = await call('POST', '/tanks', {
      token: owner,
      body: { name: `INV1501-BadEui-${RUN}`, capacityLiters: 1000, currentLevelLiters: 500, siteName: SITE_NAME, sensorDevEui: 'ABCDEF12345678901' }
    });
    check(
      'Test 10: Geçersiz DevEUI formatı (17 hane) → 400',
      badEui.status === 400,
      `status=${badEui.status}, body=${JSON.stringify(badEui.body)}`
    );

    // === Test 11: prizmatik geometri — cylinder strapping-table (FUEL-403 mekanizması, INV-1501 uzantısı) ===
    const prismTank = await call('POST', '/tanks', {
      token: owner,
      body: { name: `INV1501-PrismTank-${RUN}`, capacityLiters: 20000, currentLevelLiters: 5000, siteName: SITE_NAME, deadVolumeLiters: 200 }
    });
    if (prismTank.body?.data?.id) createdTankIds.push(prismTank.body.data.id);
    const prismTankId = prismTank.body.data.id;

    const prismConfig = await call('POST', `/tanks/${prismTankId}/strapping-table`, {
      token: owner,
      body: { cylinderConfig: { lengthMm: 4000, widthMm: 2000, heightMm: 2000, orientation: 'PRISMATIC' } }
    });
    check(
      "Test 11: Prizmatik (dikdörtgen prizma) geometri strapping-table olarak kabul edilir (diameterMm olmadan)",
      prismConfig.status === 201 && prismConfig.body?.data?.source === 'CYLINDER_FORMULA',
      `status=${prismConfig.status}, body=${JSON.stringify(prismConfig.body)}`
    );

    // 4000mm x 2000mm taban, 1000mm dolum yüksekliği → 4000*2000*1000 mm³ = 8_000_000_000 mm³ = 8000 L (yarı dolu)
    const prismVolHalf = await call('GET', `/tanks/${prismTankId}/volume?levelMm=1000`, { token: owner });
    check(
      'Test 12: Prizmatik hacim hesabı doğru (4m x 2m taban, 1m dolum = 8000 L ham hacim)',
      prismVolHalf.status === 200 && Number(prismVolHalf.body?.data?.observedLiters ?? prismVolHalf.body?.data?.rawLiters) === 8000,
      `status=${prismVolHalf.status}, body=${JSON.stringify(prismVolHalf.body)}`
    );

    // === Test 13 (ASIL AC — "ölü hacim hesabı", prizmatik dahil): usableLiters = standartLiters - deadVolume ===
    check(
      'Test 13 (ASIL AC): /tanks/:id/volume — usableLiters, prizmatik hacimden ölü hacim (200L) düşülerek hesaplanır',
      prismVolHalf.status === 200 &&
        typeof prismVolHalf.body?.data?.usableLiters === 'number' &&
        Math.abs(prismVolHalf.body.data.usableLiters - (Number(prismVolHalf.body.data.standardLiters ?? prismVolHalf.body.data.observedLiters) - 200)) < 0.01,
      `body=${JSON.stringify(prismVolHalf.body)}`
    );

    // === Ön koşul (FUEL-401 testiyle aynı desen): veh-1'i drv-1'e ata, otomatik ikmal testleri için ===
    await q(`UPDATE vehicles SET assigned_driver_name = 'Ahmet Yılmaz' WHERE id = 'veh-1'`);

    await q(
      `INSERT INTO tanks (id, tenant_id, name, site_name, capacity_liters, current_level_liters, fuel_type, dead_volume_liters, operational_status)
       VALUES ($1, 'comp-camsa', $2, $3, 20000, 500, 'Motorin (Euro Diesel)', 400, 'AKTİF')`,
      [dispenseTankId, dispenseTankName, SITE_NAME]
    );

    // === Test 14 (ASIL AC — otomatik ikmalde dead-volume CEILING): maxAllowedLiters, ölü hacim düşülmüş
    // kullanılabilir stokla (500-400=100L) SINIRLANIR, ham current_level_liters (500L) İLE DEĞİL ===
    const authCapped = await hwPost('/dispense/request-auth', { rfidCardId: 'CARD-881201', tankName: dispenseTankName });
    check(
      'Test 14 (ASIL AC): Otomatik ikmal izni, ölü hacim düşülmüş kullanılabilir stokla sınırlanır (maxAllowedLiters<=100, ham 500 DEĞİL)',
      authCapped.status === 200 && Number(authCapped.data?.data?.maxAllowedLiters ?? authCapped.data?.maxAllowedLiters) <= 100,
      `status=${authCapped.status}, body=${JSON.stringify(authCapped.data)}`
    );

    // Oturumu iptal et (bir sonraki teste temiz session gerekiyor)
    await clearDeviceDispenseSession(DEVICE_ID);

    // === Test 15 (ASIL AC — usable stock tükendiğinde TANK_LOW): dead volume >= current level ===
    await q(`UPDATE tanks SET current_level_liters = 300, dead_volume_liters = 400 WHERE id = $1`, [dispenseTankId]);
    const authTankLow = await hwPost('/dispense/request-auth', { rfidCardId: 'CARD-881201', tankName: dispenseTankName });
    check(
      'Test 15 (ASIL AC): Ölü hacim düşüldüğünde kullanılabilir stok<=0 → otomatik ikmal 409 TANK_LOW (ham seviye>0 olsa bile)',
      authTankLow.status === 409 && authTankLow.data?.details?.error === 'TANK_LOW',
      `status=${authTankLow.status}, body=${JSON.stringify(authTankLow.data)}`
    );

    // === Test 16 (ASIL AC — TANK_UNAVAILABLE): tank BAKIMDA iken otomatik ikmal reddedilir, DOLU olsa bile ===
    await q(`UPDATE tanks SET current_level_liters = 15000, dead_volume_liters = 0, operational_status = 'BAKIMDA' WHERE id = $1`, [dispenseTankId]);
    const authMaintenance = await hwPost('/dispense/request-auth', { rfidCardId: 'CARD-881201', tankName: dispenseTankName });
    check(
      'Test 16 (ASIL AC): Tank BAKIMDA iken (dolu olsa bile) otomatik ikmal 403 TANK_UNAVAILABLE ile reddedilir',
      authMaintenance.status === 403 && authMaintenance.data?.details?.error === 'TANK_UNAVAILABLE',
      `status=${authMaintenance.status}, body=${JSON.stringify(authMaintenance.data)}`
    );

    // === Test 17: DEVRE_DIŞI durumu da aynı şekilde engeller ===
    await q(`UPDATE tanks SET operational_status = 'DEVRE_DIŞI' WHERE id = $1`, [dispenseTankId]);
    const authDisabled = await hwPost('/dispense/request-auth', { rfidCardId: 'CARD-881201', tankName: dispenseTankName });
    check(
      'Test 17: Tank DEVRE_DIŞI iken de otomatik ikmal 403 TANK_UNAVAILABLE ile reddedilir',
      authDisabled.status === 403 && authDisabled.data?.details?.error === 'TANK_UNAVAILABLE',
      `status=${authDisabled.status}, body=${JSON.stringify(authDisabled.data)}`
    );

    // === Test 18 (regresyon — ASIL kapsam sınırı): operational_status BAKIMDA/DEVRE_DIŞI iken bile
    // MANUEL/operatör ikmali (POST /dispense) ETKİLENMEZ — o yol bilinçli olarak bu kontrolü taşımıyor ===
    const manualDispense = await call('POST', '/dispense', {
      token: owner,
      body: { siteName: SITE_NAME, vehiclePlate: '34 CTP 82', tankName: dispenseTankName, amountLiters: 10, driverName: 'Ahmet Yılmaz' }
    });
    check(
      'Test 18 (regresyon — kasıtlı kapsam sınırı): Manuel/operatör ikmali, tank DEVRE_DIŞI olsa da operational_status denetiminden ETKİLENMEZ',
      manualDispense.status !== 403 || manualDispense.body?.details?.error !== 'TANK_UNAVAILABLE',
      `status=${manualDispense.status}, body=${JSON.stringify(manualDispense.body)}`
    );

    // === Test 19: tank AKTİF'e dönünce otomatik ikmal tekrar çalışır (yeterli kullanılabilir stokla) ===
    await q(`UPDATE tanks SET operational_status = 'AKTİF', current_level_liters = 5000, dead_volume_liters = 100 WHERE id = $1`, [dispenseTankId]);
    const authRestored = await hwPost('/dispense/request-auth', { rfidCardId: 'CARD-881201', tankName: dispenseTankName });
    check(
      'Test 19: Tank AKTİF durumuna dönünce ve yeterli kullanılabilir stok varken otomatik ikmal tekrar başarılı',
      authRestored.status === 200,
      `status=${authRestored.status}, body=${JSON.stringify(authRestored.data)}`
    );
  } finally {
    await clearDeviceDispenseSession(DEVICE_ID).catch(() => {});
    await q(`DELETE FROM transactions WHERE tank_name = $1 AND created_at > NOW() - INTERVAL '5 minutes'`, [dispenseTankName]).catch(() => {});
    await q(`UPDATE vehicles SET assigned_driver_name = NULL WHERE id = 'veh-1'`).catch(() => {});
    await q(`DELETE FROM tank_strapping_tables WHERE tank_name LIKE $1`, [`INV1501-PrismTank-${RUN}%`]).catch(() => {});
    await q(`DELETE FROM tanks WHERE id = ANY($1) OR id = $2`, [createdTankIds, dispenseTankId]).catch(() => {});
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
