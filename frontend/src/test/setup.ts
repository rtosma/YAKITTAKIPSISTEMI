import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

/**
 * TEST_PLAN.md §3.1 — her test dosyası için ortak kurulum.
 *
 * Testler arası SIZINTI bu projede özellikle tehlikeli: test edilen mantığın
 * büyük kısmı localStorage (token'lar) ve `window` olayları üzerinden
 * çalışıyor. Bir testten kalan token ya da dinleyici, bir sonraki testi
 * sahte biçimde geçirebilir (false positive) — bu yüzden her testten önce
 * localStorage tamamen temizlenir, her testten sonra React ağacı sökülür ve
 * tüm mock'lar sıfırlanır.
 */
beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});
