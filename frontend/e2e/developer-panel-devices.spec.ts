import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { loginCompanyUser, resetLoginRateLimit } from './helpers';

/**
 * FE-806 Test Notu: "cihaz offline olduğunda tablonun güncellenmesi; log
 * ekranında tampon sınırının korunması."
 *
 * KAPSAM UYARLAMASI (disclosed): "offline olduğunda" senaryosu burada REST
 * yeniden-çekim (fetchHardwareDevices, sayfaya girişte) yolunu test eder —
 * canlı (sayfa yenilenmeden) OFFLINE soket yayınını (device:status) tetiklemek
 * GERÇEK bir MQTT LWT/disconnect veya imzalı bir durum mesajı gerektirir;
 * bu depoda AYNI gerekçeyle (test_iot301_mqtt_resilience.ts'in kendi dosya
 * başı notu: "EMQX container'ını gerçekten durdurup/başlatıp... CI'da
 * güvenilir şekilde otomatikleştirmek ayrı bir altyapı gerektiriyor")
 * otomatik E2E'ye dahil edilmedi — canlı ONLINE→OFFLINE soket yansıması
 * manuel doğrulandı (bkz. PR açıklaması).
 */

function psql(sql: string): string {
  return execFileSync('docker', ['exec', 'yakittakip_postgres', 'psql', '-U', 'postgres', '-d', 'yakittakip_db', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();
}
function redisSetDeviceState(deviceId: string, state: 'ONLINE' | null): void {
  if (state === 'ONLINE') {
    execFileSync('docker', ['exec', 'yakittakip_redis', 'redis-cli', 'SET', `device:${deviceId}:state`, 'ONLINE', 'EX', '10']);
  } else {
    execFileSync('docker', ['exec', 'yakittakip_redis', 'redis-cli', 'DEL', `device:${deviceId}:state`]);
  }
}

test.beforeEach(() => resetLoginRateLimit());

test('geliştirici paneli: cihaz durumu REST yeniden-çekimde yansır, sağlık/heartbeat/firmware gerçek verisi görünür (FE-806)', async ({ page }) => {
  const run = Date.now();
  const deviceId = `fe806e2e-${run}`;
  try {
    psql(`INSERT INTO hardware_devices (id, tenant_id, device_id, name, site_name, encrypted_secret, status, firmware_version, last_seen_at, last_reported_rssi)
          VALUES ('hwd-${deviceId}', 'comp-camsa', '${deviceId}', 'FE806 E2E Cihaz', 'Gebze Ana Şantiye', 'x', 'AKTİF', '3.1.0', NOW(), -62)`);
    psql(`INSERT INTO device_health_scores (id, tenant_id, device_id, site_name, period_days, sample_count, score, computed_at)
          VALUES ('dhs-${deviceId}', 'comp-camsa', '${deviceId}', 'Gebze Ana Şantiye', 30, 5, 91, NOW())`);
    redisSetDeviceState(deviceId, 'ONLINE');

    await loginCompanyUser(page, 'admin');
    await page.goto('/admin/devices');

    const card = page.locator(`[data-testid="device-card"][data-device-code="${deviceId}"]`);
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-device-status', 'ONLINE');
    await expect(card.getByTestId('device-health-score')).toContainText('91');
    await expect(card.getByTestId('device-last-heartbeat')).toContainText('Az önce');

    // Cihaz OFFLINE'a düşer (redis anahtarı silinir — LWT/timeout'un bıraktığı GERÇEK son durum).
    // hardwareDevices yalnızca girişte BİR KEZ çekiliyor (SPA içi gezinme yeniden
    // ÇEKMEZ) — bu yüzden bir tam sayfa yenilemesi (oturum localStorage'dan
    // GERİ YÜKLENİR, SUPER_ADMIN fetch efekti yeniden çalışır) gerekiyor.
    redisSetDeviceState(deviceId, null);
    await page.reload();
    await expect(page.locator(`[data-testid="device-card"][data-device-code="${deviceId}"]`)).toHaveAttribute('data-device-status', 'OFFLINE');
  } finally {
    psql(`DELETE FROM device_health_scores WHERE device_id = '${deviceId}'`);
    psql(`DELETE FROM hardware_devices WHERE device_id = '${deviceId}'`);
  }
});

test('canlı log ekranı: 500 satır tamponu korunur, bellek sızıntısı yapmaz (FE-806 Teknik Not)', async ({ page }) => {
  const run = Date.now();
  const deviceId = `fe806log-${run}`;
  try {
    psql(`INSERT INTO hardware_devices (id, tenant_id, device_id, name, site_name, encrypted_secret, status)
          VALUES ('hwd-${deviceId}', 'comp-camsa', '${deviceId}', 'FE806 Log E2E Cihaz', 'Gebze Ana Şantiye', 'x', 'AKTİF')`);

    await loginCompanyUser(page, 'admin');
    await page.goto('/admin/devices');
    await expect(page.getByTestId('device-ping').first()).toBeVisible();

    // 600 satır ÜRET (tampon 500) — native DOM click'leri ile hızlı (Playwright
    // actionability beklemesi olmadan), her tıklama TEK bir gerçek log satırı ekler.
    await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="device-ping"]') as HTMLButtonElement;
      for (let i = 0; i < 600; i++) btn.click();
    });

    // SPA içi gezinme (page.goto DEĞİL — tam sayfa yenilemesi hardwareLogs'u
    // (yalnızca bellekte, kalıcılaştırılmaz) SIFIRLARDI ve test amacını bozardı).
    await page.getByRole('button', { name: 'Canlı Sistem Logları' }).click();
    await page.waitForURL(/\/admin\/logs/);
    const countText = await page.getByTestId('log-count').textContent();
    const total = Number(countText?.match(/\/\s*(\d+)\s*\(/)?.[1]);
    expect(total).toBe(500);

    const lineCount = await page.getByTestId('log-line').count();
    expect(lineCount).toBeLessThanOrEqual(500);
  } finally {
    psql(`DELETE FROM hardware_devices WHERE device_id = '${deviceId}'`);
  }
});
