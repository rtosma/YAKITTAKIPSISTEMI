import React from 'react';
import { useApp } from '../../context/AppContext';

export const NotificationsPage: React.FC = () => {
  const { tanks, selectedSiteFilter } = useApp();

  const siteTanks = selectedSiteFilter === 'TÜMÜ'
    ? tanks
    : tanks.filter(t => t.siteName === selectedSiteFilter);

  const criticalTanks = siteTanks.filter(t => (t.currentLevelLiters / t.capacityLiters) < 0.2);
  const warningTanks = siteTanks.filter(t => (t.currentLevelLiters / t.capacityLiters) >= 0.2 && (t.currentLevelLiters / t.capacityLiters) < 0.4);

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 bg-[#1c1b1b] border border-[#514532]/25 p-6 rounded-xl">
        <div className="space-y-1">
          <span className="text-xs font-mono font-bold text-[#ffdca1] uppercase tracking-widest block">
            TELEMETRİ UYARILARI
          </span>
          <h1 className="text-2xl font-black text-[#e5e2e1] uppercase tracking-tight">
            BİLDİRİMLER & ANOMALİ ALARMLARI
          </h1>
          <p className="text-xs text-[#d5c4ab]">
            Depo kritiği, yetkisiz yakıt çekim girişimleri ve donanım kopma uyarıları.
          </p>
        </div>
      </div>

      <div className="space-y-3">
        {criticalTanks.map(t => (
          <div key={t.id} className="p-4 bg-[#93000a]/20 border border-[#93000a] rounded-xl flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <span className="material-symbols-outlined text-[#ffb4ab] text-xl">error</span>
              <div>
                <h4 className="text-sm font-bold text-[#ffdad6]">{t.name} - Kritik Düzey Uyarısı!</h4>
                <p className="text-xs text-[#d5c4ab]">
                  Mevcut doluluk %{Math.round((t.currentLevelLiters / t.capacityLiters) * 100)} ({t.currentLevelLiters.toLocaleString('tr-TR')} Litre). Yakıt dolumu gerekiyor!
                </p>
              </div>
            </div>
            <span className="text-xs font-mono text-[#ffb4ab]">Bugün 09:12</span>
          </div>
        ))}

        {warningTanks.map(t => (
          <div key={t.id} className="p-4 bg-[#ff8a00]/10 border border-[#ff8a00]/30 rounded-xl flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <span className="material-symbols-outlined text-[#ffb77f] text-xl">warning</span>
              <div>
                <h4 className="text-sm font-bold text-[#ffdca1]">{t.name} - Düşük Seviye Yaklaşıyor</h4>
                <p className="text-xs text-[#d5c4ab]">
                  Mevcut doluluk %{Math.round((t.currentLevelLiters / t.capacityLiters) * 100)}. Lojistik planlaması yapılması önerilir.
                </p>
              </div>
            </div>
            <span className="text-xs font-mono text-[#ffdca1]">Dün 16:45</span>
          </div>
        ))}

        <div className="p-4 bg-[#1c1b1b] border border-[#514532]/25 rounded-xl flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <span className="material-symbols-outlined text-[#a1e8a2] text-xl">check_circle</span>
            <div>
              <h4 className="text-sm font-bold text-[#e5e2e1]">IoT Ağ Bağlantısı Stabil</h4>
              <p className="text-xs text-[#d5c4ab]">
                Tüm LoRaWAN/ESP32 ağ geçitleri 100% sinyal kalitesiyle veri aktarmaktadır.
              </p>
            </div>
          </div>
          <span className="text-xs font-mono text-[#d5c4ab]">Sürekli</span>
        </div>
      </div>
    </div>
  );
};
