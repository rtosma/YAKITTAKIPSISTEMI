import { defineConfig, devices } from '@playwright/test';

/**
 * TEST_PLAN.md §3.3 — E2E testleri.
 *
 * KAPSAM BİLİNÇLİ OLARAK DAR: 24 sayfanın hepsi için E2E YAZILMIYOR.
 * E2E testleri yavaş ve kırılgandır; bakım maliyeti Vitest birim
 * testlerinin kat kat üstündedir. Burada yalnızca "birim testle
 * YAKALANAMAYAN" şeyler test edilir:
 *   - CSP'nin GERÇEK tarayıcıda uygulamayı kırıp kırmadığı (jsdom CSP
 *     uygulamaz; curl yalnızca başlığın döndüğünü gösterir, tarayıcının
 *     script/style/font'u gerçekten yükleyebildiğini göstermez).
 *   - Giriş → panel → çıkış zincirinin uçtan uca gerçekten çalışması.
 *   - Route guard'ların token'sız erişimi engellemesi.
 *
 * ÇALIŞTIRMA: docker-compose ayakta olmalı (nginx :3000). CI'da bu yığın
 * olmadığı için E2E CI'a BAĞLANMADI — test_res905/test_iot301 ile aynı
 * gerekçe (bkz. TEST_PLAN §0.3). Yerel komut: `npm run test:e2e`.
 */
export default defineConfig({
  testDir: './e2e',
  // Aynı kullanıcı hesaplarıyla giriş yapan testler paralel koşarsa
  // hesap kilitleme (AUTH-209) ve login rate limit birbirini tetikler.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3000',
    headless: true,
    // Hata ayıklamayı kolaylaştırır, başarısızlıkta iz bırakır.
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
