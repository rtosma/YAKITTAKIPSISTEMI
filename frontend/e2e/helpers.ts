import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';

// playwright.config.ts frontend/'de yaşıyor (testDir './e2e'), bu yüzden
// Playwright süreci frontend/ cwd'siyle çalışır — docker compose/`.env`
// repo KÖKÜNDE, bu yüzden burada açıkça çözülüyor. (ESM: __dirname yok.)
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

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

/**
 * FE-804 — bu ortamda docker-compose.yml backend'e NODE_ENV=production
 * verdiğinden (bkz. proje belleği) forgot-password yanıtı `devResetToken`
 * DÖNDÜRMEZ (sızıntı koruması route seviyesinde). E2E'nin gerçek reset
 * adımını (sahte değil) çalıştırabilmesi için, backend'in KENDİ
 * `test_auth206_password_reset.ts` testiyle AYNI desen kullanılır:
 * `requestPasswordReset` servis fonksiyonu HTTP route'unu (ve onun
 * devResetToken bastırmasını) atlayarak doğrudan çağrılır — mevcut
 * `yakittakipsistemi-backend:test-runner` imajı (backend testleri için
 * zaten inşa edilmiş) içinde, TEK bir geçici script dosyası tek-dosya
 * bind-mount ile /app/test/'e bağlanır. backend/ dizininde HİÇBİR kalıcı
 * dosya bırakılmaz (görev kapsamı yalnızca frontend) — script bir temp
 * dizinde oluşturulup finally'de silinir.
 */
export function getPasswordResetToken(username: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'fe804-pwreset-'));
  const scriptPath = join(dir, 'get-token.ts');
  writeFileSync(
    scriptPath,
    [
      "import { requestPasswordReset } from '../src/services/passwordResetService';",
      '(async () => {',
      '  const token = await requestPasswordReset(process.argv[2]);',
      '  if (!token) { console.error("NULL_TOKEN"); process.exit(1); }',
      '  console.log(`TOKEN=${token}`);',
      '  process.exit(0);',
      '})();',
      ''
    ].join('\n')
  );

  try {
    const backendContainerId = execSync('docker compose ps -q backend', { encoding: 'utf-8', cwd: REPO_ROOT }).trim();
    const output = execFileSync(
      'docker',
      [
        'run', '--rm',
        '--network', `container:${backendContainerId}`,
        '--env-file', join(REPO_ROOT, '.env'),
        '-e', 'POSTGRES_HOST=postgres',
        '-e', 'REDIS_HOST=redis',
        '-v', `${scriptPath}:/app/test/get-token.ts:ro`,
        'yakittakipsistemi-backend:test-runner',
        'npx', 'tsx', 'test/get-token.ts', username
      ],
      { encoding: 'utf-8', cwd: REPO_ROOT }
    );
    const match = output.match(/TOKEN=([0-9a-f]{64})/);
    if (!match) throw new Error(`Reset token alınamadı, çıktı: ${output}`);
    return match[1];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * FE-804 — forgot-password kendi ayrı rate limitine sahip (1/dk + 5/saat,
 * KULLANICI ADINA göre anahtarlanır — `usernameKey`, IP'ye göre DEĞİL; bkz.
 * rateLimitMiddleware.ts). resetLoginRateLimit() bunu SIFIRLAMAZ (ayrı
 * Redis anahtar öneki). Testler aynı SEED_USER'ı art arda çağırdığından
 * (ve manuel doğrulama sırasında da aynı kullanıcı denenmiş olabilir) bu
 * limit gerçek bir 429'a yol açıp testi YANLIŞ kırmızı yapabilir.
 */
export function resetPasswordResetRateLimit(): void {
  try {
    execSync(
      "docker exec yakittakip_redis sh -c \"redis-cli --scan --pattern 'rl:pwreset-*:*' | xargs -r redis-cli DEL\"",
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
