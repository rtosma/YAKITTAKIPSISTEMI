import React from 'react';
import { useApp } from '../context/AppContext';

/**
 * FE-810 AC: "Kota tükendiğinde ekrana anlık uyarı düşmelidir (FUEL-402.2)."
 * RfidUnmatchedAlerts İLE AYNI desen (backend Socket.io 'quota:exhausted'
 * olayı, bkz. tenantDb.ts recordCrossSiteDenialFromError). Bu, GENEL
 * fuel_quotas (FUEL-402.1) için DEĞİL — araştırıldı, o sistem gerçek ikmal
 * yetkilendirmesinde HİÇ kontrol edilmiyor (yalnızca bakiye gösterimi için
 * var). Gerçek zamanlı reddedilen TEK kota mekanizması çapraz şantiye
 * izninin (cross_site_permissions) kendisidir — bu yüzden burada "hızlı
 * tanımlama" (RFID'deki gibi) YOK: tek mantıklı aksiyon, CrossSitePage'den
 * izni manuel artırmak/yenilemek, otomatikleştirilmedi (ticket bunu istemiyor).
 *
 * Rol kısıtı backend QUOTA_MANAGER_ROLES İLE AYNI.
 */
export const QuotaExhaustedAlerts: React.FC = () => {
  const { quotaExhaustedAlerts, dismissQuotaExhaustedAlert, currentUser } = useApp();

  if (!currentUser || !['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'].includes(currentUser.role)) return null;
  if (quotaExhaustedAlerts.length === 0) return null;

  return (
    <div className="fixed top-6 left-6 z-40 space-y-2 w-80 max-w-[calc(100vw-3rem)]" data-testid="quota-exhausted-alerts">
      {quotaExhaustedAlerts.map((alert) => (
        <div
          key={`${alert.permissionId}-${alert.occurredAt}`}
          data-testid="quota-exhausted-alert"
          className="bg-[#1c1b1b] border border-[#ffb4ab] rounded-xl p-4 shadow-2xl font-mono text-xs"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start space-x-2 min-w-0">
              <span className="material-symbols-outlined text-[#ffb4ab] text-lg shrink-0">local_gas_station</span>
              <div className="min-w-0">
                <p className="font-bold text-[#ffb4ab]">Çapraz Şantiye Kotası Tükendi</p>
                <p className="text-[#d5c4ab] mt-0.5 truncate">
                  {alert.vehiclePlate} — {alert.homeSite || 'Bilinmeyen'} → {alert.targetSite}
                </p>
                <p className="text-[#d5c4ab]/70 text-[10px] mt-0.5">
                  {alert.usedLiters ?? '-'} / {alert.allowedLiters ?? '-'} L — {new Date(alert.occurredAt).toLocaleTimeString('tr-TR')}
                </p>
              </div>
            </div>
            <button
              onClick={() => dismissQuotaExhaustedAlert(alert.permissionId, alert.occurredAt)}
              className="text-[#d5c4ab] hover:text-[#ffb4ab] cursor-pointer shrink-0"
              data-testid="quota-exhausted-alert-dismiss"
            >
              <span className="material-symbols-outlined text-base">close</span>
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};
