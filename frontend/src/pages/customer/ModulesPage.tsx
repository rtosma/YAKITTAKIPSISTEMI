import React from 'react';
import { useApp } from '../../context/AppContext';

export const ModulesPage: React.FC = () => {
  const { currentCompany } = useApp();

  const moduleList = [
    {
      key: 'aiAnomaly',
      name: 'AI Hırsızlık Tespiti',
      icon: 'psychology',
      active: currentCompany.modules.aiAnomaly,
      desc: 'Anormal pompa çıkışı, gece saatlerinde beklenmeyen hareket tespiti ve debimetre-tank farkı analiz motoru.',
      features: ['Otomatik SMS & E-Posta Uyarısı', 'Gece İkmal Blokajı', 'Debimetre Sensör Doğrulama']
    },
    {
      key: 'eInvoice',
      name: 'e-İrsaliye Entegrasyonu',
      icon: 'receipt_long',
      active: currentCompany.modules.eInvoice,
      desc: 'Saha teslimatı anında GİB UBL-TR uyumlu e-İrsaliye otomatik oluşturulması ve entegratöre iletilmesi.',
      features: ['GİB UBL-TR 1.2 Formatı', 'Dijital İrsaliye PDF Oluşturucu', 'Otomatik ERP Senkronizasyonu']
    },
    {
      key: 'smartWarehouse',
      name: 'Akıllı Ambar & Depo',
      icon: 'inventory_2',
      active: currentCompany.modules.smartWarehouse,
      desc: 'Saha yedek parça, madeni yağ, filtre ve şantiye ekipman stok takibi.',
      features: ['Barkod/QR Stok Girişi', 'Kritik Stok Uyarısı', 'Şantiye Zimmet Takibi']
    },
    {
      key: 'maintenanceTrack',
      name: 'Bakım & Arıza Takibi',
      icon: 'build',
      active: currentCompany.modules.maintenanceTrack,
      desc: 'Çalışma saati ve kilometre bazlı periyodik araç bakım hatırlatıcıları.',
      features: ['Çalışma Saati Sayacı', 'Yedek Parça Aşınma Raporu', 'Servis Geçmişi Logları']
    },
    {
      key: 'driverScore',
      name: 'Şoför Performans Skoru',
      icon: 'military_tech',
      active: currentCompany.modules.driverScore,
      desc: 'Yakıt tüketim verimliliği ve rölatanti süresi analizine göre şoför sıralaması.',
      features: ['Rölanti İsraf Tespiti', 'Aylık Liderlik Tablosu', 'Tasarruf Teşvik Skorlaması']
    }
  ];

  return (
    <div className="space-y-6">
      
      {/* Header */}
      <div className="bg-[#1c1b1b] border border-[#353535] p-6 rounded-2xl flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <span className="text-[10px] font-mono text-[#ffdca1] font-bold uppercase tracking-widest">
            FİRMA LİSANSLI PAKETLER
          </span>
          <h2 className="text-xl font-extrabold text-[#e5e2e1] uppercase mt-0.5">
            Satın Alınan Ek Modüller
          </h2>
          <p className="text-xs text-[#d5c4ab] mt-1">
            {currentCompany.name} firmasına tanımlı aktif B2B SaaS yetkinlikleri
          </p>
        </div>

        <div className="text-xs font-mono font-bold text-[#ffdca1] bg-[#20201f] border border-[#353535] px-4 py-2 rounded-xl">
          Lisans Bitiş: {currentCompany.licenseExpiry}
        </div>
      </div>

      {/* Modules Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {moduleList.map(m => (
          <div key={m.key} className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 space-y-4 flex flex-col justify-between">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="w-10 h-10 rounded-xl bg-[#20201f] border border-[#353535] text-[#ffdca1] flex items-center justify-center">
                  <span className="material-symbols-outlined text-xl">{m.icon}</span>
                </div>
                <span className={`text-[10px] font-mono font-bold px-2.5 py-1 rounded ${
                  m.active
                    ? 'bg-[#a1e8a2]/10 text-[#a1e8a2] border border-[#a1e8a2]/30'
                    : 'bg-[#ffb4ab]/10 text-[#ffb4ab] border border-[#ffb4ab]/30'
                }`}>
                  {m.active ? 'PAKET AKTİF' : 'PASİF (SÜPER ADMİN YETKİSİ GEREKLİ)'}
                </span>
              </div>

              <div>
                <h3 className="text-base font-extrabold text-[#e5e2e1]">{m.name}</h3>
                <p className="text-xs text-[#d5c4ab] leading-relaxed mt-1">{m.desc}</p>
              </div>

              <div className="pt-3 border-t border-[#353535] space-y-1">
                <span className="text-[10px] font-mono text-[#ffdca1] font-bold block uppercase">
                  Modül Özellikleri:
                </span>
                <ul className="space-y-1">
                  {m.features.map((f, idx) => (
                    <li key={idx} className="text-xs text-[#d5c4ab] flex items-center space-x-2">
                      <span className="material-symbols-outlined text-sm text-[#a1e8a2]">check_circle</span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="pt-4 border-t border-[#353535] text-[11px] font-mono text-[#d5c4ab]">
              {m.active ? 'Sisteminizle tam senkronize çalışıyor.' : 'Aktivasyon için geliştirici ekibiyle iletişime geçin.'}
            </div>
          </div>
        ))}
      </div>

    </div>
  );
};
