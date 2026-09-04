import { Pool } from 'pg';
import { config } from '../config/env';
import { logger } from '../utils/logger';

export const pool = new Pool({
  host: config.POSTGRES_HOST,
  port: config.POSTGRES_PORT,
  user: config.POSTGRES_USER,
  password: config.POSTGRES_PASSWORD,
  database: config.POSTGRES_DB,
  max: 10,
  idleTimeoutMillis: 30000
});

pool.on('error', (err) => {
  logger.error({ err }, '🚨 [Postgres] Havuz beklenmeyen hata!');
});
