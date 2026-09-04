import express from 'express';
import http from 'http';
import { traceMiddleware, httpLoggerMiddleware } from '../src/middleware/loggerMiddleware';
import { globalErrorHandler, notFoundHandler } from '../src/middleware/errorHandler';
import { AppError, BadRequestError, UnauthorizedError } from '../src/utils/errors';
import { z } from 'zod';

const app = express();
app.use(express.json());

// Attach trace & logging middlewares
app.use(traceMiddleware);
app.use(httpLoggerMiddleware);

// Test Endpoints for RES-902 Validation
app.get('/api/v1/test/success', (_req, res) => {
  res.json({ success: true, message: 'İşlem başarılı' });
});

app.get('/api/v1/test/bad-request', (_req, _res, next) => {
  next(new BadRequestError('Geçersiz parametre girildi', { field: 'email' }));
});

app.get('/api/v1/test/unauthorized', (_req, _res, next) => {
  next(new UnauthorizedError('Oturum süreniz doldu'));
});

app.get('/api/v1/test/zod-error', (_req, _res, next) => {
  const schema = z.object({
    plaka: z.string().regex(/^[0-9]{2}[A-Z]{1,3}[0-9]{2,4}$/, 'Geçersiz plaka formatı'),
    litre: z.number().positive('Litre pozitif olmalıdır'),
  });

  try {
    schema.parse({ plaka: 'INVALID_PLATE', litre: -50 });
  } catch (err) {
    return next(err);
  }
});

app.get('/api/v1/test/critical-500', (_req, _res, next) => {
  // Simulate an unexpected internal database error with sensitive info
  const dbError = new Error('SELECT * FROM users WHERE password_hash = secret_key_123 FAILED: Connection timeout at postgres://admin:secret123@localhost:5432/db');
  next(dbError);
});

// 404 Handler
app.use('/api/v1', notFoundHandler);

// Global Error Handler
app.use(globalErrorHandler);

async function runTests() {
  const server = app.listen(5099, async () => {
    console.log('\n=============================================================');
    console.log('🧪 [TEST-RES-902] Global Exception Filter & Pino Loglama Testi');
    console.log('=============================================================\n');

    let passedCount = 0;
    let failedCount = 0;

    const assert = (condition: boolean, title: string, failureReason?: string) => {
      if (condition) {
        console.log(`  ✅ [PASS] ${title}`);
        passedCount++;
      } else {
        console.error(`  ❌ [FAIL] ${title} - ${failureReason || 'Beklenen koşul sağlanamadı'}`);
        failedCount++;
      }
    };

    try {
      // 1. Success Request & X-Trace-ID Header Test
      const res1 = await fetch('http://localhost:5099/api/v1/test/success');
      const traceId1 = res1.headers.get('x-trace-id');
      assert(res1.status === 200, 'Başarılı istek 200 OK dönmeli');
      assert(!!traceId1 && traceId1.length > 10, 'X-Trace-ID yanıt header alanında mevcut olmalı');

      // 2. Custom Request X-Trace-ID Propagation Test
      const customTrace = 'test-correlation-uuid-999';
      const res2 = await fetch('http://localhost:5099/api/v1/test/success', {
        headers: { 'X-Trace-ID': customTrace },
      });
      const traceId2 = res2.headers.get('x-trace-id');
      assert(traceId2 === customTrace, 'Gönderilen custom X-Trace-ID korunmalı ve aynı dönmeli');

      // 3. BadRequest Operational Error (400)
      const res3 = await fetch('http://localhost:5099/api/v1/test/bad-request');
      const json3 = await res3.json() as any;
      assert(res3.status === 400, 'BadRequest 400 status code dönmeli');
      assert(json3.success === false, 'success: false olmalı');
      assert(json3.error === 'BadRequestError', 'Hata sınıfı BadRequestError olmalı');
      assert(json3.details?.field === 'email', 'Hata detayları güvenli olarak dönmeli');
      assert(!!json3.traceId, 'Hata yanıtında traceId yer almalı');

      // 4. Unauthorized Operational Error (401)
      const res4 = await fetch('http://localhost:5099/api/v1/test/unauthorized');
      const json4 = await res4.json() as any;
      assert(res4.status === 401, 'Unauthorized 401 status code dönmeli');
      assert(json4.error === 'UnauthorizedError', 'Hata sınıfı UnauthorizedError olmalı');

      // 5. Zod Validation Error Handling (400)
      const res5 = await fetch('http://localhost:5099/api/v1/test/zod-error');
      const json5 = await res5.json() as any;
      assert(res5.status === 400, 'Zod doğrulama hatası 400 status code dönmeli');
      assert(json5.error === 'VALIDATION_ERROR', 'Hata tipi VALIDATION_ERROR olmalı');
      assert(Array.isArray(json5.details) && json5.details.length >= 2, 'Zod hata detayları dizi olarak dönmeli');

      // 6. 404 Not Found Route Handler
      const res6 = await fetch('http://localhost:5099/api/v1/non-existing-route');
      const json6 = await res6.json() as any;
      assert(res6.status === 404, 'Bulunamayan rotada 404 Not Found dönmeli');
      assert(json6.error === 'NOT_FOUND', 'Hata tipi NOT_FOUND olmalı');

      // 7. Critical 500 Unexpected Internal Server Error & Leak Prevention
      const res7 = await fetch('http://localhost:5099/api/v1/test/critical-500');
      const json7 = await res7.json() as any;
      const rawText7 = JSON.stringify(json7);

      assert(res7.status === 500, 'Dahili sunucu hatası 500 status code dönmeli');
      assert(json7.success === false, '500 yanıtında success: false olmalı');
      assert(json7.error === 'INTERNAL_SERVER_ERROR', 'Hata tipi INTERNAL_SERVER_ERROR olmalı');
      assert(!rawText7.includes('secret123') && !rawText7.includes('postgres://'), 'Dahili şifre ve DB verileri asla istemciye sızmamalı!');
      assert(!rawText7.includes('stack'), 'Stack trace istemciye asla sızmamalı!');
      assert(!!json7.traceId, '500 hatasında kullanıcıya destek için traceId sunulmalı');

      console.log('\n-------------------------------------------------------------');
      console.log(`📊 Test Sonucu: ${passedCount} Başarılı, ${failedCount} Başarısız`);
      console.log('-------------------------------------------------------------\n');

    } catch (err) {
      console.error('❌ Test sırasında beklenmeyen bir hata oluştu:', err);
    } finally {
      server.close(() => {
        process.exit(failedCount === 0 ? 0 : 1);
      });
    }
  });
}

runTests();
