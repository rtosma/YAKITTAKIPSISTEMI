import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { loginCompanyUser, resetLoginRateLimit, waitForApi } from './helpers';

/**
 * FE-810 (#142) — Çapraz alım yetkilendirme ve kota ekranı.
 *
 * KAPSAM UYARLAMASI (disclosed): Ticket'ın "kota tükendiğinde anlık uyarı
 * (FUEL-402.2)" AC'si GENEL fuel_quotas (FUEL-402.1) için DEĞİL — araştırıldı,
 * o sistem authorizeDispenseRequestCore/createTransactionCore'da HİÇ kontrol
 * edilmiyor (sadece GET /quotas/:id/balance ile GÖSTERİLİYOR). Gerçek zamanlı
 * reddedilen TEK kota mekanizması çapraz şantiye izninin (cross_site_permissions)
 * kendisidir (bkz. backend tenantDb.ts authorizeDispenseRequestCore,
 * 'FUEL-402.2' yorumu) — bu yüzden Test 2'deki canlı uyarı senaryosu O
 * mekanizmayı tetikler, genel kota sistemini DEĞİL.
 *
 * Test 1: YENİ frontend yüzeyi — kota tanımlama/listeleme/bakiye/aktif-pasif
 * (GET/POST/PATCH /quotas, zaten tam olan ama önceden arayüzü olmayan backend).
 * Test 2: canlı 'quota:exhausted' Socket.io olayının panelde ANLIK göründüğü
 * — backend tarafı (olayın DOĞRU payload'la, DOĞRU zamanda yayınlandığı)
 * zaten test_fuel402_2_quota_concurrency.ts Test 6'da mutation-test ile
 * doğrulandı; burada SADECE frontend'in bu olayı dinleyip gösterdiği test
 * ediliyor — redlock/eşzamanlılık burada TEKRAR test EDİLMİYOR.
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

function sign(secret: string, timestamp: string, nonce: string, rawBody: string): string {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${nonce}.${rawBody}`).digest('hex');
}

test.beforeEach(() => resetLoginRateLimit());

test('yakıt kotası tanımlanabilir, listelenir, bakiyesi (kalan/toplam) gösterilir ve pasifleştirilebilir (FE-810)', async ({ page }) => {
  await loginCompanyUser(page, 'camsa');
  await page.goto('/panel/cross-site');
  await waitForApi(page, ['/quotas', '/reports/rep-715-mahsup']);

  await expect(page.getByTestId('fuel-quota-section')).toBeVisible();
  const before = await page.getByTestId('quota-row').count();

  await page.getByTestId('quota-add-open').click();
  await expect(page.getByTestId('quota-create-modal')).toBeVisible();
  await page.getByTestId('quota-scope-all').click();
  await page.getByTestId('quota-period-select').selectOption('MONTHLY');
  await page.getByTestId('quota-carryover-select').selectOption('NONE');
  await page.getByTestId('quota-limit-input').fill('1500');

  const createRes = page.waitForResponse((r) => r.url().endsWith('/api/v1/quotas') && r.request().method() === 'POST');
  await page.getByTestId('quota-save').click();
  expect((await createRes).status()).toBe(201);
  await expect(page.getByTestId('quota-create-modal')).not.toBeVisible();

  // Yeni satır listede görünür + bakiye (GET /quotas/:id/balance) yüklenir.
  await expect(page.getByTestId('quota-row')).toHaveCount(before + 1);
  const newRow = page.getByTestId('quota-row').filter({ hasText: 'Tüm Filo' }).first();
  await expect(newRow).toBeVisible();
  await expect(newRow.getByTestId('quota-balance')).toContainText('1500', { timeout: 10_000 });
  await expect(newRow).toContainText('AKTİF');

  // Pasifleştir — PATCH /quotas/:id ile durum değişir.
  const patchRes = page.waitForResponse((r) => r.url().includes('/api/v1/quotas/') && r.request().method() === 'PATCH');
  await newRow.getByTestId('quota-toggle-status').click();
  expect((await patchRes).status()).toBe(200);
  await expect(newRow).toContainText('PASİF');
});

test('çapraz şantiye izni tükendiğinde panelde \'quota:exhausted\' canlı uyarısı ANLIK belirir (FE-810, FUEL-402.2)', async ({ page }) => {
  const RUN = Date.now();
  const plate = `34 FE810 ${String(RUN).slice(-4)}`;
  const homeSite = 'Gebze Ana Şantiye';
  const targetSite = `FE810Target-${RUN}`;
  const tankName = `FE810Tank-${RUN}`;
  const cardId = `FE810-CARD-${RUN}`;
  const driverName = `FE810 Sürücü ${RUN}`;
  const permId = `csp-fe810-${RUN}`;
  const deviceId = `FE810-DEV-${RUN}`;
  const owner = await apiLogin('camsa');

  try {
    // Ön koşul: zaten TÜKENMİŞ bir çapraz şantiye izni (allowed=used=10) —
    // tek bir istek bile ANINDA QUOTA_EXHAUSTED almalı, yarış koşuluna gerek yok.
    psql(`INSERT INTO vehicles (id, tenant_id, plate, brand_model, vehicle_type, rfid_tag, site_name, status, fuel_capacity_liters, assigned_driver_name)
          VALUES ('veh-fe810-${RUN}', 'comp-camsa', '${plate}', 'Test', 'Kamyon', 'RFID-FE810-${RUN}', '${homeSite}', 'AKTİF', 20, '${driverName}')`);
    psql(`INSERT INTO drivers (id, tenant_id, name, tc_no, rfid_card_id, site_name, status)
          VALUES ('drv-fe810-${RUN}', 'comp-camsa', '${driverName}', '12345678950', '${cardId}', '${homeSite}', 'AKTİF')`);
    psql(`INSERT INTO tanks (id, tenant_id, name, site_name, capacity_liters, current_level_liters, fuel_type)
          VALUES ('tank-fe810-${RUN}', 'comp-camsa', '${tankName}', '${targetSite}', 10000, 5000, 'Motorin')`);
    psql(`INSERT INTO cross_site_permissions (id, tenant_id, vehicle_plate, home_site, target_site, allowed_liters, used_liters, status, expiry_date)
          VALUES ('${permId}', 'comp-camsa', '${plate}', '${homeSite}', '${targetSite}', 10, 10, 'AKTİF', CURRENT_DATE + 7)`);

    const claimRes = await fetch(`${API_URL}/devices/claim-codes`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner}` },
      body: JSON.stringify({ siteName: targetSite, deviceName: `FE810 Test Pompa ${RUN}` })
    });
    const code = (await claimRes.json())?.data?.code;
    if (!code) throw new Error('claim kodu üretilemedi');
    const claimedRes = await fetch(`${API_URL}/devices/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, deviceId }) });
    const secret = (await claimedRes.json())?.data?.secret;
    if (!secret) throw new Error('cihaz claim edilemedi');

    // Panel ÖNCE açık + canlı bağlantı kurulu olmalı ki olay kaçırılmasın.
    await loginCompanyUser(page, 'camsa');
    await page.waitForFunction(() => document.documentElement.dataset.socket === 'connected', { timeout: 15_000 });
    await expect(page.getByTestId('quota-exhausted-alert')).toHaveCount(0);

    // Reddedilecek tek istek — HMAC'li donanım çağrısı doğrudan Node'dan.
    const rawBody = JSON.stringify({ rfidCardId: cardId, tankName });
    const timestamp = Date.now().toString();
    const nonce = crypto.randomBytes(16).toString('hex');
    const dispenseRes = await fetch(`${API_URL}/dispense/request-auth`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-ID': deviceId,
        'X-Timestamp': timestamp,
        'X-Nonce': nonce,
        'X-Hardware-Signature': sign(secret, timestamp, nonce, rawBody)
      },
      body: rawBody
    });
    expect(dispenseRes.status).toBe(409);
    expect((await dispenseRes.json())?.details?.error).toBe('QUOTA_EXHAUSTED');

    // ASIL AC: panelde SOL ÜSTTE anlık uyarı kartı belirir (RfidUnmatchedAlerts İLE AYNI desen, QuotaExhaustedAlerts).
    const alert = page.getByTestId('quota-exhausted-alert').filter({ hasText: plate });
    await expect(alert).toBeVisible({ timeout: 10_000 });
    await expect(alert).toContainText(targetSite);
    await expect(alert).toContainText('10 / 10');

    await alert.getByTestId('quota-exhausted-alert-dismiss').click();
    await expect(page.getByTestId('quota-exhausted-alert').filter({ hasText: plate })).toHaveCount(0);
  } finally {
    psql(`DELETE FROM hardware_devices WHERE device_id = '${deviceId}'`);
    psql(`DELETE FROM cross_site_denials WHERE vehicle_plate = '${plate}'`);
    psql(`DELETE FROM cross_site_permissions WHERE id = '${permId}'`);
    psql(`DELETE FROM tanks WHERE name = '${tankName}'`);
    psql(`DELETE FROM vehicles WHERE plate = '${plate}'`);
    psql(`DELETE FROM drivers WHERE rfid_card_id = '${cardId}'`);
    psql(`DELETE FROM device_claim_codes WHERE device_name LIKE 'FE810 Test Pompa ${RUN}%'`);
  }
});
