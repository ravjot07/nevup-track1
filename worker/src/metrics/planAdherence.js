/**
 * Metric 1 — Plan Adherence Score
 *
 * Rolling 10-trade average of planAdherence ratings per user.
 * Recomputed on every closed trade because the rolling window slides.
 */
export async function recomputePlanAdherence(client, ev) {
  await client.query(
    `WITH last10 AS (
       SELECT plan_adherence
       FROM trades
       WHERE user_id = $1
         AND status = 'closed'
         AND plan_adherence IS NOT NULL
       ORDER BY exit_at DESC, trade_id DESC
       LIMIT 10
     ),
     agg AS (
       SELECT
         AVG(plan_adherence)::numeric(4,2) AS rolling_avg,
         COUNT(*)::int                     AS sample_size
       FROM last10
     )
     INSERT INTO plan_adherence_rolling (user_id, rolling_avg, last_trade_at, sample_size)
     SELECT $1, agg.rolling_avg, $2::timestamptz, agg.sample_size FROM agg
     ON CONFLICT (user_id) DO UPDATE SET
       rolling_avg   = EXCLUDED.rolling_avg,
       last_trade_at = EXCLUDED.last_trade_at,
       sample_size   = EXCLUDED.sample_size`,
    [ev.userId, ev.exitAt || ev.entryAt]
  );
}

/**
 * Bonus — incremental hourly+daily aggregates for the read API.
 * The trades table is the source of truth; these aggregates exist purely
 * so GET /users/:id/metrics can be answered with index-only scans.
 */
export async function bumpAggregates(client, ev) {
  if (!ev.exitAt) return;
  const win = ev.outcome === 'win' ? 1 : 0;
  const pnl = Number(ev.pnl ?? 0);
  const pa = ev.planAdherence ?? null;

  // Hourly bucket
  await client.query(
    `INSERT INTO metrics_hourly (user_id, bucket, trade_count, win_count, pnl, avg_plan_adherence)
     VALUES ($1, date_trunc('hour', $2::timestamptz), 1, $3, $4, $5)
     ON CONFLICT (user_id, bucket) DO UPDATE SET
       trade_count        = metrics_hourly.trade_count + 1,
       win_count          = metrics_hourly.win_count + EXCLUDED.win_count,
       pnl                = metrics_hourly.pnl + EXCLUDED.pnl,
       avg_plan_adherence = CASE
         WHEN EXCLUDED.avg_plan_adherence IS NULL THEN metrics_hourly.avg_plan_adherence
         WHEN metrics_hourly.avg_plan_adherence IS NULL THEN EXCLUDED.avg_plan_adherence
         ELSE ((metrics_hourly.avg_plan_adherence * metrics_hourly.trade_count) + EXCLUDED.avg_plan_adherence)
              / (metrics_hourly.trade_count + 1)
       END`,
    [ev.userId, ev.exitAt, win, pnl, pa]
  );

  // Daily bucket
  await client.query(
    `INSERT INTO metrics_daily (user_id, bucket, trade_count, win_count, pnl, avg_plan_adherence)
     VALUES ($1, date_trunc('day', $2::timestamptz), 1, $3, $4, $5)
     ON CONFLICT (user_id, bucket) DO UPDATE SET
       trade_count        = metrics_daily.trade_count + 1,
       win_count          = metrics_daily.win_count + EXCLUDED.win_count,
       pnl                = metrics_daily.pnl + EXCLUDED.pnl,
       avg_plan_adherence = CASE
         WHEN EXCLUDED.avg_plan_adherence IS NULL THEN metrics_daily.avg_plan_adherence
         WHEN metrics_daily.avg_plan_adherence IS NULL THEN EXCLUDED.avg_plan_adherence
         ELSE ((metrics_daily.avg_plan_adherence * metrics_daily.trade_count) + EXCLUDED.avg_plan_adherence)
              / (metrics_daily.trade_count + 1)
       END`,
    [ev.userId, ev.exitAt, win, pnl, pa]
  );
}
