import React, { useState, useEffect } from 'react';
import { useApp } from '../../context/AppContext';

export const SettingsPage: React.FC = () => {
  const { 
    currentCompany, 
    kFactor, 
    calibrationMultiplier, 
    setCalibrationMultiplier, 
    saveEEPROMCalibration, 
    showToast,
    isManagerMode
  } = useApp();

  // Wizard state: 'IDLE' | 'FLOWING' | 'INPUT_VOLUME' | 'SAVED'
  const [calibState, setCalibState] = useState<'IDLE' | 'FLOWING' | 'INPUT_VOLUME' | 'SAVED'>('IDLE');
  const [showConfirmModal, setShowConfirmModal] = useState<boolean>(false);
  
  // Calibration variables as required
  const [pulsSayaci, setPulsSayaci] = useState<number>(0);
  const [actualVolumeLiters, setActualVolumeLiters] = useState<number>(10.0);
  const [isFlowSimulating, setIsFlowSimulating] = useState<boolean>(false);
  
  // General Manual Settings
  const [manualMultiplier, setManualMultiplier] = useState<number>(calibrationMultiplier);
  const [smsAlerts, setSmsAlerts] = useState<boolean>(true);
  const [emailAlerts, setEmailAlerts] = useState<boolean>(true);

  // Live simulation of Hardware Interrupt pulses during FLOWING step
  useEffect(() => {
    let interval: any;
    if (calibState === 'FLOWING' && isFlowSimulating) {
      interval = setInterval(() => {
        setPulsSayaci(prev => prev + 25); // Simulating 25 pulses per tick
      }, 200);
    }
    return () => clearInterval(interval);
  }, [calibState, isFlowSimulating]);

  // Step 1: Start Calibration - Reset puls_sayaci
  const handleStartCalibration = () => {
    setPulsSayaci(0);
    setIsFlowSimulating(true);
    setCalibState('FLOWING');
    showToast('Kalibrasyon Modu Başlatıldı: Hardware Interrupt aktifleştirildi, puls_sayaci sıfırlandı.', 'info');
  };

  // Step 2: Stop Flow & Finish Measurement
  const handleStopFlow = () => {
    setIsFlowSimulating(false);
    setCalibState('INPUT_VOLUME');
    showToast(`Akış durduruldu. Biriken Toplam Sinyal: ${pulsSayaci} Puls.`, 'info');
  };

  // Step 3 & 4 & 5: Calculation and EEPROM Flash Storage
  const calculatedNewKFactor = actualVolumeLiters > 0 && pulsSayaci > 0 
    ? Number((pulsSayaci / actualVolumeLiters).toFixed(2))
    : kFactor;

  const calculatedNewMultiplier = actualVolumeLiters > 0 && pulsSayaci > 0 
    ? Number((actualVolumeLiters / pulsSayaci).toFixed(5))
    : calibrationMultiplier;

  const handleSaveToEEPROM = () => {
    if (actualVolumeLiters <= 0 || pulsSayaci <= 0) {
      showToast('Lütfen geçerli bir puls sayısı ve gerçek mazot litresi giriniz.', 'error');
      return;
    }

    saveEEPROMCalibration(calculatedNewKFactor, calculatedNewMultiplier);
    setManualMultiplier(calculatedNewMultiplier);
    setCalibState('SAVED');
  };

  const handleManualSave = (e: React.FormEvent) => {
    e.preventDefault();
    setCalibrationMultiplier(manualMultiplier);
    showToast(`Sistem kalibrasyon ayarları güncellendi (Çarpan: x${manualMultiplier})`, 'success');
  };

  return (
    <div className="space-y-6 max-w-4xl">
      
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 bg-[#1c1b1b] border border-[#514532]/25 p-6 rounded-xl">
        <div className="space-y-1">
          <span className="text-xs font-mono font-bold text-[#ffdca1] uppercase tracking-widest block">
            FİRMA YAPILANDIRMASI & IOT DONANIM HASSASİYETİ
          </span>
          <h1 className="text-2xl font-black text-[#e5e2e1] uppercase tracking-tight">
            SİSTEM VE KALİBRASYON AYARLARI
          </h1>
          <p className="text-xs text-[#d5c4ab]">
            {currentCompany.name} firmasına özel donanım kalibrasyon modu (EEPROM saklama) ve alarm tercihleri.
          </p>
        </div>

        <div className="flex items-center space-x-3 bg-[#0e0e0e] border border-[#514532]/30 px-4 py-2 rounded-lg">
          <span className="w-2.5 h-2.5 rounded-full bg-[#a1e8a2] animate-pulse"></span>
          <div className="text-left font-mono">
            <span className="text-[10px] text-[#d5c4ab] block uppercase">EEPROM K-FAKTÖRÜ</span>
            <span className="text-xs font-bold text-[#a1e8a2]">{kFactor.toFixed(2)} Pulse/L (x{calibrationMultiplier})</span>
          </div>
        </div>
      </div>

      {/* Main Calibration Wizard Box (ONLY VISIBLE IN MANAGER MODE) */}
      {isManagerMode ? (
        <div className="bg-[#1c1b1b] border border-[#ffb800]/40 rounded-xl p-6 space-y-6 shadow-xl relative overflow-hidden">
          <div className="absolute top-0 right-0 bg-[#ffb800]/10 text-[#ffb800] text-[10px] font-mono font-bold px-3 py-1 rounded-bl-xl border-l border-b border-[#ffb800]/30 flex items-center space-x-1">
            <span className="material-symbols-outlined text-xs">bolt</span>
            <span>HARDWARE INTERRUPT AKTİF (GPIO 18)</span>
          </div>

          <div className="border-b border-[#514532]/20 pb-3">
            <h2 className="text-base font-black text-[#ffdca1] uppercase font-mono flex items-center space-x-2">
              <span className="material-symbols-outlined text-lg text-[#ffb800]">build_circle</span>
              <span>Pompa Debimetre "Kalibrasyon Modu" (Saha Doğrulama)</span>
            </h2>
            <p className="text-xs text-[#d5c4ab] mt-1">
              Akışmetreden gelen puls sinyallerini kaçırmamak için donanımsal <strong>Hardware Interrupt</strong> kullanılır. Aşağıdaki adımları takip ederek pompayı kalibre ediniz.
            </p>
          </div>

          {/* Wizard Steps Stepper Bar */}
          <div className="grid grid-cols-4 gap-2 text-center select-none">
            {[
              { step: 'IDLE', num: '1', title: 'Test Başlangıcı' },
              { step: 'FLOWING', num: '2', title: 'Akış İşlemi' },
              { step: 'INPUT_VOLUME', num: '3', title: 'Gerçek Veri Girişi' },
              { step: 'SAVED', num: '4', title: 'EEPROM Kaydı' }
            ].map((item) => (
              <div 
                key={item.step} 
                className={`p-2.5 rounded-lg border text-xs font-mono transition-all ${
                  calibState === item.step
                    ? 'bg-[#ffb800]/20 border-[#ffb800] text-[#ffdca1] font-bold shadow'
                    : 'bg-[#141313] border-[#514532]/20 text-[#d5c4ab]/60'
                }`}
              >
                <span className="block text-[10px] font-bold opacity-80">ADIM {item.num}</span>
                <span className="truncate block">{item.title}</span>
              </div>
            ))}
          </div>

          {/* STEP 1: IDLE / START */}
          {calibState === 'IDLE' && (
            <div className="bg-[#141313] border border-[#514532]/30 rounded-xl p-6 space-y-4 text-center">
              <div className="w-12 h-12 bg-[#ffb800]/10 border border-[#ffb800]/30 text-[#ffb800] rounded-2xl flex items-center justify-center mx-auto">
                <span className="material-symbols-outlined text-2xl">play_arrow</span>
              </div>
              <div className="space-y-1 max-w-md mx-auto">
                <h3 className="text-sm font-bold text-[#e5e2e1] uppercase font-mono">1. Test Başlangıcı Hazırlığı</h3>
                <p className="text-xs text-[#d5c4ab]/80">
                  Hacmi kesin olarak bilinen bir kabı (örneğin tam 10 Litre) pompanın altına yerleştiriniz. Butona bastığınızda <code className="text-[#a1e8a2] font-mono font-bold">puls_sayaci</code> sıfırlanacaktır.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowConfirmModal(true)}
                className="px-8 py-3 bg-gradient-to-r from-[#ffb800] to-[#ff8a00] hover:from-[#ffdca1] hover:to-[#ffb77f] text-[#412d00] font-extrabold rounded-xl text-xs uppercase tracking-wider transition-all cursor-pointer shadow-lg inline-flex items-center space-x-2"
              >
                <span className="material-symbols-outlined text-base">power_settings_new</span>
                <span>Kalibrasyonu Başlat (Puls Sayacını Sıfırla)</span>
              </button>
            </div>
          )}

          {/* STEP 2: FLOWING / ACCUMULATING PULSES */}
          {calibState === 'FLOWING' && (
            <div className="bg-[#141313] border border-[#a1e8a2]/40 rounded-xl p-6 space-y-5 text-center">
              <div className="flex justify-between items-center bg-[#1c1b1b] px-4 py-2 rounded-lg border border-[#353535]">
                <span className="text-xs font-mono text-[#a1e8a2] flex items-center space-x-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#a1e8a2] animate-ping"></span>
                  <span>POMPA AKIŞI AKTİF (GPIO 18 INTERRUPT DİNLENİYOR)</span>
                </span>
                <span className="text-[11px] font-mono text-[#d5c4ab]">Puls Kaçırma: %0</span>
              </div>

              <div className="space-y-2 py-4">
                <span className="text-xs font-mono text-[#d5c4ab] uppercase block">Biriken Toplam Puls (puls_sayaci)</span>
                <div className="text-5xl font-black font-mono text-[#a1e8a2] tracking-wider bg-[#0e0e0e] border border-[#a1e8a2]/30 py-4 px-6 rounded-2xl inline-block min-w-[240px] shadow-inner">
                  {pulsSayaci} <span className="text-base text-[#d5c4ab]">puls</span>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={() => setPulsSayaci(prev => prev + 100)}
                  className="px-4 py-2 bg-[#20201f] hover:bg-[#353535] border border-[#514532]/40 text-[#e5e2e1] font-mono text-xs rounded-lg transition-colors cursor-pointer"
                >
                  +100 Puls Ekle (Test)
                </button>
                <button
                  type="button"
                  onClick={() => setIsFlowSimulating(!isFlowSimulating)}
                  className={`px-4 py-2 font-mono text-xs rounded-lg border transition-colors cursor-pointer ${
                    isFlowSimulating ? 'bg-[#ffb4ab]/10 border-[#ffb4ab]/40 text-[#ffb4ab]' : 'bg-[#a1e8a2]/10 border-[#a1e8a2]/40 text-[#a1e8a2]'
                  }`}
                >
                  {isFlowSimulating ? 'Otomatik Akışı Duraklat' : 'Otomatik Akışı Sürdür'}
                </button>
              </div>

              <p className="text-xs text-[#d5c4ab]/80 max-w-md mx-auto">
                Hacmi bilinen kaba (örneğin 10 Litre) mazot dolumu tamamlandığında pompayı durdurun ve aşağıdaki buton ile ölçümü sonlandırın.
              </p>

              <button
                type="button"
                onClick={handleStopFlow}
                className="px-8 py-3 bg-[#ffb4ab] hover:bg-[#ffdad6] text-[#601410] font-extrabold rounded-xl text-xs uppercase tracking-wider transition-all cursor-pointer shadow-lg inline-flex items-center space-x-2"
              >
                <span className="material-symbols-outlined text-base">stop_circle</span>
                <span>Akışı Durdur & Ölçümü Tamamla</span>
              </button>
            </div>
          )}

          {/* STEP 3: INPUT ACTUAL VOLUME & CALCULATE */}
          {calibState === 'INPUT_VOLUME' && (
            <div className="bg-[#141313] border border-[#ffdca1]/40 rounded-xl p-6 space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                
                {/* Left Column: Input Question */}
                <div className="space-y-4">
                  <h3 className="text-xs font-mono font-bold text-[#ffdca1] uppercase border-b border-[#514532]/20 pb-2">
                    3. Veri Girişi (Gerçek Hacim)
                  </h3>

                  <div className="bg-[#1c1b1b] border border-[#514532]/30 p-3 rounded-lg flex justify-between items-center font-mono">
                    <span className="text-xs text-[#d5c4ab]">Ölçülen Toplam Puls:</span>
                    <span className="text-base text-[#a1e8a2] font-bold">{pulsSayaci} Puls</span>
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-mono font-bold text-[#e5e2e1] block">
                      Kaba dolan gerçek miktarı litre cinsinden giriniz:
                    </label>
                    <div className="relative">
                      <input
                        type="number"
                        step="0.1"
                        min="0.1"
                        value={actualVolumeLiters}
                        onChange={(e) => setActualVolumeLiters(Number(e.target.value))}
                        className="w-full bg-[#0e0e0e] border border-[#ffdca1]/50 text-[#ffdca1] font-mono text-lg font-bold rounded-lg p-3 outline-none focus:border-[#ffb800]"
                      />
                      <span className="absolute right-3 top-4 text-xs font-mono text-[#d5c4ab]">Litre</span>
                    </div>
                    <p className="text-[11px] text-[#d5c4ab]/70 font-mono">
                      Örn: Tam 10 Litrelik kalibrasyon kabı doldurulduysa "10" yazınız.
                    </p>
                  </div>
                </div>

                {/* Right Column: Calculated Results */}
                <div className="bg-[#1c1b1b] border border-[#514532]/30 rounded-xl p-4 space-y-3">
                  <h3 className="text-xs font-mono font-bold text-[#a1e8a2] uppercase border-b border-[#514532]/20 pb-2">
                    4. Hesaplanan Yeni K-Faktörü
                  </h3>

                  <div className="space-y-2 font-mono text-xs">
                    <div className="flex justify-between">
                      <span className="text-[#d5c4ab]">Formül:</span>
                      <span className="text-[#e5e2e1]">Toplam Puls / Gerçek Litre</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[#d5c4ab]">Mevcut K-Faktörü:</span>
                      <span className="text-[#d5c4ab]">{kFactor.toFixed(2)} Pulse/L</span>
                    </div>
                    <div className="pt-2 border-t border-[#514532]/30 flex justify-between items-center">
                      <span className="text-[#ffdca1] font-bold">Yeni K-Faktörü:</span>
                      <span className="text-base text-[#a1e8a2] font-black bg-[#a1e8a2]/10 px-2 py-0.5 rounded border border-[#a1e8a2]/30">
                        {calculatedNewKFactor} Pulse/L
                      </span>
                    </div>
                    <div className="flex justify-between items-center text-[11px]">
                      <span className="text-[#d5c4ab]">Hesaplanan Çarpan:</span>
                      <span className="text-[#ffdca1]">x{calculatedNewMultiplier}</span>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={handleSaveToEEPROM}
                    className="w-full py-3 bg-gradient-to-r from-[#ffb800] to-[#ff8a00] hover:from-[#ffdca1] hover:to-[#ffb77f] text-[#412d00] font-black rounded-xl text-xs uppercase tracking-wider transition-all cursor-pointer shadow-md mt-2 flex items-center justify-center space-x-2"
                  >
                    <span className="material-symbols-outlined text-base">memory</span>
                    <span>K-Faktörünü EEPROM/Flash Hafızaya Kaydet</span>
                  </button>
                </div>

              </div>
            </div>
          )}

          {/* STEP 4: EEPROM SAVED CONFIRMATION */}
          {calibState === 'SAVED' && (
            <div className="bg-[#141313] border border-[#a1e8a2]/50 rounded-xl p-6 space-y-4 text-center">
              <div className="w-12 h-12 bg-[#a1e8a2]/10 border border-[#a1e8a2]/30 text-[#a1e8a2] rounded-2xl flex items-center justify-center mx-auto">
                <span className="material-symbols-outlined text-2xl">verified</span>
              </div>

              <div className="space-y-1">
                <h3 className="text-base font-black text-[#a1e8a2] uppercase font-mono">
                  EEPROM / Flash Hafıza Kaydı Başarılı!
                </h3>
                <p className="text-xs text-[#d5c4ab] max-w-lg mx-auto">
                  Yeni <strong>K_Faktoru ({kFactor} Pulse/L)</strong> donanım kartındaki silinmez flash belleğe yazıldı. Cihaz elektrikten kesilse bile kalibrasyon korunacaktır.
                </p>
              </div>

              <div className="bg-[#1c1b1b] border border-[#353535] rounded-xl p-4 max-w-md mx-auto grid grid-cols-2 gap-4 font-mono text-xs">
                <div>
                  <span className="text-[10px] text-[#d5c4ab] block uppercase">YENİ K-FAKTÖRÜ</span>
                  <span className="text-sm font-bold text-[#a1e8a2]">{kFactor} Pulse/L</span>
                </div>
                <div>
                  <span className="text-[10px] text-[#d5c4ab] block uppercase">LİTRE ÇARPANI</span>
                  <span className="text-sm font-bold text-[#ffdca1]">x{calibrationMultiplier}</span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setCalibState('IDLE')}
                className="px-6 py-2.5 bg-[#20201f] hover:bg-[#353535] border border-[#514532]/40 text-[#e5e2e1] font-mono text-xs rounded-xl transition-colors cursor-pointer"
              >
                Yeni Kalibrasyon Testi Başlat
              </button>
            </div>
          )}

        </div>
      ) : (
        <div className="bg-[#1c1b1b] border border-[#353535] rounded-xl p-6 flex items-center space-x-4">
          <div className="w-10 h-10 rounded-xl bg-[#a1e8a2]/10 border border-[#a1e8a2]/30 text-[#a1e8a2] flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-xl">lock</span>
          </div>
          <div>
            <h3 className="text-xs font-bold text-[#e5e2e1] font-mono uppercase">
              Saha Modu Kısıtlaması: Pompa Kalibrasyonu Kilitli
            </h3>
            <p className="text-xs text-[#d5c4ab] mt-0.5">
              Pompa debimetre kalibrasyonu ve EEPROM K-Faktörü müdahaleleri güvenlik sebebiyle yalnızca <strong>Firma Yönetici Modunda</strong> yapılabilmektedir.
            </p>
          </div>
        </div>
      )}

      {/* Manual Fine-Tuning & Notification Channels */}
      <form onSubmit={handleManualSave} className="bg-[#1c1b1b] border border-[#514532]/25 rounded-xl p-6 space-y-6">
        
        {/* Manuel Çarpan Ayarı (Sadece Yönetici Modunda Görünür) */}
        {isManagerMode && (
          <div className="space-y-4">
            <h3 className="text-sm font-bold text-[#ffdca1] uppercase font-mono border-b border-[#514532]/20 pb-2 flex items-center space-x-2">
              <span className="material-symbols-outlined text-base text-[#ffb800]">tune</span>
              <span>2. Manuel Çarpan İnce Ayarı</span>
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-3">
                <label className="text-xs font-mono font-bold text-[#d5c4ab] block">
                  Manuel Litre Kalibrasyon Çarpanı (x)
                </label>
                <input
                  type="number"
                  step="0.0001"
                  min="0.0001"
                  max="10.0000"
                  value={manualMultiplier}
                  onChange={(e) => setManualMultiplier(Number(e.target.value))}
                  className="w-full bg-[#0e0e0e] border border-[#514532]/40 text-[#ffdca1] font-mono text-base font-bold rounded-lg p-3 outline-none focus:border-[#ffdca1]"
                />
              </div>
              <div className="text-xs text-[#d5c4ab]/80 font-mono space-y-1 bg-[#141313] p-3 rounded-lg border border-[#514532]/20">
                <span className="text-[#ffdca1] font-bold block">💡 İpucu:</span>
                <p>Kalibrasyon sihirbazı otomatik olarak K-Faktörünü ve çarpanı hesaplayıp EEPROM'a yazar. Dilerseniz buradan elle doğrudan katsayı müdahalesi yapabilirsiniz.</p>
              </div>
            </div>
          </div>
        )}

        {/* Otomatik Alarm Kanalları */}
        <div className="space-y-4 pt-4 border-t border-[#514532]/20">
          <h3 className="text-sm font-bold text-[#ffdca1] uppercase font-mono border-b border-[#514532]/20 pb-2">
            3. Otomatik Alarm & Bildirim Kanalları
          </h3>

          <div className="space-y-3">
            <label className="flex items-center space-x-3 cursor-pointer">
              <input
                type="checkbox"
                checked={smsAlerts}
                onChange={(e) => setSmsAlerts(e.target.checked)}
                className="w-4 h-4 accent-[#ffb800]"
              />
              <span className="text-xs font-mono text-[#e5e2e1]">
                Kritik seviyede şantiye şeflerine SMS bildirimi gönder
              </span>
            </label>

            <label className="flex items-center space-x-3 cursor-pointer">
              <input
                type="checkbox"
                checked={emailAlerts}
                onChange={(e) => setEmailAlerts(e.target.checked)}
                className="w-4 h-4 accent-[#ffb800]"
              />
              <span className="text-xs font-mono text-[#e5e2e1]">
                Günlük ve haftalık ikmal özet raporlarını E-Posta olarak gönder
              </span>
            </label>
          </div>
        </div>

        <div className="pt-4 border-t border-[#514532]/20 flex justify-end">
          <button
            type="submit"
            className="px-6 py-2.5 bg-gradient-to-r from-[#ffb800] to-[#ff8a00] hover:from-[#ffdca1] hover:to-[#ffb77f] text-[#412d00] font-black rounded-md text-xs transition-all cursor-pointer shadow-sm"
          >
            Manuel Ayarları Kaydet
          </button>
        </div>

      </form>

      {/* Confirmation Warning Modal */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#1c1b1b] border border-[#ffb800]/50 rounded-2xl max-w-md w-full p-6 space-y-5 shadow-2xl animate-in fade-in zoom-in duration-200">
            
            <div className="flex items-center space-x-3 text-[#ffb800]">
              <div className="w-10 h-10 rounded-xl bg-[#ffb800]/10 border border-[#ffb800]/30 flex items-center justify-center shrink-0">
                <span className="material-symbols-outlined text-2xl">warning</span>
              </div>
              <div>
                <h3 className="font-extrabold text-sm text-[#e5e2e1] uppercase font-mono tracking-wide">
                  KALİBRASYON MODU BAŞLATMA UYARISI
                </h3>
                <span className="text-[10px] text-[#ffdca1] font-mono">Donanım Sıfırlama & Interrupt Kurulumu</span>
              </div>
            </div>

            <div className="bg-[#141313] border border-[#353535] rounded-xl p-4 space-y-3 text-xs text-[#d5c4ab] font-mono">
              <p className="leading-relaxed">
                Pompa debimetre kalibrasyon modu başlatılacaktır. Bu işlem <strong className="text-[#a1e8a2]">puls_sayaci</strong> değişkenini sıfırlayacak ve donanımsal kesmeyi (<span className="text-[#ffdca1]">GPIO 18 Interrupt</span>) aktifleştirecektir.
              </p>
              <div className="p-2.5 bg-[#ffb800]/10 border border-[#ffb800]/30 rounded-lg text-[11px] text-[#ffdca1] font-bold">
                ⚠️ Hacmi kesin olarak bilinen test kabınızın (Örn: 10 Litre) hazır olduğundan emin misiniz?
              </div>
            </div>

            <div className="flex items-center justify-end space-x-3 pt-1">
              <button
                type="button"
                onClick={() => setShowConfirmModal(false)}
                className="px-4 py-2.5 bg-[#20201f] hover:bg-[#353535] border border-[#514532]/40 text-[#e5e2e1] font-mono text-xs rounded-xl transition-colors cursor-pointer font-bold"
              >
                İptal / Vazgeç
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowConfirmModal(false);
                  handleStartCalibration();
                }}
                className="px-5 py-2.5 bg-gradient-to-r from-[#ffb800] to-[#ff8a00] hover:from-[#ffdca1] hover:to-[#ffb77f] text-[#412d00] font-black rounded-xl text-xs uppercase tracking-wider transition-all cursor-pointer shadow-lg flex items-center space-x-1.5"
              >
                <span className="material-symbols-outlined text-base">check_circle</span>
                <span>Evet, Kalibrasyonu Başlat</span>
              </button>
            </div>

          </div>
        </div>
      )}

    </div>
  );
};


