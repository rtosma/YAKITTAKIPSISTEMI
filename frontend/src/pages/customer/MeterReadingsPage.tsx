import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { Vehicle, MeterReading, BulkMeterResultRow, MissingMeterReadings } from '../../types';
import {
  fetchVehicleMeterReadings,
  recordMeterReading,
  recordMeterReadingsBulk,
  fetchMissingMeterReadings,
  remindMissingMeterReadings,
  resolveMeterTypeForVehicleType,
  currentPeriodLabel,
  formatSuspicionDetail,
  BulkMeterReadingItem
} from '../../hooks/useMeterReadings';

const REASON_LABELS: Record<string, string> = {
  BACKWARD: 'Geri giden değer',
  ABSURD_JUMP: 'Absürt sıçrama',
  DUPLICATE_PERIOD: 'Bu dönem için zaten bir giriş var'
};

/**
 * FE-813 (#144) — Km/motor-saat giriş ekranı ve toplu giriş. FLEET-1404 +
 * RES-903'ün backend'i (vehicle_meter_readings, /vehicles/:id/meter-readings,
 * /meter-readings/bulk, /meter-readings/missing) ZATEN TAMDI — önceden
 * frontend'de hiç arayüzü yoktu (grep: sıfır referans). KAPSAM UYARLAMASI
 * (disclosed): bu sayfa COMPANY_OWNER/SUPER_ADMIN'in /panel'inde (tüm filo,
 * toplu/Excel-yapıştırma, eksik giriş panosu, hatırlatma). Ticket'ın "sahada
 * tablet" notu SITE_MANAGER'ı da işaret ediyor ama SITE_MANAGER /panel'e HİÇ
 * giremiyor (ROLE_GROUPS.PANEL yalnızca SUPER_ADMIN/COMPANY_OWNER, bkz.
 * utils/permissions.ts) — o yüzden SiteOperatorPanel.tsx'e AYRI, küçük/
 * dokunma-dostu tekil bir giriş bölümü eklendi (bkz. o dosyadaki yorum);
 * toplu yapıştırma/Excel İÇE AKTARMA orada YOK (orası zaten kısıtlı bir
 * panel, tam grid'i oraya taşımak orantısız olurdu).
 */
export const MeterReadingsPage: React.FC = () => {
  const { vehicles, currentUser, showToast } = useApp();

  const [periodLabel, setPeriodLabel] = useState(currentPeriodLabel());
  const [entries, setEntries] = useState<Record<string, string>>({});
  const [savingVehicleId, setSavingVehicleId] = useState<string | null>(null);
  const [suspiciousConfirm, setSuspiciousConfirm] = useState<{ vehicleId: string; value: number; reasons: string[]; detail: string } | null>(null); // detail burada ZATEN formatlanmış metin olarak tutulur (bkz. formatSuspicionDetail)
  const [overrideReasonInput, setOverrideReasonInput] = useState('');

  const [missing, setMissing] = useState<MissingMeterReadings | null>(null);
  const [isLoadingMissing, setIsLoadingMissing] = useState(false);

  const [historyVehicle, setHistoryVehicle] = useState<Vehicle | null>(null);
  const [historyRecords, setHistoryRecords] = useState<MeterReading[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  // FE-813 Kapsam: "Düzeltme geçmişinin görüntülenmesi." Backend APPEND-ONLY
  // (bir düzeltme eski satırı SİLMEZ) — correctsReadingId ile YENİ bir satır.
  const [correctingReadingId, setCorrectingReadingId] = useState<string | null>(null);
  const [correctionValue, setCorrectionValue] = useState('');
  const [isSavingCorrection, setIsSavingCorrection] = useState(false);
  // Canlı yakalanan bulgu: correctsReadingId VARKEN BİLE RES-903'ün BACKWARD/
  // ABSURD_JUMP kontrolü ATLANMAZ (yalnızca DUPLICATE_PERIOD atlanır) — bir
  // düzeltme de şüpheli sayılabilir, bu yüzden düzeltme formunun KENDİ
  // override-confirm'ı da var (ana giriş akışıyla AYNI desen).
  const [correctionSuspicion, setCorrectionSuspicion] = useState<{ reasons: string[]; detail: string } | null>(null);
  const [correctionOverrideReason, setCorrectionOverrideReason] = useState('');

  const [isBulkModalOpen, setIsBulkModalOpen] = useState(false);
  const [bulkPasteText, setBulkPasteText] = useState('');
  const [bulkResults, setBulkResults] = useState<BulkMeterResultRow[] | null>(null);
  const [isBulkSaving, setIsBulkSaving] = useState(false);

  const activeVehicles = useMemo(() => vehicles.filter(v => v.status !== 'PASİF'), [vehicles]);
  const missingPlates = useMemo(() => new Set((missing?.bySite || []).flatMap(s => s.plates)), [missing]);

  const loadMissing = async (period: string) => {
    setIsLoadingMissing(true);
    try {
      setMissing(await fetchMissingMeterReadings(period));
    } catch (err: any) {
      showToast(`Eksik girişler getirilirken hata: ${err.message}`, 'error');
    } finally {
      setIsLoadingMissing(false);
    }
  };

  useEffect(() => {
    loadMissing(periodLabel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodLabel]);

  // RES-903 AC: "Doğrulama uyarısı girişi engellememeli, onay isteyerek
  // geçişe izin vermelidir." Backend 409 METER_READING_SUSPICIOUS döndürürse
  // (overrideReason YOKSA) burada o hatayı YAKALAYIP onay diyaloğu açıyoruz
  // — kalıcı bir engel DEĞİL.
  const handleSave = async (vehicle: Vehicle, overrideReason?: string) => {
    const raw = entries[vehicle.id];
    const value = Number(raw);
    if (!raw || Number.isNaN(value) || value < 0) {
      showToast('Geçerli bir sayaç değeri girin.', 'error');
      return;
    }
    setSavingVehicleId(vehicle.id);
    try {
      const { warnings } = await recordMeterReading(vehicle.id, {
        value,
        periodLabel,
        meterType: resolveMeterTypeForVehicleType(vehicle.type),
        overrideReason
      });
      showToast(warnings[0] || `${vehicle.plate} için sayaç kaydedildi.`);
      setEntries(prev => { const next = { ...prev }; delete next[vehicle.id]; return next; });
      setSuspiciousConfirm(null);
      setOverrideReasonInput('');
      await loadMissing(periodLabel);
    } catch (err: any) {
      if (err.details?.error === 'METER_READING_SUSPICIOUS') {
        setSuspiciousConfirm({ vehicleId: vehicle.id, value, reasons: err.details.reasons, detail: formatSuspicionDetail(err.details.detail) });
      } else {
        showToast(`Sayaç kaydedilirken hata: ${err.message}`, 'error');
      }
    } finally {
      setSavingVehicleId(null);
    }
  };

  const handleConfirmOverride = async () => {
    if (!suspiciousConfirm || overrideReasonInput.trim().length < 3) return;
    const vehicle = vehicles.find(v => v.id === suspiciousConfirm.vehicleId);
    if (!vehicle) return;
    await handleSave(vehicle, overrideReasonInput.trim());
  };

  const openHistory = async (vehicle: Vehicle) => {
    setHistoryVehicle(vehicle);
    setIsLoadingHistory(true);
    try {
      setHistoryRecords(await fetchVehicleMeterReadings(vehicle.id));
    } catch (err: any) {
      showToast(`Geçmiş getirilirken hata: ${err.message}`, 'error');
    } finally {
      setIsLoadingHistory(false);
    }
  };

  const handleSaveCorrection = async (reading: MeterReading, overrideReason?: string) => {
    const value = Number(correctionValue);
    if (!correctionValue || Number.isNaN(value) || value < 0 || !historyVehicle) return;
    setIsSavingCorrection(true);
    try {
      await recordMeterReading(historyVehicle.id, {
        value,
        periodLabel: reading.periodLabel,
        meterType: reading.meterType,
        correctsReadingId: reading.id,
        overrideReason
      });
      showToast('Düzeltme kaydedildi — önceki kayıt geçmişte korunuyor.');
      setCorrectingReadingId(null);
      setCorrectionValue('');
      setCorrectionSuspicion(null);
      setCorrectionOverrideReason('');
      setHistoryRecords(await fetchVehicleMeterReadings(historyVehicle.id));
      await loadMissing(periodLabel);
    } catch (err: any) {
      if (err.details?.error === 'METER_READING_SUSPICIOUS') {
        setCorrectionSuspicion({ reasons: err.details.reasons, detail: formatSuspicionDetail(err.details.detail) });
      } else {
        showToast(`Düzeltme kaydedilirken hata: ${err.message}`, 'error');
      }
    } finally {
      setIsSavingCorrection(false);
    }
  };

  const handleConfirmCorrectionOverride = async (reading: MeterReading) => {
    if (correctionOverrideReason.trim().length < 3) return;
    await handleSaveCorrection(reading, correctionOverrideReason.trim());
  };

  const handleRemind = async () => {
    try {
      const result = await remindMissingMeterReadings(periodLabel);
      showToast(`${result.remindedSites} şantiyeye hatırlatma gönderildi.`);
    } catch (err: any) {
      showToast(`Hatırlatma gönderilirken hata: ${err.message}`, 'error');
    }
  };

  // FE-813 Kapsam: "Toplu giriş: tablo yapıştırma." Excel'den kopyalanan
  // satırlar TAB (veya virgül) ayraçlı gelir — "PLAKA<TAB>DEĞER" biçimi
  // beklenir. Backend'in POST /meter-readings/bulk'u ZATEN varken (JSON
  // array alıyor) burada SADECE istemci tarafı ayrıştırma eklendi — yeni
  // bir backend parse/CSV ucu İCAT EDİLMEDİ (FUEL-403.1'in strapping-table
  // CSV ucundan FARKLI olarak, çünkü bulk endpoint zaten yapılandırılmış
  // JSON alıyor, ham metin DEĞİL).
  const parseBulkPaste = (text: string): BulkMeterReadingItem[] => {
    return text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const parts = line.split(/\t|,/).map(p => p.trim());
        return { vehiclePlate: parts[0], value: Number(parts[1]), periodLabel };
      })
      .filter(item => item.vehiclePlate && !Number.isNaN(item.value));
  };

  const bulkPreview = useMemo(() => parseBulkPaste(bulkPasteText), [bulkPasteText, periodLabel]);

  const handleBulkSave = async () => {
    if (bulkPreview.length === 0) return;
    setIsBulkSaving(true);
    try {
      const result = await recordMeterReadingsBulk(bulkPreview);
      setBulkResults(result.rows);
      showToast(`${result.accepted}/${result.total} kayıt başarıyla eklendi.`);
      await loadMissing(periodLabel);
    } catch (err: any) {
      showToast(`Toplu giriş sırasında hata: ${err.message}`, 'error');
    } finally {
      setIsBulkSaving(false);
    }
  };

  const canRemind = currentUser && ['SUPER_ADMIN', 'COMPANY_OWNER'].includes(currentUser.role);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 bg-[#1c1b1b] border border-[#514532]/25 p-6 rounded-xl">
        <div className="space-y-1">
          <span className="text-xs font-mono font-bold text-[#ffdca1] uppercase tracking-widest block">
            TÜKETİM HESABININ GİRDİSİ
          </span>
          <h1 className="text-2xl font-black text-[#e5e2e1] uppercase tracking-tight">KM / MOTOR-SAAT GİRİŞİ</h1>
          <p className="text-xs text-[#d5c4ab]">Dönem başı/sonu sayaç okumaları — L/100km ve L/motor-saat hesabının girdisi.</p>
        </div>
        <div className="flex items-center gap-3">
          <div>
            <label className="text-[10px] font-mono font-bold text-[#d5c4ab] uppercase block mb-1">Dönem</label>
            <input
              type="month"
              data-testid="period-select"
              value={periodLabel}
              onChange={(e) => setPeriodLabel(e.target.value)}
              className="bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs font-mono rounded-md p-2.5 focus:outline-none focus:border-[#ffdca1]"
            />
          </div>
          <button
            data-testid="bulk-open"
            onClick={() => { setIsBulkModalOpen(true); setBulkPasteText(''); setBulkResults(null); }}
            className="self-end px-4 py-2.5 bg-[#20201f] hover:bg-[#2a2a2a] border border-[#514532]/30 text-[#e5e2e1] font-bold rounded-md text-xs flex items-center space-x-2 transition-all cursor-pointer"
          >
            <span className="material-symbols-outlined text-base">content_paste</span>
            <span>Toplu Yapıştır</span>
          </button>
        </div>
      </div>

      {/* FE-813 Kapsam: "Eksik giriş yapılan araçların vurgulanması ve hatırlatma." */}
      {missing && missing.missingCount > 0 && (
        <div className="bg-[#2a1f10] border border-[#ffb800]/30 rounded-xl p-4 flex items-center justify-between gap-4" data-testid="missing-banner">
          <div className="flex items-center gap-2 text-xs text-[#ffdca1]">
            <span className="material-symbols-outlined text-base">warning</span>
            <span>{periodLabel} dönemi için <strong>{missing.missingCount}</strong> araçta sayaç girişi eksik.</span>
          </div>
          {canRemind && (
            <button
              data-testid="remind-missing"
              onClick={handleRemind}
              className="px-3 py-1.5 bg-[#ffdca1] text-[#412d00] rounded-md text-[11px] font-bold cursor-pointer"
            >
              Şantiyelere Hatırlat
            </button>
          )}
        </div>
      )}

      {/* FE-813 Kapsam: "Dönem seçimi ve araç listesi üzerinde satır içi değer girişi." */}
      <div className="bg-[#1c1b1b] border border-[#514532]/25 rounded-xl p-6 overflow-x-auto">
        <table className="w-full text-left text-xs border-collapse" data-testid="meter-table">
          <thead>
            <tr className="border-b border-[#514532]/30 text-[#d5c4ab] uppercase text-[10px] tracking-wider font-mono">
              <th className="py-3 px-4">Plaka</th>
              <th className="py-3 px-4">Araç Tipi</th>
              <th className="py-3 px-4">Birim</th>
              <th className="py-3 px-4">{periodLabel} Değeri</th>
              <th className="py-3 px-4">Durum</th>
              <th className="py-3 px-4 text-right">İşlem</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#514532]/20 font-mono">
            {activeVehicles.map((v) => {
              const unit = resolveMeterTypeForVehicleType(v.type);
              const isMissing = missingPlates.has(v.plate);
              const isConfirming = suspiciousConfirm?.vehicleId === v.id;
              return (
                <React.Fragment key={v.id}>
                  <tr data-testid="meter-row" data-plate={v.plate} className={isMissing ? 'bg-[#2a1f10]/40' : ''}>
                    <td className="py-3 px-4 font-black text-[#ffdca1] text-sm">{v.plate}</td>
                    <td className="py-3 px-4 text-[#e5e2e1]">{v.type}</td>
                    <td className="py-3 px-4 text-[#d5c4ab]">{unit === 'KM' ? 'Km' : 'Motor-Saat'}</td>
                    <td className="py-3 px-4">
                      <input
                        type="number"
                        data-testid="meter-value-input"
                        value={entries[v.id] ?? ''}
                        onChange={(e) => setEntries(prev => ({ ...prev, [v.id]: e.target.value }))}
                        placeholder={unit === 'KM' ? 'km' : 'saat'}
                        className="w-28 bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-2 focus:outline-none focus:border-[#ffdca1]"
                      />
                    </td>
                    <td className="py-3 px-4">
                      {isMissing ? (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-[#ffb800]/10 text-[#ffdca1]">EKSİK</span>
                      ) : (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-[#a1e8a2]/10 text-[#a1e8a2]">GİRİLDİ</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right space-x-2">
                      <button
                        data-testid="meter-save"
                        onClick={() => handleSave(v)}
                        disabled={savingVehicleId === v.id || !entries[v.id]}
                        className="px-3 py-1.5 bg-[#ffdca1] text-[#412d00] rounded-md text-[11px] font-bold cursor-pointer disabled:opacity-40"
                      >
                        {savingVehicleId === v.id ? 'Kaydediliyor...' : 'Kaydet'}
                      </button>
                      <button
                        data-testid="meter-history-open"
                        onClick={() => openHistory(v)}
                        className="px-3 py-1.5 bg-[#20201f] hover:bg-[#2a2a2a] border border-[#514532]/30 text-[#d5c4ab] rounded-md text-[11px] font-bold cursor-pointer"
                      >
                        Geçmiş
                      </button>
                    </td>
                  </tr>
                  {isConfirming && suspiciousConfirm && (
                    <tr data-testid="suspicion-confirm-row">
                      <td colSpan={6} className="bg-[#2a1f10] px-6 py-4">
                        <div className="flex flex-col md:flex-row md:items-center gap-3 text-xs">
                          <span className="material-symbols-outlined text-[#ffb4ab]">report</span>
                          <div className="flex-1">
                            <p className="text-[#ffb4ab] font-bold" data-testid="suspicion-reasons">
                              Şüpheli giriş: {suspiciousConfirm.reasons.map(r => REASON_LABELS[r] || r).join(', ')}
                            </p>
                            <p className="text-[#d5c4ab] mt-0.5">{suspiciousConfirm.detail}</p>
                          </div>
                          <input
                            type="text"
                            data-testid="override-reason-input"
                            value={overrideReasonInput}
                            onChange={(e) => setOverrideReasonInput(e.target.value)}
                            placeholder="Onay gerekçesi (en az 3 karakter)..."
                            className="w-full md:w-64 bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-2 focus:outline-none focus:border-[#ffdca1]"
                          />
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => { setSuspiciousConfirm(null); setOverrideReasonInput(''); }}
                              className="px-3 py-1.5 bg-[#20201f] text-[#d5c4ab] rounded-md text-[11px] font-bold cursor-pointer"
                            >
                              İptal
                            </button>
                            <button
                              data-testid="override-confirm"
                              onClick={handleConfirmOverride}
                              disabled={overrideReasonInput.trim().length < 3 || savingVehicleId === v.id}
                              className="px-3 py-1.5 bg-[#ffb4ab] text-[#412d00] rounded-md text-[11px] font-bold cursor-pointer disabled:opacity-40"
                            >
                              Onayla ve Kaydet
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* FE-813 Kapsam: "Düzeltme geçmişinin görüntülenmesi." */}
      {historyVehicle && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#1c1b1b] border border-[#514532]/30 rounded-xl p-6 max-w-lg w-full space-y-4 max-h-[85vh] overflow-y-auto" data-testid="meter-history-modal">
            <div className="flex items-center justify-between border-b border-[#514532]/20 pb-4">
              <h3 className="text-base font-bold text-[#e5e2e1] uppercase">Sayaç Geçmişi — {historyVehicle.plate}</h3>
              <button data-testid="meter-history-close" onClick={() => setHistoryVehicle(null)} className="text-[#d5c4ab] hover:text-[#e5e2e1] cursor-pointer">
                <span className="material-symbols-outlined text-lg">close</span>
              </button>
            </div>
            {isLoadingHistory ? (
              <p className="text-xs text-[#d5c4ab] text-center py-6">Yükleniyor...</p>
            ) : historyRecords.length === 0 ? (
              <p className="text-xs text-[#d5c4ab] text-center py-6">Bu araç için henüz sayaç girişi yok.</p>
            ) : (
              <div className="space-y-2">
                {historyRecords.map(r => (
                  <div key={r.id} data-testid="meter-history-row" className="bg-[#0e0e0e] border border-[#514532]/20 rounded-lg p-3 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-[#ffdca1]">{r.value.toLocaleString('tr-TR')} {r.meterType === 'KM' ? 'km' : 'saat'}</span>
                      <span className="text-[#d5c4ab] font-mono">{r.periodLabel}</span>
                    </div>
                    <p className="text-[#d5c4ab]/70 mt-1">{new Date(r.readingAt).toLocaleString('tr-TR')} — {r.source}</p>
                    {r.isSuspicious && (
                      <p className="text-[#ffb4ab] mt-1">
                        Şüpheli ({r.suspicionReasons.map(x => REASON_LABELS[x] || x).join(', ')}) — onaylı: {r.overrideReason}
                      </p>
                    )}
                    {r.correctsReadingId && <p className="text-[#a1e8a2] mt-1">Bu kayıt önceki hatalı girişi düzeltiyor.</p>}

                    {correctingReadingId === r.id ? (
                      <div className="flex items-center gap-2 mt-2 pt-2 border-t border-[#514532]/20">
                        <input
                          type="number"
                          data-testid="correction-value-input"
                          value={correctionValue}
                          onChange={(e) => setCorrectionValue(e.target.value)}
                          placeholder="Doğru değer"
                          className="flex-1 bg-[#131313] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-2 focus:outline-none focus:border-[#ffdca1]"
                        />
                        <button onClick={() => { setCorrectingReadingId(null); setCorrectionValue(''); setCorrectionSuspicion(null); setCorrectionOverrideReason(''); }} className="px-2 py-1.5 bg-[#20201f] text-[#d5c4ab] rounded-md text-[11px] font-bold cursor-pointer">
                          İptal
                        </button>
                        <button
                          data-testid="correction-save"
                          onClick={() => handleSaveCorrection(r)}
                          disabled={!correctionValue || isSavingCorrection}
                          className="px-2 py-1.5 bg-[#ffdca1] text-[#412d00] rounded-md text-[11px] font-bold cursor-pointer disabled:opacity-40"
                        >
                          Kaydet
                        </button>
                      </div>
                    ) : null}
                    {correctingReadingId === r.id && correctionSuspicion && (
                      <div data-testid="correction-suspicion" className="flex flex-col gap-2 mt-2 pt-2 border-t border-[#514532]/20 bg-[#2a1f10] rounded-md p-2">
                        <p className="text-[#ffb4ab]">Şüpheli düzeltme: {correctionSuspicion.reasons.join(', ')} — {correctionSuspicion.detail}</p>
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            data-testid="correction-override-reason-input"
                            value={correctionOverrideReason}
                            onChange={(e) => setCorrectionOverrideReason(e.target.value)}
                            placeholder="Onay gerekçesi..."
                            className="flex-1 bg-[#131313] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-2 focus:outline-none focus:border-[#ffdca1]"
                          />
                          <button
                            data-testid="correction-override-confirm"
                            onClick={() => handleConfirmCorrectionOverride(r)}
                            disabled={correctionOverrideReason.trim().length < 3 || isSavingCorrection}
                            className="px-2 py-1.5 bg-[#ffb4ab] text-[#412d00] rounded-md text-[11px] font-bold cursor-pointer disabled:opacity-40"
                          >
                            Onayla
                          </button>
                        </div>
                      </div>
                    )}
                    {correctingReadingId !== r.id && (
                      <button
                        data-testid="correction-open"
                        onClick={() => { setCorrectingReadingId(r.id); setCorrectionValue(''); }}
                        className="text-[10px] font-bold text-[#d5c4ab] hover:text-[#ffdca1] mt-2 cursor-pointer"
                      >
                        Düzelt
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* FE-813 Kapsam: "Toplu giriş: tablo yapıştırma veya Excel içe aktarma." */}
      {isBulkModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#1c1b1b] border border-[#514532]/30 rounded-xl p-6 max-w-2xl w-full space-y-4 max-h-[85vh] overflow-y-auto" data-testid="bulk-modal">
            <div className="flex items-center justify-between border-b border-[#514532]/20 pb-4">
              <div>
                <h3 className="text-base font-bold text-[#e5e2e1] uppercase">Toplu Sayaç Girişi</h3>
                <p className="text-xs text-[#d5c4ab] mt-1">Excel'den kopyalayıp yapıştırın: her satır "PLAKA[TAB/VİRGÜL]DEĞER" (en fazla 50 araç).</p>
              </div>
              <button onClick={() => setIsBulkModalOpen(false)} className="text-[#d5c4ab] hover:text-[#e5e2e1] cursor-pointer">
                <span className="material-symbols-outlined text-lg">close</span>
              </button>
            </div>

            <textarea
              data-testid="bulk-paste-textarea"
              value={bulkPasteText}
              onChange={(e) => { setBulkPasteText(e.target.value); setBulkResults(null); }}
              placeholder={'34 ABC 123\t45000\n34 DEF 456\t12800'}
              rows={8}
              className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] font-mono text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
            />

            {bulkPreview.length > 0 && !bulkResults && (
              <div data-testid="bulk-preview">
                <p className="text-[10px] font-mono text-[#d5c4ab] uppercase mb-2">{bulkPreview.length} satır ayrıştırıldı</p>
                <div className="max-h-40 overflow-y-auto space-y-1">
                  {bulkPreview.map((item, i) => (
                    <div key={i} className="text-xs text-[#e5e2e1] font-mono flex justify-between bg-[#0e0e0e] px-3 py-1.5 rounded">
                      <span>{item.vehiclePlate}</span>
                      <span>{item.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {bulkResults && (
              <div data-testid="bulk-results" className="space-y-1">
                {bulkResults.map((r, i) => (
                  <div
                    key={i}
                    data-testid="bulk-result-row"
                    data-ok={r.ok}
                    className={`text-xs font-mono flex justify-between px-3 py-1.5 rounded ${r.ok ? 'bg-[#a1e8a2]/10 text-[#a1e8a2]' : 'bg-[#ffb4ab]/10 text-[#ffb4ab]'}`}
                  >
                    <span>{r.vehiclePlate}</span>
                    <span>{r.ok ? (r.suspicious ? 'ONAYLI (şüpheli)' : 'OK') : (r.error === 'METER_READING_SUSPICIOUS' ? 'Şüpheli — tekil girişle onaylayın' : r.message || r.error)}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center justify-end space-x-3 pt-2 border-t border-[#514532]/20">
              <button onClick={() => setIsBulkModalOpen(false)} className="px-4 py-2 bg-[#20201f] text-[#d5c4ab] rounded-md text-xs font-bold cursor-pointer">
                Kapat
              </button>
              <button
                data-testid="bulk-save"
                onClick={handleBulkSave}
                disabled={bulkPreview.length === 0 || isBulkSaving}
                className="px-5 py-2 bg-gradient-to-r from-[#ffb800] to-[#ff8a00] disabled:opacity-50 text-[#412d00] rounded-md text-xs font-black cursor-pointer transition-all"
              >
                {isBulkSaving ? 'Kaydediliyor...' : `Topluca Kaydet (${bulkPreview.length})`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
