import React, { useEffect, useState } from 'react';
import { Vehicle, VehicleMaintenanceRecord } from '../types';
import { fetchVehicleMaintenanceRecords, createVehicleMaintenanceRecord } from '../hooks/useVehicleMaintenanceRecords';
import { useApp } from '../context/AppContext';

interface Props {
  vehicle: Vehicle;
  onClose: () => void;
}

// Backend'in createVehicleMaintenanceRecordSchema'sındaki (zod enum) SABİT
// değerlerle BİREBİR aynı olmalı — serbest metin gönderirse 400 alır.
const MAINTENANCE_TYPES: { value: string; label: string }[] = [
  { value: 'PERİYODİK_BAKIM', label: 'Periyodik Bakım' },
  { value: 'LASTİK', label: 'Lastik' },
  { value: 'YAĞ_DEĞİŞİMİ', label: 'Yağ Değişimi' },
  { value: 'ARIZA_ONARIMI', label: 'Arıza Onarımı' },
  { value: 'DİĞER', label: 'Diğer' }
];

/**
 * FLEET-1407 AC: "Bakım kayıtları araç kartında listelenmelidir." Backend
 * (createVehicleMaintenanceRecord/getVehicleMaintenanceRecords, bakım
 * öncesi/sonrası tüketim karşılaştırması, hatırlatma sweep'i) ZATEN
 * tamamdı — eksik olan yalnızca bu ekrandı.
 */
export const VehicleMaintenanceModal: React.FC<Props> = ({ vehicle, onClose }) => {
  const { showToast } = useApp();
  const [records, setRecords] = useState<VehicleMaintenanceRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const [maintenanceType, setMaintenanceType] = useState(MAINTENANCE_TYPES[0].value);
  const [performedAt, setPerformedAt] = useState(new Date().toISOString().slice(0, 10));
  const [odometerValue, setOdometerValue] = useState('');
  const [costAmount, setCostAmount] = useState('');
  const [operationsDescription, setOperationsDescription] = useState('');
  const [nextDueDate, setNextDueDate] = useState('');
  const [nextDueMeterValue, setNextDueMeterValue] = useState('');

  const load = async () => {
    setIsLoading(true);
    try {
      setRecords(await fetchVehicleMaintenanceRecords(vehicle.id));
    } catch (err: any) {
      showToast(`Bakım geçmişi getirilirken hata: ${err.message}`, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicle.id]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!operationsDescription.trim() || !costAmount) return;
    setIsSaving(true);
    try {
      await createVehicleMaintenanceRecord(vehicle.id, {
        maintenanceType,
        performedAt,
        odometerValue: odometerValue ? Number(odometerValue) : undefined,
        costAmount: Number(costAmount),
        operationsDescription: operationsDescription.trim(),
        nextDueDate: nextDueDate || undefined,
        nextDueMeterValue: nextDueMeterValue ? Number(nextDueMeterValue) : undefined
      });
      showToast('Bakım kaydı eklendi.');
      setOperationsDescription('');
      setCostAmount('');
      setOdometerValue('');
      setNextDueDate('');
      setNextDueMeterValue('');
      setIsFormOpen(false);
      await load();
    } catch (err: any) {
      showToast(`Bakım kaydı eklenirken hata: ${err.message}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-[#1c1b1b] border border-[#514532]/30 rounded-xl p-6 max-w-2xl w-full space-y-5 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-[#514532]/20 pb-4">
          <div>
            <h3 className="text-base font-bold text-[#e5e2e1] uppercase flex items-center space-x-2">
              <span className="material-symbols-outlined text-[#ffdca1]">build</span>
              <span>Bakım Geçmişi</span>
            </h3>
            <p className="text-xs text-[#d5c4ab] mt-1">{vehicle.plate} — {vehicle.brandModel}</p>
          </div>
          <button onClick={onClose} className="text-[#d5c4ab] hover:text-[#e5e2e1] cursor-pointer">
            <span className="material-symbols-outlined text-lg">close</span>
          </button>
        </div>

        {isLoading ? (
          <div className="py-8 text-center text-[#d5c4ab] text-xs font-mono">
            <span className="inline-flex items-center gap-2">
              <span className="w-4 h-4 border-2 border-[#ffdca1] border-t-transparent rounded-full animate-spin" />
              Yükleniyor...
            </span>
          </div>
        ) : (
          <div className="space-y-2">
            {records.length === 0 && (
              <p className="text-xs text-[#d5c4ab] text-center py-6">Bu araç için kayıtlı bakım geçmişi yok.</p>
            )}
            {records.map((r) => (
              <div key={r.id} className="bg-[#0e0e0e] border border-[#514532]/20 rounded-lg p-3.5 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-[#ffdca1]">{MAINTENANCE_TYPES.find((t) => t.value === r.maintenanceType)?.label || r.maintenanceType}</span>
                  <span className="text-[#d5c4ab] font-mono">{r.performedAt}</span>
                </div>
                <p className="text-[#e5e2e1] mt-1.5">{r.operationsDescription}</p>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[#d5c4ab] font-mono text-[11px]">
                  <span>Maliyet: {r.costAmount.toLocaleString('tr-TR')} TL</span>
                  {r.odometerValue !== null && <span>Sayaç: {r.odometerValue.toLocaleString('tr-TR')}</span>}
                  {r.nextDueDate && <span>Sonraki: {r.nextDueDate}</span>}
                </div>
              </div>
            ))}
          </div>
        )}

        {isFormOpen ? (
          <form onSubmit={handleSave} className="space-y-3 border-t border-[#514532]/20 pt-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] font-mono text-[#d5c4ab] block mb-1">Bakım Türü</label>
                <select
                  value={maintenanceType}
                  onChange={(e) => setMaintenanceType(e.target.value)}
                  className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-2.5 focus:outline-none focus:border-[#ffdca1]"
                  required
                >
                  {MAINTENANCE_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] font-mono text-[#d5c4ab] block mb-1">Tarih</label>
                <input
                  type="date"
                  value={performedAt}
                  onChange={(e) => setPerformedAt(e.target.value)}
                  className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-2.5 focus:outline-none focus:border-[#ffdca1]"
                  required
                />
              </div>
            </div>

            <div>
              <label className="text-[10px] font-mono text-[#d5c4ab] block mb-1">Yapılan İşlemler</label>
              <textarea
                value={operationsDescription}
                onChange={(e) => setOperationsDescription(e.target.value)}
                className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-2.5 focus:outline-none focus:border-[#ffdca1]"
                rows={2}
                required
              />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-[10px] font-mono text-[#d5c4ab] block mb-1">Maliyet (TL)</label>
                <input
                  type="number"
                  value={costAmount}
                  onChange={(e) => setCostAmount(e.target.value)}
                  className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] font-mono text-xs rounded-md p-2.5 focus:outline-none focus:border-[#ffdca1]"
                  required
                />
              </div>
              <div>
                <label className="text-[10px] font-mono text-[#d5c4ab] block mb-1">Sayaç (opsiyonel)</label>
                <input
                  type="number"
                  value={odometerValue}
                  onChange={(e) => setOdometerValue(e.target.value)}
                  className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] font-mono text-xs rounded-md p-2.5 focus:outline-none focus:border-[#ffdca1]"
                />
              </div>
              <div>
                <label className="text-[10px] font-mono text-[#d5c4ab] block mb-1">Sonraki Tarih (opsiyonel)</label>
                <input
                  type="date"
                  value={nextDueDate}
                  onChange={(e) => setNextDueDate(e.target.value)}
                  className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-2.5 focus:outline-none focus:border-[#ffdca1]"
                />
              </div>
            </div>

            <div className="flex items-center justify-end space-x-3 pt-1">
              <button type="button" onClick={() => setIsFormOpen(false)} className="px-4 py-2 bg-[#20201f] text-[#d5c4ab] rounded-md text-xs font-bold cursor-pointer">
                İptal
              </button>
              <button
                type="submit"
                disabled={isSaving}
                className="px-5 py-2 bg-gradient-to-r from-[#ffb800] to-[#ff8a00] hover:from-[#ffdca1] hover:to-[#ffb77f] disabled:opacity-50 text-[#412d00] rounded-md text-xs font-black cursor-pointer transition-all"
              >
                {isSaving ? 'Kaydediliyor...' : 'Kaydet'}
              </button>
            </div>
          </form>
        ) : (
          <button
            onClick={() => setIsFormOpen(true)}
            className="w-full px-4 py-2.5 bg-[#20201f] hover:bg-[#2a2a2a] border border-[#514532]/30 text-[#e5e2e1] hover:text-[#ffdca1] rounded-md text-xs font-bold transition-colors flex items-center justify-center space-x-2 cursor-pointer"
          >
            <span className="material-symbols-outlined text-base">add</span>
            <span>Yeni Bakım Kaydı Ekle</span>
          </button>
        )}
      </div>
    </div>
  );
};
