import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { TenantDetailModal } from '../../components/TenantDetailModal';
import { TenantProvisioningResult } from '../../types';

// FE-805 AC: "son aktivite" — göreli/okunur Türkçe biçim (bu proje boyunca
// başka bir yerde relative-time yardımcı fonksiyonu yok, bu yüzden yerel).
function formatLastActivity(iso: string | null): string {
  if (!iso) return 'Hiç ikmal yapılmadı';
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'Az önce';
  if (diffMin < 60) return `${diffMin} dk önce`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} sa önce`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 30) return `${diffDay} gün önce`;
  return new Date(iso).toLocaleDateString('tr-TR');
}

export const TenantsPage: React.FC = () => {
  const { companies, addCompany, setSelectedTenantForDetail, showToast } = useApp();
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [taxNumber, setTaxNumber] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  // FE-805 AC: "parola tek seferlik gösterilmelidir" + Teknik Not: "sayfadan
  // ayrılınca bir daha gösterilmemelidir." — yalnızca oluşturma anındaki bu
  // state'te tutulur, hiçbir yerde kalıcılaştırılmaz (localStorage/context yok).
  const [provisionResult, setProvisionResult] = useState<TenantProvisioningResult | null>(null);

  const filteredCompanies = companies.filter(c =>
    !searchTerm.trim() ||
    c.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.city.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const result = await addCompany({
      name: name.trim(),
      city: city || 'İstanbul',
      taxNumber: taxNumber || '1234567890'
    });

    setName('');
    setCity('');
    setTaxNumber('');
    if (result) {
      // Formdan tek seferlik parola ekranına geç — sihirbaz henüz kapanmıyor.
      setProvisionResult(result);
    } else {
      setIsAddOpen(false);
    }
  };

  const closeWizard = () => {
    setIsAddOpen(false);
    setProvisionResult(null);
  };

  const copyCredentials = () => {
    if (!provisionResult) return;
    const text = `Kullanıcı adı: ${provisionResult.ownerUsername}\nGeçici parola: ${provisionResult.temporaryPassword}`;
    navigator.clipboard?.writeText(text)
      .then(() => showToast('Kimlik bilgileri panoya kopyalandı.'))
      .catch(() => showToast('Kopyalama başarısız — elle kopyalayın.', 'error'));
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
          data-testid="tenant-add-open"
          onClick={() => setIsAddOpen(true)}
          className="bg-[#ffb77f] text-[#412d00] font-black px-4 py-2.5 rounded-xl text-xs flex items-center space-x-2 transition-all cursor-pointer shadow"
        >
          <span className="material-symbols-outlined text-lg">domain_add</span>
          <span>Yeni Firma Ekle</span>
        </button>
      </div>

      {/* Quick Search */}
      <div className="bg-[#1c1b1b] border border-[#514532]/25 p-4 rounded-xl">
        <div className="relative w-full sm:w-80">
          <input
            type="text"
            data-testid="tenant-search-input"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Firma adı, kodu veya şehir ara..."
            className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md pl-9 pr-3 py-2.5 focus:outline-none focus:border-[#ffdca1]"
          />
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[#d5c4ab] text-sm">
            search
          </span>
        </div>
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
              <th className="py-3.5 px-4">Son Aktivite</th>
              <th className="py-3.5 px-4">Lisans Durumu</th>
              <th className="py-3.5 px-4 text-right">İşlemler</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#353535] font-mono">
            {filteredCompanies.map(c => (
              <tr key={c.id} data-testid="tenant-row" data-tenant-name={c.name} data-tenant-id={c.id} className="hover:bg-[#282726] transition-colors">
                <td className="py-3.5 px-4 font-black text-[#ffb77f] text-sm">{c.code}</td>
                <td className="py-3.5 px-4 font-bold text-[#e5e2e1] text-sm">{c.name}</td>
                <td className="py-3.5 px-4 text-[#d5c4ab]">{c.city} / {c.taxNumber}</td>
                <td className="py-3.5 px-4 text-[#e5e2e1]">{c.sites.length} Şantiye</td>
                <td className="py-3.5 px-4 text-[#ffdca1] font-bold">{c.activeVehiclesCount} Araç</td>
                <td className="py-3.5 px-4 text-[#a1e8a2] font-bold">
                  {c.totalFuelThisMonth.toLocaleString('tr-TR')} Litre
                </td>
                <td className="py-3.5 px-4 text-[#d5c4ab]" data-testid="tenant-last-activity">
                  {formatLastActivity(c.lastActivityAt)}
                </td>
                <td className="py-3.5 px-4">
                  <span className="text-[10px] font-bold px-2.5 py-1 rounded bg-[#a1e8a2]/10 text-[#a1e8a2] border border-[#a1e8a2]/30">
                    {c.licenseStatus}
                  </span>
                </td>
                <td className="py-3.5 px-4 text-right">
                  <button
                    data-testid="tenant-detail-open"
                    onClick={() => setSelectedTenantForDetail(c)}
                    className="px-3 py-1.5 bg-[#20201f] hover:bg-[#282726] border border-[#353535] text-[#ffb77f] font-bold text-xs rounded-xl cursor-pointer"
                  >
                    Detay & Modüller
                  </button>
                </td>
              </tr>
            ))}

            {filteredCompanies.length === 0 && (
              <tr>
                <td colSpan={8} className="py-12 text-center text-[#d5c4ab]">
                  Aramayla eşleşen firma bulunamadı.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ADD COMPANY MODAL */}
      {isAddOpen && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 max-w-md w-full space-y-6">
            <div className="flex items-center justify-between border-b border-[#353535] pb-4">
              <h3 className="text-base font-extrabold text-[#e5e2e1] uppercase tracking-wider flex items-center space-x-2">
                <span className="material-symbols-outlined text-[#ffb77f]">domain_add</span>
                <span>{provisionResult ? 'Firma Oluşturuldu' : 'Yeni Kiracı Firma Kaydı'}</span>
              </h3>
              <button onClick={closeWizard} className="text-[#d5c4ab] hover:text-[#e5e2e1]">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            {provisionResult ? (
              // FE-805 AC: "parola tek seferlik gösterilmelidir" — bu ekran,
              // bu sihirbaz kapatıldıktan sonra BİR DAHA gösterilemez
              // (provisionResult yalnızca bu bileşenin local state'inde,
              // kalıcılaştırılmıyor; kaybedilirse parola sıfırlama akışı kullanılır).
              <div className="space-y-4" data-testid="tenant-credentials-panel">
                <div className="p-3 bg-[#ff5f56]/10 border border-[#ff5f56]/30 rounded-xl text-[11px] text-[#ffdca1] font-mono leading-relaxed">
                  ⚠️ Bu parola yalnızca ŞİMDİ gösterilir, bir daha görüntülenemez. Kapatmadan önce kaydedin veya kopyalayın.
                </div>
                <div className="space-y-2 font-mono text-xs">
                  <div className="bg-[#131313] border border-[#353535] rounded-xl p-3">
                    <span className="text-[10px] text-[#d5c4ab] block mb-0.5">Kullanıcı Adı</span>
                    <span data-testid="tenant-owner-username" className="text-[#e5e2e1] font-bold text-sm">{provisionResult.ownerUsername}</span>
                  </div>
                  <div className="bg-[#131313] border border-[#353535] rounded-xl p-3">
                    <span className="text-[10px] text-[#d5c4ab] block mb-0.5">Geçici Parola</span>
                    <span data-testid="tenant-temp-password" className="text-[#a1e8a2] font-black text-sm select-all">{provisionResult.temporaryPassword}</span>
                  </div>
                  <p className="text-[10px] text-[#d5c4ab] px-1">
                    Geçerlilik: {new Date(provisionResult.passwordExpiresAt).toLocaleString('tr-TR')}'e kadar — ilk girişte değiştirilmesi zorunludur.
                  </p>
                </div>
                <div className="pt-4 border-t border-[#353535] flex items-center justify-end space-x-3">
                  <button
                    type="button"
                    data-testid="tenant-credentials-copy"
                    onClick={copyCredentials}
                    className="px-4 py-2.5 bg-[#20201f] hover:bg-[#282726] border border-[#353535] text-[#ffb77f] rounded-xl text-xs font-bold flex items-center space-x-1.5"
                  >
                    <span className="material-symbols-outlined text-base">content_copy</span>
                    <span>Kopyala</span>
                  </button>
                  <button
                    type="button"
                    data-testid="tenant-credentials-done"
                    onClick={closeWizard}
                    className="px-5 py-2.5 bg-[#ffb77f] text-[#412d00] rounded-xl text-xs font-black"
                  >
                    Kaydettim, Kapat
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleSave} className="space-y-4">
                <div>
                  <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Firma Ünvanı</label>
                  <input
                    type="text"
                    data-testid="tenant-name-input"
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
                    data-testid="tenant-city-input"
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
                    data-testid="tenant-tax-input"
                    value={taxNumber}
                    onChange={(e) => setTaxNumber(e.target.value)}
                    placeholder="10 haneli VKN"
                    className="w-full bg-[#131313] border border-[#353535] text-[#e5e2e1] font-mono text-xs rounded-xl p-3 focus:outline-none focus:border-[#ffb77f]"
                  />
                </div>

                <div className="pt-4 border-t border-[#353535] flex items-center justify-end space-x-3">
                  <button
                    type="button"
                    onClick={closeWizard}
                    className="px-4 py-2.5 bg-[#20201f] text-[#d5c4ab] rounded-xl text-xs font-bold"
                  >
                    İptal
                  </button>
                  <button
                    type="submit"
                    data-testid="tenant-save"
                    className="px-5 py-2.5 bg-[#ffb77f] text-[#412d00] rounded-xl text-xs font-black"
                  >
                    Firmayı Kaydet
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* TENANT DETAIL MODAL */}
      <TenantDetailModal />

    </div>
  );
};
