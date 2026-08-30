import React from 'react';
import { useApp } from '../context/AppContext';

export const Toast: React.FC = () => {
  const { toast } = useApp();

  if (!toast) return null;

  const bgColors = {
    success: 'bg-[#1c1b1b] border-[#ffdca1] text-[#ffdca1]',
    info: 'bg-[#1c1b1b] border-[#ffb77f] text-[#ffb77f]',
    warning: 'bg-[#1c1b1b] border-[#ffb77f] text-[#ffb77f]',
    error: 'bg-[#1c1b1b] border-[#ffb4ab] text-[#ffb4ab]',
  };

  const icons = {
    success: 'check_circle',
    info: 'info',
    warning: 'warning',
    error: 'error',
  };

  return (
    <div className="fixed bottom-6 right-6 z-50 animate-bounce-short">
      <div className={`flex items-center space-x-3 px-4 py-3 rounded-xl border shadow-2xl ${bgColors[toast.type]} font-mono text-xs font-bold`}>
        <span className="material-symbols-outlined text-lg">{icons[toast.type]}</span>
        <span>{toast.message}</span>
      </div>
    </div>
  );
};
