import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { HOURLY_CONSUMPTION_DATA } from '../../mock';
import { TankGauge } from '../../components/TankGauge';

export const OverviewPage: React.FC = () => {
  const { 
    currentCompany, 
    selectedSiteFilter, 
    tanks, 
    transactions, 
    vehicles, 
    addFuelTransaction,
    showToast,
    isManagerMode,
    currentUser
  } = useApp();

  // Modal State for Quick Fuel Log
  const [isRefuelModalOpen, setIsRefuelModalOpen] = useState(false);
  const [refuelPlate, setRefuelPlate] = useState(vehicles[0]?.plate || '34 CTP 82');
  const [refuelDriver, setRefuelDriver] = useState('Ahmet Yılmaz');
  const [refuelSite, setRefuelSite] = useState(currentCompany.sites[0]?.name || 'Gebze Ana Şantiye');
  const [refuelTank, setRefuelTank] = useState(tanks[0]?.name || 'Gebze Ana Tank (T-1)');
  const [refuelLiters, setRefuelLiters] = useState<number>(250);

  // Filter transactions by site filter
  const filteredTransactions = selectedSiteFilter === 'TÜMÜ'
    ? transactions
    : transactions.filter(t => t.siteName === selectedSiteFilter);

  // Filter tanks by site filter
  const filteredTanks = selectedSiteFilter === 'TÜMÜ'
    ? tanks
    : tanks.filter(t => t.siteName === selectedSiteFilter);

  // Metrics
  const totalTankCapacity = filteredTanks.reduce((acc, t) => acc + t.capacityLiters, 0);
  const currentTankTotal = filteredTanks.reduce((acc, t) => acc + t.currentLevelLiters, 0);
  const tankPercentage = totalTankCapacity > 0 ? Math.round((currentTankTotal / totalTankCapacity) * 100) : 0;

  const todayOutputLiters = filteredTransactions.reduce((acc, t) => acc + t.amountLiters, 0);
  const activeVehiclesCount = selectedSiteFilter === 'TÜMÜ'
    ? vehicles.length
    : vehicles.filter(v => v.siteName === selectedSiteFilter).length;

  const handleCreateRefuel = (e: React.FormEvent) => {
    e.preventDefault();
    if (!refuelLiters || refuelLiters <= 0) return;

    addFuelTransaction({
      siteName: refuelSite,
      vehiclePlate: refuelPlate,
      driverName: refuelDriver,
      tankName: refuelTank,
      amountLiters: Number(refuelLiters),
      flowRateLpm: 52.0,
      pumpStatus: 'TAMAMLANTI',
      type: 'Otomatik',
      rfidAuth: true
    });

    setIsRefuelModalOpen(false);
  };

  return (
    <div className="space-y-8">
      
      {/* Top Banner */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 bg-[#1c1b1b] border border-[#353535] p-6 rounded-2xl">
        <div>
          <span className="text-[10px] font-mono text-[#ffdca1] font-bold uppercase tracking-widest">
            SİSTEM ÖZETİ
          </span>
          <h2 className="text-xl font-extrabold text-[#e5e2e1] uppercase tracking-tight mt-0.5">
            {selectedSiteFilter === 'TÜMÜ' ? 'Tüm Şantiyeler Yakıt Genel Durumu' : `${selectedSiteFilter} Yakıt Raporu`}
          </h2>
          <p className="text-xs text-[#d5c4ab] mt-1">
            Anlık debimetre akış verileri, tank sensör seviyeleri ve araç ikmal geçmişi
          </p>
        </div>

        <button
          onClick={() => setIsRefuelModalOpen(true)}
          className="bg-[#ffdca1] hover:bg-[#ffe5b9] text-[#412d00] font-black px-4 py-2.5 rounded-xl text-xs flex items-center space-x-2 transition-all cursor-pointer shadow"
        >
          <span className="material-symbols-outlined text-lg">local_gas_station</span>
          <span>Hızlı İkmal Kaydı Gir</span>
        </button>
      </div>

      {/* 3 METRIC CARDS */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        
        {/* Metric 1: Tank Doluluk Oranı */}
        <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-[#d5c4ab] uppercase tracking-wider">Tank Doluluk Oranı</span>
            <div className="w-8 h-8 rounded-lg bg-[#20201f] border border-[#353535] text-[#ffdca1] flex items-center justify-center">
              <span className="material-symbols-outlined text-lg">oil_barrel</span>
            </div>
          </div>
          <div className="flex items-baseline space-x-2">
            <span className="text-3xl font-extrabold font-mono text-[#e5e2e1]">%{tankPercentage}</span>
            <span className="text-xs text-[#d5c4ab] font-mono">
              ({currentTankTotal.toLocaleString('tr-TR')} / {totalTankCapacity.toLocaleString('tr-TR')} L)
            </span>
          </div>
          <div className="w-full h-1.5 bg-[#20201f] rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-500 ${
                tankPercentage < 20 ? 'bg-[#ffb4ab]' : tankPercentage < 40 ? 'bg-[#ffb77f]' : 'bg-[#ffdca1]'
              }`}
              style={{ width: `${Math.min(100, tankPercentage)}%` }}
            ></div>
          </div>
        </div>

        {/* Metric 2: Bugünkü Pompa Çıkışı */}
        <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-[#d5c4ab] uppercase tracking-wider">Bugünkü Pompa Çıkışı</span>
            <div className="w-8 h-8 rounded-lg bg-[#20201f] border border-[#353535] text-[#ffb77f] flex items-center justify-center">
              <span className="material-symbols-outlined text-lg">water_drop</span>
            </div>
          </div>
          <div className="flex items-baseline space-x-2">
            <span className="text-3xl font-extrabold font-mono text-[#e5e2e1]">
              {todayOutputLiters.toLocaleString('tr-TR')} L
            </span>
          </div>
          <p className="text-[11px] text-[#a1e8a2] font-mono flex items-center space-x-1">
            <span className="material-symbols-outlined text-sm">trending_up</span>
            <span>Düne göre %4.2 optimum tüketim bandında</span>
          </p>
        </div>

        {/* Metric 3: Aktif Çalışan Araç */}
        <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-[#d5c4ab] uppercase tracking-wider">Aktif Saheadaki Araç</span>
            <div className="w-8 h-8 rounded-lg bg-[#20201f] border border-[#353535] text-[#a1e8a2] flex items-center justify-center">
              <span className="material-symbols-outlined text-lg">local_shipping</span>
            </div>
          </div>
          <div className="flex items-baseline space-x-2">
            <span className="text-3xl font-extrabold font-mono text-[#e5e2e1]">{activeVehiclesCount} Araç</span>
          </div>
          <p className="text-[11px] text-[#d5c4ab]">RFID aktif doğrulama ile sahada çalışıyor</p>
        </div>

      </div>

      {/* CHART & VERTICAL CAPSULE TANKS GRID */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* CHART: Günlük Tüketim Trendi (2 Columns) */}
        <div className="lg:col-span-2 bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-[10px] font-mono text-[#ffdca1] font-bold uppercase tracking-widest">
                SAATLİK TÜKETİM TRENDİ
              </span>
              <h3 className="text-sm font-extrabold text-[#e5e2e1] uppercase mt-0.5">
                Pompa Çıkış Debi Grafiği (Litre)
              </h3>
            </div>
            <span className="text-xs font-mono text-[#d5c4ab] bg-[#20201f] px-2.5 py-1 rounded border border-[#353535]">
              Canlı Akış
            </span>
          </div>

          <div className="h-64 w-full pt-2">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={HOURLY_CONSUMPTION_DATA} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="amberGlow" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#ffdca1" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#ffdca1" stopOpacity={0.0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#353535" vertical={false} />
                <XAxis dataKey="hour" stroke="#d5c4ab" fontSize={11} tickLine={false} />
                <YAxis stroke="#d5c4ab" fontSize={11} tickLine={false} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#131313', borderColor: '#353535', borderRadius: '12px', fontSize: '12px', color: '#e5e2e1' }}
                  itemStyle={{ color: '#ffdca1' }}
                />
                <Area type="monotone" dataKey="Total" stroke="#ffdca1" strokeWidth={2} fillOpacity={1} fill="url(#amberGlow)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* DEPO REZERV DURUMLARI — VERTICAL CAPSULE/TUBE INDICATORS */}
        <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 space-y-4 flex flex-col justify-between">
          <div>
            <span className="text-[10px] font-mono text-[#ffdca1] font-bold uppercase tracking-widest">
              SAHA DEPO STOKLARI
            </span>
            <h3 className="text-sm font-extrabold text-[#e5e2e1] uppercase mt-0.5">
              Depo Rezerv Durumları
            </h3>
          </div>

          <div className="grid grid-cols-3 gap-3 my-auto pt-2">
            {filteredTanks.map((t, idx) => (
              <TankGauge
                key={`${t.id}-${selectedSiteFilter}`}
                tank={t}
                index={idx}
                variant="compact"
                siteFilter={selectedSiteFilter}
              />
            ))}
          </div>

          <div className="text-[10px] text-[#d5c4ab] font-mono text-center pt-2 border-t border-[#353535]">
            Ultrasonik Seviye Sensörleri Aktif
          </div>
        </div>

      </div>

      {/* RECENT FUEL TRANSACTIONS TABLE */}
      <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-[10px] font-mono text-[#ffdca1] font-bold uppercase tracking-widest">
              CANLI İKMAL AKIŞI
            </span>
            <h3 className="text-base font-extrabold text-[#e5e2e1] uppercase mt-0.5">
              Son Yakıt Hareketleri
            </h3>
          </div>
          <span className="text-xs font-mono text-[#d5c4ab]">
            Görüntülenen: {filteredTransactions.length} Kayıt
          </span>
        </div>

        <div className="overflow-x-auto rounded-xl border border-[#353535]">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-[#131313] border-b border-[#353535] text-[#d5c4ab] uppercase text-[10px] tracking-wider font-mono sticky top-0">
                <th className="py-3.5 px-4">Tarih & Saat</th>
                <th className="py-3.5 px-4">Şantiye</th>
                <th className="py-3.5 px-4">Plaka</th>
                <th className="py-3.5 px-4">Şoför</th>
                <th className="py-3.5 px-4">Pompa Durumu</th>
                <th className="py-3.5 px-4 text-right">Alınan Litre</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#353535] font-mono">
              {filteredTransactions.map((tx) => (
                <tr key={tx.id} className="bg-[#1c1b1b] hover:bg-[#282726] transition-colors">
                  <td className="py-3.5 px-4 text-[#d5c4ab]">{tx.timestamp}</td>
                  <td className="py-3.5 px-4 font-bold text-[#e5e2e1]">{tx.siteName}</td>
                  <td className="py-3.5 px-4 font-black text-[#ffdca1]">{tx.vehiclePlate}</td>
                  <td className="py-3.5 px-4 text-[#e5e2e1]">{tx.driverName}</td>
                  <td className="py-3.5 px-4">
                    <span className="inline-flex items-center space-x-1 text-[10px] px-2 py-0.5 rounded bg-[#a1e8a2]/10 text-[#a1e8a2] font-bold">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#a1e8a2]"></span>
                      <span>{tx.pumpStatus}</span>
                    </span>
                  </td>
                  <td className="py-3.5 px-4 text-right font-black text-[#e5e2e1]">
                    {tx.amountLiters} L
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* QUICK REFUEL MODAL */}
      {isRefuelModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 max-w-md w-full space-y-6">
            <div className="flex items-center justify-between border-b border-[#353535] pb-4">
              <h3 className="text-base font-extrabold text-[#e5e2e1] uppercase tracking-wider flex items-center space-x-2">
                <span className="material-symbols-outlined text-[#ffdca1]">local_gas_station</span>
                <span>Hızlı İkmal Kaydı</span>
              </h3>
              <button
                onClick={() => setIsRefuelModalOpen(false)}
                className="text-[#d5c4ab] hover:text-[#e5e2e1]"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <form onSubmit={handleCreateRefuel} className="space-y-4">
              <div>
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Şantiye</label>
                {isManagerMode ? (
                  <select
                    value={refuelSite}
                    onChange={(e) => setRefuelSite(e.target.value)}
                    className="w-full bg-[#131313] border border-[#353535] text-[#e5e2e1] text-xs rounded-xl p-3 focus:outline-none focus:border-[#ffdca1]"
                  >
                    {currentCompany.sites.map(s => (
                      <option key={s.id} value={s.name}>{s.name}</option>
                    ))}
                  </select>
                ) : (
                  <div className="w-full bg-[#131313] border border-[#a1e8a2]/30 text-[#a1e8a2] text-xs rounded-xl p-3 font-bold flex items-center space-x-1.5 select-none">
                    <span className="material-symbols-outlined text-sm">lock</span>
                    <span>{currentUser?.siteName || selectedSiteFilter}</span>
                  </div>
                )}
              </div>

              <div>
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Araç Plakası</label>
                <select
                  value={refuelPlate}
                  onChange={(e) => setRefuelPlate(e.target.value)}
                  className="w-full bg-[#131313] border border-[#353535] text-[#e5e2e1] text-xs rounded-xl p-3 focus:outline-none focus:border-[#ffdca1]"
                >
                  {vehicles
                    .filter(v => isManagerMode || v.siteName === (currentUser?.siteName || refuelSite))
                    .map(v => (
                      <option key={v.id} value={v.plate}>{v.plate} — ({v.assignedDriver})</option>
                    ))}
                </select>
              </div>

              <div>
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Şoför Adı</label>
                <input
                  type="text"
                  value={refuelDriver}
                  onChange={(e) => setRefuelDriver(e.target.value)}
                  className="w-full bg-[#131313] border border-[#353535] text-[#e5e2e1] text-xs rounded-xl p-3 focus:outline-none focus:border-[#ffdca1]"
                  required
                />
              </div>

              <div>
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Verilen Yakıt Miktarı (Litre)</label>
                <input
                  type="number"
                  value={refuelLiters}
                  onChange={(e) => setRefuelLiters(Number(e.target.value))}
                  min={1}
                  max={2000}
                  className="w-full bg-[#131313] border border-[#353535] text-[#e5e2e1] font-mono font-bold text-sm rounded-xl p-3 focus:outline-none focus:border-[#ffdca1]"
                  required
                />
              </div>

              <div className="pt-4 border-t border-[#353535] flex items-center justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setIsRefuelModalOpen(false)}
                  className="px-4 py-2.5 bg-[#20201f] text-[#d5c4ab] rounded-xl text-xs font-bold hover:text-[#e5e2e1]"
                >
                  İptal
                </button>
                <button
                  type="submit"
                  className="px-5 py-2.5 bg-[#ffdca1] text-[#412d00] rounded-xl text-xs font-black hover:bg-[#ffe5b9]"
                >
                  İkmalı Kaydet
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
};
