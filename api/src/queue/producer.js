import Redis from 'ioredis';
import { logger } from '../lib/logger.js';

export const STREAM_KEY = 'nevup:events';
export const CONSUMER_GROUP = 'metrics-workers';

let redisClient;

export function getRedis() {
  if (!redisClient) {
    redisClient = new Redis(process.env.REDIS_URL || 'redis://redis:6379', {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });
    redisClient.on('error', (err) => logger.error({ err }, 'redis error'));
  }
  return redisClient;
}

/**
 * Idempotent consumer-group creation. Safe to call repeatedly.
 */
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

/**
 * Publish a domain event onto the Redis Stream.
 * The worker reads via XREADGROUP and acknowledges via XACK.
 *
 * Stays off the write-path's critical section: XADD with a maxlen cap
 * keeps memory bounded and runs in O(1).
 */
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

/**
 * /health helper — pending message count is a proxy for queue lag.
 */
export async function queueLag() {
  const redis = getRedis();
  try {
    const info = await redis.xpending(STREAM_KEY, CONSUMER_GROUP);
    // Returns: [ pendingCount, minId, maxId, [[consumer, count], ...] ] when count > 0
    // or [ 0, null, null, null ] when empty
    if (Array.isArray(info)) return Number(info[0] || 0);
    return 0;
  } catch (err) {
    if (String(err.message || '').includes('NOGROUP')) return 0;
    throw err;
  }
}
