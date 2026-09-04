import pino from 'pino';
import { config } from '../config/env';

// Configure Pino Logger instance
export const logger = pino({
  level: config.LOG_LEVEL,
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  base: {
    service: 'yakittakip-backend',
    env: config.NODE_ENV,
  },
});

export default logger;
