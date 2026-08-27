import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useApp } from '../../context/AppContext';

export const SiteOperatorPanel: React.FC = () => {
  const navigate = useNavigate();
  const { 
    currentUser, 
    logoutCompany, 
    selectedSiteFilter, 
    tanks, 
    vehicles, 
    drivers, 
    transactions, 
    addFuelTransaction,
    calibrationMultiplier,
    calculateCalibratedLiters
  } = useApp();

  const activeSiteName = currentUser?.siteName || (selectedSiteFilter !== 'TÜMÜ' ? selectedSiteFilter : 'Gebze Ana Şantiye');

  // Filter site-specific tanks & vehicles
  const siteTanks = tanks.filter(t => t.siteName === activeSiteName || selectedSiteFilter === 'TÜMÜ');
  const siteVehicles = vehicles.filter(v => v.siteName === activeSiteName || selectedSiteFilter === 'TÜMÜ');
  const siteDrivers = drivers.filter(d => d.siteName === activeSiteName || selectedSiteFilter === 'TÜMÜ');
  const siteTransactions = transactions.filter(t => t.siteName === activeSiteName || selectedSiteFilter === 'TÜMÜ');

  // Quick Refuel Form State
  const [selectedVehicleId, setSelectedVehicleId] = useState<string>(siteVehicles[0]?.id || '');
  const [selectedDriverId, setSelectedDriverId] = useState<string>(siteDrivers[0]?.id || '');
  const [amountLiters, setAmountLiters] = useState<number>(150);
  const [isPumpActive, setIsPumpActive] = useState<boolean>(false);

  const handleStartRefuel = (e: React.FormEvent) => {
    e.preventDefault();
    const vehicle = vehicles.find(v => v.id === selectedVehicleId) || siteVehicles[0];
    const driver = drivers.find(d => d.id === selectedDriverId) || siteDrivers[0];
    const tank = siteTanks[0];

    if (!vehicle || !driver || !tank) return;

    setIsPumpActive(true);

    const netCalibratedLiters = calculateCalibratedLiters(amountLiters);

    setTimeout(() => {
      addFuelTransaction({
        siteName: activeSiteName,
        vehiclePlate: vehicle.plate,
        driverName: driver.name,
        tankName: tank.name,
        amountLiters: netCalibratedLiters,
        flowRateLpm: Number((52.4 * calibrationMultiplier).toFixed(1)),
        pumpStatus: 'TAMAMLANTI',
        type: 'Otomatik',
        rfidAuth: true
      });
      setIsPumpActive(false);
    }, 1200);
  };

  return (
    <div className="min-h-screen bg-[#131313] text-[#e5e2e1] flex flex-col font-sans antialiased">
      
      {/* Top Header */}
      <header className="h-16 bg-[#1c1b1b] border-b border-[#353535] px-6 flex items-center justify-between sticky top-0 z-30 select-none">
        
        <div className="flex items-center space-x-3">
          <div className="w-9 h-9 rounded-xl bg-[#a1e8a2] text-[#0d3811] flex items-center justify-center font-black shadow">
            <span className="material-symbols-outlined text-xl">construction</span>
          </div>
          <div>
            <h1 className="font-extrabold text-[#e5e2e1] text-xs tracking-wider uppercase">
              ŞANTİYE SAHA OPERATÖR PANELİ
            </h1>
            <p className="text-[10px] text-[#a1e8a2] font-mono font-bold">{activeSiteName}</p>
          </div>
        </div>

        <div className="flex items-center space-x-4">
          
          {/* User badge */}
          <div className="flex items-center space-x-2.5 bg-[#20201f] border border-[#353535] px-3 py-1.5 rounded-xl">
            <div className="w-6 h-6 rounded-full bg-[#a1e8a2] text-[#0d3811] flex items-center justify-center text-[10px] font-black uppercase">
              {currentUser?.username ? currentUser.username.substring(0, 2) : 'SO'}
            </div>
            <div className="hidden sm:block">
              <p className="text-xs font-bold text-[#e5e2e1] leading-tight">
                {currentUser?.username || 'Saha Operatörü'}
              </p>
              <p className="text-[9px] text-[#d5c4ab] font-mono">Pompa Yetkilisi</p>
            </div>
          </div>

          {/* Logout button */}
          <button
            onClick={() => {
              logoutCompany();
              navigate('/santiye-login');
            }}
            className="flex items-center space-x-1.5 bg-[#ffb4ab]/10 hover:bg-[#ffb4ab]/20 border border-[#ffb4ab]/30 text-[#ffb4ab] px-3 py-1.5 rounded-xl text-xs font-bold transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-sm">logout</span>
            <span className="hidden sm:inline">Çıkış Yap</span>
          </button>

        </div>

      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6 md:p-8 space-y-6">
        
        {/* Notice Info Box for restricted site personnel */}
        <div className="bg-[#1c1b1b] border border-[#353535] p-4 rounded-2xl flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-xl bg-[#ffdca1]/10 text-[#ffdca1] flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-lg">info</span>
            </div>
            <div>
              <p className="text-xs font-bold text-[#e5e2e1]">Saha İkmal & Pompa Yetkilisi Erişim Modu</p>
              <p className="text-[11px] text-[#d5c4ab]">
                Bu panel sadece <strong>{activeSiteName}</strong> yakıt ikmalleri ve tank takibi içindir. Genel ayarlar için Firma Yetkilisi girişi gereklidir.
              </p>
            </div>
          </div>
          <div className="text-[11px] font-mono text-[#a1e8a2] bg-[#20201f] border border-[#353535] px-3 py-1 rounded-lg flex items-center space-x-2">
            <span className="w-2 h-2 rounded-full bg-[#a1e8a2] animate-ping"></span>
            <span>POMPA SOLENOİD: HAZIR</span>
          </div>
        </div>

        {/* Top Grid: Tank Status & Quick Refuel Activation */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          {/* Column 1 & 2: Active Site Tank Indicators */}
          <div className="lg:col-span-2 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-extrabold text-[#e5e2e1] uppercase tracking-wider flex items-center space-x-2">
                <span className="material-symbols-outlined text-base text-[#a1e8a2]">oil_barrel</span>
                <span>Şantiye Tank Durumu ({siteTanks.length})</span>
              </h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {siteTanks.map((tank) => {
                const percentage = Math.round((tank.currentLevelLiters / tank.capacityLiters) * 100);
                return (
                  <motion.div
                    key={tank.id}
                    whileHover={{ y: -2 }}
                    className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-5 space-y-4 relative overflow-hidden"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="font-extrabold text-sm text-[#e5e2e1]">{tank.name}</h3>
                        <p className="text-[10px] text-[#d5c4ab] font-mono">{tank.fuelType}</p>
                      </div>
                      <span className={`text-[10px] font-mono font-bold px-2.5 py-1 rounded-full border ${
                        tank.status === 'KRİTİK' ? 'bg-[#ffb4ab]/10 border-[#ffb4ab]/40 text-[#ffb4ab]' :
                        tank.status === 'UYARI' ? 'bg-[#ffdca1]/10 border-[#ffdca1]/40 text-[#ffdca1]' :
                        'bg-[#a1e8a2]/10 border-[#a1e8a2]/40 text-[#a1e8a2]'
                      }`}>
                        %{percentage} Dolu
                      </span>
                    </div>

                    {/* Progress Bar */}
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs font-mono font-bold">
                        <span className="text-[#e5e2e1]">{tank.currentLevelLiters.toLocaleString()} Litre</span>
                        <span className="text-[#d5c4ab]">{tank.capacityLiters.toLocaleString()} L</span>
                      </div>
                      <div className="w-full h-3 bg-[#20201f] border border-[#353535] rounded-full overflow-hidden p-0.5">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${
                            percentage < 20 ? 'bg-[#ffb4ab]' : percentage < 40 ? 'bg-[#ffdca1]' : 'bg-[#a1e8a2]'
                          }`}
                          style={{ width: `${percentage}%` }}
                        />
                      </div>
                    </div>

                    <div className="pt-2 border-t border-[#353535] flex items-center justify-between text-[11px] font-mono text-[#d5c4ab]">
                      <span className="flex items-center space-x-1">
                        <span className="material-symbols-outlined text-sm">thermostat</span>
                        <span>{tank.temperatureC}°C</span>
                      </span>
                      <span className="flex items-center space-x-1">
                        <span className="material-symbols-outlined text-sm">sensors</span>
                        <span>{tank.sensorId}</span>
                      </span>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </div>

          {/* Column 3: Quick Pump Refuel Trigger */}
          <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 space-y-4">
            <div className="flex items-center space-x-2 pb-3 border-b border-[#353535]">
              <div className="w-8 h-8 rounded-xl bg-[#a1e8a2]/10 text-[#a1e8a2] flex items-center justify-center font-bold">
                <span className="material-symbols-outlined text-lg">local_gas_station</span>
              </div>
              <div>
                <h3 className="font-extrabold text-sm text-[#e5e2e1]">Saha Pompa İkmali Başlat</h3>
                <p className="text-[10px] text-[#d5c4ab] font-mono">Manuel / Otomatik İkmal Kaydı</p>
              </div>
            </div>

            <form onSubmit={handleStartRefuel} className="space-y-3">
              
              <div className="space-y-1">
                <label className="text-xs font-bold text-[#d5c4ab] block">İkmal Yapılacak Araç</label>
                <select
                  value={selectedVehicleId}
                  onChange={(e) => setSelectedVehicleId(e.target.value)}
                  className="w-full p-2.5 bg-[#20201f] border border-[#353535] rounded-xl text-xs font-bold text-[#e5e2e1] outline-none cursor-pointer"
                >
                  {siteVehicles.map(v => (
                    <option key={v.id} value={v.id} className="bg-[#1c1b1b]">
                      {v.plate} - {v.brandModel} ({v.type})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-bold text-[#d5c4ab] block">İkmal Eden Şoför</label>
                <select
                  value={selectedDriverId}
                  onChange={(e) => setSelectedDriverId(e.target.value)}
                  className="w-full p-2.5 bg-[#20201f] border border-[#353535] rounded-xl text-xs font-bold text-[#e5e2e1] outline-none cursor-pointer"
                >
                  {siteDrivers.map(d => (
                    <option key={d.id} value={d.id} className="bg-[#1c1b1b]">
                      {d.name} ({d.tcNo})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <div className="flex justify-between items-center">
                  <label className="text-xs font-bold text-[#d5c4ab] block">Verilecek Yakıt (Ham Litre / Pulse)</label>
                  <span className="text-[10px] font-mono text-[#ffdca1] bg-[#ffdca1]/10 px-1.5 py-0.5 rounded border border-[#ffdca1]/20">
                    Çarpan: x{calibrationMultiplier}
                  </span>
                </div>
                <input
                  type="number"
                  min="1"
                  max="10000"
                  value={amountLiters}
                  onChange={(e) => setAmountLiters(Number(e.target.value))}
                  className="w-full p-2.5 bg-[#20201f] border border-[#353535] rounded-xl text-xs font-bold font-mono text-[#a1e8a2] outline-none"
                />
                <div className="flex items-center justify-between text-[11px] font-mono pt-1 text-[#d5c4ab]">
                  <span>Net Pompa Çıkışı:</span>
                  <span className="text-[#a1e8a2] font-bold">
                    {calculateCalibratedLiters(amountLiters)} Litre
                  </span>
                </div>
              </div>

              <button
                type="submit"
                disabled={isPumpActive}
                className="w-full py-3 px-4 bg-[#a1e8a2] hover:bg-[#bbf4bd] text-[#0d3811] font-extrabold text-xs rounded-xl flex items-center justify-center space-x-2 transition-all cursor-pointer disabled:opacity-50 mt-4 shadow-lg"
              >
                {isPumpActive ? (
                  <>
                    <span className="w-4 h-4 border-2 border-[#0d3811] border-t-transparent rounded-full animate-spin"></span>
                    <span>Pompa Akışı Aktif...</span>
                  </>
                ) : (
                  <>
                    <span className="material-symbols-outlined text-base">play_arrow</span>
                    <span>Pompayı Başlat & İkmal Et</span>
                  </>
                )}
              </button>

            </form>
          </div>

        </div>

        {/* Bottom Section: Recent Refuel Transactions Log */}
        <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-extrabold text-[#e5e2e1] uppercase tracking-wider flex items-center space-x-2">
              <span className="material-symbols-outlined text-base text-[#a1e8a2]">receipt_long</span>
              <span>Son Saha İkmal Kayıtları ({siteTransactions.length})</span>
            </h2>
            <span className="text-xs font-mono text-[#d5c4ab]">Şantiye: {activeSiteName}</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#353535] text-[11px] font-mono text-[#d5c4ab] uppercase">
                  <th className="py-2.5 px-3">Tarih / Saat</th>
                  <th className="py-2.5 px-3">Plaka</th>
                  <th className="py-2.5 px-3">Şoför</th>
                  <th className="py-2.5 px-3 text-right">Miktar (Litre)</th>
                  <th className="py-2.5 px-3 text-right">Debi (L/dk)</th>
                  <th className="py-2.5 px-3 text-center">Durum</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#353535] text-xs">
                {siteTransactions.slice(0, 8).map((tx) => (
                  <tr key={tx.id} className="hover:bg-[#20201f] transition-colors">
                    <td className="py-3 px-3 font-mono text-[#d5c4ab]">{tx.timestamp}</td>
                    <td className="py-3 px-3 font-extrabold text-[#e5e2e1]">{tx.vehiclePlate}</td>
                    <td className="py-3 px-3 text-[#d5c4ab]">{tx.driverName}</td>
                    <td className="py-3 px-3 text-right font-mono font-bold text-[#a1e8a2]">
                      {tx.amountLiters} L
                    </td>
                    <td className="py-3 px-3 text-right font-mono text-[#d5c4ab]">{tx.flowRateLpm}</td>
                    <td className="py-3 px-3 text-center">
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-[#a1e8a2]/10 text-[#a1e8a2] border border-[#a1e8a2]/30">
                        {tx.pumpStatus}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

      </main>

      {/* Footer */}
      <footer className="text-center text-xs text-[#d5c4ab]/60 font-mono max-w-6xl w-full mx-auto py-4 border-t border-[#353535] select-none">
        Akıllı Şantiye Saha İkmal Terminali © 2026 — Endüstriyel IoT Otomasyonu
      </footer>

    </div>
  );
};
