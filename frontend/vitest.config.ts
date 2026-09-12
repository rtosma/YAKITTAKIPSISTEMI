import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * TEST_PLAN.md §3.1 — Frontend test altyapısı.
 *
 * Neden AYRI bir dosya (vite.config.ts'e `test` alanı eklemek yerine):
 * prod build yapılandırmasını test yapılandırmasıyla karıştırmamak için.
 * Vitest bu dosyayı vite.config.ts'e tercih eder; proje '@/' alias'ı
 * KULLANMADIĞI için (tarandı, sıfır kullanım) burada yol eşlemesi
 * tekrarlanmıyor — yani iki config'in birbirinden sapma riski yok.
 *
 * Kapsam bilinçli olarak dar: yeni bir test framework'ü "kurmuş olmak" için
 * değil, güvenlik açısından kritik istemci mantığını (token yenileme
 * zinciri, oturum düşürme) doğrulamak için var.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // node_modules ve build çıktısı taranmasın
    exclude: ['node_modules/**', 'dist/**']
  }
});
