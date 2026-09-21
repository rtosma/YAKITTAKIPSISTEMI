import { defineConfig, devices } from '@playwright/test';

/**
 * TEST-1004 — 3 panelin kritik akışları (CI + yerel). Eski `playwright.config.ts` (testDir ./e2e) docker-compose yığınına bağlı yerel paketi
 * çalıştırır; BU yapılandırma yalnızca e2e/critical/ altını koşar ve orkestratörün (node scripts/e2e/run-e2e.mjs --browser) kurduğu izole
 * yığına E2E_BASE_URL ile bağlanır.
 *
 * DETERMİNİZM: retries = 0 (yeniden deneme rastgele başarısızlığı MASKELER — kırmızı gerçek kırmızıdır); tek worker (testler aynı IP'den giriş yapar,
 * login rate limit'i paylaşır); zaman aşımları sabit ve cömert (koşula bağlı beklemeler zaten anında biter).
 * HATA KANITI (AC): başarısız testte ekran görüntüsü + VİDEO + trace `test-results/` altına yazılır; CI bunu artifact olarak yükler.
 */
export default defineConfig({
  testDir: './e2e/critical',
  testMatch: /.*\.spec\.ts/,
  outputDir: './test-results',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }], ['junit', { outputFile: 'test-results/junit.xml' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3000',
    headless: true,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
    testIdAttribute: 'data-testid'
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
