import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1';
import { apiFetch } from '../utils/api';
import { 
  Company, 
  Site,
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
  // Auth & Permissions Mode State
  isAuthenticated: boolean;
  isManagerMode: boolean;
  setIsManagerMode: (val: boolean) => void;
  currentUser: { username: string; companyName: string; role: string; siteName?: string } | null;
  loginCompany: (username: string, password: string) => Promise<{ success: boolean; error?: string }>;
  loginSiteOperator: (username: string, password: string) => Promise<{ success: boolean; error?: string }>;
  logoutCompany: () => void;

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
  fetchVehicles: () => Promise<void>;
  addVehicle: (vehicle: Omit<Vehicle, 'id' | 'totalRefuelsCount'>) => Promise<void>;
  updateVehicle: (id: string, updatedVehicle: Partial<Vehicle>) => Promise<void>;
  deleteVehicle: (id: string) => Promise<void>;

  // Driver CRUD
  fetchDrivers: () => Promise<void>;
  addDriver: (driver: Omit<Driver, 'id' | 'totalFuelPumpedLiters'>) => Promise<void>;
  updateDriver: (id: string, updatedDriver: Partial<Driver>) => Promise<void>;
  deleteDriver: (id: string) => Promise<void>;

  // Tank CRUD
  fetchTanks: () => Promise<void>;
  addTank: (tank: Omit<Tank, 'id'>) => Promise<void>;
  updateTank: (id: string, updatedTank: Partial<Tank>) => Promise<void>;
  deleteTank: (id: string) => Promise<void>;

  addFuelTransaction: (tx: Omit<FuelTransaction, 'id' | 'timestamp'>) => void;
  addHardwareLog: (log: Omit<HardwareLog, 'id' | 'timestamp'>) => void;
  clearHardwareLogs: () => void;
  toggleCrossSiteStatus: (id: string) => void;
  addCrossSitePermission: (perm: Omit<CrossSitePermission, 'id' | 'usedLiters' | 'status'>) => void;
  addCompany: (comp: Omit<Company, 'id' | 'code' | 'sites' | 'totalFuelThisMonth' | 'activeVehiclesCount' | 'licenseExpiry' | 'licenseStatus' | 'modules'>) => void;
  updateCompanyStatus: (companyId: string, status: 'AKTİF' | 'ASKIDA' | 'DENEME') => void;

  // Toast
  toast: ToastState | null;
  showToast: (message: string, type?: 'success' | 'info' | 'warning' | 'error') => void;

  // Pump Calibration Multiplier & EEPROM Persistence
  kFactor: number; // Pulse / Litre (Örn: 100.0)
  calibrationMultiplier: number;
  setCalibrationMultiplier: (val: number) => void;
  calculateCalibratedLiters: (rawAmount: number) => number;
  saveEEPROMCalibration: (newKFactor: number, newMultiplier: number) => void;

  // Selected Tenant for Admin Detail View
  selectedTenantForDetail: Company | null;
  setSelectedTenantForDetail: (company: Company | null) => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [companies, setCompanies] = useState<Company[]>(INITIAL_COMPANIES);
  const [currentCompanyIndex, setCurrentCompanyIndex] = useState<number>(() => {
    const saved = localStorage.getItem('YAKIT_COMPANY_IDX');
    return saved ? parseInt(saved, 10) : 0;
  });

  const [rawSelectedSiteFilter, setRawSelectedSiteFilter] = useState<string>(() => {
    return localStorage.getItem('YAKIT_SITE_FILTER') || 'TÜMÜ';
  });

  // Authentication state & Manager Mode toggle (Persisted across F5 reloads)
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => {
    return localStorage.getItem('YAKIT_IS_AUTH') === 'true';
  });

  const [isManagerMode, setIsManagerMode] = useState<boolean>(() => {
    const saved = localStorage.getItem('YAKIT_IS_MANAGER_MODE');
    return saved !== null ? saved === 'true' : true;
  });

  const [currentUser, setCurrentUser] = useState<{ username: string; companyName: string; role: string; siteName?: string } | null>(() => {
    const saved = localStorage.getItem('YAKIT_CURRENT_USER');
    if (!saved) return null;
    try {
      return JSON.parse(saved);
    } catch {
      return null;
    }
  });

  // Automatically sync Auth & Mode state changes to localStorage
  useEffect(() => {
    localStorage.setItem('YAKIT_IS_AUTH', isAuthenticated ? 'true' : 'false');
  }, [isAuthenticated]);

  useEffect(() => {
    localStorage.setItem('YAKIT_IS_MANAGER_MODE', isManagerMode ? 'true' : 'false');
  }, [isManagerMode]);

  useEffect(() => {
    if (currentUser) {
      localStorage.setItem('YAKIT_CURRENT_USER', JSON.stringify(currentUser));
    } else {
      localStorage.removeItem('YAKIT_CURRENT_USER');
    }
  }, [currentUser]);

  useEffect(() => {
    localStorage.setItem('YAKIT_COMPANY_IDX', currentCompanyIndex.toString());
  }, [currentCompanyIndex]);

  useEffect(() => {
    localStorage.setItem('YAKIT_SITE_FILTER', rawSelectedSiteFilter);
  }, [rawSelectedSiteFilter]);

  // Enforce selected site filter lock for Site Operator mode
  const selectedSiteFilter = (!isManagerMode && currentUser?.siteName) ? currentUser.siteName : rawSelectedSiteFilter;

  const setSelectedSiteFilter = (site: string) => {
    if (!isManagerMode && currentUser?.siteName) {
      setRawSelectedSiteFilter(currentUser.siteName);
      return;
    }
    setRawSelectedSiteFilter(site);
  };

  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [tanks, setTanks] = useState<Tank[]>([]);
  const [transactions, setTransactions] = useState<FuelTransaction[]>(INITIAL_TRANSACTIONS);
  const [crossSitePermissions, setCrossSitePermissions] = useState<CrossSitePermission[]>(INITIAL_CROSS_SITE_PERMISSIONS);
  const [hardwareDevices, setHardwareDevices] = useState<HardwareDevice[]>(INITIAL_HARDWARE_DEVICES);
  const [hardwareLogs, setHardwareLogs] = useState<HardwareLog[]>(INITIAL_HARDWARE_LOGS);

  const [simulatedLatencyMs, setSimulatedLatencyMs] = useState<number>(14);
  const [isLogStreamActive, setIsLogStreamActive] = useState<boolean>(true);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [selectedTenantForDetail, setSelectedTenantForDetail] = useState<Company | null>(null);
  const [tankRefreshKey, setTankRefreshKey] = useState<number>(0);

  // EEPROM Persistent Calibration State (Default: 100.0 Pulse/Litre, Multiplier: 1.0)
  const [kFactor, setKFactor] = useState<number>(() => {
    const saved = localStorage.getItem('YAKIT_EEPROM_K_FACTOR');
    return saved ? parseFloat(saved) : 100.0;
  });

  const [calibrationMultiplier, setCalibrationMultiplier] = useState<number>(() => {
    const saved = localStorage.getItem('YAKIT_EEPROM_MULTIPLIER');
    return saved ? parseFloat(saved) : 1.0;
  });

  const calculateCalibratedLiters = (rawAmount: number): number => {
    return Number((rawAmount * calibrationMultiplier).toFixed(2));
  };

  const saveEEPROMCalibration = (newKFactor: number, newMultiplier: number) => {
    setKFactor(newKFactor);
    setCalibrationMultiplier(newMultiplier);
    localStorage.setItem('YAKIT_EEPROM_K_FACTOR', newKFactor.toString());
    localStorage.setItem('YAKIT_EEPROM_MULTIPLIER', newMultiplier.toString());

    // Hardware log for EEPROM Flash sync & interrupt verification
    const now = new Date();
    const timeStr = now.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setHardwareLogs(prev => [
      ...prev,
      {
        id: Date.now().toString(),
        timestamp: timeStr,
        deviceCode: 'ESP32_FLOW_ISR',
        tag: 'EEPROM',
        message: `[EEPROM_FLASH_WRITE] Address 0x0040 updated: K_Faktoru = ${newKFactor.toFixed(2)} Pulse/L | Multiplier = x${newMultiplier.toFixed(4)}. Hardware Interrupt Verified.`,
        siteName: 'Sistem Kalibrasyonu'
      }
    ]);

    showToast(`Yeni K-Faktörü (${newKFactor.toFixed(2)} Pulse/L) EEPROM/Flash hafızaya yazıldı! Cihaz kapansa da saklanır.`, 'success');
  };

  const currentCompany = companies[currentCompanyIndex] || companies[0];

  const loginCompany = async (username: string, password: string): Promise<{ success: boolean; error?: string }> => {
    const trimmedUsername = username.trim().toLowerCase();
    const trimmedPassword = password.trim();

    if (!trimmedUsername || !trimmedPassword) {
      return { success: false, error: 'Firma kullanıcı adı ve şifre zorunludur.' };
    }

    try {
      // Send login request to Backend API (PostgreSQL + Argon2id Verification)
      const response = await fetch(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-ID': 'comp-camsa'
        },
        body: JSON.stringify({ username: trimmedUsername, password: trimmedPassword })
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        return { success: false, error: data.message || 'Girilen kullanıcı adı veya şifre hatalı.' };
      }

      // Store JWT Tokens in LocalStorage
      localStorage.setItem('YAKIT_ACCESS_TOKEN', data.accessToken);
      localStorage.setItem('YAKIT_REFRESH_TOKEN', data.refreshToken);

      const targetComp = companies.find(
        c => (c.username && c.username.toLowerCase() === trimmedUsername) ||
             c.code.toLowerCase() === trimmedUsername ||
             c.name.toLowerCase().includes(trimmedUsername)
      ) || companies[0];

      const targetIdx = companies.findIndex(c => c.id === targetComp.id);
      if (targetIdx !== -1) {
        setCurrentCompanyIndex(targetIdx);
      }

      setIsAuthenticated(true);
      setIsManagerMode(true);
      setRawSelectedSiteFilter('TÜMÜ');
      setCurrentUser({
        username: data.user?.username || targetComp.username || username.trim(),
        companyName: targetComp.name,
        role: 'Firma Yöneticisi'
      });

      showToast(`PostgreSQL Giriş Başarılı: ${targetComp.name} Yönetici paneline yönlendiriliyorsunuz`, 'success');
      return { success: true };
    } catch (err: any) {
      console.error('Backend API Hatası:', err);
      return { success: false, error: 'Sunucuya bağlanılamadı veya şifre doğrulaması başarısız oldu.' };
    }
  };

  const loginSiteOperator = async (username: string, password: string): Promise<{ success: boolean; error?: string }> => {
    const trimmedUsername = username.trim().toLowerCase();
    const trimmedPassword = password.trim();

    if (!trimmedUsername || !trimmedPassword) {
      return { success: false, error: 'Şantiye kullanıcı adı ve şifre zorunludur.' };
    }

    try {
      // Send login request to Backend API (PostgreSQL + Argon2id Verification)
      const response = await fetch(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ username: trimmedUsername, password: trimmedPassword })
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        return { success: false, error: data.message || 'Girilen şantiye kullanıcı adı veya şifre hatalı.' };
      }

      // Store JWT Tokens in LocalStorage
      localStorage.setItem('YAKIT_ACCESS_TOKEN', data.accessToken);
      localStorage.setItem('YAKIT_REFRESH_TOKEN', data.refreshToken);

      let matchedSite: Site | undefined;
      let matchedCompany: Company | undefined;

      for (const company of companies) {
        const site = company.sites.find(
          s => (s.username && s.username.toLowerCase() === trimmedUsername) ||
               s.id.toLowerCase() === trimmedUsername
        );
        if (site) {
          matchedSite = site;
          matchedCompany = company;
          break;
        }
      }

      const activeComp = matchedCompany || companies[0];
      const activeSiteName = data.user?.siteName || matchedSite?.name || 'Gebze Ana Şantiye';

      setRawSelectedSiteFilter(activeSiteName);
      setIsAuthenticated(true);
      setIsManagerMode(false);
      setCurrentUser({
        username: data.user?.username || username.trim(),
        companyName: activeComp.name,
        siteName: activeSiteName,
        role: 'Şantiye Saha Operatörü'
      });

      showToast(`PostgreSQL Şantiye Girişi Başarılı: ${activeSiteName} modunda panele yönlendiriliyorsunuz`, 'success');
      return { success: true };
    } catch (err: any) {
      console.error('Backend API Hatası:', err);
      return { success: false, error: 'Sunucuya bağlanılamadı veya şifre doğrulaması başarısız oldu.' };
    }
  };

  const logoutCompany = () => {
    setIsAuthenticated(false);
    setIsManagerMode(true);
    setCurrentUser(null);
    localStorage.removeItem('YAKIT_IS_AUTH');
    localStorage.removeItem('YAKIT_IS_MANAGER_MODE');
    localStorage.removeItem('YAKIT_CURRENT_USER');
    localStorage.removeItem('YAKIT_COMPANY_IDX');
    localStorage.removeItem('YAKIT_SITE_FILTER');
    localStorage.removeItem('YAKIT_ACCESS_TOKEN');
    localStorage.removeItem('YAKIT_REFRESH_TOKEN');
    showToast('Oturum kapatıldı. Giriş sayfasına dönüldü.', 'info');
  };

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

  const updateCompanyStatus = (companyId: string, status: 'AKTİF' | 'ASKIDA' | 'DENEME') => {
    setCompanies(prev => prev.map(c => {
      if (c.id === companyId) {
        const updated = { ...c, licenseStatus: status };
        if (selectedTenantForDetail?.id === companyId) {
          setSelectedTenantForDetail(updated);
        }
        showToast(`${c.name} lisans durumu güncellendi: ${status}`);
        return updated;
      }
      return c;
    }));
  };


  // Vehicle CRUD
  const fetchVehicles = async () => {
    try {
      const response = await apiFetch('/vehicles');
      if (response.success && response.data) {
        // Backend returns snake_case for DB fields, so we map them to camelCase
        const mappedVehicles: Vehicle[] = response.data.map((v: any) => ({
          id: v.id,
          plate: v.plate,
          brandModel: v.brand_model,
          type: v.vehicle_type,
          siteName: v.site_name || 'Gebze Ana Şantiye',
          assignedDriver: 'Atanmadı', // TODO: Fetch from relations
          rfidTag: v.rfid_tag,
          fuelCapacityLiters: 500, // TODO: Mock or new DB column
          lastRefuelDate: 'Henüz yok', // TODO: Calculate from transactions
          lastRefuelLiters: 0,
          totalRefuelsCount: 0,
          status: v.status
        }));
        setVehicles(mappedVehicles);
      }
    } catch (err: any) {
      showToast(`Araçlar getirilirken hata: ${err.message}`, 'error');
    }
  };

  const addVehicle = async (newVeh: Omit<Vehicle, 'id' | 'totalRefuelsCount'>) => {
    try {
      const payload = {
        plate: newVeh.plate,
        brandModel: newVeh.brandModel,
        type: newVeh.type,
        rfidTag: newVeh.rfidTag,
        fuelCapacityLiters: newVeh.fuelCapacityLiters || 450,
        status: newVeh.status
      };
      await apiFetch('/vehicles', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      showToast(`Yeni araç kaydedildi: ${newVeh.plate}`);
      await fetchVehicles();
    } catch (err: any) {
      showToast(`Araç eklenirken hata: ${err.message}`, 'error');
    }
  };

  const updateVehicle = async (id: string, updatedVeh: Partial<Vehicle>) => {
    try {
      const payload = {
        ...(updatedVeh.plate && { plate: updatedVeh.plate }),
        ...(updatedVeh.brandModel && { brandModel: updatedVeh.brandModel }),
        ...(updatedVeh.type && { type: updatedVeh.type }),
        ...(updatedVeh.rfidTag && { rfidTag: updatedVeh.rfidTag }),
        ...(updatedVeh.fuelCapacityLiters && { fuelCapacityLiters: updatedVeh.fuelCapacityLiters }),
        ...(updatedVeh.status && { status: updatedVeh.status })
      };
      await apiFetch(`/vehicles/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      showToast('Araç bilgileri güncellendi');
      await fetchVehicles();
    } catch (err: any) {
      showToast(`Araç güncellenirken hata: ${err.message}`, 'error');
    }
  };

  const deleteVehicle = async (id: string) => {
    try {
      await apiFetch(`/vehicles/${id}`, {
        method: 'DELETE'
      });
      showToast(`Araç kaydı silindi`, 'warning');
      await fetchVehicles();
    } catch (err: any) {
      showToast(`Araç silinirken hata: ${err.message}`, 'error');
    }
  };

  useEffect(() => {
    if (isAuthenticated) {
      fetchVehicles();
      fetchDrivers();
      fetchTanks();
    }
  }, [isAuthenticated]);

  // Driver CRUD
  const fetchDrivers = async () => {
    try {
      const response = await apiFetch('/drivers');
      if (response.success && response.data) {
        const mappedDrivers: Driver[] = response.data.map((d: any) => ({
          id: d.id,
          name: d.name,
          tcNo: d.tc_no,
          phone: d.phone,
          licenseType: d.license_type,
          rfidCardId: d.rfid_card_id,
          status: d.status,
          siteName: d.site_name || 'Gebze Ana Şantiye',
          assignedVehiclePlate: 'Atanmadı', // TODO: Map this correctly from relations
          performanceScore: 100, // Mock
          totalFuelPumpedLiters: 0 // Mock
        }));
        setDrivers(mappedDrivers);
      }
    } catch (err: any) {
      showToast(`Şoförler getirilirken hata: ${err.message}`, 'error');
    }
  };

  const addDriver = async (newDrv: Omit<Driver, 'id' | 'totalFuelPumpedLiters'>) => {
    try {
      const payload = {
        name: newDrv.name,
        tcNo: newDrv.tcNo,
        phone: newDrv.phone,
        licenseType: newDrv.licenseType,
        rfidCardId: newDrv.rfidCardId,
        status: newDrv.status
      };
      await apiFetch('/drivers', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      showToast(`Yeni şoför eklendi: ${newDrv.name}`);
      await fetchDrivers();
    } catch (err: any) {
      showToast(`Şoför eklenirken hata: ${err.message}`, 'error');
    }
  };

  const updateDriver = async (id: string, updatedDrv: Partial<Driver>) => {
    try {
      const payload = {
        ...(updatedDrv.name && { name: updatedDrv.name }),
        ...(updatedDrv.tcNo && { tcNo: updatedDrv.tcNo }),
        ...(updatedDrv.phone && { phone: updatedDrv.phone }),
        ...(updatedDrv.licenseType && { licenseType: updatedDrv.licenseType }),
        ...(updatedDrv.rfidCardId && { rfidCardId: updatedDrv.rfidCardId }),
        ...(updatedDrv.status && { status: updatedDrv.status })
      };
      await apiFetch(`/drivers/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      showToast('Şoför bilgileri güncellendi');
      await fetchDrivers();
    } catch (err: any) {
      showToast(`Şoför güncellenirken hata: ${err.message}`, 'error');
    }
  };

  const deleteDriver = async (id: string) => {
    try {
      await apiFetch(`/drivers/${id}`, {
        method: 'DELETE'
      });
      showToast(`Şoför kaydı silindi`, 'warning');
      await fetchDrivers();
    } catch (err: any) {
      showToast(`Şoför silinirken hata: ${err.message}`, 'error');
    }
  };

  // Tank CRUD
  const fetchTanks = async () => {
    try {
      const response = await apiFetch('/tanks');
      if (response.success && response.data) {
        const mappedTanks: Tank[] = response.data.map((t: any) => ({
          id: t.id,
          name: t.name,
          siteName: t.site_name || 'Gebze Ana Şantiye',
          capacityLiters: Number(t.capacity_liters),
          currentLevelLiters: Number(t.current_level_liters),
          fuelType: t.fuel_type,
          temperatureC: 22.5, // Mock from hardware
          lastRefillDate: 'Bilinmiyor',
          sensorId: 'SEN-' + t.id.substring(4, 10),
          status: t.status
        }));
        setTanks(mappedTanks);
      }
    } catch (err: any) {
      showToast(`Tanklar getirilirken hata: ${err.message}`, 'error');
    }
  };

  const addTank = async (newTank: Omit<Tank, 'id'>) => {
    try {
      const payload = {
        name: newTank.name,
        capacityLiters: newTank.capacityLiters,
        currentLevelLiters: newTank.currentLevelLiters,
        fuelType: newTank.fuelType,
        status: newTank.status
      };
      await apiFetch('/tanks', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      showToast(`Yeni tank eklendi: ${newTank.name}`);
      await fetchTanks();
    } catch (err: any) {
      showToast(`Tank eklenirken hata: ${err.message}`, 'error');
    }
  };

  const updateTank = async (id: string, updatedTank: Partial<Tank>) => {
    try {
      const payload = {
        ...(updatedTank.name && { name: updatedTank.name }),
        ...(updatedTank.capacityLiters !== undefined && { capacityLiters: updatedTank.capacityLiters }),
        ...(updatedTank.currentLevelLiters !== undefined && { currentLevelLiters: updatedTank.currentLevelLiters }),
        ...(updatedTank.fuelType && { fuelType: updatedTank.fuelType }),
        ...(updatedTank.status && { status: updatedTank.status })
      };
      await apiFetch(`/tanks/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      showToast('Tank bilgileri güncellendi');
      await fetchTanks();
    } catch (err: any) {
      showToast(`Tank güncellenirken hata: ${err.message}`, 'error');
    }
  };

  const deleteTank = async (id: string) => {
    try {
      await apiFetch(`/tanks/${id}`, {
        method: 'DELETE'
      });
      showToast(`Tank silindi`, 'warning');
      await fetchTanks();
    } catch (err: any) {
      showToast(`Tank silinirken hata: ${err.message}`, 'error');
    }
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

  const addCrossSitePermission = (perm: Omit<CrossSitePermission, 'id' | 'usedLiters' | 'status'>) => {
    const newPerm: CrossSitePermission = {
      ...perm,
      id: 'csp-' + Date.now(),
      usedLiters: 0,
      status: 'AKTİF'
    };
    setCrossSitePermissions(prev => [newPerm, ...prev]);
    showToast(`Çapraz şantiye yetkisi eklendi: ${perm.vehiclePlate} → ${perm.targetSite}`);
  };

  const addCompany = (comp: Omit<Company, 'id' | 'code' | 'sites' | 'totalFuelThisMonth' | 'activeVehiclesCount' | 'licenseExpiry' | 'licenseStatus' | 'modules'>) => {
    const code = 'COMP-' + (companies.length + 1).toString().padStart(2, '0');
    const compUsername = comp.name.toLowerCase().replace(/[^a-z0-9]/g, '') || 'firma';
    const newComp: Company = {
      ...comp,
      id: 'comp-' + Date.now(),
      code,
      username: compUsername,
      password: '123456',
      sites: [
        { id: 'site-' + Date.now(), name: `${comp.name} Ana Şantiye`, username: `${compUsername}-santiye`, password: '123456', location: comp.city, activeVehiclesCount: 2, activeTanksCount: 1 }
      ],
      totalFuelThisMonth: 0,
      activeVehiclesCount: 2,
      licenseExpiry: '2027-12-31',
      licenseStatus: 'AKTİF',
      modules: {
        eInvoice: true,
        aiAnomaly: true,
        smartWarehouse: false,
        maintenanceTrack: true,
        driverScore: true,
        crossSiteAuth: true
      }
    };
    setCompanies(prev => [...prev, newComp]);
    showToast(`Yeni firma sisteme tanımlandı: ${newComp.name}`);
  };

  return (
    <AppContext.Provider
      value={{
        isAuthenticated,
        isManagerMode,
        setIsManagerMode,
        currentUser,
        loginCompany,
        loginSiteOperator,
        logoutCompany,
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
        fetchVehicles,
        addVehicle,
        updateVehicle,
        deleteVehicle,
        fetchDrivers,
        addDriver,
        updateDriver,
        deleteDriver,
        fetchTanks,
        addFuelTransaction,
        addHardwareLog,
        clearHardwareLogs,
        toggleCrossSiteStatus,
        addCrossSitePermission,
        addCompany,
        updateCompanyStatus,
        toast,
        showToast,
        selectedTenantForDetail,
        setSelectedTenantForDetail,
        kFactor,
        calibrationMultiplier,
        setCalibrationMultiplier,
        calculateCalibratedLiters,
        saveEEPROMCalibration,
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
