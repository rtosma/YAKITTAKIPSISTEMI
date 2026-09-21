import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';
import {sentryVitePlugin} from '@sentry/vite-plugin';

// RES-907 (#192): source map'ler `hidden` üretilir — pakette `sourceMappingURL` yorumu YOKTUR, tarayıcı/son kullanıcı kaynak kodu görmez.
// Sentry'ye yüklenir (SENTRY_AUTH_TOKEN + SENTRY_ORG + SENTRY_PROJECT varsa; release adı = VITE_APP_VERSION = backend `release`) ve
// yüklemeden sonra silinir. Token yoksa yükleme yapılmaz; .map dosyaları Dockerfile'da imaja alınmadan silinir (kaynak sızmasın).
const sentryUpload = Boolean(process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT);

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      ...(sentryUpload
        ? [sentryVitePlugin({
            authToken: process.env.SENTRY_AUTH_TOKEN,
            org: process.env.SENTRY_ORG,
            project: process.env.SENTRY_PROJECT,
            url: process.env.SENTRY_URL || undefined,
            release: { name: process.env.VITE_APP_VERSION || 'dev' },
            sourcemaps: { filesToDeleteAfterUpload: ['./dist/**/*.map'] },
            telemetry: false,
            // Sentry erişilemez/token yanlışsa DERLEME/DAĞITIM başarısız olmasın (haritalar yine imaja girmez; yalnızca stack minify görünür).
            errorHandler: (err: Error) => console.warn(`[sentry] source map yüklenemedi (derleme sürüyor): ${err.message}`),
          })]
        : []),
    ],
    build: {
      sourcemap: 'hidden' as const,
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
      // Proxy API requests to backend during development
      proxy: {
        '/api': {
          target: 'http://localhost:5000',
          changeOrigin: true,
        },
        // FE-801: Socket.io — needs ws: true for the WebSocket upgrade to be
        // proxied (plain HTTP proxying alone silently breaks the connection).
        '/socket.io': {
          target: 'http://localhost:5000',
          changeOrigin: true,
          ws: true,
        },
      },
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
