import React from 'react';

/**
 * FE-817 — "Skeleton, içeriğin gerçek düzenine benzemelidir; genel spinner
 * kullanıcıyı yormaz ama bilgi de vermez." Önceden bu kod tabanında
 * HİÇBİR skeleton/shimmer bileşeni yoktu (grep "skeleton" → sıfır sonuç;
 * tek `animate-pulse` kullanımları durum noktaları/QR görseli gibi
 * tamamen İLİŞKİSİZ yerlerdeydi) — tüm liste/tablo yüklemeleri ya düz
 * "Yükleniyor…" metni ya da hiçbir şey gösteriyordu.
 */
interface ListSkeletonProps {
  rows?: number;
  columns?: number;
  variant?: 'table' | 'cards';
  testId?: string;
}

export const ListSkeleton: React.FC<ListSkeletonProps> = ({ rows = 5, columns = 4, variant = 'table', testId }) => {
  if (variant === 'cards') {
    return (
      <div data-testid={testId ?? 'list-skeleton'} className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-5 space-y-3 animate-pulse">
            <div className="h-4 bg-[#282726] rounded w-2/3" />
            <div className="h-3 bg-[#282726] rounded w-full" />
            <div className="h-3 bg-[#282726] rounded w-1/2" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div data-testid={testId ?? 'list-skeleton'} className="space-y-2">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 bg-[#1c1b1b] border border-[#353535] rounded-xl p-3 animate-pulse">
          {Array.from({ length: columns }).map((_, c) => (
            <div key={c} className="h-3 bg-[#282726] rounded flex-1" style={{ maxWidth: c === 0 ? '18%' : undefined }} />
          ))}
        </div>
      ))}
    </div>
  );
};
