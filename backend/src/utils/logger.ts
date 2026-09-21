import pino from 'pino';
import { config } from '../config/env';
import { scrubLogArgs } from '../privacy/piiScrub';

/**
 * COMP-606: `hooks.logMethod` her log çağrısının argümanlarını (nesne + mesaj + hata) TCKN/telefon/e-posta ve
 * kişisel-veri anahtarları için temizler (bkz. privacy/piiScrub.ts). Testler AYNI seçeneklerle ayrı bir pino
 * örneği kurabilsin diye seçenekler dışa aktarılır.
 */
export function buildLoggerOptions(level: string = config.LOG_LEVEL): pino.LoggerOptions {
  return {
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    base: {
      service: 'yakittakip-backend',
      env: config.NODE_ENV,
    },
    hooks: {
      logMethod(args, method) {
        return method.apply(this, scrubLogArgs(args as unknown[]) as Parameters<typeof method>);
      },
    },
  };
}

// Configure Pino Logger instance
export const logger = pino(buildLoggerOptions());

export default logger;
