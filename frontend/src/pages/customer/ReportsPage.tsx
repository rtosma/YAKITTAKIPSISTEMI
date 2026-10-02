import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { ResponsiveContainer, LineChart, Line, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import { useApp } from '../../context/AppContext';
import { downloadAuthenticatedFile } from '../../utils/api';
import { fetchTenantUsers } from '../../hooks/useAlarms';
import {
  fetchReportCatalog, fetchReport, reportExportEndpoint, fetchExecutiveDashboard,
  fetchReportSchedules, createReportSchedule, updateReportSchedule, deleteReportSchedule, fetchReportDeliveries,
  REPORT_SCHEDULE_PERIOD_LABELS, REPORT_DELIVERY_STATUS_LABELS, dayOfWeekLabel
} from '../../hooks/useReports';
import {
  ReportCatalogEntry, ReportRunResult, ExecutiveDashboard, DashboardDrilldown, DashboardKpi, ReportSchedule, ReportDelivery,
  ReportSchedulePeriod, TenantUser
} from '../../types';

/**
 * FE-816 — Rapor Merkezi (katalog, filtre, indirme, zamanlama, yönetici özeti).
 *
 * Backend (REP-703 ortak rapor çatısı: GET /reports, GET /reports/:id,
 * GET /reports/:id/export; REP-705 zamanlanmış gönderim: /report-schedules*;
 * REP-723 yönetici özet dashboard'u: GET /dashboard/executive) ZATEN TAMDI —
 * önceden frontend/src/pages altında "rapor" geçen tek şey TransactionsPage'in
 * tek bir bespoke rep-711 CSV/PDF export butonuydu. Bu sayfa 27 kayıtlı
 * rapor tanımının TAMAMINI (katalog + ortak filtre motoru) ve REP-705/723'ün
 * önceden HİÇ frontend'i olmayan zamanlama/dashboard uçlarını kapsar.
 *
 * BİLİNÇLİ KAPSAM KARARI — "Arka planda üretilen rapor hazır olduğunda
 * bildirim gelmelidir": bu kod tabanında (FE-812'nin aynı AC için verdiği
 * kararla AYNI) hiçbir arka plan iş kuyruğu/job altyapısı yok (BullMQ yok,
 * job tablosu yok, 6. bir bildirim şablonu yok — bkz. notifications/
 * templateRegistry.ts'in 5 GERÇEK tipi). Tüm JSON/CSV/PDF/XLSX üretimi tek
 * bir HTTP isteği içinde SENKRON çalışır; sahte bir "iş kuyruğu" polling'i
 * icat etmek yerine engelleyici/spinner UX kullanılır (handleExport).
 *
 * BİLİNÇLİ KAPSAM KARARI — Rapor Merkezi'nin tamamı (katalog, filtre,
 * zamanlama, dashboard) /panel altında (yalnızca SUPER_ADMIN/COMPANY_OWNER,
 * bkz. ROLE_GROUPS.PANEL) kurulu — SITE_MANAGER'ın gerçek paneli
 * /santiye-panel'dir ve ORADA ZATEN rep-711'in kendi CSV export butonu var
 * (SiteOperatorPanel.tsx) — bu "S" efor biletinde 27 raporluk tam katalog
 * UI'sini mobil-öncelikli saha paneline de taşımak orantısız olurdu.
 */

// Okabe-Ito renk körlüğüne uygun kategorik palet (dashboard AC'si: "renk
// körlüğüne uygun palet") — bu kod tabanında önceden hiç çok-serili bir
// grafik yoktu (OverviewPage'in tek serisi tek sabit renk kullanıyordu).
const PALETTE = { consumption: '#56B4E9', stock: '#009E73', cost: '#E69F00' };

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return value.toLocaleString('tr-TR', { maximumFractionDigits: 2 });
  if (typeof value === 'boolean') return value ? 'Evet' : 'Hayır';
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toLocaleString('tr-TR');
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString('tr-TR');
  }
  return s;
}

function formatDateTick(ymd: string): string {
  const parts = ymd.split('-');
  return parts.length === 3 ? `${parts[2]}.${parts[1]}` : ymd;
}

type ReportTab = 'dashboard' | 'catalog' | 'schedules';

export const ReportsPage: React.FC = () => {
  const { showToast } = useApp();
  const [activeTab, setActiveTab] = useState<ReportTab>('dashboard');

  // ── Katalog (tüm raporlar için paylaşılan) ──
  const [catalog, setCatalog] = useState<ReportCatalogEntry[]>([]);
  const [isLoadingCatalog, setIsLoadingCatalog] = useState(true);
  const catalogById = useMemo(() => new Map(catalog.map((r) => [r.id, r])), [catalog]);

  useEffect(() => {
    fetchReportCatalog()
      .then(setCatalog)
      .catch((err) => showToast(err.message || 'Rapor kataloğu yüklenemedi.', 'error'))
      .finally(() => setIsLoadingCatalog(false));
  }, []);

  // ── Dashboard (REP-723) ──
  const [dashboardDays, setDashboardDays] = useState(30);
  const [dashboard, setDashboard] = useState<ExecutiveDashboard | null>(null);
  const [isLoadingDashboard, setIsLoadingDashboard] = useState(true);

  const loadDashboard = useCallback((days: number) => {
    setIsLoadingDashboard(true);
    fetchExecutiveDashboard(days)
      .then(setDashboard)
      .catch((err) => showToast(err.message || 'Yönetici özeti yüklenemedi.', 'error'))
      .finally(() => setIsLoadingDashboard(false));
  }, []);

  useEffect(() => { loadDashboard(dashboardDays); }, [dashboardDays, loadDashboard]);

  const trendChartData = useMemo(() => {
    if (!dashboard) return [];
    const map = new Map<string, { date: string; Tüketim?: number; Stok?: number }>();
    dashboard.trends.dailyConsumption.forEach((r) => map.set(r.date, { date: r.date, Tüketim: r.liters }));
    dashboard.trends.stockLevel.forEach((r) => {
      const existing: { date: string; Tüketim?: number; Stok?: number } = map.get(r.date) ?? { date: r.date };
      existing.Stok = r.liters;
      map.set(r.date, existing);
    });
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [dashboard]);

  const costChartData = useMemo(
    () => dashboard?.trends.dailyCost.map((r) => ({ date: r.date, Maliyet: r.cost })) ?? [],
    [dashboard]
  );

  // ── Rapor çalıştırma (katalog sekmesi) ──
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const selectedReport = selectedReportId ? catalogById.get(selectedReportId) : undefined;
  const [catalogSearch, setCatalogSearch] = useState('');
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [runResult, setRunResult] = useState<ReportRunResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ sortBy?: string; sortDir?: 'asc' | 'desc' }>({});
  const [exportingFormat, setExportingFormat] = useState<string | null>(null);

  const runSelectedReport = useCallback((reportId: string, filters: Record<string, string>, pageArg: number, sortArg: typeof sort) => {
    setIsRunning(true);
    setRunError(null);
    fetchReport(reportId, { page: pageArg, pageSize: 20, sortBy: sortArg.sortBy, sortDir: sortArg.sortDir, filters })
      .then(setRunResult)
      .catch((err) => { setRunResult(null); setRunError(err.message || 'Rapor çalıştırılamadı.'); })
      .finally(() => setIsRunning(false));
  }, []);

  const selectReport = (reportId: string, prefillFilters: Record<string, string> = {}) => {
    setSelectedReportId(reportId);
    setFilterValues(prefillFilters);
    setPage(1);
    setSort({});
    setRunResult(null);
    runSelectedReport(reportId, prefillFilters, 1, {});
  };

  const openDrilldown = (d: DashboardDrilldown) => {
    setActiveTab('catalog');
    selectReport(d.reportId, d.query);
  };

  const handleFilterSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedReportId) return;
    setPage(1);
    runSelectedReport(selectedReportId, filterValues, 1, sort);
  };

  const handleSortClick = (columnKey: string) => {
    if (!selectedReportId) return;
    const nextDir: 'asc' | 'desc' = sort.sortBy === columnKey && sort.sortDir === 'asc' ? 'desc' : 'asc';
    const nextSort = { sortBy: columnKey, sortDir: nextDir };
    setSort(nextSort);
    runSelectedReport(selectedReportId, filterValues, page, nextSort);
  };

  const handlePageChange = (nextPage: number) => {
    if (!selectedReportId) return;
    setPage(nextPage);
    runSelectedReport(selectedReportId, filterValues, nextPage, sort);
  };

  const handleExport = async (format: 'csv' | 'pdf' | 'xlsx') => {
    if (!selectedReportId || !selectedReport) return;
    setExportingFormat(format);
    try {
      const endpoint = reportExportEndpoint(selectedReportId, format, filterValues);
      await downloadAuthenticatedFile(endpoint, `${selectedReport.id}-${new Date().toISOString().slice(0, 10)}.${format}`);
      showToast(`${format.toUpperCase()} dosyası indirildi.`, 'success');
    } catch (err: any) {
      showToast(err.message || 'Dosya indirilemedi.', 'error');
    } finally {
      setExportingFormat(null);
    }
  };

  const filteredCatalog = useMemo(() => {
    const q = catalogSearch.trim().toLocaleLowerCase('tr-TR');
    if (!q) return catalog;
    return catalog.filter((r) => r.title.toLocaleLowerCase('tr-TR').includes(q) || r.description.toLocaleLowerCase('tr-TR').includes(q));
  }, [catalog, catalogSearch]);

  // ── Zamanlanmış raporlar (REP-705) ──
  const [schedules, setSchedules] = useState<ReportSchedule[]>([]);
  const [isLoadingSchedules, setIsLoadingSchedules] = useState(false);
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [expandedScheduleId, setExpandedScheduleId] = useState<string | null>(null);
  const [deliveriesByScheduleId, setDeliveriesByScheduleId] = useState<Record<string, ReportDelivery[]>>({});
  const [isSavingSchedule, setIsSavingSchedule] = useState(false);

  const [newScheduleReportId, setNewScheduleReportId] = useState('');
  const [newSchedulePeriod, setNewSchedulePeriod] = useState<ReportSchedulePeriod>('DAILY');
  const [newScheduleHour, setNewScheduleHour] = useState(7);
  const [newScheduleDayOfWeek, setNewScheduleDayOfWeek] = useState(1);
  const [newScheduleDayOfMonth, setNewScheduleDayOfMonth] = useState(1);
  const [newScheduleRecipients, setNewScheduleRecipients] = useState<string[]>([]);
  const [newScheduleSkipIfEmpty, setNewScheduleSkipIfEmpty] = useState(true);

  const loadSchedules = useCallback(() => {
    setIsLoadingSchedules(true);
    fetchReportSchedules()
      .then(setSchedules)
      .catch((err) => showToast(err.message || 'Zamanlamalar yüklenemedi.', 'error'))
      .finally(() => setIsLoadingSchedules(false));
  }, []);

  useEffect(() => {
    if (activeTab !== 'schedules') return;
    loadSchedules();
    if (users.length === 0) {
      fetchTenantUsers().then(setUsers).catch(() => { /* kullanıcı listesi opsiyonel yardımcı, sessiz geç */ });
    }
  }, [activeTab, loadSchedules, users.length]);

  const toggleRecipient = (userId: string) => {
    setNewScheduleRecipients((prev) => (prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]));
  };

  const handleCreateSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newScheduleReportId || newScheduleRecipients.length === 0) {
      showToast('Rapor ve en az bir alıcı seçmelisiniz.', 'warning');
      return;
    }
    setIsSavingSchedule(true);
    try {
      await createReportSchedule({
        reportId: newScheduleReportId,
        periodType: newSchedulePeriod,
        sendHourLocal: newScheduleHour,
        dayOfWeek: newSchedulePeriod === 'WEEKLY' ? newScheduleDayOfWeek : undefined,
        dayOfMonth: newSchedulePeriod === 'MONTHLY' ? newScheduleDayOfMonth : undefined,
        recipientUserIds: newScheduleRecipients,
        skipIfEmpty: newScheduleSkipIfEmpty
      });
      showToast('Zamanlanmış rapor oluşturuldu.', 'success');
      setNewScheduleReportId('');
      setNewScheduleRecipients([]);
      loadSchedules();
    } catch (err: any) {
      showToast(err.message || 'Zamanlama oluşturulamadı.', 'error');
    } finally {
      setIsSavingSchedule(false);
    }
  };

  const handleToggleEnabled = async (schedule: ReportSchedule) => {
    try {
      await updateReportSchedule(schedule.id, { enabled: !schedule.enabled });
      loadSchedules();
    } catch (err: any) {
      showToast(err.message || 'Zamanlama güncellenemedi.', 'error');
    }
  };

  const handleDeleteSchedule = async (id: string) => {
    if (!window.confirm('Bu zamanlanmış raporu silmek istediğinize emin misiniz?')) return;
    try {
      await deleteReportSchedule(id);
      showToast('Zamanlama silindi.', 'success');
      loadSchedules();
    } catch (err: any) {
      showToast(err.message || 'Zamanlama silinemedi.', 'error');
    }
  };

  const handleExpandDeliveries = (scheduleId: string) => {
    if (expandedScheduleId === scheduleId) { setExpandedScheduleId(null); return; }
    setExpandedScheduleId(scheduleId);
    if (!deliveriesByScheduleId[scheduleId]) {
      fetchReportDeliveries(scheduleId)
        .then((rows) => setDeliveriesByScheduleId((prev) => ({ ...prev, [scheduleId]: rows })))
        .catch((err) => showToast(err.message || 'Gönderim geçmişi yüklenemedi.', 'error'));
    }
  };

  const TABS: Array<{ id: ReportTab; label: string; icon: string }> = [
    { id: 'dashboard', label: 'Yönetici Özeti', icon: 'insights' },
    { id: 'catalog', label: 'Rapor Kataloğu', icon: 'summarize' },
    { id: 'schedules', label: 'Zamanlanmış Raporlar', icon: 'schedule_send' }
  ];

  return (
    <div className="space-y-6" data-testid="reports-page">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 bg-[#1c1b1b] border border-[#353535] p-6 rounded-2xl">
        <div>
          <span className="text-[10px] font-mono text-[#ffdca1] font-bold uppercase tracking-widest">RAPOR MERKEZİ</span>
          <h2 className="text-xl font-extrabold text-[#e5e2e1] uppercase tracking-tight mt-0.5">13 Rapor, Tek Yerden Filtre ve İndirme</h2>
          <p className="text-xs text-[#d5c4ab] mt-1">Yönetici özeti, tüm raporların kataloğu ve zamanlanmış gönderimler</p>
        </div>
        <div className="flex gap-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              data-testid={`reports-tab-${t.id}`}
              onClick={() => setActiveTab(t.id)}
              className={`px-4 py-2.5 rounded-xl text-xs font-black flex items-center gap-2 transition-colors ${
                activeTab === t.id ? 'bg-[#ffdca1] text-[#412d00]' : 'bg-[#20201f] text-[#d5c4ab] hover:text-[#e5e2e1]'
              }`}
            >
              <span className="material-symbols-outlined text-lg">{t.icon}</span>
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'dashboard' && (
        <div className="space-y-6" data-testid="dashboard-panel">
          <div className="flex items-center justify-end gap-2">
            <span className="text-xs text-[#d5c4ab]">Pencere:</span>
            {[7, 30, 90].map((d) => (
              <button
                key={d}
                data-testid={`dashboard-days-${d}`}
                onClick={() => setDashboardDays(d)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold ${dashboardDays === d ? 'bg-[#ffdca1] text-[#412d00]' : 'bg-[#20201f] text-[#d5c4ab]'}`}
              >
                {d} gün
              </button>
            ))}
          </div>

          {isLoadingDashboard && <p className="text-xs text-[#d5c4ab]">Yükleniyor…</p>}

          {dashboard && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-4">
                {(Object.entries(dashboard.kpis) as Array<[string, DashboardKpi]>).map(([key, kpi]) => (
                  <button
                    key={key}
                    data-testid={`kpi-${key}`}
                    onClick={() => openDrilldown(kpi.drilldown)}
                    className="text-left bg-[#1c1b1b] border border-[#353535] rounded-2xl p-4 space-y-1 hover:border-[#ffdca1] transition-colors"
                  >
                    <span className="text-[10px] text-[#d5c4ab] uppercase tracking-wider font-bold">{kpi.label}</span>
                    <div className="text-xl font-extrabold font-mono text-[#e5e2e1]">
                      {kpi.value.toLocaleString('tr-TR')} <span className="text-xs text-[#d5c4ab]">{kpi.unit}</span>
                    </div>
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 space-y-4">
                  <h3 className="text-sm font-extrabold text-[#e5e2e1] uppercase">Günlük Tüketim & Stok Trendi</h3>
                  <div className="h-64 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={trendChartData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#353535" vertical={false} />
                        <XAxis dataKey="date" tickFormatter={formatDateTick} stroke="#d5c4ab" fontSize={11} tickLine={false} />
                        <YAxis stroke="#d5c4ab" fontSize={11} tickLine={false} />
                        <Tooltip contentStyle={{ backgroundColor: '#131313', borderColor: '#353535', borderRadius: '12px', fontSize: '12px' }} />
                        <Legend wrapperStyle={{ fontSize: '11px' }} />
                        <Line type="monotone" dataKey="Tüketim" stroke={PALETTE.consumption} strokeWidth={2} dot={false} />
                        <Line type="monotone" dataKey="Stok" stroke={PALETTE.stock} strokeWidth={2} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 space-y-4">
                  <h3 className="text-sm font-extrabold text-[#e5e2e1] uppercase">Günlük Maliyet</h3>
                  <div className="h-64 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={costChartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                        <defs>
                          <linearGradient id="costGlow" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={PALETTE.cost} stopOpacity={0.3} />
                            <stop offset="95%" stopColor={PALETTE.cost} stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#353535" vertical={false} />
                        <XAxis dataKey="date" tickFormatter={formatDateTick} stroke="#d5c4ab" fontSize={11} tickLine={false} />
                        <YAxis stroke="#d5c4ab" fontSize={11} tickLine={false} />
                        <Tooltip contentStyle={{ backgroundColor: '#131313', borderColor: '#353535', borderRadius: '12px', fontSize: '12px' }} />
                        <Area type="monotone" dataKey="Maliyet" stroke={PALETTE.cost} strokeWidth={2} fillOpacity={1} fill="url(#costGlow)" />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 space-y-3">
                  <h3 className="text-sm font-extrabold text-[#e5e2e1] uppercase">İlk 10 Araç</h3>
                  <table className="w-full text-left text-xs">
                    <tbody className="divide-y divide-[#353535]">
                      {dashboard.topVehicles.map((v) => (
                        <tr key={v.vehiclePlate} data-testid="top-vehicle-row" className="hover:bg-[#282726] cursor-pointer" onClick={() => openDrilldown(v.drilldown)}>
                          <td className="py-2 font-black text-[#ffdca1]">{v.vehiclePlate}</td>
                          <td className="py-2 text-right font-mono text-[#e5e2e1]">{v.liters.toLocaleString('tr-TR')} L</td>
                          <td className="py-2 text-right font-mono text-[#d5c4ab]">{v.transactions} ikmal</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 space-y-3">
                  <h3 className="text-sm font-extrabold text-[#e5e2e1] uppercase">Tank Doluluk Özeti</h3>
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {dashboard.tanks.map((t) => (
                      <div key={t.id} className="flex items-center justify-between text-xs">
                        <span className={`font-bold ${t.isCritical ? 'text-[#ffb4ab]' : 'text-[#e5e2e1]'}`}>{t.tankName} ({t.siteName})</span>
                        <span className="font-mono text-[#d5c4ab]">{t.fillPct === null ? '—' : `%${t.fillPct.toFixed(0)}`}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="flex gap-3">
                <button data-testid="dashboard-export-csv" onClick={() => downloadAuthenticatedFile(dashboard.exports.csv, `yonetici-ozeti-${new Date().toISOString().slice(0, 10)}.csv`).then(() => showToast('CSV indirildi.', 'success')).catch((e) => showToast(e.message, 'error'))} className="px-4 py-2 bg-[#20201f] text-[#d5c4ab] rounded-xl text-xs font-bold hover:text-[#e5e2e1]">CSV İndir</button>
                <button data-testid="dashboard-export-pdf" onClick={() => downloadAuthenticatedFile(dashboard.exports.pdf, `yonetici-ozeti-${new Date().toISOString().slice(0, 10)}.pdf`).then(() => showToast('PDF indirildi.', 'success')).catch((e) => showToast(e.message, 'error'))} className="px-4 py-2 bg-[#20201f] text-[#d5c4ab] rounded-xl text-xs font-bold hover:text-[#e5e2e1]">PDF İndir</button>
              </div>
            </>
          )}
        </div>
      )}

      {activeTab === 'catalog' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6" data-testid="catalog-panel">
          <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-4 space-y-3 h-fit">
            <input
              type="text"
              value={catalogSearch}
              onChange={(e) => setCatalogSearch(e.target.value)}
              placeholder="Rapor ara…"
              data-testid="catalog-search"
              className="w-full bg-[#131313] border border-[#353535] text-[#e5e2e1] text-xs rounded-xl p-3 focus:outline-none focus:border-[#ffdca1]"
            />
            {isLoadingCatalog && <p className="text-xs text-[#d5c4ab]">Yükleniyor…</p>}
            <div className="space-y-2 max-h-[600px] overflow-y-auto">
              {filteredCatalog.map((r) => (
                <button
                  key={r.id}
                  data-testid="catalog-report-card"
                  data-report-id={r.id}
                  onClick={() => selectReport(r.id)}
                  className={`w-full text-left p-3 rounded-xl border transition-colors ${
                    selectedReportId === r.id ? 'border-[#ffdca1] bg-[#282726]' : 'border-[#353535] hover:bg-[#282726]'
                  }`}
                >
                  <div className="text-xs font-bold text-[#e5e2e1]">{r.title}</div>
                  <div className="text-[10px] text-[#d5c4ab] mt-0.5 line-clamp-2">{r.description}</div>
                </button>
              ))}
              {!isLoadingCatalog && filteredCatalog.length === 0 && <p className="text-xs text-[#d5c4ab]">Yetkili olduğunuz rapor bulunamadı.</p>}
            </div>
          </div>

          <div className="lg:col-span-2 space-y-4">
            {!selectedReport && (
              <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-10 text-center text-xs text-[#d5c4ab]">
                Soldan bir rapor seçin.
              </div>
            )}

            {selectedReport && (
              <>
                <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 space-y-4">
                  <h3 className="text-sm font-extrabold text-[#e5e2e1] uppercase">{selectedReport.title}</h3>
                  <form onSubmit={handleFilterSubmit} className="grid grid-cols-2 md:grid-cols-3 gap-3" data-testid="report-filter-form">
                    {selectedReport.filters.map((f) => (
                      <div key={f.key}>
                        <label className="text-[10px] text-[#d5c4ab] block mb-1">{f.label}</label>
                        <input
                          type={f.type === 'dateFrom' || f.type === 'dateToExclusiveNextDay' ? 'date' : f.type === 'numberGte' || f.type === 'numberLte' ? 'number' : 'text'}
                          data-testid={`report-filter-${f.key}`}
                          value={filterValues[f.key] ?? ''}
                          onChange={(e) => setFilterValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
                          placeholder={f.type === 'in' ? 'virgülle ayırın' : f.type === 'ilike' ? 'içerir…' : undefined}
                          className="w-full bg-[#131313] border border-[#353535] text-[#e5e2e1] text-xs rounded-lg p-2 focus:outline-none focus:border-[#ffdca1]"
                        />
                      </div>
                    ))}
                    <div className="flex items-end">
                      <button type="submit" data-testid="report-filter-apply" disabled={isRunning} className="px-4 py-2 bg-[#ffdca1] text-[#412d00] rounded-xl text-xs font-black disabled:opacity-60">
                        {isRunning ? 'Yükleniyor…' : 'Filtrele'}
                      </button>
                    </div>
                  </form>

                  <div className="flex gap-2 pt-2 border-t border-[#353535]">
                    {(['csv', 'pdf', 'xlsx'] as const).map((fmt) => (
                      <button
                        key={fmt}
                        data-testid={`report-export-${fmt}`}
                        onClick={() => handleExport(fmt)}
                        disabled={exportingFormat !== null}
                        className="px-4 py-2 bg-[#20201f] text-[#d5c4ab] rounded-xl text-xs font-bold hover:text-[#e5e2e1] disabled:opacity-60"
                      >
                        {exportingFormat === fmt ? 'İndiriliyor…' : `${fmt.toUpperCase()} İndir`}
                      </button>
                    ))}
                  </div>
                </div>

                {runError && <div className="bg-[#1c1b1b] border border-[#ffb4ab] rounded-2xl p-4 text-xs text-[#ffb4ab]" data-testid="report-run-error">{runError}</div>}

                {runResult && (
                  <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 space-y-4">
                    {Object.keys(runResult.aggregates).length > 0 && (
                      <div className="flex gap-4 flex-wrap text-xs font-mono text-[#d5c4ab]" data-testid="report-aggregates">
                        {Object.entries(runResult.aggregates).map(([k, v]) => (
                          <span key={k}>{k}: <strong className="text-[#e5e2e1]">{formatCell(v)}</strong></span>
                        ))}
                      </div>
                    )}
                    <div className="overflow-x-auto rounded-xl border border-[#353535]">
                      <table className="w-full text-left text-xs border-collapse" data-testid="report-preview-table">
                        <thead>
                          <tr className="bg-[#131313] border-b border-[#353535] text-[#d5c4ab] uppercase text-[10px] tracking-wider font-mono">
                            {selectedReport.columns.map((c) => (
                              <th key={c.key} className="py-3 px-3 cursor-pointer select-none" onClick={() => handleSortClick(c.key)}>
                                {c.header}{sort.sortBy === c.key ? (sort.sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#353535] font-mono">
                          {runResult.data.map((row, idx) => (
                            <tr key={idx} data-testid="report-row" className="hover:bg-[#282726]">
                              {selectedReport.columns.map((c) => (
                                <td key={c.key} className="py-2.5 px-3 text-[#e5e2e1]">{formatCell(row[c.key])}</td>
                              ))}
                            </tr>
                          ))}
                          {runResult.data.length === 0 && (
                            <tr><td colSpan={selectedReport.columns.length} className="py-6 text-center text-[#d5c4ab]">Kayıt bulunamadı.</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                    <div className="flex items-center justify-between text-xs text-[#d5c4ab]">
                      <span>Toplam {runResult.pagination.totalCount} kayıt</span>
                      <div className="flex items-center gap-2">
                        <button data-testid="report-page-prev" disabled={page <= 1} onClick={() => handlePageChange(page - 1)} className="px-3 py-1.5 bg-[#20201f] rounded-lg disabled:opacity-40">Önceki</button>
                        <span>Sayfa {runResult.pagination.page} / {Math.max(1, runResult.pagination.totalPages)}</span>
                        <button data-testid="report-page-next" disabled={page >= runResult.pagination.totalPages} onClick={() => handlePageChange(page + 1)} className="px-3 py-1.5 bg-[#20201f] rounded-lg disabled:opacity-40">Sonraki</button>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {activeTab === 'schedules' && (
        <div className="space-y-6" data-testid="schedules-panel">
          <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 space-y-4">
            <h3 className="text-sm font-extrabold text-[#e5e2e1] uppercase">Yeni Zamanlama</h3>
            <form onSubmit={handleCreateSchedule} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div>
                  <label className="text-[10px] text-[#d5c4ab] block mb-1">Rapor</label>
                  <select data-testid="schedule-report-select" value={newScheduleReportId} onChange={(e) => setNewScheduleReportId(e.target.value)} className="w-full bg-[#131313] border border-[#353535] text-[#e5e2e1] text-xs rounded-lg p-2">
                    <option value="">Seçin…</option>
                    {catalog.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-[#d5c4ab] block mb-1">Periyot</label>
                  <select data-testid="schedule-period-select" value={newSchedulePeriod} onChange={(e) => setNewSchedulePeriod(e.target.value as ReportSchedulePeriod)} className="w-full bg-[#131313] border border-[#353535] text-[#e5e2e1] text-xs rounded-lg p-2">
                    {(['DAILY', 'WEEKLY', 'MONTHLY'] as const).map((p) => <option key={p} value={p}>{REPORT_SCHEDULE_PERIOD_LABELS[p]}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-[#d5c4ab] block mb-1">Saat (0-23, Europe/Istanbul)</label>
                  <input type="number" min={0} max={23} data-testid="schedule-hour-input" value={newScheduleHour} onChange={(e) => setNewScheduleHour(Number(e.target.value))} className="w-full bg-[#131313] border border-[#353535] text-[#e5e2e1] text-xs rounded-lg p-2" />
                </div>
                {newSchedulePeriod === 'WEEKLY' && (
                  <div>
                    <label className="text-[10px] text-[#d5c4ab] block mb-1">Gün</label>
                    <select data-testid="schedule-day-of-week-select" value={newScheduleDayOfWeek} onChange={(e) => setNewScheduleDayOfWeek(Number(e.target.value))} className="w-full bg-[#131313] border border-[#353535] text-[#e5e2e1] text-xs rounded-lg p-2">
                      {[0, 1, 2, 3, 4, 5, 6].map((d) => <option key={d} value={d}>{dayOfWeekLabel(d)}</option>)}
                    </select>
                  </div>
                )}
                {newSchedulePeriod === 'MONTHLY' && (
                  <div>
                    <label className="text-[10px] text-[#d5c4ab] block mb-1">Ayın Günü (1-28)</label>
                    <input type="number" min={1} max={28} data-testid="schedule-day-of-month-input" value={newScheduleDayOfMonth} onChange={(e) => setNewScheduleDayOfMonth(Number(e.target.value))} className="w-full bg-[#131313] border border-[#353535] text-[#e5e2e1] text-xs rounded-lg p-2" />
                  </div>
                )}
              </div>

              <div>
                <label className="text-[10px] text-[#d5c4ab] block mb-1">Alıcılar</label>
                <div className="flex flex-wrap gap-2" data-testid="schedule-recipients">
                  {users.map((u) => (
                    <label key={u.id} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs cursor-pointer ${newScheduleRecipients.includes(u.id) ? 'border-[#ffdca1] bg-[#282726] text-[#e5e2e1]' : 'border-[#353535] text-[#d5c4ab]'}`}>
                      <input type="checkbox" className="hidden" checked={newScheduleRecipients.includes(u.id)} onChange={() => toggleRecipient(u.id)} />
                      {u.username} ({u.role})
                    </label>
                  ))}
                  {users.length === 0 && <span className="text-xs text-[#d5c4ab]">Kullanıcı listesi yükleniyor…</span>}
                </div>
              </div>

              <label className="flex items-center gap-2 text-xs text-[#d5c4ab]">
                <input type="checkbox" checked={newScheduleSkipIfEmpty} onChange={(e) => setNewScheduleSkipIfEmpty(e.target.checked)} data-testid="schedule-skip-if-empty" />
                Boş raporda gönderim yapılmasın
              </label>

              <button type="submit" disabled={isSavingSchedule} data-testid="schedule-create-submit" className="px-5 py-2.5 bg-[#ffdca1] text-[#412d00] rounded-xl text-xs font-black disabled:opacity-60">
                {isSavingSchedule ? 'Oluşturuluyor…' : 'Zamanlamayı Oluştur'}
              </button>
            </form>
          </div>

          <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 space-y-3">
            <h3 className="text-sm font-extrabold text-[#e5e2e1] uppercase">Mevcut Zamanlamalar</h3>
            {isLoadingSchedules && <p className="text-xs text-[#d5c4ab]">Yükleniyor…</p>}
            <div className="space-y-2">
              {schedules.map((s) => (
                <div key={s.id} data-testid="schedule-row" className="border border-[#353535] rounded-xl">
                  <div className="flex items-center justify-between p-3 text-xs">
                    <div>
                      <div className="font-bold text-[#e5e2e1]">{catalogById.get(s.reportId)?.title ?? s.reportId}</div>
                      <div className="text-[#d5c4ab] font-mono mt-0.5">
                        {REPORT_SCHEDULE_PERIOD_LABELS[s.periodType]} · Saat {s.sendHourLocal}:00
                        {s.dayOfWeek !== null ? ` · ${dayOfWeekLabel(s.dayOfWeek)}` : ''}
                        {s.dayOfMonth !== null ? ` · Ayın ${s.dayOfMonth}. günü` : ''}
                        {' · '}Sonraki: {new Date(s.nextRunAt).toLocaleString('tr-TR')}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button data-testid="schedule-toggle-enabled" onClick={() => handleToggleEnabled(s)} className={`px-3 py-1.5 rounded-lg font-bold ${s.enabled ? 'bg-[#a1e8a2]/10 text-[#a1e8a2]' : 'bg-[#20201f] text-[#d5c4ab]'}`}>
                        {s.enabled ? 'Etkin' : 'Devre Dışı'}
                      </button>
                      <button data-testid="schedule-expand-deliveries" onClick={() => handleExpandDeliveries(s.id)} className="px-3 py-1.5 bg-[#20201f] text-[#d5c4ab] rounded-lg">Gönderimler</button>
                      <button data-testid="schedule-delete" onClick={() => handleDeleteSchedule(s.id)} className="px-3 py-1.5 bg-[#20201f] text-[#ffb4ab] rounded-lg">Sil</button>
                    </div>
                  </div>
                  {expandedScheduleId === s.id && (
                    <div className="border-t border-[#353535] p-3 space-y-1" data-testid="schedule-deliveries-list">
                      {(deliveriesByScheduleId[s.id] ?? []).map((d) => (
                        <div key={d.id} className="flex items-center justify-between text-[11px] font-mono">
                          <span className="text-[#d5c4ab]">{new Date(d.createdAt).toLocaleString('tr-TR')}</span>
                          <span className="text-[#e5e2e1]">{REPORT_DELIVERY_STATUS_LABELS[d.status] ?? d.status}</span>
                          <span className="text-[#d5c4ab]">{d.rowCount ?? '—'} satır</span>
                        </div>
                      ))}
                      {(deliveriesByScheduleId[s.id] ?? []).length === 0 && <span className="text-[11px] text-[#d5c4ab]">Henüz gönderim yok.</span>}
                    </div>
                  )}
                </div>
              ))}
              {!isLoadingSchedules && schedules.length === 0 && <p className="text-xs text-[#d5c4ab]">Henüz zamanlanmış rapor yok.</p>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
