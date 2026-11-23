import { expect, test } from '@playwright/test';
import { loginCompanyUser, resetLoginRateLimit, waitForApi } from './helpers';

/**
 * FE-801 AC: "Eski veri açıkça işaretlenmelidir." Önceden backend'in
 * `telemetry:data`/`device:status` Socket.io olaylarının frontend'de HİÇBİR
 * dinleyicisi yoktu ve bağlantı koptuğunda ekrandaki tank seviyeleri sessizce
 * "güncel"miş gibi görünmeye devam ediyordu (Teknik Not: "Kopuk bağlantıda
 * eski veriyi güncel göstermek operasyonel hataya yol açar").
 *
 * Bu test, GERÇEK bir Socket.io bağlantı kopmasını (tarayıcıyı çevrimdışına
 * alarak) simüle edip "eski veri" uyarısının GERÇEKTEN belirdiğini ve
 * bağlantı geri gelince kaybolduğunu doğrular.
 */

test.beforeEach(() => resetLoginRateLimit());

test('FE-801: bağlantı koptuğunda tank ekranında "eski veri" uyarısı belirir, geri gelince kaybolur', async ({ page, context }) => {
  // Socket.io'nun SESSİZ bir bağlantı kaybını (temiz bir close frame OLMADAN)
  // fark etmesi ping-timeout mekanizmasına dayanır (istemci varsayılanı:
  // pingInterval 25sn + pingTimeout 20sn ile toplamda 45sn'ye kadar sürebilir)
  // — playwright.config.ts'in genel 30sn test timeout'u burada YETERSİZ.
  test.setTimeout(90_000);

  await loginCompanyUser(page, 'camsa');
  await page.goto('/panel/tanks');
  await waitForApi(page, ['/tanks']);

  const staleWarning = page.getByText(/Canlı bağlantı kesik — aşağıdaki tank seviyeleri ESKİ/);
  await expect(staleWarning).not.toBeVisible();

  // Gerçek bir bağlantı kopması simülasyonu — socket.io istemcisi bunu GERÇEK
  // bir ağ hatası olarak görür (mock bir olay DEĞİL).
  await context.setOffline(true);
  await expect(staleWarning).toBeVisible({ timeout: 60_000 });

  await context.setOffline(false);
  await expect(staleWarning).not.toBeVisible({ timeout: 20_000 });
});
