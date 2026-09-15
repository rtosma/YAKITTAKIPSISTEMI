import React, { useState } from 'react';
import { useApp } from '../context/AppContext';

/**
 * FLEET-1402 AC: "Eşleşmemiş kart okutulduğunda uyarı ve hızlı tanımlama
 * akışı." Pompada okutulan bir kart hiçbir şoföre bağlı DEĞİLSE (backend
 * `rfid:unmatched` Socket.io olayı, bkz. tenantDb.ts authorizeDispenseRequest)
 * burada canlı bir uyarı kartı belirir; "Hızlı Tanımla" bu UID'yi VAR OLAN
 * bir araca (rfidTag) ya da şoföre (rfidCardId) atamak için mevcut
 * updateVehicle/updateDriver uçlarını (YENİ bir endpoint İCAT EDİLMEDİ)
 * doğrudan çağıran küçük bir modal açar.
 *
 * Yalnızca araç/şoför yönetebilen roller görür (backend'in PUT /vehicles,
 * PUT /drivers route'larıyla AYNI rol kümesi) — PUMP_OPERATOR/DRIVER'a
 * gösterilmesi zaten yetkisiz bir aksiyona (atama) davetiye çıkarırdı.
 */
export const RfidUnmatchedAlerts: React.FC = () => {
  const { unmatchedRfidAlerts, dismissRfidAlert, vehicles, drivers, updateVehicle, updateDriver, currentUser } = useApp();
  const [assigningUid, setAssigningUid] = useState<string | null>(null);
  const [assignTarget, setAssignTarget] = useState<'vehicle' | 'driver'>('vehicle');
  const [selectedId, setSelectedId] = useState('');
  const [isAssigning, setIsAssigning] = useState(false);

  if (!currentUser || !['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'].includes(currentUser.role)) return null;
  if (unmatchedRfidAlerts.length === 0) return null;

  const openAssign = (uid: string) => {
    setAssigningUid(uid);
    setAssignTarget('vehicle');
    setSelectedId('');
  };

  const handleConfirmAssign = async () => {
    if (!assigningUid || !selectedId) return;
    setIsAssigning(true);
    try {
      if (assignTarget === 'vehicle') {
        await updateVehicle(selectedId, { rfidTag: assigningUid });
      } else {
        await updateDriver(selectedId, { rfidCardId: assigningUid });
      }
      dismissRfidAlert(assigningUid);
      setAssigningUid(null);
    } finally {
      setIsAssigning(false);
    }
  };

  return (
    <>
      <div className="fixed top-6 right-6 z-40 space-y-2 w-80 max-w-[calc(100vw-3rem)]">
        {unmatchedRfidAlerts.map((alert) => (
          <div key={alert.cardUid} className="bg-[#1c1b1b] border border-[#ffb4ab] rounded-xl p-4 shadow-2xl font-mono text-xs">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-start space-x-2 min-w-0">
                <span className="material-symbols-outlined text-[#ffb4ab] text-lg shrink-0">contactless</span>
                <div className="min-w-0">
                  <p className="font-bold text-[#ffb4ab]">Tanımsız RFID Kartı</p>
                  <p className="text-[#d5c4ab] mt-0.5 truncate">{alert.cardUid}</p>
                  <p className="text-[#d5c4ab]/70 text-[10px] mt-0.5">
                    {alert.siteName} — {new Date(alert.detectedAt).toLocaleTimeString('tr-TR')}
                  </p>
                </div>
              </div>
              <button onClick={() => dismissRfidAlert(alert.cardUid)} className="text-[#d5c4ab] hover:text-[#ffb4ab] cursor-pointer shrink-0">
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            </div>
            <button
              onClick={() => openAssign(alert.cardUid)}
              className="mt-3 w-full px-3 py-2 bg-[#ffb800] hover:bg-[#ffdca1] text-[#412d00] font-black rounded-md text-[11px] cursor-pointer transition-colors"
            >
              Hızlı Tanımla
            </button>
          </div>
        ))}
      </div>

      {assigningUid && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#1c1b1b] border border-[#514532]/30 rounded-xl p-6 max-w-sm w-full space-y-4">
            <h3 className="text-base font-bold text-[#e5e2e1]">RFID Kartını Tanımla</h3>
            <p className="text-xs text-[#d5c4ab] font-mono break-all">{assigningUid}</p>

            <div className="flex space-x-2">
              <button
                onClick={() => { setAssignTarget('vehicle'); setSelectedId(''); }}
                className={`flex-1 px-3 py-2 rounded-md text-xs font-bold cursor-pointer transition-colors ${
                  assignTarget === 'vehicle' ? 'bg-[#ffb800] text-[#412d00]' : 'bg-[#20201f] text-[#d5c4ab]'
                }`}
              >
                Araca Ata
              </button>
              <button
                onClick={() => { setAssignTarget('driver'); setSelectedId(''); }}
                className={`flex-1 px-3 py-2 rounded-md text-xs font-bold cursor-pointer transition-colors ${
                  assignTarget === 'driver' ? 'bg-[#ffb800] text-[#412d00]' : 'bg-[#20201f] text-[#d5c4ab]'
                }`}
              >
                Şoföre Ata
              </button>
            </div>

            <select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
            >
              <option value="">Seçiniz...</option>
              {assignTarget === 'vehicle'
                ? vehicles.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.plate} — {v.brandModel}
                    </option>
                  ))
                : drivers.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
            </select>

            <div className="flex items-center justify-end space-x-3 pt-2">
              <button onClick={() => setAssigningUid(null)} className="px-4 py-2 bg-[#20201f] text-[#d5c4ab] rounded-md text-xs font-bold cursor-pointer">
                İptal
              </button>
              <button
                onClick={handleConfirmAssign}
                disabled={!selectedId || isAssigning}
                className="px-5 py-2 bg-[#ffb800] hover:bg-[#ffdca1] disabled:opacity-40 disabled:cursor-not-allowed text-[#412d00] rounded-md text-xs font-black cursor-pointer transition-colors"
              >
                {isAssigning ? 'Atanıyor...' : 'Ata'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
