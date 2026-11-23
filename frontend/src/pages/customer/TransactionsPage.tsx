import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { exportToExcelWithTotals } from '../../utils/excelExporter';
import { downloadAuthenticatedFile } from '../../utils/api';
import { FuelTransaction, DespatchAdviceStatus } from '../../types';
import { useTransactionsQuery, useDebouncedValue, fetchAllFilteredTransactions, TransactionQueryFilters } from '../../hooks/useTransactionsQuery';
import { ListSkeleton } from '../../components/ListSkeleton';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';

const DESPATCH_STATUS_VIEW_ROLES = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'];

type SortColumn = 'created_at' | 'site_name' | 'vehicle_plate' | 'driver_name' | 'tank_name' | 'amount_liters' | 'pump_status' | 'type';

// FE-812 AC: "sütun sıralama." Backend'in izin verdiği kolon kümesiyle
// BİREBİR aynı (bkz. backend transactionSchema.ts TRANSACTION_SORT_COLUMNS).
const SortableHeader: React.FC<{
  column: SortColumn;
  label: string;
  sortBy: SortColumn;
  sortDir: 'asc' | 'desc';
  onSort: (column: SortColumn) => void;
  align?: 'left' | 'right';
}> = ({ column, label, sortBy, sortDir, onSort, align = 'left' }) => {
  const isActive = sortBy === column;
  return (
    <th
      data-testid={`sort-header-${column}`}
      onClick={() => onSort(column)}
      className={`py-3.5 px-4 cursor-pointer select-none hover:text-[#ffdca1] transition-colors ${align === 'right' ? 'text-right' : ''}`}
    >
      <span className={`inline-flex items-center gap-1 ${align === 'right' ? 'flex-row-reverse' : ''}`}>
        {label}
        <span className={`material-symbols-outlined text-sm ${isActive ? 'text-[#ffdca1]' : 'text-[#514532]/60'}`}>
          {isActive && sortDir === 'asc' ? 'arrow_upward' : 'arrow_downward'}
        </span>
      </span>
    </th>
  );
};

export const TransactionsPage: React.FC = () => {
  const { selectedSiteFilter, currentCompany, drivers, tanks, isManagerMode, currentUser, showToast, fetchTransactionDespatchStatus } = useApp();

  // FE-802 AC: "Filtreler URL ile senkron olmalıdır" (?page=1&site=...&startDate=...)
  // — sayfa yenilenince/bağlantı paylaşılınca filtreler ÖNCEDEN kayboluyordu.
  // Başlangıç durumu URL'den okunuyor (varsa), sonraki her değişiklik
  // aşağıdaki yazıcı effect'le GERİ URL'e yazılıyor.
  const [searchParams, setSearchParams] = useSearchParams();

  // Filter States
  const [startDate, setStartDate] = useState<string>(() => searchParams.get('startDate') || '');
  const [endDate, setEndDate] = useState<string>(() => searchParams.get('endDate') || '');
  const [siteFilter, setSiteFilter] = useState<string>(() => searchParams.get('site') || selectedSiteFilter);
  const [searchTerm, setSearchTerm] = useState<string>(() => searchParams.get('q') || '');
  const [driverFilter, setDriverFilter] = useState<string>(() => searchParams.get('driver') || 'TÜMÜ');
  const [pumpStatusFilter, setPumpStatusFilter] = useState<string>(() => searchParams.get('pumpStatus') || 'TÜMÜ');
  const [selectedType, setSelectedType] = useState<string>(() => searchParams.get('type') || 'TÜMÜ');
  // FE-812 Kapsam: "Gelişmiş filtre paneli: ... araç, ... tank." Önceden
  // bunlar yalnızca serbest metin "Arama" kutusunun (ILIKE birleşik) dolaylı
  // kapsamındaydı — REP-711'in (bkz. backend rep711DispenseMovement.ts)
  // AYRI alanlarıyla tutarlı, kendi filtreleri eklendi.
  const [vehicleFilter, setVehicleFilter] = useState<string>(() => searchParams.get('vehicle') || '');
  const [tankFilter, setTankFilter] = useState<string>(() => searchParams.get('tank') || 'TÜMÜ');

  // FE-812 AC: "sütun sıralama." Varsayılan backend'le AYNI (created_at DESC).
  const [sortBy, setSortBy] = useState<SortColumn>(() => (searchParams.get('sortBy') as SortColumn) || 'created_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(() => (searchParams.get('sortDir') as 'asc' | 'desc') || 'desc');

  // FE-812 Kapsam: "yoğunluk seçenekleri" — tablo satır yüksekliği tercihi,
  // sunucuya gitmez, yalnızca görüntüleme.
  const [isCompactDensity, setIsCompactDensity] = useState(false);

  // FE-812 Kapsam: "Satır detayında ... e-İrsaliye durumu." Açık satırın id'si
  // + o satır için (on-demand, lazy) çekilen e-İrsaliye durumu.
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
  const [despatchStatus, setDespatchStatus] = useState<DespatchAdviceStatus | null | 'loading' | 'forbidden'>(null);

  // Export Loading State — hangi formatın o an hazırlandığını da taşır,
  // böylece sadece tıklanan buton spinner gösterir, diğer ikisi disabled kalır.
  const [isExportingFormat, setIsExportingFormat] = useState<'xlsx' | 'csv' | 'pdf' | null>(null);

  // Pagination State
  const [currentPage, setCurrentPage] = useState<number>(() => {
    const fromUrl = Number(searchParams.get('page'));
    return Number.isFinite(fromUrl) && fromUrl > 0 ? Math.floor(fromUrl) : 1;
  });
  const pageSize = 10;

  // Sync with global header site filter if user changes header — İLK
  // render'da ÇALIŞTIRILMAZ (yukarıdaki lazy initializer zaten URL'deki
  // 'site' parametresini YA DA header'ın o anki değerini kullanıyor; bu
  // effect ilk seferde de çalışsaydı URL'den geri yüklenen siteFilter'ı
  // hemen ÜZERİNE yazardı).
  const isFirstSiteSyncRef = useRef(true);
  useEffect(() => {
    if (isFirstSiteSyncRef.current) {
      isFirstSiteSyncRef.current = false;
      return;
    }
    setSiteFilter(selectedSiteFilter);
    setCurrentPage(1);
  }, [selectedSiteFilter]);

  // FE-802 Kapsam: "Arama girdilerinde 300ms debounce" — arama kutusu her
  // tuş vuruşunda değil, kullanıcı yazmayı bitirdikten ~300ms sonra sunucuya gitsin.
  const debouncedSearchTerm = useDebouncedValue(searchTerm, 300);
  // FE-812 AC: "Arama girdilerinde 300ms debounce" — araç plakası filtresi
  // de serbest metin olduğundan AYNI kurala tabi.
  const debouncedVehicleFilter = useDebouncedValue(vehicleFilter, 300);

  // Filtre/sayfa değiştikçe URL'i GÜNCEL durumla senkron tutar (AC).
  // `replace: true` — her tuş vuruşunda/filtre değişiminde tarayıcı geçmişini
  // ŞİŞİRMEMEK için (aksi halde "geri" tuşu kullanılamaz hale gelirdi).
  // Varsayılan değerler ('TÜMÜ', boş, page 1) URL'i kirletmemek için hiç yazılmaz.
  useEffect(() => {
    const params: Record<string, string> = {};
    if (startDate) params.startDate = startDate;
    if (endDate) params.endDate = endDate;
    if (siteFilter !== 'TÜMÜ') params.site = siteFilter;
    if (vehicleFilter) params.vehicle = vehicleFilter;
    if (driverFilter !== 'TÜMÜ') params.driver = driverFilter;
    if (tankFilter !== 'TÜMÜ') params.tank = tankFilter;
    if (pumpStatusFilter !== 'TÜMÜ') params.pumpStatus = pumpStatusFilter;
    if (selectedType !== 'TÜMÜ') params.type = selectedType;
    if (searchTerm) params.q = searchTerm;
    if (sortBy !== 'created_at') params.sortBy = sortBy;
    if (sortDir !== 'desc') params.sortDir = sortDir;
    if (currentPage > 1) params.page = String(currentPage);
    setSearchParams(params, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startDate, endDate, siteFilter, vehicleFilter, driverFilter, tankFilter, pumpStatusFilter, selectedType, searchTerm, sortBy, sortDir, currentPage]);

  // Sunucuya gidecek filtre seti — bunlardan biri değiştiğinde React Query
  // otomatik olarak yeni bir sayfa isteği atar (queryKey bu nesneyi içeriyor).
  const filters: TransactionQueryFilters = useMemo(() => ({
    page: currentPage,
    pageSize,
    startDate: startDate || undefined,
    endDate: endDate || undefined,
    siteName: siteFilter !== 'TÜMÜ' ? siteFilter : undefined,
    vehiclePlate: debouncedVehicleFilter || undefined,
    driverName: driverFilter !== 'TÜMÜ' ? driverFilter : undefined,
    tankName: tankFilter !== 'TÜMÜ' ? tankFilter : undefined,
    pumpStatus: pumpStatusFilter !== 'TÜMÜ' ? (pumpStatusFilter as any) : undefined,
    type: selectedType !== 'TÜMÜ' ? (selectedType as any) : undefined,
    search: debouncedSearchTerm || undefined,
    sortBy,
    sortDir
  }), [currentPage, startDate, endDate, siteFilter, debouncedVehicleFilter, driverFilter, tankFilter, pumpStatusFilter, selectedType, debouncedSearchTerm, sortBy, sortDir]);

  const { data, isLoading, isFetching, isPlaceholderData, isError, error, refetch } = useTransactionsQuery(filters);

  const transactions = data?.transactions ?? [];
  const totalCount = data?.totalCount ?? 0;
  const totalPages = data?.totalPages ?? 1;
  const totalFilteredLiters = data?.totalLiters ?? 0;

  useEffect(() => {
    if (isError) {
      showToast(`İkmal geçmişi getirilirken hata: ${error?.message}`, 'error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isError]);

  // Bir filtre sayfa sayısını filtrelenmiş sonucu currentPage'in ötesine
  // düşürürse (ör. arama sonucu 2 sayfaya iniyor ama 5. sayfadaydık) son
  // geçerli sayfaya geri çek.
  useEffect(() => {
    if (data && currentPage > data.totalPages) {
      setCurrentPage(data.totalPages);
    }
  }, [data, currentPage]);

  // Clear filters
  const handleClearFilters = () => {
    setStartDate('');
    setEndDate('');
    setSiteFilter(!isManagerMode && currentUser?.siteName ? currentUser.siteName : 'TÜMÜ');
    setSearchTerm('');
    setVehicleFilter('');
    setDriverFilter('TÜMÜ');
    setTankFilter('TÜMÜ');
    setPumpStatusFilter('TÜMÜ');
    setSelectedType('TÜMÜ');
    setCurrentPage(1);
  };

  // FE-812 AC: "sütun sıralama." Aynı sütuna tekrar tıklamak yönü çevirir;
  // farklı bir sütuna tıklamak o sütunu DESC (en yeni/en büyük önce) başlatır.
  const handleSortClick = (column: SortColumn) => {
    if (sortBy === column) {
      setSortDir(prev => (prev === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortBy(column);
      setSortDir('desc');
    }
    setCurrentPage(1);
  };

  // FE-812 Kapsam: "Satır detayında ... e-İrsaliye durumu." Aynı satıra
  // tekrar tıklamak kapatır; başka bir satıra tıklamak o satırın durumunu
  // (on-demand) çeker.
  const handleToggleRowDetail = async (transactionId: string) => {
    if (expandedRowId === transactionId) {
      setExpandedRowId(null);
      return;
    }
    setExpandedRowId(transactionId);
    // Backend DESPATCH_TRANSMISSION_VIEW_ROLES'da yok (PUMP_OPERATOR) —
    // hiç çağrı yapılmaz, "henüz oluşturulmadı" gibi YANILTICI bir mesaj
    // yerine doğrudan yetkisiz olduğu belirtilir.
    if (!currentUser || !DESPATCH_STATUS_VIEW_ROLES.includes(currentUser.role)) {
      setDespatchStatus('forbidden');
      return;
    }
    setDespatchStatus('loading');
    const status = await fetchTransactionDespatchStatus(transactionId);
    setDespatchStatus(status);
  };

  // Section 6.3 Real Excel Export with SheetJS & Auto-Calculated Totals.
  // Ekranda görünen tek sayfa değil, filtreye uyan TÜM kayıtlar dışa
  // aktarılıyor — bkz. fetchAllFilteredTransactions (birden fazla sayfa
  // isteğini birleştirir). BİLİNÇLİ OLARAK dokunulmadı/değiştirilmedi: zaten
  // var olan, REP-701'in sabit sütun kümesinden DAHA ZENGİN (Debi Hızı, RFID
  // Onayı) bir export — REP-701'e geçmek bu sütunları KAYBEDERDİ.
  const handleExportExcel = async () => {
    setIsExportingFormat('xlsx');
    try {
      const allFiltered = await fetchAllFilteredTransactions({
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        siteName: siteFilter !== 'TÜMÜ' ? siteFilter : undefined,
        vehiclePlate: debouncedVehicleFilter || undefined,
        driverName: driverFilter !== 'TÜMÜ' ? driverFilter : undefined,
        tankName: tankFilter !== 'TÜMÜ' ? tankFilter : undefined,
        pumpStatus: pumpStatusFilter !== 'TÜMÜ' ? (pumpStatusFilter as any) : undefined,
        type: selectedType !== 'TÜMÜ' ? (selectedType as any) : undefined,
        search: debouncedSearchTerm || undefined
      });

      const today = new Date().toISOString().split('T')[0];
      const filename = `yakit-hareketleri_${today}.xlsx`;

      exportToExcelWithTotals<FuelTransaction>({
        data: allFiltered,
        sheetName: 'Yakıt Hareketleri',
        filename,
        totalLabelColumnIndex: 0,
        totalLabel: 'GENEL TOPLAM',
        columns: [
          { header: 'İkmal Tarihi', key: t => t.timestamp.split(' ')[0] || t.timestamp, width: 14 },
          { header: 'Saat', key: t => t.timestamp.split(' ')[1] || '', width: 10 },
          { header: 'Şantiye Adı', key: 'siteName', width: 22 },
          { header: 'Araç Plakası', key: 'vehiclePlate', width: 16 },
          { header: 'Şoför Ad Soyad', key: 'driverName', width: 20 },
          { header: 'Çekilen Tank', key: 'tankName', width: 24 },
          { header: 'Debi Hızı (L/dk)', key: 'flowRateLpm', width: 16 },
          { header: 'İkmal Tipi', key: 'type', width: 16 },
          { header: 'RFID Onayı', key: t => t.rfidAuth ? 'Başarılı' : 'Manuel / Yok', width: 14 },
          { header: 'Pompa Durumu', key: 'pumpStatus', width: 16 },
          { header: 'Alınan Miktar (Litre)', key: 'amountLiters', isTotalable: true, format: 'number', width: 22 }
        ]
      });
    } catch (err: any) {
      showToast(`Excel dışa aktarımı sırasında hata: ${err.message}`, 'error');
    } finally {
      setIsExportingFormat(null);
    }
  };

  // FE-812 AC: "Excel/CSV/PDF export" + "Export işlemi kullanıcıyı
  // bloklamamalıdır." CSV/PDF YENİ eklendi — REP-703'ün zaten var olan, test
  // edilmiş /reports/rep-711/export ucunu (REP-711) doğrudan kullanır: tek,
  // sunucu taraflı STREAMED bir istek (üstteki Excel'in sayfa-sayfa yeniden
  // çekmesinden daha verimli), buton bu sırada devre dışı+spinner gösterir
  // ama render thread'i DONDURMAZ (async fetch).
  //
  // KAPSAM UYARLAMASI (disclosed): "büyük export'ta arka plan bilgilendirmesi"
  // AC'si bir iş kuyruğu + daha sonra bildirim (push/e-posta) ima ediyor —
  // bu kod tabanında (başka HİÇBİR export'ta da, bkz. src/index.ts'teki
  // "BullMQ yok" yorumları) böyle bir arka plan kuyruk altyapısı YOK; ayrı,
  // büyük bir backend projesi olurdu. Burada "bloklamama" AC'sinin
  // karşılandığı biçim: tek async istek + devre dışı buton + spinner + bitince
  // toast (PDF zaten REP-703 tarafında 2000 satır üstünde 400 ile reddedilip
  // CSV'ye yönlendiriliyor — bkz. reports/pdfExport.ts).
  const handleExportReport = async (format: 'csv' | 'pdf') => {
    setIsExportingFormat(format);
    try {
      const params = new URLSearchParams({ format });
      if (startDate) params.set('startDate', startDate);
      if (endDate) params.set('endDate', endDate);
      if (siteFilter !== 'TÜMÜ') params.set('siteName', siteFilter);
      if (debouncedVehicleFilter) params.set('vehiclePlate', debouncedVehicleFilter);
      if (driverFilter !== 'TÜMÜ') params.set('driverName', driverFilter);
      if (tankFilter !== 'TÜMÜ') params.set('tankName', tankFilter);
      if (pumpStatusFilter !== 'TÜMÜ') params.set('pumpStatus', pumpStatusFilter);
      if (selectedType !== 'TÜMÜ') params.set('type', selectedType);

      const today = new Date().toISOString().split('T')[0];
      await downloadAuthenticatedFile(`/reports/rep-711/export?${params.toString()}`, `ikmal-hareketleri_${today}.${format}`);
      showToast(`${format.toUpperCase()} dosyası indirildi.`);
    } catch (err: any) {
      showToast(`${format.toUpperCase()} dışa aktarımı sırasında hata: ${err.message}`, 'error');
    } finally {
      setIsExportingFormat(null);
    }
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

          {/* Section 6.3 Export Buttons — Excel (zaten var, dokunulmadı) + FE-812: YENİ CSV/PDF */}
          <div className="flex items-center gap-2">
            <button
              data-testid="export-excel"
              onClick={handleExportExcel}
              disabled={isExportingFormat !== null || totalCount === 0}
              className="px-5 py-3 bg-gradient-to-r from-[#ffb800] to-[#ff8a00] hover:from-[#ffdca1] hover:to-[#ffb77f] text-[#412d00] font-black rounded-md text-xs flex items-center space-x-2 transition-all cursor-pointer shadow-sm disabled:opacity-50"
            >
              {isExportingFormat === 'xlsx' ? (
                <>
                  <span className="w-4 h-4 border-2 border-[#412d00] border-t-transparent rounded-full animate-spin" />
                  <span>Hazırlanıyor...</span>
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined text-base">download</span>
                  <span>Excel</span>
                </>
              )}
            </button>
            <button
              data-testid="export-csv"
              onClick={() => handleExportReport('csv')}
              disabled={isExportingFormat !== null || totalCount === 0}
              className="px-4 py-3 bg-[#20201f] hover:bg-[#2a2a2a] border border-[#514532]/30 text-[#e5e2e1] font-bold rounded-md text-xs flex items-center space-x-2 transition-all cursor-pointer disabled:opacity-50"
            >
              {isExportingFormat === 'csv' ? (
                <span className="w-4 h-4 border-2 border-[#e5e2e1] border-t-transparent rounded-full animate-spin" />
              ) : (
                <span className="material-symbols-outlined text-base">description</span>
              )}
              <span>CSV</span>
            </button>
            <button
              data-testid="export-pdf"
              onClick={() => handleExportReport('pdf')}
              disabled={isExportingFormat !== null || totalCount === 0}
              className="px-4 py-3 bg-[#20201f] hover:bg-[#2a2a2a] border border-[#514532]/30 text-[#e5e2e1] font-bold rounded-md text-xs flex items-center space-x-2 transition-all cursor-pointer disabled:opacity-50"
            >
              {isExportingFormat === 'pdf' ? (
                <span className="w-4 h-4 border-2 border-[#e5e2e1] border-t-transparent rounded-full animate-spin" />
              ) : (
                <span className="material-symbols-outlined text-base">picture_as_pdf</span>
              )}
              <span>PDF</span>
            </button>
          </div>
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
            {isManagerMode ? (
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
            ) : (
              <div className="w-full bg-[#0e0e0e] border border-[#a1e8a2]/30 text-[#a1e8a2] text-xs rounded-md p-2 font-bold flex items-center space-x-1.5 select-none">
                <span className="material-symbols-outlined text-sm">lock</span>
                <span>{currentUser?.siteName || selectedSiteFilter}</span>
              </div>
            )}
          </div>

          {/* FE-812 Kapsam: "araç" — önceden yalnızca serbest metin Arama'nın dolaylı kapsamındaydı */}
          <div>
            <label className="text-[10px] font-mono font-bold text-[#d5c4ab] uppercase block mb-1">
              Araç Plakası
            </label>
            <input
              type="text"
              data-testid="filter-vehicle"
              value={vehicleFilter}
              onChange={(e) => { setVehicleFilter(e.target.value); setCurrentPage(1); }}
              placeholder="Plaka..."
              className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs font-mono rounded-md p-2 focus:outline-none focus:border-[#ffdca1]"
            />
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

          {/* FE-812 Kapsam: "tank" */}
          <div>
            <label className="text-[10px] font-mono font-bold text-[#d5c4ab] uppercase block mb-1">
              Tank
            </label>
            <select
              data-testid="filter-tank"
              value={tankFilter}
              onChange={(e) => { setTankFilter(e.target.value); setCurrentPage(1); }}
              className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-2 focus:outline-none focus:border-[#ffdca1]"
            >
              <option value="TÜMÜ">Tüm Tanklar</option>
              {tanks.map(t => (
                <option key={t.id} value={t.name}>
                  {t.name}
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

          {/* FE-812: "yetki tipi" — state/URL zaten vardı, bu seçim kutusu HİÇ yoktu (ölü alan) */}
          <div>
            <label className="text-[10px] font-mono font-bold text-[#d5c4ab] uppercase block mb-1">
              Yetki Tipi
            </label>
            <select
              data-testid="filter-type"
              value={selectedType}
              onChange={(e) => { setSelectedType(e.target.value); setCurrentPage(1); }}
              className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-2 focus:outline-none focus:border-[#ffdca1]"
            >
              <option value="TÜMÜ">Tümü</option>
              <option value="Otomatik">Otomatik (RFID/Cihaz)</option>
              <option value="Manuel">Manuel</option>
              <option value="Çapraz Şantiye">Çapraz Şantiye</option>
              <option value="Çevrimdışı Senkron">Çevrimdışı Senkron</option>
            </select>
          </div>

          {/* Arama Input (Plaka / Şoför / Tank serbest metin) */}
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
          <span className="text-[#ffdca1] font-bold flex items-center gap-2">
            {totalCount} ikmal hareketi bulundu
            {isFetching && (
              <span className="w-3 h-3 border-2 border-[#ffdca1] border-t-transparent rounded-full animate-spin" title="Güncelleniyor..." />
            )}
          </span>

          <div className="flex items-center gap-2">
            {/* FE-812 Kapsam: "yoğunluk seçenekleri" — sunucuya gitmeyen, salt görüntüleme tercihi */}
            <button
              data-testid="density-toggle"
              onClick={() => setIsCompactDensity(prev => !prev)}
              className="px-3 py-1 bg-transparent hover:bg-[#353535] text-[#d5c4ab] hover:text-[#e5e2e1] rounded-md text-xs transition-colors flex items-center space-x-1 cursor-pointer"
              title="Satır yüksekliğini değiştir"
            >
              <span className="material-symbols-outlined text-sm">{isCompactDensity ? 'density_small' : 'density_large'}</span>
              <span>{isCompactDensity ? 'Sıkı Görünüm' : 'Geniş Görünüm'}</span>
            </button>
            <button
              onClick={handleClearFilters}
              className="px-3 py-1 bg-transparent hover:bg-[#353535] text-[#d5c4ab] hover:text-[#e5e2e1] rounded-md text-xs transition-colors flex items-center space-x-1 cursor-pointer"
            >
              <span className="material-symbols-outlined text-sm">filter_alt_off</span>
              <span>Filtreleri Temizle</span>
            </button>
          </div>
        </div>

      </div>

      {/* SECTION 6.2 Tablo */}
      <div className={`bg-[#1c1b1b] border border-[#514532]/25 rounded-xl p-6 space-y-4 overflow-hidden transition-opacity ${isPlaceholderData ? 'opacity-60' : 'opacity-100'}`}>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse" data-testid="transactions-table" data-density={isCompactDensity ? 'compact' : 'comfortable'}>
            <thead>
              <tr className="border-b border-[#514532]/30 text-[#d5c4ab] uppercase text-[10px] tracking-wider font-mono">
                <SortableHeader column="created_at" label="Tarih & Saat" sortBy={sortBy} sortDir={sortDir} onSort={handleSortClick} />
                <SortableHeader column="site_name" label="Şantiye" sortBy={sortBy} sortDir={sortDir} onSort={handleSortClick} />
                <SortableHeader column="vehicle_plate" label="Araç Plakası" sortBy={sortBy} sortDir={sortDir} onSort={handleSortClick} />
                <SortableHeader column="driver_name" label="Şoför" sortBy={sortBy} sortDir={sortDir} onSort={handleSortClick} />
                <SortableHeader column="tank_name" label="Çekilen Tank" sortBy={sortBy} sortDir={sortDir} onSort={handleSortClick} />
                <th className="py-3.5 px-4">Debi Hızı</th>
                <SortableHeader column="type" label="İkmal Tipi" sortBy={sortBy} sortDir={sortDir} onSort={handleSortClick} />
                <SortableHeader column="pump_status" label="Pompa Durumu" sortBy={sortBy} sortDir={sortDir} onSort={handleSortClick} />
                <SortableHeader column="amount_liters" label="Alınan Miktar" sortBy={sortBy} sortDir={sortDir} onSort={handleSortClick} align="right" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[#514532]/20 font-mono">
              {isLoading && (
                <tr>
                  <td colSpan={9} className="py-4"><ListSkeleton rows={6} columns={9} testId="transactions-skeleton" /></td>
                </tr>
              )}

              {isError && !isLoading && (
                <tr>
                  <td colSpan={9} className="py-4"><ErrorState error={error} onRetry={() => refetch()} testId="transactions-error" /></td>
                </tr>
              )}

              {!isLoading && !isError && transactions.map(t => {
                const cellPad = isCompactDensity ? 'py-1.5 px-4' : 'py-3.5 px-4';
                const isExpanded = expandedRowId === t.id;
                return (
                  <React.Fragment key={t.id}>
                    <tr
                      data-testid="transaction-row"
                      onClick={() => handleToggleRowDetail(t.id)}
                      className={`hover:bg-[#20201f] transition-colors cursor-pointer ${isExpanded ? 'bg-[#20201f]' : ''}`}
                    >
                      <td className={`${cellPad} text-[#d5c4ab]`}>{t.timestamp}</td>
                      <td className={`${cellPad} font-bold text-[#e5e2e1]`}>{t.siteName}</td>
                      <td className={`${cellPad} font-black text-[#ffdca1] text-sm`}>{t.vehiclePlate}</td>
                      <td className={`${cellPad} text-[#e5e2e1]`}>{t.driverName}</td>
                      <td className={`${cellPad} text-[#d5c4ab]`}>{t.tankName}</td>
                      <td className={`${cellPad} text-[#a1e8a2]`}>{t.flowRateLpm} L/dk</td>
                      <td className={cellPad}>
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-[#20201f] text-[#d5c4ab] border border-[#514532]/30">
                          {t.type}
                        </span>
                      </td>
                      <td className={cellPad}>
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
                      <td className={`${cellPad} text-right font-black text-[#e5e2e1] text-sm`}>
                        {t.amountLiters.toLocaleString('tr-TR')} Litre
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr data-testid="transaction-row-detail">
                        <td colSpan={9} className="bg-[#131313] px-6 py-4">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                            <div>
                              <span className="text-[10px] font-mono font-bold text-[#d5c4ab] uppercase block mb-1">E-İrsaliye Durumu</span>
                              {despatchStatus === 'loading' ? (
                                <span className="text-[#d5c4ab] inline-flex items-center gap-2">
                                  <span className="w-3 h-3 border-2 border-[#ffdca1] border-t-transparent rounded-full animate-spin" /> Yükleniyor...
                                </span>
                              ) : despatchStatus === 'forbidden' ? (
                                <span className="text-[#d5c4ab]/70" data-testid="despatch-status-forbidden">Bu bilgiyi görüntüleme yetkiniz yok.</span>
                              ) : despatchStatus === null ? (
                                <span className="text-[#d5c4ab]/70" data-testid="despatch-status-none">Bu ikmal için henüz e-İrsaliye oluşturulmadı.</span>
                              ) : (
                                <div className="space-y-1" data-testid="despatch-status-value">
                                  <p className="text-[#e5e2e1] font-bold">{despatchStatus.documentNumber} — {despatchStatus.status}</p>
                                  {despatchStatus.rejectReason && <p className="text-[#ffb4ab]">Red sebebi: {despatchStatus.rejectReason}</p>}
                                  {despatchStatus.cancelReason && <p className="text-[#ffb4ab]">İptal sebebi: {despatchStatus.cancelReason}</p>}
                                </div>
                              )}
                            </div>
                            <div>
                              <span className="text-[10px] font-mono font-bold text-[#d5c4ab] uppercase block mb-1">Telemetri Grafiği</span>
                              {/* KAPSAM UYARLAMASI (disclosed): backend'de bu ikmale ait bir
                                  zaman serisi (ör. debi örneklemesi) hiç SAKLANMIYOR — schema.sql'de
                                  telemetry/sample tablosu yok, telemetry:data Socket.io olayı
                                  canlı/geçici, kalıcı değil. Araştırıldı; sahte veriyle grafik
                                  göstermek yerine durum açıkça bildiriliyor. */}
                              <span className="text-[#d5c4ab]/70" data-testid="telemetry-chart-unavailable">
                                Bu ikmal için geçmişe dönük telemetri örneklemesi saklanmıyor (yalnızca anlık canlı veri yayınlanır, kalıcı değildir) — grafik gösterilemiyor.
                              </span>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}

              {!isLoading && !isError && transactions.length === 0 && (
                <tr>
                  <td colSpan={9}><EmptyState icon="receipt_long" title="Filtre kriterlerine uygun yakıt hareketi bulunamadı." testId="transactions-empty" /></td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination controls */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between pt-4 border-t border-[#514532]/20 font-mono text-xs">
            <span className="text-[#d5c4ab]">
              Sayfa {currentPage} / {totalPages} (Toplam {totalCount} Kayıt)
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
                disabled={currentPage === totalPages || isPlaceholderData}
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
