import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { 
  Company, 
  Vehicle, 
  Driver, 
  FuelTransaction, 
  Tank, 
  CrossSitePermission, 
  HardwareDevice, 
  HardwareLog,
  CompanyModule
} from '../types';
import { 
  INITIAL_COMPANIES, 
  INITIAL_VEHICLES, 
  INITIAL_DRIVERS, 
  INITIAL_TANKS, 
  INITIAL_TRANSACTIONS, 
  INITIAL_CROSS_SITE_PERMISSIONS, 
  INITIAL_HARDWARE_DEVICES, 
  INITIAL_HARDWARE_LOGS 
} from '../mock';

interface ToastState {
  id: string;
  message: string;
  type: 'success' | 'info' | 'warning' | 'error';
}

interface AppContextType {
  // Current Customer Firm State (Default: ÇamSA Pelet)
  currentCompany: Company;
  selectedSiteFilter: string; // 'TÜMÜ' | 'Gebze Ana Şantiye' | 'Orman Şantiyesi' | 'Silivri Tesisleri'
  setSelectedSiteFilter: (site: string) => void;

  // Data lists
  companies: Company[];
  vehicles: Vehicle[];
  drivers: Driver[];
  tanks: Tank[];
  transactions: FuelTransaction[];
  crossSitePermissions: CrossSitePermission[];
  hardwareDevices: HardwareDevice[];
  hardwareLogs: HardwareLog[];

  // Refresh trigger for animations
  tankRefreshKey: number;
  triggerTankRefresh: () => void;

  // Latency & Terminal Stream
  simulatedLatencyMs: number;
  isLogStreamActive: boolean;
  setIsLogStreamActive: (active: boolean) => void;

  // Actions
  toggleCompanyModule: (companyId: string, moduleKey: keyof CompanyModule) => void;
  
  // Tank CRUD
  addTank: (tank: Omit<Tank, 'id'>) => void;
  updateTank: (id: string, updatedTank: Partial<Tank>) => void;
  deleteTank: (id: string) => void;

  // Vehicle CRUD
  addVehicle: (vehicle: Omit<Vehicle, 'id' | 'totalRefuelsCount'>) => void;
  updateVehicle: (id: string, updatedVehicle: Partial<Vehicle>) => void;
  deleteVehicle: (id: string) => void;

  // Driver CRUD
  addDriver: (driver: Omit<Driver, 'id' | 'totalFuelPumpedLiters'>) => void;
  updateDriver: (id: string, updatedDriver: Partial<Driver>) => void;
  deleteDriver: (id: string) => void;

  addFuelTransaction: (tx: Omit<FuelTransaction, 'id' | 'timestamp'>) => void;
  addHardwareLog: (log: Omit<HardwareLog, 'id' | 'timestamp'>) => void;
  clearHardwareLogs: () => void;
  toggleCrossSiteStatus: (id: string) => void;

  // Toast
  toast: ToastState | null;
  showToast: (message: string, type?: 'success' | 'info' | 'warning' | 'error') => void;

  // Selected Tenant for Admin Detail View
  selectedTenantForDetail: Company | null;
  setSelectedTenantForDetail: (company: Company | null) => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [companies, setCompanies] = useState<Company[]>(INITIAL_COMPANIES);
  const [currentCompanyIndex] = useState<number>(0);
  const [selectedSiteFilter, setSelectedSiteFilter] = useState<string>('TÜMÜ');

  const [vehicles, setVehicles] = useState<Vehicle[]>(INITIAL_VEHICLES);
  const [drivers, setDrivers] = useState<Driver[]>(INITIAL_DRIVERS);
  const [tanks, setTanks] = useState<Tank[]>(INITIAL_TANKS);
  const [transactions, setTransactions] = useState<FuelTransaction[]>(INITIAL_TRANSACTIONS);
  const [crossSitePermissions, setCrossSitePermissions] = useState<CrossSitePermission[]>(INITIAL_CROSS_SITE_PERMISSIONS);
  const [hardwareDevices, setHardwareDevices] = useState<HardwareDevice[]>(INITIAL_HARDWARE_DEVICES);
  const [hardwareLogs, setHardwareLogs] = useState<HardwareLog[]>(INITIAL_HARDWARE_LOGS);

  const [simulatedLatencyMs, setSimulatedLatencyMs] = useState<number>(14);
  const [isLogStreamActive, setIsLogStreamActive] = useState<boolean>(true);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [selectedTenantForDetail, setSelectedTenantForDetail] = useState<Company | null>(null);
  const [tankRefreshKey, setTankRefreshKey] = useState<number>(0);

  const currentCompany = companies[currentCompanyIndex] || companies[0];

  const triggerTankRefresh = () => {
    setTankRefreshKey(prev => prev + 1);
    showToast('Tank verileri ve göstergeleri yenilendi', 'info');
  };

  // Toast Helper
  const showToast = (message: string, type: 'success' | 'info' | 'warning' | 'error' = 'success') => {
    const id = Date.now().toString();
    setToast({ id, message, type });
    setTimeout(() => {
      setToast(prev => (prev?.id === id ? null : prev));
    }, 3500);
  };

  // Simulate network ping latency oscillation (for Developer Dashboard)
  useEffect(() => {
    const interval = setInterval(() => {
      setSimulatedLatencyMs(prev => Math.max(8, Math.min(38, prev + Math.floor(Math.random() * 5) - 2)));
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  // Simulate live IoT Log Stream
  useEffect(() => {
    if (!isLogStreamActive) return;

    const sampleLogs = [
      { tag: 'MQTT' as const, msg: '[MQTT_PUB] Topic: camsa/gebze/telemetry Payload: {"flow_rate": 48.2, "rssi": -65}', site: 'Gebze Ana Şantiye', dev: 'ESP32_PUMP_01' },
      { tag: 'RFID' as const, msg: '[RFID] Plaka 34 BKT 19 Okundu → Auth: Başarılı (CARD-881203)', site: 'Gebze Ana Şantiye', dev: 'ESP32_RFID_01' },
      { tag: 'PUMP' as const, msg: '[PUMP] Pompa #1 Akış Başladı — 51.8 Litre/dk (Solenoid RÖLE: AÇIK)', site: 'Gebze Ana Şantiye', dev: 'ESP32_PUMP_01' },
      { tag: 'SENSOR' as const, msg: '[SENSOR] Tank-1 Ultrasonik Seviye: 14,830 Litre (%74.1) | 18.5°C', site: 'Gebze Ana Şantiye', dev: 'ESP32_TANK_01' },
      { tag: 'WARN' as const, msg: '[WARN] Tank-3 (Silivri) Seviye %12.8 KRİTİK EŞİK DÜŞÜKLÜĞÜ', site: 'Silivri Tesisleri', dev: 'ESP32_TANK_03' },
    ];

    const interval = setInterval(() => {
      const log = sampleLogs[Math.floor(Math.random() * sampleLogs.length)];
      const now = new Date();
      const timeStr = now.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

      setHardwareLogs(prev => [
        ...prev.slice(-49), // keep last 50
        {
          id: Date.now().toString() + Math.random().toString(36).substring(2, 5),
          timestamp: timeStr,
          deviceCode: log.dev,
          tag: log.tag,
          message: log.msg,
          siteName: log.site
        }
      ]);
    }, 3500);

    return () => clearInterval(interval);
  }, [isLogStreamActive]);

  // Actions
  const toggleCompanyModule = (companyId: string, moduleKey: keyof CompanyModule) => {
    setCompanies(prev => prev.map(c => {
      if (c.id === companyId) {
        const updatedVal = !c.modules[moduleKey];
        const updated = {
          ...c,
          modules: {
            ...c.modules,
            [moduleKey]: updatedVal
          }
        };
        if (selectedTenantForDetail?.id === companyId) {
          setSelectedTenantForDetail(updated);
        }
        showToast(`Modül durumu güncellendi: ${moduleKey} → ${updatedVal ? 'AKTİF' : 'PASİF'}`);
        return updated;
      }
      return c;
    }));
  };

  // Tank CRUD
  const addTank = (newTank: Omit<Tank, 'id'>) => {
    const t: Tank = {
      ...newTank,
      id: 'tank-' + Date.now()
    };
    setTanks(prev => [t, ...prev]);
    showToast(`Yeni tank eklendi: ${t.name}`);
  };

  const updateTank = (id: string, updatedTank: Partial<Tank>) => {
    setTanks(prev => prev.map(t => {
      if (t.id === id) {
        const merged = { ...t, ...updatedTank };
        const pct = (merged.currentLevelLiters / merged.capacityLiters) * 100;
        let status: 'GÜVENLİ' | 'UYARI' | 'KRİTİK' = 'GÜVENLİ';
        if (pct < 20) status = 'KRİTİK';
        else if (pct < 40) status = 'UYARI';
        return { ...merged, status };
      }
      return t;
    }));
    showToast('Tank bilgileri güncellendi');
  };

  const deleteTank = (id: string) => {
    const target = tanks.find(t => t.id === id);
    setTanks(prev => prev.filter(t => t.id !== id));
    showToast(`Tank silindi: ${target?.name || id}`, 'warning');
  };

  // Vehicle CRUD
  const addVehicle = (newVeh: Omit<Vehicle, 'id' | 'totalRefuelsCount'>) => {
    const v: Vehicle = {
      ...newVeh,
      id: 'veh-' + Date.now(),
      totalRefuelsCount: 0
    };
    setVehicles(prev => [v, ...prev]);
    showToast(`Yeni araç eklendi: ${v.plate}`);
  };

  const updateVehicle = (id: string, updatedVeh: Partial<Vehicle>) => {
    setVehicles(prev => prev.map(v => (v.id === id ? { ...v, ...updatedVeh } : v)));
    showToast('Araç bilgileri güncellendi');
  };

  const deleteVehicle = (id: string) => {
    const target = vehicles.find(v => v.id === id);
    setVehicles(prev => prev.filter(v => v.id !== id));
    showToast(`Araç kaydı silindi: ${target?.plate || id}`, 'warning');
  };

  // Driver CRUD
  const addDriver = (newDrv: Omit<Driver, 'id' | 'totalFuelPumpedLiters'>) => {
    const d: Driver = {
      ...newDrv,
      id: 'drv-' + Date.now(),
      totalFuelPumpedLiters: 0
    };
    setDrivers(prev => [d, ...prev]);
    showToast(`Yeni şoför eklendi: ${d.name}`);
  };

  const updateDriver = (id: string, updatedDrv: Partial<Driver>) => {
    setDrivers(prev => prev.map(d => (d.id === id ? { ...d, ...updatedDrv } : d)));
    showToast('Şoför bilgileri güncellendi');
  };

  const deleteDriver = (id: string) => {
    const target = drivers.find(d => d.id === id);
    setDrivers(prev => prev.filter(d => d.id !== id));
    showToast(`Şoför kaydı silindi: ${target?.name || id}`, 'warning');
  };

  const addFuelTransaction = (newTx: Omit<FuelTransaction, 'id' | 'timestamp'>) => {
    const now = new Date();
    const dateStr = now.toISOString().replace('T', ' ').substring(0, 19);
    const tx: FuelTransaction = {
      ...newTx,
      id: 'tx-' + Date.now(),
      timestamp: dateStr
    };
    setTransactions(prev => [tx, ...prev]);

    // Update tank current level
    setTanks(prev => prev.map(t => {
      if (t.name === newTx.tankName || t.siteName === newTx.siteName) {
        const updatedLevel = Math.max(0, t.currentLevelLiters - newTx.amountLiters);
        const percentage = (updatedLevel / t.capacityLiters) * 100;
        let status: 'GÜVENLİ' | 'UYARI' | 'KRİTİK' = 'GÜVENLİ';
        if (percentage < 20) status = 'KRİTİK';
        else if (percentage < 40) status = 'UYARI';

        return { ...t, currentLevelLiters: updatedLevel, status };
      }
      return t;
    }));

    showToast(`İkmal kaydedildi: ${newTx.vehiclePlate} — ${newTx.amountLiters} Litre`);
  };

  const addHardwareLog = (log: Omit<HardwareLog, 'id' | 'timestamp'>) => {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setHardwareLogs(prev => [
      ...prev,
      {
        ...log,
        id: Date.now().toString(),
        timestamp: timeStr
      }
    ]);
  };

  const clearHardwareLogs = () => {
    setHardwareLogs([]);
    showToast('IoT log ekranı temizlendi', 'info');
  };

  const toggleCrossSiteStatus = (id: string) => {
    setCrossSitePermissions(prev => prev.map(p => {
      if (p.id === id) {
        const nextStatus = p.status === 'AKTİF' ? 'SÜRESİ_DOLDU' : 'AKTİF';
        showToast(`Yetki durumu değişti: ${p.vehiclePlate} (${nextStatus})`);
        return { ...p, status: nextStatus };
      }
      return p;
    }));
  };

  return (
    <AppContext.Provider
      value={{
        currentCompany,
        selectedSiteFilter,
        setSelectedSiteFilter,
        companies,
        vehicles,
        drivers,
        tanks,
        transactions,
        crossSitePermissions,
        hardwareDevices,
        hardwareLogs,
        tankRefreshKey,
        triggerTankRefresh,
        simulatedLatencyMs,
        isLogStreamActive,
        setIsLogStreamActive,
        toggleCompanyModule,
        addTank,
        updateTank,
        deleteTank,
        addVehicle,
        updateVehicle,
        deleteVehicle,
        addDriver,
        updateDriver,
        deleteDriver,
        addFuelTransaction,
        addHardwareLog,
        clearHardwareLogs,
        toggleCrossSiteStatus,
        toast,
        showToast,
        selectedTenantForDetail,
        setSelectedTenantForDetail,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
};
