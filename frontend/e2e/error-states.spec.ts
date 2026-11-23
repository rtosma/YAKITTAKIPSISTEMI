import { expect, test } from '@playwright/test';
import { loginCompanyUser, resetLoginRateLimit, waitForApi } from './helpers';

/**
 * FE-817 (#148) — Boş, hata ve yükleniyor durumları, error boundary ve skeleton.
 *
 * Bu, tek bir backend özelliğine dayanmayan, çapraz-kesen bir UX bileti —
 * test notu da bunu yansıtıyor: "API hatası enjekte edilerek hata ekranı;
 * boş veri setiyle boş durum ekranı." Her iki senaryo da GERÇEK backend'e
 * karşı çalışır; hata senaryosu `page.route()` ile belirli bir uca kasıtlı
 * bir hata enjekte eder (API'nin KENDİSİNİ bozmaz, sadece bu testin isteğini
 * yakalar).
 */

test.beforeEach(() => resetLoginRateLimit());

test('beklenmeyen render hatası tüm uygulamayı çökertmez; hata ekranı trace_id gösterir ve "Tekrar Dene" gerçekten kurtarır (FE-817)', async ({ page }) => {
  await loginCompanyUser(page, 'camsa');
  // Rapor Merkezi'ne gidip GERÇEK bir API isteği ile `getLastApiTraceId()`'yi
  // doldur — aksi halde hata ekranındaki destek kodu her zaman boş olurdu
  // (bu testin asıl amacı: trace_id'nin GERÇEKTEN göründüğünü kanıtlamak).
  await page.goto('/panel/reports');
  await waitForApi(page, ['/dashboard/executive']);

  await page.goto('/panel?__e2e_throw=1');
  await expect(page.getByTestId('error-boundary-screen')).toBeVisible();
  const traceText = await page.getByTestId('error-boundary-trace-id').textContent();
  expect(traceText?.trim()).not.toBe('yok');
  expect(traceText?.trim().length).toBeGreaterThan(5);

  // ASIL AC — "Tekrar deneme düğmeleri." `resetError` sadece AYNI ağacı
  // yeniden render eder — tetikleyici koşul (URL'deki parametre) hâlâ
  // oradaysa tekrar çöker, bu GERÇEK bir sınırlamadır (geçici olmayan bir
  // hatayı "Tekrar Dene" zaten düzeltemez). Burada test, gerçek bir
  // kurtarma senaryosunu simüle etmek için tetikleyici koşulu KENDİSİ
  // temizliyor (DevErrorTrigger URL'in KENDİSİNİ okur, App.tsx'teki not).
  await page.evaluate(() => window.history.replaceState(null, '', '/panel'));
  await page.getByTestId('error-boundary-retry').click();
  await expect(page.getByTestId('error-boundary-screen')).not.toBeVisible();
  await expect(page.getByText('Rapor Merkezi')).toBeVisible();
});

test('kritik ilk veri yüklemesi başarısız olursa panelde skeleton → hata ekranı gösterilir, eski/sahte firma verisi SESSİZCE gösterilmez, "Tekrar Dene" gerçek veriyle kurtarır (FE-817)', async ({ page }) => {
  let shouldFail = true;
  await page.route('**/api/v1/companies/me', async (route) => {
    if (!shouldFail) { await route.continue(); return; }
    // Skeleton'ın görünür kalacak kadar süre tanınması için küçük bir gecikme.
    await new Promise((r) => setTimeout(r, 600));
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, message: 'Kasıtlı test hatası (FE-817)' }) });
  });

  await loginCompanyUser(page, 'camsa');

  // ASIL AC — "Her liste ekranında skeleton ... tanımlı olmalıdır" — bu,
  // panel genelinin skeleton'ı (CustomerLayout, isLoadingInitialData).
  await expect(page.getByTestId('panel-initial-load-skeleton')).toBeVisible();

  // ASIL AC — "Beklenmeyen hatada uygulama çökmemeli, hata ekranı gösterilmelidir."
  // ÖNCEDEN (bulunan gerçek hata): bu başarısız olunca `companies` state'i
  // sessizce INITIAL_COMPANIES mock'unda kalıyor, kullanıcı SAHTE firma
  // verisi görüyordu — hiçbir hata göstergesi YOKTU.
  await expect(page.getByTestId('panel-initial-load-error')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('panel-initial-load-skeleton')).not.toBeVisible();

  shouldFail = false;
  const retryRes = page.waitForResponse((r) => r.url().includes('/api/v1/companies/me') && r.status() === 200);
  await page.getByTestId('panel-initial-load-error-retry').click();
  await retryRes;
  await expect(page.getByTestId('panel-initial-load-error')).not.toBeVisible();
  await expect(page.getByText('ÇamSA')).toBeVisible();
});

test('boş araç listesi genel bir "bulunamadı" değil, eylem öneren bir boş durum gösterir; eylem ekleme formunu açar (FE-817)', async ({ page }) => {
  await page.route('**/api/v1/vehicles', async (route) => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [] }) });
  });

  await loginCompanyUser(page, 'camsa');
  await page.goto('/panel/vehicles');
  await waitForApi(page, ['/vehicles']);

  const empty = page.getByTestId('vehicles-empty');
  await expect(empty).toBeVisible();
  await expect(empty).toContainText('Henüz araç eklenmedi');
  await expect(page.getByTestId('vehicles-empty-action')).toHaveText('İlk Aracınızı Ekleyin');

  await page.getByTestId('vehicles-empty-action').click();
  await expect(page.getByText('Yeni Araç Tanımla')).toBeVisible();
});
