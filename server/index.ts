import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { TenantContextService } from './middleware/tenantMiddleware';
import routes from './routes/routes';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());

// Configure express.json to preserve rawBody Buffer for HMAC-SHA256 hardware signature verification
app.use(express.json({
  verify: (req: any, _res, buf) => {
    req.rawBody = buf;
  }
}));

// Apply Tenant Context Middleware across API routes
// Unprotected health, auth, and telemetry routes pass without requiring X-Tenant-ID header
app.use('/api/v1', (req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/auth/') || req.path.startsWith('/telemetry/')) {
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
