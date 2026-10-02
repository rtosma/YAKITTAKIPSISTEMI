import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { Alarm, AlarmStatus, TenantUser, UserNotificationMute } from '../../types';
import {
  fetchAlarms, fetchAlarm, updateAlarm, snoozeAlarm, fetchTenantUsers,
  ALARM_STATUS_LABELS, categoryLabel
} from '../../hooks/useAlarms';
import {
  fetchNotificationPreferences, setNotificationPreference, fetchActiveMutes, createMute,
  NOTIFICATION_EVENT_TYPES, NOTIFICATION_EVENT_TYPE_LABELS, NOTIFICATION_CHANNELS, NOTIFICATION_CHANNEL_LABELS
} from '../../hooks/useNotificationPreferences';
import { enableAlertSound, isAlertSoundEnabled } from '../../utils/alertSound';

const SEVERITY_STYLES: Record<string, string> = {
  INFO: 'bg-[#20201f] text-[#d5c4ab] border border-[#514532]/30',
  WARNING: 'bg-[#ffb800]/10 text-[#ffdca1]',
  CRITICAL: 'bg-[#ffb4ab]/15 text-[#ffb4ab]'
};
const STATUS_STYLES: Record<string, string> = {
  OPEN: 'bg-[#ffb4ab]/10 text-[#ffb4ab]',
  ACKNOWLEDGED: 'bg-[#ffb800]/10 text-[#ffdca1]',
  INVESTIGATING: 'bg-[#ffb800]/10 text-[#ffdca1]',
  RESOLVED: 'bg-[#a1e8a2]/10 text-[#a1e8a2]',
  FALSE_POSITIVE: 'bg-[#d5c4ab]/10 text-[#d5c4ab]'
};

function formatDuration(iso: string): string {
  const diffMin = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMin < 1) return 'az önce';
  if (diffMin < 60) return `${diffMin} dk önce`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} sa önce`;
  return `${Math.floor(diffHour / 24)} gün önce`;
}

/**
 * FE-815 (#146) — Alarm/anomali merkezi ve bildirim tercihleri. AI-507
 * (birleşik alarm yaşam döngüsü: gruplama/durum/atama/susturma/eskalasyon)
 * + NOTIF-1605 (kullanıcı bazlı kanal tercihi + sessize alma) ZATEN TAMDI —
 * bu sayfa önceden tanks'tan TÜRETİLMİŞ bir mock'tu (gerçek /alarms ucunu
 * hiç kullanmıyordu), Teknik Yığın'ın işaret ettiği ÜZERİNE yeniden yazıldı.
 */
export const NotificationsPage: React.FC = () => {
  const { showToast, sites, clearUnreadAlarmCount } = useApp();

  const [alarms, setAlarms] = useState<Alarm[]>([]);
  const [isLoadingAlarms, setIsLoadingAlarms] = useState(true);
  const [users, setUsers] = useState<TenantUser[]>([]);
  const userLabel = (id: string | null) => (id ? users.find(u => u.id === id)?.username ?? id : '—');

  const [severityFilter, setSeverityFilter] = useState('TÜMÜ');
  const [statusFilter, setStatusFilter] = useState('TÜMÜ');
  const [siteFilter, setSiteFilter] = useState('TÜMÜ');
  // FE-815 Teknik Not: "Alarm listesi varsayılan olarak açık alarmları
  // göstermelidir. Kapalılar filtreyle gelmelidir."
  const [includeResolved, setIncludeResolved] = useState(false);

  const [selectedAlarm, setSelectedAlarm] = useState<Alarm | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [resolutionNote, setResolutionNote] = useState('');
  const [assigneeSelect, setAssigneeSelect] = useState('');
  const [snoozeMinutes, setSnoozeMinutes] = useState('60');
  const [isSavingAlarm, setIsSavingAlarm] = useState(false);

  const [preferences, setPreferences] = useState<Record<string, Record<string, boolean>>>({});
  const [mutes, setMutes] = useState<UserNotificationMute[]>([]);
  const [muteMinutes, setMuteMinutes] = useState('60');
  const [soundEnabled, setSoundEnabled] = useState(isAlertSoundEnabled());

  const loadAlarms = async () => {
    setIsLoadingAlarms(true);
    try {
      const rows = await fetchAlarms({
        severity: severityFilter !== 'TÜMÜ' ? severityFilter : undefined,
        status: statusFilter !== 'TÜMÜ' ? (statusFilter as AlarmStatus) : undefined,
        siteName: siteFilter !== 'TÜMÜ' ? siteFilter : undefined,
        includeResolved,
        includeSnoozed: true
      });
      setAlarms(rows);
    } catch (err: any) {
      showToast(`Alarmlar getirilirken hata: ${err.message}`, 'error');
    } finally {
      setIsLoadingAlarms(false);
    }
  };

  useEffect(() => {
    clearUnreadAlarmCount();
    fetchTenantUsers().then(setUsers).catch(() => {});
    fetchNotificationPreferences().then((rows) => {
      const map: Record<string, Record<string, boolean>> = {};
      for (const row of rows) {
        if (!map[row.eventType]) map[row.eventType] = {};
        map[row.eventType][row.channel] = row.enabled;
      }
      setPreferences(map);
    }).catch(() => {});
    fetchActiveMutes().then(setMutes).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadAlarms();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [severityFilter, statusFilter, siteFilter, includeResolved]);

  const openDetail = async (alarm: Alarm) => {
    setIsLoadingDetail(true);
    setSelectedAlarm(alarm);
    setResolutionNote('');
    setAssigneeSelect(alarm.assigneeId || '');
    try {
      setSelectedAlarm(await fetchAlarm(alarm.id));
    } catch (err: any) {
      showToast(`Alarm detayı getirilirken hata: ${err.message}`, 'error');
    } finally {
      setIsLoadingDetail(false);
    }
  };

  const handleAssign = async () => {
    if (!selectedAlarm) return;
    setIsSavingAlarm(true);
    try {
      const updated = await updateAlarm(selectedAlarm.id, { assigneeId: assigneeSelect || null });
      setSelectedAlarm(prev => prev ? { ...prev, ...updated } : updated);
      await loadAlarms();
      showToast('Alarm atandı.');
    } catch (err: any) {
      showToast(`Atama sırasında hata: ${err.message}`, 'error');
    } finally {
      setIsSavingAlarm(false);
    }
  };

  // FE-815 AC: "Alarmlar ... kapatılabilmelidir." Backend RESOLVED/
  // FALSE_POSITIVE için resolutionNote (≥3 karakter) ZORUNLU kılıyor — aynı
  // kısıt burada da (sunucuya boş istek atmadan) uygulanıyor.
  const handleStatusChange = async (status: AlarmStatus) => {
    if (!selectedAlarm) return;
    const terminal = status === 'RESOLVED' || status === 'FALSE_POSITIVE';
    if (terminal && resolutionNote.trim().length < 3) {
      showToast('Çözüm notu en az 3 karakter olmalıdır.', 'error');
      return;
    }
    setIsSavingAlarm(true);
    try {
      const updated = await updateAlarm(selectedAlarm.id, { status, resolutionNote: terminal ? resolutionNote.trim() : undefined });
      setSelectedAlarm(prev => prev ? { ...prev, ...updated } : updated);
      await loadAlarms();
      showToast(`Alarm durumu güncellendi: ${ALARM_STATUS_LABELS[status]}`);
    } catch (err: any) {
      showToast(`Durum güncellenirken hata: ${err.message}`, 'error');
    } finally {
      setIsSavingAlarm(false);
    }
  };

  const handleSnooze = async () => {
    if (!selectedAlarm) return;
    const minutes = Number(snoozeMinutes);
    if (!minutes || minutes <= 0) return;
    setIsSavingAlarm(true);
    try {
      const updated = await snoozeAlarm(selectedAlarm.id, minutes);
      setSelectedAlarm(prev => prev ? { ...prev, ...updated } : updated);
      await loadAlarms();
      showToast(`Alarm ${minutes} dakika susturuldu.`);
    } catch (err: any) {
      showToast(`Susturma sırasında hata: ${err.message}`, 'error');
    } finally {
      setIsSavingAlarm(false);
    }
  };

  const handleTogglePreference = async (eventType: string, channel: string, current: boolean) => {
    setPreferences(prev => ({ ...prev, [eventType]: { ...prev[eventType], [channel]: !current } }));
    try {
      await setNotificationPreference(eventType, channel as any, !current);
    } catch (err: any) {
      showToast(`Tercih kaydedilirken hata: ${err.message}`, 'error');
      setPreferences(prev => ({ ...prev, [eventType]: { ...prev[eventType], [channel]: current } }));
    }
  };

  const handleToggleRow = async (eventType: string, enable: boolean) => {
    for (const channel of NOTIFICATION_CHANNELS) {
      const cur = preferences[eventType]?.[channel] ?? true;
      if (cur !== enable) await handleTogglePreference(eventType, channel, cur);
    }
  };

  const handleMuteAll = async () => {
    const minutes = Number(muteMinutes);
    if (!minutes || minutes <= 0) return;
    try {
      await createMute(null, minutes);
      setMutes(await fetchActiveMutes());
      showToast(`Tüm bildirimler ${minutes} dakika sessize alındı.`);
    } catch (err: any) {
      showToast(`Sessize alma sırasında hata: ${err.message}`, 'error');
    }
  };

  const handleEnableSound = () => {
    enableAlertSound();
    setSoundEnabled(true);
    showToast('Sesli uyarılar etkinleştirildi.');
  };

  const siteOptions = useMemo(() => ['TÜMÜ', ...sites], [sites]);
  const openCount = alarms.filter(a => !['RESOLVED', 'FALSE_POSITIVE'].includes(a.status)).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 bg-[#1c1b1b] border border-[#514532]/25 p-6 rounded-xl">
        <div className="space-y-1">
          <span className="text-xs font-mono font-bold text-[#ffdca1] uppercase tracking-widest block">ALARM/ANOMALİ MERKEZİ</span>
          <h1 className="text-2xl font-black text-[#e5e2e1] uppercase tracking-tight">BİLDİRİMLER</h1>
          <p className="text-xs text-[#d5c4ab]">
            <strong className="text-[#ffdca1]">{openCount}</strong> açık alarm — hırsızlık/anomali/stok/bakım/mevzuat kaynaklı tüm uyarılar tek yerde.
          </p>
        </div>
        {!soundEnabled && (
          <button
            data-testid="enable-sound"
            onClick={handleEnableSound}
            className="px-4 py-2.5 bg-[#20201f] hover:bg-[#2a2a2a] border border-[#514532]/30 text-[#d5c4ab] hover:text-[#ffdca1] rounded-xl text-xs font-bold flex items-center space-x-2 cursor-pointer shrink-0"
          >
            <span className="material-symbols-outlined text-base">volume_up</span>
            <span>Sesli Uyarıları Etkinleştir</span>
          </button>
        )}
      </div>

      {/* Filtre Çubuğu */}
      <div className="bg-[#1c1b1b] border border-[#514532]/25 p-4 rounded-xl">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="text-[10px] font-mono font-bold text-[#d5c4ab] uppercase block mb-1">Şiddet</label>
            <select data-testid="filter-severity" value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value)} className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-2 focus:outline-none focus:border-[#ffdca1]">
              <option value="TÜMÜ">Tümü</option>
              <option value="CRITICAL">Kritik</option>
              <option value="WARNING">Uyarı</option>
              <option value="INFO">Bilgi</option>
            </select>
          </div>
          <div>
            <label className="text-[10px] font-mono font-bold text-[#d5c4ab] uppercase block mb-1">Durum</label>
            <select data-testid="filter-status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-2 focus:outline-none focus:border-[#ffdca1]">
              <option value="TÜMÜ">Tümü</option>
              {Object.entries(ALARM_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[10px] font-mono font-bold text-[#d5c4ab] uppercase block mb-1">Şantiye</label>
            <select data-testid="filter-site" value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)} className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-2 focus:outline-none focus:border-[#ffdca1]">
              {siteOptions.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-xs text-[#d5c4ab] cursor-pointer">
              <input type="checkbox" data-testid="filter-include-resolved" checked={includeResolved} onChange={(e) => setIncludeResolved(e.target.checked)} className="cursor-pointer" />
              <span>Çözülenleri de göster</span>
            </label>
          </div>
        </div>
      </div>

      {/* Alarm Listesi */}
      <div className="bg-[#1c1b1b] border border-[#514532]/25 rounded-xl p-6 overflow-x-auto">
        <table className="w-full text-left text-xs border-collapse" data-testid="alarm-table">
          <thead>
            <tr className="border-b border-[#514532]/20 text-[#d5c4ab] uppercase text-[10px] tracking-wider font-mono">
              <th className="py-3 px-4">Şiddet</th>
              <th className="py-3 px-4">Tip</th>
              <th className="py-3 px-4">Başlık</th>
              <th className="py-3 px-4">Şantiye</th>
              <th className="py-3 px-4">Atanan</th>
              <th className="py-3 px-4">Süre</th>
              <th className="py-3 px-4">Durum</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#514532]/15 font-mono">
            {isLoadingAlarms ? (
              <tr><td colSpan={7} className="py-8 text-center text-[#d5c4ab]">Yükleniyor...</td></tr>
            ) : alarms.length === 0 ? (
              <tr><td colSpan={7} className="py-8 text-center text-[#d5c4ab]">Filtre kriterlerine uygun alarm yok.</td></tr>
            ) : alarms.map((a) => (
              <tr key={a.id} data-testid="alarm-row" data-alarm-id={a.id} data-status={a.status} onClick={() => openDetail(a)} className="hover:bg-[#20201f] transition-colors cursor-pointer">
                <td className="py-3 px-4"><span className={`text-[10px] font-bold px-2 py-0.5 rounded ${SEVERITY_STYLES[a.severity]}`}>{a.severity}</span></td>
                <td className="py-3 px-4 text-[#d5c4ab]">{categoryLabel(a.category)}</td>
                <td className="py-3 px-4 text-[#e5e2e1] font-bold">
                  {a.title}
                  {a.eventCount > 1 && <span className="text-[#d5c4ab] font-normal"> ({a.eventCount})</span>}
                  {a.snoozedUntil && new Date(a.snoozedUntil).getTime() > Date.now() && <span className="ml-2 text-[10px] text-[#ffdca1]">🔕 Susturuldu</span>}
                </td>
                <td className="py-3 px-4 text-[#d5c4ab]">{a.siteName || '—'}</td>
                <td className="py-3 px-4 text-[#d5c4ab]">{userLabel(a.assigneeId)}</td>
                <td className="py-3 px-4 text-[#d5c4ab]">{formatDuration(a.lastSeenAt)}</td>
                <td className="py-3 px-4"><span className={`text-[10px] font-bold px-2 py-0.5 rounded ${STATUS_STYLES[a.status]}`}>{ALARM_STATUS_LABELS[a.status]}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Bildirim Tercihleri */}
      <div className="bg-[#1c1b1b] border border-[#514532]/25 rounded-xl p-6 overflow-x-auto" data-testid="preferences-section">
        <h3 className="text-xs font-extrabold text-[#e5e2e1] uppercase tracking-wider mb-4">Bildirim Tercihleri — Kanal × Olay Tipi</h3>
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-[#514532]/20 text-[#d5c4ab] uppercase text-[10px] tracking-wider font-mono">
              <th className="py-2 px-3">Olay Tipi</th>
              {NOTIFICATION_CHANNELS.map(c => <th key={c} className="py-2 px-3 text-center">{NOTIFICATION_CHANNEL_LABELS[c]}</th>)}
              <th className="py-2 px-3 text-right">Hepsi</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#514532]/15 font-mono">
            {NOTIFICATION_EVENT_TYPES.map((eventType) => (
              <tr key={eventType} data-testid="preference-row" data-event-type={eventType}>
                <td className="py-2.5 px-3 text-[#e5e2e1]">{NOTIFICATION_EVENT_TYPE_LABELS[eventType]}</td>
                {NOTIFICATION_CHANNELS.map((channel) => {
                  const enabled = preferences[eventType]?.[channel] ?? true;
                  return (
                    <td key={channel} className="py-2.5 px-3 text-center">
                      <input
                        type="checkbox"
                        data-testid={`pref-${eventType}-${channel}`}
                        checked={enabled}
                        onChange={() => handleTogglePreference(eventType, channel, enabled)}
                        className="cursor-pointer"
                      />
                    </td>
                  );
                })}
                <td className="py-2.5 px-3 text-right space-x-1">
                  <button onClick={() => handleToggleRow(eventType, true)} className="text-[10px] text-[#a1e8a2] hover:underline cursor-pointer">Tümünü Seç</button>
                  <button onClick={() => handleToggleRow(eventType, false)} className="text-[10px] text-[#ffb4ab] hover:underline cursor-pointer">Tümünü Kapat</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-6 pt-4 border-t border-[#514532]/20 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div>
            <h4 className="text-[11px] font-bold text-[#e5e2e1] uppercase">Sessize Alma</h4>
            {mutes.length > 0 ? (
              <ul className="text-[11px] text-[#d5c4ab] mt-1 space-y-0.5">
                {mutes.map(m => (
                  <li key={m.id} data-testid="active-mute-row">
                    {m.eventType ? NOTIFICATION_EVENT_TYPE_LABELS[m.eventType] || m.eventType : 'Tüm bildirimler'} — {new Date(m.mutedUntil).toLocaleString('tr-TR')}'e kadar
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[11px] text-[#d5c4ab]/60 mt-1">Aktif sessize alma yok.</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              data-testid="mute-minutes-input"
              value={muteMinutes}
              onChange={(e) => setMuteMinutes(e.target.value)}
              className="w-20 bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-2 focus:outline-none focus:border-[#ffdca1]"
            />
            <span className="text-[11px] text-[#d5c4ab]">dk</span>
            <button data-testid="mute-all" onClick={handleMuteAll} className="px-3 py-2 bg-[#20201f] hover:bg-[#2a2a2a] border border-[#514532]/30 text-[#d5c4ab] rounded-md text-[11px] font-bold cursor-pointer">
              Tümünü Sessize Al
            </button>
          </div>
        </div>
      </div>

      {/* Alarm Detayı */}
      {selectedAlarm && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div data-testid="alarm-detail-modal" className="bg-[#1c1b1b] border border-[#514532]/30 rounded-xl p-6 max-w-2xl w-full space-y-5 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-[#514532]/20 pb-4">
              <div>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${SEVERITY_STYLES[selectedAlarm.severity]}`}>{selectedAlarm.severity}</span>
                <h3 className="text-base font-bold text-[#e5e2e1] mt-1">{selectedAlarm.title}</h3>
                <p className="text-xs text-[#d5c4ab] mt-0.5">{categoryLabel(selectedAlarm.category)} — {selectedAlarm.siteName || 'Şantiye belirtilmemiş'}</p>
              </div>
              <button data-testid="alarm-detail-close" onClick={() => setSelectedAlarm(null)} className="text-[#d5c4ab] hover:text-[#e5e2e1] cursor-pointer">
                <span className="material-symbols-outlined text-lg">close</span>
              </button>
            </div>

            <div className="flex items-center gap-2 text-xs">
              <span className={`font-bold px-2 py-0.5 rounded ${STATUS_STYLES[selectedAlarm.status]}`}>{ALARM_STATUS_LABELS[selectedAlarm.status]}</span>
              <span className="text-[#d5c4ab]">{selectedAlarm.eventCount} olay — ilk görülme: {new Date(selectedAlarm.firstSeenAt).toLocaleString('tr-TR')}</span>
            </div>

            {/* FE-815 Kapsam: "Delil paketi (telemetri grafiği)." KAPSAM
                UYARLAMASI (disclosed): alarm_events.detail serbest-formatlı
                bir JSON'dur (20+ farklı kategori, HER birinin KENDİ şekli —
                tek bir "telemetri grafiği" bileşeni bunların hepsini anlamlı
                çizemez). Burada ham ama OKUNABİLİR biçimde (anahtar: değer)
                gösteriliyor — sahte/varsayımsal bir grafik ÇİZİLMEDİ. */}
            <div>
              <h4 className="text-[11px] font-bold text-[#d5c4ab] uppercase mb-2">Delil Paketi — Zaman Çizelgesi</h4>
              {isLoadingDetail ? (
                <p className="text-xs text-[#d5c4ab]">Yükleniyor...</p>
              ) : (
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {(selectedAlarm.events || []).map((ev) => (
                    <div key={ev.id} data-testid="alarm-event-row" className="bg-[#0e0e0e] border border-[#514532]/20 rounded-md p-3 text-[11px]">
                      <p className="text-[#d5c4ab] font-mono">{new Date(ev.occurredAt).toLocaleString('tr-TR')}</p>
                      {Object.keys(ev.detail || {}).length > 0 ? (
                        <dl className="grid grid-cols-2 gap-1 mt-1">
                          {Object.entries(ev.detail).map(([k, v]) => (
                            <React.Fragment key={k}>
                              <dt className="text-[#d5c4ab]/70">{k}</dt>
                              <dd className="text-[#e5e2e1]">{String(v)}</dd>
                            </React.Fragment>
                          ))}
                        </dl>
                      ) : <p className="text-[#d5c4ab]/50 mt-1">Ek ayrıntı yok.</p>}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4 border-t border-[#514532]/20">
              <div>
                <label className="text-[10px] font-mono text-[#d5c4ab] block mb-1">Ata</label>
                <div className="flex gap-2">
                  <select data-testid="alarm-assignee-select" value={assigneeSelect} onChange={(e) => setAssigneeSelect(e.target.value)} className="flex-1 min-w-0 bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-2 focus:outline-none focus:border-[#ffdca1]">
                    <option value="">— Atanmadı —</option>
                    {users.map(u => <option key={u.id} value={u.id}>{u.username} ({u.role})</option>)}
                  </select>
                  <button data-testid="alarm-assign" onClick={handleAssign} disabled={isSavingAlarm} className="px-3 py-2 bg-[#ffdca1] text-[#412d00] rounded-md text-[11px] font-bold cursor-pointer disabled:opacity-40">Ata</button>
                </div>
              </div>
              <div>
                <label className="text-[10px] font-mono text-[#d5c4ab] block mb-1">Sustur</label>
                <div className="flex gap-2">
                  <input type="number" data-testid="alarm-snooze-minutes" value={snoozeMinutes} onChange={(e) => setSnoozeMinutes(e.target.value)} className="flex-1 min-w-0 bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-2 focus:outline-none focus:border-[#ffdca1]" />
                  <button data-testid="alarm-snooze" onClick={handleSnooze} disabled={isSavingAlarm} className="px-3 py-2 bg-[#20201f] border border-[#514532]/30 text-[#d5c4ab] rounded-md text-[11px] font-bold cursor-pointer disabled:opacity-40">dk Sustur</button>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button data-testid="alarm-status-acknowledged" onClick={() => handleStatusChange('ACKNOWLEDGED')} disabled={isSavingAlarm} className="px-3 py-2 bg-[#20201f] border border-[#514532]/30 text-[#d5c4ab] rounded-md text-[11px] font-bold cursor-pointer disabled:opacity-40">Onayla</button>
              <button data-testid="alarm-status-investigating" onClick={() => handleStatusChange('INVESTIGATING')} disabled={isSavingAlarm} className="px-3 py-2 bg-[#20201f] border border-[#514532]/30 text-[#d5c4ab] rounded-md text-[11px] font-bold cursor-pointer disabled:opacity-40">İnceleniyor</button>
            </div>

            <div className="space-y-2 pt-2 border-t border-[#514532]/20">
              <label className="text-[10px] font-mono text-[#d5c4ab] block">Çözüm Notu (Kapatmak/Yanlış Pozitif İçin Zorunlu)</label>
              <textarea
                data-testid="alarm-resolution-note"
                value={resolutionNote}
                onChange={(e) => setResolutionNote(e.target.value)}
                rows={2}
                placeholder="Kök neden ve alınan aksiyonu yazın..."
                className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-2.5 focus:outline-none focus:border-[#ffdca1]"
              />
              <div className="flex items-center justify-end gap-2">
                <button data-testid="alarm-status-false-positive" onClick={() => handleStatusChange('FALSE_POSITIVE')} disabled={isSavingAlarm || resolutionNote.trim().length < 3} className="px-4 py-2 bg-[#20201f] border border-[#514532]/30 text-[#d5c4ab] rounded-md text-xs font-bold cursor-pointer disabled:opacity-40">Yanlış Pozitif</button>
                <button data-testid="alarm-status-resolved" onClick={() => handleStatusChange('RESOLVED')} disabled={isSavingAlarm || resolutionNote.trim().length < 3} className="px-4 py-2 bg-gradient-to-r from-[#ffb800] to-[#ff8a00] text-[#412d00] rounded-md text-xs font-black cursor-pointer disabled:opacity-40">Çöz ve Kapat</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
