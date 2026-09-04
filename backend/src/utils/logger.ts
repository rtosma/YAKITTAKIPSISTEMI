import pino from 'pino';

// Configure Pino Logger instance
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  base: {
    service: 'yakittakip-backend',
    env: process.env.NODE_ENV || 'development',
  },
});

export default logger;
