/**
 * Metric 5 — Overtrading Detector
 *
 * If a user has opened more than 10 trades in a sliding 30-minute window
 * ending at this trade's entry_at, emit an overtrading event.
 *
 * Implemented as a windowed COUNT(*) on `trades` and a single row insert.
 * The detector publishes its own `overtrading.detected` event back onto the
 * stream so other consumers (e.g. notification systems) can react without
 * blocking the write path.
 */
export async function detectOvertrading(client, ev, redis, streamKey) {
  const r = await client.query(
    `SELECT COUNT(*)::int AS c, MIN(entry_at) AS window_start, MAX(entry_at) AS window_end
     FROM trades
     WHERE user_id = $1
       AND entry_at <= $2::timestamptz
       AND entry_at >  $2::timestamptz - INTERVAL '30 minutes'`,
    [ev.userId, ev.entryAt]
  );
  const { c, window_start, window_end } = r.rows[0];
  if (c > 10) {
    // Dedupe: don't emit if we already recorded a window ending within the
    // last minute of this same window for this user — prevents storms.
    const dup = await client.query(
      `SELECT 1 FROM overtrading_events
       WHERE user_id = $1
         AND window_end >= $2::timestamptz - INTERVAL '1 minute'
         AND window_end <= $2::timestamptz
       LIMIT 1`,
      [ev.userId, window_end]
    );
    if (dup.rowCount === 0) {
      await client.query(
        `INSERT INTO overtrading_events (user_id, window_start, window_end, trade_count)
         VALUES ($1, $2, $3, $4)`,
        [ev.userId, window_start, window_end, c]
      );
      await redis.xadd(
        streamKey,
        'MAXLEN',
        '~',
        '100000',
        '*',
        'type',
        'overtrading.detected',
        'data',
        JSON.stringify({
          userId: ev.userId,
          windowStart: window_start,
          windowEnd: window_end,
          tradeCount: c,
        })
      );
      return true;
    }
  }
  return false;
}
