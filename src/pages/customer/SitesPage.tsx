import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';

export const SitesPage: React.FC = () => {
  const { currentCompany, setSelectedSiteFilter } = useApp();
  const [searchTerm, setSearchTerm] = useState('');

  const filteredSites = currentCompany.sites.filter(s =>
    s.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    s.location.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="space-y-6">
      
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 bg-[#1c1b1b] border border-[#514532]/25 p-6 rounded-xl">
        <div className="space-y-1">
          <span className="text-xs font-mono font-bold text-[#ffdca1] uppercase tracking-widest block">
            SAHA ALTYAPISI
          </span>
          <h1 className="text-2xl font-black text-[#e5e2e1] uppercase tracking-tight">
            ŞANTİYE YÖNETİMİ
          </h1>
          <p className="text-xs text-[#d5c4ab]">
            {currentCompany.name} firmasına tanımlı aktif şantiyeler, lokasyonlar ve telemetri altyapısı.
          </p>
        </div>

        <div className="bg-[#0e0e0e] border border-[#514532]/30 px-4 py-2.5 rounded-md flex items-center space-x-3">
          <span className="material-symbols-outlined text-[#ffdca1] text-xl">location_city</span>
          <div>
            <span className="text-[10px] text-[#d5c4ab] font-mono block">TOPLAM AKTİF ŞANTİYE</span>
            <span className="text-lg font-black font-mono text-[#e5e2e1]">
              {currentCompany.sites.length} Tesis
            </span>
          </div>
        </div>
      </div>

      {/* Sites Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredSites.map(site => (
          <div
            key={site.id}
            className="bg-[#20201f] hover:bg-[#2a2a2a] border border-[#514532]/25 rounded-xl p-6 space-y-4 transition-all duration-150 flex flex-col justify-between"
          >
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono font-bold text-[#ffdca1] px-2.5 py-1 rounded bg-[#ffb800]/10 border border-[#ffb800]/20">
                  AKTİF LOKASYON
                </span>
                <span className="material-symbols-outlined text-[#d5c4ab]">location_on</span>
              </div>

              <div>
                <h3 className="text-lg font-bold text-[#e5e2e1]">{site.name}</h3>
                <p className="text-xs font-mono text-[#d5c4ab] mt-1">{site.location}</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 pt-4 border-t border-[#514532]/20 text-xs font-mono">
              <div className="bg-[#0e0e0e] p-3 rounded-md border border-[#514532]/20">
                <span className="text-[10px] text-[#d5c4ab] block">AKTİF TANKLAR</span>
                <span className="text-base font-black text-[#e5e2e1]">{site.activeTanksCount} Adet</span>
              </div>
              <div className="bg-[#0e0e0e] p-3 rounded-md border border-[#514532]/20">
                <span className="text-[10px] text-[#d5c4ab] block">ATANMIŞ ARAÇLAR</span>
                <span className="text-base font-black text-[#ffdca1]">{site.activeVehiclesCount} Araç</span>
              </div>
            </div>

            <button
              onClick={() => setSelectedSiteFilter(site.name)}
              className="w-full mt-2 py-2 bg-[#1c1b1b] hover:bg-[#353535] border border-[#514532]/30 text-[#e5e2e1] hover:text-[#ffdca1] rounded-md text-xs font-bold transition-colors cursor-pointer"
            >
              Bu Şantiyeyi Filtrele →
            </button>
          </div>
        ))}
      </div>

    </div>
  );
};
