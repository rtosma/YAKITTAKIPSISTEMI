import React, { useEffect, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { FuelQuota } from '../../types';

const PERIOD_LABELS: Record<FuelQuota['periodType'], string> = {
  DAILY: 'Günlük',
  WEEKLY: 'Haftalık',
  MONTHLY: 'Aylık',
  ONE_TIME: 'Tek Seferlik'
};
const CARRYOVER_LABELS: Record<FuelQuota['carryoverPolicy'], string> = {
  NONE: 'Devretmez',
  FULL: 'Tamamı Devreder',
  CAPPED: 'Sınırlı Devreder'
};

export const CrossSitePage: React.FC = () => {
  const {
    crossSitePermissions, toggleCrossSiteStatus, vehicles, drivers, currentCompany, addCrossSitePermission, isManagerMode, currentUser, selectedSiteFilter,
    fuelQuotas, createFuelQuota, setFuelQuotaStatus, quotaBalances, fetchQuotaBalance,
    crossSiteSettlementSummary
  } = useApp();

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedPlate, setSelectedPlate] = useState(vehicles[0]?.plate || '35 EGE 40');
  const [targetSite, setTargetSite] = useState(currentCompany.sites[0]?.name || 'Gebze Ana Şantiye');
  const [allowedLiters, setAllowedLiters] = useState<number>(300);

  // FE-810 Kapsam: "Kota tanımı: litre, dönem, geçerlilik aralığı, devir
  // politikası." GENEL fuel_quotas (FUEL-402.1) — yukarıdaki çapraz şantiye
  // İZNİNDEN (kendi allowed_liters/usedLiters'ı olan, ayrı bir kavram) FARKLI.
  const [isQuotaModalOpen, setIsQuotaModalOpen] = useState(false);
  const [quotaScope, setQuotaScope] = useState<'VEHICLE' | 'SITE' | 'ALL'>('VEHICLE');
  const [quotaVehiclePlate, setQuotaVehiclePlate] = useState(vehicles[0]?.plate || '');
  const [quotaSiteName, setQuotaSiteName] = useState(currentCompany.sites[0]?.name || '');
  const [quotaPeriodType, setQuotaPeriodType] = useState<FuelQuota['periodType']>('MONTHLY');
  const [quotaLimitLiters, setQuotaLimitLiters] = useState<number>(1000);
  const [quotaCarryoverPolicy, setQuotaCarryoverPolicy] = useState<FuelQuota['carryoverPolicy']>('NONE');
  const [quotaValidUntil, setQuotaValidUntil] = useState<string>('');
  const [isSavingQuota, setIsSavingQuota] = useState(false);

  // Her kota için bakiyeyi (kalan/kullanılan) bir kez çek — GET /quotas/:id/balance
  // zaten 5 sn sunucu tarafı cache'li, burada tekrar tekrar çağrılmıyor.
  useEffect(() => {
    fuelQuotas.forEach((q) => {
      if (!quotaBalances[q.id]) fetchQuotaBalance(q.id);
    });
  }, [fuelQuotas]);

  const visiblePermissions = isManagerMode
    ? crossSitePermissions
    : crossSitePermissions.filter(p => p.homeSite === (currentUser?.siteName || selectedSiteFilter) || p.targetSite === (currentUser?.siteName || selectedSiteFilter));

  const handleCreateQuota = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSavingQuota(true);
    try {
      const ok = await createFuelQuota({
        vehiclePlate: quotaScope === 'VEHICLE' ? quotaVehiclePlate : undefined,
        siteName: quotaScope === 'SITE' ? quotaSiteName : undefined,
        periodType: quotaPeriodType,
        limitLiters: Number(quotaLimitLiters),
        carryoverPolicy: quotaCarryoverPolicy,
        validUntil: quotaValidUntil || undefined
      });
      if (ok) setIsQuotaModalOpen(false);
    } finally {
      setIsSavingQuota(false);
    }
  };

  const handleCreatePermission = (e: React.FormEvent) => {
    e.preventDefault();
    const veh = vehicles.find(v => v.plate === selectedPlate);
    const drvName = veh ? veh.assignedDriver : (drivers[0]?.name || 'Ahmet Yılmaz');
    const homeSite = veh ? veh.siteName : 'Orman Şantiyesi';

    const nextWeek = new Date();
    nextWeek.setDate(nextWeek.getDate() + 7);
    const expiryDate = nextWeek.toISOString().split('T')[0];

    addCrossSitePermission({
      vehiclePlate: selectedPlate,
      driverName: drvName,
      homeSite,
      targetSite,
      allowedLiters: Number(allowedLiters),
      expiryDate
    });

    setIsModalOpen(false);
  };

  return (
    <div className="space-y-6">
      
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-[#1c1b1b] border border-[#353535] p-6 rounded-2xl">
        <div>
          <span className="text-[10px] font-mono text-[#ffdca1] font-bold uppercase tracking-widest">
            ŞANTİYELER ARASI GEÇİCİ İZİN
          </span>
          <h2 className="text-xl font-extrabold text-[#e5e2e1] uppercase mt-0.5">
            Yetkilendirme (Çapraz Şantiye)
          </h2>
          <p className="text-xs text-[#d5c4ab] mt-1">
            Farklı şantiyeye sevk edilen araç ve şoförlerin geçici yakıt alma yetki tanımları
          </p>
        </div>

        <button
          data-testid="crosssite-add-open"
          onClick={() => setIsModalOpen(true)}
          className="bg-[#ffdca1] text-[#412d00] font-black px-4 py-2.5 rounded-xl text-xs flex items-center space-x-2 transition-all cursor-pointer shadow"
        >
          <span className="material-symbols-outlined text-lg">add_moderator</span>
          <span>Geçici İkmal İzni Tanımla</span>
        </button>
      </div>

      {/* Permissions List Table */}
      <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 overflow-x-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-[#353535] text-[#d5c4ab] uppercase text-[10px] tracking-wider font-mono">
              <th className="py-3.5 px-4">Araç Plakası</th>
              <th className="py-3.5 px-4">Şoför</th>
              <th className="py-3.5 px-4">Kendi Şantiyesi</th>
              <th className="py-3.5 px-4">İkmal Alacağı Şantiye</th>
              <th className="py-3.5 px-4">İzin Verilen Miktar</th>
              <th className="py-3.5 px-4">Kullanılan Miktar</th>
              <th className="py-3.5 px-4">Son Geçerlilik</th>
              <th className="py-3.5 px-4">Durum</th>
              <th className="py-3.5 px-4 text-right">İşlem</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#353535] font-mono">
            {visiblePermissions.map(p => (
              <tr key={p.id} data-testid="crosssite-row" data-plate={p.vehiclePlate} data-target-site={p.targetSite} data-permission-status={p.status} className="hover:bg-[#282726] transition-colors">
                <td className="py-3.5 px-4 font-black text-[#ffdca1] text-sm">{p.vehiclePlate}</td>
                <td className="py-3.5 px-4 text-[#e5e2e1] font-bold">{p.driverName}</td>
                <td className="py-3.5 px-4 text-[#d5c4ab]">{p.homeSite}</td>
                <td className="py-3.5 px-4 text-[#a1e8a2] font-bold">{p.targetSite}</td>
                <td className="py-3.5 px-4 text-[#e5e2e1]">{p.allowedLiters} L</td>
                <td className="py-3.5 px-4 text-[#d5c4ab]">{p.usedLiters} L</td>
                <td className="py-3.5 px-4 text-[#d5c4ab]">{p.expiryDate}</td>
                <td className="py-3.5 px-4">
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                    p.status === 'AKTİF' ? 'bg-[#a1e8a2]/10 text-[#a1e8a2]' : 'bg-[#ffb4ab]/10 text-[#ffb4ab]'
                  }`}>
                    {p.status}
                  </span>
                </td>
                <td className="py-3.5 px-4 text-right">
                  <button
                    onClick={() => toggleCrossSiteStatus(p.id)}
                    className="px-3 py-1 bg-[#20201f] hover:bg-[#282726] border border-[#353535] text-[#ffdca1] text-[11px] font-bold rounded-lg cursor-pointer"
                  >
                    {p.status === 'AKTİF' ? 'Kapat' : 'Aktifleştir'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* FE-810 Kapsam: "Kota tanımı/kullanım göstergeleri." GENEL fuel_quotas
          (FUEL-402.1) — yukarıdaki çapraz şantiye izninden AYRI bir kavram:
          araç/şantiye bazlı dönemsel (günlük/haftalık/aylık/tek seferlik) kota. */}
      <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6" data-testid="fuel-quota-section">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4">
          <div>
            <span className="text-[10px] font-mono text-[#ffdca1] font-bold uppercase tracking-widest">
              DÖNEMSEL YAKIT KOTASI
            </span>
            <h3 className="text-base font-extrabold text-[#e5e2e1] uppercase mt-0.5">Kota Tanımları (FUEL-402.1)</h3>
            <p className="text-xs text-[#d5c4ab] mt-1">
              Araç veya şantiye bazlı, dönemsel ve devredebilen yakıt limitleri — yukarıdaki çapraz şantiye izninden ayrı, genel bir kapsam sınırı.
            </p>
          </div>
          <button
            data-testid="quota-add-open"
            onClick={() => setIsQuotaModalOpen(true)}
            className="bg-[#ffdca1] text-[#412d00] font-black px-4 py-2.5 rounded-xl text-xs flex items-center space-x-2 transition-all cursor-pointer shadow shrink-0"
          >
            <span className="material-symbols-outlined text-lg">rule</span>
            <span>Kota Tanımla</span>
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-[#353535] text-[#d5c4ab] uppercase text-[10px] tracking-wider font-mono">
                <th className="py-3 px-4">Kapsam</th>
                <th className="py-3 px-4">Dönem</th>
                <th className="py-3 px-4">Limit</th>
                <th className="py-3 px-4">Devir Politikası</th>
                <th className="py-3 px-4">Kullanım (Kalan/Toplam)</th>
                <th className="py-3 px-4">Durum</th>
                <th className="py-3 px-4 text-right">İşlem</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#353535] font-mono">
              {fuelQuotas.length === 0 && (
                <tr><td colSpan={7} className="py-6 px-4 text-center text-[#d5c4ab]/60">Henüz tanımlı kota yok.</td></tr>
              )}
              {fuelQuotas.map((q) => {
                const balance = quotaBalances[q.id];
                const usagePct = balance ? Math.min(100, Math.round(((balance.effectiveLimitLiters - balance.remainingLiters) / (balance.effectiveLimitLiters || 1)) * 100)) : 0;
                return (
                  <tr key={q.id} data-testid="quota-row" data-quota-status={q.status} className="hover:bg-[#282726] transition-colors">
                    <td className="py-3 px-4 text-[#e5e2e1] font-bold">
                      {q.vehiclePlate || q.siteName || 'Tüm Filo'}
                    </td>
                    <td className="py-3 px-4 text-[#d5c4ab]">{PERIOD_LABELS[q.periodType]}</td>
                    <td className="py-3 px-4 text-[#e5e2e1]">{q.limitLiters} L</td>
                    <td className="py-3 px-4 text-[#d5c4ab]">{CARRYOVER_LABELS[q.carryoverPolicy]}</td>
                    <td className="py-3 px-4 min-w-[140px]" data-testid="quota-balance">
                      {balance ? (
                        <div>
                          <div className="w-full bg-[#20201f] rounded-full h-1.5 overflow-hidden">
                            <div
                              className={`h-full rounded-full ${usagePct >= 100 ? 'bg-[#ffb4ab]' : usagePct >= 80 ? 'bg-[#ffdca1]' : 'bg-[#a1e8a2]'}`}
                              style={{ width: `${usagePct}%` }}
                            />
                          </div>
                          <p className="text-[10px] text-[#d5c4ab] mt-1">{balance.remainingLiters.toFixed(0)} / {balance.effectiveLimitLiters.toFixed(0)} L kaldı</p>
                        </div>
                      ) : (
                        <span className="text-[#d5c4ab]/50">Yükleniyor...</span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                        q.status === 'AKTİF' ? 'bg-[#a1e8a2]/10 text-[#a1e8a2]' : 'bg-[#ffb4ab]/10 text-[#ffb4ab]'
                      }`}>
                        {q.status}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button
                        data-testid="quota-toggle-status"
                        onClick={() => setFuelQuotaStatus(q.id, q.status === 'AKTİF' ? 'PASİF' : 'AKTİF')}
                        className="px-3 py-1 bg-[#20201f] hover:bg-[#282726] border border-[#353535] text-[#ffdca1] text-[11px] font-bold rounded-lg cursor-pointer"
                      >
                        {q.status === 'AKTİF' ? 'Pasifleştir' : 'Aktifleştir'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* FE-810 Kapsam: "Mahsuplaşma özetine hızlı erişim (REP-715)." Tam bir
          rapor merkezi sayfası henüz YOK (hiçbir rapor görüntüleyici sayfa
          mevcut değil) — bu yüzden zaten var olan genel /reports/:reportId
          ucu (rep-715-mahsup) doğrudan burada, küçük bir özet olarak. */}
      <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6" data-testid="settlement-summary-section">
        <span className="text-[10px] font-mono text-[#ffdca1] font-bold uppercase tracking-widest">HIZLI ERİŞİM</span>
        <h3 className="text-base font-extrabold text-[#e5e2e1] uppercase mt-0.5 mb-4">Şantiye Mahsuplaşma Özeti (REP-715)</h3>
        {crossSiteSettlementSummary.length === 0 ? (
          <p className="text-xs text-[#d5c4ab]/60">Bu ay henüz çapraz şantiye hareketi yok.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-[#353535] text-[#d5c4ab] uppercase text-[10px] tracking-wider font-mono">
                  <th className="py-2.5 px-4">Şantiye Çifti</th>
                  <th className="py-2.5 px-4">Ay</th>
                  <th className="py-2.5 px-4">Hareket</th>
                  <th className="py-2.5 px-4">Net Tutar</th>
                  <th className="py-2.5 px-4">Borçlu → Alacaklı</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#353535] font-mono">
                {crossSiteSettlementSummary.map((r) => (
                  <tr key={r.id} data-testid="settlement-summary-row" className="hover:bg-[#282726] transition-colors">
                    <td className="py-2.5 px-4 text-[#e5e2e1]">{r.siteA} ↔ {r.siteB}</td>
                    <td className="py-2.5 px-4 text-[#d5c4ab]">{r.monthLabel}</td>
                    <td className="py-2.5 px-4 text-[#d5c4ab]">{r.movementCount}</td>
                    <td className="py-2.5 px-4 text-[#e5e2e1] font-bold">{r.netAmount.toFixed(2)} TL</td>
                    <td className="py-2.5 px-4 text-[#d5c4ab]">
                      {r.debtor && r.creditor ? <>{r.debtor} <span className="text-[#ffdca1]">→</span> {r.creditor}</> : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* KOTA MODAL */}
      {isQuotaModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 max-w-md w-full space-y-6" data-testid="quota-create-modal">
            <div className="flex items-center justify-between border-b border-[#353535] pb-4">
              <h3 className="text-base font-extrabold text-[#e5e2e1] uppercase tracking-wider flex items-center space-x-2">
                <span className="material-symbols-outlined text-[#ffdca1]">rule</span>
                <span>Yakıt Kotası Tanımla</span>
              </h3>
              <button onClick={() => setIsQuotaModalOpen(false)} className="text-[#d5c4ab] hover:text-[#e5e2e1]">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <form onSubmit={handleCreateQuota} className="space-y-4">
              <div>
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Kapsam</label>
                <div className="flex space-x-2">
                  {([['VEHICLE', 'Araç'], ['SITE', 'Şantiye'], ['ALL', 'Tüm Filo']] as const).map(([val, label]) => (
                    <button
                      key={val}
                      type="button"
                      data-testid={`quota-scope-${val.toLowerCase()}`}
                      onClick={() => setQuotaScope(val)}
                      className={`flex-1 px-3 py-2 rounded-md text-xs font-bold cursor-pointer transition-colors ${
                        quotaScope === val ? 'bg-[#ffdca1] text-[#412d00]' : 'bg-[#131313] text-[#d5c4ab] border border-[#353535]'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {quotaScope === 'VEHICLE' && (
                <div>
                  <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Araç Plakası</label>
                  <select
                    data-testid="quota-vehicle-select"
                    value={quotaVehiclePlate}
                    onChange={(e) => setQuotaVehiclePlate(e.target.value)}
                    className="w-full bg-[#131313] border border-[#353535] text-[#e5e2e1] text-xs rounded-xl p-3 focus:outline-none focus:border-[#ffdca1]"
                  >
                    {vehicles.map(v => (
                      <option key={v.id} value={v.plate}>{v.plate} ({v.siteName})</option>
                    ))}
                  </select>
                </div>
              )}

              {quotaScope === 'SITE' && (
                <div>
                  <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Şantiye</label>
                  <select
                    data-testid="quota-site-select"
                    value={quotaSiteName}
                    onChange={(e) => setQuotaSiteName(e.target.value)}
                    className="w-full bg-[#131313] border border-[#353535] text-[#e5e2e1] text-xs rounded-xl p-3 focus:outline-none focus:border-[#ffdca1]"
                  >
                    {currentCompany.sites.map(s => (
                      <option key={s.id} value={s.name}>{s.name}</option>
                    ))}
                  </select>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Dönem</label>
                  <select
                    data-testid="quota-period-select"
                    value={quotaPeriodType}
                    onChange={(e) => setQuotaPeriodType(e.target.value as FuelQuota['periodType'])}
                    className="w-full bg-[#131313] border border-[#353535] text-[#e5e2e1] text-xs rounded-xl p-3 focus:outline-none focus:border-[#ffdca1]"
                  >
                    {Object.entries(PERIOD_LABELS).map(([val, label]) => (
                      <option key={val} value={val}>{label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Devir Politikası</label>
                  <select
                    data-testid="quota-carryover-select"
                    value={quotaCarryoverPolicy}
                    onChange={(e) => setQuotaCarryoverPolicy(e.target.value as FuelQuota['carryoverPolicy'])}
                    className="w-full bg-[#131313] border border-[#353535] text-[#e5e2e1] text-xs rounded-xl p-3 focus:outline-none focus:border-[#ffdca1]"
                  >
                    {Object.entries(CARRYOVER_LABELS).map(([val, label]) => (
                      <option key={val} value={val}>{label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Limit (Litre)</label>
                <input
                  type="number"
                  data-testid="quota-limit-input"
                  value={quotaLimitLiters}
                  onChange={(e) => setQuotaLimitLiters(Number(e.target.value))}
                  min={1}
                  max={10_000_000}
                  className="w-full bg-[#131313] border border-[#353535] text-[#e5e2e1] font-mono text-xs rounded-xl p-3 focus:outline-none focus:border-[#ffdca1]"
                  required
                />
              </div>

              <div>
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Geçerlilik Sonu (opsiyonel)</label>
                <input
                  type="date"
                  data-testid="quota-valid-until-input"
                  value={quotaValidUntil}
                  onChange={(e) => setQuotaValidUntil(e.target.value)}
                  className="w-full bg-[#131313] border border-[#353535] text-[#e5e2e1] font-mono text-xs rounded-xl p-3 focus:outline-none focus:border-[#ffdca1]"
                />
              </div>

              <div className="pt-4 border-t border-[#353535] flex items-center justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setIsQuotaModalOpen(false)}
                  className="px-4 py-2.5 bg-[#20201f] text-[#d5c4ab] rounded-xl text-xs font-bold"
                >
                  İptal
                </button>
                <button
                  type="submit"
                  data-testid="quota-save"
                  disabled={isSavingQuota}
                  className="px-5 py-2.5 bg-[#ffdca1] text-[#412d00] rounded-xl text-xs font-black disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isSavingQuota ? 'Kaydediliyor...' : 'Kotayı Tanımla'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 max-w-md w-full space-y-6">
            <div className="flex items-center justify-between border-b border-[#353535] pb-4">
              <h3 className="text-base font-extrabold text-[#e5e2e1] uppercase tracking-wider flex items-center space-x-2">
                <span className="material-symbols-outlined text-[#ffdca1]">add_moderator</span>
                <span>Çapraz Şantiye Yetkisi Ver</span>
              </h3>
              <button onClick={() => setIsModalOpen(false)} className="text-[#d5c4ab] hover:text-[#e5e2e1]">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <form onSubmit={handleCreatePermission} className="space-y-4">
              <div>
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Araç Plakası</label>
                <select
                  data-testid="crosssite-plate-select"
                  value={selectedPlate}
                  onChange={(e) => setSelectedPlate(e.target.value)}
                  className="w-full bg-[#131313] border border-[#353535] text-[#e5e2e1] text-xs rounded-xl p-3 focus:outline-none focus:border-[#ffdca1]"
                >
                  {vehicles.map(v => (
                    <option key={v.id} value={v.plate}>{v.plate} ({v.siteName})</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">İkmal Yapacağı Şantiye</label>
                <select
                  data-testid="crosssite-target-select"
                  value={targetSite}
                  onChange={(e) => setTargetSite(e.target.value)}
                  className="w-full bg-[#131313] border border-[#353535] text-[#e5e2e1] text-xs rounded-xl p-3 focus:outline-none focus:border-[#ffdca1]"
                >
                  {currentCompany.sites.map(s => (
                    <option key={s.id} value={s.name}>{s.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs font-mono text-[#d5c4ab] block mb-1">İzin Verilen Miktar (Litre)</label>
                <input
                  type="number"
                  data-testid="crosssite-liters-input"
                  value={allowedLiters}
                  onChange={(e) => setAllowedLiters(Number(e.target.value))}
                  min={50}
                  max={2000}
                  className="w-full bg-[#131313] border border-[#353535] text-[#e5e2e1] font-mono text-xs rounded-xl p-3 focus:outline-none focus:border-[#ffdca1]"
                  required
                />
              </div>

              <div className="pt-4 border-t border-[#353535] flex items-center justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2.5 bg-[#20201f] text-[#d5c4ab] rounded-xl text-xs font-bold"
                >
                  İptal
                </button>
                <button
                  type="submit"
                  data-testid="crosssite-save"
                  className="px-5 py-2.5 bg-[#ffdca1] text-[#412d00] rounded-xl text-xs font-black"
                >
                  Yetkiyi Oluştur
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
};
