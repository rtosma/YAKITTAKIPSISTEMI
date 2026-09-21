import { test, expect } from '@playwright/test';
import { api, createTenant, uiLogin, uniq, VALID_TCKN } from './support';

/**
 * TEST-1004 — YÖNETİCİ (COMPANY_OWNER) paneli: şantiye oluşturma → araç/sürücü tanımı → çapraz alım yetkisi.
 */
test('yönetici: şantiye → sürücü → araç → çapraz alım yetkisi', async ({ page }) => {
  const t = await createTenant('Yonetici');
  const siteA = `E2E Şantiye A ${uniq()}`;
  const siteB = `E2E Şantiye B ${uniq()}`;
  const driverName = `E2E Sürücü ${uniq()}`;
  const plate = '06 ABC 1234';
  await uiLogin(page, 'company', t.ownerUsername);
  await expect(page).toHaveURL(/\/panel/);

  // ── 1) İki şantiye ──
  await page.goto('/panel/sites');
  for (const site of [siteA, siteB]) {
    await page.getByTestId('site-add-open').click();
    await page.getByTestId('site-name-input').fill(site);
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/v1/sites') && r.request().method() === 'POST'),
      page.getByTestId('site-save').click()
    ]);
    expect(res.status()).toBe(200);
    await expect(page.locator(`[data-testid="site-card"][data-site-name="${site}"]`)).toBeVisible();
  }

  // ── 2) Sürücü tanımı (A şantiyesi) ──
  await page.goto('/panel/drivers');
  await page.getByTestId('driver-add-open').click();
  await page.getByTestId('driver-name-input').fill(driverName);
  await page.getByTestId('driver-phone-input').fill('0532 111 22 33');
  await page.getByTestId('driver-tc-input').fill(VALID_TCKN);
  await page.getByTestId('driver-site-select').selectOption(siteA);
  const [drv] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/v1/drivers') && r.request().method() === 'POST'),
    page.getByTestId('driver-save').click()
  ]);
  expect(drv.status()).toBe(200);
  await expect(page.locator(`[data-testid="driver-row"][data-driver-name="${driverName}"]`)).toBeVisible();

  // ── 3) Araç tanımı (A şantiyesi, sürücü atanmış) ──
  await page.goto('/panel/vehicles');
  await page.getByTestId('vehicle-add-open').click();
  await page.getByTestId('vehicle-plate-input').fill(plate);
  await page.getByTestId('vehicle-brand-input').fill('E2E Kamyon');
  await page.getByTestId('vehicle-site-select').selectOption(siteA);
  await page.getByTestId('vehicle-driver-select').selectOption(driverName);
  const [veh] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/v1/vehicles') && r.request().method() === 'POST'),
    page.getByTestId('vehicle-save').click()
  ]);
  expect(veh.status()).toBe(200);
  const vrow = page.locator(`[data-testid="vehicle-row"][data-plate="${plate}"]`);
  await expect(vrow).toBeVisible();
  await expect(vrow).toHaveAttribute('data-vehicle-status', 'AKTİF');
  // Aynı plaka tekrar: sunucu reddeder, ikinci satır oluşmaz
  await page.getByTestId('vehicle-add-open').click();
  await page.getByTestId('vehicle-plate-input').fill(plate);
  await page.getByTestId('vehicle-brand-input').fill('E2E Kamyon 2');
  await page.getByTestId('vehicle-site-select').selectOption(siteA);
  const [dup] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/v1/vehicles') && r.request().method() === 'POST'),
    page.getByTestId('vehicle-save').click()
  ]);
  expect(dup.status()).toBe(409);
  await expect(page.locator(`[data-testid="vehicle-row"][data-plate="${plate}"]`)).toHaveCount(1);

  // ── 4) Çapraz alım yetkisi: A şantiyesinin aracı B şantiyesinden yakıt alabilsin ──
  await page.goto('/panel/cross-site');
  await page.getByTestId('crosssite-add-open').click();
  await page.getByTestId('crosssite-plate-select').selectOption(plate);
  await page.getByTestId('crosssite-target-select').selectOption(siteB);
  await page.getByTestId('crosssite-liters-input').fill('300');
  const [perm] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/v1/cross-site-permissions') && r.request().method() === 'POST'),
    page.getByTestId('crosssite-save').click()
  ]);
  expect(perm.status()).toBe(200);
  const prow = page.locator(`[data-testid="crosssite-row"][data-plate="${plate}"][data-target-site="${siteB}"]`);
  await expect(prow).toBeVisible();
  await expect(prow).toHaveAttribute('data-permission-status', 'AKTİF');

  // Sunucu durumu: gerçekten kaydedildi
  const list = await api('GET', '/cross-site-permissions', { token: t.ownerToken });
  expect(list.body.data.some((p: any) => p.vehicle_plate === plate && p.target_site === siteB && Number(p.allowed_liters) === 300 && p.home_site === siteA)).toBe(true);
});
