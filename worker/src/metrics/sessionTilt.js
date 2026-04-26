/**
 * Metric 3 — Session Tilt Index
 *
 * Ratio of (loss-following trades / total trades) for the trade's session.
 * A "loss-following" trade is one whose immediately preceding trade in the
 * same session ended in a loss.
 *
 * Recomputes from scratch on every close — small per-session row count
 * (typically 5-16) makes this trivial; pre-aggregating per partial session
 * would add invariant maintenance for no meaningful win.
 */
export async function recomputeSessionTilt(client, ev) {
  await client.query(
    `WITH ordered AS (
       SELECT
         outcome,
         LAG(outcome) OVER (PARTITION BY session_id ORDER BY entry_at, trade_id) AS prev_outcome
       FROM trades
       WHERE session_id = $1 AND status = 'closed'
     ),
     agg AS (
       SELECT
         COUNT(*) FILTER (WHERE prev_outcome = 'loss')::int AS loss_following,
         COUNT(*)::int AS total_trades
       FROM ordered
     )
     INSERT INTO session_tilt (session_id, user_id, loss_following, total_trades, ratio, updated_at)
     SELECT
       $1, $2, agg.loss_following, agg.total_trades,
       CASE WHEN agg.total_trades = 0 THEN 0
            ELSE (agg.loss_following::numeric / agg.total_trades)::numeric(5,4)
       END,
       now()
     FROM agg
     ON CONFLICT (session_id) DO UPDATE SET
       loss_following = EXCLUDED.loss_following,
       total_trades   = EXCLUDED.total_trades,
       ratio          = EXCLUDED.ratio,
       updated_at     = EXCLUDED.updated_at`,
    [ev.sessionId, ev.userId]
  );
}
