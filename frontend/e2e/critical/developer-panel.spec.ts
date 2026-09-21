import { test, expect } from '@playwright/test';
import { api, createTenant, login, publishMqtt, seedFuel, uiLogin, uniq } from './support';

/**
 * TEST-1004 — GELİŞTİRİCİ (SUPER_ADMIN) paneli: firma oluşturma → modül aç/kapa → cihaz sağlığı görüntüleme.
 * Her adım arayüzden yapılır; sonuç sunucu durumuyla (API) ayrıca doğrulanır — "ekranda göründü ama kaydedilmedi" yanlış yeşilini önler.
 */
test('geliştirici: firma oluştur → modül aç/kapa + lisans → cihaz sağlığı', async ({ page }) => {
  const name = `E2E Firma ${uniq()}`;
  await uiLogin(page, 'company', 'admin'); // (uygulama SUPER_ADMIN'i /panel'e indiriyor; geliştirici paneline doğrudan gidilir)

  // ── 1) Firma oluşturma ──
  await page.goto('/admin/tenants');
  await page.getByTestId('tenant-add-open').click();
  await page.getByTestId('tenant-name-input').fill(name);
  await page.getByTestId('tenant-city-input').fill('Ankara');
  await page.getByTestId('tenant-tax-input').fill('1234567890');
  const [created] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/v1/companies') && r.request().method() === 'POST'),
    page.getByTestId('tenant-save').click()
  ]);
  expect(created.status()).toBe(200);
  const tenantId: string = (await created.json()).data.id;
  const row = page.locator(`[data-testid="tenant-row"][data-tenant-name="${name}"]`);
  await expect(row).toBeVisible();

  // ── 2) Modül aç/kapa (arayüzden) → sunucuda kalıcı ──
  await row.getByTestId('tenant-detail-open').click();
  const toggle = page.getByTestId('module-toggle-aiAnomaly');
  const before = (await toggle.getAttribute('data-enabled')) === 'true';
  const admin = await login('admin');
  const moduleOnServer = async (): Promise<boolean> => {
    const list = await api('GET', '/companies', { token: admin });
    return !!list.body.data.find((c: any) => c.id === tenantId)?.modules?.aiAnomaly;
  };
  expect(await moduleOnServer()).toBe(before);
  await toggle.click();
  await expect(toggle).toHaveAttribute('data-enabled', String(!before));
  await expect.poll(moduleOnServer).toBe(!before);
  await toggle.click(); // geri al: iki yönlü çalıştığını göster
  await expect(toggle).toHaveAttribute('data-enabled', String(before));
  await expect.poll(moduleOnServer).toBe(before);

  // Lisans durumu
  await page.getByTestId('license-status-ASKIDA').click();
  await expect.poll(async () => (await api('GET', '/companies', { token: admin })).body.data.find((c: any) => c.id === tenantId)?.licenseStatus).toBe('ASKIDA');

  // ── 3) Cihaz sağlığı: kayıtlı cihaz, MQTT ile ONLINE olur → panelde görünür ──
  const t = await createTenant('Cihaz');
  const fx = await seedFuel(t, `E2E Şantiye ${uniq()}`);
  await page.goto('/admin/devices');
  const card = page.locator(`[data-testid="device-card"][data-device-code="${fx.deviceId}"]`);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-device-status', 'OFFLINE'); // henüz hiç sinyal yok
  publishMqtt(`telemetry/v1/${t.id}/site/pump/${fx.deviceId}/status`, 'ONLINE');
  await expect.poll(async () => {
    await page.goto('/admin/devices');
    return page.locator(`[data-testid="device-card"][data-device-code="${fx.deviceId}"]`).getAttribute('data-device-status');
  }, { timeout: 20_000 }).toBe('ONLINE');
});
