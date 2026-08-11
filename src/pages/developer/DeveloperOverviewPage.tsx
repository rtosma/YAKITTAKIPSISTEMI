import React, { useState, useEffect, useRef } from 'react';
import { useApp } from '../../context/AppContext';
import { Company } from '../../types';

export const DeveloperOverviewPage: React.FC = () => {
  const { 
    companies, 
    hardwareDevices, 
    hardwareLogs, 
    simulatedLatencyMs, 
    isLogStreamActive, 
    setIsLogStreamActive, 
    addHardwareLog, 
    clearHardwareLogs,
    toggleCompanyModule,
    setSelectedTenantForDetail,
    selectedTenantForDetail
  } = useApp();

  const [selectedCompanyId, setSelectedCompanyId] = useState<string>(companies[0]?.id || 'comp-camsa');
  const [terminalInput, setTerminalInput] = useState<string>('');
  const terminalEndRef = useRef<HTMLDivElement>(null);

  const activeCompany = companies.find(c => c.id === selectedCompanyId) || companies[0];

  useEffect(() => {
    if (terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [hardwareLogs]);

  const handleTerminalSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!terminalInput.trim()) return;

    const cmd = terminalInput.trim();
    addHardwareLog({
      deviceCode: 'ESP32_CLI',
      tag: 'MQTT',
      message: `> CLI EXECUTE: ${cmd}`
    });

    if (cmd === 'ping') {
      addHardwareLog({ deviceCode: 'ESP32_PUMP_01', tag: 'PUMP', message: `PING ACK: ESP32_PUMP_01 ping=12ms RSSI=-65dBm` });
    } else if (cmd === 'status') {
      addHardwareLog({ deviceCode: 'ESP32_GATEWAY_01', tag: 'SENSOR', message: 'BROKER ONLINE: 5 devices connected, 0 errors' });
    } else if (cmd === 'clear') {
      clearHardwareLogs();
    } else {
      addHardwareLog({ deviceCode: 'ESP32_TANK_01', tag: 'SENSOR', message: `Command '${cmd}' ACK received from hardware controller.` });
    }

    setTerminalInput('');
  };

  return (
    <div className="space-y-8">
      
      {/* 3 SYSTEM HEALTH METRICS */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        
        {/* Metric 1: Aktif Firma Sayısı */}
        <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-[#d5c4ab] uppercase tracking-wider">Aktif Firma (Tenant)</span>
            <span className="material-symbols-outlined text-xl text-[#ffdca1]">domain</span>
          </div>
          <div className="text-3xl font-extrabold font-mono text-[#e5e2e1]">
            {companies.length} Firma
          </div>
          <p className="text-[11px] text-[#d5c4ab]">Multi-tenant B2B SaaS platformunda aktif</p>
        </div>

        {/* Metric 2: Yayındaki Cihaz Sayısı */}
        <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-[#d5c4ab] uppercase tracking-wider">Yayındaki Cihaz Sayısı</span>
            <span className="material-symbols-outlined text-xl text-[#ffb77f]">developer_board</span>
          </div>
          <div className="text-3xl font-extrabold font-mono text-[#e5e2e1]">
            {hardwareDevices.length} ESP32 IoT
          </div>
          <p className="text-[11px] text-[#d5c4ab]">Debimetre, RFID & Ultrasonik Modüller</p>
        </div>

        {/* Metric 3: Anlık Ağ Gecikmesi */}
        <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-[#d5c4ab] uppercase tracking-wider">Anlık Ağ Gecikmesi</span>
            <span className="material-symbols-outlined text-xl text-[#a1e8a2]">speed</span>
          </div>
          <div className="text-3xl font-extrabold font-mono text-[#a1e8a2]">
            {simulatedLatencyMs} ms
          </div>
          <p className="text-[11px] text-[#d5c4ab]">MQTT SSL Telemetri yanıt süresi mükemmel</p>
        </div>

      </div>

      {/* IoT CANLI LOG TERMİNALİ */}
      <div className="bg-[#0e0e0e] border border-[#353535] rounded-2xl p-6 font-mono text-xs space-y-4 shadow-2xl">
        
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pb-3 border-b border-[#353535]">
          <div className="flex items-center space-x-2">
            <span className="w-3 h-3 rounded-full bg-[#ff5f56]"></span>
            <span className="w-3 h-3 rounded-full bg-[#ffbd2e]"></span>
            <span className="w-3 h-3 rounded-full bg-[#27c93f]"></span>
            <span className="font-bold text-xs text-[#a1e8a2] uppercase tracking-wider ml-2">
              IoT Canlı Telemetri Log Terminali (ESP32 C++ Stream)
            </span>
          </div>

          <div className="flex items-center space-x-3 text-[11px]">
            <button
              onClick={() => setIsLogStreamActive(!isLogStreamActive)}
              className={`px-3 py-1 rounded font-bold cursor-pointer transition-colors ${
                isLogStreamActive ? 'bg-[#a1e8a2]/20 text-[#a1e8a2] border border-[#a1e8a2]/40' : 'bg-[#20201f] text-[#d5c4ab]'
              }`}
            >
              {isLogStreamActive ? 'AKISI DURDUR' : 'AKISI BAŞLAT'}
            </button>
            <button
              onClick={clearHardwareLogs}
              className="px-3 py-1 bg-[#20201f] hover:bg-[#282726] text-[#d5c4ab] rounded border border-[#353535] cursor-pointer"
            >
              Temizle
            </button>
          </div>
        </div>

        {/* Log Box Stream */}
        <div className="h-60 overflow-y-auto space-y-1.5 custom-scrollbar pr-2 text-[11px] leading-relaxed">
          {hardwareLogs.length === 0 ? (
            <p className="text-[#d5c4ab]/50 italic">Log akışı bekleniyor...</p>
          ) : (
            hardwareLogs.map((log) => (
              <div key={log.id} className="flex items-start space-x-2 font-mono hover:bg-[#1a1a1a] py-0.5 px-1 rounded">
                <span className="text-[#d5c4ab]/60">[{log.timestamp}]</span>
                <span className="text-[#ffb77f] font-bold">[{log.tag}]</span>
                <span className="text-[#a1e8a2]">{log.message}</span>
              </div>
            ))
          )}
          <div ref={terminalEndRef} />
        </div>

        {/* Interactive CLI Input */}
        <form onSubmit={handleTerminalSubmit} className="pt-3 border-t border-[#353535] flex items-center space-x-2">
          <span className="text-[#a1e8a2] font-bold">$</span>
          <input
            type="text"
            value={terminalInput}
            onChange={(e) => setTerminalInput(e.target.value)}
            placeholder="ESP32 CLI komutu girin (ping, status, clear)..."
            className="flex-1 bg-transparent border-none text-[#a1e8a2] font-mono text-xs focus:outline-none placeholder-[#d5c4ab]/40"
          />
          <button
            type="submit"
            className="px-4 py-1.5 bg-[#a1e8a2]/20 text-[#a1e8a2] border border-[#a1e8a2]/40 rounded font-bold hover:bg-[#a1e8a2]/30 cursor-pointer"
          >
            ÇALIŞTIR
          </button>
        </form>

      </div>

      {/* TÜM FİRMALAR TABLE & MODÜL YÖNETİMİ TOGGLES */}
      <div className="space-y-6">
        
        {/* Company Selection Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {companies.map(c => {
            const isSelected = c.id === selectedCompanyId;
            return (
              <div
                key={c.id}
                onClick={() => setSelectedCompanyId(c.id)}
                className={`p-5 rounded-2xl border transition-all cursor-pointer ${
                  isSelected
                    ? 'bg-[#20201f] border-[#ffb77f] shadow-lg'
                    : 'bg-[#1c1b1b] border-[#353535] hover:border-[#ffb77f]/50'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono text-[11px] text-[#ffb77f] font-bold">{c.code}</span>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-[#a1e8a2]/10 text-[#a1e8a2]">
                    {c.licenseStatus}
                  </span>
                </div>
                <h3 className="font-extrabold text-sm text-[#e5e2e1] truncate">{c.name}</h3>
                <p className="text-xs text-[#d5c4ab] mt-1">{c.sites.length} Şantiye / {c.activeVehiclesCount} Araç</p>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedTenantForDetail(c);
                  }}
                  className="mt-3 text-[11px] font-bold text-[#ffb77f] hover:underline flex items-center space-x-1"
                >
                  <span>Firma Detayını Aç</span>
                  <span className="material-symbols-outlined text-sm">open_in_new</span>
                </button>
              </div>
            );
          })}
        </div>

        {/* MODÜL YÖNETİMİ TOGGLE LIST FOR SELECTED COMPANY */}
        <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 space-y-6">
          <div className="pb-4 border-b border-[#353535] flex items-center justify-between">
            <div>
              <span className="text-[10px] font-mono text-[#ffb77f] font-bold uppercase tracking-widest">
                SEÇİLİ FİRMA MODÜL YÖNETİMİ
              </span>
              <h2 className="text-lg font-black text-[#e5e2e1] uppercase mt-1">
                {activeCompany.name} ({activeCompany.code})
              </h2>
              <p className="text-xs text-[#d5c4ab] mt-0.5">
                Firmaya tanımlı B2B SaaS yetkilerini anlık olarak açıp kapatın
              </p>
            </div>
            <span className="text-xs font-mono font-bold text-[#a1e8a2] bg-[#20201f] border border-[#353535] px-3 py-1.5 rounded-xl">
              Lisans: {activeCompany.licenseExpiry}
            </span>
          </div>

          {/* Module Toggle Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            
            {/* Toggle: e-İrsaliye */}
            <div className="bg-[#20201f] border border-[#353535] p-4 rounded-xl flex items-center justify-between">
              <div>
                <h4 className="font-bold text-xs text-[#e5e2e1]">e-İrsaliye Entegrasyonu</h4>
                <p className="text-[11px] text-[#d5c4ab]">GİB UBL-TR e-İrsaliye otomatik bildirimi</p>
              </div>
              <button
                onClick={() => toggleCompanyModule(activeCompany.id, 'eInvoice')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold font-mono transition-all cursor-pointer ${
                  activeCompany.modules.eInvoice
                    ? 'bg-[#a1e8a2] text-[#412d00]'
                    : 'bg-[#131313] text-[#d5c4ab] border border-[#353535]'
                }`}
              >
                {activeCompany.modules.eInvoice ? 'AÇIK' : 'KAPALI'}
              </button>
            </div>

            {/* Toggle: AI Anomali Motoru */}
            <div className="bg-[#20201f] border border-[#353535] p-4 rounded-xl flex items-center justify-between">
              <div>
                <h4 className="font-bold text-xs text-[#e5e2e1]">AI Hırsızlık & Anomali Motoru</h4>
                <p className="text-[11px] text-[#d5c4ab]">Debimetre vs tank farkı kaçak tespiti</p>
              </div>
              <button
                onClick={() => toggleCompanyModule(activeCompany.id, 'aiAnomaly')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold font-mono transition-all cursor-pointer ${
                  activeCompany.modules.aiAnomaly
                    ? 'bg-[#a1e8a2] text-[#412d00]'
                    : 'bg-[#131313] text-[#d5c4ab] border border-[#353535]'
                }`}
              >
                {activeCompany.modules.aiAnomaly ? 'AÇIK' : 'KAPALI'}
              </button>
            </div>

            {/* Toggle: Akıllı Ambar */}
            <div className="bg-[#20201f] border border-[#353535] p-4 rounded-xl flex items-center justify-between">
              <div>
                <h4 className="font-bold text-xs text-[#e5e2e1]">Akıllı Ambar & Depo</h4>
                <p className="text-[11px] text-[#d5c4ab]">Maden & şantiye ana stok yönetimi</p>
              </div>
              <button
                onClick={() => toggleCompanyModule(activeCompany.id, 'smartWarehouse')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold font-mono transition-all cursor-pointer ${
                  activeCompany.modules.smartWarehouse
                    ? 'bg-[#a1e8a2] text-[#412d00]'
                    : 'bg-[#131313] text-[#d5c4ab] border border-[#353535]'
                }`}
              >
                {activeCompany.modules.smartWarehouse ? 'AÇIK' : 'KAPALI'}
              </button>
            </div>

            {/* Toggle: Çapraz Şantiye */}
            <div className="bg-[#20201f] border border-[#353535] p-4 rounded-xl flex items-center justify-between">
              <div>
                <h4 className="font-bold text-xs text-[#e5e2e1]">Çapraz Şantiye İkmal Yetkisi</h4>
                <p className="text-[11px] text-[#d5c4ab]">Farklı firma şantiyelerinden ikmal alma</p>
              </div>
              <button
                onClick={() => toggleCompanyModule(activeCompany.id, 'crossSiteAuth')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold font-mono transition-all cursor-pointer ${
                  activeCompany.modules.crossSiteAuth
                    ? 'bg-[#a1e8a2] text-[#412d00]'
                    : 'bg-[#131313] text-[#d5c4ab] border border-[#353535]'
                }`}
              >
                {activeCompany.modules.crossSiteAuth ? 'AÇIK' : 'KAPALI'}
              </button>
            </div>

          </div>
        </div>

      </div>

      {/* SLIDE-OVER DRAWER FOR TENANT DETAIL */}
      {selectedTenantForDetail && (
        <div className="fixed inset-0 z-50 bg-black/80 flex justify-end">
          <div className="bg-[#1c1b1b] border-l border-[#353535] w-full max-w-lg p-6 space-y-6 overflow-y-auto">
            <div className="flex items-center justify-between border-b border-[#353535] pb-4">
              <div>
                <span className="text-[10px] font-mono text-[#ffb77f] font-bold uppercase">{selectedTenantForDetail.code}</span>
                <h3 className="text-lg font-black text-[#e5e2e1] uppercase">{selectedTenantForDetail.name}</h3>
              </div>
              <button
                onClick={() => setSelectedTenantForDetail(null)}
                className="p-2 text-[#d5c4ab] hover:text-[#e5e2e1]"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="space-y-4 font-mono text-xs">
              <div className="bg-[#20201f] p-4 rounded-xl space-y-2 border border-[#353535]">
                <div className="flex justify-between">
                  <span className="text-[#d5c4ab]">Vergi Numarası:</span>
                  <span className="text-[#e5e2e1] font-bold">{selectedTenantForDetail.taxNumber}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#d5c4ab]">Şehir:</span>
                  <span className="text-[#e5e2e1] font-bold">{selectedTenantForDetail.city}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#d5c4ab]">Lisans Durumu:</span>
                  <span className="text-[#a1e8a2] font-bold">{selectedTenantForDetail.licenseStatus}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#d5c4ab]">Aylık Tüketim:</span>
                  <span className="text-[#ffdca1] font-bold">{selectedTenantForDetail.totalFuelThisMonth.toLocaleString('tr-TR')} Litre</span>
                </div>
              </div>

              <div>
                <h4 className="font-extrabold text-[#e5e2e1] uppercase mb-2">Şantiyeler ({selectedTenantForDetail.sites.length})</h4>
                <div className="space-y-2">
                  {selectedTenantForDetail.sites.map(s => (
                    <div key={s.id} className="bg-[#20201f] border border-[#353535] p-3 rounded-xl flex items-center justify-between">
                      <div>
                        <p className="font-bold text-[#e5e2e1]">{s.name}</p>
                        <p className="text-[10px] text-[#d5c4ab]">{s.location}</p>
                      </div>
                      <span className="text-[10px] bg-[#353535] text-[#d5c4ab] px-2 py-0.5 rounded">
                        {s.activeVehiclesCount} Araç / {s.activeTanksCount} Tank
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
