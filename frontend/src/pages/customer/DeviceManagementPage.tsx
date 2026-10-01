import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useApp } from '../../context/AppContext';
import { TenantHardwareDevice } from '../../types';
import { DeviceCalibrationModal } from '../../components/DeviceCalibrationModal';

// FE-809 Kapsam: "Cihaz eşleştirme (provisioning) akışı ve QR/claim kodu
// gösterimi" + AC: "Cihaz eşleştirme QR ile tamamlanabilmelidir." IOT-304
// (backend) BİLİNÇLİ OLARAK yalnızca kriptografik olarak güçlü bir METİN
// kodu üretir — gerçek bir QR GÖRÜNTÜSÜ üretmez (kendi yorumunda açıklanan
// gerekçe: EMQX cihaz başına kimlik/ACL altyapısı bu ticket'ın kapsamı
// dışında tutulmuştu, QR da "aynı gerekçeyle" atlanmıştı). Burada o metin
// kodundan GERÇEK bir QR (kütüphane: qrcode, yeni bağımlılık — başka bir
// şeyin yeniden üretimi DEĞİL) render edilir; backend sözleşmesi değişmedi.
function ClaimQrCode({ code }: { code: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(code, { width: 220, margin: 1 }).then((url) => {
      if (!cancelled) setDataUrl(url);
    });
    return () => { cancelled = true; };
  }, [code]);
  if (!dataUrl) return <div className="w-[220px] h-[220px] bg-[#0e0e0e] rounded-md animate-pulse" />;
  // Teknik Not: "QR kodu saha teknisyeninin telefonuyla okuyabileceği
  // boyutta olmalıdır" — 220px render + beyaz zemin (koyu temada taranabilirlik).
  return <img src={dataUrl} alt={`Claim kodu QR: ${code}`} data-testid="device-claim-qr" className="rounded-md bg-white p-2" width={220} height={220} />;
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return 'Hiç görülmedi';
  const diffMin = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMin < 1) return 'Az önce';
  if (diffMin < 60) return `${diffMin} dk önce`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} sa önce`;
  return `${Math.floor(diffHour / 24)} gün önce`;
}

export const DeviceManagementPage: React.FC = () => {
  const {
    tenantHardwareDevices, assignDeviceTank, deviceClaimCodes, generateDeviceClaimCode,
    tanks, sites, currentCompany, deviceOnlineStatus
  } = useApp();

  const availableSites = Array.from(new Set([...sites, ...currentCompany.sites.map((s) => s.name)])).filter(Boolean);

  const [calibratingDevice, setCalibratingDevice] = useState<TenantHardwareDevice | null>(null);

  const [isClaimOpen, setIsClaimOpen] = useState(false);
  const [claimSiteName, setClaimSiteName] = useState(availableSites[0] || '');
  const [claimDeviceName, setClaimDeviceName] = useState('');
  const [generatedCode, setGeneratedCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  const openClaimModal = () => {
    setClaimSiteName(availableSites[0] || '');
    setClaimDeviceName('');
    setGeneratedCode(null);
    setIsClaimOpen(true);
  };

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!claimDeviceName.trim() || !claimSiteName) return;
    setIsGenerating(true);
    try {
      const result = await generateDeviceClaimCode(claimSiteName, claimDeviceName.trim());
      if (result) setGeneratedCode({ code: result.code, expiresAt: result.expiresAt });
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 bg-[#1c1b1b] border border-[#514532]/25 p-6 rounded-xl">
        <div className="space-y-1">
          <span className="text-xs font-mono font-bold text-[#ffdca1] uppercase tracking-widest block">
            SAHA DONANIMI
          </span>
          <h1 className="text-2xl font-black text-[#e5e2e1] uppercase tracking-tight">
            CİHAZ YÖNETİMİ
          </h1>
          <p className="text-xs text-[#d5c4ab]">
            Kayıtlı ESP32/debimetre cihazları, tank eşleştirmeleri ve yeni cihaz provisioning akışı.
          </p>
        </div>

        <button
          data-testid="device-claim-open"
          onClick={openClaimModal}
          className="px-5 py-3 bg-gradient-to-r from-[#ffb800] to-[#ff8a00] hover:from-[#ffdca1] hover:to-[#ffb77f] text-[#412d00] font-black rounded-lg text-xs flex items-center space-x-2 transition-all shadow-md cursor-pointer shrink-0"
        >
          <span className="material-symbols-outlined text-base">qr_code_2</span>
          <span>Yeni Cihaz Eşleştir</span>
        </button>
      </div>

      {/* Devices Table */}
      <div className="bg-[#1c1b1b] border border-[#514532]/25 rounded-xl p-6 overflow-x-auto">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-[#514532]/20 text-[#d5c4ab] uppercase text-[10px] tracking-wider font-mono">
              <th className="py-3.5 px-4">Cihaz ID</th>
              <th className="py-3.5 px-4">Ad</th>
              <th className="py-3.5 px-4">Şantiye</th>
              <th className="py-3.5 px-4">Durum</th>
              <th className="py-3.5 px-4">Son Görülme</th>
              <th className="py-3.5 px-4">Firmware</th>
              <th className="py-3.5 px-4">Bağlı Tank</th>
              <th className="py-3.5 px-4">K-Factor</th>
              <th className="py-3.5 px-4 text-right">İşlem</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#514532]/15 font-mono">
            {tenantHardwareDevices.map((d) => {
              const liveOnline = deviceOnlineStatus[d.deviceId];
              const liveStatus = liveOnline === undefined ? null : (liveOnline ? 'ONLINE' : 'OFFLINE');
              return (
                <tr key={d.id} data-testid="device-row" data-device-id={d.deviceId} className="hover:bg-[#20201f] transition-colors">
                  <td className="py-3.5 px-4 font-black text-[#ffdca1]">{d.deviceId}</td>
                  <td className="py-3.5 px-4 text-[#e5e2e1] font-bold">{d.name}</td>
                  <td className="py-3.5 px-4 text-[#d5c4ab]">{d.siteName}</td>
                  <td className="py-3.5 px-4">
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded mr-1.5 ${
                      d.status === 'BLOKE' ? 'bg-[#ffb4ab]/20 text-[#ffb4ab]' : 'bg-[#20201f] text-[#d5c4ab] border border-[#514532]/30'
                    }`}>
                      {d.status}
                    </span>
                    {liveStatus && (
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                        liveStatus === 'ONLINE' ? 'bg-[#a1e8a2]/10 text-[#a1e8a2]' : 'bg-[#ffb4ab]/10 text-[#ffb4ab]'
                      }`}>
                        {liveStatus}
                      </span>
                    )}
                  </td>
                  <td className="py-3.5 px-4 text-[#d5c4ab]">{formatRelativeTime(d.lastSeenAt)}</td>
                  <td className="py-3.5 px-4 text-[#d5c4ab]">{d.firmwareVersion ? `v${d.firmwareVersion}` : 'Bilinmiyor'}</td>
                  <td className="py-3.5 px-4">
                    <select
                      data-testid="device-tank-select"
                      value={d.tankName || ''}
                      onChange={(e) => assignDeviceTank(d.deviceId, e.target.value || null)}
                      className="bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-2 focus:outline-none focus:border-[#ffdca1]"
                    >
                      <option value="">— Bağlı değil —</option>
                      {tanks.map((t) => (
                        <option key={t.id} value={t.name}>{t.name}</option>
                      ))}
                    </select>
                  </td>
                  <td className="py-3.5 px-4 text-[#d5c4ab]" data-testid="device-k-factor">{d.kFactor !== null ? d.kFactor.toFixed(4) : '—'}</td>
                  <td className="py-3.5 px-4 text-right">
                    <button
                      data-testid="device-calibration-open"
                      onClick={() => setCalibratingDevice(d)}
                      className="px-3 py-1.5 bg-[#20201f] hover:bg-[#2a2a2a] border border-[#514532]/30 text-[#d5c4ab] hover:text-[#ffdca1] rounded-md text-[11px] font-bold cursor-pointer"
                    >
                      Kalibrasyon
                    </button>
                  </td>
                </tr>
              );
            })}

            {tenantHardwareDevices.length === 0 && (
              <tr>
                <td colSpan={9} className="py-12 text-center text-[#d5c4ab]">
                  Kayıtlı cihaz bulunamadı. "Yeni Cihaz Eşleştir" ile ilk cihazınızı provizyonlayın.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pending/Recent Claim Codes */}
      <div className="bg-[#1c1b1b] border border-[#514532]/25 rounded-xl p-6 overflow-x-auto">
        <h3 className="text-xs font-extrabold text-[#e5e2e1] uppercase tracking-wider mb-4">Eşleştirme Kodları</h3>
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-[#514532]/20 text-[#d5c4ab] uppercase text-[10px] tracking-wider font-mono">
              <th className="py-2 px-4">Kod</th>
              <th className="py-2 px-4">Şantiye</th>
              <th className="py-2 px-4">Cihaz Adı</th>
              <th className="py-2 px-4">Durum</th>
              <th className="py-2 px-4">Son Kullanma</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#514532]/15 font-mono">
            {deviceClaimCodes.map((c) => (
              <tr key={c.id} data-testid="claim-code-row">
                <td className="py-2.5 px-4 text-[#ffb77f] font-bold">{c.code}</td>
                <td className="py-2.5 px-4 text-[#d5c4ab]">{c.siteName}</td>
                <td className="py-2.5 px-4 text-[#e5e2e1]">{c.deviceName}</td>
                <td className="py-2.5 px-4">
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                    c.status === 'REDEEMED' ? 'bg-[#a1e8a2]/10 text-[#a1e8a2]' : c.status === 'EXPIRED' ? 'bg-[#d5c4ab]/10 text-[#d5c4ab]' : 'bg-[#ffdca1]/10 text-[#ffdca1]'
                  }`}>
                    {c.status}
                  </span>
                </td>
                <td className="py-2.5 px-4 text-[#d5c4ab]">{new Date(c.expiresAt).toLocaleString('tr-TR')}</td>
              </tr>
            ))}
            {deviceClaimCodes.length === 0 && (
              <tr><td colSpan={5} className="py-6 text-center text-[#d5c4ab]">Henüz üretilmiş bir eşleştirme kodu yok.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* MODAL: Device Claim / Provisioning */}
      {isClaimOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#1c1b1b] border border-[#514532]/30 rounded-xl p-6 max-w-md w-full space-y-5">
            <div className="flex items-center justify-between border-b border-[#514532]/20 pb-4">
              <h3 className="text-base font-bold text-[#e5e2e1] uppercase flex items-center space-x-2">
                <span className="material-symbols-outlined text-[#ffdca1]">qr_code_2</span>
                <span>Yeni Cihaz Eşleştir</span>
              </h3>
              <button onClick={() => setIsClaimOpen(false)} className="text-[#d5c4ab] hover:text-[#e5e2e1]">
                <span className="material-symbols-outlined text-lg">close</span>
              </button>
            </div>

            {!generatedCode ? (
              <form onSubmit={handleGenerate} className="space-y-4">
                <div>
                  <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Şantiye</label>
                  <select
                    data-testid="device-claim-site-select"
                    value={claimSiteName}
                    onChange={(e) => setClaimSiteName(e.target.value)}
                    className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                  >
                    {availableSites.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-mono text-[#d5c4ab] block mb-1">Cihaz Adı</label>
                  <input
                    type="text"
                    data-testid="device-claim-name-input"
                    placeholder="örn. Gebze Tank-1 Debimetresi"
                    value={claimDeviceName}
                    onChange={(e) => setClaimDeviceName(e.target.value)}
                    autoFocus
                    className="w-full bg-[#0e0e0e] border border-[#514532]/30 text-[#e5e2e1] text-xs rounded-md p-3 focus:outline-none focus:border-[#ffdca1]"
                  />
                </div>
                <p className="text-[10px] text-[#d5c4ab]/70 font-mono">
                  Kod 15 dakika geçerlidir ve tek kullanımlıktır. Sahadaki teknisyen bu kodu cihaza (veya eşleştirme uygulamasına) girer.
                </p>
                <div className="pt-2 flex items-center justify-end">
                  <button
                    type="submit"
                    data-testid="device-claim-generate"
                    disabled={isGenerating || !claimDeviceName.trim()}
                    className="px-5 py-2.5 bg-gradient-to-r from-[#ffb800] to-[#ff8a00] text-[#412d00] rounded-md text-xs font-black cursor-pointer disabled:opacity-40"
                  >
                    {isGenerating ? 'Üretiliyor...' : 'Kod Üret'}
                  </button>
                </div>
              </form>
            ) : (
              <div className="space-y-4 flex flex-col items-center" data-testid="device-claim-result">
                <ClaimQrCode code={generatedCode.code} />
                <div className="text-center">
                  <p className="text-[10px] text-[#d5c4ab] font-mono">Kod</p>
                  <p data-testid="device-claim-code-text" className="text-lg font-black text-[#ffb77f] font-mono select-all">{generatedCode.code}</p>
                  <p className="text-[10px] text-[#d5c4ab] font-mono mt-1">
                    Son kullanma: {new Date(generatedCode.expiresAt).toLocaleString('tr-TR')}
                  </p>
                </div>
                <button
                  onClick={() => setIsClaimOpen(false)}
                  className="w-full py-2.5 bg-[#20201f] hover:bg-[#282726] border border-[#514532]/30 text-[#d5c4ab] rounded-md text-xs font-bold cursor-pointer"
                >
                  Kapat
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {calibratingDevice && (
        <DeviceCalibrationModal device={calibratingDevice} onClose={() => setCalibratingDevice(null)} />
      )}

    </div>
  );
};
