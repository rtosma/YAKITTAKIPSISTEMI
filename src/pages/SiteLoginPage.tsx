import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useApp } from '../context/AppContext';

export const SiteLoginPage: React.FC = () => {
  const navigate = useNavigate();
  const { loginSiteOperator } = useApp();

  const [username, setUsername] = useState<string>('gebze-santiye');
  const [password, setPassword] = useState<string>('123456');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!username.trim()) {
      setErrorMessage('Lütfen şantiye kullanıcı adını giriniz.');
      return;
    }

    if (!password.trim()) {
      setErrorMessage('Lütfen şantiye şifresini giriniz.');
      return;
    }

    setIsLoading(true);

    setTimeout(() => {
      const result = loginSiteOperator(username, password);
      setIsLoading(false);

      if (result.success) {
        navigate('/panel');
      } else {
        setErrorMessage(result.error || 'Şantiye girişi yapılırken bir hata oluştu.');
      }
    }, 400);
  };

  return (
    <div className="min-h-screen bg-[#131313] text-[#e5e2e1] flex flex-col justify-between p-6 md:p-12 font-sans antialiased">

      {/* Brand Header */}
      <header className="flex items-center justify-between border-b border-[#353535] pb-6 max-w-6xl w-full mx-auto select-none">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-[#a1e8a2] text-[#0d3811] flex items-center justify-center font-black shadow">
            <span className="material-symbols-outlined text-2xl font-bold">construction</span>
          </div>
          <div>
            <h1 className="font-extrabold text-[#e5e2e1] text-base tracking-widest uppercase">
              AKILLI ŞANTİYE
            </h1>
            <p className="text-xs text-[#d5c4ab] font-medium">Saha Operatörü & Pompa İkmal Girişi</p>
          </div>
        </div>

        <div className="flex items-center space-x-2 text-xs font-mono text-[#a1e8a2] bg-[#1c1b1b] border border-[#353535] px-3.5 py-1.5 rounded-full">
          <span className="w-2 h-2 rounded-full bg-[#a1e8a2] animate-pulse"></span>
          <span>SAHA MODU (ONLINE)</span>
        </div>
      </header>

      {/* Main Login Card Area */}
      <main className="max-w-md w-full mx-auto my-12">
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="bg-[#1c1b1b] border border-[#353535] rounded-3xl p-8 shadow-2xl space-y-6 relative overflow-hidden"
        >
          {/* Accent Top Border Glow */}
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-transparent via-[#a1e8a2] to-transparent opacity-80" />

          {/* Form Title & Icon */}
          <div className="text-center space-y-2 select-none">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-[#a1e8a2]/10 border border-[#a1e8a2]/30 text-[#a1e8a2] mb-2">
              <span className="material-symbols-outlined text-3xl">local_gas_station</span>
            </div>
            <span className="block text-[10px] font-mono font-bold uppercase tracking-widest text-[#a1e8a2]">
              SAHA PERSONELİ GİRİŞİ
            </span>
            <h2 className="text-2xl font-extrabold text-[#e5e2e1] tracking-tight">
              Şantiye Saha Girişi
            </h2>
            <p className="text-xs text-[#d5c4ab]">
              Firmanızın şantiyeniz için tanımladığı saha kullanıcı adı ve şifresini girin.
            </p>
          </div>

          {/* Error Alert Box */}
          {errorMessage && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="bg-[#ffb4ab]/10 border border-[#ffb4ab]/30 p-3.5 rounded-xl flex items-start space-x-3 text-xs text-[#ffb4ab]"
            >
              <span className="material-symbols-outlined text-lg shrink-0 mt-0.5">error</span>
              <span>{errorMessage}</span>
            </motion.div>
          )}

          {/* Site Login Form */}
          <form onSubmit={handleSubmit} className="space-y-4">

            {/* Username Input */}
            <div className="space-y-1.5">
              <label className="text-xs font-bold text-[#d5c4ab] block">
                Şantiye Kullanıcı Adı / Kod
              </label>
              <div className="relative">
                <span className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-[#d5c4ab] text-lg pointer-events-none">
                  badge
                </span>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Şantiye Adı"
                  className="w-full pl-11 pr-4 py-3 bg-[#20201f] border border-[#353535] focus:border-[#a1e8a2] focus:ring-1 focus:ring-[#a1e8a2] rounded-xl text-xs font-semibold text-[#e5e2e1] placeholder-[#d5c4ab]/40 outline-none transition-all"
                />
              </div>
            </div>

            {/* Password Input */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold text-[#d5c4ab]">
                  Şantiye Şifresi
                </label>
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="text-[11px] font-mono text-[#a1e8a2] hover:underline cursor-pointer"
                >
                  {showPassword ? 'Gizle' : 'Göster'}
                </button>
              </div>
              <div className="relative">
                <span className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-[#d5c4ab] text-lg pointer-events-none">
                  key
                </span>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full pl-11 pr-11 py-3 bg-[#20201f] border border-[#353535] focus:border-[#a1e8a2] focus:ring-1 focus:ring-[#a1e8a2] rounded-xl text-xs font-semibold text-[#e5e2e1] placeholder-[#d5c4ab]/40 outline-none transition-all"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[#d5c4ab] hover:text-[#e5e2e1] transition-colors cursor-pointer"
                >
                  <span className="material-symbols-outlined text-lg">
                    {showPassword ? 'visibility_off' : 'visibility'}
                  </span>
                </button>
              </div>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-3.5 px-4 bg-[#a1e8a2] hover:bg-[#bbf4bd] active:scale-[0.99] text-[#0d3811] font-extrabold rounded-xl text-xs flex items-center justify-center space-x-2 transition-all shadow-lg cursor-pointer disabled:opacity-50"
            >
              {isLoading ? (
                <>
                  <span className="w-4 h-4 border-2 border-[#0d3811] border-t-transparent rounded-full animate-spin"></span>
                  <span>Şantiye Paneline Bağlanılıyor...</span>
                </>
              ) : (
                <>
                  <span>Şantiye Saha Paneline Giriş Yap</span>
                  <span className="material-symbols-outlined text-base">arrow_forward</span>
                </>
              )}
            </button>

          </form>

          {/* Navigation links back */}
          <div className="pt-4 border-t border-[#353535] flex flex-col space-y-2 text-center select-none">
            <button
              type="button"
              onClick={() => navigate('/login')}
              className="text-xs font-semibold text-[#ffdca1] hover:underline flex items-center justify-center space-x-1.5 cursor-pointer"
            >
              <span className="material-symbols-outlined text-sm">storefront</span>
              <span>Firma Kurumsal Girişine Dön</span>
            </button>
          </div>

        </motion.div>
      </main>

      {/* Footer */}
      <footer className="text-center text-xs text-[#d5c4ab]/60 font-mono max-w-6xl w-full mx-auto pt-6 border-t border-[#353535] select-none">
        Akıllı Şantiye IoT Otomasyon Sistemleri © 2026 — Endüstriyel B2B Yakıt Takip Mimarisi
      </footer>

    </div>
  );
};
