import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { loginCompanyUser, resetLoginRateLimit, waitForApi } from './helpers';

/**
 * FLEET-1407 AC: "Bakım kayıtları araç kartında listelenmelidir." Backend
 * (GET/POST /vehicles/:id/maintenance-records, bakım öncesi/sonrası tüketim
 * karşılaştırması, hatırlatma sweep'i) ZATEN tamamdı — bu test, önceden HİÇ
 * VAROLMAYAN arayüzün gerçek bir tarayıcıda uçtan uca çalıştığını doğrular:
 * araç kartından "Bakım Geçmişi" aç → kayıt ekle → listede görün.
 */

function psql(sql: string): string {
  return execFileSync('docker', ['exec', 'yakittakip_postgres', 'psql', '-U', 'postgres', '-d', 'yakittakip_db', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();
}

test.beforeEach(() => resetLoginRateLimit());

test('FLEET-1407: araç kartından bakım kaydı eklenir ve geçmişte görünür', async ({ page }) => {
  const plate = `34 FMT ${1000 + Math.floor(Math.random() * 9000)}`;
  const description = `E2E bakım açıklaması ${Date.now()}`;

  try {
    await loginCompanyUser(page, 'camsa');
    await page.goto('/panel/vehicles');
    await waitForApi(page, ['/vehicles']);

    // Test aracı oluştur (tenant-and-crud.spec.ts ile AYNI form akışı).
    await page.getByRole('button', { name: /Yeni Araç Ekle/ }).click();
    await page.getByPlaceholder(/örn\. 34 CTP 99/).fill(plate);
    await page.getByPlaceholder('örn. Volvo FMX 460 Damperli').fill('E2E Bakım Test Aracı');
    const created = page.waitForResponse((r) => r.url().endsWith('/api/v1/vehicles') && r.request().method() === 'POST');
    await page.getByRole('button', { name: /Aracı Kaydet/ }).click();
    expect((await created).status()).toBe(200);

    const row = page.locator('tr', { hasText: plate });
    await expect(row).toHaveCount(1);

    await row.getByTitle('Bakım Geçmişi').click();
    await expect(page.getByText('Bu araç için kayıtlı bakım geçmişi yok.')).toBeVisible();

    await page.getByRole('button', { name: /Yeni Bakım Kaydı Ekle/ }).click();
    await page.locator('textarea').fill(description);
    await page.locator('input[type="number"]').first().fill('1500');

    const post = page.waitForResponse((r) => r.url().includes('/maintenance-records') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Kaydet' }).click();
    expect((await post).status()).toBe(201);

    await expect(page.getByText(description)).toBeVisible();
    await expect(page.getByText('1.500')).toBeVisible();
  } finally {
    psql(`DELETE FROM vehicle_maintenance_records WHERE operations_description = '${description}'`);
    psql(`DELETE FROM vehicles WHERE plate = '${plate}' AND tenant_id = 'comp-camsa'`);
  }
});
