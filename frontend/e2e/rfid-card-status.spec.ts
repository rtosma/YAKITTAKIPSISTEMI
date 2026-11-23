import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { loginCompanyUser, resetLoginRateLimit, waitForApi } from './helpers';

/**
 * FE-808 Kapsam: "Araç/sürücü bloke etme ve kart kayıp bildirimi." AUTH-210
 * (backend rfid_card_blacklist) zaten tam bir akış sunuyordu — bu, onun
 * TEK frontend arayüzünün (RfidCardStatusModal) uçtan uca testi.
 *
 * KAPSAM UYARLAMASI (disclosed): Test Notu'ndaki "toplu içe aktarma hata
 * raporu" burada YOK — Excel İÇE AKTARMA (yalnızca dışa aktarma zaten var)
 * bu projede hiç yok, yeni bir özellik olarak FE-808'in kapsamı dışına
 * bırakıldı (ayrı bilet önerilir). "Kart okutarak eşleştirme (simüle
 * olay)" FLEET-1402'nin ZATEN var olan RfidUnmatchedAlerts bileşenidir —
 * bu dosyada DEĞİL, geçmiş oturumlarda FLEET-1402 kapsamında test edildi.
 */

function psql(sql: string): string {
  return execFileSync('docker', ['exec', 'yakittakip_postgres', 'psql', '-U', 'postgres', '-d', 'yakittakip_db', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();
}

test.beforeEach(() => resetLoginRateLimit());

test('RFID kart durumu: kayıp bildir → listede KART BLOKE işaretlenir → blokeyi kaldır → kartı değiştir (FE-808)', async ({ page }) => {
  let originalRfidTag = '';
  let newUid = '';
  const run = Date.now();
  try {
    await loginCompanyUser(page, 'camsa');
    await page.goto('/panel/vehicles');
    await waitForApi(page, ['/vehicles']);

    const firstRow = page.getByTestId('vehicle-row').first();
    await expect(firstRow).toBeVisible();
    const plate = await firstRow.getAttribute('data-plate');
    originalRfidTag = (await firstRow.locator('td').nth(5).textContent())?.trim().split(/\s/)[0] || '';
    expect(originalRfidTag.length).toBeGreaterThan(0);

    // 1) Kayıp/Çalıntı bildir
    await firstRow.getByTestId('rfid-card-status-open').click();
    await expect(page.getByTestId('rfid-card-status-modal')).toBeVisible();
    await page.getByTestId('rfid-card-report-open').click();
    await page.getByTestId('rfid-card-reason-input').fill('E2E test — kayıp bildirimi');
    const blockRes = page.waitForResponse((r) => r.url().includes('/rfid-cards/') && r.url().includes('/block') && r.request().method() === 'POST');
    await page.getByTestId('rfid-card-report-confirm').click();
    expect((await blockRes).status()).toBe(201);
    await expect(page.getByTestId('rfid-card-status-modal')).not.toBeVisible();

    // 2) Listede AÇIKÇA işaretlenir (AC)
    await expect(page.locator(`[data-testid="vehicle-row"][data-plate="${plate}"]`).getByTestId('rfid-card-blocked-badge')).toBeVisible();

    // 3) Blokeyi kaldır (kart bulundu)
    await page.locator(`[data-testid="vehicle-row"][data-plate="${plate}"]`).getByTestId('rfid-card-status-open').click();
    await expect(page.getByText('KAYIP olarak işaretli', { exact: false })).toBeVisible();
    const unblockRes = page.waitForResponse((r) => r.url().includes('/rfid-cards/') && r.url().includes('/unblock'));
    await page.getByTestId('rfid-card-unblock').click();
    expect((await unblockRes).status()).toBe(200);
    await expect(page.locator(`[data-testid="vehicle-row"][data-plate="${plate}"]`).getByTestId('rfid-card-blocked-badge')).not.toBeVisible();

    // 4) Kartı değiştir — eski kart REPLACED olur, araç yeni UID'i alır
    newUid = `E2E-NEWCARD-${run}`;
    await page.locator(`[data-testid="vehicle-row"][data-plate="${plate}"]`).getByTestId('rfid-card-status-open').click();
    await page.getByTestId('rfid-card-replace-open').click();
    await page.getByTestId('rfid-card-new-uid-input').fill(newUid);
    const replaceRes = page.waitForResponse((r) => r.url().endsWith('/api/v1/rfid-cards/replace'));
    await page.getByTestId('rfid-card-replace-confirm').click();
    expect((await replaceRes).status()).toBe(200);
    await expect(page.locator(`[data-testid="vehicle-row"][data-plate="${plate}"]`)).toContainText(newUid);
  } finally {
    if (originalRfidTag) psql(`UPDATE vehicles SET rfid_tag = '${originalRfidTag}' WHERE tenant_id = 'comp-camsa' AND rfid_tag IN ('${newUid}', '${originalRfidTag}')`);
    if (originalRfidTag) psql(`DELETE FROM rfid_card_blacklist WHERE tenant_id = 'comp-camsa' AND card_uid IN ('${originalRfidTag}', '${newUid}')`);
  }
});
