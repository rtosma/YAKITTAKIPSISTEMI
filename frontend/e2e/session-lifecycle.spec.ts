import { execSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { loginCompanyUser, loginSiteUser, resetLoginRateLimit } from './helpers';

/**
 * TEST_PLAN.md §3.3 (E2E 3. tur) — oturumun uçtan uca yaşam döngüsü.
 *
 * Bu turda bulunan iki gerçek açık bu dosyanın var olma sebebi:
 *  1) "Çıkış Yap" yalnızca localStorage'ı siliyordu; frontend POST /auth/logout
 *     ucunu HİÇ çağırmıyordu → sunucudaki refresh token 7 gün geçerli
 *     kalıyordu (kopyalanmış bir token çıkıştan sonra da yeni access token
 *     alabiliyordu).
 *  2) SUPER_ADMIN panelinde çıkış butonu YOKTU — "Rol Seçimine Dön" `/`'a
 *     gidiyor, giriş sayfası da oturum açık olduğu için panele geri
 *     yolluyordu: platformun en yetkili hesabı arayüzden çıkamıyordu.
 */

test.beforeEach(() => resetLoginRateLimit());

async function storedTokens(page: Page) {
  return page.evaluate(() => ({
    access: localStorage.getItem('YAKIT_ACCESS_TOKEN'),
    refresh: localStorage.getItem('YAKIT_REFRESH_TOKEN')
  }));
}

async function refreshStatus(page: Page, refreshToken: string): Promise<number> {
  const res = await page.request.post('/api/v1/auth/refresh', { data: { refreshToken } });
  return res.status();
}

const LOGOUT_CASES = [
  { role: 'COMPANY_OWNER', login: (p: Page) => loginCompanyUser(p, 'camsa') },
  { role: 'SUPER_ADMIN', login: async (p: Page) => { await loginCompanyUser(p, 'admin'); await p.goto('/admin'); } },
  { role: 'SITE_MANAGER', login: (p: Page) => loginSiteUser(p, 'gebze-santiye') }
];

for (const { role, login } of LOGOUT_CASES) {
  test(`${role}: "Çıkış Yap" oturumu SUNUCUDA da kapatır (eski refresh token reddedilir)`, async ({ page }) => {
    await login(page);
    const before = await storedTokens(page);
    expect(before.refresh, 'giriş sonrası refresh token saklanmalı').toBeTruthy();

    const logoutCall = page.waitForRequest((r) => r.url().includes('/api/v1/auth/logout') && r.method() === 'POST', { timeout: 5_000 });
    await page.getByRole('button', { name: /Çıkış Yap/ }).first().click();
    await logoutCall;

    await expect(page.locator('input[type="password"]')).toBeVisible();
    expect(await storedTokens(page)).toEqual({ access: null, refresh: null });
    expect(await refreshStatus(page, before.refresh!), 'çıkıştan sonra eski refresh token yeni oturum AÇMAMALI').toBe(401);
  });
}

test('rol, kendi grubu dışındaki panele URL ile giremez (/403)', async ({ page }) => {
  await loginCompanyUser(page, 'camsa');
  await page.goto('/admin/overview');
  await expect(page.getByText('Erişim Reddedildi')).toBeVisible();

  await page.evaluate(() => localStorage.clear());
  await loginSiteUser(page, 'gebze-santiye');
  await page.goto('/panel/overview');
  await expect(page.getByText('Erişim Reddedildi')).toBeVisible();
});

test('geçersiz/süresi dolmuş oturum (401 + yenileme başarısız) giriş ekranına döndürür ve token\'ları siler', async ({ page }) => {
  await loginCompanyUser(page, 'camsa');
  await page.evaluate(() => {
    localStorage.setItem('YAKIT_ACCESS_TOKEN', 'bozuk.access.token');
    localStorage.setItem('YAKIT_REFRESH_TOKEN', 'bozuk.refresh.token');
  });
  await page.goto('/panel/vehicles');

  await expect(page.locator('input[type="password"]')).toBeVisible({ timeout: 15_000 });
  expect(await storedTokens(page)).toEqual({ access: null, refresh: null });
});

test('5 hatalı denemeden sonra hesap kilidi (423) mesajı kullanıcıya gösterilir', async ({ page }) => {
  const username = `e2e-kilit-${Date.now()}`;
  const clearLock = () =>
    execSync(`docker exec yakittakip_redis redis-cli DEL login-fail:${username} login-lock:${username} login-lock-strikes:${username}`, { stdio: 'ignore' });
  try {
    await page.goto('/');
    await page.fill('input[placeholder="Firma Adı"]', username);
    await page.fill('input[type="password"]', 'yanlis-parola');
    let lastStatus = 0;
    for (let i = 0; i < 6 && lastStatus !== 423; i++) {
      const response = page.waitForResponse((r) => r.url().includes('/api/v1/auth/login'));
      await page.click('button[type="submit"]');
      lastStatus = (await response).status();
    }
    expect(lastStatus).toBe(423);
    await expect(page.getByText(/hesap geçici olarak kilitlendi/i)).toBeVisible();
  } finally {
    clearLock();
  }
});

test.describe('mobil görünüm (390px)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('giriş sayfası ve genel bakış yatay taşma olmadan kullanılabilir', async ({ page }) => {
    const horizontalOverflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

    await page.goto('/');
    await expect(page.locator('button[type="submit"]')).toBeInViewport();
    expect(await horizontalOverflow(), 'giriş sayfası yatay kayıyor').toBeLessThanOrEqual(1);

    await loginCompanyUser(page, 'camsa');
    await page.goto('/panel/overview');
    await expect(page.locator('#root')).not.toBeEmpty();
    expect(await horizontalOverflow(), 'genel bakış yatay kayıyor').toBeLessThanOrEqual(1);
  });
});
