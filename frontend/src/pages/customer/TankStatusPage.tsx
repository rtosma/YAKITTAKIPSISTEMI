import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { TankGauge } from '../../components/TankGauge';
import { Tank, StrappingUploadError } from '../../types';
import { EmptyState } from '../../components/EmptyState';

export const TankStatusPage: React.FC = () => {
  const { tanks, selectedSiteFilter, tankRefreshKey, triggerTankRefresh, addTank, updateTank, deleteTank, currentCompany, isManagerMode, currentUser, sites, isSocketConnected, uploadTankStrappingTable } = useApp();

  // FE-809 AC: "Strapping table yüklemesi hata raporuyla birlikte çalışmalıdır."
  const [strappingTank, setStrappingTank] = useState<Tank | null>(null);
  const [strappingCsv, setStrappingCsv] = useState('');
  const [strappingErrors, setStrappingErrors] = useState<StrappingUploadError[] | null>(null);
  const [strappingSuccess, setStrappingSuccess] = useState(false);
  const [isUploadingStrapping, setIsUploadingStrapping] = useState(false);

  const openStrappingModal = (tank: Tank) => {
    setStrappingTank(tank);
    setStrappingCsv('');
    setStrappingErrors(null);
    setStrappingSuccess(false);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setStrappingCsv(String(reader.result || ''));
    reader.readAsText(file);
  };

  const handleUploadStrapping = async () => {
    if (!strappingTank || !strappingCsv.trim()) return;
    setIsUploadingStrapping(true);
    setStrappingErrors(null);
    try {
      const errors = await uploadTankStrappingTable(strappingTank.id, strappingCsv);
      if (errors.length === 0) {
        setStrappingSuccess(true);
      } else {
        setStrappingErrors(errors);
      }
    } finally {
      setIsUploadingStrapping(false);
    }
  };

  const availableSites = Array.from(new Set([...sites, ...currentCompany.sites.map(s => s.name)])).filter(Boolean);

  // Modal states
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [editingTank, setEditingTank] = useState<Tank | null>(null);
  const [deletingTank, setDeletingTank] = useState<Tank | null>(null);

  // Form states
  const [tankName, setTankName] = useState('');
  const [siteName, setSiteName] = useState(availableSites[0] || 'Gebze Ana Şantiye');
  const [capacityLiters, setCapacityLiters] = useState(15000);
  const [currentLevelLiters, setCurrentLevelLiters] = useState(12000);
  const [fuelType, setFuelType] = useState<'Motorin (Euro Diesel)' | 'Benzin (95)'>('Motorin (Euro Diesel)');

  const filteredTanks = selectedSiteFilter === 'TÜMÜ'
    ? tanks
    : tanks.filter(t => t.siteName === selectedSiteFilter);

  const handleOpenAddModal = () => {
    setTankName('');
    setSiteName(!isManagerMode && currentUser?.siteName ? currentUser.siteName : (selectedSiteFilter === 'TÜMÜ' ? currentCompany.sites[0]?.name || 'Gebze Ana Şantiye' : selectedSiteFilter));
    setCapacityLiters(15000);
    setCurrentLevelLiters(12000);
    setFuelType('Motorin (Euro Diesel)');
    setIsAddModalOpen(true);
  };

  const handleSaveAddTank = (e: React.FormEvent) => {
    e.preventDefault();
    if (!tankName.trim()) return;

    addTank({
      name: tankName,
      siteName,
      capacityLiters: Number(capacityLiters),
      currentLevelLiters: Number(currentLevelLiters),
      fuelType,
      temperatureC: 18.5,
      lastRefillDate: new Date().toISOString().split('T')[0],
      sensorId: `ESP32_TANK_0${tanks.length + 1}`,
      status: (currentLevelLiters / capacityLiters) < 0.2 ? 'KRİTİK' : (currentLevelLiters / capacityLiters) < 0.4 ? 'UYARI' : 'GÜVENLİ'
    });

    setIsAddModalOpen(false);
  };

  const handleOpenEditModal = (tank: Tank) => {
    setEditingTank(tank);
    setTankName(tank.name);
    setSiteName(tank.siteName);
    setCapacityLiters(tank.capacityLiters);
    setCurrentLevelLiters(tank.currentLevelLiters);
    setFuelType(tank.fuelType);
  };

  const handleSaveEditTank = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTank || !tankName.trim()) return;

    updateTank(editingTank.id, {
      name: tankName,
      siteName,
      capacityLiters: Number(capacityLiters),
      currentLevelLiters: Number(currentLevelLiters),
      fuelType
    });

    setEditingTank(null);
  };

  const handleConfirmDelete = () => {
    if (deletingTank) {
      deleteTank(deletingTank.id);
      setDeletingTank(null);
    }
  };

  return (
    <div className="space-y-8">

      {/* FE-801 AC: "Eski veri açıkça işaretlenmelidir." — canlı bağlantı
          kesikken (kopuk/yeniden bağlanıyor/sekme arka planda) aşağıdaki
          seviyelerin ARTIK CANLI OLARAK doğrulanamadığını açıkça söyler. */}
      {!isSocketConnected && (
        <div className="bg-[#93000a]/10 border border-[#93000a]/40 rounded-xl p-3.5 flex items-center gap-2.5 text-xs font-bold text-[#ffb4ab]">
          <span className="material-symbols-outlined text-lg">wifi_off</span>
          <span>Canlı bağlantı kesik — aşağıdaki tank seviyeleri ESKİ (doğrulanmamış) olabilir.</span>
        </div>
      )}

      {/* SECTION 5.1 Sayfa Başlığı */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 bg-[#1c1b1b] border border-[#514532]/25 p-6 md:p-8 rounded-xl">
        <div className="space-y-1.5">
          <span className="text-xs font-mono font-bold text-[#ffdca1] uppercase tracking-widest block">
            TELEMETRİ & DEPO YÖNETİMİ
          </span>
          <h1 className="text-2xl md:text-3xl font-black text-[#e5e2e1] uppercase tracking-tight">
            TANK VE REZERV DURUMU
          </h1>
          <p className="text-sm text-[#d5c4ab]">
            Depolama ünitelerinin anlık doluluk oranları ve rezerv takibi.
          </p>
        </div>

        {/* Action Buttons: "+ Yeni Tank Ekle" (Primary) & "Verileri Yenile" (Secondary/Ghost) */}
        <div className="flex items-center space-x-3 shrink-0">
          <button
            onClick={triggerTankRefresh}
            className="px-4 py-2.5 bg-[#20201f] hover:bg-[#2a2a2a] border border-[#514532]/30 text-[#e5e2e1] hover:text-[#ffdca1] rounded-md text-xs font-bold transition-colors flex items-center space-x-2 cursor-pointer"
          >
            <span className="material-symbols-outlined text-base">refresh</span>
            <span>Verileri Yenile</span>
          </button>

          <button
            onClick={handleOpenAddModal}
            className="px-5 py-2.5 bg-gradient-to-r from-[#ffb800] to-[#ff8a00] hover:from-[#ffdca1] hover:to-[#ffb77f] text-[#412d00] rounded-md text-xs font-black transition-all flex items-center space-x-2 shadow-sm cursor-pointer"
          >
            <span className="material-symbols-outlined text-base font-bold">add</span>
            <span>+ Yeni Tank Ekle</span>
          </button>
        </div>
      </div>

      {/* SECTION 5.2 Tank Kartı Grid'i (grid grid-cols-3 gap-8) */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
        {filteredTanks.map((tank, idx) => (
          <TankGauge
            key={`${tank.id}-${tankRefreshKey}`}
            tank={tank}
            index={idx}
            variant="detailed"
            siteFilter={selectedSiteFilter}
            refreshKey={tankRefreshKey}
            onEdit={handleOpenEditModal}
            onDelete={(t) => setDeletingTank(t)}
            onUploadStrapping={openStrappingModal}
          />
        ))}

        {filteredTanks.length === 0 && (
          <div className="col-span-full">
            <EmptyState
              icon="oil_barrel"
              title={tanks.length === 0 ? 'Henüz tank eklenmedi.' : 'Bu şantiyeye kayıtlı tank bulunamadı.'}
              description={tanks.length === 0 ? 'İlk tankınızı ekleyerek başlayın.' : undefined}
              actionLabel={tanks.length === 0 ? 'İlk Tankınızı Ekleyin' : undefined}
              onAction={tanks.length === 0 ? handleOpenAddModal : undefined}
              testId="tanks-empty"
            />
          </div>
        )}
      </div>

      {/* MODAL 1: ADD TANK */}
      {isAddModalOpen && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#1c1b1b] border border-[#514532]/30 rounded-xl p-6 max-w-md w-full space-y-6">
            <div className="flex items-center justify-between border-b border-[#514532]/20 pb-4">
              <h3 className="text-base font-bold text-[#e5e2e1] uppercase flex items-center space-x-2">
                <span className="material-symbols-outlined text-[#ffdca1]">database</span>
                <span>Yeni Tank Ekle</span>
              </h3>
              <button onClick={() => setIsAddModalOpen(false)} className="text-[#d5c4ab] hover:text-[#e5e2e1]">
                <span className="material-symbols-outlined text-lg">close</span>
              </button>
            </div>

            <form onSubmit={handleSaveAddTank} className="space-y-4">
              <div>
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Tank Adı</label>
                <input
                  type="text"
                  value={tankName}
                  onChange={(e) => setTankName(e.target.value)}
                  placeholder="örn. B Şantiyesi Tankı"
                  className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                  required
                />
              </div>

              <div>
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Bağlı Şantiye</label>
                {isManagerMode ? (
                  <select
                    value={siteName}
                    onChange={(e) => setSiteName(e.target.value)}
                    className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                  >
                    {availableSites.map(sName => (
                      <option key={sName} value={sName} className="bg-[#1c1b1b]">
                        {sName}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="w-full bg-[#0e0e0e] border border-[#a1e8a2]/30 text-[#a1e8a2] text-xs rounded-md p-3 font-bold flex items-center space-x-1.5 select-none">
                    <span className="material-symbols-outlined text-sm">lock</span>
                    <span>{currentUser?.siteName || selectedSiteFilter}</span>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Maksimum Kapasite (L)</label>
                  <input
                    type="number"
                    value={capacityLiters}
                    onChange={(e) => setCapacityLiters(Number(e.target.value))}
                    className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] font-mono text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                    required
                  />
                </div>
                <div>
                  <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Mevcut Seviye (L)</label>
                  <input
                    type="number"
                    value={currentLevelLiters}
                    onChange={(e) => setCurrentLevelLiters(Number(e.target.value))}
                    className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] font-mono text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Yakıt Türü</label>
                <select
                  value={fuelType}
                  onChange={(e) => setFuelType(e.target.value as any)}
                  className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                >
                  <option value="Motorin (Euro Diesel)">Motorin (Euro Diesel)</option>
                  <option value="Benzin (95)">Benzin (95)</option>
                </select>
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
                  Kaydet
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 2: EDIT TANK */}
      {editingTank && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#1c1b1b] border border-[#514532]/30 rounded-xl p-6 max-w-md w-full space-y-6">
            <div className="flex items-center justify-between border-b border-[#514532]/20 pb-4">
              <h3 className="text-base font-bold text-[#e5e2e1] uppercase flex items-center space-x-2">
                <span className="material-symbols-outlined text-[#ffdca1]">edit</span>
                <span>Tank Düzenle</span>
              </h3>
              <button onClick={() => setEditingTank(null)} className="text-[#d5c4ab] hover:text-[#e5e2e1]">
                <span className="material-symbols-outlined text-lg">close</span>
              </button>
            </div>

            <form onSubmit={handleSaveEditTank} className="space-y-4">
              <div>
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Tank Adı</label>
                <input
                  type="text"
                  value={tankName}
                  onChange={(e) => setTankName(e.target.value)}
                  className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                  required
                />
              </div>

              <div>
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Bağlı Şantiye</label>
                {isManagerMode ? (
                  <select
                    value={siteName}
                    onChange={(e) => setSiteName(e.target.value)}
                    className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                  >
                    {availableSites.map(sName => (
                      <option key={sName} value={sName} className="bg-[#1c1b1b]">
                        {sName}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="w-full bg-[#0e0e0e] border border-[#a1e8a2]/30 text-[#a1e8a2] text-xs rounded-md p-3 font-bold flex items-center space-x-1.5 select-none">
                    <span className="material-symbols-outlined text-sm">lock</span>
                    <span>{currentUser?.siteName || selectedSiteFilter}</span>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Maksimum Kapasite (L)</label>
                  <input
                    type="number"
                    value={capacityLiters}
                    onChange={(e) => setCapacityLiters(Number(e.target.value))}
                    className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] font-mono text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                    required
                  />
                </div>
                <div>
                  <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Mevcut Seviye (L)</label>
                  <input
                    type="number"
                    value={currentLevelLiters}
                    onChange={(e) => setCurrentLevelLiters(Number(e.target.value))}
                    className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] font-mono text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                    required
                  />
                </div>
              </div>

              <div className="pt-4 border-t border-[#514532]/20 flex items-center justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setEditingTank(null)}
                  className="px-4 py-2 bg-[#20201f] text-[#d5c4ab] rounded-md text-xs font-bold"
                >
                  İptal
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 bg-gradient-to-r from-[#ffb800] to-[#ff8a00] text-[#412d00] rounded-md text-xs font-black"
                >
                  Güncelle
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 3: CONFIRM DELETE TANK */}
      {deletingTank && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#1c1b1b] border border-[#514532]/30 rounded-xl p-6 max-w-sm w-full space-y-4 text-center">
            <div className="w-12 h-12 bg-[#93000a]/20 border border-[#93000a] text-[#ffb4ab] rounded-full flex items-center justify-center mx-auto">
              <span className="material-symbols-outlined text-2xl">warning</span>
            </div>

            <h3 className="text-base font-bold text-[#e5e2e1]">Tank Silinsin mi?</h3>
            <p className="text-xs text-[#d5c4ab]">
              <span className="font-bold text-[#e5e2e1]">{deletingTank.name}</span> kaydı silinecektir. Bu işlem geri alınamaz.
            </p>

            <div className="pt-4 flex items-center justify-center space-x-3">
              <button
                onClick={() => setDeletingTank(null)}
                className="px-4 py-2 bg-[#20201f] text-[#d5c4ab] rounded-md text-xs font-bold"
              >
                İptal
              </button>
              <button
                onClick={handleConfirmDelete}
                className="px-5 py-2 bg-[#93000a] hover:bg-[#b5000d] text-[#ffdad6] rounded-md text-xs font-black"
              >
                Sil ve Kaldır
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 4: UPLOAD STRAPPING TABLE (FE-809) */}
      {strappingTank && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#1c1b1b] border border-[#514532]/30 rounded-xl p-6 max-w-lg w-full space-y-4" data-testid="strapping-upload-modal">
            <div className="flex items-center justify-between border-b border-[#514532]/20 pb-4">
              <h3 className="text-base font-bold text-[#e5e2e1] uppercase flex items-center space-x-2">
                <span className="material-symbols-outlined text-[#ffdca1]">upload_file</span>
                <span>Daldırma Cetveli Yükle — {strappingTank.name}</span>
              </h3>
              <button onClick={() => setStrappingTank(null)} className="text-[#d5c4ab] hover:text-[#e5e2e1]">
                <span className="material-symbols-outlined text-lg">close</span>
              </button>
            </div>

            {strappingSuccess ? (
              <div className="space-y-4 text-center py-4">
                <span className="material-symbols-outlined text-4xl text-[#a1e8a2]">check_circle</span>
                <p className="text-sm text-[#e5e2e1] font-bold">Cetvel başarıyla kaydedildi.</p>
                <button
                  onClick={() => setStrappingTank(null)}
                  className="px-5 py-2.5 bg-gradient-to-r from-[#ffb800] to-[#ff8a00] text-[#412d00] rounded-md text-xs font-black cursor-pointer"
                >
                  Kapat
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-[10px] text-[#d5c4ab]/70 font-mono">
                  Format: her satır "mm,litre" (veya ";" ile) — mm KESİN ARTAN, litre AZALMAYAN olmalı. İlk satır başlık olabilir, "#" ile başlayan satırlar yorum sayılır.
                </p>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  data-testid="strapping-file-input"
                  onChange={handleFileSelect}
                  className="w-full text-xs text-[#d5c4ab] file:mr-3 file:py-2 file:px-3 file:rounded-md file:border-0 file:bg-[#20201f] file:text-[#ffdca1] file:text-xs file:font-bold file:cursor-pointer cursor-pointer"
                />
                <textarea
                  data-testid="strapping-csv-textarea"
                  value={strappingCsv}
                  onChange={(e) => setStrappingCsv(e.target.value)}
                  placeholder={'mm,litre\n0,0\n500,1250\n1000,2600\n...'}
                  rows={6}
                  className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] font-mono text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                />

                {strappingErrors && strappingErrors.length > 0 && (
                  <div data-testid="strapping-error-report" className="bg-[#93000a]/10 border border-[#93000a]/40 rounded-md p-3 space-y-1.5 max-h-40 overflow-y-auto">
                    <p className="text-[11px] font-bold text-[#ffb4ab]">{strappingErrors.length} satırda hata bulundu:</p>
                    {strappingErrors.map((err, i) => (
                      <p key={i} className="text-[10px] text-[#ffb4ab] font-mono">
                        {err.row > 0 ? `Satır ${err.row}: ` : ''}{err.message}
                      </p>
                    ))}
                  </div>
                )}

                <div className="pt-2 flex items-center justify-end space-x-3">
                  <button
                    type="button"
                    onClick={() => setStrappingTank(null)}
                    className="px-4 py-2 bg-[#20201f] text-[#d5c4ab] rounded-md text-xs font-bold cursor-pointer"
                  >
                    İptal
                  </button>
                  <button
                    type="button"
                    data-testid="strapping-upload-submit"
                    onClick={handleUploadStrapping}
                    disabled={isUploadingStrapping || !strappingCsv.trim()}
                    className="px-5 py-2 bg-gradient-to-r from-[#ffb800] to-[#ff8a00] text-[#412d00] rounded-md text-xs font-black cursor-pointer disabled:opacity-40"
                  >
                    {isUploadingStrapping ? 'Yükleniyor...' : 'Yükle'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
};
