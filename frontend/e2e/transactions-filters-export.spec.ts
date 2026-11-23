import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { loginCompanyUser, resetLoginRateLimit, waitForApi } from './helpers';

/**
 * FE-812 (#143) — İkmal hareketleri tablosu, filtre ve export.
 *
 * `transactions-url-sync.spec.ts` (FE-802) zaten "arama" filtresinin URL
 * senkronizasyonunu kapsıyor — BURADA TEKRAR test EDİLMİYOR. Bu dosya
 * SADECE bu ticket'ın GERÇEKTEN yeni/önceden hiç yüzeyi olmayan kısımlarını
 * kapsar: araç/tank/yetki tipi filtreleri (biri önceden ÖLÜ bir alandı —
 * state/URL vardı ama seçim kutusu yoktu), sütun sıralama, yoğunluk
 * seçeneği, CSV/PDF export (REP-711 — önceden frontend'de hiç
 * kullanılmıyordu) ve satır detayındaki e-İrsaliye durumu/telemetri notu.
 */

test.beforeEach(() => resetLoginRateLimit());

test('gelişmiş filtreler (araç/tank/yetki tipi) URL ile senkron olur, sütun sıralama ve yoğunluk çalışır (FE-812)', async ({ page }) => {
  await loginCompanyUser(page, 'camsa');
  await page.goto('/panel/transactions');
  await waitForApi(page, ['/transactions']);

  // ASIL AC — önceden ÖLÜ bir alan: selectedType state/URL zaten vardı,
  // bu seçim kutusu HİÇ yoktu.
  const typeSelect = page.getByTestId('filter-type');
  await expect(typeSelect).toBeVisible();
  const typeRes = page.waitForResponse((r) => r.url().includes('/api/v1/transactions') && r.url().includes('type=Manuel'));
  await typeSelect.selectOption('Manuel');
  expect((await typeRes).status()).toBe(200);
  expect(new URL(page.url()).searchParams.get('type')).toBe('Manuel');

  // ASIL AC — "araç" filtresi (önceden yalnızca serbest metin aramanın dolaylı kapsamındaydı).
  const vehicleInput = page.getByTestId('filter-vehicle');
  const vehicleRes = page.waitForResponse((r) => r.url().includes('/api/v1/transactions') && r.url().includes('vehiclePlate=35'), { timeout: 5000 });
  await vehicleInput.fill('35');
  await vehicleRes;
  expect(new URL(page.url()).searchParams.get('vehicle')).toBe('35');

  // Temizle — her iki yeni filtre de URL'den düşer.
  await page.getByRole('button', { name: /Filtreleri Temizle/ }).click();
  await expect(typeSelect).toHaveValue('TÜMÜ');
  await expect(vehicleInput).toHaveValue('');
  await expect.poll(() => new URL(page.url()).searchParams.has('vehicle')).toBe(false);

  // ASIL AC — "sütun sıralama": aynı sütuna ikinci tıklama yönü çevirir, URL'e yansır.
  const amountHeader = page.getByTestId('sort-header-amount_liters');
  const sortRes1 = page.waitForResponse((r) => r.url().includes('/api/v1/transactions') && r.url().includes('sortBy=amount_liters'));
  await amountHeader.click();
  expect((await sortRes1).status()).toBe(200);
  expect(new URL(page.url()).searchParams.get('sortBy')).toBe('amount_liters');
  // sortDir henüz varsayılan ('desc') — URL'i kirletmemek için YAZILMAZ
  // (diğer filtrelerdeki "varsayılan değer URL'e hiç yazılmaz" kuralıyla aynı).
  expect(new URL(page.url()).searchParams.get('sortDir')).toBeNull();

  const sortRes2 = page.waitForResponse((r) => r.url().includes('/api/v1/transactions') && r.url().includes('sortDir=asc'));
  await amountHeader.click();
  expect((await sortRes2).status()).toBe(200);
  expect(new URL(page.url()).searchParams.get('sortDir')).toBe('asc');

  // Kapsam: "yoğunluk seçenekleri" — sunucuya gitmeyen, salt görüntüleme tercihi.
  const table = page.getByTestId('transactions-table');
  await expect(table).toHaveAttribute('data-density', 'comfortable');
  await page.getByTestId('density-toggle').click();
  await expect(table).toHaveAttribute('data-density', 'compact');
});

test('CSV/PDF export (REP-711) indirir, satır detayında e-İrsaliye durumu ve telemetri notu gösterilir (FE-812)', async ({ page }) => {
  await loginCompanyUser(page, 'camsa');
  await page.goto('/panel/transactions');
  await waitForApi(page, ['/transactions']);

  // ASIL AC — "Excel/CSV/PDF export": CSV önceden hiç yoktu, REP-711'in
  // zaten var olan /reports/rep-711/export ucunu kullanır.
  const [csvDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-csv').click()
  ]);
  expect(csvDownload.suggestedFilename()).toMatch(/^ikmal-hareketleri_\d{4}-\d{2}-\d{2}\.csv$/);
  const csvContent = readFileSync(await csvDownload.path() as string, 'utf8');
  expect(csvContent.length).toBeGreaterThan(0);

  const [pdfDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-pdf').click()
  ]);
  expect(pdfDownload.suggestedFilename()).toMatch(/^ikmal-hareketleri_\d{4}-\d{2}-\d{2}\.pdf$/);
  const pdfBuffer = readFileSync(await pdfDownload.path() as string);
  expect(pdfBuffer.subarray(0, 4).toString()).toBe('%PDF');

  // ASIL AC — "Satır detayında ... e-İrsaliye durumu." Seed verisindeki
  // ikmaller için henüz hiç e-İrsaliye üretilmedi — bu, hata DEĞİL, normal
  // bir durum olarak gösterilmeli (önceden bu uç HİÇ kullanılmıyordu).
  const firstRow = page.getByTestId('transaction-row').first();
  await firstRow.click();
  const detail = page.getByTestId('transaction-row-detail');
  await expect(detail).toBeVisible();
  await expect(detail.getByTestId('despatch-status-none')).toBeVisible();

  // KAPSAM UYARLAMASI (disclosed) — "telemetri grafiği": backend'de bu
  // ikmale ait kalıcı bir zaman serisi YOK (araştırıldı, schema.sql'de yok);
  // sahte veri göstermek yerine durum açıkça bildiriliyor.
  await expect(detail.getByTestId('telemetry-chart-unavailable')).toBeVisible();

  // Aynı satıra tekrar tıklamak detayı kapatır.
  await firstRow.click();
  await expect(detail).not.toBeVisible();
});
