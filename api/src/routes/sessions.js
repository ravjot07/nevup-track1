import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';
import { errorBody } from '../lib/errors.js';

const debriefSchema = {
  type: 'object',
  required: ['overallMood', 'planAdherenceRating'],
  additionalProperties: false,
  properties: {
    overallMood: {
      type: 'string',
      enum: ['calm', 'anxious', 'greedy', 'fearful', 'neutral'],
    },
    keyMistake: { type: ['string', 'null'], maxLength: 1000 },
    keyLesson: { type: ['string', 'null'], maxLength: 1000 },
    planAdherenceRating: { type: 'integer', minimum: 1, maximum: 5 },
    willReviewTomorrow: { type: 'boolean' },
  },
};

export default async function sessionRoutes(app) {
  // GET /sessions/:sessionId — returns SessionSummary with full trade list.
  app.get('/sessions/:sessionId', async (req, reply) => {
    const { sessionId } = req.params;

    const sessionRes = await pool.query(
      `SELECT s.id, s.user_id, s.started_at, s.notes,
              COALESCE(st.ratio, 0)::float AS tilt_ratio
       FROM sessions s
       LEFT JOIN session_tilt st ON st.session_id = s.id
       WHERE s.id = $1`,
      [sessionId]
    );

    if (sessionRes.rowCount === 0) {
      return reply
        .code(404)
        .send(errorBody('SESSION_NOT_FOUND', 'No session with that id.', req.id));
    }

    const s = sessionRes.rows[0];
    if (!req.assertTenant(s.user_id, reply)) return;

    const tradesRes = await pool.query(
      `SELECT * FROM trades WHERE session_id = $1 ORDER BY entry_at, trade_id`,
      [sessionId]
    );
    const trades = tradesRes.rows.map((r) => ({
      tradeId: r.trade_id,
      userId: r.user_id,
      sessionId: r.session_id,
      asset: r.asset,
      assetClass: r.asset_class,
      direction: r.direction,
      entryPrice: r.entry_price,
      exitPrice: r.exit_price,
      quantity: r.quantity,
      entryAt: r.entry_at instanceof Date ? r.entry_at.toISOString() : r.entry_at,
      exitAt:
        r.exit_at instanceof Date ? r.exit_at.toISOString() : r.exit_at,
      status: r.status,
      planAdherence: r.plan_adherence,
      emotionalState: r.emotional_state,
      entryRationale: r.entry_rationale,
      outcome: r.outcome,
      pnl: r.pnl,
      revengeFlag: r.revenge_flag,
    }));

    const closed = trades.filter((t) => t.status === 'closed');
    const wins = closed.filter((t) => t.outcome === 'win').length;
    const winRate = closed.length === 0 ? 0 : +(wins / closed.length).toFixed(4);
    const totalPnl = +closed.reduce((acc, t) => acc + (t.pnl || 0), 0).toFixed(2);

    return reply.send({
      sessionId: s.id,
      userId: s.user_id,
      date:
        s.started_at instanceof Date
          ? s.started_at.toISOString()
          : s.started_at,
      notes: s.notes,
      tradeCount: trades.length,
      winRate,
      totalPnl,
      sessionTiltIndex: s.tilt_ratio,
      trades,
    });
  });

  // POST /sessions/:sessionId/debrief
  app.post(
    '/sessions/:sessionId/debrief',
    { schema: { body: debriefSchema } },
    async (req, reply) => {
      const { sessionId } = req.params;

      const sRes = await pool.query(
        'SELECT user_id FROM sessions WHERE id = $1',
        [sessionId]
      );
      if (sRes.rowCount === 0) {
        return reply
          .code(404)
          .send(errorBody('SESSION_NOT_FOUND', 'No session with that id.', req.id));
      }
      if (!req.assertTenant(sRes.rows[0].user_id, reply)) return;

      const debriefId = randomUUID();
      const ins = await pool.query(
        `INSERT INTO debriefs (id, session_id, user_id, payload)
         VALUES ($1, $2, $3, $4)
         RETURNING id, session_id, created_at`,
        [debriefId, sessionId, sRes.rows[0].user_id, req.body]
      );
      const row = ins.rows[0];
      return reply.code(201).send({
        debriefId: row.id,
        sessionId: row.session_id,
        savedAt:
          row.created_at instanceof Date
            ? row.created_at.toISOString()
            : row.created_at,
      });
    }
  );
}
