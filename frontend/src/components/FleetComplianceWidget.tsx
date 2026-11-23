import React, { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import { fetchFleetComplianceDashboard, FleetComplianceItem } from '../hooks/useFleetComplianceDashboard';

/**
 * FLEET-1408 AC: "Geçmiş yükümlülükler dashboard'da kritik olarak
 * gösterilmelidir." Backend'in GET /fleet/compliance/dashboard ucu
 * (30/15/7 gün muayene-egzoz-sigorta uyarısı + lastik km ömrü) daha önce
 * hiçbir arayüze yansımıyordu — yalnızca ham bir API idi.
 */
export const FleetComplianceWidget: React.FC = () => {
  const { currentUser } = useApp();
  const [items, setItems] = useState<FleetComplianceItem[] | null>(null);

  const canView = !!currentUser && ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'].includes(currentUser.role);

  useEffect(() => {
    if (!canView) return;
    fetchFleetComplianceDashboard().then(setItems).catch(() => setItems([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView]);

  if (!canView || items === null) return null;

  const critical = items.filter((i) => i.severity === 'CRITICAL');
  const warning = items.filter((i) => i.severity === 'WARNING');
  const sorted = [...critical, ...warning];

  return (
    <div className="bg-[#1c1b1b] border border-[#353535] rounded-2xl p-6 space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-[#d5c4ab] uppercase tracking-wider flex items-center gap-2">
          <span className="material-symbols-outlined text-lg text-[#ffdca1]">fact_check</span>
          Filo Uygunluk Durumu
        </span>
        {critical.length > 0 && (
          <span className="text-[10px] font-mono font-bold px-2 py-1 rounded bg-[#93000a]/20 text-[#ffb4ab] border border-[#93000a]/40">
            {critical.length} GECİKMİŞ
          </span>
        )}
      </div>

      {sorted.length === 0 ? (
        <p className="text-xs text-[#d5c4ab]">Yaklaşan veya geciken bir yükümlülük yok — filo uygun.</p>
      ) : (
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {sorted.map((item) => (
            <div
              key={`${item.vehicleId}-${item.type}-${item.subKey}`}
              data-testid="fleet-compliance-row"
              className={`flex items-center justify-between gap-3 p-3 rounded-lg border text-xs ${
                item.severity === 'CRITICAL'
                  ? 'bg-[#93000a]/10 border-[#93000a]/40'
                  : 'bg-[#ff8a00]/5 border-[#ff8a00]/25'
              }`}
            >
              <div className="min-w-0">
                <span className={`font-bold ${item.severity === 'CRITICAL' ? 'text-[#ffb4ab]' : 'text-[#ffb77f]'}`}>
                  {item.vehiclePlate}
                </span>
                <span className="text-[#d5c4ab]"> — {item.label}</span>
              </div>
              <span className="font-mono text-[10px] text-[#d5c4ab] shrink-0">{item.dueInfo}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
