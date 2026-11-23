import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { activateManager, createTenant, injectDispense, provisionSite, seedFuel, uiLogin, uniq, waitForLiveConnection, NEW_PASSWORD } from './support';

/**
 * TEST-1004 — ŞANTİYE paneli: canlı ikmal izleme → hareket listesi → rapor indirme.
 *
 * Canlı akış deterministik: rastgele bir zamanlayıcıya değil, SENTETİK olay enjeksiyonuna bağlı — cihaz gibi HMAC imzalı tam ikmal döngüsü
 * (kart okut → pompalama → bitir) tarayıcının WebSocket bağlantısı KURULDUKTAN sonra tetiklenir; panel sayfa yenilenmeden güncellenmelidir.
 * Beklenen değerler el hesabı: tank 10000 L, ikmal 60 L → 9940 L.
 */
test('şantiye: canlı ikmal izleme → hareket listesi → rapor indirme', async ({ page }) => {
  const t = await createTenant('Santiye');
  const site = `E2E Şantiye ${uniq()}`;
  const mgr = await provisionSite(t, site);
  await activateManager(mgr.managerUsername, mgr.temporaryPassword);
  const fx = await seedFuel(t, site);

  await uiLogin(page, 'site', mgr.managerUsername, NEW_PASSWORD);
  await expect(page).toHaveURL(/\/santiye-panel/);
  await expect(page.getByTestId('site-panel-site-name')).toHaveText(site);

  // ── Başlangıç: tank 10000 L, hareket yok ──
  const tank = page.locator(`[data-testid="site-tank"][data-tank-name="${fx.tank}"]`);
  await expect(tank).toHaveAttribute('data-level-liters', '10000');
  await expect(page.getByTestId('site-tx-row')).toHaveCount(0);

  // ── 1) Canlı ikmal izleme: olay enjekte edilir, sayfa YENİLENMEDEN tank düşer ve hareket görünür ──
  await waitForLiveConnection(page);
  const { transactionId } = await injectDispense(fx, 60);
  await expect(tank).toHaveAttribute('data-level-liters', '9940');

  // ── 2) Hareket listesi ──
  const txRow = page.locator(`[data-testid="site-tx-row"][data-plate="${fx.plate}"]`);
  await expect(txRow).toHaveCount(1);
  await expect(txRow).toHaveAttribute('data-liters', '60');
  await expect(txRow).toHaveAttribute('data-tx-id', transactionId);

  // Kalıcılık: sayfa yenilenince (sunucudan okunan) aynı değerler
  await page.reload();
  await expect(tank).toHaveAttribute('data-level-liters', '9940');
  await expect(txRow).toHaveCount(1);

  // ── 3) Rapor indirme: şantiyenin ikmal raporu (CSV) ──
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('site-report-download').click()]);
  expect(download.suggestedFilename()).toMatch(/^ikmal-raporu-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = readFileSync(await download.path() as string, 'utf8').replace(/^﻿/, '');
  const lines = csv.trim().split(/\r?\n/);
  expect(lines.length).toBe(2); // başlık + tek ikmal (taze firma)
  expect(lines[1]).toContain(fx.plate);
  expect(lines[1]).toContain('60.00');
  expect(lines[1]).toContain(fx.driver);
  await expect(page.getByTestId('site-report-error')).toHaveCount(0);
});
