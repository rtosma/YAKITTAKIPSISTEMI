import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { exportToExcelWithTotals } from '../../utils/excelExporter';
import { Vehicle, Driver } from '../../types';

export const VehiclesDriversPage: React.FC = () => {
  const { vehicles, drivers, selectedSiteFilter, addVehicle, addDriver } = useApp();
  const [activeTab, setActiveTab] = useState<'vehicles' | 'drivers'>('vehicles');

  // Search filter
  const [searchTerm, setSearchTerm] = useState('');

  // Modal State
  const [isAddVehOpen, setIsAddVehOpen] = useState(false);
  const [newPlate, setNewPlate] = useState('');
  const [newBrand, setNewBrand] = useState('');
  const [newType, setNewType] = useState<'Kamyon' | 'Ekskavatör' | 'Dozer' | 'Silindir' | 'Beton Mikseri' | 'Binek Hizmet'>('Kamyon');
  const [newDriver, setNewDriver] = useState('');

  const filteredVehicles = vehicles
    .filter(v => selectedSiteFilter === 'TÜMÜ' || v.siteName === selectedSiteFilter)
    .filter(v => v.plate.toLowerCase().includes(searchTerm.toLowerCase()) || v.assignedDriver.toLowerCase().includes(searchTerm.toLowerCase()));

  const filteredDrivers = drivers
    .filter(d => selectedSiteFilter === 'TÜMÜ' || d.siteName === selectedSiteFilter)
    .filter(d => d.name.toLowerCase().includes(searchTerm.toLowerCase()) || d.assignedVehiclePlate.toLowerCase().includes(searchTerm.toLowerCase()));

  const handleCreateVehicle = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPlate.trim()) return;

    addVehicle({
      plate: newPlate.toUpperCase(),
      brandModel: newBrand || 'Volvo FMX 460',
      type: newType,
      rfidTag: `RFID-${Math.floor(100000 + Math.random() * 900000)}`,
      assignedDriver: newDriver || 'Atanmadı',
      siteName: selectedSiteFilter === 'TÜMÜ' ? 'Gebze Ana Şantiye' : selectedSiteFilter,
      fuelCapacityLiters: 500,
      lastRefuelDate: 'Henüz yok',
      lastRefuelLiters: 0,
      totalRefuelsCount: 0,
      status: 'AKTİF'
    });

    setNewPlate('');
    setNewBrand('');
    setIsAddVehOpen(false);
  };

  const handleExportVehicles = () => {
    exportToExcelWithTotals<Vehicle>({
      data: filteredVehicles,
      sheetName: 'Araç Envanteri',
      filename: `arac_envanteri_${new Date().toISOString().split('T')[0]}.xlsx`,
      totalLabelColumnIndex: 0,
      totalLabel: 'GENEL TOPLAM',
      columns: [
        { header: 'Plaka', key: 'plate', width: 14 },
        { header: 'Marka / Model', key: 'brandModel', width: 22 },
        { header: 'Araç Tipi', key: 'type', width: 16 },
        { header: 'Şantiye', key: 'siteName', width: 20 },
        { header: 'Atanan Şoför', key: 'assignedDriver', width: 20 },
        { header: 'RFID Tag', key: 'rfidTag', width: 18 },
        { header: 'Depo Kapasitesi (L)', key: 'fuelCapacityLiters', isTotalable: true, format: 'number', width: 20 },
        { header: 'Son İkmal (L)', key: 'lastRefuelLiters', isTotalable: true, format: 'number', width: 16 },
        { header: 'Toplam İkmal Sayısı', key: 'totalRefuelsCount', isTotalable: true, format: 'number', width: 20 }
      ]
    });
  };

  const handleExportDrivers = () => {
    exportToExcelWithTotals<Driver>({
      data: filteredDrivers,
      sheetName: 'Şoför Kadrosu',
      filename: `sofor_kadrosu_${new Date().toISOString().split('T')[0]}.xlsx`,
      totalLabelColumnIndex: 0,
      totalLabel: 'GENEL TOPLAM',
      columns: [
        { header: 'Ad Soyad', key: 'name', width: 20 },
        { header: 'TC Kimlik No', key: 'tcNo', width: 16 },
        { header: 'Telefon', key: 'phone', width: 16 },
        { header: 'Ehliyet Sınıfı', key: 'licenseType', width: 14 },
        { header: 'Atanan Araç', key: 'assignedVehiclePlate', width: 16 },
        { header: 'Şantiye', key: 'siteName', width: 20 },
        { header: 'Performans Skoru', key: 'performanceScore', width: 18 },
        { header: 'Toplam Aldığı Yakıt (L)', key: 'totalFuelPumpedLiters', isTotalable: true, format: 'number', width: 24 }
      ]
    });
  };

  return (
    <div className="space-y-6">
      
      {/* Page Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-[#1c1b1b] border border-[#353535] p-6 rounded-2xl">
        <div>
          <span className="text-[10px] font-mono text-[#ffdca1] font-bold uppercase tracking-widest">
            SAHA FİLO YÖNETİMİ
          </span>
          <h2 className="text-xl font-extrabold text-[#e5e2e1] uppercase mt-0.5">
            Araçlar & Şoför Envanteri
          </h2>
          <p className="text-xs text-[#d5c4ab] mt-1">
            Tanımlı RFID tag'leri, araç depo kapasiteleri ve şoför performans puanları
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={activeTab === 'vehicles' ? handleExportVehicles : handleExportDrivers}
            className="bg-[#20201f] border border-[#353535] hover:border-[#ffdca1]/50 text-[#ffdca1] font-bold px-4 py-2.5 rounded-xl text-xs flex items-center space-x-2 transition-all cursor-pointer shadow"
          >
            <span className="material-symbols-outlined text-lg">download</span>
            <span>{activeTab === 'vehicles' ? 'Araç Listesi Excel (Toplamlı)' : 'Şoför Listesi Excel (Toplamlı)'}</span>
          </button>

          <button
            onClick={() => setIsAddVehOpen(true)}
            className="bg-[#ffdca1] text-[#412d00] font-black px-4 py-2.5 rounded-xl text-xs flex items-center space-x-2 transition-all cursor-pointer shadow"
          >
            <span className="material-symbols-outlined text-lg">add</span>
            <span>Yeni Araç Tanımla</span>
          </button>
        </div>
      </div>

      {/* Tabs & Search Filter */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        
        {/* Tab Buttons */}
        <div className="flex items-center bg-[#1c1b1b] border border-[#353535] p-1 rounded-xl space-x-1">
          <button
            onClick={() => setActiveTab('vehicles')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center space-x-2 ${
              activeTab === 'vehicles' ? 'bg-[#ffdca1] text-[#412d00]' : 'text-[#d5c4ab] hover:text-[#e5e2e1]'
            }`}
          >
            <span className="material-symbols-outlined text-base">local_shipping</span>
            <span>Araç Filosu ({filteredVehicles.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('drivers')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center space-x-2 ${
              activeTab === 'drivers' ? 'bg-[#ffdca1] text-[#412d00]' : 'text-[#d5c4ab] hover:text-[#e5e2e1]'
            }`}
          >
            <span className="material-symbols-outlined text-base">badge</span>
            <span>Şoför Kadrosu ({filteredDrivers.length})</span>
          </button>
        </div>

        {/* Search */}
        <div className="relative w-full sm:w-64">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[#d5c4ab] text-sm">
            search
          </span>
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Plaka veya isim ara..."
            className="w-full bg-[#1c1b1b] border border-[#353535] text-[#e5e2e1] text-xs rounded-xl pl-9 pr-3 py-2.5 focus:outline-none focus:border-[#ffdca1]"
          />
        </div>

      </div>

      {/* TAB 1: VEHICLES TABLE */}
      {activeTab === 'vehicles' && (
        <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-[#353535] text-[#d5c4ab] uppercase text-[10px] tracking-wider font-mono">
                <th className="py-3.5 px-4">Plaka</th>
                <th className="py-3.5 px-4">Marka & Model</th>
                <th className="py-3.5 px-4">Tipi</th>
                <th className="py-3.5 px-4">Sorumlu Şoför</th>
                <th className="py-3.5 px-4">Şantiye</th>
                <th className="py-3.5 px-4">RFID Tag ID</th>
                <th className="py-3.5 px-4">Depo Hacmi</th>
                <th className="py-3.5 px-4">Durum</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#353535] font-mono">
              {filteredVehicles.map(v => (
                <tr key={v.id} className="hover:bg-[#282726] transition-colors">
                  <td className="py-3.5 px-4 font-black text-[#ffdca1] text-sm">{v.plate}</td>
                  <td className="py-3.5 px-4 text-[#e5e2e1] font-bold">{v.brandModel}</td>
                  <td className="py-3.5 px-4 text-[#d5c4ab]">{v.type}</td>
                  <td className="py-3.5 px-4 text-[#e5e2e1]">{v.assignedDriver}</td>
                  <td className="py-3.5 px-4 text-[#d5c4ab]">{v.siteName}</td>
                  <td className="py-3.5 px-4 text-[#ffb77f]">{v.rfidTag}</td>
                  <td className="py-3.5 px-4 text-[#e5e2e1]">{v.fuelCapacityLiters} Litre</td>
                  <td className="py-3.5 px-4">
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                      v.status === 'AKTİF' ? 'bg-[#a1e8a2]/10 text-[#a1e8a2]' : 'bg-[#ffb77f]/10 text-[#ffb77f]'
                    }`}>
                      {v.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* TAB 2: DRIVERS TABLE */}
      {activeTab === 'drivers' && (
        <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-[#353535] text-[#d5c4ab] uppercase text-[10px] tracking-wider font-mono">
                <th className="py-3.5 px-4">Ad Soyad</th>
                <th className="py-3.5 px-4">Ait Olduğu Şantiye</th>
                <th className="py-3.5 px-4">Kullandığı Araç</th>
                <th className="py-3.5 px-4">Ehliyet Sınıfı</th>
                <th className="py-3.5 px-4">RFID Kart No</th>
                <th className="py-3.5 px-4">Performans Skoru</th>
                <th className="py-3.5 px-4">Toplam Yakıt Alımı</th>
                <th className="py-3.5 px-4">Durum</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#353535] font-mono">
              {filteredDrivers.map(d => (
                <tr key={d.id} className="hover:bg-[#282726] transition-colors">
                  <td className="py-3.5 px-4 font-bold text-[#e5e2e1]">{d.name}</td>
                  <td className="py-3.5 px-4 text-[#d5c4ab]">{d.siteName}</td>
                  <td className="py-3.5 px-4 text-[#ffdca1] font-bold">{d.assignedVehiclePlate}</td>
                  <td className="py-3.5 px-4 text-[#d5c4ab]">{d.licenseType}</td>
                  <td className="py-3.5 px-4 text-[#ffb77f]">{d.rfidCardId}</td>
                  <td className="py-3.5 px-4">
                    <span className="font-extrabold text-[#a1e8a2]">{d.performanceScore} / 100</span>
                  </td>
                  <td className="py-3.5 px-4 text-[#e5e2e1]">
                    {d.totalFuelPumpedLiters.toLocaleString('tr-TR')} Litre
                  </td>
                  <td className="py-3.5 px-4">
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-[#a1e8a2]/10 text-[#a1e8a2]">
                      {d.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ADD VEHICLE MODAL */}
      {isAddVehOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 max-w-md w-full space-y-6">
            <div className="flex items-center justify-between border-b border-[#353535] pb-4">
              <h3 className="text-base font-extrabold text-[#e5e2e1] uppercase tracking-wider flex items-center space-x-2">
                <span className="material-symbols-outlined text-[#ffdca1]">local_shipping</span>
                <span>Yeni Araç Tanımla</span>
              </h3>
              <button onClick={() => setIsAddVehOpen(false)} className="text-[#d5c4ab] hover:text-[#e5e2e1]">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <form onSubmit={handleCreateVehicle} className="space-y-4">
              <div>
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Araç Plakası</label>
                <input
                  type="text"
                  value={newPlate}
                  onChange={(e) => setNewPlate(e.target.value)}
                  placeholder="örn. 34 CTP 99"
                  className="w-full bg-[#131313] border border-[#353535] text-[#e5e2e1] font-mono text-xs rounded-xl p-3 focus:outline-none focus:border-[#ffdca1]"
                  required
                />
              </div>

              <div>
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Marka & Model</label>
                <input
                  type="text"
                  value={newBrand}
                  onChange={(e) => setNewBrand(e.target.value)}
                  placeholder="örn. Mercedes Actros 1848"
                  className="w-full bg-[#131313] border border-[#353535] text-[#e5e2e1] text-xs rounded-xl p-3 focus:outline-none focus:border-[#ffdca1]"
                />
              </div>

              <div>
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Araç Tipi</label>
                <select
                  value={newType}
                  onChange={(e) => setNewType(e.target.value as any)}
                  className="w-full bg-[#131313] border border-[#353535] text-[#e5e2e1] text-xs rounded-xl p-3 focus:outline-none focus:border-[#ffdca1]"
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
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Sorumlu Şoför</label>
                <input
                  type="text"
                  value={newDriver}
                  onChange={(e) => setNewDriver(e.target.value)}
                  placeholder="Şoför adı veya Atanmadı"
                  className="w-full bg-[#131313] border border-[#353535] text-[#e5e2e1] text-xs rounded-xl p-3 focus:outline-none focus:border-[#ffdca1]"
                />
              </div>

              <div className="pt-4 border-t border-[#353535] flex items-center justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setIsAddVehOpen(false)}
                  className="px-4 py-2.5 bg-[#20201f] text-[#d5c4ab] rounded-xl text-xs font-bold"
                >
                  İptal
                </button>
                <button
                  type="submit"
                  className="px-5 py-2.5 bg-[#ffdca1] text-[#412d00] rounded-xl text-xs font-black"
                >
                  Aracı Kaydet
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
};
