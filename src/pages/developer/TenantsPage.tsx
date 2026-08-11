import React from 'react';
import { useApp } from '../../context/AppContext';

export const TenantsPage: React.FC = () => {
  const { companies, toggleCompanyModule, setSelectedTenantForDetail } = useApp();

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
          onClick={() => alert('Yeni Kiraci Ekleme Formu')}
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

    </div>
  );
};
