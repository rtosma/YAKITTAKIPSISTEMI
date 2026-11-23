import React from 'react';

/**
 * FE-817 — "Boş durum ekranı 'Kayıt bulunamadı' demekle kalmamalı, 'İlk
 * aracınızı ekleyin' gibi eylem önermelidir." Önceden her liste sayfası
 * kendi tek-satırlık genel metnini (örn. "Kayıtlı araç bulunamadı.")
 * tekrar tekrar yazıyordu, hiçbiri bir eylem önermiyordu (tek kısmi
 * istisna DeviceManagementPage'in cihaz listesiydi) — bu, o metinlerin
 * yerini alan paylaşılan, eylem önerebilen tek bileşen.
 */
interface EmptyStateProps {
  icon: string;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  testId?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ icon, title, description, actionLabel, onAction, testId }) => (
  <div
    data-testid={testId ?? 'empty-state'}
    className="border border-dashed border-[#353535] rounded-2xl p-10 flex flex-col items-center text-center gap-3"
  >
    <div className="w-12 h-12 rounded-full bg-[#20201f] border border-[#353535] text-[#d5c4ab] flex items-center justify-center">
      <span className="material-symbols-outlined text-2xl">{icon}</span>
    </div>
    <div className="space-y-1">
      <p className="text-sm font-bold text-[#e5e2e1]">{title}</p>
      {description && <p className="text-xs text-[#d5c4ab]">{description}</p>}
    </div>
    {actionLabel && onAction && (
      <button
        type="button"
        onClick={onAction}
        data-testid={`${testId ?? 'empty-state'}-action`}
        className="mt-2 px-4 py-2 bg-[#ffdca1] text-[#412d00] rounded-xl text-xs font-black hover:bg-[#ffe5b9]"
      >
        {actionLabel}
      </button>
    )}
  </div>
);
