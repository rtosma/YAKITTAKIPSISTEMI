import React from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';

export const WelcomeScreen: React.FC = () => {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-[#131313] text-[#e5e2e1] flex flex-col justify-between p-6 md:p-12 font-sans antialiased">
      
      {/* Brand Header */}
      <header className="flex items-center justify-between border-b border-[#353535] pb-6 max-w-6xl w-full mx-auto">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-[#ffdca1] text-[#412d00] flex items-center justify-center font-black shadow">
            <span className="material-symbols-outlined text-2xl font-bold">local_gas_station</span>
          </div>
          <div>
            <h1 className="font-extrabold text-[#e5e2e1] text-base tracking-widest uppercase">
              AKILLI ŞANTİYE
            </h1>
            <p className="text-xs text-[#d5c4ab] font-medium">IoT Yakıt Takip & Şantiye Otomasyon Platformu</p>
          </div>
        </div>

        <div className="flex items-center space-x-2 text-xs font-mono text-[#a1e8a2] bg-[#1c1b1b] border border-[#353535] px-3.5 py-1.5 rounded-full">
          <span className="w-2 h-2 rounded-full bg-[#a1e8a2] animate-pulse"></span>
          <span>SİSTEM ÇEVRİMİÇİ (v2.4)</span>
        </div>
      </header>

      {/* Main Content & Role Selection Cards */}
      <main className="max-w-5xl w-full mx-auto my-12 space-y-12">
        
        <div className="text-center space-y-3 max-w-2xl mx-auto">
          <span className="text-xs font-bold text-[#ffdca1] uppercase tracking-widest font-mono">
            KURUMSAL B2B PLATFORMU
          </span>
          <h2 className="text-3xl md:text-4xl font-extrabold text-[#e5e2e1] tracking-tight">
            Giriş Yapmak İstediğiniz Paneli Seçin
          </h2>
          <p className="text-sm text-[#d5c4ab] leading-relaxed">
            Müşteri firmalar kendi şantiyelerini ve araç ikmallerini yönetirken; geliştirici ekibi tüm sistemi ve IoT donanım loglarını denetler.
          </p>
        </div>

        {/* 2 DISTINCT ROLE SELECTION CARDS */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          
          {/* Card 1: Müşteri (Firma) Girişi */}
          <motion.div
            whileHover={{ y: -4 }}
            transition={{ duration: 0.2 }}
            onClick={() => navigate('/panel')}
            className="bg-[#1c1b1b] hover:bg-[#20201f] border border-[#353535] hover:border-[#ffdca1] rounded-2xl p-8 cursor-pointer flex flex-col justify-between space-y-8 group transition-all"
          >
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="w-12 h-12 rounded-xl bg-[#20201f] border border-[#353535] text-[#ffdca1] flex items-center justify-center group-hover:bg-[#ffdca1] group-hover:text-[#412d00] transition-colors">
                  <span className="material-symbols-outlined text-2xl font-bold">storefront</span>
                </div>
                <span className="text-[10px] font-mono font-bold px-2.5 py-1 rounded bg-[#ffdca1]/10 text-[#ffdca1] border border-[#ffdca1]/30">
                  FİRMA PORTALI
                </span>
              </div>

              <div>
                <h3 className="text-xl font-extrabold text-[#e5e2e1] group-hover:text-[#ffdca1] transition-colors">
                  Müşteri Paneli
                </h3>
                <p className="text-xs text-[#d5c4ab] font-mono mt-1">ÇamSA Pelet & Enerji A.Ş.</p>
              </div>

              <p className="text-xs text-[#d5c4ab] leading-relaxed">
                Şantiye bazlı tank doluluk seviyelerini, araç ikmal kayıtlarını, debimetre hareketlerini ve çapraz şantiye yetkilendirmelerini inceleyin.
              </p>
            </div>

            <div className="pt-4 border-t border-[#353535] flex items-center justify-between text-xs font-bold text-[#ffdca1]">
              <span>Müşteri Paneline Giriş Yap</span>
              <span className="material-symbols-outlined text-lg group-hover:translate-x-1 transition-transform">
                arrow_forward
              </span>
            </div>
          </motion.div>

          {/* Card 2: Geliştirici (Süper Admin) Girişi */}
          <motion.div
            whileHover={{ y: -4 }}
            transition={{ duration: 0.2 }}
            onClick={() => navigate('/admin')}
            className="bg-[#1c1b1b] hover:bg-[#20201f] border border-[#353535] hover:border-[#ffb77f] rounded-2xl p-8 cursor-pointer flex flex-col justify-between space-y-8 group transition-all"
          >
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="w-12 h-12 rounded-xl bg-[#20201f] border border-[#353535] text-[#ffb77f] flex items-center justify-center group-hover:bg-[#ffb77f] group-hover:text-[#412d00] transition-colors">
                  <span className="material-symbols-outlined text-2xl font-bold">terminal</span>
                </div>
                <span className="text-[10px] font-mono font-bold px-2.5 py-1 rounded bg-[#ffb77f]/10 text-[#ffb77f] border border-[#ffb77f]/30">
                  SÜPER ADMİN
                </span>
              </div>

              <div>
                <h3 className="text-xl font-extrabold text-[#e5e2e1] group-hover:text-[#ffb77f] transition-colors">
                  Geliştirici Paneli
                </h3>
                <p className="text-xs text-[#d5c4ab] font-mono mt-1">Sistem Yönetimi & Donanım Telemetrisi</p>
              </div>

              <p className="text-xs text-[#d5c4ab] leading-relaxed">
                Tüm kiracı (tenant) firmaları yönetin, e-İrsaliye / AI modül lisanslarını açıp kapatın ve ESP32 IoT cihazlarından gelen canlı MQTT loglarını izleyin.
              </p>
            </div>

            <div className="pt-4 border-t border-[#353535] flex items-center justify-between text-xs font-bold text-[#ffb77f]">
              <span>Geliştirici Paneline Giriş Yap</span>
              <span className="material-symbols-outlined text-lg group-hover:translate-x-1 transition-transform">
                arrow_forward
              </span>
            </div>
          </motion.div>

        </div>

      </main>

      {/* Footer */}
      <footer className="text-center text-xs text-[#d5c4ab]/60 font-mono max-w-6xl w-full mx-auto pt-6 border-t border-[#353535]">
        Akıllı Şantiye IoT Otomasyon Sistemleri © 2026 — Endüstriyel B2B Yakıt Takip Mimarisi
      </footer>

    </div>
  );
};
