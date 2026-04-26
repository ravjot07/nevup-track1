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
