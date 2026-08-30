import React from 'react';
import { useApp } from '../context/AppContext';
import { CompanyModule } from '../types';

export const TenantDetailModal: React.FC = () => {
  const { selectedTenantForDetail, setSelectedTenantForDetail, toggleCompanyModule, updateCompanyStatus } = useApp();

  if (!selectedTenantForDetail) return null;

  const tenant = selectedTenantForDetail;

  const moduleDefinitions: { key: keyof CompanyModule; title: string; desc: string; icon: string }[] = [
    {
      key: 'eInvoice',
      title: 'e-İrsaliye Entegrasyonu',
      desc: 'GİB UBL-TR e-İrsaliye otomatik bildirimi ve e-Fatura eşleme',
      icon: 'receipt'
    },
    {
      key: 'aiAnomaly',
      title: 'AI Hırsızlık & Anomali Motoru',
      desc: 'Debimetre vs ultrasonik seviye kaçak & hortum müdahale tespiti',
      icon: 'psychology'
    },
    {
      key: 'smartWarehouse',
      title: 'Akıllı Ambar & Depo',
      desc: 'Maden & şantiye ana stok, yedek parça ve malzeme takibi',
      icon: 'warehouse'
    },
    {
      key: 'maintenanceTrack',
      title: 'Bakım & Arıza Takibi',
      desc: 'Çalışma saati / km bazlı periyodik servis ve filtre uyarıları',
      icon: 'build'
    },
    {
      key: 'driverScore',
      title: 'Şoför Performans Skoru',
      desc: 'Rolanti süresi, aşırı tüketim ve güvenli ikmal skorlaması',
      icon: 'stars'
    },
    {
      key: 'crossSiteAuth',
      title: 'Çapraz Şantiye İkmal Yetkisi',
      desc: 'Konsorsiyum & partner şantiyelerden ortak akaryakıt alabilme',
      icon: 'verified'
    }
  ];

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex justify-end animate-fadeIn">
      <div 
        className="fixed inset-0"
        onClick={() => setSelectedTenantForDetail(null)}
      />

      <div className="relative bg-[#1c1b1b] border-l border-[#353535] w-full max-w-xl p-6 sm:p-8 space-y-6 overflow-y-auto shadow-2xl z-10 flex flex-col justify-between">
        
        <div className="space-y-6">
          
          {/* Header */}
          <div className="flex items-start justify-between pb-4 border-b border-[#353535]">
            <div className="space-y-1">
              <div className="flex items-center space-x-2">
                <span className="font-mono text-xs font-black text-[#ffb77f] bg-[#ffb77f]/10 border border-[#ffb77f]/30 px-2.5 py-0.5 rounded">
                  {tenant.code}
                </span>
                <span className="text-[10px] font-mono text-[#d5c4ab]">{tenant.city} / VKN: {tenant.taxNumber}</span>
              </div>
              <h2 className="text-xl font-black text-[#e5e2e1] uppercase tracking-wide">
                {tenant.name}
              </h2>
            </div>
            
            <button
              onClick={() => setSelectedTenantForDetail(null)}
              className="p-2 text-[#d5c4ab] hover:text-[#e5e2e1] hover:bg-[#282726] rounded-xl transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-2xl">close</span>
            </button>
          </div>

          {/* License Status Management */}
          <div className="bg-[#20201f] border border-[#353535] p-4.5 rounded-2xl space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono font-bold text-[#ffb77f] uppercase tracking-wider">
                Lisans & Abonelik Durumu
              </span>
              <span className="text-[10px] font-mono text-[#d5c4ab]">
                Bitiş: <strong className="text-[#e5e2e1]">{tenant.licenseExpiry}</strong>
              </span>
            </div>

            <div className="grid grid-cols-3 gap-2 pt-1">
              {(['AKTİF', 'ASKIDA', 'DENEME'] as const).map(status => {
                const isActive = tenant.licenseStatus === status;
                let colorClass = 'border-[#353535] text-[#d5c4ab] bg-[#131313]';
                if (isActive) {
                  if (status === 'AKTİF') colorClass = 'border-[#a1e8a2] bg-[#a1e8a2]/20 text-[#a1e8a2] font-black';
                  if (status === 'ASKIDA') colorClass = 'border-[#ff5f56] bg-[#ff5f56]/20 text-[#ff5f56] font-black';
                  if (status === 'DENEME') colorClass = 'border-[#ffdca1] bg-[#ffdca1]/20 text-[#ffdca1] font-black';
                }
                return (
                  <button
                    key={status}
                    onClick={() => updateCompanyStatus(tenant.id, status)}
                    className={`py-2 px-3 rounded-xl border text-xs font-mono text-center transition-all cursor-pointer ${colorClass}`}
                  >
                    {status}
                  </button>
                );
              })}
            </div>
          </div>

          {/* B2B SaaS Modules Management */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-extrabold text-[#e5e2e1] uppercase tracking-wider flex items-center space-x-2">
                <span className="material-symbols-outlined text-[#ffb77f] text-base">extension</span>
                <span>Modül Yetkileri & Lisans İzinleri</span>
              </h3>
              <span className="text-[10px] font-mono text-[#d5c4ab]">Anlık Aktif/Pasif Değişimi</span>
            </div>

            <div className="space-y-2.5">
              {moduleDefinitions.map((mod) => {
                const isEnabled = !!tenant.modules[mod.key];
                return (
                  <div
                    key={mod.key}
                    className="bg-[#20201f] border border-[#353535] p-3.5 rounded-2xl flex items-center justify-between gap-3 hover:border-[#ffb77f]/40 transition-colors"
                  >
                    <div className="flex items-start space-x-3 min-w-0">
                      <div className={`p-2 rounded-xl shrink-0 ${
                        isEnabled ? 'bg-[#ffb77f]/15 text-[#ffb77f]' : 'bg-[#131313] text-[#d5c4ab]/50'
                      }`}>
                        <span className="material-symbols-outlined text-xl">{mod.icon}</span>
                      </div>
                      <div className="min-w-0">
                        <h4 className="font-bold text-xs text-[#e5e2e1] truncate">{mod.title}</h4>
                        <p className="text-[11px] text-[#d5c4ab] line-clamp-1">{mod.desc}</p>
                      </div>
                    </div>

                    <button
                      onClick={() => toggleCompanyModule(tenant.id, mod.key)}
                      className={`px-3.5 py-1.5 rounded-xl text-xs font-mono font-bold transition-all cursor-pointer shrink-0 ${
                        isEnabled
                          ? 'bg-[#a1e8a2] text-[#412d00] shadow-sm'
                          : 'bg-[#131313] text-[#d5c4ab] border border-[#353535] hover:border-[#ffb77f]/50'
                      }`}
                    >
                      {isEnabled ? 'AÇIK' : 'KAPALI'}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Registered Sites List */}
          <div className="space-y-3 pt-2">
            <h3 className="text-xs font-extrabold text-[#e5e2e1] uppercase tracking-wider flex items-center space-x-2">
              <span className="material-symbols-outlined text-[#ffb77f] text-base">location_city</span>
              <span>Kayıtlı Şantiyeler ({tenant.sites.length})</span>
            </h3>

            <div className="space-y-2">
              {tenant.sites.map((site) => (
                <div key={site.id} className="bg-[#20201f] border border-[#353535] p-3 rounded-xl flex items-center justify-between font-mono text-xs">
                  <div>
                    <p className="font-bold text-[#e5e2e1]">{site.name}</p>
                    <p className="text-[10px] text-[#d5c4ab]">{site.location}</p>
                  </div>
                  <div className="text-right text-[10px]">
                    <span className="text-[#ffdca1] font-bold block">{site.activeVehiclesCount} Araç</span>
                    <span className="text-[#a1e8a2] font-bold block">{site.activeTanksCount} Tank</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Key Metrics Summary */}
          <div className="grid grid-cols-2 gap-3 pt-2 font-mono text-xs">
            <div className="bg-[#20201f] border border-[#353535] p-3.5 rounded-xl space-y-1">
              <span className="text-[10px] text-[#d5c4ab] font-bold uppercase block">Filo Büyüklüğü</span>
              <span className="text-lg font-black text-[#ffdca1]">{tenant.activeVehiclesCount} Kayıtlı Araç</span>
            </div>
            <div className="bg-[#20201f] border border-[#353535] p-3.5 rounded-xl space-y-1">
              <span className="text-[10px] text-[#d5c4ab] font-bold uppercase block">Aylık İkmal Hacmi</span>
              <span className="text-lg font-black text-[#a1e8a2]">
                {tenant.totalFuelThisMonth.toLocaleString('tr-TR')} LT
              </span>
            </div>
          </div>

        </div>

        {/* Modal Footer */}
        <div className="pt-4 border-t border-[#353535]">
          <button
            onClick={() => setSelectedTenantForDetail(null)}
            className="w-full py-2.5 bg-[#ffb77f] hover:bg-[#ffdca1] text-[#412d00] font-black text-xs rounded-xl transition-all cursor-pointer uppercase shadow"
          >
            Detay Panelini Kapat
          </button>
        </div>

      </div>
    </div>
  );
};
