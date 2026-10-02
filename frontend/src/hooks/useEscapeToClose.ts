import { useEffect } from 'react';

/**
 * FE-818 — WCAG 2.1.2/4.1.2. Önceden bu kod tabanındaki 29 modalin HİÇBİRİNDE
 * Escape ile kapatma, `role="dialog"`/`aria-modal` yoktu (araştırıldı, grep
 * ile doğrulandı) — klavye kullanıcısı bir modalden çıkmak için yalnızca
 * (eğer varsa) bir "İptal"/"Kapat" butonuna Tab ile ulaşabiliyordu. Tam bir
 * odak tuzağı (focus trap) bu ticket'ın kapsamı dışında bırakıldı (her
 * modal kendi DOM sırasını koruyor, arka plan hâlâ Tab ile erişilebilir) —
 * ama Escape-ile-kapatma, en az efor/en çok kazanım oranına sahip, AC'nin
 * "etkileşimli öğeler klavye ile erişilebilir olmalı" kısmını karşılayan
 * gerçek bir iyileştirme.
 */
export function useEscapeToClose(onClose: (() => void) | undefined, enabled = true): void {
  useEffect(() => {
    if (!enabled || !onClose) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose, enabled]);
}
