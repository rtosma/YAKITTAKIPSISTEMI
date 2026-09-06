import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppProvider } from './context/AppContext';
import { Toast } from './components/Toast';

// FE-802 — TransactionsPage'in sunucu taraflı sayfalı/filtreli sorguları
// için tek bir global QueryClient. staleTime > 0: aynı filtre/sayfa
// kombinasyonuna kısa sürede geri dönüldüğünde (ör. sayfalar arası ileri-geri)
// gereksiz tekrar istek atılmaz; refetchOnWindowFocus kapalı çünkü bu liste
// zaten Socket.io ile dispense:completed olayında AppContext tarafında ayrıca
// canlı güncelleniyor (bkz. AppContext.tsx socket effect'i).
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1
    }
  }
});

// Pages & Layouts
import { LoginPage } from './pages/LoginPage';
import { SiteLoginPage } from './pages/SiteLoginPage';
import { ForcedPasswordChangePage } from './pages/ForcedPasswordChangePage';
import { WelcomeScreen } from './pages/WelcomeScreen';
import { NotFoundPage } from './pages/NotFoundPage';
import { ForbiddenPage } from './pages/ForbiddenPage';
import { CustomerLayout } from './layouts/CustomerLayout';
import { DeveloperLayout } from './layouts/DeveloperLayout';
import { SiteOperatorPanel } from './pages/santiye/SiteOperatorPanel';
import { RoleRoute } from './components/RoleRoute';
import { ROLE_GROUPS } from './utils/permissions';

// Customer Pages
import { OverviewPage } from './pages/customer/OverviewPage';
import { SitesPage } from './pages/customer/SitesPage';
import { VehiclesPage } from './pages/customer/VehiclesPage';
import { DriversPage } from './pages/customer/DriversPage';
import { VehiclesDriversPage } from './pages/customer/VehiclesDriversPage';
import { TransactionsPage } from './pages/customer/TransactionsPage';
import { TankStatusPage } from './pages/customer/TankStatusPage';
import { ArchivePage } from './pages/customer/ArchivePage';
import { NotificationsPage } from './pages/customer/NotificationsPage';
import { SettingsPage } from './pages/customer/SettingsPage';
import { CrossSitePage } from './pages/customer/CrossSitePage';
import { ModulesPage } from './pages/customer/ModulesPage';

// Developer Pages
import { DeveloperOverviewPage } from './pages/developer/DeveloperOverviewPage';
import { TenantsPage } from './pages/developer/TenantsPage';
import { DevicesPage } from './pages/developer/DevicesPage';
import { LiveLogsPage } from './pages/developer/LiveLogsPage';
import { SystemHealthPage } from './pages/developer/SystemHealthPage';

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
    <AppProvider>
      <BrowserRouter>
        <Toast />
        <Routes>
          {/* Home Login Page */}
          <Route path="/" element={<LoginPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/santiye-login" element={<SiteLoginPage />} />
          {/* FE-803: Saha paneli — SITE_MANAGER / PUMP_OPERATOR (+ üst roller).
              DRIVER gibi yetkisiz bir rol doğrudan URL yazsa /403'e düşer. */}
          <Route
            path="/santiye-panel"
            element={
              <RoleRoute allow={ROLE_GROUPS.SITE_PANEL}>
                <SiteOperatorPanel />
              </RoleRoute>
            }
          />
          <Route path="/parola-degistir" element={<ForcedPasswordChangePage />} />
          <Route path="/welcome" element={<WelcomeScreen />} />
          <Route path="/403" element={<ForbiddenPage />} />

          {/* Customer Panel Routes (/panel/*) — FE-803: yalnızca COMPANY_OWNER /
              SUPER_ADMIN. SITE_MANAGER'ın yeri /santiye-panel; buraya doğrudan
              URL ile gelmeye çalışırsa /403. */}
          <Route
            path="/panel"
            element={
              <RoleRoute allow={ROLE_GROUPS.PANEL}>
                <CustomerLayout />
              </RoleRoute>
            }
          >
            <Route index element={<OverviewPage />} />
            <Route path="overview" element={<OverviewPage />} />
            <Route path="sites" element={<SitesPage />} />
            <Route path="santiye-yonetimi" element={<SitesPage />} />
            <Route path="vehicles" element={<VehiclesPage />} />
            <Route path="arac-yonetimi" element={<VehiclesPage />} />
            <Route path="drivers" element={<DriversPage />} />
            <Route path="sofor-yonetimi" element={<DriversPage />} />
            <Route path="vehicles-drivers" element={<VehiclesDriversPage />} />
            <Route path="transactions" element={<TransactionsPage />} />
            <Route path="yakit-hareketleri" element={<TransactionsPage />} />
            <Route path="tanks" element={<TankStatusPage />} />
            <Route path="tank-durumu" element={<TankStatusPage />} />
            <Route path="archive" element={<ArchivePage />} />
            <Route path="arsiv" element={<ArchivePage />} />
            <Route path="notifications" element={<NotificationsPage />} />
            <Route path="bildirimler" element={<NotificationsPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="ayarlar" element={<SettingsPage />} />
            <Route path="cross-site" element={<CrossSitePage />} />
            <Route path="modules" element={<ModulesPage />} />
            {/* Unknown sub-route under /panel -> 404 */}
            <Route path="*" element={<NotFoundPage />} />
          </Route>

          {/* Developer Super Admin Panel Routes (/admin/*) — FE-803: SUPER_ADMIN only.
              DeveloperLayout içinde de aynı kontrol var (defense-in-depth). */}
          <Route
            path="/admin"
            element={
              <RoleRoute allow={ROLE_GROUPS.ADMIN}>
                <DeveloperLayout />
              </RoleRoute>
            }
          >
            <Route index element={<DeveloperOverviewPage />} />
            <Route path="overview" element={<DeveloperOverviewPage />} />
            <Route path="tenants" element={<TenantsPage />} />
            <Route path="modules" element={<DeveloperOverviewPage />} />
            <Route path="devices" element={<DevicesPage />} />
            <Route path="logs" element={<LiveLogsPage />} />
            <Route path="health" element={<SystemHealthPage />} />
            {/* Unknown sub-route under /admin -> 404 */}
            <Route path="*" element={<NotFoundPage />} />
          </Route>

          {/* Global Fallback Catch-All -> Modern 404 Page */}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </BrowserRouter>
    </AppProvider>
    </QueryClientProvider>
  );
}

export default App;
