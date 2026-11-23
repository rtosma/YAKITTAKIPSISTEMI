import { test, type Page } from '@playwright/test';
import { expect, loginCompanyUser, loginSiteUser } from './helpers';

/**
 * TEST_PLAN §3.3 — Frontend ↔ backend sözleşme taraması.
 *
 * NEDEN: backend testleri uçları doğru girdilerle çağırıyor, frontend birim
 * testleri ise fetch'i mock'luyor — ikisi de frontend'in backend'i GERÇEKTE
 * nasıl çağırdığını doğrulamıyor. Bu boşluk gerçek bir hataya yol açmıştı:
 * AppContext `GET /transactions?pageSize=200` istiyor, backend sözleşmesi
 * pageSize ≤ 100 → her istek 400. FE-802'nin eklendiği günden beri genel ikmal
 * listesi hiç yüklenmiyor, her ikmalden sonra hata toast'ı çıkıyordu; ne
 * backend ne frontend testleri bunu görebildi.
 *
 * Test: her rolün her panel sayfası gerçek tarayıcıda açılır ve sayfa
 * yüklenirken yapılan API çağrılarından HİÇBİRİNİN 4xx/5xx dönmediği doğrulanır.
 * Bu, tek bir hatayı değil, frontend ile backend arasındaki TÜM sözleşme
 * kaymalarını (yanlış parametre, kaldırılmış alan, yetkisiz uç) yakalar.
 */

async function collectFailedApiCalls(page: Page, routes: string[]): Promise<string[]> {
  const failures: string[] = [];
  const onResponse = (r: import('@playwright/test').Response) => {
    const url = r.url();
    if (url.includes('/api/v1/') && r.status() >= 400) {
      failures.push(`${r.request().method()} ${url.replace(/^.*\/api\/v1/, '')} → ${r.status()} (sayfa: ${page.url().replace(/^.*?\/\/[^/]+/, '')})`);
    }
  };
  page.on('response', onResponse);
  for (const route of routes) {
    await page.goto(route, { waitUntil: 'networkidle' });
    // SPA'da bazı veri çağrıları ilk networkidle'dan hemen sonra tetiklenebilir.
    await page.waitForTimeout(500);
  }
  page.off('response', onResponse);
  return failures;
}

test('firma sahibi (COMPANY_OWNER): tüm panel sayfaları başarısız API çağrısı YAPMADAN yüklenir', async ({ page }) => {
  test.setTimeout(120_000);
  await loginCompanyUser(page, 'camsa');
  const failures = await collectFailedApiCalls(page, [
    '/panel/overview',
    '/panel/sites',
    '/panel/vehicles',
    '/panel/drivers',
    '/panel/vehicles-drivers',
    '/panel/transactions',
    '/panel/tanks',
    '/panel/archive',
    '/panel/notifications',
    '/panel/settings',
    '/panel/cross-site',
    '/panel/modules'
  ]);
  expect(failures, `Başarısız API çağrıları:\n${failures.join('\n')}`).toEqual([]);
});

test('süper admin (SUPER_ADMIN): admin paneli sayfaları başarısız API çağrısı YAPMADAN yüklenir', async ({ page }) => {
  test.setTimeout(120_000);
  await loginCompanyUser(page, 'admin');
  const failures = await collectFailedApiCalls(page, [
    '/admin/overview',
    '/admin/tenants',
    '/admin/devices',
    '/admin/logs',
    '/admin/health'
  ]);
  expect(failures, `Başarısız API çağrıları:\n${failures.join('\n')}`).toEqual([]);
});

test('şantiye yöneticisi: operatör paneli başarısız API çağrısı YAPMADAN yüklenir', async ({ page }) => {
  test.setTimeout(60_000);
  await loginSiteUser(page, 'gebze-santiye');
  const failures = await collectFailedApiCalls(page, ['/santiye-panel']);
  expect(failures, `Başarısız API çağrıları:\n${failures.join('\n')}`).toEqual([]);
});
