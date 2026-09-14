import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { apiFetch } from '../utils/api';

/**
 * FE-804 — Şifre Sıfırlama Talebi (AUTH-206 backend'i zaten hazır: POST
 * /auth/forgot-password). Backend enumeration korumasından dolayı
 * kullanıcı var/yok fark etmeksizin HER ZAMAN aynı 200 + jenerik mesajı
 * döner — bu ekran da AYNI mesajı, isteğin başarılı olup olmadığından
 * bağımsız olarak gösterir; "bu kullanıcı adı yok" gibi FARKLI bir mesaj
 * ASLA gösterilmez (backend'in koruduğu şeyi frontend'de bozmamak için).
 *
 * `devResetToken` yalnızca üretim-DIŞI ortamda (#159 — gerçek e-posta/SMS
 * iletimi henüz yok) yanıtta döner; geldiğinde doğrudan sıfırlama
 * ekranına geçen bir kısayol gösterilir (manuel/E2E test kolaylığı).
 */
export const ForgotPasswordPage: React.FC = () => {
  const navigate = useNavigate();

  const [username, setUsername] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [devResetToken, setDevResetToken] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!username.trim()) {
      setErrorMessage('Lütfen kullanıcı adınızı giriniz.');
      return;
    }

    setIsLoading(true);
    try {
      const data = await apiFetch('/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ username: username.trim() })
      });
      setSubmitted(true);
      setDevResetToken(data?.devResetToken ?? null);
    } catch (err: any) {
      // Yalnızca rate limit (429) gibi gerçek bir HATA burada gösterilir —
      // "kullanıcı bulunamadı" mesajı backend'den ZATEN gelmiyor.
      setErrorMessage(err.message || 'İstek gönderilirken bir hata oluştu. Lütfen tekrar deneyin.');
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
              <span className="material-symbols-outlined text-3xl">mail_lock</span>
            </div>
            <span className="block text-[10px] font-mono font-bold uppercase tracking-widest text-[#ffdca1]">PAROLA SIFIRLAMA</span>
            <h2 className="text-2xl font-extrabold text-[#e5e2e1] tracking-tight">Parolamı Unuttum</h2>
            <p className="text-xs text-[#d5c4ab]">
              Kullanıcı adınızı girin, sıfırlama talimatlarını ilgili kanaldan ileteceğiz.
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

          {submitted ? (
            <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="space-y-4">
              <div className="bg-[#a1e8a2]/10 border border-[#a1e8a2]/30 p-4 rounded-xl flex items-start space-x-3 text-xs text-[#a1e8a2]">
                <span className="material-symbols-outlined text-lg shrink-0 mt-0.5">check_circle</span>
                <span>
                  Eğer bu kullanıcı adı sistemde kayıtlıysa, şifre sıfırlama talimatları ilgili kanaldan iletildi.
                  30 dakika içinde işlemi tamamlamanız gerekiyor.
                </span>
              </div>

              {devResetToken && (
                <div className="bg-[#20201f] border border-dashed border-[#ffb77f]/50 p-4 rounded-xl space-y-2">
                  <p className="text-[10px] font-mono font-bold uppercase tracking-widest text-[#ffb77f]">
                    Geliştirme Modu (e-posta/SMS entegrasyonu henüz yok)
                  </p>
                  <button
                    type="button"
                    onClick={() => navigate(`/parola-sifirla/${devResetToken}`)}
                    className="w-full py-3 px-4 bg-[#ffb77f]/10 hover:bg-[#ffb77f]/20 border border-[#ffb77f]/40 text-[#ffb77f] font-bold rounded-xl text-xs flex items-center justify-center space-x-2 transition-all cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-base">key</span>
                    <span>Sıfırlama Bağlantısına Git (Test)</span>
                  </button>
                </div>
              )}

              <button
                type="button"
                onClick={() => navigate('/login')}
                className="w-full py-3 px-4 bg-[#20201f] hover:bg-[#282726] border border-[#353535] text-[#e5e2e1] font-bold rounded-xl text-xs flex items-center justify-center space-x-2 transition-all cursor-pointer"
              >
                <span>Giriş Ekranına Dön</span>
              </button>
            </motion.div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-[#d5c4ab] block">Kullanıcı Adı</label>
                <div className="relative">
                  <span className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-[#d5c4ab] text-lg pointer-events-none">
                    person
                  </span>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="Kullanıcı Adı"
                    className="w-full pl-11 pr-4 py-3 bg-[#20201f] border border-[#353535] focus:border-[#ffdca1] focus:ring-1 focus:ring-[#ffdca1] rounded-xl text-xs font-semibold text-[#e5e2e1] placeholder-[#d5c4ab]/40 outline-none transition-all"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full py-3.5 px-4 bg-[#ffdca1] hover:bg-[#ffe5b8] active:scale-[0.99] text-[#412d00] font-extrabold rounded-xl text-xs flex items-center justify-center space-x-2 transition-all shadow-lg cursor-pointer disabled:opacity-50"
              >
                {isLoading ? (
                  <>
                    <span className="w-4 h-4 border-2 border-[#412d00] border-t-transparent rounded-full animate-spin"></span>
                    <span>Gönderiliyor...</span>
                  </>
                ) : (
                  <>
                    <span>Sıfırlama Talebi Gönder</span>
                    <span className="material-symbols-outlined text-base">send</span>
                  </>
                )}
              </button>
            </form>
          )}

          {!submitted && (
            <div className="pt-4 border-t border-[#353535] text-center select-none">
              <button
                type="button"
                onClick={() => navigate('/login')}
                className="text-xs font-semibold text-[#ffdca1] hover:underline cursor-pointer"
              >
                Giriş ekranına dön
              </button>
            </div>
          )}
        </motion.div>
      </main>

      <footer className="text-center text-xs text-[#d5c4ab]/60 font-mono max-w-6xl w-full mx-auto pt-6 border-t border-[#353535] select-none">
        Akıllı Şantiye IoT Otomasyon Sistemleri © 2026 — Endüstriyel B2B Yakıt Takip Mimarisi
      </footer>
    </div>
  );
};
