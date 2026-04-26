import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { pool, withClient } from './pool.js';
import { logger } from '../lib/logger.js';

const SEED_PATH = process.env.SEED_PATH || '/app/nevup_seed_dataset.csv';
const FALLBACK_PATH = path.resolve(process.cwd(), '../nevup_seed_dataset.csv');

function toNumOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function toIntOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

function toStrOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  return v;
}

export async function seedFromCsv() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM trades');
  if (rows[0].c > 0) {
    logger.info({ existing: rows[0].c }, 'trades already seeded; skipping');
    return;
  }

  let csvPath = SEED_PATH;
  try {
    await fs.access(csvPath);
  } catch {
    csvPath = FALLBACK_PATH;
  }

  logger.info({ csvPath }, 'loading seed CSV');
  const buf = await fs.readFile(csvPath);
  const records = parse(buf, { columns: true, skip_empty_lines: true });
  logger.info({ count: records.length }, 'parsed seed CSV');

  const users = new Map();
  const sessions = new Map();
  for (const r of records) {
    if (!users.has(r.userId)) {
      users.set(r.userId, { id: r.userId, name: r.traderName, role: 'trader' });
    }
    if (!sessions.has(r.sessionId)) {
      sessions.set(r.sessionId, {
        id: r.sessionId,
        user_id: r.userId,
        started_at: r.entryAt,
      });
    } else {
      const cur = sessions.get(r.sessionId);
      if (new Date(r.entryAt) < new Date(cur.started_at)) cur.started_at = r.entryAt;
    }
  }

  await withClient(async (c) => {
    await c.query('BEGIN');
    try {
      for (const u of users.values()) {
        await c.query(
          `INSERT INTO users (id, name, role) VALUES ($1, $2, $3)
           ON CONFLICT (id) DO NOTHING`,
          [u.id, u.name, u.role]
        );
      }
      for (const s of sessions.values()) {
        await c.query(
          `INSERT INTO sessions (id, user_id, started_at) VALUES ($1, $2, $3)
           ON CONFLICT (id) DO NOTHING`,
          [s.id, s.user_id, s.started_at]
        );
      }

      const BATCH = 200;
      for (let i = 0; i < records.length; i += BATCH) {
        const slice = records.slice(i, i + BATCH);
        const values = [];
        const params = [];
        let p = 1;
        for (const r of slice) {
          values.push(
            `($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`
          );
          params.push(
            r.tradeId,
            r.userId,
            r.sessionId,
            r.asset,
            r.assetClass,
            r.direction,
            toNumOrNull(r.entryPrice),
            toNumOrNull(r.exitPrice),
            toNumOrNull(r.quantity),
            r.entryAt,
            toStrOrNull(r.exitAt),
            r.status,
            toIntOrNull(r.planAdherence),
            toStrOrNull(r.emotionalState),
            toStrOrNull(r.entryRationale),
            toStrOrNull(r.outcome),
            toNumOrNull(r.pnl),
            r.revengeFlag === 'true'
          );
        }
        const sql = `
          INSERT INTO trades
            (trade_id, user_id, session_id, asset, asset_class, direction,
             entry_price, exit_price, quantity, entry_at, exit_at, status,
             plan_adherence, emotional_state, entry_rationale, outcome, pnl, revenge_flag)
          VALUES ${values.join(',')}
          ON CONFLICT (trade_id) DO NOTHING`;
        await c.query(sql, params);
      }

      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    }
  });

  logger.info({ users: users.size, sessions: sessions.size, trades: records.length }, 'seed complete');

  await replayMetrics();
}

async function replayMetrics() {
  logger.info('replaying metrics for seeded trades');

  await pool.query(`
    WITH ordered AS (
      SELECT
        trade_id,
        user_id,
        entry_at,
        emotional_state,
        LAG(outcome) OVER (PARTITION BY user_id ORDER BY entry_at, trade_id) AS prev_outcome,
        LAG(exit_at) OVER (PARTITION BY user_id ORDER BY entry_at, trade_id) AS prev_exit_at
      FROM trades
      WHERE status = 'closed'
    )
    UPDATE trades t SET revenge_flag = TRUE
    FROM ordered o
    WHERE t.trade_id = o.trade_id
      AND o.prev_outcome = 'loss'
      AND o.prev_exit_at IS NOT NULL
      AND EXTRACT(EPOCH FROM (o.entry_at - o.prev_exit_at)) <= 90
      AND t.emotional_state IN ('anxious','fearful')
  `);

  await pool.query(`
    INSERT INTO metrics_hourly (user_id, bucket, trade_count, win_count, pnl, avg_plan_adherence)
    SELECT
      user_id,
      date_trunc('hour', exit_at) AS bucket,
      COUNT(*)::int AS trade_count,
      COUNT(*) FILTER (WHERE outcome = 'win')::int AS win_count,
      COALESCE(SUM(pnl), 0) AS pnl,
      AVG(plan_adherence)::numeric(4,2) AS avg_plan_adherence
    FROM trades
    WHERE status = 'closed' AND exit_at IS NOT NULL
    GROUP BY user_id, date_trunc('hour', exit_at)
    ON CONFLICT (user_id, bucket) DO UPDATE SET
      trade_count        = EXCLUDED.trade_count,
      win_count          = EXCLUDED.win_count,
      pnl                = EXCLUDED.pnl,
      avg_plan_adherence = EXCLUDED.avg_plan_adherence
  `);

  await pool.query(`
    INSERT INTO metrics_daily (user_id, bucket, trade_count, win_count, pnl, avg_plan_adherence)
    SELECT
      user_id,
      date_trunc('day', exit_at) AS bucket,
      COUNT(*)::int AS trade_count,
      COUNT(*) FILTER (WHERE outcome = 'win')::int AS win_count,
      COALESCE(SUM(pnl), 0) AS pnl,
      AVG(plan_adherence)::numeric(4,2) AS avg_plan_adherence
    FROM trades
    WHERE status = 'closed' AND exit_at IS NOT NULL
    GROUP BY user_id, date_trunc('day', exit_at)
    ON CONFLICT (user_id, bucket) DO UPDATE SET
      trade_count        = EXCLUDED.trade_count,
      win_count          = EXCLUDED.win_count,
      pnl                = EXCLUDED.pnl,
      avg_plan_adherence = EXCLUDED.avg_plan_adherence
  `);

  await pool.query(`
    INSERT INTO winrate_by_emotion (user_id, emotional_state, wins, losses)
    SELECT
      user_id,
      emotional_state,
      COUNT(*) FILTER (WHERE outcome = 'win')::int AS wins,
      COUNT(*) FILTER (WHERE outcome = 'loss')::int AS losses
    FROM trades
    WHERE status = 'closed' AND emotional_state IS NOT NULL
    GROUP BY user_id, emotional_state
    ON CONFLICT (user_id, emotional_state) DO UPDATE SET
      wins   = EXCLUDED.wins,
      losses = EXCLUDED.losses
  `);

  await pool.query(`
    WITH ordered AS (
      SELECT
        session_id,
        user_id,
        outcome,
        LAG(outcome) OVER (PARTITION BY session_id ORDER BY entry_at, trade_id) AS prev_outcome
      FROM trades
      WHERE status = 'closed'
    )
    INSERT INTO session_tilt (session_id, user_id, loss_following, total_trades, ratio, updated_at)
    SELECT
      session_id,
      user_id,
      COUNT(*) FILTER (WHERE prev_outcome = 'loss')::int AS loss_following,
      COUNT(*)::int AS total_trades,
      (COUNT(*) FILTER (WHERE prev_outcome = 'loss')::numeric /
       NULLIF(COUNT(*), 0))::numeric(5,4) AS ratio,
      now()
    FROM ordered
    GROUP BY session_id, user_id
    ON CONFLICT (session_id) DO UPDATE SET
      loss_following = EXCLUDED.loss_following,
      total_trades   = EXCLUDED.total_trades,
      ratio          = EXCLUDED.ratio,
      updated_at     = EXCLUDED.updated_at
  `);

  await pool.query(`
    WITH window_counts AS (
      SELECT
        a.user_id,
        a.entry_at AS window_end,
        COUNT(*)::int AS trade_count
      FROM trades a
      JOIN trades b
        ON b.user_id = a.user_id
       AND b.entry_at <= a.entry_at
       AND b.entry_at > a.entry_at - INTERVAL '30 minutes'
      GROUP BY a.user_id, a.entry_at
    )
    INSERT INTO overtrading_events (user_id, window_start, window_end, trade_count)
    SELECT user_id, window_end - INTERVAL '30 minutes', window_end, trade_count
    FROM window_counts
    WHERE trade_count > 10
  `);

  await pool.query(`
    WITH ranked AS (
      SELECT
        user_id,
        exit_at,
        plan_adherence,
        ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY exit_at DESC, trade_id DESC) AS rn
      FROM trades
      WHERE status = 'closed' AND plan_adherence IS NOT NULL
    ),
    last10 AS (
      SELECT user_id, AVG(plan_adherence)::numeric(4,2) AS rolling_avg, COUNT(*)::int AS sample_size, MAX(exit_at) AS last_trade_at
      FROM ranked
      WHERE rn <= 10
      GROUP BY user_id
    )
    INSERT INTO plan_adherence_rolling (user_id, rolling_avg, last_trade_at, sample_size)
    SELECT user_id, rolling_avg, last_trade_at, sample_size FROM last10
    ON CONFLICT (user_id) DO UPDATE SET
      rolling_avg   = EXCLUDED.rolling_avg,
      last_trade_at = EXCLUDED.last_trade_at,
      sample_size   = EXCLUDED.sample_size
  `);

  logger.info('metrics replay complete');
}
