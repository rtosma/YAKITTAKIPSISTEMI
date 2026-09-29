import React, { useMemo, useRef, useState, useEffect } from 'react';
import { useApp } from '../../context/AppContext';

// FE-806 Kapsam: "seviye/tenant/cihaz filtreleri." "Tenant" filtresi
// BİLİNÇLİ OLARAK eklenmedi: SUPER_ADMIN'in soketi yalnızca KENDİ
// tenant'ının odasına (`tenant:{id}`) katılıyor (socketServer.ts) — çapraz
// tenant yayını yok, bu yüzden şu an akışta zaten TEK bir tenant'ın verisi
// var; işlevsiz bir filtre eklemek yanıltıcı olur. Bu, ayrı ve daha büyük
// bir altyapı işi (SUPER_ADMIN soketinin TÜM tenant odalarına katılması)
// olarak bildiriliyor.
const ALL = 'HEPSİ';

export const LiveLogsPage: React.FC = () => {
  const { hardwareLogs, isLogStreamActive, setIsLogStreamActive, clearHardwareLogs } = useApp();
  const terminalEndRef = useRef<HTMLDivElement>(null);
  const [levelFilter, setLevelFilter] = useState<string>(ALL);
  const [deviceFilter, setDeviceFilter] = useState<string>(ALL);

  const knownLevels = useMemo(() => Array.from(new Set(hardwareLogs.map((l) => l.tag))).sort(), [hardwareLogs]);
  const knownDevices = useMemo(() => Array.from(new Set(hardwareLogs.map((l) => l.deviceCode))).sort(), [hardwareLogs]);
  const filteredLogs = useMemo(
    () => hardwareLogs.filter((l) => (levelFilter === ALL || l.tag === levelFilter) && (deviceFilter === ALL || l.deviceCode === deviceFilter)),
    [hardwareLogs, levelFilter, deviceFilter]
  );

  useEffect(() => {
    if (terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [filteredLogs]);

  return (
    <div className="space-y-6">
      
      {/* Header */}
      <div className="bg-[#1c1b1b] border border-[#353535] p-6 rounded-2xl flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <span className="text-[10px] font-mono text-[#ffb77f] font-bold uppercase tracking-widest">
            SİSTEM TELEMETRİSİ
          </span>
          <h2 className="text-xl font-extrabold text-[#e5e2e1] uppercase mt-0.5">
            Tam Ekran Canlı IoT Log Akışı
          </h2>
          <p className="text-xs text-[#d5c4ab] mt-1">
            MQTT Broker, RFID Okuyucu ve Debimetre PUMP akış eventlerinin milisaniye detaylı log kaydı
          </p>
        </div>

        <div className="flex items-center space-x-3">
          <button
            onClick={() => setIsLogStreamActive(!isLogStreamActive)}
            className={`px-4 py-2.5 rounded-xl text-xs font-bold font-mono transition-all cursor-pointer ${
              isLogStreamActive ? 'bg-[#a1e8a2] text-[#412d00]' : 'bg-[#20201f] text-[#d5c4ab] border border-[#353535]'
            }`}
          >
            {isLogStreamActive ? 'AKISI DURDUR' : 'AKISI BAŞLAT'}
          </button>
          <button
            onClick={clearHardwareLogs}
            className="px-4 py-2.5 bg-[#20201f] hover:bg-[#282726] border border-[#353535] text-[#d5c4ab] rounded-xl text-xs font-bold font-mono cursor-pointer"
          >
            Terminali Temizle
          </button>
        </div>
      </div>

      {/* Filtreler — FE-806 Kapsam: "seviye/tenant/cihaz filtreleri" */}
      <div className="bg-[#1c1b1b] border border-[#353535] p-4 rounded-xl flex flex-wrap items-center gap-3 font-mono text-xs">
        <label className="flex items-center space-x-2 text-[#d5c4ab]">
          <span>Seviye:</span>
          <select
            data-testid="log-filter-level"
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value)}
            className="bg-[#131313] border border-[#353535] text-[#e5e2e1] rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-[#ffdca1]"
          >
            <option value={ALL}>{ALL}</option>
            {knownLevels.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <label className="flex items-center space-x-2 text-[#d5c4ab]">
          <span>Cihaz:</span>
          <select
            data-testid="log-filter-device"
            value={deviceFilter}
            onChange={(e) => setDeviceFilter(e.target.value)}
            className="bg-[#131313] border border-[#353535] text-[#e5e2e1] rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-[#ffdca1]"
          >
            <option value={ALL}>{ALL}</option>
            {knownDevices.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
      </div>

      {/* Terminal Container */}
      <div className="bg-[#0e0e0e] border border-[#353535] rounded-2xl p-6 font-mono text-xs space-y-3 min-h-[500px] shadow-2xl">
        <div className="pb-3 border-b border-[#353535] text-[#a1e8a2] font-bold flex justify-between">
          <span>ROOT@AKILLI-SANTIYE-MQTT-BROKER:~$ tail -f /var/log/iot-telemetry.log</span>
          <span data-testid="log-count">LOG SAYISI: {filteredLogs.length} / {hardwareLogs.length} (tampon sınırı: 500)</span>
        </div>

        <div className="space-y-2 leading-relaxed" data-testid="log-terminal-lines">
          {filteredLogs.map(log => (
            <div key={log.id} data-testid="log-line" className="flex items-start space-x-3 hover:bg-[#1a1a1a] p-1 rounded font-mono">
              <span className="text-[#d5c4ab]/60">[{log.timestamp}]</span>
              <span className="text-[#ffb77f] font-bold">[{log.deviceCode}]</span>
              <span className="text-[#ffdca1]">[{log.tag}]</span>
              <span className="text-[#a1e8a2] flex-1">{log.message}</span>
            </div>
          ))}
          <div ref={terminalEndRef} />
        </div>
      </div>

    </div>
  );
};
