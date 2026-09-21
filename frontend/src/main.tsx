import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {initSentry, SentryErrorBoundary} from './utils/sentry';
import './index.css';

// RES-907: DSN tanımlı değilse no-op. Render hatalarını da yakalayan sınır (kullanıcıya Türkçe yedek ekran).
initSentry();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SentryErrorBoundary
      fallback={({eventId}) => (
        <div role="alert" style={{padding: '2rem', fontFamily: 'sans-serif'}}>
          <h1>Beklenmeyen bir hata oluştu</h1>
          <p>Sayfayı yenileyin. Sorun sürerse destek ekibine şu kodu iletin: <code>{eventId || 'yok'}</code></p>
          <button type="button" onClick={() => window.location.reload()}>Sayfayı yenile</button>
        </div>
      )}
    >
      <App />
    </SentryErrorBoundary>
  </StrictMode>,
);
