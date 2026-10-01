import React, { useState } from 'react';
import { useApp } from '../context/AppContext';

/**
 * FE-808 Kapsam: "Araç/sürücü bloke etme ve kart kayıp bildirimi." AUTH-210
 * (backend rfid_card_blacklist: LOST/BLOCKED/REPLACED) zaten tam bir akış
 * sunuyordu — bu, onun TEK frontend arayüzü. VehiclesPage/DriversPage'den
 * her satırın kendi RFID kart UID'si (`v.rfidTag` / `d.rfidCardId`) ile
 * açılır. Rol kısıtı RfidUnmatchedAlerts İLE AYNI (backend
 * RFID_CARD_MANAGER_ROLES) — çağıran sayfa zaten bu rollerde render ediliyor.
 */
interface Props {
  cardUid: string;
  entityLabel: string; // "34 ABC 123" (araç) veya "Ahmet Yılmaz" (şoför)
  onClose: () => void;
}

export const RfidCardStatusModal: React.FC<Props> = ({ cardUid, entityLabel, onClose }) => {
  const { rfidDenylist, reportRfidCardLost, unblockRfidCardByUid, replaceRfidCardByUid } = useApp();
  const [mode, setMode] = useState<'VIEW' | 'REPORT' | 'REPLACE'>('VIEW');
  const [reportStatus, setReportStatus] = useState<'LOST' | 'BLOCKED'>('LOST');
  const [reason, setReason] = useState('');
  const [newCardUid, setNewCardUid] = useState('');
  const [isBusy, setIsBusy] = useState(false);

  const blacklistEntry = rfidDenylist.find((r) => r.card_uid === cardUid && r.status !== 'REPLACED');

  const handleReport = async () => {
    setIsBusy(true);
    try {
      if (await reportRfidCardLost(cardUid, reportStatus, reason.trim() || undefined)) onClose();
    } finally {
      setIsBusy(false);
    }
  };

  const handleUnblock = async () => {
    setIsBusy(true);
    try {
      if (await unblockRfidCardByUid(cardUid)) onClose();
    } finally {
      setIsBusy(false);
    }
  };

  const handleReplace = async () => {
    if (!newCardUid.trim()) return;
    setIsBusy(true);
    try {
      if (await replaceRfidCardByUid(cardUid, newCardUid.trim())) onClose();
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-[#1c1b1b] border border-[#514532]/30 rounded-xl p-6 max-w-md w-full space-y-5" data-testid="rfid-card-status-modal">
        <div className="flex items-center justify-between border-b border-[#514532]/20 pb-4">
          <h3 className="text-base font-bold text-[#e5e2e1] uppercase flex items-center space-x-2">
            <span className="material-symbols-outlined text-[#ffdca1]">contactless</span>
            <span>RFID Kart Durumu</span>
          </h3>
          <button onClick={onClose} className="text-[#d5c4ab] hover:text-[#e5e2e1]">
            <span className="material-symbols-outlined text-lg">close</span>
          </button>
        </div>

        <div className="text-xs font-mono text-[#d5c4ab] space-y-1">
          <div className="flex justify-between"><span>Bağlı:</span><span className="text-[#e5e2e1] font-bold">{entityLabel}</span></div>
          <div className="flex justify-between"><span>Kart UID:</span><span className="text-[#ffb77f] font-bold break-all">{cardUid}</span></div>
        </div>

        {blacklistEntry && (
          <div className="p-3 bg-[#ffb4ab]/10 border border-[#ffb4ab]/30 rounded-xl text-[11px] text-[#ffb4ab] font-mono space-y-1">
            <p className="font-bold">
              Bu kart şu anda {blacklistEntry.status === 'LOST' ? 'KAYIP' : 'BLOKE'} olarak işaretli.
            </p>
            {blacklistEntry.reason && <p className="text-[#d5c4ab]">Gerekçe: {blacklistEntry.reason}</p>}
            <p className="text-[#d5c4ab]/70">
              {new Date(blacklistEntry.updated_at).toLocaleString('tr-TR')}
            </p>
          </div>
        )}

        {mode === 'VIEW' && (
          <div className="space-y-2.5 pt-2">
            {!blacklistEntry ? (
              <button
                data-testid="rfid-card-report-open"
                onClick={() => setMode('REPORT')}
                className="w-full px-4 py-2.5 bg-[#ffb4ab]/10 hover:bg-[#ffb4ab]/20 border border-[#ffb4ab]/30 text-[#ffb4ab] rounded-md text-xs font-bold cursor-pointer"
              >
                Kayıp / Çalıntı Bildir
              </button>
            ) : (
              <button
                data-testid="rfid-card-unblock"
                onClick={handleUnblock}
                disabled={isBusy}
                className="w-full px-4 py-2.5 bg-[#a1e8a2]/10 hover:bg-[#a1e8a2]/20 border border-[#a1e8a2]/30 text-[#a1e8a2] rounded-md text-xs font-bold cursor-pointer disabled:opacity-40"
              >
                {isBusy ? 'İşleniyor...' : 'Blokeyi Kaldır (Kart Bulundu)'}
              </button>
            )}
            <button
              data-testid="rfid-card-replace-open"
              onClick={() => setMode('REPLACE')}
              className="w-full px-4 py-2.5 bg-[#20201f] hover:bg-[#282726] border border-[#514532]/30 text-[#d5c4ab] rounded-md text-xs font-bold cursor-pointer"
            >
              Kartı Değiştir
            </button>
          </div>
        )}

        {mode === 'REPORT' && (
          <div className="space-y-3 pt-2">
            <div className="flex space-x-2">
              <button
                onClick={() => setReportStatus('LOST')}
                className={`flex-1 px-3 py-2 rounded-md text-xs font-bold cursor-pointer transition-colors ${reportStatus === 'LOST' ? 'bg-[#ffb4ab] text-[#412d00]' : 'bg-[#20201f] text-[#d5c4ab]'}`}
              >
                Kayıp
              </button>
              <button
                onClick={() => setReportStatus('BLOCKED')}
                className={`flex-1 px-3 py-2 rounded-md text-xs font-bold cursor-pointer transition-colors ${reportStatus === 'BLOCKED' ? 'bg-[#ffb4ab] text-[#412d00]' : 'bg-[#20201f] text-[#d5c4ab]'}`}
              >
                Çalıntı / Bloke
              </button>
            </div>
            <input
              type="text"
              data-testid="rfid-card-reason-input"
              placeholder="Gerekçe (opsiyonel)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
            />
            <div className="flex items-center justify-between pt-1">
              <button onClick={() => setMode('VIEW')} className="px-4 py-2 bg-[#20201f] text-[#d5c4ab] rounded-md text-xs font-bold cursor-pointer">← Geri</button>
              <button
                data-testid="rfid-card-report-confirm"
                onClick={handleReport}
                disabled={isBusy}
                className="px-5 py-2 bg-[#ffb4ab] hover:bg-[#ffcdc4] text-[#412d00] rounded-md text-xs font-black cursor-pointer disabled:opacity-40"
              >
                {isBusy ? 'İşleniyor...' : 'Bildir'}
              </button>
            </div>
          </div>
        )}

        {mode === 'REPLACE' && (
          <div className="space-y-3 pt-2">
            <p className="text-[10px] text-[#d5c4ab]/70 font-mono">
              Eski kart (yukarıdaki UID) otomatik olarak iptal edilir (REPLACED); geçmiş ikmal kayıtları korunur.
            </p>
            <input
              type="text"
              data-testid="rfid-card-new-uid-input"
              placeholder="Yeni kart UID"
              value={newCardUid}
              onChange={(e) => setNewCardUid(e.target.value)}
              autoFocus
              className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
            />
            <div className="flex items-center justify-between pt-1">
              <button onClick={() => setMode('VIEW')} className="px-4 py-2 bg-[#20201f] text-[#d5c4ab] rounded-md text-xs font-bold cursor-pointer">← Geri</button>
              <button
                data-testid="rfid-card-replace-confirm"
                onClick={handleReplace}
                disabled={isBusy || !newCardUid.trim()}
                className="px-5 py-2 bg-[#ffb800] hover:bg-[#ffdca1] text-[#412d00] rounded-md text-xs font-black cursor-pointer disabled:opacity-40"
              >
                {isBusy ? 'İşleniyor...' : 'Değiştir'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
