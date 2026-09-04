import React, { useState } from 'react';
import { Outlet, useNavigate, useLocation, Navigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';

export const DeveloperLayout: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { simulatedLatencyMs, setSimulatedLatencyMs, isLogStreamActive, setIsLogStreamActive, hardwareDevices, isAuthenticated, currentUser } = useApp();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  if (currentUser?.mustChangePassword) {
    return <Navigate to="/parola-degistir" replace />;
  }

  // FE-803: Süper Admin paneli yalnızca gerçekten SUPER_ADMIN rolüne sahip
  // kullanıcılara açık olmalıdır. Önceden burada hiçbir rol kontrolü yoktu —
  // oturum açmış HERHANGİ bir kullanıcı (COMPANY_OWNER, SITE_MANAGER, hatta
  // DRIVER) doğrudan /admin URL'sini yazarak tüm firmaların verisine erişebilirdi.
  if (currentUser?.role !== 'SUPER_ADMIN') {
    return <Navigate to="/403" replace />;
  }

  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const navItems = [
    { label: 'Sistem Genel Bakış', path: '/admin', icon: 'dashboard' },
    { label: 'Tüm Firmalar', path: '/admin/tenants', icon: 'domain' },
    { label: 'Lisanslar & Modüller', path: '/admin/modules', icon: 'extension' },
    { label: 'ESP32 Cihaz Yönetimi', path: '/admin/devices', icon: 'developer_board' },
    { label: 'Canlı Sistem Logları', path: '/admin/logs', icon: 'terminal' },
    { label: 'Sistem Sağlığı', path: '/admin/health', icon: 'monitor_heart' },
  ];

  const currentPath = location.pathname;

  return (
    <div className="flex min-h-screen bg-[#131313] text-[#e5e2e1] font-sans antialiased">
      
      {/* MOBILE MENU BACKDROP OVERLAY */}
      {isMobileMenuOpen && (
        <div 
          className="fixed inset-0 bg-black/60 backdrop-blur-xs z-30 md:hidden transition-opacity"
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}

      {/* DEVELOPER SIDEBAR */}
      <aside className={`fixed inset-y-0 left-0 z-40 w-64 h-screen max-h-screen bg-[#1c1b1b] border-r border-[#353535] p-5 flex flex-col justify-between shrink-0 select-none overflow-y-auto transition-transform duration-200 md:translate-x-0 ${
        isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
      }`}>
        <div className="space-y-6">
          
          {/* Header Badge */}
          <div className="bg-[#20201f] border border-[#353535] p-3.5 rounded-xl flex items-center space-x-3">
            <div className="w-9 h-9 rounded-lg bg-[#ffb77f] text-[#412d00] flex items-center justify-center font-black shrink-0">
              <span className="material-symbols-outlined text-xl font-bold">terminal</span>
            </div>
            <div className="min-w-0">
              <h1 className="font-extrabold text-[#e5e2e1] text-xs uppercase tracking-wider truncate">
                GELİŞTİRİCİ MERKEZİ
              </h1>
              <p className="text-[10px] text-[#ffb77f] font-mono font-bold truncate">SÜPER ADMİN PANELİ</p>
            </div>
          </div>

          {/* Navigation Menu */}
          <nav className="space-y-1">
            {navItems.map((item) => {
              const isActive = currentPath === item.path || (item.path === '/admin' && currentPath === '/admin/overview');
              return (
                <button
                  key={item.path}
                  onClick={() => {
                    navigate(item.path);
                    setIsMobileMenuOpen(false);
                  }}
                  className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                    isActive
                      ? 'bg-[#ffb77f] text-[#412d00] shadow-md'
                      : 'text-[#e5e2e1] hover:bg-[#20201f] hover:text-[#ffb77f]'
                  }`}
                >
                  <span className="material-symbols-outlined text-lg shrink-0">{item.icon}</span>
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </nav>

        </div>

        {/* Sidebar Footer - Hardware status */}
        <div className="pt-4 mt-6 border-t border-[#353535] space-y-3 shrink-0">
          <div className="bg-[#20201f] p-3 rounded-xl border border-[#353535] text-xs font-mono space-y-1">
            <div className="flex items-center justify-between text-[#d5c4ab] font-bold">
              <span>MQTT BROKER</span>
              <span className="text-[#a1e8a2]">ONLINE</span>
            </div>
            <p className="text-[10px] text-[#d5c4ab]/70">{hardwareDevices.length} Cihaz Bağlı | Port: 1883</p>
          </div>

          <button
            onClick={() => navigate('/')}
            className="w-full flex items-center justify-center space-x-2 bg-[#20201f] hover:bg-[#282726] border border-[#353535] text-[#d5c4ab] hover:text-[#e5e2e1] py-2.5 rounded-xl text-xs font-bold transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-base">swap_horiz</span>
            <span>Rol Seçimine Dön</span>
          </button>
        </div>
      </aside>

      {/* MAIN CONTENT WRAPPER */}
      <div className="flex-1 flex flex-col min-w-0 md:pl-64">
        
        {/* DEVELOPER HEADER (Section 9.1) */}
        <header className="h-16 bg-[#131313] border-b border-[#353535] px-6 flex items-center justify-between sticky top-0 z-30 select-none">
          
          <div className="flex items-center space-x-4">
            <button
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              className="md:hidden p-2 text-[#e5e2e1] hover:bg-[#20201f] rounded-lg"
            >
              <span className="material-symbols-outlined text-2xl">menu</span>
            </button>

            {/* SUPER ADMIN BRAND TITLE */}
            <div className="flex items-center space-x-2.5">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#ffb800] to-[#ff8a00] text-[#412d00] font-black flex items-center justify-center text-xs shadow-sm">
                AŞ
              </div>
              <div className="hidden sm:block">
                <h2 className="text-xs font-black uppercase text-[#e5e2e1] tracking-wider leading-tight">
                  AKILLI ŞANTİYE — TEKTONİK PANOPTIKON
                </h2>
                <span className="text-[10px] font-mono text-[#ffb77f] font-bold">GELİŞTİRİCİ ADMİN PANELİ</span>
              </div>
            </div>
          </div>

          {/* Section 9.1 Controls & Navigation */}
          <div className="flex items-center space-x-4">
            
            {/* Simüle Gecikme Dropdown */}
            <div className="hidden lg:flex items-center space-x-2 bg-[#1c1b1b] border border-[#353535] px-3 py-1 rounded-xl text-xs font-mono">
              <span className="text-[#d5c4ab]">Gecikme:</span>
              <select
                value={simulatedLatencyMs}
                onChange={(e) => setSimulatedLatencyMs(Number(e.target.value))}
                className="bg-transparent text-[#a1e8a2] font-bold focus:outline-none cursor-pointer"
              >
                <option value={50} className="bg-[#1c1b1b]">50 ms</option>
                <option value={200} className="bg-[#1c1b1b]">200 ms</option>
                <option value={500} className="bg-[#1c1b1b]">500 ms</option>
                <option value={1200} className="bg-[#1c1b1b]">1200 ms</option>
              </select>
            </div>

            {/* Log Akışı Toggle Switch */}
            <button
              onClick={() => setIsLogStreamActive(!isLogStreamActive)}
              className={`hidden sm:flex items-center space-x-2 px-3 py-1.5 rounded-xl text-xs font-mono font-bold transition-all cursor-pointer ${
                isLogStreamActive
                  ? 'bg-[#a1e8a2]/10 text-[#a1e8a2] border border-[#a1e8a2]/40'
                  : 'bg-[#20201f] text-[#d5c4ab] border border-[#353535]'
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${isLogStreamActive ? 'bg-[#a1e8a2] animate-pulse' : 'bg-[#d5c4ab]'}`} />
              <span>{isLogStreamActive ? 'Log Akışı AÇIK' : 'Log Akışı KAPALI'}</span>
            </button>

            {/* "Müşteri Paneline Geç" Primary Button */}
            <button
              onClick={() => navigate('/panel')}
              className="px-4 py-2 bg-gradient-to-r from-[#ffb800] to-[#ff8a00] hover:from-[#ffdca1] hover:to-[#ffb77f] text-[#412d00] font-black rounded-xl text-xs flex items-center space-x-2 transition-all cursor-pointer shadow-sm"
            >
              <span className="material-symbols-outlined text-base">dashboard</span>
              <span>Müşteri Paneline Geç</span>
            </button>

          </div>

        </header>

        {/* PAGE CONTENT ROUTER OUTLET */}
        <main className="flex-1 p-6 md:p-8 space-y-8 overflow-y-auto">
          <Outlet />
        </main>

      </div>

    </div>
  );
};
