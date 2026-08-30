import React from 'react';
import { useApp } from '../../context/AppContext';

export const SystemHealthPage: React.FC = () => {
  const { simulatedLatencyMs } = useApp();

  return (
    <div className="space-y-6">
      
      {/* Header */}
      <div className="bg-[#1c1b1b] border border-[#353535] p-6 rounded-2xl flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <span className="text-[10px] font-mono text-[#ffb77f] font-bold uppercase tracking-widest">
            MONİTÖR & SUNUCU METRİKLERİ
          </span>
          <h2 className="text-xl font-extrabold text-[#e5e2e1] uppercase mt-0.5">
            Sistem Sağlığı & Sunucu Durumu
          </h2>
          <p className="text-xs text-[#d5c4ab] mt-1">
            MQTT Broker, PostgreSQL veritabanı, SSL sertifikaları ve REST API sağlık göstergeleri
          </p>
        </div>

        <div className="text-xs font-mono font-bold text-[#a1e8a2] bg-[#20201f] border border-[#353535] px-4 py-2 rounded-xl">
          UPTIME: %99.98 (72 Gündür Kesintisiz)
        </div>
      </div>

      {/* Services Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 font-mono text-xs">
        
        <div className="bg-[#1c1b1b] border border-[#353535] p-6 rounded-2xl space-y-3">
          <div className="flex justify-between items-center">
            <span className="font-bold text-[#e5e2e1]">MQTT Broker Servisi</span>
            <span className="text-[10px] bg-[#a1e8a2]/10 text-[#a1e8a2] px-2 py-0.5 rounded font-bold">ONLINE</span>
          </div>
          <p className="text-[11px] text-[#d5c4ab]">EMQX Cloud Cluster (Port 1883 / SSL 8883)</p>
          <div className="pt-2 border-t border-[#353535] flex justify-between text-[#d5c4ab]">
            <span>Gecikme:</span>
            <span className="text-[#a1e8a2] font-bold">{simulatedLatencyMs} ms</span>
          </div>
        </div>

        <div className="bg-[#1c1b1b] border border-[#353535] p-6 rounded-2xl space-y-3">
          <div className="flex justify-between items-center">
            <span className="font-bold text-[#e5e2e1]">PostgreSQL DB Cluster</span>
            <span className="text-[10px] bg-[#a1e8a2]/10 text-[#a1e8a2] px-2 py-0.5 rounded font-bold">ONLINE</span>
          </div>
          <p className="text-[11px] text-[#d5c4ab]">Multi-tenant izolasyonlu veritabanı motoru</p>
          <div className="pt-2 border-t border-[#353535] flex justify-between text-[#d5c4ab]">
            <span>Aktif Bağlantı:</span>
            <span className="text-[#ffdca1] font-bold">24 / 100 Connection</span>
          </div>
        </div>

        <div className="bg-[#1c1b1b] border border-[#353535] p-6 rounded-2xl space-y-3">
          <div className="flex justify-between items-center">
            <span className="font-bold text-[#e5e2e1]">e-İrsaliye GİB Gateway</span>
            <span className="text-[10px] bg-[#a1e8a2]/10 text-[#a1e8a2] px-2 py-0.5 rounded font-bold">READY</span>
          </div>
          <p className="text-[11px] text-[#d5c4ab]">GİB Entegratör API Entegrasyonu</p>
          <div className="pt-2 border-t border-[#353535] flex justify-between text-[#d5c4ab]">
            <span>Kuyruktaki İrsaliye:</span>
            <span className="text-[#e5e2e1] font-bold">0 Bekleyen</span>
          </div>
        </div>

      </div>

    </div>
  );
};
