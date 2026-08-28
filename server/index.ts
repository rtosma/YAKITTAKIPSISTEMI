import express from 'express';
import dotenv from 'dotenv';
import { TenantContextService } from './middleware/tenantMiddleware';
import routes from './routes/routes';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());

// Apply Tenant Context Middleware across API routes
// Unprotected health route will pass, protected routes require X-Tenant-ID
app.use('/api/v1', (req, res, next) => {
  if (req.path === '/health') {
    return TenantContextService.middleware({ requireTenant: false })(req, res, next);
  }
  return TenantContextService.middleware({ requireTenant: true })(req, res, next);
});

// Mount Routes
app.use('/api/v1', routes);

app.listen(PORT, () => {
  console.log(`===========================================================`);
  console.log(`🚀 [ARCH-101] Yakıttakip Backend Sunucusu Başlatıldı!`);
  console.log(`🌐 Dinlenen Port: http://localhost:${PORT}`);
  console.log(`🔒 Multi-Tenancy: AsyncLocalStorage & RLS Aktif`);
  console.log(`===========================================================`);
});
