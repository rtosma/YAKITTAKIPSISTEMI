import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { loginCompanyUser, loginSiteUser, resetLoginRateLimit, waitForApi } from './helpers';

/**
 * FE-813 (#144) — Km/motor-saat giriş ekranı ve toplu giriş.
 *
 * Backend (FLEET-1404 + RES-903, vehicle_meter_readings) zaten tamdı ve
 * backend/test/test_fleet1404_meter_readings.ts'te kapsamlıydı — burada
 * backend davranışı TEKRAR test EDİLMİYOR, sadece önceden hiç var olmayan
 * frontend yüzeyi: tekil/toplu giriş, RES-903'ün "uyarı + onaylı geçiş"
 * akışının UI'da doğru şekilde gösterilmesi, eksik giriş vurgusu ve
 * düzeltme geçmişi.
 *
 * İZOLASYON: Bu container uzun süredir ayakta, gerçek araçlarda geçmiş
 * dönemler için zaten okuma olabilir (DUPLICATE_PERIOD'a çarpardı) — bu
 * yüzden testler KENDİ taze, tek seferlik (Date.now()) plakalı araçlarını
 * kullanır, paylaşılan seed araçlara DOKUNMAZ.
 */

function psql(sql: string): string {
  return execFileSync('docker', ['exec', 'yakittakip_postgres', 'psql', '-U', 'postgres', '-d', 'yakittakip_db', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();
}

test.beforeEach(() => resetLoginRateLimit());

test('tekil giriş, geri giden değer uyarısı + onaylı kayıt, toplu yapıştırma ve eksik giriş panosu (FE-813)', async ({ page }) => {
  const RUN = Date.now();
  const plateKm = `34 FE813 ${String(RUN).slice(-4)}`;
  const plateBulk1 = `35 FE813A ${String(RUN).slice(-3)}`;
  const plateBulk2 = `35 FE813B ${String(RUN).slice(-3)}`;

  try {
    psql(`INSERT INTO vehicles (id, tenant_id, plate, brand_model, vehicle_type, rfid_tag, site_name, status)
          VALUES ('veh-fe813-${RUN}', 'comp-camsa', '${plateKm}', 'Test Kamyon', 'Kamyon', 'TAG-FE813-${RUN}', 'Gebze Ana Şantiye', 'AKTİF')`);
    psql(`INSERT INTO vehicles (id, tenant_id, plate, brand_model, vehicle_type, rfid_tag, site_name, status)
          VALUES ('veh-fe813b1-${RUN}', 'comp-camsa', '${plateBulk1}', 'Test Kamyon B1', 'Kamyon', 'TAG-FE813B1-${RUN}', 'Gebze Ana Şantiye', 'AKTİF')`);
    psql(`INSERT INTO vehicles (id, tenant_id, plate, brand_model, vehicle_type, rfid_tag, site_name, status)
          VALUES ('veh-fe813b2-${RUN}', 'comp-camsa', '${plateBulk2}', 'Test Kamyon B2', 'Kamyon', 'TAG-FE813B2-${RUN}', 'Gebze Ana Şantiye', 'AKTİF')`);

    await loginCompanyUser(page, 'camsa');
    await page.goto('/panel/meter-readings');
    await waitForApi(page, ['/meter-readings/missing']);

    // ASIL AC — "Eksik giriş yapılan araçların vurgulanması": taze araç
    // henüz hiç okuma almadı → EKSİK rozeti + eksik-giriş banner'ı sayılır.
    const kmRow = page.locator(`tr[data-testid="meter-row"][data-plate="${plateKm}"]`);
    await expect(kmRow).toContainText('EKSİK');
    await expect(page.getByTestId('missing-banner')).toBeVisible();

    // ASIL AC — tekil giriş.
    const valueInput = kmRow.getByTestId('meter-value-input');
    await valueInput.fill('50000');
    const saveRes1 = page.waitForResponse((r) => r.url().includes('/api/v1/vehicles/') && r.url().includes('/meter-readings') && r.request().method() === 'POST');
    await kmRow.getByTestId('meter-save').click();
    expect((await saveRes1).status()).toBe(201);
    await expect(kmRow).toContainText('GİRİLDİ', { timeout: 10_000 });

    // ASIL AC — RES-903: "geri giden km" UYARI üretmeli, kalıcı engel OLMAMALI.
    // Düzeltme akışı (correctsReadingId) YERİNE burada BİLEREK AYNI dönem için
    // İKİNCİ bir ham giriş deneniyor (DUPLICATE_PERIOD + daha düşük bir değer
    // aynı anda BACKWARD da tetikler) — tam da "onay isteyerek geçişe izin
    // vermeli" AC'sinin UI tarafını kanıtlamak için.
    await valueInput.fill('100');
    const suspiciousRes = page.waitForResponse((r) => r.url().includes('/meter-readings') && r.request().method() === 'POST' && r.status() === 409);
    await kmRow.getByTestId('meter-save').click();
    await suspiciousRes;
    await expect(page.getByTestId('suspicion-confirm-row')).toBeVisible();
    await expect(page.getByTestId('suspicion-reasons')).toContainText('Geri giden değer');
    // ASIL AC — backend'in 409 'detail' alanı YAPILANDIRILMIŞ bir nesnedir
    // (dailyMax/elapsedDays/deltaValue), metin DEĞİL — doğrudan render
    // edilirse React çöker (canlı yakalanan bug, bkz. formatSuspicionDetail).
    // Burada OKUNABİLİR bir cümleye çevrildiğini doğruluyoruz.
    await expect(page.getByTestId('suspicion-confirm-row')).toContainText('fark:');

    await page.getByTestId('override-reason-input').fill('Sayaç değişti, gerçek değer doğrulandı');
    const overrideRes = page.waitForResponse((r) => r.url().includes('/meter-readings') && r.request().method() === 'POST' && r.status() === 201);
    await page.getByTestId('override-confirm').click();
    expect((await overrideRes).status()).toBe(201);
    await expect(page.getByTestId('suspicion-confirm-row')).not.toBeVisible();

    // ASIL AC — "Düzeltme geçmişinin görüntülenmesi": iki satır da görünür,
    // ikincisi şüpheli+onaylı olarak işaretli.
    await kmRow.getByTestId('meter-history-open').click();
    await expect(page.getByTestId('meter-history-modal')).toBeVisible();
    const historyRows = page.getByTestId('meter-history-row');
    await expect(historyRows).toHaveCount(2);
    await expect(historyRows.first()).toContainText('Şüpheli');

    // ASIL AC — "Düzeltme geçmişinin görüntülenmesi" + APPEND-ONLY düzeltme:
    // bir satırı "Düzelt" ile yeni bir değerle kaydetmek ESKİ satırı SİLMEZ,
    // geçmişe YENİ bir satır (correctsReadingId dolu) ekler — toplam 3 olur.
    // ASIL AC (canlı yakalanan bulgu) — correctsReadingId VARKEN BİLE
    // RES-903'ün BACKWARD/ABSURD_JUMP kontrolü ATLANMAZ (yalnızca
    // DUPLICATE_PERIOD atlanır) — test ortamında iki okuma arasında
    // saniyeler geçtiğinden (min. 1 saatlik pencere varsayılır) büyük bir
    // düzeltme DE 409 alır; düzeltme formunun KENDİ override-confirm'ı
    // olmalı (ana giriş akışıyla AYNI desen) — bu akış burada doğrulanıyor.
    await historyRows.first().getByTestId('correction-open').click();
    await page.getByTestId('correction-value-input').fill('99999');
    const correctionSuspiciousRes = page.waitForResponse((r) => r.url().includes('/meter-readings') && r.request().method() === 'POST' && r.status() === 409);
    await page.getByTestId('correction-save').click();
    await correctionSuspiciousRes;
    await expect(page.getByTestId('correction-suspicion')).toBeVisible();

    await page.getByTestId('correction-override-reason-input').fill('Gerçek sayaç değeri sahada doğrulandı');
    const correctionRes = page.waitForResponse((r) => r.url().includes('/meter-readings') && r.request().method() === 'POST' && r.status() === 201);
    await page.getByTestId('correction-override-confirm').click();
    expect((await correctionRes).status()).toBe(201);
    await expect(historyRows).toHaveCount(3);
    await expect(historyRows.first()).toContainText('Bu kayıt önceki hatalı girişi düzeltiyor');

    await page.getByTestId('meter-history-close').click();
    await expect(page.getByTestId('meter-history-modal')).not.toBeVisible();

    // ASIL AC — toplu giriş (tablo yapıştırma).
    await page.getByTestId('bulk-open').click();
    await expect(page.getByTestId('bulk-modal')).toBeVisible();
    await page.getByTestId('bulk-paste-textarea').fill(`${plateBulk1}\t12345\n${plateBulk2}\t67890`);
    await expect(page.getByTestId('bulk-preview')).toContainText('2 satır');
    const bulkRes = page.waitForResponse((r) => r.url().includes('/api/v1/meter-readings/bulk'));
    await page.getByTestId('bulk-save').click();
    expect((await bulkRes).status()).toBe(200);
    const bulkRows = page.getByTestId('bulk-result-row');
    await expect(bulkRows).toHaveCount(2);
    await expect(bulkRows.filter({ hasText: plateBulk1 })).toHaveAttribute('data-ok', 'true');
    await expect(bulkRows.filter({ hasText: plateBulk2 })).toHaveAttribute('data-ok', 'true');
  } finally {
    psql(`DELETE FROM vehicle_meter_readings WHERE vehicle_id IN ('veh-fe813-${RUN}', 'veh-fe813b1-${RUN}', 'veh-fe813b2-${RUN}')`);
    psql(`DELETE FROM vehicles WHERE id IN ('veh-fe813-${RUN}', 'veh-fe813b1-${RUN}', 'veh-fe813b2-${RUN}')`);
  }
});

test('şantiye panelinde dokunma-dostu tekil sayaç girişi çalışır (FE-813)', async ({ page }) => {
  const RUN = Date.now();
  const plate = `34 FE813S ${String(RUN).slice(-4)}`;
  try {
    psql(`INSERT INTO vehicles (id, tenant_id, plate, brand_model, vehicle_type, rfid_tag, site_name, status)
          VALUES ('veh-fe813s-${RUN}', 'comp-camsa', '${plate}', 'Test Ekskavatör', 'Ekskavatör', 'TAG-FE813S-${RUN}', 'Gebze Ana Şantiye', 'AKTİF')`);

    await loginSiteUser(page, 'gebze-santiye');
    await expect(page.getByTestId('meter-entry-card')).toBeVisible();

    await page.getByTestId('meter-vehicle-select').selectOption({ label: `${plate} (Motor-Saat)` });
    await page.getByTestId('meter-value-input').fill('850');
    const res = page.waitForResponse((r) => r.url().includes('/meter-readings') && r.request().method() === 'POST');
    await page.getByTestId('meter-save').click();
    expect((await res).status()).toBe(201);
    await expect(page.getByTestId('meter-success')).toBeVisible();

    // ASIL AC — RES-903 uyarı + onaylı geçiş akışı bu kompakt panelde de var
    // (ana ofis sayfasıyla AYNI backend uçları/desen, kendi küçük UI'ı).
    await page.getByTestId('meter-value-input').fill('1');
    const suspiciousRes = page.waitForResponse((r) => r.url().includes('/meter-readings') && r.request().method() === 'POST' && r.status() === 409);
    await page.getByTestId('meter-save').click();
    await suspiciousRes;
    await expect(page.getByTestId('meter-suspicion')).toBeVisible();

    await page.getByTestId('meter-override-reason-input').fill('Motor saati gerçekten sıfırlandı, doğrulandı');
    const overrideRes = page.waitForResponse((r) => r.url().includes('/meter-readings') && r.request().method() === 'POST' && r.status() === 201);
    await page.getByTestId('meter-override-confirm').click();
    expect((await overrideRes).status()).toBe(201);
    await expect(page.getByTestId('meter-suspicion')).not.toBeVisible();
  } finally {
    psql(`DELETE FROM vehicle_meter_readings WHERE vehicle_id = 'veh-fe813s-${RUN}'`);
    psql(`DELETE FROM vehicles WHERE id = 'veh-fe813s-${RUN}'`);
  }
});
