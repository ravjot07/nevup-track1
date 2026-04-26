import pg from 'pg';
import { logger } from '../lib/logger.js';

const { Pool, types } = pg;

types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 30),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 5_000,
  query_timeout: 5_000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'pg pool error');
});

export async function query(text, params) {
  return pool.query(text, params);
}

export async function withClient(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
