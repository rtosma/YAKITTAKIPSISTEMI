import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * TEST-1006 — Backend BİRİM test altyapısı (vitest + v8 coverage).
 *
 * İKİ TEST KATMANI (karıştırmayın):
 *   backend/unit/**  → BİRİM testler (bu dosya): saf hesap/iş mantığı, DB/Redis/ağ YOK, saniyeler, paralel (vitest worker'ları).
 *   backend/test/**  → ENTEGRASYON testleri (tsx betikleri): gerçek Postgres/Redis/HTTP ister, ayrı CI işlerinde koşar; vitest DEĞİL.
 *
 * COVERAGE EŞİĞİ — "tüm koda aynı eşik anlamsızdır" (ticket notu): coverage yalnızca BİRİM-TEST KAPSAMINDAKİ modülleri ölçer
 * (`coverage.include`); DB'ye bağlı tenantDb.ts/routes.ts gibi dosyalar entegrasyon testleriyle kapsanır ve buraya KATILMAZ (katılsalar
 * %70 eşiği ya hiç tutmaz ya da anlamsız düşük tutulurdu). Eşikler iki katmanlı:
 *   - HESAP MOTORLARI (hacim/strapping, kota dönemi, sayaç doğrulama, yakıt tipi, maliyet, vergi no): satır/fonksiyon/dal/ifade %90.
 *   - KAPSAMDAKİ TÜM DOSYALAR: %70 (yardımcılar, KVKK maskeleme, hata sınıfları …).
 * Yeni bir saf modül eklenirse `UNIT_SCOPE`'a eklenir; scripts/test-test1006.mjs `fuel/` ve `fleet/` altındaki HER dosyanın kapsamda olduğunu
 * dayatır (yeni bir hesap motoru eşikten kaçamaz).
 */
export const ENGINE_FILES = [
  'src/fuel/tankVolume.ts',
  'src/fuel/quotaPeriod.ts',
  'src/fuel/fuelTypes.ts',
  'src/fuel/fuelCostService.ts',
  'src/fleet/meterValidation.ts',
  'src/compliance/taxIdValidation.ts',
  'src/compliance/gtip.ts'
];
export const OTHER_UNIT_FILES = [
  'src/privacy/piiScrub.ts',
  'src/privacy/piiPolicy.ts',
  'src/utils/redaction.ts',
  'src/utils/id.ts',
  'src/utils/errors.ts',
  'src/retention/retentionCatalog.ts'
];
export const UNIT_SCOPE = [...ENGINE_FILES, ...OTHER_UNIT_FILES];

// Saat diliminden bağımsız (geliştirici makinesi ile CI aynı sonucu versin).
process.env.TZ = 'UTC';

export default defineConfig({
  resolve: { alias: { '@test-support': fileURLToPath(new URL('../test-support', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['unit/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    // Paralel: her dosya kendi izole worker'ında (varsayılan pool) — testler global durumu paylaşmaz.
    isolate: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary', 'lcov'],
      reportsDirectory: './coverage',
      include: UNIT_SCOPE,
      thresholds: {
        // Kapsamdaki tüm dosyalar (genel)
        lines: 70, functions: 70, branches: 70, statements: 70,
        // Hesap motorları — glob eşiği: her dosya AYRI ayrı %90 (perFile)
        ...Object.fromEntries(ENGINE_FILES.map((f) => [f, { lines: 90, functions: 90, branches: 90, statements: 90 }]))
      }
    }
  }
});
