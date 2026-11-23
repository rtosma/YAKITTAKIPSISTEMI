import { expect, test } from '@playwright/test';
import { loginCompanyUser, resetLoginRateLimit, waitForApi } from './helpers';

/**
 * FE-802 AC: "Filtreler URL ile senkron olmalıdır." Önceden TransactionsPage
 * filtreleri yalnızca `useState` ile tutuyordu — sayfa yenilenince/bağlantı
 * paylaşılınca filtreler KAYBOLUYORDU. Bu test tam olarak bu AC'yi, gerçek
 * bir tarayıcıda (Playwright), arama filtresi üzerinden doğrular: filtre
 * girilince URL güncellenir mi, ve o URL'e DOĞRUDAN gidilince (sayfa
 * yenileme/bağlantı paylaşımı simülasyonu) filtre GERİ YÜKLENİR mi.
 */

test.beforeEach(() => resetLoginRateLimit());

test('FE-802: arama filtresi URL ile senkron olur ve sayfa yenilenince geri yüklenir', async ({ page }) => {
  await loginCompanyUser(page, 'camsa');
  await page.goto('/panel/transactions');
  await waitForApi(page, ['/transactions']);

  const searchInput = page.getByPlaceholder('Plaka veya ara...');
  const probe = `E2EURLSYNC${Date.now()}`;
  await searchInput.fill(probe);

  // 300ms debounce + URL yazıcı effect — sunucu isteğinin kendisini bekle
  // (arama terimi query string'e gerçekten gittiğinde URL de zaten güncel demektir).
  await page.waitForResponse((r) => r.url().includes('/api/v1/transactions') && r.url().includes(encodeURIComponent(probe)), { timeout: 5000 });

  const urlAfterFilter = new URL(page.url());
  expect(urlAfterFilter.searchParams.get('q')).toBe(probe);

  // Sayfa yenileme / bağlantı paylaşımı simülasyonu: AYNI URL'e DOĞRUDAN git.
  await page.goto(urlAfterFilter.toString());
  await waitForApi(page, ['/transactions']);

  await expect(searchInput).toHaveValue(probe);
  const urlAfterReload = new URL(page.url());
  expect(urlAfterReload.searchParams.get('q')).toBe(probe);
});

test('FE-802: filtreler temizlenince URL de temizlenir', async ({ page }) => {
  await loginCompanyUser(page, 'camsa');
  await page.goto('/panel/transactions');
  await waitForApi(page, ['/transactions']);

  const searchInput = page.getByPlaceholder('Plaka veya ara...');
  await searchInput.fill('gecici-arama-terimi');
  await page.waitForResponse((r) => r.url().includes('/api/v1/transactions') && r.url().includes('gecici-arama-terimi'), { timeout: 5000 });
  expect(new URL(page.url()).searchParams.get('q')).toBe('gecici-arama-terimi');

  await page.getByRole('button', { name: /Filtreleri Temizle/ }).click();

  // React Query zaten boş-filtre kombinasyonunu (sayfa ilk açıldığındaki
  // istekten) staleTime içinde ÖNBELLEKLEMİŞTİR — "Temizle" bu durumda YENİ
  // bir ağ isteği tetiklemeyebilir (istemci tarafı state ANINDA temizlenir).
  // Bu yüzden burada bir API yanıtı DEĞİL, URL'in kendisinin ('q' parametresi
  // düşene kadar) güncellendiği bekleniyor.
  await expect(searchInput).toHaveValue('');
  await expect.poll(() => new URL(page.url()).searchParams.has('q')).toBe(false);
});
