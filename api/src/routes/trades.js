import { pool } from '../db/pool.js';
import { errorBody } from '../lib/errors.js';
import { publishEvent } from '../queue/producer.js';

const tradeInputSchema = {
  type: 'object',
  required: [
    'tradeId',
    'userId',
    'sessionId',
    'asset',
    'assetClass',
    'direction',
    'entryPrice',
    'quantity',
    'entryAt',
    'status',
  ],
  additionalProperties: false,
  properties: {
    tradeId: { type: 'string', format: 'uuid' },
    userId: { type: 'string', format: 'uuid' },
    sessionId: { type: 'string', format: 'uuid' },
    asset: { type: 'string', minLength: 1, maxLength: 32 },
    assetClass: { type: 'string', enum: ['equity', 'crypto', 'forex'] },
    direction: { type: 'string', enum: ['long', 'short'] },
    entryPrice: { type: 'number' },
    exitPrice: { type: ['number', 'null'] },
    quantity: { type: 'number' },
    entryAt: { type: 'string', format: 'date-time' },
    exitAt: { type: ['string', 'null'], format: 'date-time' },
    status: { type: 'string', enum: ['open', 'closed', 'cancelled'] },
    planAdherence: { type: ['integer', 'null'], minimum: 1, maximum: 5 },
    emotionalState: {
      type: ['string', 'null'],
      enum: ['calm', 'anxious', 'greedy', 'fearful', 'neutral', null],
    },
    entryRationale: { type: ['string', 'null'], maxLength: 500 },
  },
};

function rowToTrade(r) {
  return {
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
    createdAt:
      r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    updatedAt:
      r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
  };
}

function deriveOutcomeAndPnl(t) {
  if (t.status !== 'closed' || t.exitPrice == null) {
    return { outcome: null, pnl: null };
  }
  const sign = t.direction === 'long' ? 1 : -1;
  const pnl = +(sign * (t.exitPrice - t.entryPrice) * t.quantity).toFixed(8);
  const outcome = pnl >= 0 ? 'win' : 'loss';
  return { outcome, pnl };
}

export default async function tradeRoutes(app) {
  app.post(
    '/trades',
    { schema: { body: tradeInputSchema } },
    async (req, reply) => {
      const t = req.body;

      if (!req.assertTenant(t.userId, reply)) return;

      const { outcome, pnl } = deriveOutcomeAndPnl(t);

      const insertSql = `
        WITH new_session AS (
          INSERT INTO sessions (id, user_id, started_at)
          VALUES ($3, $2, $10)
          ON CONFLICT (id) DO NOTHING
          RETURNING id
        )
        INSERT INTO trades (
          trade_id, user_id, session_id, asset, asset_class, direction,
          entry_price, exit_price, quantity, entry_at, exit_at, status,
          plan_adherence, emotional_state, entry_rationale, outcome, pnl
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
        )
        ON CONFLICT (trade_id) DO NOTHING
        RETURNING *`;
      const params = [
        t.tradeId,
        t.userId,
        t.sessionId,
        t.asset,
        t.assetClass,
        t.direction,
        t.entryPrice,
        t.exitPrice ?? null,
        t.quantity,
        t.entryAt,
        t.exitAt ?? null,
        t.status,
        t.planAdherence ?? null,
        t.emotionalState ?? null,
        t.entryRationale ?? null,
        outcome,
        pnl,
      ];

      const ins = await pool.query(insertSql, params);
      let row;
      let isNew = false;

      if (ins.rowCount === 1) {
        row = ins.rows[0];
        isNew = true;
      } else {
        const existing = await pool.query(
          'SELECT * FROM trades WHERE trade_id = $1',
          [t.tradeId]
        );
        row = existing.rows[0];
      }

      if (isNew && row.status === 'closed') {
        publishEvent('trade.closed', {
          tradeId: row.trade_id,
          userId: row.user_id,
          sessionId: row.session_id,
          entryAt: row.entry_at,
          exitAt: row.exit_at,
          outcome: row.outcome,
          pnl: row.pnl,
          emotionalState: row.emotional_state,
          planAdherence: row.plan_adherence,
          traceId: req.id,
        }).catch((err) => {
          req.log.error({ err, tradeId: row.trade_id }, 'queue publish failed');
        });
      }

      return reply.code(200).send(rowToTrade(row));
    }
  );

  app.get('/trades/:tradeId', async (req, reply) => {
    const { tradeId } = req.params;
    const r = await pool.query('SELECT * FROM trades WHERE trade_id = $1', [tradeId]);
    if (r.rowCount === 0) {
      return reply
        .code(404)
        .send(errorBody('TRADE_NOT_FOUND', 'No trade with that id.', req.id));
    }
    const row = r.rows[0];
    if (!req.assertTenant(row.user_id, reply)) return;
    return reply.send(rowToTrade(row));
  });
}
