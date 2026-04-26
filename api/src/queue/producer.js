import Redis from 'ioredis';
import { logger } from '../lib/logger.js';

export const STREAM_KEY = 'nevup:events';
export const CONSUMER_GROUP = 'metrics-workers';

let redisClient;

function buildRedisOptions(url) {
  const opts = {
    maxRetriesPerRequest: 5,
    connectTimeout: 15_000,
    enableReadyCheck: true,
    lazyConnect: false,
  };
  if (!url) return opts;
  try {
    const parsed = new URL(url);
    const tlsByScheme = parsed.protocol === 'rediss:';
    const tlsByHost =
      /\.upstash\.io$/i.test(parsed.hostname) ||
      /\.aivencloud\.com$/i.test(parsed.hostname) ||
      /\.redislabs\.com$/i.test(parsed.hostname);
    if (tlsByScheme || tlsByHost) {
      opts.tls = { rejectUnauthorized: true, servername: parsed.hostname };
    }
  } catch {
  }
  return opts;
}

export function getRedis() {
  if (!redisClient) {
    const url = process.env.REDIS_URL || 'redis://redis:6379';
    redisClient = new Redis(url, buildRedisOptions(url));
    redisClient.on('error', (err) => logger.error({ err }, 'redis error'));
  }
  return redisClient;
}

export async function ensureConsumerGroup() {
  const redis = getRedis();
  try {
    await redis.xgroup('CREATE', STREAM_KEY, CONSUMER_GROUP, '$', 'MKSTREAM');
    logger.info({ stream: STREAM_KEY, group: CONSUMER_GROUP }, 'consumer group created');
  } catch (err) {
    if (!String(err.message || '').includes('BUSYGROUP')) {
      throw err;
    }
  }
}

export async function publishEvent(type, payload) {
  const redis = getRedis();
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return redis.xadd(
    STREAM_KEY,
    'MAXLEN',
    '~',
    '100000',
    '*',
    'type',
    type,
    'data',
    data
  );
}

export async function queueLag() {
  const redis = getRedis();
  try {
    const info = await redis.xpending(STREAM_KEY, CONSUMER_GROUP);
    if (Array.isArray(info)) return Number(info[0] || 0);
    return 0;
  } catch (err) {
    if (String(err.message || '').includes('NOGROUP')) return 0;
    throw err;
  }
}
