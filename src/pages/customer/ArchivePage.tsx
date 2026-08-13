import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';

interface CustomArchive {
  id: string;
  name: string;
  type: 'MANUEL' | 'OTOMATİK';
  date: string;
  size: string;
  records: string;
  fileFormat: string;
}

export const ArchivePage: React.FC = () => {
  const { transactions, showToast } = useApp();
  const [selectedYear, setSelectedYear] = useState('2026');
  const [autoArchiveDays, setAutoArchiveDays] = useState('30');
  const [isArchiving, setIsArchiving] = useState(false);
  const [archiveProgressText, setArchiveProgressText] = useState('');

  // Initial archives list
  const [archivesList, setArchivesList] = useState<CustomArchive[]>([
    {
      id: 'arc-1',
      name: 'Ağustos 2026 İkmal & Sensör Otomatik Arşivi',
      type: 'OTOMATİK',
      date: '2026-08-01 00:00',
      size: '3.4 MB',
      records: '142 Kayıt',
      fileFormat: 'csv'
    },
    {
      id: 'arc-2',
      name: 'Temmuz 2026 E-İrsaliye Toplu Arşivi',
      type: 'OTOMATİK',
      date: '2026-07-01 00:00',
      size: '2.1 MB',
      records: '98 Fatura',
      fileFormat: 'json'
    },
    {
      id: 'arc-3',
      name: 'Haziran 2026 LoRa RAW Telemetri Logları',
      type: 'OTOMATİK',
      date: '2026-06-01 00:00',
      size: '12.8 MB',
      records: '1.2M Ham Sensör Verisi',
      fileFormat: 'log'
    }
  ]);

  const downloadFile = (filename: string, content: string, type: string, toastMsg: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(toastMsg);
  };

  // Trigger manual archiving on demand
  const handleTriggerManualArchive = () => {
    setIsArchiving(true);
    setArchiveProgressText('İkmal veritabanı kayıtları taranıyor...');

    setTimeout(() => {
      setArchiveProgressText('Telemetri sensör lojları ve e-irsaliyeler paketleniyor...');
    }, 800);

    setTimeout(() => {
      setArchiveProgressText('Şifreli ZIP paketi oluşturuluyor ve indeksleniyor...');
    }, 1600);

    setTimeout(() => {
      const now = new Date();
      const timestampStr = now.toISOString().replace('T', ' ').substring(0, 16);
      const newArc: CustomArchive = {
        id: 'arc-' + Date.now(),
        name: `Manuel Anlık Arşiv - ${now.toLocaleDateString('tr-TR')} (${now.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })})`,
        type: 'MANUEL',
        date: timestampStr,
        size: '4.8 MB',
        records: `${transactions.length} İkmal + Telemetri Logu`,
        fileFormat: 'zip'
      };

      setArchivesList(prev => [newArc, ...prev]);
      setIsArchiving(false);
      setArchiveProgressText('');
      showToast('Manuel veri arşivleme başarıyla tamamlandı ve pakete eklendi!');
    }, 2400);
  };

  // Calculate next run text
  const getNextArchiveText = () => {
    const days = Number(autoArchiveDays);
    if (days === 7) return 'Sonraki Otomatik Arşiv: 7 Gün Sonra (Haftalık Pazartesi 00:00)';
    if (days === 15) return 'Sonraki Otomatik Arşiv: 15 Gün Sonra (1. ve 15. Günler)';
    if (days === 30) return 'Sonraki Otomatik Arşiv: 30 Gün Sonra (Her Ayın 1\'i 00:00)';
    if (days === 90) return 'Sonraki Otomatik Arşiv: 90 Gün Sonra (Çeyreklik Dönem)';
    return `${days} Günde Bir`;
  };

  return (
    <div className="space-y-6">
      {/* HEADER & YEAR SELECT */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 bg-[#1c1b1b] border border-[#353535] p-6 rounded-2xl">
        <div className="space-y-1">
          <span className="text-xs font-mono font-bold text-[#ffdca1] uppercase tracking-widest block">
            DİJİTAL ARŞİV
          </span>
          <h1 className="text-2xl font-black text-[#e5e2e1] uppercase tracking-tight">
            VERİ ARŞİVLEME & GEÇMİŞ RAPORLAR
          </h1>
          <p className="text-xs text-[#d5c4ab]">
            Mali yıl bazlı ikmal verileri, geçmiş telemetri logları, e-İrsaliye dökümleri ve isteğe bağlı manuel yedekleme.
          </p>
        </div>

        <select
          value={selectedYear}
          onChange={(e) => setSelectedYear(e.target.value)}
          className="bg-[#131313] border border-[#353535] text-[#e5e2e1] text-xs font-mono rounded-xl p-3 focus:outline-none focus:border-[#ffdca1]"
        >
          <option value="2026">2026 Mali Yılı</option>
          <option value="2025">2025 Mali Yılı</option>
          <option value="2024">2024 Mali Yılı</option>
        </select>
      </div>

      {/* AUTOMATIC ARCHIVE FREQUENCY & MANUAL TRIGGER PANEL */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* CONFIG: Automatic Frequency */}
        <div className="bg-[#1c1b1b] border border-[#353535] p-6 rounded-2xl space-y-4 flex flex-col justify-between">
          <div className="space-y-2">
            <div className="flex items-center space-x-2 text-[#ffdca1]">
              <span className="material-symbols-outlined text-xl">schedule</span>
              <h3 className="font-extrabold text-xs uppercase tracking-wider">Otomatik Arşiv Sıklığı</h3>
            </div>
            <p className="text-xs text-[#d5c4ab] leading-relaxed">
              Sistem varsayılan olarak seçtiğiniz periyotta tüm ikmal kayıtlarını, pompa telemetrisini ve e-irsaliyeleri otomatik olarak arşiv paketine dönüştürür.
            </p>
          </div>

          <div className="space-y-3 pt-2">
            <div>
              <label className="text-[11px] font-mono text-[#d5c4ab] font-bold block mb-1">
                Otomatik Arşiv Periyodu (Kaç Günde Bir?)
              </label>
              <select
                value={autoArchiveDays}
                onChange={(e) => {
                  setAutoArchiveDays(e.target.value);
                  showToast(`Otomatik arşiv periyodu ${e.target.value} gün olarak güncellendi.`);
                }}
                className="w-full bg-[#131313] border border-[#353535] text-[#ffdca1] text-xs font-mono font-bold rounded-xl p-3 focus:outline-none focus:border-[#ffdca1]"
              >
                <option value="7">7 Günde Bir (Haftalık Arşivleme)</option>
                <option value="15">15 Günde Bir (Yarı Aylık Arşivleme)</option>
                <option value="30">30 Günde Bir (Aylık Standart - Varsayılan)</option>
                <option value="90">90 Günde Bir (Çeyreklik Dönemlik)</option>
              </select>
            </div>

            <div className="bg-[#20201f] border border-[#353535] p-3 rounded-xl font-mono text-[11px] text-[#a1e8a2] flex items-center space-x-2">
              <span className="material-symbols-outlined text-base shrink-0">info</span>
              <span>{getNextArchiveText()}</span>
            </div>
          </div>
        </div>

        {/* ACTION: Manual Archiving On Demand */}
        <div className="lg:col-span-2 bg-[#1c1b1b] border border-[#353535] p-6 rounded-2xl space-y-4 flex flex-col justify-between">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2 text-[#ffdca1]">
                <span className="material-symbols-outlined text-xl">cloud_download</span>
                <h3 className="font-extrabold text-xs uppercase tracking-wider">İsteğe Bağlı Anlık Manuel Arşivleme</h3>
              </div>
              <span className="bg-[#ffdca1]/15 border border-[#ffdca1]/30 text-[#ffdca1] text-[10px] font-mono font-bold px-2.5 py-1 rounded-full">
                ANINDA TETİKLEME
              </span>
            </div>
            <p className="text-xs text-[#d5c4ab] leading-relaxed">
              Otomatik arşiv periyodunu beklemeden istediğiniz an tek tıkla mevcut tüm aktif sistem verilerini (ikmal hareketleri, pompa logları, şoför yetkileri ve irsaliyeler) paketleyip indirebilirsiniz.
            </p>
          </div>

          <div className="space-y-3 pt-2">
            {isArchiving ? (
              <div className="bg-[#20201f] border border-[#ffdca1]/40 p-4 rounded-xl space-y-2 animate-pulse">
                <div className="flex items-center space-x-3 text-[#ffdca1]">
                  <span className="material-symbols-outlined text-2xl animate-spin">sync</span>
                  <span className="font-mono text-xs font-bold">{archiveProgressText}</span>
                </div>
                <div className="w-full bg-[#131313] h-2 rounded-full overflow-hidden">
                  <div className="bg-[#ffdca1] h-full w-2/3 animate-pulse"></div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col sm:flex-row items-center gap-3">
                <button
                  onClick={handleTriggerManualArchive}
                  className="w-full sm:w-auto px-6 py-3.5 bg-[#ffdca1] hover:bg-[#ffe3b3] text-[#412d00] font-black text-xs rounded-xl transition-all cursor-pointer shadow-lg flex items-center justify-center space-x-2 shrink-0"
                >
                  <span className="material-symbols-outlined text-lg">archive</span>
                  <span>ŞİMDİ MANUEL ARŞİV OLUŞTUR</span>
                </button>

                <p className="text-[11px] font-mono text-[#d5c4ab] text-center sm:text-left">
                  * Oluşturulan arşiv paketleri aşağıdaki listede anında indirmeye hazır hale getirilir.
                </p>
              </div>
            )}
          </div>
        </div>

      </div>

      {/* ARCHIVE PACKAGES LIST */}
      <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 space-y-4">
        <div className="flex items-center justify-between border-b border-[#353535] pb-4">
          <div className="flex items-center space-x-2">
            <span className="material-symbols-outlined text-[#ffdca1]">inventory_2</span>
            <h3 className="text-sm font-extrabold text-[#e5e2e1] uppercase tracking-wider">
              Mevcut Arşiv Paketleri ({archivesList.length})
            </h3>
          </div>
          <span className="text-xs font-mono text-[#d5c4ab]">Mali Yıl: {selectedYear}</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {archivesList.map((arc) => (
            <div
              key={arc.id}
              className="bg-[#20201f] border border-[#353535] hover:border-[#ffdca1]/50 rounded-2xl p-5 space-y-3 transition-colors flex flex-col justify-between"
            >
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className={`text-[10px] font-mono font-black px-2 py-0.5 rounded border ${
                    arc.type === 'MANUEL'
                      ? 'bg-[#a1e8a2]/20 border-[#a1e8a2]/40 text-[#a1e8a2]'
                      : 'bg-[#ffdca1]/20 border-[#ffdca1]/40 text-[#ffdca1]'
                  }`}>
                    {arc.type} ARŞİV
                  </span>
                  <span className="text-[10px] font-mono text-[#d5c4ab]">{arc.date}</span>
                </div>

                <h4 className="text-xs font-bold text-[#e5e2e1] leading-snug line-clamp-2">
                  {arc.name}
                </h4>

                <div className="flex items-center justify-between text-[11px] font-mono text-[#d5c4ab] pt-1">
                  <span>{arc.records}</span>
                  <span className="font-bold text-[#e5e2e1]">{arc.size}</span>
                </div>
              </div>

              <button
                onClick={() => downloadFile(
                  `${arc.id}-${selectedYear}.${arc.fileFormat}`,
                  `Tarih,Plaka,Litre,Santiye\n2026-08-01,34 BKT 19,450,Gebze Ana Santiye\n2026-08-02,06 KMY 88,280,Silivri Tesisleri\n[Arsiv Tipi: ${arc.type} | Kayit: ${arc.records}]`,
                  'text/csv',
                  `${arc.name} indirildi`
                )}
                className="w-full py-2.5 bg-[#131313] hover:bg-[#282726] text-[#ffdca1] hover:text-[#e5e2e1] text-xs font-bold font-mono rounded-xl border border-[#353535] transition-colors cursor-pointer flex items-center justify-center space-x-2 mt-2"
              >
                <span className="material-symbols-outlined text-base">download</span>
                <span>PAKETİ İNDİR (.{arc.fileFormat.toUpperCase()})</span>
              </button>
            </div>
          ))}
        </div>
      </div>

    </div>
  );
};

