import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * TEST_PLAN.md §3.1 — Frontend test altyapısı. TEST-1006: coverage eşiği + ortak test fabrikaları (`@test-support`, repo kökündeki test-support/).
 *
 * Neden AYRI bir dosya (vite.config.ts'e `test` alanı eklemek yerine): prod build yapılandırmasını test yapılandırmasıyla karıştırmamak için.
 *
 * COVERAGE — "tüm koda aynı eşik anlamsızdır": arayüzde (sayfa/bileşen) eşik DÜŞÜK, mantık modüllerinde YÜKSEK:
 *   - Genel (tüm src): %20 — arayüz kodu çoğunlukla Playwright e2e ile sınanır; bu taban yalnızca çöküşü (testlerin silinmesi/bozulması) yakalar.
 *     Ölçüm anındaki gerçek değer ≈ %24; taban geliştikçe YÜKSELTİLİR (asla düşürülmez).
 *   - Mantık modülleri (api istemcisi, yetki matrisi, doğrulama, Sentry): dosya başına %70+ (satır/ifade), dal %70.
 * Backend eşikleri: backend/vitest.config.ts (hesap motorlarında %90).
 */
const LOGIC_FILES = ['src/utils/api.ts', 'src/utils/permissions.ts', 'src/utils/validation.ts', 'src/utils/sentry.ts'];

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@test-support': fileURLToPath(new URL('../test-support', import.meta.url)) } },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // node_modules ve build çıktısı taranmasın
    exclude: ['node_modules/**', 'dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/mock/**', 'src/types/**', 'src/types.ts', 'src/main.tsx', 'src/vite-env.d.ts'],
      thresholds: {
        lines: 20, statements: 20, functions: 10, branches: 15,
        ...Object.fromEntries(LOGIC_FILES.map((f) => [f, { lines: 70, statements: 70, functions: 60, branches: 70 }]))
      }
    }
  }
});
