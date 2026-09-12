import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

/**
 * TEST_PLAN.md §3.3 + §5.1 — E2E: CSP gerçek tarayıcıda + oturum zinciri.
 *
 * Bu dosyanın VAR OLMA SEBEBİ, birim testlerin yakalayamadığı iki şey:
 *
 *  1) CSP yalnızca GERÇEK bir tarayıcıda uygulanır. jsdom (Vitest) CSP'yi
 *     yok sayar; `curl -I` ise sadece başlığın döndüğünü gösterir —
 *     tarayıcının script/style/font'u gerçekten YÜKLEYEBİLDİĞİNİ değil.
 *     Fazla katı bir CSP uygulamayı sessizce kırar (beyaz ekran) ve bunu
 *     yalnızca bu tür bir test yakalar.
 *
 *  2) Route guard + oturum zinciri: localStorage temizliği, yönlendirme ve
 *     korumalı sayfaya token'sız erişimin engellenmesi.
 */

const SEED_COMPANY_USER = 'camsa';
const SEED_PASSWORD = '123456';

/** Sayfadaki konsol hatalarını ve CSP ihlallerini toplar. */
function collectPageProblems(page: Page) {
  const cspViolations: string[] = [];
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];

  page.on('console', (msg: ConsoleMessage) => {
    const text = msg.text();
    // Tarayıcı CSP ihlallerini konsola "Refused to ..." diye yazar.
    if (/content security policy|refused to (load|execute|apply|connect)/i.test(text)) {
      cspViolations.push(text);
    } else if (msg.type() === 'error') {
      consoleErrors.push(text);
    }
  });

  page.on('requestfailed', (req) => {
    failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText ?? 'bilinmeyen'}`);
  });

  return { cspViolations, consoleErrors, failedRequests };
}

test.describe('CSP — gerçek tarayıcı davranışı', () => {
  test('giriş sayfası CSP ihlali ÜRETMEDEN yükleniyor', async ({ page }) => {
    const { cspViolations, failedRequests } = collectPageProblems(page);

    await page.goto('/', { waitUntil: 'networkidle' });

    // Uygulama gerçekten render olmuş mu? (beyaz ekran testi)
    await expect(page.locator('#root')).not.toBeEmpty();
    await expect(page.locator('input[placeholder="Firma Adı"]')).toBeVisible();

    // Asıl mesele: CSP script/style/font'u engellemiş mi?
    expect(cspViolations, `CSP ihlalleri:\n${cspViolations.join('\n')}`).toHaveLength(0);

    // Google Fonts gibi harici kaynaklar ağ seviyesinde de engellenmemiş olmalı.
    const blockedByCsp = failedRequests.filter((r) => /blocked|csp/i.test(r));
    expect(blockedByCsp, `CSP ile engellenen istekler:\n${blockedByCsp.join('\n')}`).toHaveLength(0);
  });

  test('CSP başlığı tarayıcıya gerçekten ulaşıyor ve script-src gevşetilmemiş', async ({ page }) => {
    const response = await page.goto('/');
    const csp = response?.headers()['content-security-policy'] ?? '';

    expect(csp, 'CSP başlığı yok').toBeTruthy();
    const scriptSrc = /script-src([^;]*)/i.exec(csp)?.[1] ?? '';
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).not.toContain('unsafe-eval');
  });
});

test.describe('Oturum zinciri', () => {
  test('geçersiz kimlik bilgisiyle giriş reddediliyor ve token yazılmıyor', async ({ page }) => {
    await page.goto('/');

    await page.fill('input[placeholder="Firma Adı"]', SEED_COMPANY_USER);
    await page.fill('input[type="password"]', 'kesinlikle-yanlis-sifre');
    await page.click('button[type="submit"]');

    // Panele GEÇMEMELİ.
    await page.waitForTimeout(1500);
    expect(page.url()).not.toContain('/panel');

    const tokens = await page.evaluate(() => ({
      access: localStorage.getItem('YAKIT_ACCESS_TOKEN'),
      refresh: localStorage.getItem('YAKIT_REFRESH_TOKEN')
    }));
    expect(tokens.access).toBeNull();
    expect(tokens.refresh).toBeNull();
  });

  // NOT: çıkış (logout) davranışı burada DEĞİL, AppContext birim testinde
  // kapsanıyor (localStorage temizliği + UNAUTHORIZED olayında otomatik
  // çıkış). E2E'de tekrarlamak, yavaş ve kırılgan bir testi çoğaltmaktan
  // ibaret olurdu — bkz. playwright.config.ts'teki kapsam notu.
  test('doğru kimlik bilgisiyle giriş → panele yönlendirme → token saklanıyor', async ({ page }) => {
    const { cspViolations } = collectPageProblems(page);

    await page.goto('/');
    await page.fill('input[placeholder="Firma Adı"]', SEED_COMPANY_USER);
    await page.fill('input[type="password"]', SEED_PASSWORD);
    await page.click('button[type="submit"]');

    // Panele yönlendirilmeli.
    await page.waitForURL(/\/panel/, { timeout: 15_000 });

    const tokens = await page.evaluate(() => ({
      access: localStorage.getItem('YAKIT_ACCESS_TOKEN'),
      refresh: localStorage.getItem('YAKIT_REFRESH_TOKEN')
    }));
    expect(tokens.access, 'access token saklanmalı').toBeTruthy();
    expect(tokens.refresh, 'refresh token saklanmalı').toBeTruthy();

    // Panel gerçekten render oldu mu, CSP arkasında veri çekebiliyor mu?
    // (connect-src 'self' yanlış olsaydı API çağrıları burada patlardı.)
    await expect(page.locator('#root')).not.toBeEmpty();
    expect(cspViolations, `Panelde CSP ihlali:\n${cspViolations.join('\n')}`).toHaveLength(0);
  });

  test('token olmadan korumalı sayfaya erişilemiyor', async ({ page }) => {
    // Hiç giriş yapmadan doğrudan panel URL'ine git.
    await page.goto('/panel/overview');
    await page.waitForTimeout(1500);

    // Route guard giriş ekranına döndürmeli (panelde KALMAMALI).
    const stillOnPanel = page.url().includes('/panel');
    const loginVisible = await page.locator('input[placeholder="Firma Adı"]').isVisible().catch(() => false);
    expect(stillOnPanel && !loginVisible, 'Korumalı sayfa token olmadan açık kaldı').toBeFalsy();
  });
});
