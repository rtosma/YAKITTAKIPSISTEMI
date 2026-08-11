import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';

export const SettingsPage: React.FC = () => {
  const { currentCompany, showToast } = useApp();
  const [smsAlerts, setSmsAlerts] = useState(true);
  const [emailAlerts, setEmailAlerts] = useState(true);
  const [flowThreshold, setFlowThreshold] = useState(120);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    showToast('Sistem ayarları başarıyla kaydedildi');
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 bg-[#1c1b1b] border border-[#514532]/25 p-6 rounded-xl">
        <div className="space-y-1">
          <span className="text-xs font-mono font-bold text-[#ffdca1] uppercase tracking-widest block">
            FİRMA YAPILANDIRMASI
          </span>
          <h1 className="text-2xl font-black text-[#e5e2e1] uppercase tracking-tight">
            SİSTEM AYARLARI
          </h1>
          <p className="text-xs text-[#d5c4ab]">
            {currentCompany.name} firmasına özel telemetri eşik değerleri ve bildirim tercihleri.
          </p>
        </div>
      </div>

      <form onSubmit={handleSave} className="bg-[#1c1b1b] border border-[#514532]/25 rounded-xl p-6 space-y-6">
        <div className="space-y-4">
          <h3 className="text-sm font-bold text-[#ffdca1] uppercase font-mono border-b border-[#514532]/20 pb-2">
            1. Anomali & Debi Uyarı Eşikleri
          </h3>

          <div>
            <label className="text-xs font-mono text-[#d5c4ab] block mb-1">
              Maksimum Debi Hızı Limiti (L/dk)
            </label>
            <input
              type="number"
              value={flowThreshold}
              onChange={(e) => setFlowThreshold(Number(e.target.value))}
              className="w-full sm:w-64 bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] font-mono text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
            />
            <p className="text-[11px] text-[#d5c4ab] mt-1">
              Bu debi hızı aşıldığında sistem anında vana kapatma sinyali tetikler.
            </p>
          </div>
        </div>

        <div className="space-y-4 pt-4 border-t border-[#514532]/20">
          <h3 className="text-sm font-bold text-[#ffdca1] uppercase font-mono border-b border-[#514532]/20 pb-2">
            2. Otomatik Alarm Kanalları
          </h3>

          <div className="space-y-3">
            <label className="flex items-center space-x-3 cursor-pointer">
              <input
                type="checkbox"
                checked={smsAlerts}
                onChange={(e) => setSmsAlerts(e.target.checked)}
                className="w-4 h-4 accent-[#ffb800]"
              />
              <span className="text-xs font-mono text-[#e5e2e1]">
                Kritik seviyede şantiye şeflerine SMS bildirimi gönder
              </span>
            </label>

            <label className="flex items-center space-x-3 cursor-pointer">
              <input
                type="checkbox"
                checked={emailAlerts}
                onChange={(e) => setEmailAlerts(e.target.checked)}
                className="w-4 h-4 accent-[#ffb800]"
              />
              <span className="text-xs font-mono text-[#e5e2e1]">
                Günlük ve haftalık ikmal özet raporlarını E-Posta olarak gönder
              </span>
            </label>
          </div>
        </div>

        <div className="pt-4 border-t border-[#514532]/20 flex justify-end">
          <button
            type="submit"
            className="px-6 py-2.5 bg-gradient-to-r from-[#ffb800] to-[#ff8a00] hover:from-[#ffdca1] hover:to-[#ffb77f] text-[#412d00] font-black rounded-md text-xs transition-all cursor-pointer shadow-sm"
          >
            Ayarları Kaydet
          </button>
        </div>
      </form>
    </div>
  );
};
