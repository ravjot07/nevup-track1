/**
 * Metric 2 — Revenge Flag
 *
 * If a trade opens within 90 seconds of a *losing* close AND
 * emotionalState is anxious or fearful, mark revengeFlag = true.
 *
 * The previous trade for the same user is the one with the largest
 * exit_at strictly less than this trade's entry_at and status='closed'.
 */
export async function applyRevengeFlag(client, ev) {
  const result = await client.query(
    `WITH this_trade AS (
       SELECT trade_id, user_id, entry_at, emotional_state
       FROM trades WHERE trade_id = $1
     ),
     prev AS (
       SELECT t.outcome, t.exit_at
       FROM trades t, this_trade
       WHERE t.user_id = this_trade.user_id
         AND t.status = 'closed'
         AND t.exit_at IS NOT NULL
         AND t.exit_at < this_trade.entry_at
       ORDER BY t.exit_at DESC
       LIMIT 1
     )
     UPDATE trades SET revenge_flag = TRUE
     WHERE trade_id = $1
       AND (SELECT emotional_state FROM this_trade) IN ('anxious','fearful')
       AND (SELECT outcome FROM prev) = 'loss'
       AND EXTRACT(EPOCH FROM ((SELECT entry_at FROM this_trade) - (SELECT exit_at FROM prev))) <= 90
     RETURNING trade_id`,
    [ev.tradeId]
  );
  return result.rowCount === 1;
}
