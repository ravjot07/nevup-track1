import { pool } from '../db/pool.js';
import { errorBody } from '../lib/errors.js';

export default async function userRoutes(app) {
  app.get('/users/:userId/metrics', async (req, reply) => {
    const { userId } = req.params;
    if (!req.assertTenant(userId, reply)) return;

    const { from, to, granularity } = req.query;
    if (!from || !to || !granularity) {
      return reply
        .code(400)
        .send(
          errorBody('BAD_REQUEST', 'from, to, granularity are required.', req.id)
        );
    }
    if (!['hourly', 'daily', 'rolling30d'].includes(granularity)) {
      return reply
        .code(400)
        .send(errorBody('BAD_REQUEST', 'Invalid granularity.', req.id));
    }

    let table = 'metrics_hourly';
    let bucketExpr = 'bucket';
    if (granularity === 'daily') table = 'metrics_daily';
    if (granularity === 'rolling30d') {
      table = 'metrics_daily';
      const thirty = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      if (new Date(from) < new Date(thirty)) {
        // eslint-disable-next-line no-param-reassign
        req.query.from = thirty;
      }
    }

    const tsRes = await pool.query(
      `SELECT bucket, trade_count, win_count, pnl, avg_plan_adherence
       FROM ${table}
       WHERE user_id = $1 AND bucket >= $2 AND bucket <= $3
       ORDER BY bucket ASC`,
      [userId, req.query.from, to]
    );

    const winrateRes = await pool.query(
      `SELECT emotional_state, wins, losses
       FROM winrate_by_emotion
       WHERE user_id = $1`,
      [userId]
    );

    const planAdhRes = await pool.query(
      `SELECT rolling_avg, sample_size
       FROM plan_adherence_rolling
       WHERE user_id = $1`,
      [userId]
    );

    const tiltRes = await pool.query(
      `SELECT AVG(st.ratio)::float AS avg_ratio
       FROM session_tilt st
       JOIN sessions s ON s.id = st.session_id
       WHERE st.user_id = $1 AND s.started_at BETWEEN $2 AND $3`,
      [userId, req.query.from, to]
    );

    const overtradingRes = await pool.query(
      `SELECT COUNT(*)::int AS c
       FROM overtrading_events
       WHERE user_id = $1 AND window_end BETWEEN $2 AND $3`,
      [userId, req.query.from, to]
    );

    const revengeRes = await pool.query(
      `SELECT COUNT(*)::int AS c
       FROM trades
       WHERE user_id = $1
         AND status = 'closed'
         AND revenge_flag = TRUE
         AND exit_at BETWEEN $2 AND $3`,
      [userId, req.query.from, to]
    );

    const winRateByEmotionalState = {};
    for (const r of winrateRes.rows) {
      const total = r.wins + r.losses;
      winRateByEmotionalState[r.emotional_state] = {
        wins: r.wins,
        losses: r.losses,
        winRate: total === 0 ? 0 : +(r.wins / total).toFixed(4),
      };
    }

    return reply.send({
      userId,
      granularity,
      from: req.query.from,
      to,
      planAdherenceScore: planAdhRes.rows[0]?.rolling_avg ?? null,
      sessionTiltIndex: tiltRes.rows[0]?.avg_ratio ?? 0,
      winRateByEmotionalState,
      revengeTrades: revengeRes.rows[0].c,
      overtradingEvents: overtradingRes.rows[0].c,
      timeseries: tsRes.rows.map((r) => ({
        bucket:
          r.bucket instanceof Date ? r.bucket.toISOString() : r.bucket,
        tradeCount: r.trade_count,
        winRate:
          r.trade_count === 0 ? 0 : +(r.win_count / r.trade_count).toFixed(4),
        pnl: Number(r.pnl),
        avgPlanAdherence:
          r.avg_plan_adherence !== null ? Number(r.avg_plan_adherence) : null,
      })),
    });
  });

  app.get('/users/:userId/profile', async (req, reply) => {
    const { userId } = req.params;
    if (!req.assertTenant(userId, reply)) return;

    const userRes = await pool.query(
      'SELECT id, name FROM users WHERE id = $1',
      [userId]
    );
    if (userRes.rowCount === 0) {
      return reply
        .code(404)
        .send(errorBody('USER_NOT_FOUND', 'No user with that id.', req.id));
    }

    const sigsRes = await pool.query(
      `WITH r AS (
         SELECT COUNT(*) FILTER (WHERE revenge_flag) AS revenge_trades,
                COUNT(*) FILTER (WHERE status = 'closed') AS total_closed
         FROM trades WHERE user_id = $1
       ), o AS (
         SELECT COUNT(*) AS overtrading_events FROM overtrading_events WHERE user_id = $1
       ), t AS (
         SELECT AVG(ratio)::float AS avg_tilt FROM session_tilt WHERE user_id = $1
       )
       SELECT r.revenge_trades, r.total_closed, o.overtrading_events, t.avg_tilt
       FROM r, o, t`,
      [userId]
    );

    const sig = sigsRes.rows[0];
    const dominant = [];
    const closed = Number(sig.total_closed || 0);
    const revenge = Number(sig.revenge_trades || 0);
    const overtrading = Number(sig.overtrading_events || 0);
    const tilt = Number(sig.avg_tilt || 0);

    if (closed > 0 && revenge / closed > 0.15) {
      dominant.push({
        pathology: 'revenge_trading',
        confidence: Math.min(1, +(revenge / closed * 2).toFixed(2)),
        evidenceSessions: [],
        evidenceTrades: [],
      });
    }
    if (overtrading > 0) {
      dominant.push({
        pathology: 'overtrading',
        confidence: Math.min(1, +(overtrading / 5).toFixed(2)),
        evidenceSessions: [],
        evidenceTrades: [],
      });
    }
    if (tilt > 0.4) {
      dominant.push({
        pathology: 'session_tilt',
        confidence: Math.min(1, +(tilt).toFixed(2)),
        evidenceSessions: [],
        evidenceTrades: [],
      });
    }

    if (dominant.length > 0 && dominant[0].pathology === 'revenge_trading') {
      const e = await pool.query(
        `SELECT trade_id, session_id FROM trades
         WHERE user_id = $1 AND revenge_flag = TRUE
         ORDER BY entry_at DESC LIMIT 10`,
        [userId]
      );
      dominant[0].evidenceTrades = e.rows.map((r) => r.trade_id);
      dominant[0].evidenceSessions = [...new Set(e.rows.map((r) => r.session_id))];
    }

    const peakRes = await pool.query(
      `SELECT EXTRACT(HOUR FROM entry_at)::int AS hour,
              COUNT(*) FILTER (WHERE outcome = 'win')::int AS w,
              COUNT(*) FILTER (WHERE outcome IS NOT NULL)::int AS t
       FROM trades
       WHERE user_id = $1 AND status = 'closed'
       GROUP BY EXTRACT(HOUR FROM entry_at)
       HAVING COUNT(*) FILTER (WHERE outcome IS NOT NULL) >= 3
       ORDER BY (COUNT(*) FILTER (WHERE outcome='win')::float /
                 NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0)) DESC
       LIMIT 1`,
      [userId]
    );
    const peak =
      peakRes.rowCount > 0
        ? {
            startHour: peakRes.rows[0].hour,
            endHour: peakRes.rows[0].hour + 1,
            winRate: +(peakRes.rows[0].w / peakRes.rows[0].t).toFixed(4),
          }
        : null;

    return reply.send({
      userId,
      generatedAt: new Date().toISOString(),
      dominantPathologies: dominant,
      strengths: [],
      peakPerformanceWindow: peak,
    });
  });
}
