import pg from 'pg';
import Redis from 'ioredis';
import pino from 'pino';

const { Pool, types } = pg;
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'nevup-worker' },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
        },
      }
    : {}),
});

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,
  query_timeout: 10_000,
});

export const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379', {
  maxRetriesPerRequest: 3,
});

export const STREAM_KEY = 'nevup:events';
export const CONSUMER_GROUP = 'metrics-workers';
export const CONSUMER_NAME = `worker-${process.pid}-${Math.floor(Math.random() * 1e6)}`;

export async function ensureConsumerGroup() {
  try {
    await redis.xgroup('CREATE', STREAM_KEY, CONSUMER_GROUP, '$', 'MKSTREAM');
    logger.info({ stream: STREAM_KEY, group: CONSUMER_GROUP }, 'consumer group created');
  } catch (err) {
    if (!String(err.message || '').includes('BUSYGROUP')) throw err;
  }
}
