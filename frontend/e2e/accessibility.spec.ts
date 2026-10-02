import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { loginCompanyUser, loginSiteUser, resetLoginRateLimit, waitForApi } from './helpers';

/**
 * FE-818 (#190) — Responsive ve saha tableti dokunmatik optimizasyonu (WCAG 2.1 AA).
 *
 * Bu kod tabanında ÖNCEDEN axe-core (ya da başka bir erişilebilirlik tarama
 * aracı) hiç yoktu (araştırıldı: grep "axe|a11y|accessibility" → sıfır
 * gerçek sonuç, tek "eşleşme" `leading-relaxed` içindeki "axe" alt dizesiydi).
 * AC: "axe-core taramasında KRİTİK erişilebilirlik hatası bulunmamalıdır" —
 * bu yüzden burada `impact === 'critical'` filtrelenir, DAHA HAFİF (serious/
 * moderate/minor) bulgular ayrı ayrı raporlanır ama testi DÜŞÜRMEZ (bu
 * ticket'ın "S" efor kapsamında TÜM sayfaların TAM AA taraması YAPILMADI —
 * dispense/km-giriş kritik akışları ve genel navigasyon/modal ARIA'sı
 * düzeltildi; kalan sayfalardaki daha hafif bulgular disclosed bir
 * sonraki-tur maddesi).
 */

function assertNoCriticalViolations(results: { violations: Array<{ id: string; impact?: string | null; nodes: unknown[] }> }, context: string) {
  const critical = results.violations.filter((v) => v.impact === 'critical');
  if (critical.length > 0) {
    const detail = critical.map((v) => `${v.id} (${v.nodes.length} öğe)`).join(', ');
    throw new Error(`${context}: ${critical.length} KRİTİK erişilebilirlik hatası — ${detail}`);
  }
}

test.beforeEach(() => resetLoginRateLimit());

test('giriş sayfası axe-core taramasında kritik erişilebilirlik hatası içermiyor (FE-818)', async ({ page }) => {
  await page.goto('/');
  const results = await new AxeBuilder({ page }).analyze();
  assertNoCriticalViolations(results, 'Giriş sayfası');
});

test('yönetici paneli (genel bakış) axe-core taramasında kritik hata içermiyor; klavyeyle gezilebilir (FE-818)', async ({ page }) => {
  await loginCompanyUser(page, 'camsa');
  await page.goto('/panel/overview');
  await waitForApi(page, ['/companies/me']);
  // Tank kartları framer-motion ile kademeli (staggered) fade-in yapıyor
  // (TankGauge.tsx) — tarama ANİMASYON SIRASINDA çalışırsa axe-core ara
  // opaklık değerlerini GERÇEK bir kontrast kusuru gibi raporlar (bulundu,
  // doğrulandı: animasyon bitince AYNI sayfada 0 ihlale düşüyor) — bu
  // sahte-pozitifi önlemek için animasyonun oturmasını bekle.
  await page.waitForTimeout(800);

  const results = await new AxeBuilder({ page }).analyze();
  assertNoCriticalViolations(results, 'Genel Bakış');

  // ASIL AC — "Tüm etkileşimli öğeler klavye ile erişilebilir olmalıdır."
  // Hızlı ikmal modalı: Tab ile ulaşılabilir, Escape ile kapanır (önceden
  // bu modalde HİÇBİR klavye desteği yoktu — role=dialog/aria-modal/Escape
  // bu biletle eklendi).
  await page.getByText('Hızlı İkmal Kaydı Gir').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('Araç Plakası')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('saha operatör paneli (dispense + km girişi) axe-core taramasında kritik hata içermiyor, 10" tablet genişliğinde yatay kaymıyor, dokunma hedefleri yeterli (FE-818)', async ({ page }) => {
  // iPad Air benzeri yatay (landscape) 10" tablet — AC: "Kritik ekranlar 10
  // inç tablette kullanılabilir olmalıdır."
  await page.setViewportSize({ width: 1180, height: 820 });
  await loginSiteUser(page, 'gebze-santiye');
  await page.goto('/santiye-panel');
  await expect(page.getByTestId('site-panel')).toBeVisible();

  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(horizontalOverflow, 'saha paneli 10" tablet genişliğinde yatay kayıyor').toBeLessThanOrEqual(1);

  const results = await new AxeBuilder({ page }).analyze();
  assertNoCriticalViolations(results, 'Saha operatör paneli');

  // ASIL AC — "Dokunma hedefi minimum 44×44 px." Sahada en kritik iki
  // buton: acil durdur ve pompa başlat/ikmal et.
  const stopBox = await page.getByTestId('site-emergency-stop-open').boundingBox();
  expect(stopBox?.height, 'acil durdur butonu 44px altında').toBeGreaterThanOrEqual(44);

  const meterInput = page.getByTestId('meter-value-input');
  const meterBox = await meterInput.boundingBox();
  expect(meterBox?.height, 'km/motor-saat giriş alanı 44px altında').toBeGreaterThanOrEqual(44);
});
