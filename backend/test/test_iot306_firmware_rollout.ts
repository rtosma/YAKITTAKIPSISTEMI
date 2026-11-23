import mqtt from 'mqtt';
import { Client } from 'pg';
import { execFileSync } from 'child_process';
import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * IOT-306 (#156) — OTA firmware dağıtım servisi (sürüm, kanal, kademeli rollout).
 *
 * IOT-305/FUEL-406 ile AYNI black-box yaklaşım: gerçek MQTT "cihaz"
 * istemcileriyle command/v1/{deviceId} komutlarına ACK/NACK yayınlanır.
 * HOST'tan çalışır (nginx :3000, EMQX :1883 — ikisi de host'a yayınlı);
 * Redis'e host'un YANLIŞ/ilgisiz local instance'ından değil, `docker compose
 * exec redis redis-cli` üzerinden yazılır (bkz. test_iot305/test_fuel406).
 *
 * AC kapsamı: kademeli dağıtım (%10→%50→%100), ikmal yapan cihazın
 * atlanması, başarısızlık eşiği aşılınca otomatik durdurma, rollback
 * bildirimi izlenmesi, RBAC.
 *
 * CI'a EKLENMEDİ — test_res905/test_iot305/test_fuel406 ile AYNI gerekçe:
 * `docker` CLI'ı (redisCli, "ikmal yapıyor" fixture'ını kurmak için) çağırır,
 * GH Actions'ın `services:` modeli bunu desteklemez. Host'ta ayrı çalıştırılır.
 */

const API_URL = 'http://localhost:3000/api/v1';
const MQTT_URL = process.env.MQTT_URL_TEST || 'mqtt://localhost:1883';
const MQTT_USERNAME = process.env.MQTT_USERNAME || '';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || '';
const TENANT_ID = 'comp-camsa';
const RUN = Date.now();
const REPO_ROOT = `${process.cwd()}/..`;

function redisCli(...args: string[]): string {
  return execFileSync('docker', ['compose', 'exec', '-T', 'redis', 'redis-cli', ...args], { cwd: REPO_ROOT, encoding: 'utf-8' }).trim();
}
function redisDel(...keys: string[]): void {
  if (keys.length) redisCli('DEL', ...keys);
}
function redisSetSession(deviceId: string): void {
  const session = {
    sessionId: `sess-${RUN}`,
    tenantId: TENANT_ID,
    siteName: 'Gebze Ana Şantiye',
    deviceId,
    vehiclePlate: '34 OTA 01',
    driverName: 'Test Şoför',
    tankName: 'Gebze Ana Tank (T-1)',
    state: 'PUMPING',
    maxAllowedLiters: 500,
    startTotalizerLiters: 0,
    currentTotalizerLiters: 50,
    currentFlowRateLpm: 20,
    createdAt: Date.now(),
    lastHeartbeatAt: Date.now(),
    crossSitePermissionId: null
  };
  redisCli('SET', `dispense:session:${deviceId}`, JSON.stringify(session), 'EX', '1800');
}

function pg(): Client {
  return new Client({
    host: 'localhost',
    port: 5432,
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

/** Bir "cihaz" MQTT istemcisi: command/v1/{deviceId}'yi dinler, gelen komuta ANINDA ACK ya da NACK döner. */
async function simulateDevice(deviceId: string, behavior: 'ACK' | 'NACK'): Promise<mqtt.MqttClient> {
  const client = mqtt.connect(MQTT_URL, { username: MQTT_USERNAME, password: MQTT_PASSWORD, protocolVersion: 5 });
  await new Promise<void>((resolve, reject) => {
    client.on('connect', () => resolve());
    client.on('error', reject);
  });
  await new Promise<void>((resolve, reject) => {
    client.subscribe(`command/v1/${deviceId}`, (err) => (err ? reject(err) : resolve()));
  });
  client.on('message', (_topic, payload) => {
    const msg = JSON.parse(payload.toString());
    if (msg.commandId) {
      client.publish(`command/v1/${deviceId}/ack`, JSON.stringify({ commandId: msg.commandId, status: behavior }), { qos: 1 });
    }
  });
  return client;
}

async function run() {
  console.log('===========================================================');
  console.log('📦 [IOT-306] OTA FİRMWARE DAĞITIM SERVİSİ TESTİ');
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
  const superAdmin = await login('admin');

  const hwSuccess = `HWREV-OTA-SUCCESS-${RUN}`;
  const hwHalt = `HWREV-OTA-HALT-${RUN}`;
  const hwBusy = `HWREV-OTA-BUSY-${RUN}`;
  const devS = [`iot306-s1-${RUN}`, `iot306-s2-${RUN}`, `iot306-s3-${RUN}`];
  const devH = [`iot306-h1-${RUN}`, `iot306-h2-${RUN}`, `iot306-h3-${RUN}`];
  const devB = [`iot306-b1-${RUN}`, `iot306-b2-${RUN}`];
  const allDeviceIds = [...devS, ...devH, ...devB];
  const mqttClients: mqtt.MqttClient[] = [];
  const pumpUsername = `iot306-pump-${RUN}`;

  try {
    for (const [i, id] of devS.entries()) {
      await q(`INSERT INTO hardware_devices (id, tenant_id, device_id, name, site_name, encrypted_secret, hardware_revision, firmware_version, status) VALUES ($1,'comp-camsa',$1,$2,'Gebze Ana Şantiye','x',$3,'1.0.0','AKTİF')`, [id, `OTA-Success-${i}`, hwSuccess]);
      mqttClients.push(await simulateDevice(id, 'ACK'));
    }
    for (const [i, id] of devH.entries()) {
      await q(`INSERT INTO hardware_devices (id, tenant_id, device_id, name, site_name, encrypted_secret, hardware_revision, firmware_version, status) VALUES ($1,'comp-camsa',$1,$2,'Gebze Ana Şantiye','x',$3,'1.0.0','AKTİF')`, [id, `OTA-Halt-${i}`, hwHalt]);
      mqttClients.push(await simulateDevice(id, i === 0 ? 'NACK' : 'ACK'));
    }
    for (const [i, id] of devB.entries()) {
      await q(`INSERT INTO hardware_devices (id, tenant_id, device_id, name, site_name, encrypted_secret, hardware_revision, firmware_version, status) VALUES ($1,'comp-camsa',$1,$2,'Gebze Ana Şantiye','x',$3,'1.0.0','AKTİF')`, [id, `OTA-Busy-${i}`, hwBusy]);
      mqttClients.push(await simulateDevice(id, 'ACK'));
    }
    redisSetSession(devB[0]); // devB[0] "ikmal yapıyor" — OTA başlatılmamalı

    // === Test 1: RBAC — COMPANY_OWNER firmware artefaktı OLUŞTURAMAZ (SUPER_ADMIN-only). ===
    const artifactDenied = await call('POST', '/firmware-artifacts', {
      token: owner,
      body: { version: '2.0.0', hardwareRevision: hwSuccess, channel: 'stable', artifactUrl: 'https://cdn.example.com/fw.bin', sha256: 'a'.repeat(64), signature: 'sig' }
    });
    check('Test 1: COMPANY_OWNER firmware artefaktı oluşturamaz (403)', artifactDenied.status === 403, `status=${artifactDenied.status}`);

    // === Test 2: SUPER_ADMIN 3 farklı donanım revizyonu için artefakt kaydeder. ===
    const artifactSuccess = await call('POST', '/firmware-artifacts', { token: superAdmin, body: { version: '2.0.0', hardwareRevision: hwSuccess, channel: 'stable', artifactUrl: 'https://cdn.example.com/fw.bin', sha256: 'a'.repeat(64), signature: 'sig' } });
    const artifactHalt = await call('POST', '/firmware-artifacts', { token: superAdmin, body: { version: '2.0.0', hardwareRevision: hwHalt, channel: 'stable', artifactUrl: 'https://cdn.example.com/fw.bin', sha256: 'b'.repeat(64), signature: 'sig' } });
    const artifactBusy = await call('POST', '/firmware-artifacts', { token: superAdmin, body: { version: '2.0.0', hardwareRevision: hwBusy, channel: 'stable', artifactUrl: 'https://cdn.example.com/fw.bin', sha256: 'c'.repeat(64), signature: 'sig' } });
    check(
      'Test 2: SUPER_ADMIN 3 firmware artefaktını başarıyla kaydeder',
      artifactSuccess.status === 201 && artifactHalt.status === 201 && artifactBusy.status === 201,
      `statuses=${artifactSuccess.status},${artifactHalt.status},${artifactBusy.status}`
    );

    // === Test 3 (ASIL AC — kademeli dağıtım + tamamlanma): tüm cihazlar ACK ederse
    // rollout %10→%50→%100 ilerler, 3/3 cihaza ulaşır, TAMAMLANDI. ===
    const rolloutSuccess = await call('POST', '/firmware-rollouts', { token: owner, body: { firmwareArtifactId: artifactSuccess.body.data.id } });
    const stagesSuccess = rolloutSuccess.body?.data?.stages ?? [];
    const dbDevicesSuccess = await q(`SELECT device_id, status FROM firmware_rollout_devices WHERE rollout_id = $1`, [rolloutSuccess.body?.data?.rollout?.id]);
    check(
      "Test 3 (ASIL AC — kademeli dağıtım): 3 aşamada (%10,%50,%100) toplam 3 cihaza ulaşıldı, hepsi BAŞARILI, rollout TAMAMLANDI",
      rolloutSuccess.status === 201 &&
        rolloutSuccess.body?.data?.rollout?.status === 'TAMAMLANDI' &&
        stagesSuccess.length === 3 &&
        stagesSuccess.reduce((s: number, x: any) => s + x.dispatched, 0) === 3 &&
        dbDevicesSuccess.length === 3 &&
        dbDevicesSuccess.every((d) => d.status === 'BAŞARILI'),
      `status=${rolloutSuccess.body?.data?.rollout?.status}, stages=${JSON.stringify(stagesSuccess.map((s: any) => ({ pct: s.stagePct, d: s.dispatched })))}, dbDevices=${dbDevicesSuccess.length}`
    );

    // === Test 4 (ASIL AC — başarısızlık eşiği aşılınca otomatik durdurma): 3 cihazlı grupta
    // 1. cihaz NACK eder → %10 aşamasında (1 cihaz) başarısızlık oranı %100 > %20 eşiği →
    // rollout DURDURULDU, kalan 2 cihaza HİÇ dokunulmaz. ===
    const rolloutHalt = await call('POST', '/firmware-rollouts', { token: owner, body: { firmwareArtifactId: artifactHalt.body.data.id } });
    const dbDevicesHalt = await q(`SELECT device_id, status FROM firmware_rollout_devices WHERE rollout_id = $1`, [rolloutHalt.body?.data?.rollout?.id]);
    check(
      "Test 4 (ASIL AC — otomatik durdurma): 1. cihaz NACK → rollout DURDURULDU, YALNIZCA 1 cihaza (o da BAŞARISIZ) dokunuldu",
      rolloutHalt.status === 201 &&
        rolloutHalt.body?.data?.rollout?.status === 'DURDURULDU' &&
        !!rolloutHalt.body?.data?.rollout?.halted_reason &&
        dbDevicesHalt.length === 1 &&
        dbDevicesHalt[0].status === 'BAŞARISIZ',
      `status=${rolloutHalt.body?.data?.rollout?.status}, haltedReason=${rolloutHalt.body?.data?.rollout?.halted_reason}, dbDevices=${JSON.stringify(dbDevicesHalt)}`
    );

    // === Test 5 (ASIL AC — "İkmal sırasında güncelleme başlatılmamalıdır"): ikmal yapan
    // cihaz (devB[0]) rollout'a HİÇ dahil edilmez (skippedBusyDeviceIds'te görünür,
    // firmware_rollout_devices'a hiç satır yazılmaz); diğer cihaz normal işlenir. ===
    const rolloutBusy = await call('POST', '/firmware-rollouts', { token: owner, body: { firmwareArtifactId: artifactBusy.body.data.id } });
    const dbDevicesBusy = await q(`SELECT device_id FROM firmware_rollout_devices WHERE rollout_id = $1`, [rolloutBusy.body?.data?.rollout?.id]);
    const allSkippedBusy: string[] = (rolloutBusy.body?.data?.stages ?? []).flatMap((s: any) => s.skippedBusyDeviceIds);
    check(
      "Test 5 (ASIL AC — ikmal sırasında güncelleme başlatılmaz): ikmal yapan cihaz skippedBusyDeviceIds'te VE hiçbir firmware_rollout_devices satırında YOK",
      rolloutBusy.status === 201 &&
        allSkippedBusy.includes(devB[0]) &&
        !dbDevicesBusy.some((d) => d.device_id === devB[0]) &&
        dbDevicesBusy.some((d) => d.device_id === devB[1]),
      `skippedBusy=${JSON.stringify(allSkippedBusy)}, dbDevices=${JSON.stringify(dbDevicesBusy)}`
    );

    // === Test 6: RBAC — PUMP_OPERATOR rollout başlatamaz (403). ===
    await q(`INSERT INTO users (id, tenant_id, username, password_hash, role) SELECT $1, 'comp-camsa', $2, password_hash, 'PUMP_OPERATOR' FROM users WHERE username = 'camsa'`, [`usr-${pumpUsername}`, pumpUsername]);
    const pumpToken = await login(pumpUsername);
    const rolloutDenied = await call('POST', '/firmware-rollouts', { token: pumpToken, body: { firmwareArtifactId: artifactSuccess.body.data.id } });
    check('Test 6: PUMP_OPERATOR rollout başlatamaz (403)', rolloutDenied.status === 403, `status=${rolloutDenied.status}`);

    // === Test 7 (AC — cihaz tarafı rollback sinyalinin izlenmesi, FW-1311): başarılı
    // bir rollout'taki bir cihaz SONRADAN A/B rollback bildirir → GERİ_ALINDI. ===
    const rollbackRes = await call('POST', `/firmware-rollouts/${rolloutSuccess.body.data.rollout.id}/devices/${devS[0]}/report-rollback`, {
      token: owner,
      body: { reason: 'Yeni firmware boot testinden geçemedi, A/B rollback tetiklendi.' }
    });
    check(
      'Test 7 (AC — rollback izlenmesi): cihazın rollback bildirimi firmware_rollout_devices satırını GERİ_ALINDI yapar',
      rollbackRes.status === 200 && rollbackRes.body?.data?.status === 'GERİ_ALINDI',
      `status=${rollbackRes.status}, recordStatus=${rollbackRes.body?.data?.status}`
    );

    // === Test 8: GET /firmware-rollouts/:id detay — cihaz kırılımını döndürür. ===
    const detail = await call('GET', `/firmware-rollouts/${rolloutSuccess.body.data.rollout.id}`, { token: owner });
    check(
      'Test 8: Rollout detayı 3 cihazlık kırılımı döndürür',
      detail.status === 200 && detail.body?.data?.devices?.length === 3,
      `status=${detail.status}, deviceCount=${detail.body?.data?.devices?.length}`
    );
  } finally {
    mqttClients.forEach((c) => c.end(true));
    redisDel(`dispense:session:${devB[0]}`);
    await q('DELETE FROM firmware_rollout_devices WHERE device_id = ANY($1)', [allDeviceIds]);
    await q('DELETE FROM firmware_rollouts WHERE tenant_id = $1 AND firmware_artifact_id IN (SELECT id FROM firmware_artifacts WHERE hardware_revision = ANY($2))', ['comp-camsa', [hwSuccess, hwHalt, hwBusy]]);
    await q('DELETE FROM firmware_artifacts WHERE hardware_revision = ANY($1)', [[hwSuccess, hwHalt, hwBusy]]);
    await q('DELETE FROM hardware_devices WHERE id = ANY($1)', [allDeviceIds]);
    await q('DELETE FROM users WHERE username = $1', [pumpUsername]);
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
