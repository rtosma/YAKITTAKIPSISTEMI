import { execSync } from 'node:child_process';
import { expect, type Page } from '@playwright/test';

/**
 * TEST_PLAN §0.3 — E2E paketi de aynı IP'den çok sayıda giriş yapar ve login
 * rate limiter'ına (10 deneme / 15 dk) takılıp YANLIŞ başarısızlık üretir
 * (canlı gözlemlendi: art arda koşularda tüm giriş gerektiren testler 16 sn
 * timeout'la düştü, backend 429 dönüyordu). Backend testlerindeki
 * helpers/loginRateLimit.ts ile aynı amaç; burada Redis host'a yayınlanmadığı
 * için docker exec kullanılıyor. Başarısız olursa testi durdurmaz.
 */
export function resetLoginRateLimit(): void {
  try {
    execSync(
      "docker exec yakittakip_redis sh -c \"redis-cli --scan --pattern 'rl:auth-login:*' | xargs -r redis-cli DEL\"",
      { stdio: 'ignore' }
    );
  } catch {
    // docker/redis erişilemiyorsa test yine de denesin.
  }
}

export async function loginCompanyUser(page: Page, username: string, password = '123456'): Promise<void> {
  resetLoginRateLimit();
  await page.goto('/');
  await page.fill('input[placeholder="Firma Adı"]', username);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/(panel|admin)/, { timeout: 15_000 });
}

export async function loginSiteUser(page: Page, username: string, password = '123456'): Promise<void> {
  resetLoginRateLimit();
  await page.goto('/santiye-login');
  await page.fill('input[placeholder="Şantiye Adı"]', username);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/santiye-panel/, { timeout: 15_000 });
}

/** Sayfa verisi yüklenene kadar bekler: belirtilen API uçlarının 2xx yanıtları. */
export async function waitForApi(page: Page, paths: string[]): Promise<void> {
  await Promise.all(
    paths.map((p) =>
      page.waitForResponse((r) => r.url().includes(`/api/v1${p}`) && r.status() < 400, { timeout: 15_000 })
    )
  );
}

export { expect };
