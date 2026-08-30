import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { TenantDetailModal } from '../../components/TenantDetailModal';

export const TenantsPage: React.FC = () => {
  const { companies, addCompany, setSelectedTenantForDetail } = useApp();
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [taxNumber, setTaxNumber] = useState('');

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    addCompany({
      name: name.trim(),
      city: city || 'İstanbul',
      taxNumber: taxNumber || '1234567890'
    });

    setName('');
    setCity('');
    setTaxNumber('');
    setIsAddOpen(false);
  };

  return (
    <div className="space-y-6">
      
      {/* Header */}
      <div className="bg-[#1c1b1b] border border-[#353535] p-6 rounded-2xl flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <span className="text-[10px] font-mono text-[#ffb77f] font-bold uppercase tracking-widest">
            KİRACI FİRMA YÖNETİMİ
          </span>
          <h2 className="text-xl font-extrabold text-[#e5e2e1] uppercase mt-0.5">
            Tüm B2B SaaS Müşteri Firmaları
          </h2>
          <p className="text-xs text-[#d5c4ab] mt-1">
            Platformda kayıtlı tüm firmaların şantiye, araç sayıları ve lisanslı modül durumları
          </p>
        </div>

        <button
          onClick={() => setIsAddOpen(true)}
          className="bg-[#ffb77f] text-[#412d00] font-black px-4 py-2.5 rounded-xl text-xs flex items-center space-x-2 transition-all cursor-pointer shadow"
        >
          <span className="material-symbols-outlined text-lg">domain_add</span>
          <span>Yeni Firma Ekle</span>
        </button>
      </div>

      {/* Tenants Table */}
      <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 overflow-x-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-[#353535] text-[#d5c4ab] uppercase text-[10px] tracking-wider font-mono">
              <th className="py-3.5 px-4">Firma Kodu</th>
              <th className="py-3.5 px-4">Firma Ünvanı</th>
              <th className="py-3.5 px-4">Şehir / Vergi No</th>
              <th className="py-3.5 px-4">Şantiye</th>
              <th className="py-3.5 px-4">Filo Büyüklüğü</th>
              <th className="py-3.5 px-4">Aylık Tüketim</th>
              <th className="py-3.5 px-4">Lisans Durumu</th>
              <th className="py-3.5 px-4 text-right">İşlemler</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#353535] font-mono">
            {companies.map(c => (
              <tr key={c.id} className="hover:bg-[#282726] transition-colors">
                <td className="py-3.5 px-4 font-black text-[#ffb77f] text-sm">{c.code}</td>
                <td className="py-3.5 px-4 font-bold text-[#e5e2e1] text-sm">{c.name}</td>
                <td className="py-3.5 px-4 text-[#d5c4ab]">{c.city} / {c.taxNumber}</td>
                <td className="py-3.5 px-4 text-[#e5e2e1]">{c.sites.length} Şantiye</td>
                <td className="py-3.5 px-4 text-[#ffdca1] font-bold">{c.activeVehiclesCount} Araç</td>
                <td className="py-3.5 px-4 text-[#a1e8a2] font-bold">
                  {c.totalFuelThisMonth.toLocaleString('tr-TR')} Litre
                </td>
                <td className="py-3.5 px-4">
                  <span className="text-[10px] font-bold px-2.5 py-1 rounded bg-[#a1e8a2]/10 text-[#a1e8a2] border border-[#a1e8a2]/30">
                    {c.licenseStatus}
                  </span>
                </td>
                <td className="py-3.5 px-4 text-right">
                  <button
                    onClick={() => setSelectedTenantForDetail(c)}
                    className="px-3 py-1.5 bg-[#20201f] hover:bg-[#282726] border border-[#353535] text-[#ffb77f] font-bold text-xs rounded-xl cursor-pointer"
                  >
                    Detay & Modüller
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ADD COMPANY MODAL */}
      {isAddOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 max-w-md w-full space-y-6">
            <div className="flex items-center justify-between border-b border-[#353535] pb-4">
              <h3 className="text-base font-extrabold text-[#e5e2e1] uppercase tracking-wider flex items-center space-x-2">
                <span className="material-symbols-outlined text-[#ffb77f]">domain_add</span>
                <span>Yeni Kiracı Firma Kaydı</span>
              </h3>
              <button onClick={() => setIsAddOpen(false)} className="text-[#d5c4ab] hover:text-[#e5e2e1]">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Firma Ünvanı</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="örn. Yılmaz İnşaat A.Ş."
                  className="w-full bg-[#131313] border border-[#353535] text-[#e5e2e1] text-xs rounded-xl p-3 focus:outline-none focus:border-[#ffb77f]"
                  required
                />
              </div>

              <div>
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Şehir</label>
                <input
                  type="text"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="örn. Ankara"
                  className="w-full bg-[#131313] border border-[#353535] text-[#e5e2e1] text-xs rounded-xl p-3 focus:outline-none focus:border-[#ffb77f]"
                />
              </div>

              <div>
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Vergi Numarası</label>
                <input
                  type="text"
                  value={taxNumber}
                  onChange={(e) => setTaxNumber(e.target.value)}
                  placeholder="10 haneli VKN"
                  className="w-full bg-[#131313] border border-[#353535] text-[#e5e2e1] font-mono text-xs rounded-xl p-3 focus:outline-none focus:border-[#ffb77f]"
                />
              </div>

              <div className="pt-4 border-t border-[#353535] flex items-center justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setIsAddOpen(false)}
                  className="px-4 py-2.5 bg-[#20201f] text-[#d5c4ab] rounded-xl text-xs font-bold"
                >
                  İptal
                </button>
                <button
                  type="submit"
                  className="px-5 py-2.5 bg-[#ffb77f] text-[#412d00] rounded-xl text-xs font-black"
                >
                  Firmayı Kaydet
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* TENANT DETAIL MODAL */}
      <TenantDetailModal />

    </div>
  );
};
