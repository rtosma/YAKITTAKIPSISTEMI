import React, { useState, useMemo } from 'react';
import { useApp } from '../../context/AppContext';

export const SitesPage: React.FC = () => {
  const { currentCompany, setSelectedSiteFilter, isManagerMode, currentUser, tanks, vehicles, sites, addSite, deleteSite } = useApp();
  const [searchTerm, setSearchTerm] = useState('');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [newSiteName, setNewSiteName] = useState('');
  const [siteToDelete, setSiteToDelete] = useState<string | null>(null);

  const handleCreateSite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSiteName.trim()) return;
    await addSite(newSiteName.trim());
    setNewSiteName('');
    setIsAddModalOpen(false);
  };

  // Use the exact 'sites' array returned from the backend (which includes user's sites, vehicle sites, tank sites, etc.)
  const dynamicSites = useMemo(() => {
    let visibleSiteNames = sites;

    // If not manager, only see own site
    if (!isManagerMode && currentUser?.siteName) {
      visibleSiteNames = [currentUser.siteName];
    }

    return visibleSiteNames.map((siteName, index) => {
      const siteTanks = tanks.filter(t => t.siteName === siteName);
      const siteVehicles = vehicles.filter(v => v.siteName === siteName);

      return {
        id: `site-dyn-${index}`,
        name: siteName,
        location: 'Türkiye',
        activeTanksCount: siteTanks.length,
        activeVehiclesCount: siteVehicles.length
      };
    });
  }, [sites, tanks, vehicles, isManagerMode, currentUser]);

  const filteredSites = dynamicSites.filter(s =>
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

        <div className="flex items-center space-x-3">
          <div className="bg-[#0e0e0e] border border-[#514532]/30 px-4 py-2.5 rounded-md flex items-center space-x-3">
            <span className="material-symbols-outlined text-[#ffdca1] text-xl">location_city</span>
            <div>
              <span className="text-[10px] text-[#d5c4ab] font-mono block">TOPLAM AKTİF ŞANTİYE</span>
              <span className="text-lg font-black font-mono text-[#e5e2e1]">
                {dynamicSites.length} Tesis
              </span>
            </div>
          </div>

          {isManagerMode && (
            <button
              onClick={() => setIsAddModalOpen(true)}
              className="px-4 py-3 bg-gradient-to-r from-[#ffb800] to-[#ff8a00] hover:from-[#ffa800] hover:to-[#e67e00] text-[#412d00] font-black rounded-lg text-xs flex items-center space-x-2 transition-all shadow-md cursor-pointer shrink-0"
            >
              <span className="material-symbols-outlined text-base">add_location_alt</span>
              <span>+ Yeni Şantiye Ekle</span>
            </button>
          )}
        </div>
      </div>

      {/* Search Bar */}
      <div className="bg-[#1c1b1b] border border-[#514532]/25 p-4 rounded-xl flex items-center space-x-3">
        <span className="material-symbols-outlined text-[#d5c4ab]">search</span>
        <input
          type="text"
          placeholder="Şantiye adı veya lokasyon ara..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="bg-transparent border-none outline-none text-[#e5e2e1] text-sm w-full font-mono placeholder-[#d5c4ab]/50"
        />
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
                <div className="flex items-center space-x-2">
                  <span className="text-[10px] font-mono font-bold text-[#ffdca1] px-2.5 py-1 rounded bg-[#ffb800]/10 border border-[#ffb800]/20">
                    AKTİF LOKASYON
                  </span>
                </div>

                <div className="flex items-center space-x-1">
                  {isManagerMode && (
                    <button
                      onClick={() => setSiteToDelete(site.name)}
                      className="p-1 text-[#ffb4ab] hover:bg-[#ffb4ab]/20 rounded transition-colors cursor-pointer"
                      title="Şantiyeyi Sil"
                    >
                      <span className="material-symbols-outlined text-lg">delete</span>
                    </button>
                  )}
                  <span className="material-symbols-outlined text-[#d5c4ab]">location_on</span>
                </div>
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

        {filteredSites.length === 0 && (
          <div className="col-span-full py-12 flex flex-col items-center justify-center text-[#d5c4ab] bg-[#1c1b1b] border border-[#514532]/20 rounded-xl border-dashed">
            <span className="material-symbols-outlined text-4xl mb-3 opacity-50">search_off</span>
            <p className="font-mono text-sm">Veritabanında kayıtlı şantiye bulunamadı.</p>
          </div>
        )}
      </div>

      {/* MODAL: ADD NEW SITE */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#1c1b1b] border border-[#514532]/30 rounded-xl p-6 max-w-md w-full space-y-6">
            <div className="flex items-center justify-between border-b border-[#514532]/20 pb-4">
              <h3 className="text-base font-bold text-[#e5e2e1] uppercase flex items-center space-x-2">
                <span className="material-symbols-outlined text-[#ffdca1]">add_location_alt</span>
                <span>Yeni Şantiye / Tesis Ekle</span>
              </h3>
              <button onClick={() => setIsAddModalOpen(false)} className="text-[#d5c4ab] hover:text-[#e5e2e1]">
                <span className="material-symbols-outlined text-lg">close</span>
              </button>
            </div>

            <form onSubmit={handleCreateSite} className="space-y-4">
              <div>
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Şantiye / Tesis Adı</label>
                <input
                  type="text"
                  placeholder="Örn: Silivri Tesisleri, Ankara Şantiyesi"
                  value={newSiteName}
                  onChange={(e) => setNewSiteName(e.target.value)}
                  className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                  required
                  autoFocus
                />
                <p className="text-[10px] text-[#d5c4ab]/70 font-mono mt-1.5">
                  Eklenen şantiye doğrudan veritabanına işlenecek ve tüm araç, şoför ve tank atamalarında seçilebilir olacaktır.
                </p>
              </div>

              <div className="pt-4 border-t border-[#514532]/20 flex items-center justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  className="px-4 py-2 bg-[#20201f] text-[#d5c4ab] rounded-md text-xs font-bold"
                >
                  İptal
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 bg-gradient-to-r from-[#ffb800] to-[#ff8a00] text-[#412d00] rounded-md text-xs font-black"
                >
                  Şantiyeyi Kaydet
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: DELETE SITE CONFIRMATION */}
      {siteToDelete && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#1c1b1b] border border-[#ffb4ab]/30 rounded-xl p-6 max-w-md w-full space-y-6">
            <div className="flex items-center space-x-3 text-[#ffb4ab]">
              <span className="material-symbols-outlined text-2xl">warning</span>
              <h3 className="text-base font-bold uppercase">Şantiye Silme Onayı</h3>
            </div>
            <p className="text-xs text-[#d5c4ab]">
              <strong className="text-[#e5e2e1]">{siteToDelete}</strong> şantiyesini veritabanından silmek istediğinize emin misiniz? Bu şantiyedeki araç ve tanklar "Atanmadı" durumuna getirilecektir.
            </p>
            <div className="flex items-center justify-end space-x-3 pt-4 border-t border-[#514532]/20">
              <button
                type="button"
                onClick={() => setSiteToDelete(null)}
                className="px-4 py-2 bg-[#20201f] text-[#d5c4ab] rounded-md text-xs font-bold"
              >
                İptal
              </button>
              <button
                type="button"
                onClick={async () => {
                  await deleteSite(siteToDelete);
                  setSiteToDelete(null);
                }}
                className="px-5 py-2 bg-red-600 hover:bg-red-700 text-white rounded-md text-xs font-black"
              >
                Şantiyeyi Sil
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
