-- NevUp Track 1 — initial schema
-- Notes:
--   * trade_id is the natural primary key; ON CONFLICT (trade_id) gives us
--     idempotent POST /trades for free, no separate idempotency table needed.
--   * NUMERIC(18,8) is mandated by the canonical schema for prices/quantities.
--   * Partial index on closed trades dramatically shrinks the index for the
--     hottest read pattern (rolling metrics on closed trades only).

CREATE TABLE IF NOT EXISTS users (
  id   UUID PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'trader',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id         UUID PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL,
  notes      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_started ON sessions (user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS trades (
  trade_id        UUID PRIMARY KEY,
  user_id         UUID NOT NULL,
  session_id      UUID NOT NULL,
  asset           TEXT NOT NULL,
  asset_class     TEXT NOT NULL CHECK (asset_class IN ('equity','crypto','forex')),
  direction       TEXT NOT NULL CHECK (direction IN ('long','short')),
  entry_price     NUMERIC(18,8) NOT NULL,
  exit_price      NUMERIC(18,8),
  quantity        NUMERIC(18,8) NOT NULL,
  entry_at        TIMESTAMPTZ NOT NULL,
  exit_at         TIMESTAMPTZ,
  status          TEXT NOT NULL CHECK (status IN ('open','closed','cancelled')),
  plan_adherence  SMALLINT CHECK (plan_adherence BETWEEN 1 AND 5),
  emotional_state TEXT CHECK (emotional_state IN ('calm','anxious','greedy','fearful','neutral')),
  entry_rationale TEXT,
  outcome         TEXT CHECK (outcome IN ('win','loss')),
  pnl             NUMERIC(18,8),
  revenge_flag    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trades_user_entry   ON trades (user_id, entry_at DESC);
CREATE INDEX IF NOT EXISTS trades_user_session ON trades (user_id, session_id);
CREATE INDEX IF NOT EXISTS trades_user_closed  ON trades (user_id, exit_at DESC) WHERE status = 'closed';
CREATE INDEX IF NOT EXISTS trades_session_exit ON trades (session_id, exit_at);

-- Pre-aggregated read tables. Worker writes; API reads index-only.
CREATE TABLE IF NOT EXISTS metrics_hourly (
  user_id            UUID        NOT NULL,
  bucket             TIMESTAMPTZ NOT NULL,
  trade_count        INT         NOT NULL DEFAULT 0,
  win_count          INT         NOT NULL DEFAULT 0,
  pnl                NUMERIC(18,8) NOT NULL DEFAULT 0,
  avg_plan_adherence NUMERIC(4,2),
  PRIMARY KEY (user_id, bucket)
);

CREATE TABLE IF NOT EXISTS metrics_daily (
  user_id            UUID        NOT NULL,
  bucket             TIMESTAMPTZ NOT NULL,
  trade_count        INT         NOT NULL DEFAULT 0,
  win_count          INT         NOT NULL DEFAULT 0,
  pnl                NUMERIC(18,8) NOT NULL DEFAULT 0,
  avg_plan_adherence NUMERIC(4,2),
  PRIMARY KEY (user_id, bucket)
);

CREATE TABLE IF NOT EXISTS winrate_by_emotion (
  user_id         UUID NOT NULL,
  emotional_state TEXT NOT NULL,
  wins            INT  NOT NULL DEFAULT 0,
  losses          INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, emotional_state)
);

CREATE TABLE IF NOT EXISTS session_tilt (
  session_id  UUID PRIMARY KEY,
  user_id     UUID NOT NULL,
  loss_following INT NOT NULL DEFAULT 0,
  total_trades   INT NOT NULL DEFAULT 0,
  ratio       NUMERIC(5,4),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS session_tilt_user ON session_tilt (user_id);

CREATE TABLE IF NOT EXISTS overtrading_events (
  id           BIGSERIAL PRIMARY KEY,
  user_id      UUID NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end   TIMESTAMPTZ NOT NULL,
  trade_count  INT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS overtrading_user_window ON overtrading_events (user_id, window_end DESC);

CREATE TABLE IF NOT EXISTS plan_adherence_rolling (
  user_id          UUID PRIMARY KEY,
  rolling_avg      NUMERIC(4,2),
  last_trade_at    TIMESTAMPTZ,
  sample_size      INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS debriefs (
  id          UUID PRIMARY KEY,
  session_id  UUID NOT NULL,
  user_id     UUID NOT NULL,
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS debriefs_session ON debriefs (session_id);

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
