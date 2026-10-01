import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useApp } from '../../context/AppContext';
import { usePermissions } from '../../hooks/usePermissions';
import { API_BASE_URL } from '../../utils/api';
import { recordMeterReading, resolveMeterTypeForVehicleType, currentPeriodLabel, formatSuspicionDetail } from '../../hooks/useMeterReadings';

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
    calculateCalibratedLiters,
    isAuthenticated,
    isSocketConnected,
    siteEmergencyStatus,
    fetchSiteEmergencyStatus,
    emergencyStopSite,
    emergencyResumeSite
  } = useApp();

  // FE-803: rota /santiye-panel App.tsx'te <RoleRoute allow={SITE_PANEL}> ile
  // zaten sarılı; buradaki kontrol defense-in-depth (App.tsx sarmalayıcısı
  // kaldırılsa bile korunur) ve "Pompayı Başlat & İkmal Et" butonunun
  // POST /dispense yetkisi olmayan bir role hiç render edilmemesi için.
  const { can } = usePermissions();
  const canDispense = can('DISPENSE_FUEL');

  if (!isAuthenticated) {
    return <Navigate to="/santiye-login" replace />;
  }
  if (currentUser?.mustChangePassword) {
    return <Navigate to="/parola-degistir" replace />;
  }

  // TEST-1004: şantiye yöneticisi kendi şantiyesinin ikmal raporunu (REP-711, CSV) indirebilir — sunucu kapsamı JWT'deki şantiyeye zorlar.
  const handleDownloadReport = async () => {
    setReportError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/reports/rep-711/export?format=csv`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('YAKIT_ACCESS_TOKEN') ?? ''}` }
      });
      if (!res.ok) throw new Error(`Rapor indirilemedi (HTTP ${res.status}).`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `ikmal-raporu-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setReportError(err?.message ?? 'Rapor indirilemedi.');
    }
  };

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
  const [reportError, setReportError] = useState<string | null>(null);

  // FE-811 AC: "Acil durdurma ... onay gerektirmeli ve audit'lenmelidir."
  const [isStopConfirmOpen, setIsStopConfirmOpen] = useState(false);
  const [stopReason, setStopReason] = useState('');
  const [isStopActionBusy, setIsStopActionBusy] = useState(false);

  useEffect(() => {
    fetchSiteEmergencyStatus(activeSiteName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSiteName]);

  const handleConfirmEmergencyStop = async () => {
    if (stopReason.trim().length < 5) return;
    setIsStopActionBusy(true);
    try {
      if (await emergencyStopSite(activeSiteName, stopReason.trim())) {
        setIsStopConfirmOpen(false);
        setStopReason('');
      }
    } finally {
      setIsStopActionBusy(false);
    }
  };

  const handleResume = async () => {
    setIsStopActionBusy(true);
    try {
      await emergencyResumeSite(activeSiteName);
    } finally {
      setIsStopActionBusy(false);
    }
  };

  // FE-813 Kapsam: "Sahada tablet ile giriş yapılır; sayısal klavye ve büyük
  // dokunma alanları kullanılmalıdır." SITE_MANAGER (bu panel) /panel'e HİÇ
  // giremediğinden (ROLE_GROUPS.PANEL yalnızca SUPER_ADMIN/COMPANY_OWNER)
  // MeterReadingsPage.tsx'in tam grid'i ona ulaşmıyor — bu yüzden AYRI,
  // küçük ve dokunma-dostu bir tekil giriş bölümü (toplu yapıştırma YOK,
  // o ofis panelinin işi). Aynı backend uçlarını (FLEET-1404/RES-903)
  // doğrudan çağırır, yeni bir endpoint İCAT EDİLMEDİ.
  const [meterVehicleId, setMeterVehicleId] = useState<string>(siteVehicles[0]?.id || '');
  const [meterValue, setMeterValue] = useState('');
  const [isSavingMeter, setIsSavingMeter] = useState(false);
  const [meterSuspicion, setMeterSuspicion] = useState<{ reasons: string[]; detail: string } | null>(null);
  const [meterOverrideReason, setMeterOverrideReason] = useState('');
  const [meterError, setMeterError] = useState<string | null>(null);
  const [meterSuccess, setMeterSuccess] = useState<string | null>(null);

  const handleSaveMeterReading = async (overrideReason?: string) => {
    const vehicle = siteVehicles.find(v => v.id === meterVehicleId);
    const value = Number(meterValue);
    setMeterError(null);
    setMeterSuccess(null);
    if (!vehicle || !meterValue || Number.isNaN(value) || value < 0) {
      setMeterError('Geçerli bir sayaç değeri girin.');
      return;
    }
    setIsSavingMeter(true);
    try {
      await recordMeterReading(vehicle.id, {
        value,
        periodLabel: currentPeriodLabel(),
        meterType: resolveMeterTypeForVehicleType(vehicle.type),
        overrideReason
      });
      setMeterValue('');
      setMeterSuspicion(null);
      setMeterOverrideReason('');
      setMeterSuccess(`${vehicle.plate} için sayaç kaydedildi.`);
    } catch (err: any) {
      if (err.details?.error === 'METER_READING_SUSPICIOUS') {
        setMeterSuspicion({ reasons: err.details.reasons, detail: formatSuspicionDetail(err.details.detail) });
      } else {
        setMeterError(err.message);
      }
    } finally {
      setIsSavingMeter(false);
    }
  };
  // TEST_PLAN §2.2 — POST /dispense'in sunucuda doğal tekrar anahtarı yok;
  // `disabled={isPumpActive}` yalnızca bir SONRAKİ render'da yansır. Aynı
  // render içindeki ikinci submit'i senkron ref durdurur (OverviewPage ile aynı
  // desen, e2e/double-submit.spec.ts ile doğrulandı).
  const dispenseInFlightRef = useRef(false);

  const handleStartRefuel = async (e: React.FormEvent) => {
    e.preventDefault();
    const vehicle = vehicles.find(v => v.id === selectedVehicleId) || siteVehicles[0];
    const driver = drivers.find(d => d.id === selectedDriverId) || siteDrivers[0];
    const tank = siteTanks[0];

    if (!vehicle || !driver || !tank) return;
    if (dispenseInFlightRef.current) return;
    dispenseInFlightRef.current = true;

    setIsPumpActive(true);

    const netCalibratedLiters = calculateCalibratedLiters(amountLiters);

    // Önceden bu kayıt sadece client-side setTimeout ile "tamamlandı" gibi
    // gösteriliyordu ve hiçbir zaman backend'e yazılmıyordu. addFuelTransaction
    // artık gerçek POST /dispense çağrısı yapıyor; hata durumunda kendi
    // toast'ını gösterip fırlatıyor, burada sadece pompa animasyonunu kapatmak
    // için yakalıyoruz.
    try {
      await addFuelTransaction({
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
    } catch {
      // addFuelTransaction zaten hata toast'ını gösterdi.
    } finally {
      dispenseInFlightRef.current = false;
      setIsPumpActive(false);
    }
  };

  return (
    <div data-testid="site-panel" className="min-h-screen bg-[#131313] text-[#e5e2e1] flex flex-col font-sans antialiased">
      
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
            <p data-testid="site-panel-site-name" className="text-[10px] text-[#a1e8a2] font-mono font-bold">{activeSiteName}</p>
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
            data-testid="site-logout"
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

        {/* FE-811 AC: "Bağlantı koptuğunda kullanıcı açıkça uyarılmalıdır."
            FE-801'in zaten dinlediği isSocketConnected — TankStatusPage İLE
            AYNI desen; bu panelde önceden HİÇ gösterilmiyordu. */}
        {!isSocketConnected && (
          <div data-testid="site-connection-lost-warning" className="bg-[#93000a]/10 border border-[#93000a]/40 rounded-xl p-3.5 flex items-center gap-2.5 text-xs font-bold text-[#ffb4ab]">
            <span className="material-symbols-outlined text-lg">wifi_off</span>
            <span>Bağlantı yenileniyor — tank/pompa verileri ESKİ (doğrulanmamış) olabilir.</span>
          </div>
        )}

        {/* FE-811 AC: "Acil durdurma onay gerektirmeli ve audit'lenmelidir." */}
        {siteEmergencyStatus?.isStopped && (
          <div data-testid="site-emergency-stopped-banner" className="bg-[#93000a]/15 border border-[#93000a]/50 rounded-xl p-4 flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center space-x-2.5 text-[#ffb4ab]">
              <span className="material-symbols-outlined text-xl">dangerous</span>
              <span className="text-xs font-bold">ŞANTİYE ACİL DURDURULDU — {siteEmergencyStatus.blockedDeviceCount} cihaz bloke.</span>
            </div>
            <button
              data-testid="site-emergency-resume"
              onClick={handleResume}
              disabled={isStopActionBusy}
              className="px-4 py-2 bg-[#a1e8a2] hover:bg-[#bbf4bd] text-[#0d3811] font-black text-xs rounded-xl cursor-pointer disabled:opacity-50"
            >
              {isStopActionBusy ? 'İşleniyor...' : 'Devam Ettir'}
            </button>
          </div>
        )}

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
          <div className="flex items-center space-x-3">
            {!siteEmergencyStatus?.isStopped && (
              <div className="text-[11px] font-mono text-[#a1e8a2] bg-[#20201f] border border-[#353535] px-3 py-1 rounded-lg flex items-center space-x-2">
                <span className="w-2 h-2 rounded-full bg-[#a1e8a2] animate-ping"></span>
                <span>POMPA SOLENOİD: HAZIR</span>
              </div>
            )}
            <button
              data-testid="site-emergency-stop-open"
              onClick={() => setIsStopConfirmOpen(true)}
              disabled={siteEmergencyStatus?.isStopped}
              className="px-4 py-2 bg-[#93000a] hover:bg-[#b5000d] text-[#ffdad6] font-black text-xs rounded-xl flex items-center space-x-1.5 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <span className="material-symbols-outlined text-base">emergency</span>
              <span>ACİL DURDUR</span>
            </button>
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
                    data-testid="site-tank"
                    data-tank-name={tank.name}
                    data-level-liters={tank.currentLevelLiters}
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

              {canDispense ? (
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
              ) : (
                // FE-803: ikmal başlatma yetkisi olmayan rol — buton DOM'da yok.
                <div className="w-full py-3 px-4 bg-[#20201f] border border-[#353535] text-[#d5c4ab] font-bold text-xs rounded-xl flex items-center justify-center space-x-2 mt-4 select-none">
                  <span className="material-symbols-outlined text-base">lock</span>
                  <span>İkmal başlatma yetkiniz yok</span>
                </div>
              )}

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
            <div className="flex items-center space-x-3">
              <span className="text-xs font-mono text-[#d5c4ab]">Şantiye: {activeSiteName}</span>
              <button
                type="button"
                data-testid="site-report-download"
                onClick={handleDownloadReport}
                className="flex items-center space-x-1.5 bg-[#20201f] hover:bg-[#282726] border border-[#353535] text-[#a1e8a2] px-3 py-1.5 rounded-xl text-xs font-bold cursor-pointer"
              >
                <span className="material-symbols-outlined text-sm">download</span>
                <span>İkmal Raporunu İndir (CSV)</span>
              </button>
            </div>
            {reportError && <span data-testid="site-report-error" className="text-xs text-[#ffb4ab]">{reportError}</span>}
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
                  <tr key={tx.id} data-testid="site-tx-row" data-tx-id={tx.id} data-plate={tx.vehiclePlate} data-liters={tx.amountLiters} className="hover:bg-[#20201f] transition-colors">
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

        {/* FE-813 — sahada tablet için büyük dokunma alanlı tekil km/motor-saat girişi. */}
        <div data-testid="meter-entry-card" className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-5 space-y-4">
          <h3 className="text-sm font-extrabold text-[#e5e2e1] uppercase tracking-wide">Km / Motor-Saat Girişi</h3>
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3">
            <select
              data-testid="meter-vehicle-select"
              value={meterVehicleId}
              onChange={(e) => { setMeterVehicleId(e.target.value); setMeterSuspicion(null); setMeterError(null); setMeterSuccess(null); }}
              className="bg-[#0e0e0e] border border-[#353535] text-[#e5e2e1] text-sm rounded-xl p-4 focus:outline-none focus:border-[#ffdca1]"
            >
              {siteVehicles.map(v => (
                <option key={v.id} value={v.id}>{v.plate} ({resolveMeterTypeForVehicleType(v.type) === 'KM' ? 'Km' : 'Motor-Saat'})</option>
              ))}
            </select>
            <input
              type="number"
              inputMode="numeric"
              data-testid="meter-value-input"
              value={meterValue}
              onChange={(e) => setMeterValue(e.target.value)}
              placeholder="Sayaç değeri"
              className="bg-[#0e0e0e] border border-[#353535] text-[#e5e2e1] text-sm rounded-xl p-4 focus:outline-none focus:border-[#ffdca1]"
            />
            <button
              data-testid="meter-save"
              onClick={() => handleSaveMeterReading()}
              disabled={isSavingMeter || !meterValue}
              className="px-6 py-4 bg-[#ffdca1] text-[#412d00] rounded-xl text-sm font-black cursor-pointer disabled:opacity-40"
            >
              {isSavingMeter ? 'Kaydediliyor...' : 'Kaydet'}
            </button>
          </div>

          {meterError && <p data-testid="meter-error" className="text-xs text-[#ffb4ab]">{meterError}</p>}
          {meterSuccess && <p data-testid="meter-success" className="text-xs text-[#a1e8a2]">{meterSuccess}</p>}

          {meterSuspicion && (
            <div data-testid="meter-suspicion" className="bg-[#2a1f10] border border-[#ffb800]/30 rounded-xl p-4 space-y-3">
              <p className="text-xs text-[#ffb4ab] font-bold">
                Şüpheli giriş: {meterSuspicion.reasons.join(', ')} — {meterSuspicion.detail}
              </p>
              <div className="flex flex-col sm:flex-row gap-3">
                <input
                  type="text"
                  data-testid="meter-override-reason-input"
                  value={meterOverrideReason}
                  onChange={(e) => setMeterOverrideReason(e.target.value)}
                  placeholder="Onay gerekçesi (en az 3 karakter)..."
                  className="flex-1 bg-[#0e0e0e] border border-[#353535] text-[#e5e2e1] text-sm rounded-xl p-4 focus:outline-none focus:border-[#ffdca1]"
                />
                <button
                  data-testid="meter-override-confirm"
                  onClick={() => handleSaveMeterReading(meterOverrideReason.trim())}
                  disabled={meterOverrideReason.trim().length < 3 || isSavingMeter}
                  className="px-6 py-4 bg-[#ffb4ab] text-[#412d00] rounded-xl text-sm font-black cursor-pointer disabled:opacity-40"
                >
                  Onayla ve Kaydet
                </button>
              </div>
            </div>
          )}
        </div>

      </main>

      {/* Footer */}
      <footer className="text-center text-xs text-[#d5c4ab]/60 font-mono max-w-6xl w-full mx-auto py-4 border-t border-[#353535] select-none">
        Akıllı Şantiye Saha İkmal Terminali © 2026 — Endüstriyel IoT Otomasyonu
      </footer>

      {/* FE-811: Acil Durdurma Onay Diyaloğu — Teknik Not: "yanlışlıkla
          basılmaya çok açıktır; onay diyaloğu ve 'kim durdurdu' kaydı
          zorunludur." Gerekçe metni ZORUNLU (sunucu da reddeder, bkz.
          emergencyStopSchema) — rastgele/dikkatsiz bir tıklama durduramaz. */}
      {isStopConfirmOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div data-testid="site-emergency-stop-modal" className="bg-[#1c1b1b] border border-[#93000a]/50 rounded-2xl max-w-md w-full p-6 space-y-5 shadow-2xl">
            <div className="flex items-center space-x-3 text-[#ffb4ab]">
              <div className="w-10 h-10 rounded-xl bg-[#93000a]/20 border border-[#93000a] flex items-center justify-center shrink-0">
                <span className="material-symbols-outlined text-2xl">emergency</span>
              </div>
              <div>
                <h3 className="font-extrabold text-sm text-[#e5e2e1] uppercase font-mono tracking-wide">ACİL DURDURMA ONAYI</h3>
                <span className="text-[10px] text-[#ffdca1] font-mono">{activeSiteName}</span>
              </div>
            </div>

            <div className="bg-[#141313] border border-[#353535] rounded-xl p-4 text-xs text-[#d5c4ab] font-mono leading-relaxed">
              <p>Bu şantiyedeki <strong className="text-[#ffb4ab]">TÜM</strong> pompa/debimetre cihazları ANINDA bloke edilecek — hiçbir araç yakıt alamayacak. Bu işlem kaydınızla (kullanıcı adınız) birlikte denetim izine (audit log) yazılır.</p>
            </div>

            <div>
              <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Durdurma Gerekçesi (zorunlu, en az 5 karakter)</label>
              <input
                type="text"
                data-testid="site-emergency-stop-reason-input"
                value={stopReason}
                onChange={(e) => setStopReason(e.target.value)}
                placeholder="örn. Hortum sızıntısı tespit edildi"
                autoFocus
                className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-3 focus:outline-none focus:border-[#ffb4ab]"
              />
            </div>

            <div className="flex items-center justify-end space-x-3 pt-1">
              <button
                type="button"
                onClick={() => { setIsStopConfirmOpen(false); setStopReason(''); }}
                className="px-4 py-2.5 bg-[#20201f] hover:bg-[#353535] border border-[#514532]/40 text-[#e5e2e1] font-mono text-xs rounded-xl transition-colors cursor-pointer font-bold"
              >
                İptal / Vazgeç
              </button>
              <button
                type="button"
                data-testid="site-emergency-stop-confirm"
                onClick={handleConfirmEmergencyStop}
                disabled={isStopActionBusy || stopReason.trim().length < 5}
                className="px-5 py-2.5 bg-gradient-to-r from-[#93000a] to-[#b5000d] hover:from-[#b5000d] hover:to-[#d4000f] text-[#ffdad6] font-black rounded-xl text-xs uppercase tracking-wider transition-all cursor-pointer shadow-lg flex items-center space-x-1.5 disabled:opacity-40"
              >
                <span className="material-symbols-outlined text-base">dangerous</span>
                <span>{isStopActionBusy ? 'Durduruluyor...' : 'Evet, Acil Durdur'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
