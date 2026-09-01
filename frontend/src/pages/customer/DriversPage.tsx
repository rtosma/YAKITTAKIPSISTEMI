import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { Driver } from '../../types';

export const DriversPage: React.FC = () => {
  const { drivers, selectedSiteFilter, addDriver, updateDriver, deleteDriver, currentCompany, vehicles, isManagerMode, currentUser, sites } = useApp();

  const availableSites = Array.from(new Set([...sites, ...currentCompany.sites.map(s => s.name)])).filter(Boolean);

  const [searchTerm, setSearchTerm] = useState('');
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [editingDriver, setEditingDriver] = useState<Driver | null>(null);
  const [deletingDriver, setDeletingDriver] = useState<Driver | null>(null);

  // Form Fields
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [tcNo, setTcNo] = useState('');
  const [licenseType, setLicenseType] = useState('CE Sınıfı Ağır Vasıta');
  const [siteName, setSiteName] = useState(availableSites[0] || 'Gebze Ana Şantiye');
  const [assignedVehiclePlate, setAssignedVehiclePlate] = useState('Yok');
  const [status, setStatus] = useState<Driver['status']>('SAHADA');

  const filteredDrivers = drivers
    .filter(d => selectedSiteFilter === 'TÜMÜ' || d.siteName === selectedSiteFilter)
    .filter(d => 
      d.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
      d.phone.includes(searchTerm) ||
      d.assignedVehiclePlate.toLowerCase().includes(searchTerm.toLowerCase())
    );

  const handleOpenAdd = () => {
    setName('');
    setPhone('');
    setTcNo('');
    setLicenseType('CE Sınıfı Ağır Vasıta');
    setSiteName(!isManagerMode && currentUser?.siteName ? currentUser.siteName : (selectedSiteFilter === 'TÜMÜ' ? currentCompany.sites[0]?.name || 'Gebze Ana Şantiye' : selectedSiteFilter));
    setAssignedVehiclePlate('Yok');
    setStatus('SAHADA');
    setIsAddOpen(true);
  };

  const handleSaveAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    addDriver({
      name: name.trim(),
      tcNo: tcNo || '10000000000',
      phone: phone || '0530 000 00 00',
      licenseType,
      assignedVehiclePlate: assignedVehiclePlate || 'Yok',
      rfidCardId: `CARD-${Math.floor(800000 + Math.random() * 100000)}`,
      siteName,
      performanceScore: 90,
      status
    });

    setIsAddOpen(false);
  };

  const handleOpenEdit = (d: Driver) => {
    setEditingDriver(d);
    setName(d.name);
    setPhone(d.phone);
    setTcNo(d.tcNo);
    setLicenseType(d.licenseType);
    setSiteName(d.siteName);
    setAssignedVehiclePlate(d.assignedVehiclePlate);
    setStatus(d.status);
  };

  const handleSaveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingDriver || !name.trim()) return;

    updateDriver(editingDriver.id, {
      name: name.trim(),
      phone,
      tcNo,
      licenseType,
      siteName,
      assignedVehiclePlate,
      status
    });

    setEditingDriver(null);
  };

  const handleConfirmDelete = () => {
    if (deletingDriver) {
      deleteDriver(deletingDriver.id);
      setDeletingDriver(null);
    }
  };

  return (
    <div className="space-y-6">
      
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 bg-[#1c1b1b] border border-[#514532]/25 p-6 rounded-xl">
        <div className="space-y-1">
          <span className="text-xs font-mono font-bold text-[#ffdca1] uppercase tracking-widest block">
            PERSONEL KADROSU
          </span>
          <h1 className="text-2xl font-black text-[#e5e2e1] uppercase tracking-tight">
            ŞOFÖR YÖNETİMİ
          </h1>
          <p className="text-xs text-[#d5c4ab]">
            Şoför RFID kart atamaları, ehliyet sınıfları ve performans skor takibi.
          </p>
        </div>

        <button
          onClick={handleOpenAdd}
          className="px-5 py-3 bg-gradient-to-r from-[#ffb800] to-[#ff8a00] hover:from-[#ffdca1] hover:to-[#ffb77f] text-[#412d00] font-black rounded-md text-xs flex items-center space-x-2 transition-all cursor-pointer shadow-sm shrink-0"
        >
          <span className="material-symbols-outlined text-base">person_add</span>
          <span>+ Yeni Şoför Ekle</span>
        </button>
      </div>

      {/* Search Bar */}
      <div className="flex items-center justify-between gap-4 bg-[#1c1b1b] border border-[#514532]/25 p-4 rounded-xl">
        <div className="relative w-full sm:w-80">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Ad soyad, telefon veya plaka ara..."
            className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md pl-9 pr-3 py-2.5 focus:outline-none focus:border-[#ffdca1]"
          />
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[#d5c4ab] text-sm">
            search
          </span>
        </div>

        <span className="text-xs font-mono text-[#ffdca1] font-bold">
          {filteredDrivers.length} Şoför Kayıtlı
        </span>
      </div>

      {/* Table */}
      <div className="bg-[#1c1b1b] border border-[#514532]/25 rounded-xl p-6 overflow-x-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-[#514532]/30 text-[#d5c4ab] uppercase text-[10px] tracking-wider font-mono">
              <th className="py-3.5 px-4">Ad Soyad</th>
              <th className="py-3.5 px-4">Telefon</th>
              <th className="py-3.5 px-4">Bağlı Şantiye</th>
              <th className="py-3.5 px-4">Atanmış Araç</th>
              <th className="py-3.5 px-4">Ehliyet Sınıfı</th>
              <th className="py-3.5 px-4">RFID Kart ID</th>
              <th className="py-3.5 px-4">Performans Skoru</th>
              <th className="py-3.5 px-4">Durum</th>
              <th className="py-3.5 px-4 text-right">İşlemler</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#514532]/20 font-mono">
            {filteredDrivers.map(d => (
              <tr key={d.id} className="hover:bg-[#20201f] transition-colors">
                <td className="py-3.5 px-4 font-bold text-[#e5e2e1]">{d.name}</td>
                <td className="py-3.5 px-4 text-[#d5c4ab]">{d.phone}</td>
                <td className="py-3.5 px-4 text-[#d5c4ab]">{d.siteName}</td>
                <td className="py-3.5 px-4 font-black text-[#ffdca1] text-sm">{d.assignedVehiclePlate}</td>
                <td className="py-3.5 px-4 text-[#d5c4ab]">{d.licenseType}</td>
                <td className="py-3.5 px-4 text-[#ffb77f]">{d.rfidCardId}</td>
                <td className="py-3.5 px-4">
                  <span className="font-bold text-[#a1e8a2]">{d.performanceScore} / 100</span>
                </td>
                <td className="py-3.5 px-4">
                  <span className={`text-[10px] font-bold px-2.5 py-1 rounded border ${
                    d.status === 'SAHADA' || d.status === 'AKTİF'
                      ? 'bg-[#ffb800]/10 text-[#ffdca1] border-[#ffb800]/30'
                      : 'bg-[#ff8a00]/10 text-[#ffb77f] border-[#ff8a00]/30'
                  }`}>
                    {d.status}
                  </span>
                </td>
                <td className="py-3.5 px-4 text-right">
                  <div className="flex items-center justify-end space-x-1">
                    <button
                      onClick={() => handleOpenEdit(d)}
                      title="Düzenle"
                      className="p-1.5 text-[#d5c4ab] hover:text-[#ffdca1] hover:bg-[#353535] rounded transition-colors cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-base">edit</span>
                    </button>
                    <button
                      onClick={() => setDeletingDriver(d)}
                      title="Sil"
                      className="p-1.5 text-[#d5c4ab] hover:text-[#ffb4ab] hover:bg-[#93000a]/30 rounded transition-colors cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-base">delete</span>
                    </button>
                  </div>
                </td>
              </tr>
            ))}

            {filteredDrivers.length === 0 && (
              <tr>
                <td colSpan={9} className="py-12 text-center text-[#d5c4ab]">
                  Kayıtlı şoför bulunamadı.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* MODAL 1: ADD DRIVER */}
      {isAddOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#1c1b1b] border border-[#514532]/30 rounded-xl p-6 max-w-md w-full space-y-6">
            <div className="flex items-center justify-between border-b border-[#514532]/20 pb-4">
              <h3 className="text-base font-bold text-[#e5e2e1] uppercase flex items-center space-x-2">
                <span className="material-symbols-outlined text-[#ffdca1]">badge</span>
                <span>Yeni Şoför Tanımla</span>
              </h3>
              <button onClick={() => setIsAddOpen(false)} className="text-[#d5c4ab] hover:text-[#e5e2e1]">
                <span className="material-symbols-outlined text-lg">close</span>
              </button>
            </div>

            <form onSubmit={handleSaveAdd} className="space-y-4">
              <div>
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Ad Soyad</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="örn. Mustafa Demir"
                  className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Telefon No</label>
                  <input
                    type="text"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="0532 000 00 00"
                    className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] font-mono text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                  />
                </div>
                <div>
                  <label className="text-xs font-mono text-[#d5c4ab] block mb-1">TC Kimlik No</label>
                  <input
                    type="text"
                    value={tcNo}
                    onChange={(e) => setTcNo(e.target.value)}
                    placeholder="11 haneli TC"
                    className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] font-mono text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Ehliyet Sınıfı</label>
                  <select
                    value={licenseType}
                    onChange={(e) => setLicenseType(e.target.value)}
                    className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                  >
                    <option value="CE Sınıfı Ağır Vasıta">CE Sınıfı Ağır Vasıta</option>
                    <option value="C Sınıfı Kamyon">C Sınıfı Kamyon</option>
                    <option value="G Sınıfı İş Makinesi (Ekskavatör)">G Sınıfı (Ekskavatör)</option>
                    <option value="G Sınıfı İş Makinesi (Dozer)">G Sınıfı (Dozer)</option>
                    <option value="B Sınıfı Binek">B Sınıfı Binek</option>
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

              <div>
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Atanmış Araç Plakası</label>
                <select
                  value={assignedVehiclePlate}
                  onChange={(e) => setAssignedVehiclePlate(e.target.value)}
                  className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs font-mono rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                >
                  <option value="Yok">Yok / Atanmadı</option>
                  {vehicles
                    .filter(v => isManagerMode || v.siteName === (currentUser?.siteName || siteName))
                    .map(v => (
                      <option key={v.id} value={v.plate} className="bg-[#1c1b1b]">
                        {v.plate} ({v.brandModel})
                      </option>
                    ))}
                </select>
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
                  Şoförü Kaydet
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 2: EDIT DRIVER */}
      {editingDriver && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#1c1b1b] border border-[#514532]/30 rounded-xl p-6 max-w-md w-full space-y-6">
            <div className="flex items-center justify-between border-b border-[#514532]/20 pb-4">
              <h3 className="text-base font-bold text-[#e5e2e1] uppercase flex items-center space-x-2">
                <span className="material-symbols-outlined text-[#ffdca1]">edit</span>
                <span>Şoför Bilgilerini Düzenle</span>
              </h3>
              <button onClick={() => setEditingDriver(null)} className="text-[#d5c4ab] hover:text-[#e5e2e1]">
                <span className="material-symbols-outlined text-lg">close</span>
              </button>
            </div>

            <form onSubmit={handleSaveEdit} className="space-y-4">
              <div>
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Ad Soyad</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Telefon</label>
                  <input
                    type="text"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] font-mono text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                  />
                </div>
                <div>
                  <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Ehliyet Sınıfı</label>
                  <input
                    type="text"
                    value={licenseType}
                    onChange={(e) => setLicenseType(e.target.value)}
                    className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                  />
                </div>
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
                  <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Atanmış Araç</label>
                  <select
                    value={assignedVehiclePlate}
                    onChange={(e) => setAssignedVehiclePlate(e.target.value)}
                    className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] font-mono text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                  >
                    <option value="Yok">Yok</option>
                    {vehicles
                      .filter(v => isManagerMode || v.siteName === (currentUser?.siteName || siteName))
                      .map(v => (
                        <option key={v.id} value={v.plate} className="bg-[#1c1b1b]">
                          {v.plate} ({v.brandModel})
                        </option>
                      ))}
                  </select>
                </div>
              </div>

              <div className="pt-4 border-t border-[#514532]/20 flex items-center justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setEditingDriver(null)}
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
      {deletingDriver && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#1c1b1b] border border-[#514532]/30 rounded-xl p-6 max-w-sm w-full space-y-4 text-center">
            <div className="w-12 h-12 bg-[#93000a]/20 border border-[#93000a] text-[#ffb4ab] rounded-full flex items-center justify-center mx-auto">
              <span className="material-symbols-outlined text-2xl">warning</span>
            </div>

            <h3 className="text-base font-bold text-[#e5e2e1]">Şoför Silinsin mi?</h3>
            <p className="text-xs text-[#d5c4ab]">
              <span className="font-bold text-[#e5e2e1]">{deletingDriver.name}</span> kaydı silinecektir.
            </p>

            {deletingDriver.assignedVehiclePlate !== 'Yok' && (
              <div className="p-2.5 bg-[#514532]/20 border border-[#ffdca1]/30 rounded text-[11px] text-[#ffdca1] text-left">
                ⚠️ Uyarı: Bu şoför <span className="font-bold">{deletingDriver.assignedVehiclePlate}</span> plakalı araca tanımlıdır. Silindikten sonra araç şoförsüz kalacaktır.
              </div>
            )}

            <div className="pt-4 flex items-center justify-center space-x-3">
              <button
                onClick={() => setDeletingDriver(null)}
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
