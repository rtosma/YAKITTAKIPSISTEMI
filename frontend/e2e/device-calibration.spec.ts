import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { loginCompanyUser, resetLoginRateLimit, waitForApi } from './helpers';

/**
 * FE-814 (#145) — Kalibrasyon (K-factor) ekranı ve test alım sihirbazı.
 *
 * Backend (FUEL-404.1/404.2 — komut/ack/zaman aşımı/geri alma/ikinci onay +
 * test alımı sapma/öneri hesabı) zaten tamdı ve backend/test/
 * test_fuel404_1_calibration.ts'te (18/18) + test_rep718_calibration_
 * history.ts'te (9/9) kanıtlıydı — grep ile frontend'de sıfır referans.
 *
 * "Yetkisiz kullanıcı bu ekrana erişememeli" AC'si YENİDEN test EDİLMİYOR —
 * session-lifecycle.spec.ts'in "rol, kendi grubu dışındaki panele URL ile
 * giremez (/403)" testi SITE_MANAGER'ın /panel/* 'a (dolayısıyla /panel/
 * devices'a) hiç giremediğini ZATEN kanıtlıyor (route guard /panel
 * layout'unun kendisinde, alt-rotaya özgü DEĞİL).
 *
 * İZOLASYON: taze, tek seferlik (Date.now()) deviceId'li bir cihaz
 * kullanılır — paylaşılan seed cihazlara DOKUNULMAZ.
 */

function psql(sql: string): string {
  return execFileSync('docker', ['exec', 'yakittakip_postgres', 'psql', '-U', 'postgres', '-d', 'yakittakip_db', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();
}

const API_URL = 'http://localhost:3000/api/v1';

async function apiLogin(username: string, password = '123456'): Promise<string> {
  const res = await fetch(`${API_URL}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const data = await res.json();
  if (!data.accessToken) throw new Error(`login ${username}: ${JSON.stringify(data)}`);
  return data.accessToken;
}

function signHmac(deviceId: string, secret: string, body: object) {
  const rawBody = JSON.stringify(body);
  const timestamp = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${nonce}.${rawBody}`).digest('hex');
  return { headers: { 'Content-Type': 'application/json', 'X-Device-ID': deviceId, 'X-Timestamp': timestamp, 'X-Nonce': nonce, 'X-Hardware-Signature': signature }, rawBody };
}

async function provisionDevice(token: string, deviceId: string, deviceName: string, siteName: string): Promise<string> {
  const res = await fetch(`${API_URL}/hardware-devices`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ deviceId, name: deviceName, siteName })
  });
  const body = await res.json();
  if (!body?.data?.secret) throw new Error(`provizyon başarısız: ${JSON.stringify(body)}`);
  return body.data.secret;
}

test.beforeEach(() => resetLoginRateLimit());

test('test alım sihirbazı → sapma/öneri → kalibrasyon isteği → cihaz ack\'ler → K-factor güncellenir → geri alma (FE-814)', async ({ page }) => {
  test.setTimeout(60_000);
  const RUN = Date.now();
  const deviceId = `FE814-DEV-${RUN}`;
  const tankName = `FE814-Tank-${RUN}`;
  const siteName = 'Gebze Ana Şantiye';
  const owner = await apiLogin('camsa');

  try {
    const secret = await provisionDevice(owner, deviceId, `FE814 Test Pompası ${RUN}`, siteName);
    psql(`INSERT INTO tanks (id, tenant_id, name, site_name, capacity_liters, current_level_liters, fuel_type)
          VALUES ('tank-fe814-${RUN}', 'comp-camsa', '${tankName}', '${siteName}', 10000, 5000, 'Motorin')`);

    await loginCompanyUser(page, 'camsa');
    await page.goto('/panel/devices');
    await waitForApi(page, ['/hardware-devices']);

    const deviceRow = page.locator(`tr[data-testid="device-row"][data-device-id="${deviceId}"]`);
    await expect(deviceRow).toBeVisible();
    await deviceRow.getByTestId('device-calibration-open').click();
    await expect(page.getByTestId('calibration-modal')).toBeVisible();
    await expect(page.getByTestId('current-k-factor')).toContainText('Henüz kalibre edilmedi');

    // CANLI YAKALANAN BULGU (disclosed, bkz. commit mesajı): backend'in
    // test-intake'i bir BASELINE k_factor şart koşuyor (409
    // NO_BASELINE_K_FACTOR) — yepyeni bir cihazda sihirbaz DOĞRUDAN
    // BAŞLATILAMAZ, önce bu küçük formla bir ilk değer gönderilmeli.
    await expect(page.getByTestId('baseline-form')).toBeVisible();
    await page.getByTestId('baseline-k-factor-input').fill('100');
    await page.getByTestId('baseline-reason-input').fill('FE-814 E2E: ilk (taban) kalibrasyon');
    const baselineRes = page.waitForResponse((r) => r.url().includes('/calibration') && r.request().method() === 'POST');
    await page.getByTestId('baseline-save').click();
    expect((await baselineRes).status()).toBe(200);

    const baselineHistory = await (await fetch(`${API_URL}/devices/${deviceId}/calibration-history`, { headers: { Authorization: `Bearer ${owner}` } })).json();
    const baselineCommandId = baselineHistory.data[0].id;
    const baselineAck = signHmac(deviceId, secret, { commandId: baselineCommandId, status: 'ACK', appliedKFactor: 100 });
    await fetch(`${API_URL}/telemetry/calibration-ack`, { method: 'POST', headers: baselineAck.headers, body: baselineAck.rawBody });
    await expect(page.getByTestId('current-k-factor')).toContainText('100.0000', { timeout: 10_000 });

    // ASIL AC — "Test alım sihirbazı: referans hacim girişi → test alımı →
    // ölçülen değer → sapma → önerilen K-factor → onay."
    await page.getByTestId('test-intake-wizard-open').click();
    await expect(page.getByTestId('calibration-wizard')).toBeVisible();

    await page.getByTestId('wizard-tank-select').selectOption(tankName);
    await page.getByTestId('wizard-reference-volume').fill('200');
    await page.getByTestId('wizard-next').click(); // → DRAIN
    await page.getByTestId('wizard-next').click(); // → MEASURED

    await page.getByTestId('wizard-measured-value').fill('204');
    const intakeRes = page.waitForResponse((r) => r.url().includes('/test-intake') && r.request().method() === 'POST');
    await page.getByTestId('wizard-next').click();
    expect((await intakeRes).status()).toBe(200);

    await expect(page.getByTestId('wizard-deviation-result')).toBeVisible();
    await expect(page.getByTestId('wizard-deviation-pct')).toContainText('2.00');
    // Tek ölçüme dayalı uyarı — AC: "Tek ölçüm yanıltıcı olabilir."
    await expect(page.getByTestId('wizard-single-measurement-warning')).toBeVisible();

    await page.getByTestId('wizard-next').click(); // → CONFIRM
    // ASIL AC — "Önerilen K-factor kabul edilmeden uygulanmamalı; kullanıcı
    // değeri elle de düzenleyebilmelidir." Alan ÖNERİYLE önceden doldurulmuş
    // ama DÜZENLENEBİLİR — burada elle değiştiriliyor.
    const kFactorInput = page.getByTestId('wizard-final-k-factor');
    await expect(kFactorInput).not.toHaveValue('');
    await kFactorInput.fill('104.0800');
    await page.getByTestId('wizard-reason').fill('FE-814 E2E: test alımı sapması %2');

    const calibRes = page.waitForResponse((r) => r.url().includes('/calibration') && r.request().method() === 'POST');
    await page.getByTestId('wizard-submit').click();
    expect((await calibRes).status()).toBe(200);
    await expect(page.getByTestId('wizard-done')).toBeVisible();
    await page.getByText('Kapat').click();

    // ASIL AC — "Komut gönderim durumu (beklemede/uygulandı/ulaşmadı)."
    // Cihaz henüz ack'lemedi → BEKLEMEDE, "başarılı" izlenimi YOK.
    const firstRow = page.getByTestId('calibration-history-row').first();
    await expect(firstRow).toContainText('Gönderildi, Onay Bekliyor');
    const rowStatus = await firstRow.getAttribute('data-status');
    expect(rowStatus).toBe('BEKLIYOR');

    // Cihazın GERÇEK ack'i — HMAC imzalı, gerçek bir donanım bildirimini simüle eder.
    const historyResp = await (await fetch(`${API_URL}/devices/${deviceId}/calibration-history`, { headers: { Authorization: `Bearer ${owner}` } })).json();
    const pendingCommandId = historyResp.data[0].id;
    const ackSig = signHmac(deviceId, secret, { commandId: pendingCommandId, status: 'ACK', appliedKFactor: 104.08 });
    const ackRes = await fetch(`${API_URL}/telemetry/calibration-ack`, { method: 'POST', headers: ackSig.headers, body: ackSig.rawBody });
    expect(ackRes.status).toBe(200);

    // ASIL AC — pollingle (soket olayı YOK, 'calibration:acked' diye bir
    // olay backend'de hiç yayınlanmıyor) ekran kısa sürede "Uygulandı"ya döner.
    await expect(firstRow).toContainText('Uygulandı', { timeout: 10_000 });
    await expect(page.getByTestId('current-k-factor')).toContainText('104.0800');

    // ASIL AC (geçmiş/geri alma): "Geri Al" ONAYLANDI olana KADAR AYNI
    // ack akışından geçen YENİ bir komut oluşturur (DB'den SİLİNMEZ).
    const rollbackRes = page.waitForResponse((r) => r.url().includes('/calibration/rollback'));
    await page.getByTestId('rollback-calibration').click();
    expect((await rollbackRes).status()).toBe(200);
    // 3 satır: taban kalibrasyon + sihirbazdan gelen istek + geri alma.
    await expect(page.getByTestId('calibration-history-row')).toHaveCount(3);
  } finally {
    psql(`DELETE FROM calibration_test_intakes WHERE device_id = '${deviceId}'`);
    psql(`DELETE FROM calibration_commands WHERE device_id = '${deviceId}'`);
    psql(`DELETE FROM tanks WHERE name = '${tankName}'`);
    psql(`DELETE FROM hardware_devices WHERE device_id = '${deviceId}'`);
  }
});

test('±%20 üstü değişiklik ikinci onay ister; ack gelmezse "ulaşmadı" net gösterilir, başarı izlenimi vermez (FE-814)', async ({ page }) => {
  test.setTimeout(90_000);
  const RUN = Date.now();
  const deviceId = `FE814-DEV2-${RUN}`;
  const siteName = 'Gebze Ana Şantiye';
  const owner = await apiLogin('camsa');

  try {
    const secret = await provisionDevice(owner, deviceId, `FE814 Test Pompası B ${RUN}`, siteName);

    // Ön koşul: bir TABAN k_factor (ack'lenmiş) — %20 eşiği buna göre hesaplanıyor.
    const baseline = signHmac(deviceId, secret, {});
    const baseReq = await fetch(`${API_URL}/devices/${deviceId}/calibration`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner}` }, body: JSON.stringify({ newKFactor: 100, reason: 'FE-814 E2E: taban kalibrasyon' }) });
    const baseCmd = (await baseReq.json()).data;
    const baseAck = signHmac(deviceId, secret, { commandId: baseCmd.id, status: 'ACK', appliedKFactor: 100 });
    await fetch(`${API_URL}/telemetry/calibration-ack`, { method: 'POST', headers: baseAck.headers, body: baseAck.rawBody });

    await loginCompanyUser(page, 'camsa');
    await page.goto('/panel/devices');
    await waitForApi(page, ['/hardware-devices']);
    const deviceRow = page.locator(`tr[data-testid="device-row"][data-device-id="${deviceId}"]`);
    await deviceRow.getByTestId('device-calibration-open').click();
    await expect(page.getByTestId('current-k-factor')).toContainText('100.0000');

    // %30 değişiklik (eşik %20) — doğrudan API ile (sihirbaz Test A'da zaten
    // doğrulandı, burada ASIL AC olan ikinci onay/zaman aşımı gösterimine odaklanılıyor).
    const bigChangeReq = await fetch(`${API_URL}/devices/${deviceId}/calibration`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner}` }, body: JSON.stringify({ newKFactor: 130, reason: 'FE-814 E2E: büyük değişiklik' }) });
    expect((await bigChangeReq.json()).data.status).toBe('IKINCI_ONAY_BEKLIYOR');

    await page.getByTestId('calibration-modal-close').click();
    await deviceRow.getByTestId('device-calibration-open').click();
    const secondRow = page.getByTestId('calibration-history-row').first();
    await expect(secondRow).toContainText('İkinci Onay Bekliyor');

    // ASIL AC: ikinci onay verilince komut CİHAZA GÖNDERİLİR (BEKLIYOR'a geçer).
    const approveRes = page.waitForResponse((r) => r.url().includes('/approve'));
    await secondRow.getByTestId('approve-calibration').click();
    expect((await approveRes).status()).toBe(200);
    await expect(secondRow).toContainText('Gönderildi, Onay Bekliyor');

    // ASIL AC — "Komut ulaşmadıysa ekran bunu net göstermeli, 'başarılı'
    // izlenimi vermemelidir." Cihaz HİÇ ack'lemiyor — sent_at'i geriye
    // alıp (backend'in 5 dk'lık penceresini aşırıp) 30s'lik sweep'in
    // gerçek ZAMAN_ASIMI geçişini + soket olayını bekliyoruz.
    const historyNow = await (await fetch(`${API_URL}/devices/${deviceId}/calibration-history`, { headers: { Authorization: `Bearer ${owner}` } })).json();
    const sentCommandId = historyNow.data.find((c: any) => c.status === 'BEKLIYOR')?.id;
    psql(`UPDATE calibration_commands SET sent_at = NOW() - INTERVAL '6 minutes' WHERE id = '${sentCommandId}'`);

    await expect(secondRow).toContainText('Cihaza Ulaşmadı', { timeout: 40_000 });
    // ASIL AC: başarı (yeşil) rengi KESİNLİKLE almamalı.
    await expect(secondRow.getByTestId('calibration-status-badge')).not.toHaveClass(/a1e8a2/);
    // Cihaz hiç ack'lemediği için k_factor hâlâ taban (100), "uygulandı" DEĞİL.
    await expect(page.getByTestId('current-k-factor')).toContainText('100.0000');
  } finally {
    psql(`DELETE FROM calibration_test_intakes WHERE device_id = '${deviceId}'`);
    psql(`DELETE FROM calibration_commands WHERE device_id = '${deviceId}'`);
    psql(`DELETE FROM hardware_devices WHERE device_id = '${deviceId}'`);
  }
});
