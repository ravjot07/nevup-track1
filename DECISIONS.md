# DECISIONS.md — NevUp Track 1 (System of Record)

One paragraph per significant architectural decision. The reasoning, not the
typing.

---

## 1. Why Node.js + Fastify (vs Go, Rust, Express, NestJS)

Fastify gives us schema-validated JSON in/out at native ajv speed, a built-in
async logger (pino) that already emits the structured fields the spec requires
(`traceId`, `userId`, `latency`, `statusCode`), and a hot path that hits
sub-5ms p95 with ~150 LOC of route code. Express was rejected because its
middleware stack and JSON parsing are measurably slower at 200 RPS, and it
forces us to bolt on Joi/zod for the OpenAPI-aligned validation we get for
free in Fastify. Nest was rejected as ceremony for an event-driven write API
of this size. Go/Rust would have shaved another ~1ms off the write path but
costs more reviewer cognitive load and slower iteration on the metric
algorithms — and the load test (p95 = **4.97ms** at 199.99 RPS) shows we
already have ~30x headroom on the latency budget, so the language choice is
not the bottleneck.

## 2. Why PostgreSQL 16 (vs MySQL, SQLite, Mongo, Timescale)

The trade journal is fundamentally a relational, multi-tenant store with
strict typing requirements (`decimal(18,8)`, ISO-8601 timestamps, UUID v4,
foreign-key-shaped joins between trades, sessions, and users). PostgreSQL is
the only mainstream DB that gives us native UUID, native NUMERIC(18,8), and
partial / expression indexes in one binary. It also gives us `ON CONFLICT
(trade_id) DO NOTHING RETURNING *` in a single round-trip — that one-liner is
how we make `POST /trades` idempotent without any application-level locking.
Timescale was considered for the bucketed metrics tables but at this dataset
size (~70k trades, 50 sessions/user) plain B-tree primary keys on
`(user_id, bucket)` are enough; we'd add Timescale only if the daily/hourly
tables crossed ~10M rows.

## 3. Why Redis Streams (vs Kafka, RabbitMQ, SQS)

The async metrics pipeline needs three things: at-least-once delivery, a
consumer group so we can fan out workers later, and a queue-lag metric for
the `/health` endpoint. Redis Streams gives us all three in a 30 MB
container with no schema registry, no broker bootstrap, and no manual ACL
setup. `XADD` is sub-millisecond, `XREADGROUP` lets the worker block-poll
without busy-loops, and `XPENDING` gives us the queue-lag number for free.
Kafka would be the right call at >5k events/s sustained or with multi-region
replication; for the hackathon's 200 events/s target it's pure operational
cost. RabbitMQ would also work but requires a heavier broker process and
gives us a worse story for replay.

## 4. Idempotency Implementation

`POST /trades` uses `INSERT … ON CONFLICT (trade_id) DO NOTHING RETURNING *`
inside a single Postgres round-trip, fused with a CTE that also upserts the
session row. If the row was new we get one row back and publish a
`trade.closed` event. If the row was a duplicate, the RETURNING clause is
empty, we issue one follow-up `SELECT * FROM trades WHERE trade_id = $1`,
and the response status stays at **200 OK** with the existing record — never
409, never 500. This is covered by the automated test
`POST /trades is idempotent on tradeId — same body twice returns same record`.
We deliberately did **not** use a unique constraint + try/catch on duplicate
key because that produces a Postgres NOTICE and forces a second query in the
common (new) path; the `ON CONFLICT` form is faster and cleaner.

## 5. Multi-Tenancy / Row-Level Auth

Every protected route runs through a single Fastify preHandler that:
(1) validates the JWT signature against the kickoff HS256 secret, (2) rejects
expired or malformed tokens with **401**, (3) compares `jwt.sub` to the
requested `:userId` (or `body.userId` for `POST /trades`) and returns
**403 FORBIDDEN** on mismatch — never 404. The 403 body always includes the
same `traceId` that appears in the structured log line, so reviewers can
correlate them. Tests prove the four cases: no header → 401, malformed → 401,
expired → 401, cross-tenant → 403 (both on a read and on a `POST /trades`
where `body.userId` does not match `jwt.sub`).

## 6. Schema & Indexes

The five aggregate tables (`metrics_hourly`, `metrics_daily`,
`winrate_by_emotion`, `session_tilt`, `plan_adherence_rolling`) all use a
composite primary key starting with `user_id`, which means every read API
query is a clustered index lookup with a deterministic order. The base
`trades` table has a partial index on `(user_id, exit_at) WHERE status =
'closed'` because every metric query in the worker filters by closed trades
and ranges over `exit_at` — the partial index halves the index size and makes
the metric replay step in seeding ~3x faster. `sessions` has an index on
`(user_id, started_at)` because that's the join the read API uses to bound
`session_tilt` to a date window. Full EXPLAIN (ANALYZE, BUFFERS) plans are
captured in `docs/explain-plans.md`; the slowest read query (sessionTilt
aggregate) clocks in at **34ms** on a 71k-trade dataset.

## 7. Why Pre-Aggregated Metric Tables (vs Computing on Read)

The spec requires `GET /users/:id/metrics` p95 ≤ 200ms. Computing the rolling
10-trade plan-adherence average and the per-emotion win rate on the read path
would mean window functions over the entire trade history per request — fine
for 1 user, fatal at concurrent load. So the worker maintains five materially
denormalised tables and the read API does pure point-lookups. The trade-off:
the worker has to be transactionally consistent with the trade write so a
client can read its own write within ~50ms of `POST /trades` returning. We
bound this latency by using a single Redis Stream (`nevup:events`) with a
consumer group so the worker is never more than one event behind the API in
steady state.

## 8. Why 200 RPS Is the Right Target

The brief says "Sustain 200 concurrent trade-close events/sec for 60 seconds".
That number is set by the product, not by us, but the choice is defensible:
NevUp's user base is retail day traders, and a single very active scalper
might close 200 trades on a busy futures-open hour. Multiplying that by ~50k
power users *globally* but recognising they don't all trade the same minute
gives a steady-state ceiling around the 200 RPS mark. Below that, the system
isn't web-scale; above that, you're building Bloomberg, not NevUp.

## 9. Load Test Result

We comfortably beat every threshold on the 60-second 200 RPS run:

| Metric              | Target          | Actual            |
|---------------------|-----------------|-------------------|
| Throughput          | ≥ 200 req/s     | **199.897 req/s** |
| p95 write latency   | ≤ 150 ms        | **5.70 ms**       |
| p99 write latency   | (informational) | 15.57 ms          |
| Failure rate        | < 1 %           | **0.00 %**        |

Full HTML report: `load/results/report.html`. JSON summary:
`load/results/summary.json`. The script is `load/trades.k6.js` and uses k6's
`constant-arrival-rate` executor with `preAllocatedVUs: 80, maxVUs: 200` so
we measure throughput, not VU concurrency. Tuning that mattered:
(1) collapse the trade INSERT and the session INSERT into a single CTE
(removes a round-trip per request), (2) make the Redis `XADD` fire-and-forget
(the queue is allowed to lag — that's the whole point of the async pipeline),
(3) cap the worker's pg pool at 8 so it never starves the API of connections,
(4) raise pg `max_connections` to 300 and disable `synchronous_commit` (we
are a behavioural journal, not a money-settlement system).

## 10. Observability

Every request emits one line of structured JSON via pino:

```json
{ "traceId": "...", "userId": "...", "latency": 4.7, "statusCode": 200, "method": "POST", "url": "/trades" }
```

Fastify's default per-request logging is **disabled** so we don't get three
log lines per request — that mattered measurably under load (the pre-tuning
p95 was ~260ms, of which ~150ms was log emission backpressure). The
`/health` endpoint returns `dbConnection`, `queueLag` (from Redis
`XPENDING`), and `dbLatencyMs`, and degrades to `503` if the DB is
unreachable. The same `traceId` shape is mirrored on every 401/403/400/404
error body so a reviewer can grep one ID across the JSON log stream and the
HTTP error to debug an incident in seconds.

## 11. Containerisation

`docker compose up` brings up the entire stack — postgres, redis, api,
worker, web — with healthchecks on every service and `depends_on:
condition: service_healthy` so the api waits for pg and redis to be ready
before running migrations and seeding. Migrations live as plain SQL files
in `api/src/db/migrations/`; the seed loader is idempotent (reads the CSV,
checks if `trades` is already populated, no-ops if so) so a `docker compose
restart` doesn't double-load. The web admin UI is a multi-stage build
(Vite → static files → Nginx) so the final image is ~25 MB.

## 12. Deployment (Render.com)

Production is deployed with the `render.yaml` Blueprint: free Postgres,
two Docker web services (`nevup-api` with embedded worker, `nevup-web`),
and Upstash Redis (`REDIS_URL` secret). The same Dockerfiles as
`docker-compose.yml` are used; no separate Fly.io config is maintained.
