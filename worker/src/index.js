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

    // Run all 5 metrics in a single transaction so that if any one fails,
    // none of the aggregate state is corrupted. Because aggregates are
    // derived (not source of truth), retries are safe — the trades row
    // itself is unchanged in this transaction except for revenge_flag.
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
  // ioredis returns: [[streamKey, [[id, [field, value, field, value, ...]], ...]]]
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

// Exported so the API process can embed the worker loop on free-tier hosts
// where running a separate worker container is paid (e.g. Render). The
// metric pipeline is still asynchronous w.r.t. the HTTP write path —
// XADD → XREADGROUP — only the OS process boundary collapses.
export async function consume() {
  await ensureConsumerGroup();
  logger.info(
    { stream: STREAM_KEY, group: CONSUMER_GROUP, consumer: CONSUMER_NAME },
    'worker starting consume loop'
  );

  // Drain any messages assigned but unacked from a previous crash first.
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
          // Backlog drained — switch to live tail
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
            // Currently a no-op fan-out; keeps the channel hot for future
            // notification pipelines without changing the producer.
            logger.debug({ data: e.fields.data }, 'overtrading.detected observed');
          } else {
            logger.warn({ type }, 'unknown event type');
          }
          await redis.xack(STREAM_KEY, CONSUMER_GROUP, e.id);
        } catch (err) {
          logger.error({ err, id: e.id, type }, 'event handler failed');
          // Don't ack — XPENDING will surface it via /health and we can
          // reclaim with XAUTOCLAIM in a future iteration. For now we
          // sleep briefly so a poison pill doesn't pin the CPU.
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    } catch (err) {
      logger.error({ err }, 'xreadgroup failed; retrying');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// Auto-run the loop only when this file is the process entry point
// (i.e. the standalone worker container). When the API embeds us, it
// imports `consume` directly and skips this branch.
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
