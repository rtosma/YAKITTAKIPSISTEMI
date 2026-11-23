import * as Sentry from '@sentry/node';
import { config } from '../config/env';
import { scrubSentryEvent, scrubSentryBreadcrumb, stripUrlQuery } from './sentryScrub';

/**
 * RES-907 (#192) — backend Sentry entegrasyonu.
 *
 * KAPSAM UYARLAMASI: yalnızca HATA izleme açılır. `@sentry/node`'un varsayılan entegrasyonları (OpenTelemetry tabanlı http/pg/
 * express oto-enstrümantasyonu) bilinçli KAPALI: esbuild ile tek dosyaya paketlenen sunucuda kırılgan, gereksiz maliyet ve —
 * asıl sorun — istek/SQL gövdelerini toplayarak kişisel veri yüzeyini büyütür. Trace korelasyonu Sentry performans izi ile değil,
 * projenin kendi `X-Trace-ID`'siyle (loglar + hata yanıtı + Sentry `trace_id` etiketi) yapılır.
 *
 * Örnekleme (ticket: "ayarlanmazsa maliyet hızla artar"): hata olayları `SENTRY_ERROR_SAMPLE_RATE` (varsayılan 1), performans izi
 * `SENTRY_TRACES_SAMPLE_RATE` (varsayılan 0 = kapalı). Sürüm etiketi: `APP_VERSION` (OPS-1110; imajdan gelir, /health `version` ile aynı).
 */
let enabled = false;

export interface SentryInitOverrides { dsn?: string; sampleRate?: number; tracesSampleRate?: number; environment?: string; release?: string; }

/** `overrides` yalnızca testler içindir (canlı DSN'e gitmeden yerel bir alıcıya yönlendirmek için). */
export function initSentry(overrides: SentryInitOverrides = {}): boolean {
  const dsn = overrides.dsn ?? config.SENTRY_DSN;
  if (!dsn) return false;
  Sentry.init({
    dsn,
    release: overrides.release ?? config.APP_VERSION,
    environment: overrides.environment ?? config.SENTRY_ENVIRONMENT ?? config.NODE_ENV,
    sampleRate: overrides.sampleRate ?? config.SENTRY_ERROR_SAMPLE_RATE,
    tracesSampleRate: overrides.tracesSampleRate ?? config.SENTRY_TRACES_SAMPLE_RATE,
    sendDefaultPii: false,
    maxBreadcrumbs: 30,
    skipOpenTelemetrySetup: true,
    defaultIntegrations: false,
    integrations: [Sentry.linkedErrorsIntegration(), Sentry.dedupeIntegration()],
    initialScope: { tags: { service: 'yakittakip-backend' } },
    beforeSend: (event) => scrubSentryEvent(event),
    beforeBreadcrumb: (b) => scrubSentryBreadcrumb(b)
  });
  enabled = true;
  return true;
}

export function isSentryEnabled(): boolean {
  return enabled;
}

export interface ServerErrorContext { traceId?: string; tenantId?: string; userId?: string; method?: string; path?: string; }

/** Beklenmeyen sunucu hatasını, istemcinin gördüğü `traceId` ile etiketleyerek gönderir. Kapalıysa no-op. Dönüş: Sentry olay id'si. */
export function captureServerError(err: unknown, ctx: ServerErrorContext = {}): string | undefined {
  if (!enabled) return undefined;
  return Sentry.withScope((scope) => {
    if (ctx.traceId && ctx.traceId !== 'N/A') scope.setTag('trace_id', ctx.traceId);
    if (ctx.tenantId && ctx.tenantId !== 'N/A') scope.setTag('tenant_id', ctx.tenantId);
    if (ctx.userId && ctx.userId !== 'N/A') scope.setUser({ id: ctx.userId });
    if (ctx.method || ctx.path) scope.setContext('request', { method: ctx.method, path: stripUrlQuery(ctx.path) });
    return Sentry.captureException(err);
  });
}

export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!enabled) return;
  await Sentry.flush(timeoutMs).catch(() => false);
}

export async function closeSentry(): Promise<void> {
  if (!enabled) return;
  await Sentry.close(2000).catch(() => false);
  enabled = false;
}
