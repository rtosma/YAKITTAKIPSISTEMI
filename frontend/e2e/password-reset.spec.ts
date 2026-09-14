import { expect, test } from '@playwright/test';
import { getPasswordResetToken, resetLoginRateLimit, resetPasswordResetRateLimit } from './helpers';

/**
 * FE-804 — Parola Sıfırlama E2E (AUTH-206 backend'i zaten hazır).
 *
 * Bu dosya birim testlerin (PasswordResetPages.test.tsx — apiFetch
 * mock'lu) YAKALAYAMADIĞI şeyi test eder: gerçek backend'in ürettiği
 * bir token'ın, gerçek bir HTTP round-trip üzerinden, gerçek parolayı
 * GERÇEKTEN değiştirdiğini ve eski parolanın artık ÇALIŞMADIĞINI.
 *
 * Bu ortamda docker-compose.yml backend'e NODE_ENV=production verdiğinden
 * forgot-password yanıtı `devResetToken` DÖNDÜRMEZ (route seviyesi sızıntı
 * koruması — bkz. routes.ts). Bu yüzden:
 *  1) "Parolamı Unuttum" formu GERÇEK HTTP isteğiyle test edilir (jenerik
 *     başarı mesajı, devResetToken kısayolunun GÖRÜNMEDİĞİ doğrulanır).
 *  2) Asıl sıfırlama adımı için geçerli bir token, backend'in KENDİ
 *     `test_auth206_password_reset.ts` testiyle AYNI desenle — servis
 *     fonksiyonu (`requestPasswordReset`) route'u atlayarak doğrudan
 *     çağrılıp — elde edilir (bkz. helpers.ts `getPasswordResetToken`).
 *     ForgotPasswordPage'in devResetToken varken kısayolu GÖSTERMESİ ayrıca
 *     PasswordResetPages.test.tsx'te (mock'lu) zaten doğrulanıyor.
 *
 * forgot-password KENDİ ayrı rate limitine sahip (1/dk + 5/saat, kullanıcı
 * adına göre anahtarlanır) — `resetLoginRateLimit()` bunu SIFIRLAMAZ (ayrı
 * Redis anahtar öneki), bu yüzden `resetPasswordResetRateLimit()` de ayrıca
 * çağrılıyor (bkz. helpers.ts).
 */
test.beforeEach(() => {
  resetLoginRateLimit();
  resetPasswordResetRateLimit();
});

// TEST_PLAN §0.3 ile AYNI gerekçe — paylaşımlı seed hesaplarının parolasını
// DEĞİŞTİRMEK diğer testleri kırar. Bu yüzden test doğrudan mevcut bir SEED
// kullanıcısının parolasını sıfırlayıp SONRA testin KENDİ İÇİNDE eski
// haline (123456) GERİ döndürür (finally bloğu — test_auth206'daki AYNI desen).
const SEED_USER = 'avrasya';
const ORIGINAL_PASSWORD = '123456';
const NEW_PASSWORD = 'e2eYeniParola456';

test.describe('Parola Sıfırlama Akışı', () => {
  test('"Parolamı Unuttum" formu gerçek backend ile jenerik başarı mesajı döner (enumeration koruması)', async ({ page }) => {
    await page.goto('/login');
    await page.click('text=Parolamı Unuttum');
    await expect(page).toHaveURL(/\/parola-unuttum/);

    await page.fill('input[placeholder="Kullanıcı Adı"]', SEED_USER);
    await page.click('button:has-text("Sıfırlama Talebi Gönder")');
    await expect(page.getByText(/Eğer bu kullanıcı adı sistemde kayıtlıysa/i)).toBeVisible();

    // Bu ortamda (NODE_ENV=production) devResetToken dönmez → kısayol YOK.
    await expect(page.getByRole('button', { name: /Sıfırlama Bağlantısına Git/i })).toHaveCount(0);

    // Var olmayan bir kullanıcı için de AYNI mesaj (numaralandırma sızdırmaz).
    // Başarı ekranı formu gizlediğinden, ikinci deneme için ekrana yeniden gidilir.
    await page.goto('/parola-unuttum');
    await page.fill('input[placeholder="Kullanıcı Adı"]', 'boyle-bir-kullanici-yok-12345');
    await page.click('button:has-text("Sıfırlama Talebi Gönder")');
    await expect(page.getByText(/Eğer bu kullanıcı adı sistemde kayıtlıysa/i)).toBeVisible();
  });

  test('geçerli token ile yeni parola belirle → yeni parolayla giriş çalışır, eski parola ARTIK ÇALIŞMAZ', async ({ page }) => {
    try {
      const token = getPasswordResetToken(SEED_USER);

      // --- Yeni parola belirle ---
      await page.goto(`/parola-sifirla/${token}`);
      await page.fill('input[placeholder="En az 8 karakter"]', NEW_PASSWORD);
      await page.fill('input[placeholder="••••••••"]', NEW_PASSWORD);
      await page.click('button:has-text("Parolayı Güncelle")');

      // --- /login?reset=success'e yönlendirilir, otomatik giriş YAPILMAZ ---
      await expect(page).toHaveURL(/\/login\?reset=success/);
      await expect(page.getByText(/Parolanız güncellendi/i)).toBeVisible();

      // --- ESKİ parola artık ÇALIŞMAZ (tüm oturumlar/kimlik bilgisi güncellendi) ---
      await page.fill('input[placeholder="Firma Adı"]', SEED_USER);
      await page.fill('input[type="password"]', ORIGINAL_PASSWORD);
      await page.click('button[type="submit"]');
      await expect(page.getByText(/hatalı|geçersiz|başarısız/i)).toBeVisible({ timeout: 10_000 });

      // --- YENİ parolayla giriş BAŞARILI ---
      await page.fill('input[placeholder="Firma Adı"]', SEED_USER);
      await page.fill('input[type="password"]', NEW_PASSWORD);
      await page.click('button[type="submit"]');
      await page.waitForURL(/\/(panel|admin)/, { timeout: 15_000 });
    } finally {
      // Paylaşımlı seed hesabını AYNI mekanizmayla eski parolasına geri
      // döndür — diğer testler 123456 bekliyor.
      const revertToken = getPasswordResetToken(SEED_USER);
      await page.goto(`/parola-sifirla/${revertToken}`);
      await page.fill('input[placeholder="En az 8 karakter"]', ORIGINAL_PASSWORD);
      await page.fill('input[placeholder="••••••••"]', ORIGINAL_PASSWORD);
      await page.click('button:has-text("Parolayı Güncelle")').catch(() => {});
    }
  });

  test('geçersiz sıfırlama bağlantısıyla açılınca formu göstermez, jenerik hata verir', async ({ page }) => {
    await page.goto('/parola-sifirla/gecersiz-token-1234');
    await expect(page.getByText(/Sıfırlama bağlantısı geçersiz veya eksik/i)).toBeVisible();
    await expect(page.locator('input[placeholder="En az 8 karakter"]')).toHaveCount(0);
  });
});
