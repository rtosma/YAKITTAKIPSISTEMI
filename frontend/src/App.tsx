import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { Toast } from './components/Toast';

// Pages & Layouts
import { LoginPage } from './pages/LoginPage';
import { SiteLoginPage } from './pages/SiteLoginPage';
import { WelcomeScreen } from './pages/WelcomeScreen';
import { NotFoundPage } from './pages/NotFoundPage';
import { ForbiddenPage } from './pages/ForbiddenPage';
import { CustomerLayout } from './layouts/CustomerLayout';
import { DeveloperLayout } from './layouts/DeveloperLayout';

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
    <AppProvider>
      <BrowserRouter>
        <Toast />
        <Routes>
          {/* Home Login Page */}
          <Route path="/" element={<LoginPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/santiye-login" element={<SiteLoginPage />} />
          <Route path="/santiye-panel" element={<Navigate to="/panel" replace />} />
          <Route path="/welcome" element={<WelcomeScreen />} />
          <Route path="/403" element={<ForbiddenPage />} />

          {/* Customer Panel Routes (/panel/*) */}
          <Route path="/panel" element={<CustomerLayout />}>
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

          {/* Developer Super Admin Panel Routes (/admin/*) */}
          <Route path="/admin" element={<DeveloperLayout />}>
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
  );
}

export default App;
