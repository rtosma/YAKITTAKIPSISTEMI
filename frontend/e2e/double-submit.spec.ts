import { test, type Page } from '@playwright/test';
import { expect, loginCompanyUser, loginSiteUser, waitForApi } from './helpers';

/**
 * TEST_PLAN.md §2.2 / §3.3 — Idempotency (istemci tarafı): çift gönderim.
 *
 * BULGU: OverviewPage'deki "Hızlı İkmal Kaydı" formunun "İkmalı Kaydet"
 * butonu istek sürerken kilitlenmiyordu ve handler'da tekrar koruması yoktu.
 * POST /dispense'in sunucu tarafında doğal bir tekrar anahtarı yok (aynı araca
 * art arda iki meşru ikmal olabilir), bu yüzden çift tıklama → İKİ ikmal kaydı
 * ve tanktan yakıtın İKİ KEZ düşülmesi demekti.
 *
 * Test tasarımı: /dispense isteği Playwright ile YAKALANIP gecikmeli sahte bir
 * yanıtla karşılanıyor. Böylece (1) istek "uçuştayken" ikinci tıklama penceresi
 * deterministik olur, (2) paylaşılan veritabanına HİÇBİR ikmal yazılmaz —
 * test yalnızca tarayıcının kaç yazma isteği GÖNDERDİĞİNİ sayar.
 */

/** /dispense POST'larını sayar ve gecikmeli sahte yanıt döner (DB'ye yazılmaz). */
async function interceptDispense(page: Page): Promise<() => number> {
  let dispensePosts = 0;
  await page.route('**/api/v1/dispense', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    dispensePosts++;
    // Gerçekçi bir ağ gecikmesi: ikinci gönderim bu pencereye düşer.
    await new Promise((r) => setTimeout(r, 1500));
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ success: true, data: {} }) });
  });
  return () => dispensePosts;
}

async function openRefuelModal(page: Page) {
  await loginCompanyUser(page, 'camsa');
  await page.getByRole('button', { name: /Hızlı İkmal Kaydı Gir/ }).click();
  await expect(page.getByRole('button', { name: /İkmalı Kaydet/ })).toBeVisible();
}

test('aynı görev içinde iki kez submit edilen form da TEK POST /dispense gönderir (disabled tek başına yetmez)', async ({ page }) => {
  const count = await interceptDispense(page);
  await openRefuelModal(page);

  // requestSubmit() butonun disabled durumunu KONTROL ETMEZ ve iki çağrı aynı
  // JS görevinde, React yeniden render etmeden ardışık gelir — yalnızca
  // handler'daki senkron (ref tabanlı) kilit bunu durdurabilir.
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button[type="submit"]')).find((b) =>
      b.textContent?.includes('İkmalı Kaydet')
    );
    const form = btn?.closest('form');
    if (!form) throw new Error('ikmal formu bulunamadı');
    form.requestSubmit();
    form.requestSubmit();
  });

  await page.waitForTimeout(2500);
  expect(count(), 'Aynı görevdeki ikinci submit de istek gönderdi').toBe(1);
});

test('Şantiye operatör paneli: aynı görevde iki submit TEK POST /dispense gönderir', async ({ page }) => {
  const count = await interceptDispense(page);
  // Panel verisi (tank/araç/sürücü) yüklenmeden gönderilen form handler'da
  // erken döner ve HİÇ istek atmaz — ilk sürümde test bu yüzden 0 ölçmüştü.
  const dataLoaded = waitForApi(page, ['/tanks', '/vehicles', '/drivers']);
  await loginSiteUser(page, 'gebze-santiye');
  await dataLoaded;

  const startBtn = page.getByRole('button', { name: /Pompayı Başlat/ });
  await expect(startBtn).toBeVisible({ timeout: 10_000 });

  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button[type="submit"]')).find((b) =>
      b.textContent?.includes('Pompayı Başlat')
    );
    const form = btn?.closest('form');
    if (!form) throw new Error('operatör ikmal formu bulunamadı');
    form.requestSubmit();
    form.requestSubmit();
  });

  await page.waitForTimeout(2500);
  // toBe(1): 0 da başarısızlıktır — form hiç gönderilmediyse test anlamsız geçmemeli.
  expect(count(), 'Operatör panelinde ikinci submit de istek gönderdi').toBe(1);
});

test('Hızlı ikmal formu çift tıklamada TEK bir POST /dispense gönderir', async ({ page }) => {
  const count = await interceptDispense(page);
  await openRefuelModal(page);
  const submit = page.getByRole('button', { name: /İkmalı Kaydet|Kaydediliyor/ });

  // Kullanıcı sabırsızca iki kez tıklıyor (çift tıklama / "oldu mu?" tıklaması).
  await submit.click();
  await submit.click({ force: true, timeout: 2000 }).catch(() => {
    // Buton gizlenmiş/ayrılmışsa ikinci tıklama zaten mümkün değildir — bu da doğru davranış.
  });

  // Uçuştaki isteğin tamamlanmasını bekle.
  await page.waitForTimeout(2500);

  expect(count(), 'Çift tıklama birden fazla ikmal isteği gönderdi — yakıt iki kez düşülürdü').toBe(1);
});
