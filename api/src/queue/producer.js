import Redis from 'ioredis';
import { logger } from '../lib/logger.js';

export const STREAM_KEY = 'nevup:events';
export const CONSUMER_GROUP = 'metrics-workers';

let redisClient;

/**
 * Build ioredis options that "do the right thing" for the URL we're given.
 *
 * Upstash (and most managed Redis providers) require TLS on the only public
 * port. Their docs sometimes show `redis://` URLs even though the listener
 * is TLS-only, so users routinely copy the wrong scheme. We detect known
 * TLS-only providers by hostname and force the `tls` option so both
 * `rediss://` and `redis://` URLs Just Work for them. For local Compose
 * (`redis://redis:6379`) we leave TLS off.
 */
function buildRedisOptions(url) {
  const opts = {
    // 5 retries × ~exponential backoff is enough to ride out a brief
    // re-balance / DNS blip without permanently killing the boot.
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
    // Malformed URL — let ioredis surface the error itself.
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
