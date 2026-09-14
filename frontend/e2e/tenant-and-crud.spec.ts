import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { loginCompanyUser, resetLoginRateLimit, waitForApi } from './helpers';

/**
 * TEST_PLAN.md §3.3 (E2E 3. tur) — backend'de test edilmiş kuralların
 * KULLANICIYA ulaşıp ulaşmadığı: dondurulmuş tenant mesajı ve bir CRUD akışında
 * backend doğrulama mesajının arayüzde görünmesi.
 *
 * Kurulum/temizlik doğrudan psql ile (docker exec) — UI'da bu durumları
 * üretecek bir yol yok ve testin konusu kurulum değil, arayüzün tepkisi.
 */

function psql(sql: string): string {
  return execFileSync('docker', ['exec', 'yakittakip_postgres', 'psql', '-U', 'postgres', '-d', 'yakittakip_db', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();
}

test.beforeEach(() => resetLoginRateLimit());

test('dondurulmuş tenant kullanıcısı girişte engellenir ve nedenini görür (ARCH-108 UI yansıması)', async ({ page }) => {
  const run = Date.now();
  const tenantId = `comp-e2e-frozen-${run}`;
  const username = `e2e-frozen-${run}`;
  try {
    psql(`INSERT INTO companies (id, name, tax_number, code, account_status) VALUES ('${tenantId}', 'E2E Dondurulmuş ${run}', '0000000000', 'E2EF-${run}', 'DONDURULDU')`);
    psql(`INSERT INTO users (id, tenant_id, username, password_hash, role)
          SELECT 'usr-${username}', '${tenantId}', '${username}', password_hash, 'COMPANY_OWNER' FROM users WHERE username = 'camsa'`);

    await page.goto('/');
    await page.fill('input[placeholder="Firma Adı"]', username);
    await page.fill('input[type="password"]', '123456');
    const response = page.waitForResponse((r) => r.url().includes('/api/v1/auth/login'));
    await page.click('button[type="submit"]');
    expect((await response).status()).toBe(403);

    await expect(page.getByText(/hesabı dondurulmuştur/i)).toBeVisible();
    await expect(page).not.toHaveURL(/\/panel/);
    const token = await page.evaluate(() => localStorage.getItem('YAKIT_ACCESS_TOKEN'));
    expect(token).toBeNull();
  } finally {
    psql(`DELETE FROM companies WHERE id = '${tenantId}'`);
  }
});

test('araç CRUD: ekle → listede görünür → aynı plaka backend mesajıyla reddedilir → sil', async ({ page }) => {
  const plate = `34 ETE ${1000 + Math.floor(Math.random() * 9000)}`;
  try {
    await loginCompanyUser(page, 'camsa');
    await page.goto('/panel/vehicles');
    await waitForApi(page, ['/vehicles']);

    const addVehicle = async () => {
      await page.getByRole('button', { name: /Yeni Araç Ekle/ }).click();
      await page.getByPlaceholder('örn. 34 CTP 99').fill(plate);
      await page.getByPlaceholder('örn. Volvo FMX 460 Damperli').fill('E2E Test Kamyonu');
      const post = page.waitForResponse((r) => r.url().endsWith('/api/v1/vehicles') && r.request().method() === 'POST');
      await page.getByRole('button', { name: /Aracı Kaydet/ }).click();
      return (await post).status();
    };

    expect(await addVehicle()).toBe(200);
    await expect(page.locator('tr', { hasText: plate })).toHaveCount(1);

    // Aynı plaka: backend 409 DUPLICATE_PLATE; kullanıcı SEBEBİ görmeli
    // (genel bir "hata" değil) ve listede ikinci bir satır OLUŞMAMALI.
    expect(await addVehicle()).toBe(409);
    await expect(page.getByText(/Araç eklenirken hata: .*zaten kayıtlı/)).toBeVisible();
    await expect(page.locator('tr', { hasText: plate })).toHaveCount(1);

    const del = page.waitForResponse((r) => r.url().includes('/api/v1/vehicles/') && r.request().method() === 'DELETE');
    await page.locator('tr', { hasText: plate }).getByTitle('Sil').click();
    await page.getByRole('button', { name: 'Sil ve Kaldır' }).click();
    expect((await del).status()).toBe(200);
    await expect(page.locator('tr', { hasText: plate })).toHaveCount(0);
    expect(psql(`SELECT count(*) FROM vehicles WHERE plate = '${plate}'`)).toBe('0');
  } finally {
    psql(`DELETE FROM vehicles WHERE plate = '${plate}' AND tenant_id = 'comp-camsa'`);
  }
});
