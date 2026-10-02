import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { loginCompanyUser, resetLoginRateLimit, waitForApi } from './helpers';

/**
 * FE-815 (#146) — Alarm/anomali merkezi ve bildirim tercihleri.
 *
 * Backend (AI-507 birleşik alarm yaşam döngüsü + NOTIF-1605 kullanıcı bazlı
 * tercih/sessize alma) zaten tamdı ve backend/test/test_ai507_alarm_
 * lifecycle.ts'te kanıtlıydı — burada backend davranışı TEKRAR test
 * EDİLMİYOR, sadece önceden hiç var olmayan frontend yüzeyi: canlı toast +
 * okunmamış sayaç, alarm listesi/detay/atama/sustur/çöz, tercih matrisi.
 *
 * Alarm tetikleyici: POST /tanks/:id/reconciliations (%5 üstü AÇIKLANAMAYAN
 * sapma) — backend/test/test_ai507_alarm_lifecycle.ts'in Test 4/14'teki İLE
 * AYNI, tek-istekle CRITICAL alarm üreten en basit mekanizma.
 *
 * İZOLASYON: taze, tek seferlik (Date.now()) bir tank kullanılır.
 */

function psql(sql: string): string {
  return execFileSync('docker', ['exec', 'yakittakip_postgres', 'psql', '-U', 'postgres', '-d', 'yakittakip_db', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();
}

const API_URL = 'http://localhost:3000/api/v1';

async function apiLogin(username: string, password = '123456'): Promise<string> {
  const res = await fetch(`${API_URL}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const data = await res.json();
  if (!data.accessToken) throw new Error(`login ${username}: ${JSON.stringify(data)}`);
  return data.accessToken;
}

test.beforeEach(() => resetLoginRateLimit());

test('kritik alarm anlık toast + okunmamış sayacı üretir, listede görünür, atanır ve çözülür (FE-815)', async ({ page }) => {
  const RUN = Date.now();
  const tankId = `fe815-tank-${RUN}`;
  const siteName = 'Silivri Tesisleri';
  const owner = await apiLogin('camsa');

  try {
    psql(`INSERT INTO tanks (id, tenant_id, name, site_name, capacity_liters, current_level_liters, fuel_type)
          VALUES ('${tankId}', 'comp-camsa', 'FE815 Test Tank ${RUN}', '${siteName}', 10000, 5000, 'Motorin')`);

    await loginCompanyUser(page, 'camsa');
    await page.waitForFunction(() => document.documentElement.dataset.socket === 'connected', { timeout: 15_000 });

    // ASIL AC — "Kritik alarm ekranda anlık bildirim üretmelidir." Panel
    // /panel/overview'da (alarm merkezinde DEĞİL) iken bile toast + sayaç gelir.
    const reconRes = await fetch(`${API_URL}/tanks/${tankId}/reconciliations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner}` },
      body: JSON.stringify({ periodType: 'AD_HOC', periodStart: '2025-05-01T00:00:00.000Z', periodEnd: '2025-05-02T00:00:00.000Z', openingBookLiters: 5000, physicalLiters: 4750 })
    });
    expect(reconRes.status).toBe(201);

    await expect(page.locator('text=Stok mutabakat farkı')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('unread-alarm-badge')).toHaveText('1');

    // ASIL AC — "Alarmlar listelenip atanabilmeli ve kapatılabilmelidir."
    await page.goto('/panel/notifications');
    await waitForApi(page, ['/alarms']);
    // Sayfayı ziyaret etmek sayacı sıfırlar.
    await expect(page.getByTestId('unread-alarm-badge')).toHaveCount(0);

    const alarmRow = page.locator('tr[data-testid="alarm-row"]').filter({ hasText: `FE815 Test Tank ${RUN}` });
    await expect(alarmRow).toBeVisible();
    await expect(alarmRow).toContainText('CRITICAL');
    await alarmRow.click();

    await expect(page.getByTestId('alarm-detail-modal')).toBeVisible();
    await expect(page.getByTestId('alarm-event-row').first()).toBeVisible();

    // ASIL AC — çözüm notu ZORUNLU (backend de reddeder) — önce notsuz
    // denenemez (buton disabled). Herhangi bir ata/sustur eyleminden ÖNCE
    // kontrol edilir — o eylemlerin KENDİ geçici "kaydediliyor" durumuyla
    // (isSavingAlarm) karışıp YANLIŞ-POZİTİF bir "disabled" vermesin diye.
    await expect(page.getByTestId('alarm-status-resolved')).toBeDisabled();
    await page.getByTestId('alarm-resolution-note').fill('Tank fiziksel ölçümle doğrulandı, kayıt hatası.');
    await expect(page.getByTestId('alarm-status-resolved')).toBeEnabled();
    // Notu temizle — asıl "Ata" akışını notsuz bir durumdan test et.
    await page.getByTestId('alarm-resolution-note').fill('');
    await expect(page.getByTestId('alarm-status-resolved')).toBeDisabled();

    // Ata.
    await page.getByTestId('alarm-assignee-select').selectOption({ label: 'camsa (COMPANY_OWNER)' });
    const assignRes = page.waitForResponse((r) => r.url().includes('/alarms/') && r.request().method() === 'PATCH');
    await page.getByTestId('alarm-assign').click();
    expect((await assignRes).status()).toBe(200);
    await expect(page.getByTestId('alarm-assign')).toBeEnabled();

    await page.getByTestId('alarm-resolution-note').fill('Tank fiziksel ölçümle doğrulandı, kayıt hatası.');
    await expect(page.getByTestId('alarm-status-resolved')).toBeEnabled();

    const resolveRes = page.waitForResponse((r) => r.url().includes('/alarms/') && r.request().method() === 'PATCH');
    await page.getByTestId('alarm-status-resolved').click();
    expect((await resolveRes).status()).toBe(200);
    await expect(page.getByTestId('alarm-detail-modal')).toContainText('Çözüldü');

    await page.getByTestId('alarm-detail-close').click();
    // Varsayılan liste (includeResolved=false) artık bu alarmı GÖSTERMEMELİ.
    await expect(page.locator('tr[data-testid="alarm-row"]').filter({ hasText: `FE815 Test Tank ${RUN}` })).toHaveCount(0);
    await page.getByTestId('filter-include-resolved').check();
    await waitForApi(page, ['/alarms']);
    await expect(page.locator('tr[data-testid="alarm-row"]').filter({ hasText: `FE815 Test Tank ${RUN}` })).toBeVisible();

    // ASIL AC (Teknik Not) — sesli uyarı kullanıcı etkileşimiyle etkinleştirilir.
    await expect(page.getByTestId('enable-sound')).toBeVisible();
    await page.getByTestId('enable-sound').click();
    await expect(page.getByTestId('enable-sound')).not.toBeVisible();
  } finally {
    psql(`DELETE FROM audit_logs WHERE tenant_id = 'comp-camsa' AND target_type = 'alarm' AND target_id IN (SELECT id FROM alarms WHERE alarm_key = 'STOCK_RECON:${tankId}')`);
    psql(`DELETE FROM alarm_events WHERE alarm_id IN (SELECT id FROM alarms WHERE tenant_id = 'comp-camsa' AND alarm_key = 'STOCK_RECON:${tankId}')`);
    psql(`DELETE FROM alarms WHERE tenant_id = 'comp-camsa' AND alarm_key = 'STOCK_RECON:${tankId}'`);
    psql(`DELETE FROM stock_reconciliations WHERE tank_id = '${tankId}'`);
    psql(`DELETE FROM tanks WHERE id = '${tankId}'`);
  }
});

test('bildirim tercihleri matrisi kalıcıdır, sessize alma tüm bildirimleri kapsar (FE-815)', async ({ page }) => {
  try {
    await loginCompanyUser(page, 'camsa');
    await page.goto('/panel/notifications');
    await waitForApi(page, ['/alarms']);
    await expect(page.getByTestId('preferences-section')).toBeVisible();

    // ASIL AC — "kanal × olay tipi" matrisi; varsayılan AÇIK (opt-out modeli).
    const checkbox = page.getByTestId('pref-THEFT_DETECTED-EMAIL');
    await expect(checkbox).toBeChecked();
    const putRes = page.waitForResponse((r) => r.url().includes('/notifications/preferences') && r.request().method() === 'PUT');
    await checkbox.uncheck();
    expect((await putRes).status()).toBe(200);

    // Sayfa yenilenince (sunucudan GERÇEKTEN okunduğunu kanıtlar) tercih kalıcı.
    await page.reload();
    await waitForApi(page, ['/alarms']);
    await expect(page.getByTestId('pref-THEFT_DETECTED-EMAIL')).not.toBeChecked();
    // Geri aç — test sonrası durumu temiz bırak.
    const restoreRes = page.waitForResponse((r) => r.url().includes('/notifications/preferences') && r.request().method() === 'PUT');
    await page.getByTestId('pref-THEFT_DETECTED-EMAIL').check();
    await restoreRes;

    // ASIL AC — "Sessize alma: belirli süre... için" + "tümünü seç" satır kısayolu.
    const beforeCount = await page.getByTestId('active-mute-row').count();
    await page.getByTestId('mute-minutes-input').fill('5');
    const muteRes = page.waitForResponse((r) => r.url().includes('/notifications/mute') && r.request().method() === 'POST');
    await page.getByTestId('mute-all').click();
    expect((await muteRes).status()).toBe(200);
    await expect(page.getByTestId('active-mute-row')).toHaveCount(beforeCount + 1);
    await expect(page.getByTestId('active-mute-row').last()).toContainText('Tüm bildirimler');
  } finally {
    // Önceki (başarısız) koşulardan kalan sessize almalar BİRİKMESİN — kendi
    // oluşturduğu + varsa eski kalıntıları temizler (5 dk sonra zaten kendiliğinden biter).
    execFileSync('docker', ['exec', 'yakittakip_postgres', 'psql', '-U', 'postgres', '-d', 'yakittakip_db', '-v', 'ON_ERROR_STOP=1', '-c',
      `DELETE FROM user_notification_mutes WHERE user_id = 'usr-camsa-owner'`], { encoding: 'utf8' });
  }
});
