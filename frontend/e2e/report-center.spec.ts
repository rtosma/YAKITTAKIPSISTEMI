import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { loginCompanyUser, resetLoginRateLimit, waitForApi } from './helpers';

/**
 * FE-816 (#147) — Rapor merkezi ekranı (katalog, filtre, indirme).
 *
 * Backend (REP-703 ortak rapor çatısı, REP-705 zamanlanmış gönderim, REP-723
 * yönetici özet dashboard'u) zaten tamdı ve kendi backend testlerinde
 * (test_rep70x_*.ts, test_rep723_executive_dashboard.ts) kanıtlıydı — burada
 * backend davranışı TEKRAR test EDİLMİYOR, sadece önceden hiç var olmayan
 * frontend yüzeyi: dashboard → katalog drilldown, filtre+önizleme+export,
 * zamanlama CRUD.
 */

function psql(sql: string): string {
  return execFileSync('docker', ['exec', 'yakittakip_postgres', 'psql', '-U', 'postgres', '-d', 'yakittakip_db', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();
}

test.beforeEach(() => resetLoginRateLimit());

test('yönetici özeti KPI tıklaması katalog sekmesine filtre ön-yüklü yönlendirir, rapor filtrelenip CSV indirilir (FE-816)', async ({ page }) => {
  await loginCompanyUser(page, 'camsa');
  await page.goto('/panel/reports');
  await waitForApi(page, ['/dashboard/executive']);

  await expect(page.getByTestId('dashboard-panel')).toBeVisible();
  await expect(page.getByTestId('kpi-dailyConsumptionLiters')).toBeVisible();

  // ASIL AC — "Dashboard KPI kartları detay raporlarına yönlendirmelidir."
  // Dinleyici TIKLAMADAN ÖNCE kurulur — backend yanıtı milisaniyeler içinde
  // dönebildiğinden, sonradan kurulan bir waitForResponse zaten geçmiş bir
  // yanıtı YAKALAYAMAZ (FE-815'in assign/resolve testlerinde kurulan AYNI
  // "önce dinle, sonra tetikle" kuralı).
  const kpiRes = page.waitForResponse((r) => r.url().includes('/reports/rep-711') && r.request().method() === 'GET');
  await page.getByTestId('kpi-dailyConsumptionLiters').click();
  await kpiRes;
  await expect(page.getByTestId('catalog-panel')).toBeVisible();
  await expect(page.getByTestId('report-filter-startDate')).not.toHaveValue('');
  await expect(page.getByTestId('report-preview-table')).toBeVisible();

  // ASIL AC — "Ortak filtre paneli ve rapor önizleme tablosu" + "kullanıcı
  // yalnızca yetkili olduğu raporları görmelidir" (katalog arama/seçim).
  await page.getByTestId('catalog-search').fill('İkmal Hareket');
  await expect(page.locator('[data-testid="catalog-report-card"][data-report-id="rep-711"]')).toBeVisible();
  const cardRes = page.waitForResponse((r) => r.url().includes('/reports/rep-711') && r.request().method() === 'GET');
  await page.locator('[data-testid="catalog-report-card"][data-report-id="rep-711"]').click();
  await cardRes;

  await page.getByTestId('report-filter-siteName').fill('NONEXISTENT_SITE_FE816');
  const filterRes = page.waitForResponse((r) => r.url().includes('/reports/rep-711') && r.request().method() === 'GET');
  await page.getByTestId('report-filter-apply').click();
  await filterRes;
  await expect(page.getByTestId('report-preview-table')).toContainText('Kayıt bulunamadı');

  await page.getByTestId('report-filter-siteName').fill('');
  const clearRes = page.waitForResponse((r) => r.url().includes('/reports/rep-711') && r.request().method() === 'GET');
  await page.getByTestId('report-filter-apply').click();
  await clearRes;

  // ASIL AC — "Excel/PDF/CSV indirme."
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('report-export-csv').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain('.csv');
});

test('zamanlanmış rapor oluşturulabilir, etkinlik durumu değiştirilebilir ve silinebilir (FE-816)', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  // Seed verisinde HİÇBİR kullanıcının e-postası yok (test_rep724'ün AYNI
  // ihtiyaç için yaptığı gibi) — REP-705'in alıcı doğrulaması (e-postasız
  // kullanıcı 400 RECIPIENT_NO_EMAIL döner) geçici bir e-posta gerektirir.
  psql(`UPDATE users SET email = 'fe816-e2e@test.local' WHERE id = 'usr-camsa-owner'`);
  try {
    await loginCompanyUser(page, 'camsa');
    await page.goto('/panel/reports');
    await page.getByTestId('reports-tab-schedules').click();
    await waitForApi(page, ['/report-schedules']);
    await expect(page.getByTestId('schedules-panel')).toBeVisible();

    // ASIL AC (REP-705) — "Zamanlanan rapor belirlenen periyotta üretilip
    // gönderilmelidir" + alıcı seçimi (FE-815'te eklenen GET /users'ın
    // burada da YENİDEN kullanıldığı nokta).
    await page.getByTestId('schedule-report-select').selectOption({ label: 'İkmal Hareket Raporu' });
    await page.getByTestId('schedule-period-select').selectOption('WEEKLY');
    await expect(page.getByTestId('schedule-day-of-week-select')).toBeVisible();
    await page.getByTestId('schedule-hour-input').fill('6');

    const recipientLabel = page.locator('[data-testid="schedule-recipients"] label', { hasText: 'camsa' });
    await recipientLabel.click();

    const createRes = page.waitForResponse((r) => r.url().includes('/report-schedules') && r.request().method() === 'POST');
    await page.getByTestId('schedule-create-submit').click();
    expect((await createRes).status()).toBe(201);

    const scheduleRow = page.locator('[data-testid="schedule-row"]').filter({ hasText: 'İkmal Hareket Raporu' });
    await expect(scheduleRow).toBeVisible();
    await expect(scheduleRow).toContainText('Haftalık');

    // Gönderim geçmişi henüz boş (süpürücü bu zamanlamayı henüz çalıştırmadı).
    await scheduleRow.getByTestId('schedule-expand-deliveries').click();
    await expect(scheduleRow).toContainText('Henüz gönderim yok');

    // ASIL AC — zamanlama etkinleştirme/devre dışı bırakma.
    const toggleRes = page.waitForResponse((r) => r.url().includes('/report-schedules/') && r.request().method() === 'PATCH');
    await scheduleRow.getByTestId('schedule-toggle-enabled').click();
    expect((await toggleRes).status()).toBe(200);
    await expect(scheduleRow.getByTestId('schedule-toggle-enabled')).toContainText('Devre Dışı');

    const deleteRes = page.waitForResponse((r) => r.url().includes('/report-schedules/') && r.request().method() === 'DELETE');
    await scheduleRow.getByTestId('schedule-delete').click();
    expect((await deleteRes).status()).toBe(200);
    await expect(page.locator('[data-testid="schedule-row"]').filter({ hasText: 'İkmal Hareket Raporu' })).toHaveCount(0);
  } finally {
    // Test başarısız olup silme adımına ulaşamazsa kalıntı bırakmasın.
    psql(`DELETE FROM report_deliveries WHERE schedule_id IN (SELECT id FROM report_schedules WHERE tenant_id = 'comp-camsa' AND report_id = 'rep-711' AND created_by = 'usr-camsa-owner')`);
    psql(`DELETE FROM report_schedules WHERE tenant_id = 'comp-camsa' AND report_id = 'rep-711' AND created_by = 'usr-camsa-owner'`);
    psql(`UPDATE users SET email = NULL WHERE id = 'usr-camsa-owner'`);
  }
});
