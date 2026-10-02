import React from 'react';
import { classifyError } from '../utils/errorMessages';

/**
 * FE-817 — ağ/yetki/sunucu hatası için AYRI mesajlar + "yeniden deneme
 * düğmeleri" (bkz. utils/errorMessages.ts'in `classifyError`'ı). trace_id
 * (varsa) gösterilir — AC'nin kendisi değil ama destek sürecini kısaltan
 * aynı RES-907 kimliği, bu sefer her sayfanın kendi hata kutusunda da.
 */
interface ErrorStateProps {
  error: unknown;
  onRetry?: () => void;
  testId?: string;
}

export const ErrorState: React.FC<ErrorStateProps> = ({ error, onRetry, testId }) => {
  const classified = classifyError(error);
  return (
    <div data-testid={testId ?? 'error-state'} className="border border-[#ffb4ab]/40 bg-[#ffb4ab]/5 rounded-2xl p-6 flex flex-col items-center text-center gap-3">
      <span className="material-symbols-outlined text-2xl text-[#ffb4ab]">error</span>
      <div className="space-y-1">
        <p className="text-sm font-bold text-[#ffb4ab]">{classified.title}</p>
        <p className="text-xs text-[#d5c4ab]">{classified.message}</p>
        {classified.traceId && (
          <p className="text-[10px] font-mono text-[#8a8580] mt-1">
            Destek kodu: <span data-testid="error-state-trace-id">{classified.traceId}</span>
          </p>
        )}
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          data-testid={`${testId ?? 'error-state'}-retry`}
          className="px-4 py-2 bg-[#20201f] text-[#e5e2e1] rounded-xl text-xs font-bold hover:bg-[#282726]"
        >
          Tekrar Dene
        </button>
      )}
    </div>
  );
};
