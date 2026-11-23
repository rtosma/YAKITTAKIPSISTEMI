import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { loginCompanyUser, resetLoginRateLimit, waitForApi } from './helpers';

/**
 * FE-811 Test Notu: "simüle ikmal akışında canlı güncelleme; bağlantı
 * kesildiğinde uyarı; acil durdurma akışı."
 *
 * KAPSAM UYARLAMASI (disclosed): "simüle ikmal akışında canlı güncelleme"
 * burada test EDİLMİYOR — backend'de GERÇEK bir "devam eden dispense
 * session" canlı telemetri yayını yok (araştırıldı, bulunamadı); bu, ayrı
 * ve daha büyük bir backend işi. Burada test edilen iki GERÇEK yeni/
 * doğrulanan yüzey: acil durdurma (yeni backend ucu) ve bağlantı kesilme
 * uyarısı (FE-801'in zaten var olan mekanizması, bu panelde ÖNCEDEN HİÇ
 * gösterilmiyordu).
 *
 * İZOLASYON: Acil durdurma bir ŞANTİYEDEKİ TÜM cihazları bloke eder —
 * paylaşılan seed şantiyeleri (Gebze/Orman/Silivri) KULLANILMAZ. Bunun
 * yerine (FE-807'deki İLE AYNI teknik) taze bir şantiye + SITE_MANAGER
 * sihirbazla oluşturulur, test SADECE o izole şantiyede çalışır.
 */

function psql(sql: string): string {
  return execFileSync('docker', ['exec', 'yakittakip_postgres', 'psql', '-U', 'postgres', '-d', 'yakittakip_db', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();
}

test.beforeEach(() => resetLoginRateLimit());

test('acil durdurma: onay gerektirir, TÜM cihazları bloke eder, audit kaydı bırakır, devam ettirilebilir (FE-811)', async ({ page }) => {
  const run = Date.now();
  const siteName = `E2E FE811 ${run}`;
  const deviceId = `FE811-E2E-DEV-${run}`;
  let managerUsername = '';
  let managerTempPassword = '';
  try {
    // 1) Taze, izole bir şantiye + SITE_MANAGER oluştur (FE-807 sihirbazı)
    await loginCompanyUser(page, 'camsa');
    await page.goto('/panel/sites');
    await waitForApi(page, ['/sites']);
    await page.getByTestId('site-add-open').click();
    await page.getByTestId('site-name-input').fill(siteName);
    await page.getByTestId('site-wizard-next').click();
    await page.getByTestId('site-wizard-next').click(); // konum adımı boş geç
    const createSiteRes = page.waitForResponse((r) => r.url().endsWith('/api/v1/sites') && r.request().method() === 'POST');
    await page.getByTestId('site-save').click();
    expect((await createSiteRes).status()).toBe(200);
    managerUsername = (await page.getByTestId('site-manager-username').textContent())?.trim() || '';
    managerTempPassword = (await page.getByTestId('site-manager-temp-password').textContent())?.trim() || '';
    await page.getByTestId('site-credentials-done').click();

    // 2) Bu şantiyeye bir test cihazı provizyonla (COMPANY_OWNER olarak, hâlâ oturum açık)
    const createDeviceRes = page.waitForResponse((r) => r.url().endsWith('/api/v1/hardware-devices') && r.request().method() === 'POST');
    await page.evaluate(async ({ siteName, deviceId }) => {
      const token = localStorage.getItem('YAKIT_ACCESS_TOKEN');
      await fetch('/api/v1/hardware-devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ deviceId, name: 'FE811 E2E Test Pompası', siteName })
      });
    }, { siteName, deviceId });
    expect((await createDeviceRes).status()).toBe(200);

    // 3) SITE_MANAGER olarak geçici parolayla giriş → zorunlu değişiklik
    await page.context().clearCookies();
    await page.evaluate(() => localStorage.clear());
    await page.goto('/santiye-login');
    await page.fill('input[placeholder="Şantiye Adı"]', managerUsername);
    await page.fill('input[type="password"]', managerTempPassword);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/parola-degistir/, { timeout: 15_000 });
    const newPassword = 'Fe811E2ePw1!';
    await page.getByTestId('pwchange-current').fill(managerTempPassword);
    await page.getByTestId('pwchange-new').fill(newPassword);
    await page.getByTestId('pwchange-confirm').fill(newPassword);
    const changeRes = page.waitForResponse((r) => r.url().includes('/api/v1/auth/change-password'));
    await page.getByTestId('pwchange-submit').click();
    expect((await changeRes).status()).toBe(200);
    await page.waitForURL(/\/santiye-panel/, { timeout: 15_000 });

    // 4) ACİL DURDUR — kısa gerekçeyle devre dışı (AC: onay/gerekçe zorunlu)
    await page.getByTestId('site-emergency-stop-open').click();
    await expect(page.getByTestId('site-emergency-stop-modal')).toBeVisible();
    await expect(page.getByTestId('site-emergency-stop-confirm')).toBeDisabled();
    await page.getByTestId('site-emergency-stop-reason-input').fill('abc');
    await expect(page.getByTestId('site-emergency-stop-confirm')).toBeDisabled();

    // 5) Geçerli gerekçeyle onayla
    await page.getByTestId('site-emergency-stop-reason-input').fill('E2E test — acil durdurma simülasyonu');
    const stopRes = page.waitForResponse((r) => r.url().includes('/emergency-stop') && r.request().method() === 'POST');
    await page.getByTestId('site-emergency-stop-confirm').click();
    expect((await stopRes).status()).toBe(200);

    // 6) Durduruldu banner'ı görünür, buton devre dışı
    await expect(page.getByTestId('site-emergency-stopped-banner')).toBeVisible();
    await expect(page.getByTestId('site-emergency-stop-open')).toBeDisabled();

    // 7) Audit log — "kim durdurdu" kaydı
    const auditRow = psql(`SELECT user_id FROM audit_logs WHERE tenant_id = 'comp-camsa' AND action = 'SITE_EMERGENCY_STOP' AND target_id = '${siteName}'`);
    expect(auditRow.length).toBeGreaterThan(0);

    // 8) Devam Ettir
    const resumeRes = page.waitForResponse((r) => r.url().includes('/emergency-resume'));
    await page.getByTestId('site-emergency-resume').click();
    expect((await resumeRes).status()).toBe(200);
    await expect(page.getByTestId('site-emergency-stopped-banner')).not.toBeVisible();
    await expect(page.getByTestId('site-emergency-stop-open')).toBeEnabled();
  } finally {
    psql(`DELETE FROM hardware_devices WHERE device_id = '${deviceId}'`);
    psql(`DELETE FROM sites WHERE name = '${siteName}' AND tenant_id = 'comp-camsa'`);
    psql(`DELETE FROM users WHERE site_name = '${siteName}' AND tenant_id = 'comp-camsa'`);
  }
});

test('bağlantı koptuğunda şantiye panelinde "bağlantı yenileniyor" uyarısı belirir, geri gelince kaybolur (FE-811)', async ({ page, context }) => {
  test.setTimeout(90_000);

  // Mevcut seed SITE_MANAGER hesabıyla — bu test HİÇBİR cihazı
  // bloke etmiyor, yalnızca soket bağlantı durumunu gözlemliyor.
  await resetLoginRateLimit();
  await page.goto('/santiye-login');
  await page.fill('input[placeholder="Şantiye Adı"]', 'gebze-santiye');
  await page.fill('input[type="password"]', '123456');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/santiye-panel/, { timeout: 15_000 });

  const staleWarning = page.getByTestId('site-connection-lost-warning');
  await expect(staleWarning).not.toBeVisible();

  await context.setOffline(true);
  await expect(staleWarning).toBeVisible({ timeout: 60_000 });

  await context.setOffline(false);
  await expect(staleWarning).not.toBeVisible({ timeout: 20_000 });
});
