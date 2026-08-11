import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';

export const CrossSitePage: React.FC = () => {
  const { crossSitePermissions, toggleCrossSiteStatus, vehicles, drivers, currentCompany, showToast } = useApp();

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedPlate, setSelectedPlate] = useState(vehicles[0]?.plate || '35 EGE 40');
  const [targetSite, setTargetSite] = useState('Gebze Ana Şantiye');
  const [allowedLiters, setAllowedLiters] = useState<number>(300);

  const handleCreatePermission = (e: React.FormEvent) => {
    e.preventDefault();
    showToast(`Çapraz şantiye ikmal yetkisi tanımlandı: ${selectedPlate} → ${targetSite}`);
    setIsModalOpen(false);
  };

  return (
    <div className="space-y-6">
      
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-[#1c1b1b] border border-[#353535] p-6 rounded-2xl">
        <div>
          <span className="text-[10px] font-mono text-[#ffdca1] font-bold uppercase tracking-widest">
            ŞANTİYELER ARASI GEÇİCİ İZİN
          </span>
          <h2 className="text-xl font-extrabold text-[#e5e2e1] uppercase mt-0.5">
            Yetkilendirme (Çapraz Şantiye)
          </h2>
          <p className="text-xs text-[#d5c4ab] mt-1">
            Farklı şantiyeye sevk edilen araç ve şoförlerin geçici yakıt alma yetki tanımları
          </p>
        </div>

        <button
          onClick={() => setIsModalOpen(true)}
          className="bg-[#ffdca1] text-[#412d00] font-black px-4 py-2.5 rounded-xl text-xs flex items-center space-x-2 transition-all cursor-pointer shadow"
        >
          <span className="material-symbols-outlined text-lg">add_moderator</span>
          <span>Geçici İkmal İzni Tanımla</span>
        </button>
      </div>

      {/* Permissions List Table */}
      <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 overflow-x-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-[#353535] text-[#d5c4ab] uppercase text-[10px] tracking-wider font-mono">
              <th className="py-3.5 px-4">Araç Plakası</th>
              <th className="py-3.5 px-4">Şoför</th>
              <th className="py-3.5 px-4">Kendi Şantiyesi</th>
              <th className="py-3.5 px-4">İkmal Alacağı Şantiye</th>
              <th className="py-3.5 px-4">İzin Verilen Miktar</th>
              <th className="py-3.5 px-4">Kullanılan Miktar</th>
              <th className="py-3.5 px-4">Son Geçerlilik</th>
              <th className="py-3.5 px-4">Durum</th>
              <th className="py-3.5 px-4 text-right">İşlem</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#353535] font-mono">
            {crossSitePermissions.map(p => (
              <tr key={p.id} className="hover:bg-[#282726] transition-colors">
                <td className="py-3.5 px-4 font-black text-[#ffdca1] text-sm">{p.vehiclePlate}</td>
                <td className="py-3.5 px-4 text-[#e5e2e1] font-bold">{p.driverName}</td>
                <td className="py-3.5 px-4 text-[#d5c4ab]">{p.homeSite}</td>
                <td className="py-3.5 px-4 text-[#a1e8a2] font-bold">{p.targetSite}</td>
                <td className="py-3.5 px-4 text-[#e5e2e1]">{p.allowedLiters} L</td>
                <td className="py-3.5 px-4 text-[#d5c4ab]">{p.usedLiters} L</td>
                <td className="py-3.5 px-4 text-[#d5c4ab]">{p.expiryDate}</td>
                <td className="py-3.5 px-4">
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                    p.status === 'AKTİF' ? 'bg-[#a1e8a2]/10 text-[#a1e8a2]' : 'bg-[#ffb4ab]/10 text-[#ffb4ab]'
                  }`}>
                    {p.status}
                  </span>
                </td>
                <td className="py-3.5 px-4 text-right">
                  <button
                    onClick={() => toggleCrossSiteStatus(p.id)}
                    className="px-3 py-1 bg-[#20201f] hover:bg-[#282726] border border-[#353535] text-[#ffdca1] text-[11px] font-bold rounded-lg cursor-pointer"
                  >
                    {p.status === 'AKTİF' ? 'Kapat' : 'Aktifleştir'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* MODAL */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 max-w-md w-full space-y-6">
            <div className="flex items-center justify-between border-b border-[#353535] pb-4">
              <h3 className="text-base font-extrabold text-[#e5e2e1] uppercase tracking-wider flex items-center space-x-2">
                <span className="material-symbols-outlined text-[#ffdca1]">add_moderator</span>
                <span>Çapraz Şantiye Yetkisi Ver</span>
              </h3>
              <button onClick={() => setIsModalOpen(false)} className="text-[#d5c4ab] hover:text-[#e5e2e1]">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <form onSubmit={handleCreatePermission} className="space-y-4">
              <div>
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Araç Plakası</label>
                <select
                  value={selectedPlate}
                  onChange={(e) => setSelectedPlate(e.target.value)}
                  className="w-full bg-[#131313] border border-[#353535] text-[#e5e2e1] text-xs rounded-xl p-3 focus:outline-none focus:border-[#ffdca1]"
                >
                  {vehicles.map(v => (
                    <option key={v.id} value={v.plate}>{v.plate} ({v.siteName})</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">İkmal Yapacağı Şantiye</label>
                <select
                  value={targetSite}
                  onChange={(e) => setTargetSite(e.target.value)}
                  className="w-full bg-[#131313] border border-[#353535] text-[#e5e2e1] text-xs rounded-xl p-3 focus:outline-none focus:border-[#ffdca1]"
                >
                  {currentCompany.sites.map(s => (
                    <option key={s.id} value={s.name}>{s.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">İzin Verilen Miktar (Litre)</label>
                <input
                  type="number"
                  value={allowedLiters}
                  onChange={(e) => setAllowedLiters(Number(e.target.value))}
                  min={50}
                  max={2000}
                  className="w-full bg-[#131313] border border-[#353535] text-[#e5e2e1] font-mono text-xs rounded-xl p-3 focus:outline-none focus:border-[#ffdca1]"
                  required
                />
              </div>

              <div className="pt-4 border-t border-[#353535] flex items-center justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2.5 bg-[#20201f] text-[#d5c4ab] rounded-xl text-xs font-bold"
                >
                  İptal
                </button>
                <button
                  type="submit"
                  className="px-5 py-2.5 bg-[#ffdca1] text-[#412d00] rounded-xl text-xs font-black"
                >
                  Yetkiyi Oluştur
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
};
