import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { loginCompanyUser, resetLoginRateLimit, waitForApi } from './helpers';

/**
 * FE-807 Test Notu: "sihirbaz tamamlanır, üretilen bilgilerle giriş yapılıp
 * boş şantiye panelinin açıldığı doğrulanır."
 */

function psql(sql: string): string {
  return execFileSync('docker', ['exec', 'yakittakip_postgres', 'psql', '-U', 'postgres', '-d', 'yakittakip_db', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();
}

test.beforeEach(() => resetLoginRateLimit());

test('şantiye oluşturma sihirbazı: çok adımlı akış → tek seferlik parola → üretilen bilgilerle giriş → boş şantiye paneli (FE-807)', async ({ page }) => {
  const run = Date.now();
  const siteName = `E2E FE807 ${run}`;
  const siteLocation = 'Test OSB, İstanbul';
  try {
    await loginCompanyUser(page, 'camsa');
    await page.goto('/panel/sites');
    await waitForApi(page, ['/sites']);

    // 1) Adım: Bilgiler
    await page.getByTestId('site-add-open').click();
    await page.getByTestId('site-name-input').fill(siteName);
    await page.getByTestId('site-wizard-next').click();

    // 2) Adım: Konum
    await page.getByTestId('site-location-input').fill(siteLocation);
    await page.getByTestId('site-wizard-next').click();

    // 3) Adım: Özet → kaydet (TEK POST /sites, AUTH-204 — şantiye+kullanıcı atomik)
    const createRes = page.waitForResponse((r) => r.url().endsWith('/api/v1/sites') && r.request().method() === 'POST');
    await page.getByTestId('site-save').click();
    expect((await createRes).status()).toBe(200);

    // 4) Tek seferlik kimlik bilgileri paneli
    await expect(page.getByTestId('site-credentials-panel')).toBeVisible();
    const username = (await page.getByTestId('site-manager-username').textContent())?.trim();
    const tempPassword = (await page.getByTestId('site-manager-temp-password').textContent())?.trim();
    expect(username?.length).toBeGreaterThan(0);
    expect(tempPassword?.length).toBeGreaterThanOrEqual(8);
    await page.getByTestId('site-credentials-done').click();
    await expect(page.getByTestId('site-credentials-panel')).not.toBeVisible();

    // Şantiye listede görünüyor (konum dahil)
    const row = page.locator(`[data-testid="site-card"][data-site-name="${siteName}"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(siteLocation);

    // 5) Üretilen kimlik bilgileriyle GERÇEK giriş — geçici parola → zorunlu değişiklik → boş şantiye paneli
    await page.context().clearCookies();
    await page.evaluate(() => localStorage.clear());
    await page.goto('/santiye-login');
    await page.fill('input[placeholder="Şantiye Adı"]', username!);
    await page.fill('input[type="password"]', tempPassword!);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/parola-degistir/, { timeout: 15_000 });

    const newPassword = 'Fe807E2ePw1!';
    await page.getByTestId('pwchange-current').fill(tempPassword!);
    await page.getByTestId('pwchange-new').fill(newPassword);
    await page.getByTestId('pwchange-confirm').fill(newPassword);
    const changeRes = page.waitForResponse((r) => r.url().includes('/api/v1/auth/change-password'));
    await page.getByTestId('pwchange-submit').click();
    expect((await changeRes).status()).toBe(200);
    await page.waitForURL(/\/santiye-panel/, { timeout: 15_000 });

    // Boş şantiye paneli: doğru (yeni, veri yok) şantiyeye bağlı
    await expect(page.getByTestId('site-panel-site-name')).toHaveText(siteName);
  } finally {
    psql(`DELETE FROM sites WHERE name = '${siteName}' AND tenant_id = 'comp-camsa'`);
    psql(`DELETE FROM users WHERE site_name = '${siteName}' AND tenant_id = 'comp-camsa'`);
  }
});

test('şantiye oluşturma sihirbazı: konum boş bırakılırsa varsayılan "Türkiye" kullanılır (regresyon)', async ({ page }) => {
  const run = Date.now();
  const siteName = `E2E FE807 NoLoc ${run}`;
  try {
    await loginCompanyUser(page, 'camsa');
    await page.goto('/panel/sites');
    await waitForApi(page, ['/sites']);

    await page.getByTestId('site-add-open').click();
    await page.getByTestId('site-name-input').fill(siteName);
    await page.getByTestId('site-wizard-next').click();
    // Konum adımı BOŞ bırakılıyor.
    await page.getByTestId('site-wizard-next').click();
    const createRes = page.waitForResponse((r) => r.url().endsWith('/api/v1/sites') && r.request().method() === 'POST');
    await page.getByTestId('site-save').click();
    expect((await createRes).status()).toBe(200);
    await page.getByTestId('site-credentials-done').click();

    expect(psql(`SELECT location FROM sites WHERE name = '${siteName}' AND tenant_id = 'comp-camsa'`)).toBe('Türkiye');
  } finally {
    psql(`DELETE FROM sites WHERE name = '${siteName}' AND tenant_id = 'comp-camsa'`);
    psql(`DELETE FROM users WHERE site_name = '${siteName}' AND tenant_id = 'comp-camsa'`);
  }
});
