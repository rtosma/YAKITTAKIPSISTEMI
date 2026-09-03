import React, { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1';
import { apiFetch, UNAUTHORIZED_EVENT } from '../utils/api';
import { socket, connectSocket, disconnectSocket } from '../utils/socket';
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
// NOTE: Oturum açıldığında firma bilgisi de dahil her şey PostgreSQL backend'inden
// (apiFetch) çekiliyor: firma profili -> GET /companies/me (yalnızca giriş yapan
// tenant, SITE_MANAGER için tek şantiye). INITIAL_COMPANIES yalnızca giriş
// yapılmadan önceki ilk state ve auth'suz /admin (Süper Admin) paneli için durur.
import { INITIAL_COMPANIES } from '../mock';

interface ToastState {
  id: string;
  message: string;
  type: 'success' | 'info' | 'warning' | 'error';
}

// Backend'in JWT payload'ında döndürdüğü GERÇEK yetki rolü (bkz.
// backend/src/services/tokenService.ts UserRole). FE-803: rota koruması ve
// UI element gizleme bu değere göre yapılır — asla görüntü metnine göre değil.
export type UserRole = 'SUPER_ADMIN' | 'COMPANY_OWNER' | 'SITE_MANAGER' | 'PUMP_OPERATOR' | 'DRIVER';



interface AppContextType {
  // Auth & Permissions Mode State
  isAuthenticated: boolean;
  isManagerMode: boolean;
  setIsManagerMode: (val: boolean) => void;
  currentUser: { username: string; companyName: string; role: UserRole; siteName?: string } | null;
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
  fetchCrossSitePermissions: () => Promise<void>;
  hardwareDevices: HardwareDevice[];
  hardwareLogs: HardwareLog[];

  // Refresh trigger for animations
  tankRefreshKey: number;
  triggerTankRefresh: () => Promise<void>;

  // Latency & Terminal Stream
  simulatedLatencyMs: number;
  isLogStreamActive: boolean;
  setIsLogStreamActive: (active: boolean) => void;

  // Actions
  fetchCompanies: () => Promise<void>;
  fetchHardwareDevices: () => Promise<void>;
  toggleCompanyModule: (companyId: string, moduleKey: keyof CompanyModule) => Promise<void>;
  
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

  // Transaction (İkmal) history
  fetchTransactions: () => Promise<void>;
  addFuelTransaction: (tx: Omit<FuelTransaction, 'id' | 'timestamp'>) => Promise<void>;
  addHardwareLog: (log: Omit<HardwareLog, 'id' | 'timestamp'>) => void;
  clearHardwareLogs: () => void;
  toggleCrossSiteStatus: (id: string) => Promise<void>;
  addCrossSitePermission: (perm: Omit<CrossSitePermission, 'id' | 'usedLiters' | 'status'>) => Promise<void>;
  addCompany: (comp: Omit<Company, 'id' | 'code' | 'sites' | 'totalFuelThisMonth' | 'activeVehiclesCount' | 'licenseExpiry' | 'licenseStatus' | 'modules'>) => Promise<void>;
  updateCompanyStatus: (companyId: string, status: 'AKTİF' | 'ASKIDA' | 'DENEME') => Promise<void>;

  // Toast
  toast: ToastState | null;
  showToast: (message: string, type?: 'success' | 'info' | 'warning' | 'error') => void;

  // Selected Tenant for Admin Detail View
  selectedTenantForDetail: Company | null;
  setSelectedTenantForDetail: (company: Company | null) => void;

  // Pump Calibration Multiplier & EEPROM Persistence
  kFactor: number; // Pulse / Litre (Örn: 100.0)
  calibrationMultiplier: number;
  setCalibrationMultiplier: (val: number) => void;
  calculateCalibratedLiters: (rawAmount: number) => number;
  saveEEPROMCalibration: (newKFactor: number, newMultiplier: number) => void;

  // Real DB Sites
  sites: string[];
  fetchSites: () => Promise<void>;
  addSite: (siteName: string) => Promise<void>;
  deleteSite: (siteName: string) => Promise<void>;
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

  const [currentUser, setCurrentUser] = useState<{ username: string; companyName: string; role: UserRole; siteName?: string } | null>(() => {
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
  const [sites, setSites] = useState<string[]>([]);
  // Bu koleksiyonların henüz backend endpoint'i yok; boş başlarlar ve yalnızca
  // kullanıcı eylemleriyle (ikmal kaydı, yetki ekleme, IoT logu) dolarlar.
  const [transactions, setTransactions] = useState<FuelTransaction[]>([]);
  const [crossSitePermissions, setCrossSitePermissions] = useState<CrossSitePermission[]>([]);
  const [hardwareDevices, setHardwareDevices] = useState<HardwareDevice[]>([]);
  const [hardwareLogs, setHardwareLogs] = useState<HardwareLog[]>([]);

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

      // Firma bilgisi artık mock eşleştirmeyle değil, DB'den (/companies/me) çekiliyor.
      const profile = await fetchCompanyProfile();
      const companyName = profile?.name || data.user?.username || username.trim();

      setIsAuthenticated(true);
      setIsManagerMode(true);
      setRawSelectedSiteFilter('TÜMÜ');
      setCurrentUser({
        username: data.user?.username || username.trim(),
        companyName,
        // Backend'in JWT'de imzaladığı GERÇEK rol (SUPER_ADMIN/COMPANY_OWNER/...) —
        // önceden burada sabit "Firma Yöneticisi" metni tutuluyordu ve hiçbir rol
        // kontrolü mümkün değildi (FE-803 ihlali). Fallback yalnızca beklenmeyen
        // bir API yanıtına karşı son çare.
        role: (data.user?.role as UserRole) || 'COMPANY_OWNER'
      });

      showToast(`PostgreSQL Giriş Başarılı: ${companyName} Yönetici paneline yönlendiriliyorsunuz`, 'success');
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

      // Şantiye operatörünün firması ve şantiyesi DB'den (/companies/me) geliyor;
      // SITE_MANAGER token'ında yalnızca kendi şantiyesi döner.
      const profile = await fetchCompanyProfile();
      const activeSiteName = data.user?.siteName || profile?.sites[0]?.name || '';
      const companyName = profile?.name || username.trim();

      setRawSelectedSiteFilter(activeSiteName);
      setIsAuthenticated(true);
      setIsManagerMode(false);
      setCurrentUser({
        username: data.user?.username || username.trim(),
        companyName,
        siteName: activeSiteName,
        // bkz. loginCompany yorumu — backend'in gerçek rolü kullanılır.
        role: (data.user?.role as UserRole) || 'SITE_MANAGER'
      });

      showToast(`PostgreSQL Şantiye Girişi Başarılı: ${activeSiteName || companyName} modunda panele yönlendiriliyorsunuz`, 'success');
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

  // 401 (token süresi dolmuş/geçersiz) durumunda önceden sadece console.warn
  // basılıyordu; kullanıcı oturumu düşmeden sonsuza kadar başarısız istek
  // toast'ları görmeye devam ediyordu. apiFetch artık bu durumda bir olay
  // yayınlıyor (bkz. utils/api.ts), burada onu dinleyip otomatik logout
  // yapıyoruz — mevcut layout guard'ları (isAuthenticated kontrolü) kullanıcıyı
  // otomatik olarak giriş ekranına yönlendirir.
  useEffect(() => {
    const handleUnauthorized = () => {
      logoutCompany();
      showToast('Oturum süreniz doldu. Lütfen tekrar giriş yapın.', 'warning');
    };
    window.addEventListener(UNAUTHORIZED_EVENT, handleUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, handleUnauthorized);
  }, []);

  // FE-801: Socket.io canlı bağlantı. Bir ikmal tamamlandığında (başka bir
  // sekmede/kullanıcıda dahi olsa) tank seviyeleri ve işlem geçmişi sayfa
  // yenilenmeden anında güncellenir.
  const wasConnectedRef = useRef(false);
  useEffect(() => {
    if (!isAuthenticated) {
      disconnectSocket();
      return;
    }

    const handleDispenseCompleted = (payload: { transaction: any; tanks: any[] }) => {
      const mappedTanks: Tank[] = payload.tanks.map((t: any) => ({
        id: t.id,
        name: t.name,
        siteName: t.site_name || 'Gebze Ana Şantiye',
        capacityLiters: Number(t.capacity_liters),
        currentLevelLiters: Number(t.current_level_liters),
        fuelType: t.fuel_type,
        temperatureC: 22.5,
        lastRefillDate: 'Bilinmiyor',
        sensorId: 'SEN-' + t.id.substring(4, 10),
        status: t.status
      }));
      setTanks(mappedTanks);

      const tx = payload.transaction;
      const newTx: FuelTransaction = {
        id: tx.id,
        timestamp: new Date(tx.created_at).toLocaleString('tr-TR').replace(',', ''),
        siteName: tx.site_name,
        vehiclePlate: tx.vehicle_plate,
        driverName: tx.driver_name || '',
        tankName: tx.tank_name || '',
        amountLiters: Number(tx.amount_liters),
        flowRateLpm: tx.flow_rate_lpm != null ? Number(tx.flow_rate_lpm) : 0,
        pumpStatus: tx.pump_status,
        type: tx.type,
        rfidAuth: tx.rfid_auth
      };
      // Aynı işlem zaten local olarak eklenmiş olabilir (ikmali BEN
      // başlattıysam addFuelTransaction kendi fetchTransactions'ını zaten
      // çağırdı) — id'ye göre tekilleştir.
      setTransactions(prev => prev.some(p => p.id === newTx.id) ? prev : [newTx, ...prev]);
    };

    // FE-801 AC: bağlantı koptuğunda "Bağlantı Yenileniyor..." uyarısı +
    // exponential backoff ile yeniden bağlanma (socket.io-client'ın
    // reconnectionDelay/reconnectionDelayMax ayarı bunu zaten yapar — bkz.
    // utils/socket.ts). Kasıtlı (logout / sekme gizlenme) kopmalarda toast
    // gösterilmez — yalnızca gerçek bağlantı sorunlarında.
    const handleConnect = () => {
      if (wasConnectedRef.current) {
        showToast('Canlı bağlantı yeniden sağlandı.', 'success');
      }
      wasConnectedRef.current = true;
    };
    const handleDisconnect = (reason: string) => {
      if (reason !== 'io client disconnect') {
        showToast('Bağlantı Yenileniyor...', 'warning');
      }
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('dispense:completed', handleDispenseCompleted);

    connectSocket();

    // FE-801 AC: sekme arka plana alındığında bağlantıyı kapatıp gereksiz
    // render/bellek sızıntısını önle; tekrar görünür olunca sessizce (toast
    // göstermeden) yeniden bağlan.
    const handleVisibilityChange = () => {
      if (document.hidden) {
        socket.disconnect();
      } else {
        wasConnectedRef.current = false;
        connectSocket();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('dispense:completed', handleDispenseCompleted);
      disconnectSocket();
      wasConnectedRef.current = false;
    };
  }, [isAuthenticated]);

  const triggerTankRefresh = async () => {
    // Önceden bu fonksiyon backend'e hiç sormadan sadece animasyon anahtarını
    // artırıp "yenilendi" toast'ı gösteriyordu — kullanıcı gerçekte bayat veri
    // görmeye devam ediyordu. Artık gerçekten fetchTanks() ile DB'den taze
    // veri çekip öyle güncelliyor.
    await fetchTanks();
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

  // NOT: Sahte IoT log akışı simülasyonu kaldırıldı. hardwareLogs artık yalnızca
  // gerçek kullanıcı eylemleriyle (addHardwareLog / EEPROM kalibrasyon kaydı) dolar.
  // Gerçek telemetri için ileride bir /telemetry veya /hardware-logs endpoint'i eklenmeli.

  // Actions
  // Önceden bu iki fonksiyon yalnızca local state'i güncelliyordu (sayfa
  // yenilenince kayboluyordu). Artık PATCH /companies/:id (SUPER_ADMIN)
  // çağırıp gerçek listeyi yeniden çekiyor.
  const toggleCompanyModule = async (companyId: string, moduleKey: keyof CompanyModule) => {
    const target = companies.find(c => c.id === companyId);
    if (!target) return;
    const updatedVal = !target.modules[moduleKey];
    try {
      await apiFetch(`/companies/${companyId}`, {
        method: 'PATCH',
        body: JSON.stringify({ modules: { [moduleKey]: updatedVal } })
      });
      await fetchCompanies();
      if (selectedTenantForDetail?.id === companyId) {
        setSelectedTenantForDetail({ ...target, modules: { ...target.modules, [moduleKey]: updatedVal } });
      }
      showToast(`Modül durumu güncellendi: ${moduleKey} → ${updatedVal ? 'AKTİF' : 'PASİF'}`);
    } catch (err: any) {
      showToast(`Modül güncellenirken hata: ${err.message}`, 'error');
    }
  };

  const updateCompanyStatus = async (companyId: string, status: 'AKTİF' | 'ASKIDA' | 'DENEME') => {
    const target = companies.find(c => c.id === companyId);
    if (!target) return;
    try {
      await apiFetch(`/companies/${companyId}`, {
        method: 'PATCH',
        body: JSON.stringify({ licenseStatus: status })
      });
      await fetchCompanies();
      if (selectedTenantForDetail?.id === companyId) {
        setSelectedTenantForDetail({ ...target, licenseStatus: status });
      }
      showToast(`${target.name} lisans durumu güncellendi: ${status}`);
    } catch (err: any) {
      showToast(`Lisans durumu güncellenirken hata: ${err.message}`, 'error');
    }
  };

  // Firma profili — yalnızca oturum açan tenant'ın firması DB'den (/companies/me).
  // SITE_MANAGER (şantiye) girişinde backend yalnızca o şantiyeyi döndürür.
  const fetchCompanyProfile = async (): Promise<Company | null> => {
    try {
      const response = await apiFetch('/companies/me');
      if (response.success && response.data) {
        const d = response.data;
        const company: Company = {
          id: d.id,
          name: d.name,
          code: d.code || String(d.id || '').toUpperCase(),
          taxNumber: d.taxNumber || '',
          city: d.city || '',
          licenseStatus: d.licenseStatus || 'AKTİF',
          licenseExpiry: d.licenseExpiry || '',
          sites: Array.isArray(d.sites)
            ? d.sites.map((s: any) => ({
                id: s.id,
                name: s.name,
                location: s.location || '',
                activeTanksCount: s.activeTanksCount ?? 0,
                activeVehiclesCount: s.activeVehiclesCount ?? 0
              }))
            : [],
          modules: {
            aiAnomaly: !!d.modules?.aiAnomaly,
            eInvoice: !!d.modules?.eInvoice,
            smartWarehouse: !!d.modules?.smartWarehouse,
            maintenanceTrack: !!d.modules?.maintenanceTrack,
            driverScore: !!d.modules?.driverScore,
            crossSiteAuth: !!d.modules?.crossSiteAuth
          },
          activeVehiclesCount: d.activeVehiclesCount ?? 0,
          totalFuelThisMonth: d.totalFuelThisMonth ?? 0
        };
        setCompanies([company]);
        setCurrentCompanyIndex(0);
        return company;
      }
    } catch (err: any) {
      console.error('Firma profili getirilirken hata:', err);
    }
    return null;
  };

  // Sites Fetch
  const fetchSites = async () => {
    try {
      const response = await apiFetch('/sites');
      if (response.success && response.data) {
        setSites(response.data);
      }
    } catch (err: any) {
      console.error('Şantiyeler getirilirken hata:', err);
    }
  };

  const addSite = async (siteName: string) => {
    try {
      const response = await apiFetch('/sites', {
        method: 'POST',
        body: JSON.stringify({ siteName })
      });
      if (response.success) {
        showToast(`Yeni şantiye eklendi: ${siteName}`);
        await fetchSites();
        await fetchTanks();
      }
    } catch (err: any) {
      showToast(`Şantiye eklenirken hata: ${err.message}`, 'error');
    }
  };

  const deleteSite = async (siteName: string) => {
    try {
      const response = await apiFetch(`/sites/${encodeURIComponent(siteName)}`, {
        method: 'DELETE'
      });
      if (response.success) {
        showToast(`Şantiye silindi: ${siteName}`, 'warning');
        await fetchSites();
        await fetchVehicles();
        await fetchDrivers();
        await fetchTanks();
      }
    } catch (err: any) {
      showToast(`Şantiye silinirken hata: ${err.message}`, 'error');
    }
  };

  // Automatically fetch DB company profile, sites, vehicles, drivers, tanks &
  // transactions when user is authenticated
  // (F5 sonrası token localStorage'da kaldığından bu effect firma bilgisini yeniden kurar)
  useEffect(() => {
    if (isAuthenticated) {
      fetchCompanyProfile();
      fetchSites();
      fetchVehicles();
      fetchDrivers();
      fetchTanks();
      fetchTransactions();
      fetchCrossSitePermissions();
      // Yalnızca SUPER_ADMIN — /companies tüm tenant'ları döndürür, diğer
      // roller zaten 403 alır.
      if (currentUser?.role === 'SUPER_ADMIN') {
        fetchCompanies();
        fetchHardwareDevices();
      }
    }
  }, [isAuthenticated]);

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
          assignedDriver: v.assigned_driver_name || 'Atanmadı',
          rfidTag: v.rfid_tag,
          fuelCapacityLiters: v.fuel_capacity_liters != null ? Number(v.fuel_capacity_liters) : 0,
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
        siteName: newVeh.siteName,
        fuelCapacityLiters: newVeh.fuelCapacityLiters || 450,
        status: newVeh.status,
        assignedDriver: newVeh.assignedDriver
      };
      await apiFetch('/vehicles', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      showToast(`Yeni araç kaydedildi: ${newVeh.plate}`);
      await fetchVehicles();
      await fetchSites();
      await fetchDrivers();
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
        ...(updatedVeh.siteName && { siteName: updatedVeh.siteName }),
        ...(updatedVeh.fuelCapacityLiters && { fuelCapacityLiters: updatedVeh.fuelCapacityLiters }),
        ...(updatedVeh.status && { status: updatedVeh.status }),
        ...(updatedVeh.assignedDriver !== undefined && { assignedDriver: updatedVeh.assignedDriver })
      };
      await apiFetch(`/vehicles/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      showToast('Araç bilgileri güncellendi');
      await fetchVehicles();
      await fetchSites();
      await fetchDrivers();
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
          assignedVehiclePlate: d.assigned_vehicle_plate || 'Atanmadı',
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
        siteName: newDrv.siteName,
        status: newDrv.status,
        assignedVehiclePlate: newDrv.assignedVehiclePlate
      };
      await apiFetch('/drivers', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      showToast(`Yeni şoför eklendi: ${newDrv.name}`);
      await fetchDrivers();
      await fetchSites();
      // Şoför-araç ataması çift yönlü senkronize edilir (bkz. backend
      // syncDriverVehicleAssignment) — vehicles listesi de güncel kalmalı.
      await fetchVehicles();
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
        ...(updatedDrv.siteName && { siteName: updatedDrv.siteName }),
        ...(updatedDrv.status && { status: updatedDrv.status }),
        ...(updatedDrv.assignedVehiclePlate !== undefined && { assignedVehiclePlate: updatedDrv.assignedVehiclePlate })
      };
      await apiFetch(`/drivers/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      showToast('Şoför bilgileri güncellendi');
      await fetchDrivers();
      await fetchSites();
      await fetchVehicles();
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
        siteName: newTank.siteName,
        status: newTank.status
      };
      await apiFetch('/tanks', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      showToast(`Yeni tank eklendi: ${newTank.name}`);
      await fetchTanks();
      await fetchSites();
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
        ...(updatedTank.siteName && { siteName: updatedTank.siteName }),
        ...(updatedTank.status && { status: updatedTank.status })
      };
      await apiFetch(`/tanks/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      showToast('Tank bilgileri güncellendi');
      await fetchTanks();
      await fetchSites();
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

  const fetchTransactions = async () => {
    try {
      const response = await apiFetch('/transactions');
      if (response.success && response.data) {
        const mappedTransactions: FuelTransaction[] = response.data.map((t: any) => ({
          id: t.id,
          timestamp: new Date(t.created_at).toLocaleString('tr-TR').replace(',', ''),
          siteName: t.site_name,
          vehiclePlate: t.vehicle_plate,
          driverName: t.driver_name || '',
          tankName: t.tank_name || '',
          amountLiters: Number(t.amount_liters),
          flowRateLpm: t.flow_rate_lpm != null ? Number(t.flow_rate_lpm) : 0,
          pumpStatus: t.pump_status,
          type: t.type,
          rfidAuth: t.rfid_auth
        }));
        setTransactions(mappedTransactions);
      }
    } catch (err: any) {
      showToast(`İkmal geçmişi getirilirken hata: ${err.message}`, 'error');
    }
  };

  // Önceden bu fonksiyon backend'e hiç yazmadan yalnızca local React state'i
  // güncelliyordu (bir sonraki fetchTanks()/sayfa yenilemesinde kayıp
  // gidiyordu) ve tank seviyesini de yalnızca client tarafında düşürüyordu.
  // Artık gerçek POST /dispense çağrısı yapıyor; tank seviyesi sunucuda
  // atomik olarak düşürülüyor, ardından transactions ve tanks yeniden çekiliyor.
  const addFuelTransaction = async (newTx: Omit<FuelTransaction, 'id' | 'timestamp'>) => {
    try {
      await apiFetch('/dispense', {
        method: 'POST',
        body: JSON.stringify({
          siteName: newTx.siteName,
          vehiclePlate: newTx.vehiclePlate,
          driverName: newTx.driverName,
          tankName: newTx.tankName,
          amountLiters: newTx.amountLiters,
          flowRateLpm: newTx.flowRateLpm,
          pumpStatus: newTx.pumpStatus,
          type: newTx.type,
          rfidAuth: newTx.rfidAuth
        })
      });

      await Promise.all([fetchTransactions(), fetchTanks()]);
      showToast(`İkmal kaydedildi: ${newTx.vehiclePlate} — ${newTx.amountLiters} Litre`);
    } catch (err: any) {
      showToast(`İkmal kaydedilirken hata: ${err.message}`, 'error');
      throw err;
    }
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

  // Önceden bu iki fonksiyon yalnızca local state'i güncelliyordu; kota
  // takibi de client tarafında sahteydi. Artık gerçek backend'e yazıyor —
  // POST /dispense artık bu tabloyu kontrol edip used_liters'ı atomik
  // olarak günceliyor (bkz. tenantDb.createTransaction, FUEL-402).
  const fetchCrossSitePermissions = async () => {
    try {
      const response = await apiFetch('/cross-site-permissions');
      if (response.success && response.data) {
        const mapped: CrossSitePermission[] = response.data.map((p: any) => ({
          id: p.id,
          vehiclePlate: p.vehicle_plate,
          driverName: p.driver_name || '',
          homeSite: p.home_site,
          targetSite: p.target_site,
          allowedLiters: Number(p.allowed_liters),
          usedLiters: Number(p.used_liters),
          expiryDate: p.expiry_date,
          status: p.status
        }));
        setCrossSitePermissions(mapped);
      }
    } catch (err: any) {
      showToast(`Çapraz şantiye yetkileri getirilirken hata: ${err.message}`, 'error');
    }
  };

  const toggleCrossSiteStatus = async (id: string) => {
    const target = crossSitePermissions.find(p => p.id === id);
    if (!target) return;
    const nextStatus = target.status === 'AKTİF' ? 'SÜRESİ_DOLDU' : 'AKTİF';
    try {
      await apiFetch(`/cross-site-permissions/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus })
      });
      await fetchCrossSitePermissions();
      showToast(`Yetki durumu değişti: ${target.vehiclePlate} (${nextStatus})`);
    } catch (err: any) {
      showToast(`Yetki durumu güncellenirken hata: ${err.message}`, 'error');
    }
  };

  const addCrossSitePermission = async (perm: Omit<CrossSitePermission, 'id' | 'usedLiters' | 'status'>) => {
    try {
      await apiFetch('/cross-site-permissions', {
        method: 'POST',
        body: JSON.stringify(perm)
      });
      await fetchCrossSitePermissions();
      showToast(`Çapraz şantiye yetkisi eklendi: ${perm.vehiclePlate} → ${perm.targetSite}`);
    } catch (err: any) {
      showToast(`Çapraz şantiye yetkisi eklenirken hata: ${err.message}`, 'error');
    }
  };

  // Süper Admin panelinden yeni tenant firma oluşturur — backend companies +
  // ilk şantiye + COMPANY_OWNER giriş hesabını tek DB transaction'ında yazar
  // (bkz. adminDb.createCompanyWithOwner). Önceden bu tamamen local state'ti.
  const fetchCompanies = async () => {
    try {
      const response = await apiFetch('/companies');
      if (response.success && response.data) {
        setCompanies(response.data);
      }
    } catch (err: any) {
      showToast(`Firmalar getirilirken hata: ${err.message}`, 'error');
    }
  };

  // Kayıtlı ESP32/debimetre cihazlarını Redis'teki gerçek son bağlantı
  // durumuyla birlikte getirir (bkz. GET /devices). Önceden hardwareDevices
  // her zaman boş diziydi — hiçbir fetch bağlı değildi.
  const fetchHardwareDevices = async () => {
    try {
      const response = await apiFetch('/devices');
      if (response.success && response.data) {
        const mapped: HardwareDevice[] = response.data.map((d: any) => ({
          id: d.deviceCode,
          deviceCode: d.deviceCode,
          name: d.name,
          type: d.deviceCode.includes('TANK') ? 'Ultrasonik Tank Sensörü' : 'Debimetre & Solenoid',
          siteName: d.siteName,
          status: d.status
        }));
        setHardwareDevices(mapped);
      }
    } catch (err: any) {
      showToast(`Cihazlar getirilirken hata: ${err.message}`, 'error');
    }
  };

  const addCompany = async (comp: Omit<Company, 'id' | 'code' | 'sites' | 'totalFuelThisMonth' | 'activeVehiclesCount' | 'licenseExpiry' | 'licenseStatus' | 'modules'>) => {
    try {
      await apiFetch('/companies', {
        method: 'POST',
        body: JSON.stringify({ name: comp.name, city: comp.city, taxNumber: comp.taxNumber })
      });
      await fetchCompanies();
      showToast(`Yeni firma sisteme tanımlandı: ${comp.name}`);
    } catch (err: any) {
      showToast(`Firma eklenirken hata: ${err.message}`, 'error');
    }
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
        fetchCompanies,
        fetchHardwareDevices,
        vehicles,
        drivers,
        tanks,
        transactions,
        crossSitePermissions,
        fetchCrossSitePermissions,
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
        sites,
        fetchSites,
        addSite,
        deleteSite,
        fetchTransactions,
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
