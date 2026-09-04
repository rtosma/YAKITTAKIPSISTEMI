import { Pool } from 'pg';
import { logger } from '../utils/logger';

export const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  user: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || 'postgres',
  database: process.env.POSTGRES_DB || 'yakittakip_db',
  max: 10,
  idleTimeoutMillis: 30000
});

pool.on('error', (err) => {
  logger.error({ err }, '🚨 [Postgres] Havuz beklenmeyen hata!');
});
