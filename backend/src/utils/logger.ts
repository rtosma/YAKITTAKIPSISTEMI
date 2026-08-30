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

// Utility to create a logger child with contextual metadata (traceId, tenantId, userId)
export const createChildLogger = (context: { traceId?: string; tenantId?: string; userId?: string }) => {
  return logger.child(context);
};

export default logger;
