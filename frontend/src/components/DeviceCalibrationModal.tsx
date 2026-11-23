import React, { useEffect, useRef, useState } from 'react';
import { TenantHardwareDevice, CalibrationCommand } from '../types';
import { fetchCalibrationHistory, approveCalibration, rollbackCalibration, requestCalibration, CALIBRATION_STATUS_LABELS } from '../hooks/useCalibration';
import { useApp } from '../context/AppContext';
import { socket } from '../utils/socket';
import { CalibrationWizard } from './CalibrationWizard';

interface Props {
  device: TenantHardwareDevice;
  onClose: () => void;
}

// FE-814 AC: "Komut gönderim durumu net gösterilmelidir ... 'başarılı'
// izlenimi vermemelidir." ZAMAN_ASIMI/REDDEDILDI BİLEREK uyarı renginde
// (kırmızı/turuncu) — ONAYLANDI DIŞINDA hiçbir durum yeşil/başarı rengi almaz.
const STATUS_STYLES: Record<string, string> = {
  IKINCI_ONAY_BEKLIYOR: 'bg-[#ffb800]/10 text-[#ffdca1]',
  BEKLIYOR: 'bg-[#ffb800]/10 text-[#ffdca1]',
  ONAYLANDI: 'bg-[#a1e8a2]/10 text-[#a1e8a2]',
  REDDEDILDI: 'bg-[#ffb4ab]/10 text-[#ffb4ab]',
  ZAMAN_ASIMI: 'bg-[#ffb4ab]/10 text-[#ffb4ab]'
};

const PENDING_STATUSES = ['BEKLIYOR', 'IKINCI_ONAY_BEKLIYOR'];
const POLL_INTERVAL_MS = 4000;

/**
 * FE-814 (#145) — Kalibrasyon (K-factor) ekranı. FUEL-404.1 (komut/ack/
 * zaman aşımı/geri alma/ikinci onay) ZATEN tamdı, hiç frontend arayüzü
 * yoktu. Backend 'calibration:acked' gibi bir Socket.io olayı YAYINLAMIYOR
 * (sadece 'calibration:timeout', bkz. backend/src/index.ts sweep) — bu
 * yüzden ack/uygulandı durumunu yakalamak için BEKLIYOR/IKINCI_ONAY_BEKLIYOR
 * bir komut varken kısa aralıklı POLLING yapılıyor (TanStack Query DEĞİL,
 * useVehicleMaintenanceRecords/useMeterReadings İLE AYNI basit desen —
 * zaten var olan bir query kitaplığı entegrasyonu İCAT EDİLMEDİ); zaman
 * aşımı için EK OLARAK soket dinleniyor (anlık, pollingi beklemeden).
 */
export const DeviceCalibrationModal: React.FC<Props> = ({ device, onClose }) => {
  const { showToast, fetchTenantHardwareDevices } = useApp();
  const [history, setHistory] = useState<CalibrationCommand[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isApprovingId, setIsApprovingId] = useState<string | null>(null);
  const [isRollingBack, setIsRollingBack] = useState(false);
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [verifyingCommand, setVerifyingCommand] = useState<CalibrationCommand | null>(null);
  // CANLI YAKALANAN BULGU: FUEL-404.2'nin test-intake'i, cihazın ZATEN bir
  // k_factor'ü (baseline) OLMASINI şart koşuyor (yoksa 409 NO_BASELINE_K_FACTOR
  // — "sapma, ŞU ANKİ k_factor'e göre" hesaplanır, referans YOKSA hesaplanamaz).
  // Yeni/hiç kalibre edilmemiş bir cihazda sihirbaz BAŞLATILAMAZ — bu küçük
  // formla önce bir ilk (taban) değer tanımlanması sağlanıyor.
  const [baselineKFactor, setBaselineKFactor] = useState('');
  const [baselineReason, setBaselineReason] = useState('');
  const [isSavingBaseline, setIsSavingBaseline] = useState(false);
  const prevStatusesRef = useRef<Record<string, string>>({});

  const load = async () => {
    try {
      const rows = await fetchCalibrationHistory(device.deviceId);
      // Yeni ONAYLANDI/ZAMAN_ASIMI/REDDEDILDI'ye geçen bir satır varsa cihaz
      // listesini de tazele (k_factor DEĞİŞMİŞ olabilir, bkz. recordCalibrationAck).
      const prev = prevStatusesRef.current;
      const transitioned = rows.some((r) => prev[r.id] && prev[r.id] !== r.status);
      prevStatusesRef.current = Object.fromEntries(rows.map((r) => [r.id, r.status]));
      setHistory(rows);
      if (transitioned) await fetchTenantHardwareDevices();
    } catch (err: any) {
      showToast(`Kalibrasyon geçmişi getirilirken hata: ${err.message}`, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.deviceId]);

  // Beklemede bir komut varken kısa aralıklı yoklama.
  useEffect(() => {
    const hasPending = history.some((h) => PENDING_STATUSES.includes(h.status));
    if (!hasPending) return;
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history]);

  // ASIL AC: "Komut ulaşmadıysa ekran bunu net göstermeli." Zaman aşımı
  // sweep'i (backend/src/index.ts, 30s aralıklı) bu cihaz için tetiklenirse
  // ANINDA (pollingi beklemeden) yenile.
  useEffect(() => {
    const handleTimeout = (payload: { deviceId: string }) => {
      if (payload.deviceId === device.deviceId) load();
    };
    socket.on('calibration:timeout', handleTimeout);
    return () => { socket.off('calibration:timeout', handleTimeout); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.deviceId]);

  const handleApprove = async (commandId: string) => {
    setIsApprovingId(commandId);
    try {
      await approveCalibration(device.deviceId, commandId);
      showToast('İkinci onay verildi, komut cihaza gönderildi.');
      await load();
    } catch (err: any) {
      showToast(`Onay verilirken hata: ${err.message}`, 'error');
    } finally {
      setIsApprovingId(null);
    }
  };

  const handleRollback = async () => {
    setIsRollingBack(true);
    try {
      await rollbackCalibration(device.deviceId);
      showToast('Bir önceki onaylı kalibrasyona geri alma komutu gönderildi.');
      await load();
    } catch (err: any) {
      showToast(`Geri alma sırasında hata: ${err.message}`, 'error');
    } finally {
      setIsRollingBack(false);
    }
  };

  const handleSaveBaseline = async () => {
    const value = Number(baselineKFactor);
    if (!value || value <= 0 || !baselineReason.trim()) return;
    setIsSavingBaseline(true);
    try {
      await requestCalibration(device.deviceId, { newKFactor: value, reason: baselineReason.trim() });
      showToast('İlk kalibrasyon isteği cihaza gönderildi, ack bekleniyor.');
      setBaselineKFactor('');
      setBaselineReason('');
      await load();
    } catch (err: any) {
      showToast(`İlk kalibrasyon gönderilirken hata: ${err.message}`, 'error');
    } finally {
      setIsSavingBaseline(false);
    }
  };

  const lastApplied = history.find((h) => h.status === 'ONAYLANDI');
  const currentKFactor = lastApplied ? lastApplied.newKFactor : device.kFactor;
  const hasAnyCommand = history.length > 0;
  // ASIL AC: "Doğrulama alımı adımı." Yalnızca GERÇEKTEN uygulanmış (ONAYLANDI)
  // bir komut doğrulanabilir (backend de bunu zorunlu kılıyor, NO_BASELINE/
  // CALIBRATION_NOT_YET_ACKED ile reddeder) — bu yüzden buton SADECE varsa.
  const canVerify = !!lastApplied;

  return (
    <>
      <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
        <div data-testid="calibration-modal" className="bg-[#1c1b1b] border border-[#514532]/30 rounded-xl p-6 max-w-2xl w-full space-y-5 max-h-[85vh] overflow-y-auto">
          <div className="flex items-center justify-between border-b border-[#514532]/20 pb-4">
            <div>
              <span className="text-[10px] font-mono font-bold text-[#ffdca1] uppercase tracking-widest block">KALİBRASYON</span>
              <h3 className="text-base font-bold text-[#e5e2e1] uppercase">{device.name} ({device.deviceId})</h3>
            </div>
            <button data-testid="calibration-modal-close" onClick={onClose} className="text-[#d5c4ab] hover:text-[#e5e2e1] cursor-pointer">
              <span className="material-symbols-outlined text-lg">close</span>
            </button>
          </div>

          <div className="bg-[#0e0e0e] border border-[#514532]/30 rounded-md p-4 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-[10px] font-mono text-[#d5c4ab] block">GÜNCEL K-FACTOR</span>
                <span data-testid="current-k-factor" className="text-xl font-black text-[#ffdca1] font-mono">
                  {currentKFactor !== null ? currentKFactor.toFixed(4) : 'Henüz kalibre edilmedi'}
                </span>
              </div>
              {currentKFactor !== null && (
                <div className="flex items-center gap-2">
                  {canVerify && (
                    <button
                      data-testid="verification-intake-open"
                      onClick={() => { setVerifyingCommand(lastApplied!); setIsWizardOpen(true); }}
                      className="px-3 py-2 bg-[#20201f] hover:bg-[#2a2a2a] border border-[#514532]/30 text-[#d5c4ab] rounded-md text-[11px] font-bold cursor-pointer"
                    >
                      Doğrulama Alımı
                    </button>
                  )}
                  {lastApplied?.previousKFactor !== null && lastApplied !== undefined && (
                    <button
                      data-testid="rollback-calibration"
                      onClick={handleRollback}
                      disabled={isRollingBack}
                      className="px-3 py-2 bg-[#20201f] hover:bg-[#2a2a2a] border border-[#514532]/30 text-[#d5c4ab] rounded-md text-[11px] font-bold cursor-pointer disabled:opacity-40"
                    >
                      {isRollingBack ? 'Gönderiliyor...' : 'Geri Al'}
                    </button>
                  )}
                  <button
                    data-testid="test-intake-wizard-open"
                    onClick={() => { setVerifyingCommand(null); setIsWizardOpen(true); }}
                    className="px-4 py-2 bg-gradient-to-r from-[#ffb800] to-[#ff8a00] text-[#412d00] rounded-md text-[11px] font-black cursor-pointer"
                  >
                    Test Alım Sihirbazı
                  </button>
                </div>
              )}
            </div>

            {/* CANLI YAKALANAN BULGU: test-intake backend'de BİR BASELINE
                k_factor şart koşuyor (409 NO_BASELINE_K_FACTOR) — yeni bir
                cihazda sihirbaz başlatılamaz, önce bu küçük formla ilk
                (taban) değer tanımlanmalı. Henüz BEKLEMEDE bir istek varken
                tekrar gösterilmiyor (hasAnyCommand). */}
              {currentKFactor === null && !hasAnyCommand && (
              <div className="space-y-3 pt-3 border-t border-[#514532]/20" data-testid="baseline-form">
                <p className="text-[11px] text-[#d5c4ab]">
                  Bu cihaz için henüz bir k_factor tanımlı değil — test alım sihirbazını kullanabilmek için önce bir ilk (taban) değer gönderin (örn. pompanın etiketindeki nominal değer).
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2">
                  <input
                    type="number" step="0.0001"
                    data-testid="baseline-k-factor-input"
                    value={baselineKFactor}
                    onChange={(e) => setBaselineKFactor(e.target.value)}
                    placeholder="örn. 100.0000"
                    className="bg-[#131313] border border-[#514532]/30 text-[#e5e2e1] font-mono text-xs rounded-md p-2.5 focus:outline-none focus:border-[#ffdca1]"
                  />
                  <input
                    type="text"
                    data-testid="baseline-reason-input"
                    value={baselineReason}
                    onChange={(e) => setBaselineReason(e.target.value)}
                    placeholder="Gerekçe"
                    className="bg-[#131313] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-2.5 focus:outline-none focus:border-[#ffdca1]"
                  />
                  <button
                    data-testid="baseline-save"
                    onClick={handleSaveBaseline}
                    disabled={!baselineKFactor || !baselineReason.trim() || isSavingBaseline}
                    className="px-4 py-2.5 bg-[#ffdca1] text-[#412d00] rounded-md text-[11px] font-black cursor-pointer disabled:opacity-40"
                  >
                    {isSavingBaseline ? 'Gönderiliyor...' : 'Taban Değeri Gönder'}
                  </button>
                </div>
              </div>
            )}
          </div>

          <div>
            <h4 className="text-xs font-extrabold text-[#e5e2e1] uppercase tracking-wider mb-3">Kalibrasyon Geçmişi</h4>
            {isLoading ? (
              <p className="text-xs text-[#d5c4ab] text-center py-6">Yükleniyor...</p>
            ) : history.length === 0 ? (
              <p className="text-xs text-[#d5c4ab] text-center py-6">Bu cihaz için henüz bir kalibrasyon kaydı yok.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-[#514532]/20 text-[#d5c4ab] uppercase text-[10px] tracking-wider font-mono">
                      <th className="py-2 px-3">Tarih</th>
                      <th className="py-2 px-3">Eski → Yeni</th>
                      <th className="py-2 px-3">Gerekçe</th>
                      <th className="py-2 px-3">Durum</th>
                      <th className="py-2 px-3 text-right">İşlem</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#514532]/15 font-mono">
                    {history.map((h) => (
                      <tr key={h.id} data-testid="calibration-history-row" data-status={h.status}>
                        <td className="py-2.5 px-3 text-[#d5c4ab]">{new Date(h.createdAt).toLocaleString('tr-TR')}</td>
                        <td className="py-2.5 px-3 text-[#e5e2e1]">
                          {h.previousKFactor?.toFixed(4) ?? '—'} → {h.newKFactor.toFixed(4)}
                          {h.isRollback && <span className="ml-1 text-[10px] text-[#d5c4ab]">(geri alma)</span>}
                        </td>
                        <td className="py-2.5 px-3 text-[#d5c4ab] max-w-[160px] truncate" title={h.reason}>{h.reason}</td>
                        <td className="py-2.5 px-3">
                          <span data-testid="calibration-status-badge" className={`text-[10px] font-bold px-2 py-0.5 rounded ${STATUS_STYLES[h.status]}`}>
                            {CALIBRATION_STATUS_LABELS[h.status] || h.status}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          {h.status === 'IKINCI_ONAY_BEKLIYOR' && (
                            <button
                              data-testid="approve-calibration"
                              onClick={() => handleApprove(h.id)}
                              disabled={isApprovingId === h.id}
                              className="px-3 py-1 bg-[#ffdca1] text-[#412d00] rounded-md text-[11px] font-bold cursor-pointer disabled:opacity-40"
                            >
                              {isApprovingId === h.id ? 'Onaylanıyor...' : 'Onayla'}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      {isWizardOpen && (
        <CalibrationWizard
          device={device}
          verifiesCommand={verifyingCommand}
          onClose={() => setIsWizardOpen(false)}
          onRequested={async () => { await load(); }}
        />
      )}
    </>
  );
};
