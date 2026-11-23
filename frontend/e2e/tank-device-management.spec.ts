import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { loginCompanyUser, resetLoginRateLimit, waitForApi } from './helpers';

/**
 * FE-809 Test Notu: "tank oluşturma, cetvel yükleme (hatalı ve geçerli),
 * cihaz eşleştirme akışı."
 *
 * KAPSAM UYARLAMASI (disclosed): Cihaz eşleştirmenin TAMAMLANMASI (sahadaki
 * cihazın/teknisyenin claim kodunu TÜKETMESİ, POST /devices/claim) burada
 * TEST EDİLMİYOR — bu, backend'in zaten test ettiği (test_iot304_device_claim_flow.ts)
 * kimliksiz bir cihaz uç noktasıdır, tarayıcı akışının parçası değil. Burada
 * test edilen, admin'in YENİ AKIŞI: kod+QR üretimi ve görüntülenmesi.
 */

function psql(sql: string): string {
  return execFileSync('docker', ['exec', 'yakittakip_postgres', 'psql', '-U', 'postgres', '-d', 'yakittakip_db', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();
}

test.beforeEach(() => resetLoginRateLimit());

test('tank oluşturma + daldırma cetveli yükleme: hatalı CSV satır bazlı hata raporu, geçerli CSV başarıyla kaydedilir (FE-809)', async ({ page }) => {
  const run = Date.now();
  const tankName = `E2E FE809 Tank ${run}`;
  try {
    await loginCompanyUser(page, 'camsa');
    await page.goto('/panel/tanks');
    await waitForApi(page, ['/tanks']);

    // 1) Tank oluşturma
    await page.getByRole('button', { name: /Yeni Tank Ekle/ }).click();
    await page.getByPlaceholder('örn. B Şantiyesi Tankı').fill(tankName);
    const createRes = page.waitForResponse((r) => r.url().endsWith('/api/v1/tanks') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Kaydet' }).click();
    expect((await createRes).status()).toBe(200);

    const tankCard = page.locator(`[data-testid="tank-card"][data-tank-name="${tankName}"]`);
    await expect(tankCard).toBeVisible();

    // 2) Cetvel yükle — HATALI CSV (mm azalan — monotonluk ihlali)
    await tankCard.getByTestId('tank-strapping-upload-open').click();
    await expect(page.getByTestId('strapping-upload-modal')).toBeVisible();
    await page.getByTestId('strapping-csv-textarea').fill('mm,litre\n0,0\n500,1250\n300,1900\n');
    const invalidRes = page.waitForResponse((r) => r.url().includes('/strapping-table') && r.request().method() === 'POST');
    await page.getByTestId('strapping-upload-submit').click();
    expect((await invalidRes).status()).toBe(400);
    await expect(page.getByTestId('strapping-error-report')).toBeVisible();
    await expect(page.getByTestId('strapping-error-report')).toContainText('Satır');

    // 3) Aynı modalda GEÇERLİ CSV ile düzelt → başarı
    await page.getByTestId('strapping-csv-textarea').fill('mm,litre\n0,0\n500,1250\n1000,2600\n1500,4000\n');
    const validRes = page.waitForResponse((r) => r.url().includes('/strapping-table') && r.request().method() === 'POST');
    await page.getByTestId('strapping-upload-submit').click();
    expect((await validRes).status()).toBe(201);
    await expect(page.getByText('Cetvel başarıyla kaydedildi.')).toBeVisible();
  } finally {
    psql(`DELETE FROM tank_strapping_tables WHERE tenant_id = 'comp-camsa' AND tank_name = '${tankName}'`);
    psql(`DELETE FROM tanks WHERE tenant_id = 'comp-camsa' AND name = '${tankName}'`);
  }
});

test('cihaz eşleştirme: claim kodu + QR üretilir ve görüntülenir (FE-809)', async ({ page }) => {
  const run = Date.now();
  const deviceName = `E2E FE809 Cihaz ${run}`;
  try {
    await loginCompanyUser(page, 'camsa');
    await page.goto('/panel/devices');

    await page.getByTestId('device-claim-open').click();
    await page.getByTestId('device-claim-name-input').fill(deviceName);
    const genRes = page.waitForResponse((r) => r.url().endsWith('/api/v1/devices/claim-codes') && r.request().method() === 'POST');
    await page.getByTestId('device-claim-generate').click();
    expect((await genRes).status()).toBe(200);

    await expect(page.getByTestId('device-claim-result')).toBeVisible();
    await expect(page.getByTestId('device-claim-qr')).toBeVisible();
    const codeText = await page.getByTestId('device-claim-code-text').textContent();
    expect(codeText?.trim().length).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Kapat' }).click();
    await expect(page.getByTestId('device-claim-result')).not.toBeVisible();

    // Üretilen kod, "Eşleştirme Kodları" listesinde görünür
    await expect(page.locator('[data-testid="claim-code-row"]', { hasText: deviceName })).toBeVisible();
  } finally {
    psql(`DELETE FROM device_claim_codes WHERE tenant_id = 'comp-camsa' AND device_name = '${deviceName}'`);
  }
});
