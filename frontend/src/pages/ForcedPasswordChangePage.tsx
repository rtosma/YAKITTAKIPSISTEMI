import React, { useState } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../utils/api';

/**
 * AUTH-204/FE-804 — "İlk giriş zorunlu parola değiştirme ekranı."
 * Geçici bir parolayla giriş yapan kullanıcı (bkz. backend
 * createSiteWithManager) buraya yönlendirilir (route guard'ları:
 * CustomerLayout/DeveloperLayout/SiteOperatorPanel — mustChangePassword
 * true iken) ve parolasını değiştirmeden başka hiçbir sayfaya
 * gidemez (backend de aynı kısıtı authenticateJWT'de zorunlu kılıyor —
 * bu ekran yalnızca o zaten var olan sunucu tarafı kısıtın kullanıcı
 * arayüzü karşılığı).
 */
export const ForcedPasswordChangePage: React.FC = () => {
  const navigate = useNavigate();
  const { isAuthenticated, currentUser, completePasswordChange, logoutCompany } = useApp();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  if (currentUser && !currentUser.mustChangePassword) {
    // Parola zaten değiştirilmiş (örn. geri tuşu) — panele geri gönder.
    return <Navigate to={currentUser.role === 'SITE_MANAGER' ? '/santiye-panel' : currentUser.role === 'SUPER_ADMIN' ? '/admin' : '/panel'} replace />;
  }

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPasswords, setShowPasswords] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!currentPassword.trim()) {
      setErrorMessage('Geçici parolanızı girin.');
      return;
    }
    if (newPassword.length < 8) {
      setErrorMessage('Yeni parola en az 8 karakter olmalıdır.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setErrorMessage('Yeni parola ile tekrarı eşleşmiyor.');
      return;
    }
    if (newPassword === currentPassword) {
      setErrorMessage('Yeni parola, geçici parolanızla aynı olamaz.');
      return;
    }

    setIsLoading(true);
    try {
      const data = await apiFetch('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword })
      });
      completePasswordChange(data.accessToken, data.refreshToken);
      const target = currentUser?.role === 'SITE_MANAGER' ? '/santiye-panel' : currentUser?.role === 'SUPER_ADMIN' ? '/admin' : '/panel';
      navigate(target, { replace: true });
    } catch (err: any) {
      setErrorMessage(err.message || 'Parola değiştirilirken bir hata oluştu.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#131313] text-[#e5e2e1] flex items-center justify-center p-6 font-sans antialiased">
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="max-w-md w-full bg-[#1c1b1b] border border-[#353535] rounded-3xl p-8 shadow-2xl space-y-6 relative overflow-hidden"
      >
        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-transparent via-[#ffdca1] to-transparent opacity-80" />

        <div className="text-center space-y-2 select-none">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-[#ffdca1]/10 border border-[#ffdca1]/30 text-[#ffdca1] mb-2">
            <span className="material-symbols-outlined text-3xl">lock_reset</span>
          </div>
          <span className="block text-[10px] font-mono font-bold uppercase tracking-widest text-[#ffdca1]">
            İLK GİRİŞ — ZORUNLU PAROLA DEĞİŞTİRME
          </span>
          <h2 className="text-2xl font-extrabold text-[#e5e2e1] tracking-tight">
            Yeni Parolanızı Belirleyin
          </h2>
          <p className="text-xs text-[#d5c4ab]">
            Hesabınız geçici bir parolayla oluşturuldu. Devam etmeden önce
            kendi parolanızı belirlemeniz zorunludur.
          </p>
        </div>

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

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-bold text-[#d5c4ab] block">Geçici Parola</label>
            <input
              type={showPasswords ? 'text' : 'password'}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full px-4 py-3 bg-[#20201f] border border-[#353535] focus:border-[#ffdca1] focus:ring-1 focus:ring-[#ffdca1] rounded-xl text-xs font-semibold text-[#e5e2e1] placeholder-[#d5c4ab]/40 outline-none transition-all"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-[#d5c4ab]">Yeni Parola</label>
              <button
                type="button"
                onClick={() => setShowPasswords(!showPasswords)}
                className="text-[11px] font-mono text-[#ffdca1] hover:underline cursor-pointer"
              >
                {showPasswords ? 'Gizle' : 'Göster'}
              </button>
            </div>
            <input
              type={showPasswords ? 'text' : 'password'}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="En az 8 karakter"
              className="w-full px-4 py-3 bg-[#20201f] border border-[#353535] focus:border-[#ffdca1] focus:ring-1 focus:ring-[#ffdca1] rounded-xl text-xs font-semibold text-[#e5e2e1] placeholder-[#d5c4ab]/40 outline-none transition-all"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold text-[#d5c4ab] block">Yeni Parola (Tekrar)</label>
            <input
              type={showPasswords ? 'text' : 'password'}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full px-4 py-3 bg-[#20201f] border border-[#353535] focus:border-[#ffdca1] focus:ring-1 focus:ring-[#ffdca1] rounded-xl text-xs font-semibold text-[#e5e2e1] placeholder-[#d5c4ab]/40 outline-none transition-all"
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full py-3.5 px-4 bg-[#ffdca1] hover:bg-[#ffe5b8] active:scale-[0.99] text-[#412d00] font-extrabold rounded-xl text-xs flex items-center justify-center space-x-2 transition-all shadow-lg cursor-pointer disabled:opacity-50"
          >
            {isLoading ? (
              <>
                <span className="w-4 h-4 border-2 border-[#412d00] border-t-transparent rounded-full animate-spin"></span>
                <span>Güncelleniyor...</span>
              </>
            ) : (
              <>
                <span>Parolayı Güncelle ve Devam Et</span>
                <span className="material-symbols-outlined text-base">arrow_forward</span>
              </>
            )}
          </button>
        </form>

        <div className="pt-4 border-t border-[#353535] text-center">
          <button
            type="button"
            onClick={logoutCompany}
            className="text-xs font-semibold text-[#d5c4ab] hover:text-[#e5e2e1] hover:underline cursor-pointer"
          >
            Oturumu kapat
          </button>
        </div>
      </motion.div>
    </div>
  );
};
