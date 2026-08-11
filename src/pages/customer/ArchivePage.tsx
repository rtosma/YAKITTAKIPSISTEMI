import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';

export const ArchivePage: React.FC = () => {
  const { transactions } = useApp();
  const [selectedYear, setSelectedYear] = useState('2026');

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 bg-[#1c1b1b] border border-[#514532]/25 p-6 rounded-xl">
        <div className="space-y-1">
          <span className="text-xs font-mono font-bold text-[#ffdca1] uppercase tracking-widest block">
            DİJİTAL ARŞİV
          </span>
          <h1 className="text-2xl font-black text-[#e5e2e1] uppercase tracking-tight">
            VERİ ARŞİVLEME & GEÇMİŞ RAPORLAR
          </h1>
          <p className="text-xs text-[#d5c4ab]">
            Mali yıl bazlı ikmal verileri, geçmiş telemetri logları ve e-İrsaliye dökümleri.
          </p>
        </div>

        <select
          value={selectedYear}
          onChange={(e) => setSelectedYear(e.target.value)}
          className="bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs font-mono rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
        >
          <option value="2026">2026 Mali Yılı</option>
          <option value="2025">2025 Mali Yılı</option>
          <option value="2024">2024 Mali Yılı</option>
        </select>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-[#20201f] border border-[#514532]/25 rounded-xl p-6 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono font-bold text-[#ffdca1]">AYLIK ÖZET DÖKÜM</span>
            <span className="material-symbols-outlined text-[#d5c4ab]">folder_zip</span>
          </div>
          <h3 className="text-base font-bold text-[#e5e2e1]">Ağustos 2026 İkmal Arşivi</h3>
          <p className="text-xs text-[#d5c4ab] font-mono">124,800 Litre • 142 Kayıt</p>
          <button className="w-full py-2 bg-[#1c1b1b] hover:bg-[#353535] text-[#ffdca1] text-xs font-bold rounded-md border border-[#514532]/30 transition-colors cursor-pointer">
            ZIP Paketini İndir (3.4 MB)
          </button>
        </div>

        <div className="bg-[#20201f] border border-[#514532]/25 rounded-xl p-6 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono font-bold text-[#ffdca1]">E-İRSALİYE YEDEK</span>
            <span className="material-symbols-outlined text-[#d5c4ab]">receipt</span>
          </div>
          <h3 className="text-base font-bold text-[#e5e2e1]">Temmuz 2026 İrsaliyeleri</h3>
          <p className="text-xs text-[#d5c4ab] font-mono">98,400 Litre • 98 Fatura</p>
          <button className="w-full py-2 bg-[#1c1b1b] hover:bg-[#353535] text-[#ffdca1] text-xs font-bold rounded-md border border-[#514532]/30 transition-colors cursor-pointer">
            PDF Toplu Paket İndir
          </button>
        </div>

        <div className="bg-[#20201f] border border-[#514532]/25 rounded-xl p-6 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono font-bold text-[#ffdca1]">SENSÖR TELEMETRİSİ</span>
            <span className="material-symbols-outlined text-[#d5c4ab]">analytics</span>
          </div>
          <h3 className="text-base font-bold text-[#e5e2e1]">Haziran 2026 LoRa RAW Log</h3>
          <p className="text-xs text-[#d5c4ab] font-mono">1.2M Ham Sensör Verisi</p>
          <button className="w-full py-2 bg-[#1c1b1b] hover:bg-[#353535] text-[#ffdca1] text-xs font-bold rounded-md border border-[#514532]/30 transition-colors cursor-pointer">
            CSV Log Dosyası Al (12 MB)
          </button>
        </div>
      </div>
    </div>
  );
};
