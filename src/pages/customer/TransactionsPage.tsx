import React, { useState, useMemo } from 'react';
import { useApp } from '../../context/AppContext';
import * as XLSX from 'xlsx';

export const TransactionsPage: React.FC = () => {
  const { transactions, selectedSiteFilter, currentCompany, drivers } = useApp();

  // Filter States
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [siteFilter, setSiteFilter] = useState<string>(selectedSiteFilter);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [driverFilter, setDriverFilter] = useState<string>('TÜMÜ');
  const [pumpStatusFilter, setPumpStatusFilter] = useState<string>('TÜMÜ');
  const [selectedType, setSelectedType] = useState<string>('TÜMÜ');

  // Export Loading State
  const [isExporting, setIsExporting] = useState<boolean>(false);

  // Pagination State
  const [currentPage, setCurrentPage] = useState<number>(1);
  const pageSize = 10;

  // Sync with global header site filter if user changes header
  React.useEffect(() => {
    setSiteFilter(selectedSiteFilter);
    setCurrentPage(1);
  }, [selectedSiteFilter]);

  // Real-time client-side filtered data
  const filteredTransactions = useMemo(() => {
    return transactions.filter(t => {
      // Date filter
      if (startDate) {
        const txDate = t.timestamp.split(' ')[0];
        if (txDate < startDate) return false;
      }
      if (endDate) {
        const txDate = t.timestamp.split(' ')[0];
        if (txDate > endDate) return false;
      }

      // Site filter
      if (siteFilter !== 'TÜMÜ' && t.siteName !== siteFilter) return false;

      // Driver filter
      if (driverFilter !== 'TÜMÜ' && t.driverName !== driverFilter) return false;

      // Pump status filter
      if (pumpStatusFilter !== 'TÜMÜ' && t.pumpStatus !== pumpStatusFilter) return false;

      // Type filter
      if (selectedType !== 'TÜMÜ' && t.type !== selectedType) return false;

      // Search term (Plate, driver, tank)
      if (searchTerm.trim()) {
        const term = searchTerm.toLowerCase();
        const matchesPlate = t.vehiclePlate.toLowerCase().includes(term);
        const matchesDriver = t.driverName.toLowerCase().includes(term);
        const matchesTank = t.tankName.toLowerCase().includes(term);
        if (!matchesPlate && !matchesDriver && !matchesTank) return false;
      }

      return true;
    });
  }, [transactions, startDate, endDate, siteFilter, driverFilter, pumpStatusFilter, selectedType, searchTerm]);

  // Total volume of filtered results
  const totalFilteredLiters = useMemo(() => {
    return filteredTransactions.reduce((acc, t) => acc + t.amountLiters, 0);
  }, [filteredTransactions]);

  // Paginated Data
  const totalPages = Math.ceil(filteredTransactions.length / pageSize) || 1;
  const paginatedTransactions = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredTransactions.slice(start, start + pageSize);
  }, [filteredTransactions, currentPage, pageSize]);

  // Clear filters
  const handleClearFilters = () => {
    setStartDate('');
    setEndDate('');
    setSiteFilter('TÜMÜ');
    setSearchTerm('');
    setDriverFilter('TÜMÜ');
    setPumpStatusFilter('TÜMÜ');
    setSelectedType('TÜMÜ');
    setCurrentPage(1);
  };

  // Section 6.3 Real Excel Export with SheetJS
  const handleExportExcel = () => {
    setIsExporting(true);

    setTimeout(() => {
      // Map filtered rows to clean Turkish column titles
      const exportData = filteredTransactions.map(t => {
        const [datePart, timePart] = t.timestamp.split(' ');
        return {
          'İkmal Tarihi': datePart || t.timestamp,
          'Saat': timePart || '',
          'Şantiye Adı': t.siteName,
          'Araç Plakası': t.vehiclePlate,
          'Şoför Ad Soyad': t.driverName,
          'Çekilen Tank': t.tankName,
          'Debi Hızı (L/dk)': t.flowRateLpm,
          'İkmal Tipi': t.type,
          'RFID Onayı': t.rfidAuth ? 'Başarılı' : 'Manuel / Yok',
          'Pompa Durumu': t.pumpStatus,
          'Alınan Miktar (Litre)': t.amountLiters
        };
      });

      // Create sheet & workbook
      const worksheet = XLSX.utils.json_to_sheet(exportData);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Yakıt Hareketleri');

      // Auto-fit column widths
      const colWidths = [
        { wch: 14 }, // Tarih
        { wch: 10 }, // Saat
        { wch: 22 }, // Şantiye
        { wch: 16 }, // Plaka
        { wch: 20 }, // Şoför
        { wch: 24 }, // Tank
        { wch: 16 }, // Debi Hızı
        { wch: 16 }, // İkmal Tipi
        { wch: 14 }, // RFID
        { wch: 16 }, // Durum
        { wch: 20 }  // Litre
      ];
      worksheet['!cols'] = colWidths;

      // File format: yakit-hareketleri_YYYY-MM-DD.xlsx
      const today = new Date().toISOString().split('T')[0];
      const filename = `yakit-hareketleri_${today}.xlsx`;

      XLSX.writeFile(workbook, filename);
      setIsExporting(false);
    }, 600);
  };

  return (
    <div className="space-y-6">
      
      {/* Page Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 bg-[#1c1b1b] border border-[#514532]/25 p-6 rounded-xl">
        <div className="space-y-1">
          <span className="text-xs font-mono font-bold text-[#ffdca1] uppercase tracking-widest block">
            DEBİMETRE TELEMETRİ KAYITLARI
          </span>
          <h1 className="text-2xl font-black text-[#e5e2e1] uppercase tracking-tight">
            YAKIT HAREKETLERİ & İKMAL LOGLARI
          </h1>
          <p className="text-xs text-[#d5c4ab]">
            Pompalardan çekilen anlık yakıt litreleri, RFID kimlik doğrulamaları ve debimetre verileri.
          </p>
        </div>

        {/* Liters Total & Excel Export Button */}
        <div className="flex flex-wrap items-center gap-4">
          <div className="bg-[#0e0e0e] border border-[#514532]/30 px-4 py-2.5 rounded-md flex items-center space-x-3">
            <span className="material-symbols-outlined text-[#ffdca1] text-xl">water_drop</span>
            <div>
              <span className="text-[10px] text-[#d5c4ab] font-mono block">FİLTRELENEN TOPLAM HACMİ</span>
              <span className="text-lg font-black font-mono text-[#e5e2e1]">
                {totalFilteredLiters.toLocaleString('tr-TR')} Litre
              </span>
            </div>
          </div>

          {/* Section 6.3 Excel Export Primary Button */}
          <button
            onClick={handleExportExcel}
            disabled={isExporting || filteredTransactions.length === 0}
            className="px-5 py-3 bg-gradient-to-r from-[#ffb800] to-[#ff8a00] hover:from-[#ffdca1] hover:to-[#ffb77f] text-[#412d00] font-black rounded-md text-xs flex items-center space-x-2 transition-all cursor-pointer shadow-sm disabled:opacity-50"
          >
            {isExporting ? (
              <>
                <span className="w-4 h-4 border-2 border-[#412d00] border-t-transparent rounded-full animate-spin" />
                <span>Hazırlanıyor...</span>
              </>
            ) : (
              <>
                <span className="material-symbols-outlined text-base">download</span>
                <span>Excel Olarak İndir</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* SECTION 6.1 Yatay Filtre Çubuğu */}
      <div className="bg-[#1c1b1b] border border-[#514532]/25 p-4 rounded-xl space-y-4">
        
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
          {/* Başlangıç Tarihi */}
          <div>
            <label className="text-[10px] font-mono font-bold text-[#d5c4ab] uppercase block mb-1">
              Başlangıç Tarihi
            </label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => { setStartDate(e.target.value); setCurrentPage(1); }}
              className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs font-mono rounded-md p-2 focus:outline-none focus:border-[#ffdca1]"
            />
          </div>

          {/* Bitiş Tarihi */}
          <div>
            <label className="text-[10px] font-mono font-bold text-[#d5c4ab] uppercase block mb-1">
              Bitiş Tarihi
            </label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => { setEndDate(e.target.value); setCurrentPage(1); }}
              className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs font-mono rounded-md p-2 focus:outline-none focus:border-[#ffdca1]"
            />
          </div>

          {/* Şantiye Dropdown */}
          <div>
            <label className="text-[10px] font-mono font-bold text-[#d5c4ab] uppercase block mb-1">
              Şantiye Seçimi
            </label>
            <select
              value={siteFilter}
              onChange={(e) => { setSiteFilter(e.target.value); setCurrentPage(1); }}
              className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-2 focus:outline-none focus:border-[#ffdca1]"
            >
              <option value="TÜMÜ">Tüm Şantiyeler</option>
              {currentCompany.sites.map(s => (
                <option key={s.id} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          {/* Şoför Dropdown */}
          <div>
            <label className="text-[10px] font-mono font-bold text-[#d5c4ab] uppercase block mb-1">
              Şoför
            </label>
            <select
              value={driverFilter}
              onChange={(e) => { setDriverFilter(e.target.value); setCurrentPage(1); }}
              className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-2 focus:outline-none focus:border-[#ffdca1]"
            >
              <option value="TÜMÜ">Tüm Şoförler</option>
              {drivers.map(d => (
                <option key={d.id} value={d.name}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>

          {/* Pompa Durumu Dropdown */}
          <div>
            <label className="text-[10px] font-mono font-bold text-[#d5c4ab] uppercase block mb-1">
              Pompa Durumu
            </label>
            <select
              value={pumpStatusFilter}
              onChange={(e) => { setPumpStatusFilter(e.target.value); setCurrentPage(1); }}
              className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-2 focus:outline-none focus:border-[#ffdca1]"
            >
              <option value="TÜMÜ">Tümü</option>
              <option value="TAMAMLANTI">Başarılı / Tamamlandı</option>
              <option value="DURDURULDU">Durduruldu</option>
              <option value="ANOMALİ">Anomali / Şüpheli</option>
            </select>
          </div>

          {/* Arama Input (Plaka / Şoför) */}
          <div>
            <label className="text-[10px] font-mono font-bold text-[#d5c4ab] uppercase block mb-1">
              Plaka / Arama
            </label>
            <div className="relative">
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => { setSearchTerm(e.target.value); setCurrentPage(1); }}
                placeholder="Plaka veya ara..."
                className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md pl-8 pr-2 p-2 focus:outline-none focus:border-[#ffdca1]"
              />
              <span className="material-symbols-outlined absolute left-2 top-1/2 -translate-y-1/2 text-[#d5c4ab] text-sm">
                search
              </span>
            </div>
          </div>
        </div>

        {/* Filter Bottom Bar: Results counter & Clear ghost button */}
        <div className="flex items-center justify-between pt-3 border-t border-[#514532]/20 text-xs font-mono">
          <span className="text-[#ffdca1] font-bold">
            {filteredTransactions.length} ikmal hareketi bulundu
          </span>

          <button
            onClick={handleClearFilters}
            className="px-3 py-1 bg-transparent hover:bg-[#353535] text-[#d5c4ab] hover:text-[#e5e2e1] rounded-md text-xs transition-colors flex items-center space-x-1 cursor-pointer"
          >
            <span className="material-symbols-outlined text-sm">filter_alt_off</span>
            <span>Filtreleri Temizle</span>
          </button>
        </div>

      </div>

      {/* SECTION 6.2 Tablo */}
      <div className="bg-[#1c1b1b] border border-[#514532]/25 rounded-xl p-6 space-y-4 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-[#514532]/30 text-[#d5c4ab] uppercase text-[10px] tracking-wider font-mono">
                <th className="py-3.5 px-4">Tarih & Saat</th>
                <th className="py-3.5 px-4">Şantiye</th>
                <th className="py-3.5 px-4">Araç Plakası</th>
                <th className="py-3.5 px-4">Şoför</th>
                <th className="py-3.5 px-4">Çekilen Tank</th>
                <th className="py-3.5 px-4">Debi Hızı</th>
                <th className="py-3.5 px-4">İkmal Tipi</th>
                <th className="py-3.5 px-4">Pompa Durumu</th>
                <th className="py-3.5 px-4 text-right">Alınan Miktar</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#514532]/20 font-mono">
              {paginatedTransactions.map(t => (
                <tr key={t.id} className="hover:bg-[#20201f] transition-colors">
                  <td className="py-3.5 px-4 text-[#d5c4ab]">{t.timestamp}</td>
                  <td className="py-3.5 px-4 font-bold text-[#e5e2e1]">{t.siteName}</td>
                  <td className="py-3.5 px-4 font-black text-[#ffdca1] text-sm">{t.vehiclePlate}</td>
                  <td className="py-3.5 px-4 text-[#e5e2e1]">{t.driverName}</td>
                  <td className="py-3.5 px-4 text-[#d5c4ab]">{t.tankName}</td>
                  <td className="py-3.5 px-4 text-[#a1e8a2]">{t.flowRateLpm} L/dk</td>
                  <td className="py-3.5 px-4">
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-[#20201f] text-[#d5c4ab] border border-[#514532]/30">
                      {t.type}
                    </span>
                  </td>
                  <td className="py-3.5 px-4">
                    <span className={`text-[10px] font-bold px-2.5 py-1 rounded border ${
                      t.pumpStatus === 'TAMAMLANTI'
                        ? 'bg-[#ffb800]/10 text-[#ffdca1] border-[#ffb800]/30'
                        : t.pumpStatus === 'ANOMALİ'
                        ? 'bg-[#93000a]/20 text-[#ffb4ab] border-[#93000a]'
                        : 'bg-[#ff8a00]/10 text-[#ffb77f] border-[#ff8a00]/30'
                    }`}>
                      {t.pumpStatus}
                    </span>
                  </td>
                  <td className="py-3.5 px-4 text-right font-black text-[#e5e2e1] text-sm">
                    {t.amountLiters.toLocaleString('tr-TR')} Litre
                  </td>
                </tr>
              ))}

              {filteredTransactions.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-[#d5c4ab]">
                    Filtre kriterlerine uygun yakıt hareketi bulunamadı.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination controls */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between pt-4 border-t border-[#514532]/20 font-mono text-xs">
            <span className="text-[#d5c4ab]">
              Sayfa {currentPage} / {totalPages} (Toplam {filteredTransactions.length} Kayıt)
            </span>

            <div className="flex items-center space-x-2">
              <button
                disabled={currentPage === 1}
                onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                className="px-3 py-1.5 bg-[#20201f] hover:bg-[#2a2a2a] disabled:opacity-40 text-[#e5e2e1] rounded-md text-xs cursor-pointer"
              >
                Önceki
              </button>
              <button
                disabled={currentPage === totalPages}
                onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                className="px-3 py-1.5 bg-[#20201f] hover:bg-[#2a2a2a] disabled:opacity-40 text-[#e5e2e1] rounded-md text-xs cursor-pointer"
              >
                Sonraki
              </button>
            </div>
          </div>
        )}
      </div>

    </div>
  );
};
