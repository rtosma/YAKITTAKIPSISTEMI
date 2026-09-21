import { test, expect } from '@playwright/test';
import { activateManager, createTenant, provisionSite, uiLogin, uniq, NEW_PASSWORD } from './support';

/**
 * TEST-1004 — KİMLİK AKIŞLARI: geçici parola, zorunlu değişiklik, yetkisiz erişim.
 */
test('geçici parola → zorunlu değişiklik → eski parola geçersiz, yeni parola çalışır', async ({ page }) => {
  const t = await createTenant('Kimlik');
  const mgr = await provisionSite(t, `E2E Şantiye ${uniq()}`);

  // Geçici parolayla giriş → panel DEĞİL, zorunlu parola değişikliği ekranı
  await uiLogin(page, 'site', mgr.managerUsername, mgr.temporaryPassword, /\/parola-degistir/);
  // Değiştirmeden panele gitmeye çalış → geri yönlendirilir
  await page.goto('/santiye-panel');
  await expect(page).toHaveURL(/\/parola-degistir/);

  // İstemci doğrulamaları: uyumsuz tekrar, kısa parola, geçici parolayla aynı
  await page.getByTestId('pwchange-current').fill(mgr.temporaryPassword);
  await page.getByTestId('pwchange-new').fill(NEW_PASSWORD);
  await page.getByTestId('pwchange-confirm').fill(`${NEW_PASSWORD}x`);
  await page.getByTestId('pwchange-submit').click();
  await expect(page.getByTestId('pwchange-error')).toBeVisible();
  await page.getByTestId('pwchange-new').fill('kisa');
  await page.getByTestId('pwchange-confirm').fill('kisa');
  await page.getByTestId('pwchange-submit').click();
  await expect(page.getByTestId('pwchange-error')).toBeVisible();
  await expect(page).toHaveURL(/\/parola-degistir/);

  // Geçerli değişiklik → panel
  await page.getByTestId('pwchange-new').fill(NEW_PASSWORD);
  await page.getByTestId('pwchange-confirm').fill(NEW_PASSWORD);
  const [changed] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/change-password')),
    page.getByTestId('pwchange-submit').click()
  ]);
  expect(changed.status()).toBe(200);
  await expect(page).toHaveURL(/\/santiye-panel/);
  await expect(page.getByTestId('site-panel')).toBeVisible();

  // Çıkış → ESKİ (geçici) parola artık geçersiz; yenisi çalışır
  await page.getByTestId('site-logout').click();
  await expect(page).toHaveURL(/\/(santiye-)?login/);
  await uiLogin(page, 'site', mgr.managerUsername, mgr.temporaryPassword, null);
  await expect(page.getByTestId('login-error')).toBeVisible();
  await expect(page).toHaveURL(/\/santiye-login/);
  await uiLogin(page, 'site', mgr.managerUsername, NEW_PASSWORD, /\/santiye-panel/);
  await expect(page.getByTestId('site-panel')).toBeVisible();
});

test('yetkisiz erişim: oturumsuz, şantiye yöneticisi ve firma sahibi rol sınırlarını aşamaz', async ({ page }) => {
  const t = await createTenant('Yetki');
  const mgr = await provisionSite(t, `E2E Şantiye ${uniq()}`);
  await activateManager(mgr.managerUsername, mgr.temporaryPassword);

  // Oturumsuz: firma paneli giriş sayfasına yönlendirir; panel içeriği görünmez
  await page.goto('/panel');
  await expect(page).not.toHaveURL(/\/panel/);
  await expect(page.getByTestId('login-submit')).toBeVisible();

  // Şantiye yöneticisi: firma paneli ve admin paneli YASAK (403 sayfası)
  await uiLogin(page, 'site', mgr.managerUsername, NEW_PASSWORD, /\/santiye-panel/);
  await page.goto('/panel');
  await expect(page.getByTestId('forbidden-page')).toBeVisible();
  await page.goto('/admin/tenants');
  await expect(page.getByTestId('forbidden-page')).toBeVisible();
  await expect(page.getByTestId('tenant-add-open')).toHaveCount(0);

  // Firma sahibi: admin paneli YASAK; kendi paneli açık
  await page.evaluate(() => localStorage.clear());
  await uiLogin(page, 'company', t.ownerUsername, undefined, /\/panel/);
  await page.goto('/admin/tenants');
  await expect(page.getByTestId('forbidden-page')).toBeVisible();
  await expect(page.getByTestId('tenant-add-open')).toHaveCount(0);
  await page.goto('/panel/sites');
  await expect(page.getByTestId('site-add-open')).toBeVisible();
});
