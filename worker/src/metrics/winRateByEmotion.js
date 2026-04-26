export async function bumpWinRateByEmotion(client, ev) {
  if (!ev.emotionalState || !ev.outcome) return;

  await client.query(
    `INSERT INTO winrate_by_emotion (user_id, emotional_state, wins, losses)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, emotional_state) DO UPDATE SET
       wins   = winrate_by_emotion.wins   + EXCLUDED.wins,
       losses = winrate_by_emotion.losses + EXCLUDED.losses`,
    [
      ev.userId,
      ev.emotionalState,
      ev.outcome === 'win' ? 1 : 0,
      ev.outcome === 'loss' ? 1 : 0,
    ]
  );
}
