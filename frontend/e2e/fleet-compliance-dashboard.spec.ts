import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { loginCompanyUser, resetLoginRateLimit, waitForApi } from './helpers';

/**
 * FLEET-1408 AC: "Geçmiş yükümlülükler dashboard'da kritik olarak
 * gösterilmelidir." Backend (GET /fleet/compliance/dashboard, 30/15/7 gün
 * muayene-egzoz-sigorta uyarısı, lastik km ömrü, günlük sweep + alarm) ZATEN
 * tamamdı — bu test, önceden HİÇ VAROLMAYAN arayüzün (OverviewPage'deki
 * FleetComplianceWidget) gerçek, GECİKMİŞ bir yükümlülüğü GERÇEKTEN kritik
 * olarak gösterdiğini uçtan uca doğrular.
 */

function psql(sql: string): string {
  return execFileSync('docker', ['exec', 'yakittakip_postgres', 'psql', '-U', 'postgres', '-d', 'yakittakip_db', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();
}

test.beforeEach(() => resetLoginRateLimit());

test('FLEET-1408: geciken bir muayene son tarihi genel bakış panosunda GECİKMİŞ olarak görünür', async ({ page }) => {
  const plate = `34 FCD ${1000 + Math.floor(Math.random() * 9000)}`;

  try {
    await loginCompanyUser(page, 'camsa');
    await page.goto('/panel/vehicles');
    await waitForApi(page, ['/vehicles']);

    await page.getByRole('button', { name: /Yeni Araç Ekle/ }).click();
    await page.getByPlaceholder(/örn\. 34 CTP 99/).fill(plate);
    await page.getByPlaceholder('örn. Volvo FMX 460 Damperli').fill('E2E Uygunluk Test Aracı');
    const created = page.waitForResponse((r) => r.url().endsWith('/api/v1/vehicles') && r.request().method() === 'POST');
    await page.getByRole('button', { name: /Aracı Kaydet/ }).click();
    const createdBody = await (await created).json();
    const vehicleId: string = createdBody.data.id;

    // Geçmiş bir muayene tarihi ekle (UI'da bu formun kendisi bu ticket'ın
    // kapsamı DIŞINDA — yalnızca dashboard GÖSTERİMİ eklendi) — doğrudan API.
    const accessToken = await page.evaluate(() => localStorage.getItem('YAKIT_ACCESS_TOKEN'));
    const pastDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const deadlineRes = await page.request.post(`/api/v1/vehicles/${vehicleId}/compliance-deadlines`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { deadlineType: 'MUAYENE', issuedAt: '2020-01-01', dueDate: pastDate }
    });
    expect(deadlineRes.status()).toBe(201);

    await page.goto('/panel/overview');
    await waitForApi(page, ['/fleet/compliance/dashboard']);

    await expect(page.getByText('Filo Uygunluk Durumu')).toBeVisible();
    const row = page.getByTestId('fleet-compliance-row').filter({ hasText: plate });
    await expect(row).toBeVisible();
    await expect(row).toContainText('MUAYENE son tarihi');
    await expect(row).toContainText('gün geçti');
    await expect(page.getByText(/\d+ GECİKMİŞ/)).toBeVisible();
  } finally {
    psql(`DELETE FROM vehicle_compliance_deadlines WHERE vehicle_plate = '${plate}'`);
    psql(`DELETE FROM vehicles WHERE plate = '${plate}' AND tenant_id = 'comp-camsa'`);
  }
});
