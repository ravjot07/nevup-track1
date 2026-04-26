import {
  pool,
  redis,
  logger,
  STREAM_KEY,
  CONSUMER_GROUP,
  CONSUMER_NAME,
  ensureConsumerGroup,
} from './lib.js';
import { applyRevengeFlag } from './metrics/revengeFlag.js';
import { recomputeSessionTilt } from './metrics/sessionTilt.js';
import { bumpWinRateByEmotion } from './metrics/winRateByEmotion.js';
import { detectOvertrading } from './metrics/overtrading.js';
import { recomputePlanAdherence, bumpAggregates } from './metrics/planAdherence.js';

const READ_BLOCK_MS = 5_000;
const READ_BATCH = 50;

async function processClosedTrade(ev) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await applyRevengeFlag(client, ev);
    await recomputeSessionTilt(client, ev);
    await bumpWinRateByEmotion(client, ev);
    await recomputePlanAdherence(client, ev);
    await bumpAggregates(client, ev);
    const overtraded = await detectOvertrading(client, ev, redis, STREAM_KEY);

    await client.query('COMMIT');

    if (overtraded) {
      logger.warn(
        { userId: ev.userId, tradeId: ev.tradeId },
        'overtrading event emitted'
      );
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function parseEntries(streams) {
  const out = [];
  if (!streams) return out;
  for (const [, entries] of streams) {
    for (const [id, kv] of entries) {
      const fields = {};
      for (let i = 0; i < kv.length; i += 2) fields[kv[i]] = kv[i + 1];
      out.push({ id, fields });
    }
  }
  return out;
}

export async function consume() {
  await ensureConsumerGroup();
  logger.info(
    { stream: STREAM_KEY, group: CONSUMER_GROUP, consumer: CONSUMER_NAME },
    'worker starting consume loop'
  );

  let cursor = '0';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const arg = cursor === 'live' ? '>' : cursor;
      const resp = await redis.xreadgroup(
        'GROUP', CONSUMER_GROUP, CONSUMER_NAME,
        'COUNT', READ_BATCH,
        'BLOCK', READ_BLOCK_MS,
        'STREAMS', STREAM_KEY, arg
      );
      const entries = parseEntries(resp);

      if (entries.length === 0) {
        if (cursor !== 'live') {
          cursor = 'live';
        }
        continue;
      }

      for (const e of entries) {
        const type = e.fields.type;
        try {
          if (type === 'trade.closed') {
            const ev = JSON.parse(e.fields.data);
            await processClosedTrade(ev);
          } else if (type === 'overtrading.detected') {
            logger.debug({ data: e.fields.data }, 'overtrading.detected observed');
          } else {
            logger.warn({ type }, 'unknown event type');
          }
          await redis.xack(STREAM_KEY, CONSUMER_GROUP, e.id);
        } catch (err) {
          logger.error({ err, id: e.id, type }, 'event handler failed');
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    } catch (err) {
      logger.error({ err }, 'xreadgroup failed; retrying');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

const isEntry = import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  consume().catch((err) => {
    logger.fatal({ err }, 'worker crashed');
    process.exit(1);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      logger.info({ sig }, 'worker shutting down');
      try {
        await pool.end();
        await redis.quit();
      } catch (err) {
        logger.warn({ err }, 'shutdown cleanup error');
      }
      process.exit(0);
    });
  }
}
