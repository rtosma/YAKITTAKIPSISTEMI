import React from 'react';
import { useApp } from '../../context/AppContext';

// FE-806 Kapsam: "Sistem metrikleri: kuyruk derinlikleri, MQTT mesaj hızı,
// DLQ sayısı, API hata oranı." Bu sayfa ÖNCEDEN tamamen SABİT/uydurma
// değerler gösteriyordu ("UPTIME %99.98", "24/100 Connection", "0 Bekleyen"
// — hiçbiri gerçek bir API çağrısına dayanmıyordu). Artık OPS-1107'nin
// ZATEN var olan Prometheus registry'sinden (GET /admin/system-metrics)
// gerçek sayılar gösteriliyor. "DLQ sayısı" harfiyen karşılığı YOK (bu
// projede klasik bir mesaj kuyruğu/DLQ altyapısı değil, e-İrsaliye
// iletim kuyruğu + bildirim yeniden deneme kuyruğu var) — en yakın
// GERÇEK eşdeğerleri (despatchQueue.FAILED, notifications.retryQueue)
// kullanıldı, uydurma bir "DLQ" sayısı ÜRETİLMEDİ.
export const SystemHealthPage: React.FC = () => {
  const { systemMetrics, fetchSystemMetrics } = useApp();

  if (!systemMetrics) {
    return (
      <div className="bg-[#1c1b1b] border border-[#353535] p-6 rounded-2xl text-xs font-mono text-[#d5c4ab]">
        Sistem metrikleri yükleniyor...
      </div>
    );
  }

  const m = systemMetrics;

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
            OPS-1107 Prometheus registry'sinden gerçek zamanlı özet (istek üzerine)
          </p>
        </div>

        <button
          data-testid="system-metrics-refresh"
          onClick={fetchSystemMetrics}
          className="text-xs font-mono font-bold text-[#ffb77f] bg-[#20201f] border border-[#353535] hover:bg-[#282726] px-4 py-2 rounded-xl flex items-center space-x-2 cursor-pointer"
        >
          <span className="material-symbols-outlined text-base">refresh</span>
          <span>Yenile</span>
        </button>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 font-mono text-xs">

        <div className="bg-[#1c1b1b] border border-[#353535] p-6 rounded-2xl space-y-3">
          <div className="flex justify-between items-center">
            <span className="font-bold text-[#e5e2e1]">MQTT Mesaj Hızı</span>
            <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${m.mqtt.errorsTotal > 0 ? 'bg-[#ffb4ab]/10 text-[#ffb4ab]' : 'bg-[#a1e8a2]/10 text-[#a1e8a2]'}`}>
              {m.mqtt.errorsTotal > 0 ? 'HATA VAR' : 'SAĞLIKLI'}
            </span>
          </div>
          <p className="text-[11px] text-[#d5c4ab]">Süreç başlangıcından bu yana toplam sayaç</p>
          <div className="pt-2 border-t border-[#353535] space-y-1 text-[#d5c4ab]">
            <div className="flex justify-between"><span>Mesaj (toplam):</span><span className="text-[#a1e8a2] font-bold" data-testid="metric-mqtt-messages">{m.mqtt.messagesTotal}</span></div>
            <div className="flex justify-between"><span>Reddedilen:</span><span className="text-[#ffdca1] font-bold">{m.mqtt.rejectedTotal}</span></div>
            <div className="flex justify-between"><span>İşleme hatası:</span><span className="text-[#ffb4ab] font-bold">{m.mqtt.errorsTotal}</span></div>
          </div>
        </div>

        <div className="bg-[#1c1b1b] border border-[#353535] p-6 rounded-2xl space-y-3">
          <div className="flex justify-between items-center">
            <span className="font-bold text-[#e5e2e1]">Veritabanı Bağlantı Havuzu</span>
            <span className="text-[10px] bg-[#a1e8a2]/10 text-[#a1e8a2] px-2 py-0.5 rounded font-bold">CANLI</span>
          </div>
          <p className="text-[11px] text-[#d5c4ab]">pg havuzu — anlık (scrape anında okunur)</p>
          <div className="pt-2 border-t border-[#353535] space-y-1 text-[#d5c4ab]">
            <div className="flex justify-between"><span>Toplam:</span><span className="text-[#e5e2e1] font-bold">{m.dbPool.total ?? 0}</span></div>
            <div className="flex justify-between"><span>Boşta:</span><span className="text-[#a1e8a2] font-bold">{m.dbPool.idle ?? 0}</span></div>
            <div className="flex justify-between"><span>Bekleyen istek:</span><span className={`font-bold ${(m.dbPool.waiting ?? 0) > 0 ? 'text-[#ffb4ab]' : 'text-[#d5c4ab]'}`}>{m.dbPool.waiting ?? 0}</span></div>
          </div>
        </div>

        <div className="bg-[#1c1b1b] border border-[#353535] p-6 rounded-2xl space-y-3">
          <div className="flex justify-between items-center">
            <span className="font-bold text-[#e5e2e1]">e-İrsaliye İletim Kuyruğu</span>
            <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${m.despatchIntegratorCircuitOpen ? 'bg-[#ffb4ab]/10 text-[#ffb4ab]' : 'bg-[#a1e8a2]/10 text-[#a1e8a2]'}`}>
              {m.despatchIntegratorCircuitOpen ? 'DEVRE AÇIK' : 'HAZIR'}
            </span>
          </div>
          <p className="text-[11px] text-[#d5c4ab]">GİB Entegratör devre kesici (COMP-602.2)</p>
          <div className="pt-2 border-t border-[#353535] space-y-1 text-[#d5c4ab]">
            <div className="flex justify-between"><span>Bekleyen (QUEUED):</span><span className="text-[#ffdca1] font-bold">{m.despatchQueue.QUEUED ?? 0}</span></div>
            <div className="flex justify-between"><span>Başarısız (FAILED):</span><span className="text-[#ffb4ab] font-bold" data-testid="metric-despatch-failed">{m.despatchQueue.FAILED ?? 0}</span></div>
            <div className="flex justify-between"><span>En eski (sn):</span><span className="text-[#d5c4ab] font-bold">{m.despatchQueue.oldestQueuedAgeSeconds}</span></div>
          </div>
        </div>

        <div className="bg-[#1c1b1b] border border-[#353535] p-6 rounded-2xl space-y-3">
          <div className="flex justify-between items-center">
            <span className="font-bold text-[#e5e2e1]">Cihaz Envanteri</span>
          </div>
          <p className="text-[11px] text-[#d5c4ab]">Kayıtlı cihazların anlık durum dağılımı</p>
          <div className="pt-2 border-t border-[#353535] space-y-1 text-[#d5c4ab]">
            <div className="flex justify-between"><span>Kayıtlı:</span><span className="text-[#e5e2e1] font-bold">{m.devices.registered ?? 0}</span></div>
            <div className="flex justify-between"><span>Aktif (son 10 dk):</span><span className="text-[#a1e8a2] font-bold">{m.devices.active ?? 0}</span></div>
            <div className="flex justify-between"><span>Çevrimdışı:</span><span className="text-[#ffdca1] font-bold">{m.devices.offline ?? 0}</span></div>
            <div className="flex justify-between"><span>Bloke:</span><span className="text-[#ffb4ab] font-bold">{m.devices.blocked ?? 0}</span></div>
          </div>
        </div>

        <div className="bg-[#1c1b1b] border border-[#353535] p-6 rounded-2xl space-y-3">
          <div className="flex justify-between items-center">
            <span className="font-bold text-[#e5e2e1]">Bildirim Yeniden Deneme Kuyruğu</span>
          </div>
          <p className="text-[11px] text-[#d5c4ab]">En yakın "DLQ" eşdeğeri — klasik mesaj kuyruğu altyapısı yok</p>
          <div className="pt-2 border-t border-[#353535] space-y-1 text-[#d5c4ab]">
            <div className="flex justify-between"><span>Beklemede:</span><span className="text-[#ffdca1] font-bold" data-testid="metric-notification-retry">{m.notifications.retryQueue}</span></div>
            <div className="flex justify-between"><span>Devresi açık kanal:</span><span className={`font-bold ${m.notifications.circuitOpenChannels > 0 ? 'text-[#ffb4ab]' : 'text-[#a1e8a2]'}`}>{m.notifications.circuitOpenChannels}</span></div>
          </div>
        </div>

        <div className="bg-[#1c1b1b] border border-[#353535] p-6 rounded-2xl space-y-3">
          <div className="flex justify-between items-center">
            <span className="font-bold text-[#e5e2e1]">REST API Hata Oranı</span>
            <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${m.http.errorRatePct > 5 ? 'bg-[#ffb4ab]/10 text-[#ffb4ab]' : 'bg-[#a1e8a2]/10 text-[#a1e8a2]'}`}>
              {m.http.errorRatePct > 5 ? 'YÜKSEK' : 'NORMAL'}
            </span>
          </div>
          <p className="text-[11px] text-[#d5c4ab]">Süreç başlangıcından bu yana, tüm uçlar</p>
          <div className="pt-2 border-t border-[#353535] space-y-1 text-[#d5c4ab]">
            <div className="flex justify-between"><span>Toplam istek:</span><span className="text-[#e5e2e1] font-bold">{m.http.totalRequests}</span></div>
            <div className="flex justify-between"><span>5xx hata:</span><span className="text-[#ffb4ab] font-bold">{m.http.errorRequests}</span></div>
            <div className="flex justify-between"><span>Hata oranı:</span><span className="text-[#ffdca1] font-bold" data-testid="metric-error-rate">%{m.http.errorRatePct}</span></div>
          </div>
        </div>

      </div>

    </div>
  );
};
