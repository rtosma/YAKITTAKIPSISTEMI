import React, { useState, useMemo } from 'react';
import { useApp } from '../../context/AppContext';
import { SiteProvisioningResult } from '../../types';
import { EmptyState } from '../../components/EmptyState';

// FE-807 Kapsam: "Çok adımlı sihirbaz: şantiye bilgileri → konum/geofence →
// sorumlu kullanıcı → özet." "Geofence" adımı BİLİNÇLİ OLARAK atlandı:
// `sites` tablosunda enlem/boylam/yarıçap alanı YOK (yalnızca serbest metin
// `location`) ve bu frontend'de bir harita kütüphanesi hiç kurulu değil —
// gerçek bir geofence seçici eklemek yeni bir veri modeli + yeni bir
// bağımlılık gerektirir, ayrı ve daha büyük bir iş (disclosed). "Sorumlu
// kullanıcı" adımı da AYRI bir GİRİŞ formu DEĞİL: AUTH-204 kullanıcıyı
// KENDİSİ üretiyor (admin bir isim/e-posta seçmiyor) — bu adım burada
// ÖZET + tek seferlik kimlik bilgisi gösterimine dönüşüyor.
type WizardStep = 'INFO' | 'LOCATION' | 'SUMMARY' | 'CREDENTIALS';

export const SitesPage: React.FC = () => {
  const { currentCompany, setSelectedSiteFilter, isManagerMode, currentUser, tanks, vehicles, sites, siteDetails, addSite, deleteSite, showToast } = useApp();
  const [searchTerm, setSearchTerm] = useState('');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState<WizardStep>('INFO');
  const [newSiteName, setNewSiteName] = useState('');
  const [newSiteLocation, setNewSiteLocation] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  // FE-807 AC: "Parola yalnızca bir kez gösterilmeli." — yalnızca bu
  // bileşenin local state'inde tutulur, hiçbir yerde kalıcılaştırılmaz.
  const [provisionResult, setProvisionResult] = useState<SiteProvisioningResult | null>(null);
  const [siteToDelete, setSiteToDelete] = useState<string | null>(null);

  const closeWizard = () => {
    setIsAddModalOpen(false);
    setWizardStep('INFO');
    setNewSiteName('');
    setNewSiteLocation('');
    setProvisionResult(null);
  };

  const handleFinalSubmit = async () => {
    if (!newSiteName.trim()) return;
    setIsSaving(true);
    try {
      // FE-807 AC: "Yarıda bırakılan sihirbaz kayıt oluşturmamalıdır." —
      // önceki adımlar (İSİM/KONUM) yalnızca istemci state'i topluyor; TEK
      // bir POST /sites çağrısı (AUTH-204, kendi transaction'ında atomik:
      // şantiye+kullanıcı ya BİRLİKTE oluşur ya HİÇ) burada, en sonda
      // yapılıyor — ara adımlarda kısmi bir backend kaydı YOK.
      const result = await addSite(newSiteName.trim(), newSiteLocation.trim() || undefined);
      if (result) {
        setProvisionResult(result);
        setWizardStep('CREDENTIALS');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const copyCredentials = () => {
    if (!provisionResult) return;
    const text = `Kullanıcı adı: ${provisionResult.username}\nGeçici parola: ${provisionResult.temporaryPassword}`;
    navigator.clipboard?.writeText(text)
      .then(() => showToast('Kimlik bilgileri panoya kopyalandı.'))
      .catch(() => showToast('Kopyalama başarısız — elle kopyalayın.', 'error'));
  };

  const printCredentials = () => window.print();

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
      // FE-807: GERÇEK konum (sites tablosundan, GET /sites/details) — önceden
      // her şantiye için sabit 'Türkiye' gösteriliyordu (AUTH-204/sihirbazın
      // kaydettiği konum HİÇ okunmuyordu). `sites` tablosunda kaydı olmayan
      // "hayalet" adlar (yalnızca araç/tank/şoförden referans edilen) için
      // dürüst bir varsayılana düşer.
      const detail = siteDetails.find(d => d.name === siteName);

      return {
        id: detail?.id || `site-dyn-${index}`,
        name: siteName,
        location: detail?.location || 'Türkiye',
        activeTanksCount: siteTanks.length,
        activeVehiclesCount: siteVehicles.length
      };
    });
  }, [sites, siteDetails, tanks, vehicles, isManagerMode, currentUser]);

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
              data-testid="site-add-open"
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
            data-testid="site-card"
            data-site-name={site.name}
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
          <div className="col-span-full">
            <EmptyState
              icon="location_city"
              title={dynamicSites.length === 0 ? 'Henüz şantiye eklenmedi.' : 'Arama kriterlerine uygun şantiye bulunamadı.'}
              description={dynamicSites.length === 0 ? 'İlk şantiyenizi oluşturarak başlayın.' : undefined}
              actionLabel={dynamicSites.length === 0 ? 'İlk Şantiyenizi Oluşturun' : undefined}
              onAction={dynamicSites.length === 0 ? () => setIsAddModalOpen(true) : undefined}
              testId="sites-empty"
            />
          </div>
        )}
      </div>

      {/* MODAL: ADD NEW SITE — çok adımlı sihirbaz (FE-807) */}
      {isAddModalOpen && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#1c1b1b] border border-[#514532]/30 rounded-xl p-6 max-w-md w-full space-y-6">
            <div className="flex items-center justify-between border-b border-[#514532]/20 pb-4">
              <h3 className="text-base font-bold text-[#e5e2e1] uppercase flex items-center space-x-2">
                <span className="material-symbols-outlined text-[#ffdca1]">add_location_alt</span>
                <span>
                  {wizardStep === 'CREDENTIALS' ? 'Şantiye Oluşturuldu' : 'Yeni Şantiye / Tesis Ekle'}
                </span>
              </h3>
              <button onClick={closeWizard} className="text-[#d5c4ab] hover:text-[#e5e2e1]">
                <span className="material-symbols-outlined text-lg">close</span>
              </button>
            </div>

            {/* Adım göstergesi */}
            {wizardStep !== 'CREDENTIALS' && (
              <div className="flex items-center space-x-2 text-[10px] font-mono">
                {(['INFO', 'LOCATION', 'SUMMARY'] as const).map((step, i) => (
                  <React.Fragment key={step}>
                    {i > 0 && <span className="text-[#514532]">→</span>}
                    <span className={wizardStep === step ? 'text-[#ffdca1] font-bold' : 'text-[#d5c4ab]/50'}>
                      {i + 1}. {step === 'INFO' ? 'Bilgiler' : step === 'LOCATION' ? 'Konum' : 'Özet'}
                    </span>
                  </React.Fragment>
                ))}
              </div>
            )}

            {wizardStep === 'INFO' && (
              <div className="space-y-4">
                <div>
                  <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Şantiye / Tesis Adı</label>
                  <input
                    type="text"
                    placeholder="Örn: Silivri Tesisleri, Ankara Şantiyesi"
                    data-testid="site-name-input"
                    value={newSiteName}
                    onChange={(e) => setNewSiteName(e.target.value)}
                    className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                    required
                    autoFocus
                  />
                </div>
                <div className="pt-4 border-t border-[#514532]/20 flex items-center justify-end space-x-3">
                  <button type="button" onClick={closeWizard} className="px-4 py-2 bg-[#20201f] text-[#d5c4ab] rounded-md text-xs font-bold">
                    İptal
                  </button>
                  <button
                    type="button"
                    data-testid="site-wizard-next"
                    disabled={!newSiteName.trim()}
                    onClick={() => setWizardStep('LOCATION')}
                    className="px-5 py-2 bg-gradient-to-r from-[#ffb800] to-[#ff8a00] text-[#412d00] rounded-md text-xs font-black disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    İleri →
                  </button>
                </div>
              </div>
            )}

            {wizardStep === 'LOCATION' && (
              <div className="space-y-4">
                <div>
                  <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Konum / Adres</label>
                  <input
                    type="text"
                    placeholder="Örn: Gebze OSB 4. Cadde, Kocaeli"
                    data-testid="site-location-input"
                    value={newSiteLocation}
                    onChange={(e) => setNewSiteLocation(e.target.value)}
                    className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                    autoFocus
                  />
                  <p className="text-[10px] text-[#d5c4ab]/70 font-mono mt-1.5">
                    Boş bırakılırsa varsayılan olarak "Türkiye" kaydedilir.
                  </p>
                </div>
                <div className="pt-4 border-t border-[#514532]/20 flex items-center justify-between">
                  <button type="button" onClick={() => setWizardStep('INFO')} className="px-4 py-2 bg-[#20201f] text-[#d5c4ab] rounded-md text-xs font-bold">
                    ← Geri
                  </button>
                  <button
                    type="button"
                    data-testid="site-wizard-next"
                    onClick={() => setWizardStep('SUMMARY')}
                    className="px-5 py-2 bg-gradient-to-r from-[#ffb800] to-[#ff8a00] text-[#412d00] rounded-md text-xs font-black"
                  >
                    İleri →
                  </button>
                </div>
              </div>
            )}

            {wizardStep === 'SUMMARY' && (
              <div className="space-y-4">
                <div className="bg-[#0e0e0e] border border-[#514532]/30 rounded-md p-4 space-y-2 text-xs font-mono">
                  <div className="flex justify-between"><span className="text-[#d5c4ab]">Şantiye Adı:</span><span className="text-[#e5e2e1] font-bold">{newSiteName}</span></div>
                  <div className="flex justify-between"><span className="text-[#d5c4ab]">Konum:</span><span className="text-[#e5e2e1] font-bold">{newSiteLocation.trim() || 'Türkiye'}</span></div>
                </div>
                <p className="text-[10px] text-[#d5c4ab]/70 font-mono">
                  Onaylarsanız şantiye VE onun şantiye yöneticisi kullanıcı hesabı tek işlemde oluşturulur; sonraki ekranda gösterilen geçici parola yalnızca BİR KEZ görüntülenebilir.
                </p>
                <div className="pt-4 border-t border-[#514532]/20 flex items-center justify-between">
                  <button type="button" onClick={() => setWizardStep('LOCATION')} disabled={isSaving} className="px-4 py-2 bg-[#20201f] text-[#d5c4ab] rounded-md text-xs font-bold disabled:opacity-40">
                    ← Geri
                  </button>
                  <button
                    type="button"
                    data-testid="site-save"
                    disabled={isSaving}
                    onClick={handleFinalSubmit}
                    className="px-5 py-2 bg-gradient-to-r from-[#ffb800] to-[#ff8a00] text-[#412d00] rounded-md text-xs font-black disabled:opacity-60"
                  >
                    {isSaving ? 'Oluşturuluyor...' : 'Şantiyeyi Kaydet'}
                  </button>
                </div>
              </div>
            )}

            {wizardStep === 'CREDENTIALS' && provisionResult && (
              <div className="space-y-4" data-testid="site-credentials-panel">
                <div className="p-3 bg-[#ff5f56]/10 border border-[#ff5f56]/30 rounded-xl text-[11px] text-[#ffdca1] font-mono leading-relaxed">
                  ⚠️ Bu parola yalnızca ŞİMDİ gösterilir, bir daha görüntülenemez. Kapatmadan önce kaydedin, kopyalayın veya yazdırın.
                </div>
                <div className="print-area space-y-2 font-mono text-xs">
                  <p className="hidden print:block font-bold text-sm mb-2">{currentCompany.name} — {newSiteName} Şantiye Yöneticisi Kimlik Bilgileri</p>
                  <div className="bg-[#131313] border border-[#353535] rounded-xl p-3">
                    <span className="text-[10px] text-[#d5c4ab] block mb-0.5">Kullanıcı Adı</span>
                    <span data-testid="site-manager-username" className="text-[#e5e2e1] font-bold text-sm">{provisionResult.username}</span>
                  </div>
                  <div className="bg-[#131313] border border-[#353535] rounded-xl p-3">
                    <span className="text-[10px] text-[#d5c4ab] block mb-0.5">Geçici Parola</span>
                    <span data-testid="site-manager-temp-password" className="text-[#a1e8a2] font-black text-sm select-all">{provisionResult.temporaryPassword}</span>
                  </div>
                  <p className="text-[10px] text-[#d5c4ab] px-1">
                    Geçerlilik: {new Date(provisionResult.passwordExpiresAt).toLocaleString('tr-TR')}'e kadar — ilk girişte değiştirilmesi zorunludur.
                  </p>
                </div>
                <div className="pt-4 border-t border-[#514532]/20 flex items-center justify-end space-x-3">
                  <button
                    type="button"
                    onClick={printCredentials}
                    className="px-4 py-2.5 bg-[#20201f] hover:bg-[#282726] border border-[#514532]/30 text-[#d5c4ab] rounded-md text-xs font-bold flex items-center space-x-1.5"
                  >
                    <span className="material-symbols-outlined text-base">print</span>
                    <span>Yazdır</span>
                  </button>
                  <button
                    type="button"
                    data-testid="site-credentials-copy"
                    onClick={copyCredentials}
                    className="px-4 py-2.5 bg-[#20201f] hover:bg-[#282726] border border-[#514532]/30 text-[#ffdca1] rounded-md text-xs font-bold flex items-center space-x-1.5"
                  >
                    <span className="material-symbols-outlined text-base">content_copy</span>
                    <span>Kopyala</span>
                  </button>
                  <button
                    type="button"
                    data-testid="site-credentials-done"
                    onClick={closeWizard}
                    className="px-5 py-2.5 bg-gradient-to-r from-[#ffb800] to-[#ff8a00] text-[#412d00] rounded-md text-xs font-black"
                  >
                    Kaydettim, Kapat
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* MODAL: DELETE SITE CONFIRMATION */}
      {siteToDelete && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
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
