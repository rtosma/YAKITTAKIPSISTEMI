import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { Vehicle } from '../../types';
import { isValidPlate } from '../../utils/validation';

export const VehiclesPage: React.FC = () => {
  const { vehicles, selectedSiteFilter, addVehicle, updateVehicle, deleteVehicle, currentCompany, drivers, isManagerMode, currentUser, sites } = useApp();

  const availableSites = Array.from(new Set([...sites, ...currentCompany.sites.map(s => s.name)])).filter(Boolean);

  const [searchTerm, setSearchTerm] = useState('');
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [editingVehicle, setEditingVehicle] = useState<Vehicle | null>(null);
  const [deletingVehicle, setDeletingVehicle] = useState<Vehicle | null>(null);

  // Form Fields
  const [plate, setPlate] = useState('');
  const [brandModel, setBrandModel] = useState('');
  const [type, setType] = useState<Vehicle['type']>('Kamyon');
  const [siteName, setSiteName] = useState(availableSites[0] || 'Gebze Ana Şantiye');
  const [assignedDriver, setAssignedDriver] = useState('');
  const [fuelCapacityLiters, setFuelCapacityLiters] = useState(450);
  const [status, setStatus] = useState<'AKTİF' | 'BAKIMDA' | 'PASİF'>('AKTİF');
  const [plateError, setPlateError] = useState('');

  const filteredVehicles = vehicles
    .filter(v => selectedSiteFilter === 'TÜMÜ' || v.siteName === selectedSiteFilter)
    .filter(v => 
      v.plate.toLowerCase().includes(searchTerm.toLowerCase()) || 
      v.brandModel.toLowerCase().includes(searchTerm.toLowerCase()) ||
      v.assignedDriver.toLowerCase().includes(searchTerm.toLowerCase())
    );

  const handleOpenAdd = () => {
    setPlate('');
    setPlateError('');
    setBrandModel('');
    setType('Kamyon');
    setSiteName(selectedSiteFilter === 'TÜMÜ' ? availableSites[0] || 'Gebze Ana Şantiye' : selectedSiteFilter);
    setAssignedDriver(drivers[0]?.name || 'Atanmadı');
    setFuelCapacityLiters(450);
    setStatus('AKTİF');
    setIsAddOpen(true);
  };

  const handleSaveAdd = (e: React.FormEvent) => {
    e.preventDefault();
    setPlateError('');

    if (!isValidPlate(plate)) {
      setPlateError('Geçersiz Türkiye plaka formatı! (Örn: 34 CTP 82 veya 06 A 1234)');
      return;
    }

    addVehicle({
      plate: plate.toUpperCase().trim(),
      brandModel: brandModel || 'Volvo FMX 460',
      type,
      rfidTag: `TAG-${Math.floor(100000 + Math.random() * 900000)}`,
      assignedDriver: assignedDriver || 'Atanmadı',
      siteName,
      fuelCapacityLiters: Number(fuelCapacityLiters),
      lastRefuelDate: new Date().toISOString().split('T')[0],
      lastRefuelLiters: 0,
      status
    });

    setIsAddOpen(false);
  };

  const handleOpenEdit = (v: Vehicle) => {
    setEditingVehicle(v);
    setPlate(v.plate);
    setPlateError('');
    setBrandModel(v.brandModel);
    setType(v.type);
    setSiteName(v.siteName);
    setAssignedDriver(v.assignedDriver);
    setFuelCapacityLiters(v.fuelCapacityLiters);
    setStatus(v.status);
  };

  const handleSaveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    setPlateError('');

    if (!editingVehicle) return;

    if (!isValidPlate(plate)) {
      setPlateError('Geçersiz Türkiye plaka formatı! (Örn: 34 CTP 82 veya 06 A 1234)');
      return;
    }

    updateVehicle(editingVehicle.id, {
      plate: plate.toUpperCase().trim(),
      brandModel,
      type,
      siteName,
      assignedDriver,
      fuelCapacityLiters: Number(fuelCapacityLiters),
      status
    });

    setEditingVehicle(null);
  };

  const handleConfirmDelete = () => {
    if (deletingVehicle) {
      deleteVehicle(deletingVehicle.id);
      setDeletingVehicle(null);
    }
  };

  return (
    <div className="space-y-6">
      
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 bg-[#1c1b1b] border border-[#514532]/25 p-6 rounded-xl">
        <div className="space-y-1">
          <span className="text-xs font-mono font-bold text-[#ffdca1] uppercase tracking-widest block">
            FİLO SİSTEMİ
          </span>
          <h1 className="text-2xl font-black text-[#e5e2e1] uppercase tracking-tight">
            ARAÇ YÖNETİMİ
          </h1>
          <p className="text-xs text-[#d5c4ab]">
            Şantiye araç tanımı, RFID pasif tag eşleşmeleri ve yakıt depo kapasiteleri.
          </p>
        </div>

        <button
          onClick={handleOpenAdd}
          className="px-5 py-3 bg-gradient-to-r from-[#ffb800] to-[#ff8a00] hover:from-[#ffdca1] hover:to-[#ffb77f] text-[#412d00] font-black rounded-md text-xs flex items-center space-x-2 transition-all cursor-pointer shadow-sm shrink-0"
        >
          <span className="material-symbols-outlined text-base">add</span>
          <span>+ Yeni Araç Ekle</span>
        </button>
      </div>

      {/* Search Bar */}
      <div className="flex items-center justify-between gap-4 bg-[#1c1b1b] border border-[#514532]/25 p-4 rounded-xl">
        <div className="relative w-full sm:w-80">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Plaka, marka veya şoför ara..."
            className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md pl-9 pr-3 py-2.5 focus:outline-none focus:border-[#ffdca1]"
          />
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[#d5c4ab] text-sm">
            search
          </span>
        </div>

        <span className="text-xs font-mono text-[#ffdca1] font-bold">
          {filteredVehicles.length} Araç Kayıtlı
        </span>
      </div>

      {/* Table */}
      <div className="bg-[#1c1b1b] border border-[#514532]/25 rounded-xl p-6 overflow-x-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-[#514532]/30 text-[#d5c4ab] uppercase text-[10px] tracking-wider font-mono">
              <th className="py-3.5 px-4">Plaka</th>
              <th className="py-3.5 px-4">Marka & Model</th>
              <th className="py-3.5 px-4">Tipi</th>
              <th className="py-3.5 px-4">Bağlı Şantiye</th>
              <th className="py-3.5 px-4">Sorumlu Şoför</th>
              <th className="py-3.5 px-4">RFID Tag</th>
              <th className="py-3.5 px-4">Depo Hacmi</th>
              <th className="py-3.5 px-4">Durum</th>
              <th className="py-3.5 px-4 text-right">İşlemler</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#514532]/20 font-mono">
            {filteredVehicles.map(v => (
              <tr key={v.id} className="hover:bg-[#20201f] transition-colors">
                <td className="py-3.5 px-4 font-black text-[#ffdca1] text-sm">{v.plate}</td>
                <td className="py-3.5 px-4 text-[#e5e2e1] font-bold">{v.brandModel}</td>
                <td className="py-3.5 px-4 text-[#d5c4ab]">{v.type}</td>
                <td className="py-3.5 px-4 text-[#d5c4ab]">{v.siteName}</td>
                <td className="py-3.5 px-4 text-[#e5e2e1]">{v.assignedDriver}</td>
                <td className="py-3.5 px-4 text-[#ffb77f]">{v.rfidTag}</td>
                <td className="py-3.5 px-4 text-[#e5e2e1] font-bold">{v.fuelCapacityLiters} Litre</td>
                <td className="py-3.5 px-4">
                  <span className={`text-[10px] font-bold px-2.5 py-1 rounded border ${
                    v.status === 'AKTİF' ? 'bg-[#ffb800]/10 text-[#ffdca1] border-[#ffb800]/30' : 'bg-[#ff8a00]/10 text-[#ffb77f] border-[#ff8a00]/30'
                  }`}>
                    {v.status}
                  </span>
                </td>
                <td className="py-3.5 px-4 text-right">
                  <div className="flex items-center justify-end space-x-1">
                    <button
                      onClick={() => handleOpenEdit(v)}
                      title="Düzenle"
                      className="p-1.5 text-[#d5c4ab] hover:text-[#ffdca1] hover:bg-[#353535] rounded transition-colors cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-base">edit</span>
                    </button>
                    <button
                      onClick={() => setDeletingVehicle(v)}
                      title="Sil"
                      className="p-1.5 text-[#d5c4ab] hover:text-[#ffb4ab] hover:bg-[#93000a]/30 rounded transition-colors cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-base">delete</span>
                    </button>
                  </div>
                </td>
              </tr>
            ))}

            {filteredVehicles.length === 0 && (
              <tr>
                <td colSpan={9} className="py-12 text-center text-[#d5c4ab]">
                  Kayıtlı araç bulunamadı.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* MODAL 1: ADD VEHICLE */}
      {isAddOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#1c1b1b] border border-[#514532]/30 rounded-xl p-6 max-w-md w-full space-y-6">
            <div className="flex items-center justify-between border-b border-[#514532]/20 pb-4">
              <h3 className="text-base font-bold text-[#e5e2e1] uppercase flex items-center space-x-2">
                <span className="material-symbols-outlined text-[#ffdca1]">local_shipping</span>
                <span>Yeni Araç Tanımla</span>
              </h3>
              <button onClick={() => setIsAddOpen(false)} className="text-[#d5c4ab] hover:text-[#e5e2e1]">
                <span className="material-symbols-outlined text-lg">close</span>
              </button>
            </div>

            <form onSubmit={handleSaveAdd} className="space-y-4">
              <div>
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Araç Plakası</label>
                <input
                  type="text"
                  value={plate}
                  onChange={(e) => {
                    setPlate(e.target.value);
                    if (plateError) setPlateError('');
                  }}
                  placeholder="örn. 34 CTP 99"
                  className={`w-full bg-[#0e0e0e] border ${plateError ? 'border-[#ffb4ab]' : 'border-[#514532]/30'} text-[#e5e2e1] font-mono text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]`}
                  required
                />
                {plateError && (
                  <p className="text-[11px] font-bold text-[#ffb4ab] mt-1 flex items-center space-x-1">
                    <span className="material-symbols-outlined text-xs">error</span>
                    <span>{plateError}</span>
                  </p>
                )}
              </div>

              <div>
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Marka & Model</label>
                <input
                  type="text"
                  value={brandModel}
                  onChange={(e) => setBrandModel(e.target.value)}
                  placeholder="örn. Volvo FMX 460 Damperli"
                  className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Araç Tipi</label>
                  <select
                    value={type}
                    onChange={(e) => setType(e.target.value as any)}
                    className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                  >
                    <option value="Kamyon">Kamyon</option>
                    <option value="Ekskavatör">Ekskavatör</option>
                    <option value="Dozer">Dozer</option>
                    <option value="Silindir">Silindir</option>
                    <option value="Beton Mikseri">Beton Mikseri</option>
                    <option value="Binek Hizmet">Binek Hizmet</option>
                  </select>
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
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Depo Hacmi (Litre)</label>
                  <input
                    type="number"
                    value={fuelCapacityLiters}
                    onChange={(e) => setFuelCapacityLiters(Number(e.target.value))}
                    className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] font-mono text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                    required
                  />
                </div>

                <div>
                  <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Sorumlu Şoför</label>
                  <select
                    value={assignedDriver}
                    onChange={(e) => setAssignedDriver(e.target.value)}
                    className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                  >
                    <option value="Atanmadı">Atanmadı</option>
                    {drivers.map(d => (
                      <option key={d.id} value={d.name} className="bg-[#1c1b1b]">
                        {d.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="pt-4 border-t border-[#514532]/20 flex items-center justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setIsAddOpen(false)}
                  className="px-4 py-2 bg-[#20201f] text-[#d5c4ab] rounded-md text-xs font-bold"
                >
                  İptal
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 bg-gradient-to-r from-[#ffb800] to-[#ff8a00] text-[#412d00] rounded-md text-xs font-black"
                >
                  Aracı Kaydet
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 2: EDIT VEHICLE */}
      {editingVehicle && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#1c1b1b] border border-[#514532]/30 rounded-xl p-6 max-w-md w-full space-y-6">
            <div className="flex items-center justify-between border-b border-[#514532]/20 pb-4">
              <h3 className="text-base font-bold text-[#e5e2e1] uppercase flex items-center space-x-2">
                <span className="material-symbols-outlined text-[#ffdca1]">edit</span>
                <span>Araç Bilgilerini Düzenle</span>
              </h3>
              <button onClick={() => setEditingVehicle(null)} className="text-[#d5c4ab] hover:text-[#e5e2e1]">
                <span className="material-symbols-outlined text-lg">close</span>
              </button>
            </div>

            <form onSubmit={handleSaveEdit} className="space-y-4">
              <div>
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Araç Plakası</label>
                <input
                  type="text"
                  value={plate}
                  onChange={(e) => setPlate(e.target.value)}
                  className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] font-mono text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                  required
                />
              </div>

              <div>
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Marka & Model</label>
                <input
                  type="text"
                  value={brandModel}
                  onChange={(e) => setBrandModel(e.target.value)}
                  className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
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

                <div>
                  <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Sorumlu Şoför</label>
                  <select
                    value={assignedDriver}
                    onChange={(e) => setAssignedDriver(e.target.value)}
                    className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                  >
                    <option value="Atanmadı">Atanmadı</option>
                    {drivers.map(d => (
                      <option key={d.id} value={d.name} className="bg-[#1c1b1b]">
                        {d.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Depo Hacmi (Litre)</label>
                  <input
                    type="number"
                    value={fuelCapacityLiters}
                    onChange={(e) => setFuelCapacityLiters(Number(e.target.value))}
                    className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] font-mono text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                    required
                  />
                </div>

                <div>
                  <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Durum</label>
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value as any)}
                    className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                  >
                    <option value="AKTİF">AKTİF</option>
                    <option value="BAKIMDA">BAKIMDA</option>
                    <option value="PASİF">PASİF</option>
                  </select>
                </div>
              </div>

              <div className="pt-4 border-t border-[#514532]/20 flex items-center justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setEditingVehicle(null)}
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

      {/* MODAL 3: DELETE CONFIRMATION */}
      {deletingVehicle && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#1c1b1b] border border-[#514532]/30 rounded-xl p-6 max-w-sm w-full space-y-4 text-center">
            <div className="w-12 h-12 bg-[#93000a]/20 border border-[#93000a] text-[#ffb4ab] rounded-full flex items-center justify-center mx-auto">
              <span className="material-symbols-outlined text-2xl">warning</span>
            </div>

            <h3 className="text-base font-bold text-[#e5e2e1]">Bu Aracı Silmek İstediğinize Emin Misiniz?</h3>
            <p className="text-xs text-[#d5c4ab]">
              <span className="font-bold text-[#e5e2e1]">{deletingVehicle.plate} ({deletingVehicle.brandModel})</span> kaydı sistemden kalıcı olarak silinecektir.
            </p>

            <div className="pt-4 flex items-center justify-center space-x-3">
              <button
                onClick={() => setDeletingVehicle(null)}
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

    </div>
  );
};
