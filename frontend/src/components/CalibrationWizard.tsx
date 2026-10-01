import React, { useState } from 'react';
import { TenantHardwareDevice, CalibrationCommand, CalibrationTestIntake } from '../types';
import { recordTestIntake, requestCalibration, RecordTestIntakeInput } from '../hooks/useCalibration';
import { useApp } from '../context/AppContext';

type WizardStep = 'REFERENCE' | 'DRAIN' | 'MEASURED' | 'DEVIATION' | 'CONFIRM' | 'DONE';

interface Props {
  device: TenantHardwareDevice;
  /** Doğrulama alımıysa (FE-814 Kapsam: "Doğrulama alımı adımı") hangi komutu doğruladığı. */
  verifiesCommand?: CalibrationCommand | null;
  onClose: () => void;
  onRequested: (command: CalibrationCommand) => void;
}

/**
 * FE-814 Kapsam: "Test alım sihirbazı: referans hacim girişi → test alımı →
 * ölçülen değer → sapma → önerilen K-factor → onay." Teknik Not: "Sihirbaz
 * sahada tek başına çalışan teknisyen tarafından kullanılacak; her adımda
 * ne yapması gerektiği açıkça yazılmalıdır." + "Önerilen K-factor kabul
 * edilmeden uygulanmamalı; kullanıcı değeri elle de düzenleyebilmelidir."
 *
 * FUEL-404.2 (backend) sapma/öneri hesabını ZATEN yapıyor (deviationRatio,
 * proposedKFactor, recommendedKFactor — son 2 test alımının ortalaması) —
 * bu sihirbaz yalnızca o API'yi adım adım bir akışa oturtuyor, formülü
 * TEKRARLAMIYOR.
 */
export const CalibrationWizard: React.FC<Props> = ({ device, verifiesCommand, onClose, onRequested }) => {
  const { tanks, showToast } = useApp();
  const [step, setStep] = useState<WizardStep>('REFERENCE');
  const [referenceVolumeLiters, setReferenceVolumeLiters] = useState('');
  const [tankName, setTankName] = useState(device.tankName || tanks.find(t => t.siteName === device.siteName)?.name || '');
  const [ambientTemp, setAmbientTemp] = useState('');
  const [measuredLiters, setMeasuredLiters] = useState('');
  const [isSubmittingIntake, setIsSubmittingIntake] = useState(false);
  const [intakeResult, setIntakeResult] = useState<{ intake: CalibrationTestIntake; recommendedKFactor: number; basedOnSingleMeasurement: boolean } | null>(null);
  const [finalKFactor, setFinalKFactor] = useState('');
  const [reason, setReason] = useState('');
  const [isSubmittingCalibration, setIsSubmittingCalibration] = useState(false);

  const siteTanks = tanks.filter(t => t.siteName === device.siteName);

  const handleSubmitIntake = async () => {
    const refVol = Number(referenceVolumeLiters);
    const measured = Number(measuredLiters);
    if (!tankName || !refVol || refVol <= 0 || !measured || measured <= 0) return;
    setIsSubmittingIntake(true);
    try {
      const input: RecordTestIntakeInput = {
        tankName,
        siteName: device.siteName,
        referenceVolumeLiters: refVol,
        measuredLiters: measured,
        ambientTemperatureCelsius: ambientTemp ? Number(ambientTemp) : undefined,
        verifiesCalibrationCommandId: verifiesCommand?.id
      };
      const result = await recordTestIntake(device.deviceId, input);
      setIntakeResult(result);
      setFinalKFactor(result.recommendedKFactor.toFixed(4));
      setStep('DEVIATION');
    } catch (err: any) {
      showToast(`Test alımı kaydedilirken hata: ${err.message}`, 'error');
    } finally {
      setIsSubmittingIntake(false);
    }
  };

  const handleSubmitCalibration = async () => {
    const value = Number(finalKFactor);
    if (!value || value <= 0 || !reason.trim()) return;
    setIsSubmittingCalibration(true);
    try {
      const command = await requestCalibration(device.deviceId, {
        newKFactor: value,
        reason: reason.trim(),
        referenceMeasurement: intakeResult ? {
          referenceVolumeLiters: intakeResult.intake.referenceVolumeLiters,
          measuredLiters: intakeResult.intake.measuredLiters,
          ambientTemperatureCelsius: intakeResult.intake.ambientTemperatureCelsius ?? undefined
        } : undefined
      });
      onRequested(command);
      setStep('DONE');
    } catch (err: any) {
      showToast(`Kalibrasyon isteği gönderilirken hata: ${err.message}`, 'error');
    } finally {
      setIsSubmittingCalibration(false);
    }
  };

  const stepIndex = { REFERENCE: 1, DRAIN: 2, MEASURED: 3, DEVIATION: 4, CONFIRM: 5, DONE: 6 }[step];

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div data-testid="calibration-wizard" className="bg-[#1c1b1b] border border-[#514532]/30 rounded-xl p-6 max-w-lg w-full space-y-5 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-[#514532]/20 pb-4">
          <div>
            <span className="text-[10px] font-mono font-bold text-[#ffdca1] uppercase tracking-widest block">
              {verifiesCommand ? 'DOĞRULAMA ALIMI' : 'TEST ALIM SİHİRBAZI'} — ADIM {stepIndex}/6
            </span>
            <h3 className="text-base font-bold text-[#e5e2e1] uppercase">{device.name} ({device.deviceId})</h3>
          </div>
          <button data-testid="calibration-wizard-close" onClick={onClose} className="text-[#d5c4ab] hover:text-[#e5e2e1] cursor-pointer">
            <span className="material-symbols-outlined text-lg">close</span>
          </button>
        </div>

        {step === 'REFERENCE' && (
          <div className="space-y-4">
            <p className="text-xs text-[#d5c4ab]">
              <strong className="text-[#ffdca1]">1. Adım:</strong> Kalibre edilmiş bir referans kap kullanın. Kabın hacmini ve ikmali hangi tanktan çektiğinizi girin.
            </p>
            <div>
              <label className="text-[10px] font-mono text-[#d5c4ab] block mb-1">Tank</label>
              <select
                data-testid="wizard-tank-select"
                value={tankName}
                onChange={(e) => setTankName(e.target.value)}
                className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
              >
                <option value="">Seçiniz...</option>
                {siteTanks.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-mono text-[#d5c4ab] block mb-1">Referans Kap Hacmi (Litre)</label>
              <input
                type="number"
                data-testid="wizard-reference-volume"
                value={referenceVolumeLiters}
                onChange={(e) => setReferenceVolumeLiters(e.target.value)}
                placeholder="örn. 200"
                className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] font-mono text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
              />
            </div>
            <div>
              <label className="text-[10px] font-mono text-[#d5c4ab] block mb-1">Ortam Sıcaklığı °C (opsiyonel)</label>
              <input
                type="number"
                value={ambientTemp}
                onChange={(e) => setAmbientTemp(e.target.value)}
                className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] font-mono text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
              />
            </div>
            <button
              data-testid="wizard-next"
              onClick={() => setStep('DRAIN')}
              disabled={!tankName || !referenceVolumeLiters || Number(referenceVolumeLiters) <= 0}
              className="w-full py-3 bg-[#ffdca1] text-[#412d00] rounded-md text-xs font-black cursor-pointer disabled:opacity-40"
            >
              İleri
            </button>
          </div>
        )}

        {step === 'DRAIN' && (
          <div className="space-y-4">
            <p className="text-xs text-[#d5c4ab]">
              <strong className="text-[#ffdca1]">2. Adım — Test Alımı:</strong> Pompayı ({device.name}) başlatıp referans kabınıza tam olarak <strong className="text-[#e5e2e1]">{referenceVolumeLiters} L</strong> hedefleyerek ikmal yapın. Pompa durduğunda kaptaki GERÇEK hacmi ölçmeye hazır olun.
            </p>
            <div className="flex items-center gap-3">
              <button onClick={() => setStep('REFERENCE')} className="flex-1 py-3 bg-[#20201f] text-[#d5c4ab] rounded-md text-xs font-bold cursor-pointer">Geri</button>
              <button data-testid="wizard-next" onClick={() => setStep('MEASURED')} className="flex-1 py-3 bg-[#ffdca1] text-[#412d00] rounded-md text-xs font-black cursor-pointer">
                İkmal Tamamlandı, İleri
              </button>
            </div>
          </div>
        )}

        {step === 'MEASURED' && (
          <div className="space-y-4">
            <p className="text-xs text-[#d5c4ab]">
              <strong className="text-[#ffdca1]">3. Adım:</strong> Referans kaptaki ölçülen GERÇEK hacmi girin (pompanın gösterdiği/kaydettiği değeri DEĞİL, kabı okuyarak ölçtüğünüz değeri).
            </p>
            <div>
              <label className="text-[10px] font-mono text-[#d5c4ab] block mb-1">Ölçülen Hacim (Litre)</label>
              <input
                type="number"
                data-testid="wizard-measured-value"
                value={measuredLiters}
                onChange={(e) => setMeasuredLiters(e.target.value)}
                placeholder="örn. 204.5"
                autoFocus
                className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] font-mono text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
              />
            </div>
            <div className="flex items-center gap-3">
              <button onClick={() => setStep('DRAIN')} className="flex-1 py-3 bg-[#20201f] text-[#d5c4ab] rounded-md text-xs font-bold cursor-pointer">Geri</button>
              <button
                data-testid="wizard-next"
                onClick={handleSubmitIntake}
                disabled={!measuredLiters || Number(measuredLiters) <= 0 || isSubmittingIntake}
                className="flex-1 py-3 bg-[#ffdca1] text-[#412d00] rounded-md text-xs font-black cursor-pointer disabled:opacity-40"
              >
                {isSubmittingIntake ? 'Hesaplanıyor...' : 'Sapmayı Hesapla'}
              </button>
            </div>
          </div>
        )}

        {step === 'DEVIATION' && intakeResult && (
          <div className="space-y-4" data-testid="wizard-deviation-result">
            <p className="text-xs text-[#d5c4ab]">
              <strong className="text-[#ffdca1]">4. Adım — Sapma:</strong> Referans ile ölçülen arasındaki fark ve önerilen K-factor:
            </p>
            <div className="bg-[#0e0e0e] border border-[#514532]/30 rounded-md p-4 space-y-2 text-xs font-mono">
              <div className="flex justify-between"><span className="text-[#d5c4ab]">Referans</span><span className="text-[#e5e2e1]">{intakeResult.intake.referenceVolumeLiters} L</span></div>
              <div className="flex justify-between"><span className="text-[#d5c4ab]">Ölçülen</span><span className="text-[#e5e2e1]">{intakeResult.intake.measuredLiters} L</span></div>
              <div className="flex justify-between">
                <span className="text-[#d5c4ab]">Sapma</span>
                <span data-testid="wizard-deviation-pct" className={intakeResult.intake.deviationRatio > 0.05 ? 'text-[#ffb4ab] font-bold' : 'text-[#a1e8a2] font-bold'}>
                  %{(intakeResult.intake.deviationRatio * 100).toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between"><span className="text-[#d5c4ab]">Şu anki K-factor</span><span className="text-[#e5e2e1]">{intakeResult.intake.kFactorAtTest.toFixed(4)}</span></div>
              <div className="flex justify-between border-t border-[#514532]/20 pt-2"><span className="text-[#ffdca1] font-bold">Önerilen K-factor</span><span data-testid="wizard-recommended-k" className="text-[#ffdca1] font-bold">{intakeResult.recommendedKFactor.toFixed(4)}</span></div>
            </div>
            {intakeResult.basedOnSingleMeasurement && (
              <p data-testid="wizard-single-measurement-warning" className="text-[10px] text-[#ffb77f] bg-[#2a1f10] border border-[#ffb800]/30 rounded-md p-2">
                Bu öneri tek ölçüme dayanıyor — güvenilir bir ortalama için en az bir test alımı daha yapılması önerilir.
              </p>
            )}
            <div className="flex items-center gap-3">
              <button onClick={() => setStep('MEASURED')} className="flex-1 py-3 bg-[#20201f] text-[#d5c4ab] rounded-md text-xs font-bold cursor-pointer">Geri</button>
              <button data-testid="wizard-next" onClick={() => setStep('CONFIRM')} className="flex-1 py-3 bg-[#ffdca1] text-[#412d00] rounded-md text-xs font-black cursor-pointer">
                İleri
              </button>
            </div>
          </div>
        )}

        {step === 'CONFIRM' && (
          <div className="space-y-4">
            <p className="text-xs text-[#d5c4ab]">
              <strong className="text-[#ffdca1]">5. Adım — Onay:</strong> Önerilen K-factor otomatik uygulanmaz — değeri gözden geçirin, isterseniz elle düzenleyin ve bir gerekçe yazıp gönderin.
            </p>
            <div>
              <label className="text-[10px] font-mono text-[#d5c4ab] block mb-1">Yeni K-factor</label>
              <input
                type="number"
                step="0.0001"
                data-testid="wizard-final-k-factor"
                value={finalKFactor}
                onChange={(e) => setFinalKFactor(e.target.value)}
                className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] font-mono text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
              />
            </div>
            <div>
              <label className="text-[10px] font-mono text-[#d5c4ab] block mb-1">Gerekçe</label>
              <input
                type="text"
                data-testid="wizard-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="örn. Test alımı sapması %4,2 — K-factor güncelleniyor"
                className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
              />
            </div>
            <div className="flex items-center gap-3">
              <button onClick={() => setStep('DEVIATION')} className="flex-1 py-3 bg-[#20201f] text-[#d5c4ab] rounded-md text-xs font-bold cursor-pointer">Geri</button>
              <button
                data-testid="wizard-submit"
                onClick={handleSubmitCalibration}
                disabled={!finalKFactor || Number(finalKFactor) <= 0 || !reason.trim() || isSubmittingCalibration}
                className="flex-1 py-3 bg-gradient-to-r from-[#ffb800] to-[#ff8a00] text-[#412d00] rounded-md text-xs font-black cursor-pointer disabled:opacity-40"
              >
                {isSubmittingCalibration ? 'Gönderiliyor...' : 'Kabul Et ve Gönder'}
              </button>
            </div>
          </div>
        )}

        {step === 'DONE' && (
          <div className="space-y-4 text-center py-4" data-testid="wizard-done">
            <span className="material-symbols-outlined text-4xl text-[#a1e8a2]">check_circle</span>
            <p className="text-xs text-[#d5c4ab]">
              Kalibrasyon isteği cihaza gönderildi. Komutun durumu (beklemede/uygulandı/ulaşmadı) ana ekrandaki geçmiş tablosunda takip edilebilir.
            </p>
            <button onClick={onClose} className="w-full py-3 bg-[#20201f] text-[#d5c4ab] rounded-md text-xs font-bold cursor-pointer">Kapat</button>
          </div>
        )}
      </div>
    </div>
  );
};
