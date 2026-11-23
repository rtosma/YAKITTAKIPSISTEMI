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

test('araç CRUD: ekle → listede görünür → aynı plaka backend mesajıyla reddedilir → pasife al', async ({ page }) => {
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

    // FLEET-1401: "Sil" artık gerçek bir silme DEĞİL — aracı 'PASİF'e alır,
    // kayıt (ve geçmişi) korunur. Buton/onay metni buna göre değişti
    // ("Pasife Al"); satır listeden KAYBOLMAZ, PASİF rozetiyle kalır.
    const deactivate = page.waitForResponse((r) => r.url().includes('/api/v1/vehicles/') && r.request().method() === 'DELETE');
    await page.locator('tr', { hasText: plate }).getByTitle('Pasife Al').click();
    await page.getByRole('button', { name: 'Pasife Al' }).click();
    expect((await deactivate).status()).toBe(200);
    await expect(page.locator('tr', { hasText: plate })).toHaveCount(1);
    await expect(page.locator('tr', { hasText: plate })).toContainText('PASİF');
    expect(psql(`SELECT status FROM vehicles WHERE plate = '${plate}'`)).toBe('PASİF');
  } finally {
    psql(`DELETE FROM vehicles WHERE plate = '${plate}' AND tenant_id = 'comp-camsa'`);
  }
});

// FE-805 Test Notu: "firma oluşturma → parola görüntüleme → modül kapatma →
// ilgili menünün kaybolması." Son adım UYARLANDI: araştırmada, sidebar
// menüsünün açık modüllere göre üretilmesi (FE-803'ün kendi AC'si) kod
// tabanında GERÇEKTEN uygulanmamış çıktı (yalnızca rol bazlı filtreleme var;
// bkz. CustomerLayout.tsx) — bu FE-805'in kapsamı dışında, ayrıca bir bulgu
// olarak bildirildi. Bu yüzden "menünün kaybolması" yerine modül durumunun
// GERÇEKTEN yansıdığı yer doğrulanıyor: TenantDetailModal'ın kendisi (anlık)
// + müşteri tarafının salt-okunur Modüllerim ekranı (PASİF rozeti).
test('geliştirici paneli: firma oluşturma → tek seferlik parola → modül kapatma onayı → modül durumu yansır (FE-805)', async ({ page }) => {
  const run = Date.now();
  const companyName = `E2E FE805 ${run}`;
  let tenantId: string | null = null;
  try {
    await loginCompanyUser(page, 'admin');
    await page.goto('/admin/tenants');

    // 1) Firma oluşturma
    await page.getByTestId('tenant-add-open').click();
    await page.getByTestId('tenant-name-input').fill(companyName);
    const createRes = page.waitForResponse((r) => r.url().endsWith('/api/v1/companies') && r.request().method() === 'POST');
    await page.getByTestId('tenant-save').click();
    expect((await createRes).status()).toBe(200);
    tenantId = psql(`SELECT id FROM companies WHERE name = '${companyName}'`);

    // 2) Parola görüntüleme — tek seferlik kimlik bilgileri paneli
    await expect(page.getByTestId('tenant-credentials-panel')).toBeVisible();
    const username = await page.getByTestId('tenant-owner-username').textContent();
    const tempPassword = await page.getByTestId('tenant-temp-password').textContent();
    expect(username?.trim().length).toBeGreaterThan(0);
    expect(tempPassword?.trim().length).toBeGreaterThanOrEqual(8);
    await page.getByTestId('tenant-credentials-done').click();
    await expect(page.getByTestId('tenant-credentials-panel')).not.toBeVisible();

    // 3) Detay panelini aç — driverScore, TEMEL paketin varsayılanında AÇIK
    // olan TEK modül (bkz. adminDb.ts PACKAGE_MODULE_DEFAULTS.TEMEL) —
    // "kapatma" akışını test edebilmek için bu gerekli.
    await page.locator(`tr[data-tenant-name="${companyName}"]`).getByTestId('tenant-detail-open').click();
    const moduleToggle = page.getByTestId('module-toggle-driverScore');
    await expect(moduleToggle).toHaveAttribute('data-enabled', 'true');

    // 4) Modül kapatma — onay diyaloğu ZORUNLU (AC/Teknik Not)
    await moduleToggle.click();
    await expect(page.getByText('MODÜL KAPATMA UYARISI')).toBeVisible();
    const toggleRes = page.waitForResponse((r) => r.url().includes('/api/v1/companies/') && r.request().method() === 'PATCH');
    await page.getByTestId('destructive-action-confirm').click();
    expect((await toggleRes).status()).toBe(200);

    // 5) Modül durumu ANINDA yansır — hem yönetici detay panelinde...
    await expect(moduleToggle).toHaveAttribute('data-enabled', 'false');

    // ...hem de müşteri tarafının Modüllerim ekranında (yeni firmanın
    // sahibi olarak giriş: geçici parola ile, zorunlu değişiklik akışı).
    await page.context().clearCookies();
    await page.evaluate(() => localStorage.clear());
    await page.goto('/');
    await page.fill('input[placeholder="Firma Adı"]', username!.trim());
    await page.fill('input[type="password"]', tempPassword!.trim());
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/parola-degistir/, { timeout: 15_000 });
    const newPassword = 'Fe805E2ePw1!';
    await page.getByTestId('pwchange-current').fill(tempPassword!.trim());
    await page.getByTestId('pwchange-new').fill(newPassword);
    await page.getByTestId('pwchange-confirm').fill(newPassword);
    const changeRes = page.waitForResponse((r) => r.url().includes('/api/v1/auth/change-password'));
    await page.getByTestId('pwchange-submit').click();
    expect((await changeRes).status()).toBe(200);
    await page.waitForURL(/\/panel/, { timeout: 15_000 });

    await page.goto('/panel/modules');
    await waitForApi(page, ['/companies/me']);
    // TEMEL paketinde driverScore DIŞINDAKİ modüller zaten varsayılan PASİF —
    // bu yüzden sayfada birden fazla "PASİF" rozeti olması beklenir; asıl
    // doğrulanan, driverScore'un KENDİ kartının artık PASİF olduğu (önceden
    // AÇIK'tı, TenantDetailModal'daki kapatma işlemiyle değişti).
    const driverScoreCard = page.locator('h3', { hasText: 'Şoför Performans Skoru' })
      .locator('xpath=ancestor::div[contains(@class, "rounded-2xl")][1]');
    await expect(driverScoreCard.getByText('PASİF (SÜPER ADMİN YETKİSİ GEREKLİ)')).toBeVisible();
  } finally {
    if (tenantId) psql(`DELETE FROM companies WHERE id = '${tenantId}'`);
  }
});
