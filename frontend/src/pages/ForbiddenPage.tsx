import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';

export const ForbiddenPage: React.FC = () => {
  const navigate = useNavigate();
  const { isAuthenticated } = useApp();

  return (
    <div className="min-h-screen bg-[#131313] text-[#e5e2e1] flex flex-col items-center justify-center p-6 text-center select-none font-sans antialiased">
      <div className="max-w-md w-full bg-[#1c1b1b] border border-[#353535] p-8 rounded-3xl shadow-2xl space-y-6">

        {/* 403 Icon & Badge */}
        <div className="w-20 h-20 rounded-2xl bg-[#ffb4ab]/10 border border-[#ffb4ab]/30 text-[#ffb4ab] flex items-center justify-center mx-auto shadow-inner">
          <span className="material-symbols-outlined text-4xl">gpp_bad</span>
        </div>

        <div className="space-y-2">
          <span className="text-xs font-mono font-bold text-[#ffb4ab] uppercase tracking-widest bg-[#20201f] px-3 py-1 rounded-full border border-[#353535]">
            403 FORBIDDEN
          </span>
          <h1 className="text-2xl font-black text-[#e5e2e1] uppercase tracking-wider">
            Erişim Reddedildi
          </h1>
          <p className="text-xs text-[#d5c4ab] font-medium leading-relaxed">
            Bu sayfayı görüntülemek için gerekli yetkiye sahip değilsiniz. Hesabınızın rolü bu işlem için yeterli değil.
          </p>
        </div>

        {/* Action Button */}
        <button
          onClick={() => navigate(isAuthenticated ? '/panel' : '/')}
          className="w-full py-3 bg-gradient-to-r from-[#ffdca1] to-[#ffb77f] hover:from-[#ffe8c2] hover:to-[#ffc896] text-[#412d00] font-black rounded-xl text-xs uppercase tracking-wider transition-all shadow-md cursor-pointer flex items-center justify-center space-x-2"
        >
          <span className="material-symbols-outlined text-lg">
            {isAuthenticated ? 'dashboard' : 'arrow_back'}
          </span>
          <span>{isAuthenticated ? 'Yönetim Paneline Dön' : 'Giriş Sayfasına Dön'}</span>
        </button>

      </div>
    </div>
  );
};
