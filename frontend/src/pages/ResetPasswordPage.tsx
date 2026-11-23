import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { apiFetch } from '../utils/api';

// AUTH-206: requestPasswordReset randomBytes(32).toString('hex') → tam 64
// hex karakter. Backend'deki resetPasswordSchema (authSchema.ts) ile AYNI
// regex — burası yalnızca bariz bozuk bir bağlantıyı (kopyala/yapıştır
// hatası vb.) backend'e hiç gitmeden erken yakalamak için, asıl doğrulama
// (token gerçekten geçerli mi/süresi dolmuş mu) her zaman backend'de.
const TOKEN_REGEX = /^[0-9a-fA-F]{64}$/;

/**
 * FE-804 — Yeni Parola Belirleme (AUTH-206 backend'i zaten hazır: POST
 * /auth/reset-password). Token URL'den (/parola-sifirla/:token) okunur.
 * Başarıda kullanıcının TÜM oturumları backend tarafından düşürülür — bu
 * yüzden burada da otomatik giriş YAPILMAZ, kullanıcı bilerek yeni
 * parolasıyla tekrar giriş yapmalı (/login?reset=success ile küçük bir
 * onay mesajı gösterilir).
 */
export const ResetPasswordPage: React.FC = () => {
  const navigate = useNavigate();
  const { token } = useParams<{ token: string }>();

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const tokenValid = !!token && TOKEN_REGEX.test(token);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!tokenValid) {
      setErrorMessage('Sıfırlama bağlantısı geçersiz. Lütfen yeni bir talep oluşturun.');
      return;
    }
    if (newPassword.length < 8) {
      setErrorMessage('Yeni parola en az 8 karakter olmalıdır.');
      return;
    }
    if (newPassword.length > 128) {
      setErrorMessage('Yeni parola en fazla 128 karakter olabilir.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setErrorMessage('Yeni parola ile tekrarı eşleşmiyor.');
      return;
    }

    setIsLoading(true);
    try {
      await apiFetch('/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token, newPassword })
      });
      navigate('/login?reset=success', { replace: true });
    } catch (err: any) {
      // Backend geçersiz/kullanılmış/süresi dolmuş token için jenerik bir
      // 400 döner (hangisi olduğunu sızdırmaz) — mesaj olduğu gibi gösterilir.
      setErrorMessage(err.message || 'Parola sıfırlanırken bir hata oluştu. Lütfen tekrar deneyin.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#131313] text-[#e5e2e1] flex flex-col justify-between p-6 md:p-12 font-sans antialiased">
      <header className="flex items-center justify-between border-b border-[#353535] pb-6 max-w-6xl w-full mx-auto select-none">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-[#ffdca1] text-[#412d00] flex items-center justify-center font-black shadow">
            <span className="material-symbols-outlined text-2xl font-bold">local_gas_station</span>
          </div>
          <div>
            <h1 className="font-extrabold text-[#e5e2e1] text-base tracking-widest uppercase">AKILLI ŞANTİYE</h1>
            <p className="text-xs text-[#d5c4ab] font-medium">IoT Yakıt Takip & Şantiye Otomasyon Platformu</p>
          </div>
        </div>
      </header>

      <main className="max-w-md w-full mx-auto my-12">
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="bg-[#1c1b1b] border border-[#353535] rounded-3xl p-8 shadow-2xl space-y-6 relative overflow-hidden"
        >
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-transparent via-[#ffdca1] to-transparent opacity-80" />

          <div className="text-center space-y-2 select-none">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-[#ffdca1]/10 border border-[#ffdca1]/30 text-[#ffdca1] mb-2">
              <span className="material-symbols-outlined text-3xl">lock_reset</span>
            </div>
            <span className="block text-[10px] font-mono font-bold uppercase tracking-widest text-[#ffdca1]">PAROLA SIFIRLAMA</span>
            <h2 className="text-2xl font-extrabold text-[#e5e2e1] tracking-tight">Yeni Parola Belirle</h2>
            <p className="text-xs text-[#d5c4ab]">Hesabınız için yeni bir parola belirleyin.</p>
          </div>

          {!tokenValid && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="bg-[#ffb4ab]/10 border border-[#ffb4ab]/30 p-3.5 rounded-xl flex items-start space-x-3 text-xs text-[#ffb4ab]"
            >
              <span className="material-symbols-outlined text-lg shrink-0 mt-0.5">error</span>
              <span>Sıfırlama bağlantısı geçersiz veya eksik. Lütfen "Parolamı Unuttum" ekranından yeni bir talep oluşturun.</span>
            </motion.div>
          )}

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

          {tokenValid && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold text-[#d5c4ab]">Yeni Parola</label>
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="text-[11px] font-mono text-[#ffdca1] hover:underline cursor-pointer"
                  >
                    {showPassword ? 'Gizle' : 'Göster'}
                  </button>
                </div>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="En az 8 karakter"
                  className="w-full px-4 py-3 bg-[#20201f] border border-[#353535] focus:border-[#ffdca1] focus:ring-1 focus:ring-[#ffdca1] rounded-xl text-xs font-semibold text-[#e5e2e1] placeholder-[#d5c4ab]/40 outline-none transition-all"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-bold text-[#d5c4ab] block">Yeni Parola (Tekrar)</label>
                <input
                  type={showPassword ? 'text' : 'password'}
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
                    <span>Parolayı Güncelle</span>
                    <span className="material-symbols-outlined text-base">arrow_forward</span>
                  </>
                )}
              </button>
            </form>
          )}

          <div className="pt-4 border-t border-[#353535] text-center select-none">
            <button
              type="button"
              onClick={() => navigate('/parola-unuttum')}
              className="text-xs font-semibold text-[#ffdca1] hover:underline cursor-pointer"
            >
              Yeni bir sıfırlama bağlantısı iste
            </button>
          </div>
        </motion.div>
      </main>

      <footer className="text-center text-xs text-[#d5c4ab]/60 font-mono max-w-6xl w-full mx-auto pt-6 border-t border-[#353535] select-none">
        Akıllı Şantiye IoT Otomasyon Sistemleri © 2026 — Endüstriyel B2B Yakıt Takip Mimarisi
      </footer>
    </div>
  );
};
