import React, { useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useApp } from '../context/AppContext';

export const CustomerLayout: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { currentCompany, selectedSiteFilter, setSelectedSiteFilter } = useApp();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const navItems = [
    { label: 'Genel Bakış', path: '/panel', icon: 'dashboard' },
    { label: 'Şantiye Yönetimi', path: '/panel/sites', icon: 'location_city' },
    { label: 'Araç Yönetimi', path: '/panel/vehicles', icon: 'local_shipping' },
    { label: 'Şoför Yönetimi', path: '/panel/drivers', icon: 'badge' },
    { label: 'Yakıt Hareketleri', path: '/panel/transactions', icon: 'receipt_long' },
    { label: 'Tank Durumu', path: '/panel/tanks', icon: 'oil_barrel' },
    { label: 'Veri Arşivleme', path: '/panel/archive', icon: 'folder_zip' },
    { label: 'Bildirimler', path: '/panel/notifications', icon: 'notifications' },
    { label: 'Sistem Ayarları', path: '/panel/settings', icon: 'settings' },
    { label: 'Yetkilendirme (Çapraz)', path: '/panel/cross-site', icon: 'verified' },
    { label: 'Modüllerim', path: '/panel/modules', icon: 'extension' },
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

      {/* CUSTOMER SIDEBAR */}
      <aside className={`fixed inset-y-0 left-0 z-40 w-64 h-screen max-h-screen bg-[#1c1b1b] border-r border-[#353535] p-5 flex flex-col justify-between shrink-0 select-none overflow-y-auto transition-transform duration-200 md:translate-x-0 ${
        isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
      }`}>
        <div className="space-y-6">
          
          {/* Logo & Company Name */}
          <div className="space-y-3">
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 rounded-xl bg-[#ffdca1] text-[#412d00] flex items-center justify-center font-black shadow shrink-0">
                <span className="material-symbols-outlined text-2xl">local_gas_station</span>
              </div>
              <div className="min-w-0">
                <h1 className="font-black text-[#e5e2e1] text-xs uppercase tracking-widest truncate">
                  AKILLI ŞANTİYE
                </h1>
                <p className="text-[10px] text-[#ffdca1] font-bold font-mono uppercase tracking-wider truncate">
                  YAKIT TAKİP SİSTEMİ
                </p>
              </div>
            </div>

            {/* Current Firm Name Box */}
            <div className="bg-[#20201f] border border-[#353535] p-2.5 rounded-xl">
              <span className="text-[10px] font-mono text-[#d5c4ab] font-semibold uppercase block">
                MÜŞTERİ FİRMASI
              </span>
              <h2 className="text-xs font-bold text-[#e5e2e1] truncate mt-0.5">
                {currentCompany.name}
              </h2>
            </div>
          </div>

          {/* Navigation Menu */}
          <nav className="space-y-1">
            {navItems.map((item) => {
              const isActive = currentPath === item.path || (item.path === '/panel' && currentPath === '/panel/overview');
              return (
                <button
                  key={item.path}
                  onClick={() => {
                    navigate(item.path);
                    setIsMobileMenuOpen(false);
                  }}
                  className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                    isActive
                      ? 'bg-[#ffdca1] text-[#412d00] shadow-md'
                      : 'text-[#e5e2e1] hover:bg-[#20201f] hover:text-[#ffdca1]'
                  }`}
                >
                  <span className="material-symbols-outlined text-lg shrink-0">{item.icon}</span>
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </nav>

        </div>

        {/* Sidebar Footer */}
        <div className="pt-4 mt-6 border-t border-[#353535] space-y-2 shrink-0">
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
        
        {/* CUSTOMER HEADER */}
        <header className="h-16 bg-[#131313] border-b border-[#353535] px-6 flex items-center justify-between sticky top-0 z-30 select-none">
          
          <div className="flex items-center space-x-4">
            <button
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              className="md:hidden p-2 text-[#e5e2e1] hover:bg-[#20201f] rounded-lg"
            >
              <span className="material-symbols-outlined text-2xl">menu</span>
            </button>

            {/* "SİSTEM ÇEVRİMİÇİ" Green Live Badge */}
            <div className="flex items-center space-x-2 text-xs font-mono font-bold text-[#a1e8a2] bg-[#1c1b1b] border border-[#353535] px-3 py-1.5 rounded-xl">
              <span className="w-2 h-2 rounded-full bg-[#a1e8a2] animate-ping"></span>
              <span className="hidden sm:inline">SİSTEM ÇEVRİMİÇİ</span>
            </div>
          </div>

          {/* CRITICAL REQUIREMENT: "Şantiye Filtresi" Dropdown */}
          <div className="flex items-center space-x-4">
            
            <div className="flex items-center space-x-2 bg-[#1c1b1b] border border-[#353535] px-3 py-1.5 rounded-xl">
              <span className="material-symbols-outlined text-sm text-[#ffdca1]">location_on</span>
              <span className="text-xs font-mono text-[#d5c4ab] hidden lg:inline">Şantiye:</span>
              <select
                value={selectedSiteFilter}
                onChange={(e) => setSelectedSiteFilter(e.target.value)}
                className="bg-transparent text-xs font-bold text-[#e5e2e1] focus:outline-none cursor-pointer"
              >
                <option value="TÜMÜ" className="bg-[#1c1b1b] text-[#e5e2e1]">Tüm Şantiyeler ({currentCompany.sites.length})</option>
                {currentCompany.sites.map(site => (
                  <option key={site.id} value={site.name} className="bg-[#1c1b1b] text-[#e5e2e1]">
                    {site.name}
                  </option>
                ))}
              </select>
            </div>

            {/* User Avatar */}
            <div className="flex items-center space-x-3 pl-2 border-l border-[#353535]">
              <div className="w-8 h-8 rounded-full bg-[#ffdca1] text-[#412d00] flex items-center justify-center font-black text-xs">
                MÇ
              </div>
              <div className="hidden xl:block">
                <p className="text-xs font-extrabold text-[#e5e2e1] leading-tight">Metehan Çam</p>
                <p className="text-[10px] text-[#d5c4ab] font-mono">Tesis Müdürü</p>
              </div>
            </div>

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
