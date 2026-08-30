import React from 'react';
import { useApp } from '../../context/AppContext';

export const DevicesPage: React.FC = () => {
  const { hardwareDevices, addHardwareLog, showToast } = useApp();

  const handlePingDevice = (deviceCode: string) => {
    addHardwareLog({
      deviceCode: deviceCode,
      tag: 'MQTT',
      message: `[PING_REQ] Topic: /devices/${deviceCode}/ping -> ACK 14ms (RSSI: -64dBm)`
    });
    showToast(`Test sinyali gönderildi: ${deviceCode}`);
  };

  return (
    <div className="space-y-6">
      
      {/* Header */}
      <div className="bg-[#1c1b1b] border border-[#353535] p-6 rounded-2xl flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <span className="text-[10px] font-mono text-[#ffb77f] font-bold uppercase tracking-widest">
            SAHA IOT DONANIMLARI
          </span>
          <h2 className="text-xl font-extrabold text-[#e5e2e1] uppercase mt-0.5">
            ESP32 & Debimetre Cihaz Yönetimi
          </h2>
          <p className="text-xs text-[#d5c4ab] mt-1">
            MQTT SSL Protokolü ile bağlı saha akışmetreleri, RFID okuyucular ve ultrasonik seviye sensörleri
          </p>
        </div>

        <div className="flex items-center space-x-2 text-xs font-mono font-bold text-[#a1e8a2] bg-[#20201f] border border-[#353535] px-3.5 py-2 rounded-xl">
          <span className="w-2 h-2 rounded-full bg-[#a1e8a2] animate-pulse"></span>
          <span>MQTT Broker Port: 1883 ONLINE</span>
        </div>
      </div>

      {/* Devices Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {hardwareDevices.map(dev => (
          <div key={dev.id} className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 space-y-4 flex flex-col justify-between">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono text-[#ffb77f] font-bold uppercase">
                  {dev.deviceCode}
                </span>
                <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded ${
                  dev.status === 'ONLINE' ? 'bg-[#a1e8a2]/10 text-[#a1e8a2]' : 'bg-[#ffb4ab]/10 text-[#ffb4ab]'
                }`}>
                  {dev.status}
                </span>
              </div>

              <div>
                <h3 className="text-base font-extrabold text-[#e5e2e1]">{dev.name}</h3>
                <p className="text-xs text-[#d5c4ab]">{dev.companyName} — ({dev.siteName})</p>
              </div>

              <div className="bg-[#20201f] border border-[#353535] p-3 rounded-xl font-mono text-xs space-y-1">
                <div className="flex justify-between">
                  <span className="text-[#d5c4ab]">IP Adresi:</span>
                  <span className="text-[#e5e2e1] font-bold">{dev.ipAddress}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#d5c4ab]">Sinyal (RSSI):</span>
                  <span className="text-[#a1e8a2] font-bold">{dev.signalRssi} dBm</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#d5c4ab]">Firmware:</span>
                  <span className="text-[#ffdca1] font-bold">v{dev.firmwareVersion}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#d5c4ab]">Son Sinyal:</span>
                  <span className="text-[#d5c4ab]">{dev.lastPing}</span>
                </div>
              </div>
            </div>

            <button
              onClick={() => handlePingDevice(dev.deviceCode)}
              className="w-full bg-[#20201f] hover:bg-[#282726] border border-[#353535] text-[#ffb77f] py-2.5 rounded-xl text-xs font-bold font-mono transition-colors cursor-pointer flex items-center justify-center space-x-2"
            >
              <span className="material-symbols-outlined text-sm">sensors</span>
              <span>Test Sinyali Gönder (Ping)</span>
            </button>
          </div>
        ))}
      </div>

    </div>
  );
};
