import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {initSentry, SentryErrorBoundary, getLastApiTraceId} from './utils/sentry';
import './index.css';

// RES-907: DSN tanımlı değilse no-op. Render hatalarını da yakalayan sınır (kullanıcıya Türkçe yedek ekran).
initSentry();

/**
 * FE-817 AC: "Hata ekranında trace_id görünmelidir." ÖNCEDEN burada
 * gösterilen tek kimlik Sentry'nin kendi `eventId`'siydi (DSN
 * yapılandırılmamışsa `undefined` → ekranda literal "yok" yazıyordu) — bu,
 * `apiFetch`'in her istekte ürettiği/backend'den aldığı GERÇEK `trace_id`
 * (bkz. utils/sentry.ts `getLastApiTraceId`) DEĞİL, tamamen ayrı bir
 * kimlik. Çoğu render çökmesi aslında BİR ÖNCEKİ başarısız API isteğinin
 * (örn. `data.items.map` çağrısında `data.items` undefined) sonucu olduğundan,
 * son API trace_id'si burada varsa önceliklidir — DSN'siz ortamda da
 * (bu projede VITE_SENTRY_DSN boş olabilir) kullanıcıya HER ZAMAN bir
 * destek kodu gösterir. `resetError` (Sentry.ErrorBoundary'nin kendi
 * render-prop'u) ile "Tekrar Dene" — çoğu çökme geçici bir veri/state
 * sorunudur, tam sayfa yenilemeden önce önce bunu denemek daha ucuzdur.
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SentryErrorBoundary
      fallback={({eventId, resetError}) => {
        const apiTraceId = getLastApiTraceId();
        const supportCode = apiTraceId || eventId || 'yok';
        return (
          <div data-testid="error-boundary-screen" role="alert" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem', fontFamily: 'sans-serif', background: '#131313', color: '#e5e2e1' }}>
            <div style={{ maxWidth: '480px', textAlign: 'center' }}>
              <h1 style={{ fontSize: '1.25rem', fontWeight: 800 }}>Beklenmeyen bir hata oluştu</h1>
              <p style={{ fontSize: '0.875rem', color: '#d5c4ab', marginTop: '0.5rem' }}>
                Sayfa beklenmeyen bir durumla karşılaştı. Aşağıdaki butonla tekrar deneyebilir veya sorun sürerse
                destek ekibine şu kodu iletebilirsiniz:
              </p>
              <p style={{ fontSize: '0.75rem', fontFamily: 'monospace', color: '#8a8580', marginTop: '0.5rem' }} data-testid="error-boundary-trace-id">
                {supportCode}
              </p>
              <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', marginTop: '1.5rem' }}>
                <button type="button" data-testid="error-boundary-retry" onClick={resetError} style={{ padding: '0.625rem 1rem', borderRadius: '0.75rem', background: '#20201f', color: '#e5e2e1', border: 'none', fontSize: '0.75rem', fontWeight: 700, cursor: 'pointer' }}>
                  Tekrar Dene
                </button>
                <button type="button" data-testid="error-boundary-reload" onClick={() => window.location.reload()} style={{ padding: '0.625rem 1rem', borderRadius: '0.75rem', background: '#ffdca1', color: '#412d00', border: 'none', fontSize: '0.75rem', fontWeight: 700, cursor: 'pointer' }}>
                  Sayfayı Yenile
                </button>
              </div>
            </div>
          </div>
        );
      }}
    >
      <App />
    </SentryErrorBoundary>
  </StrictMode>,
);
