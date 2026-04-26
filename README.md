# NevUp Hackathon 2026 — Track 1: System of Record

A real-time trade-journal engine with an asynchronous behavioural-analytics
pipeline. JWT row-level multi-tenancy, idempotent writes, p95 ≤ 5 ms at
200 RPS, structured JSON logs, single-command Docker bring-up.

> **Architectural rationale:** see [`DECISIONS.md`](./DECISIONS.md).
> **EXPLAIN plans:** see [`docs/explain-plans.md`](./docs/explain-plans.md).
> **Load test report:** open [`load/results/report.html`](./load/results/report.html).
> **Wire contract:** [`nevup_openapi.yaml`](./nevup_openapi.yaml) (canonical, unmodified).

---

## Quick start — one command

```bash
docker compose up --build
```

That brings up:

| Service   | URL                         | Purpose                              |
|-----------|-----------------------------|--------------------------------------|
| `api`     | http://localhost:3000       | Fastify API (the System of Record)   |
| `worker`  | (no port)                   | Redis Streams consumer, metrics      |
| `web`     | http://localhost:8080       | React + Tailwind admin dashboard     |
| `postgres`| `localhost:5432`            | trade journal + aggregate tables     |
| `redis`   | `localhost:6379`            | event bus (`nevup:events` stream)    |

The API runs migrations and seeds `nevup_seed_dataset.csv` on first boot
(388 trades, 52 sessions, 10 traders). The seed loader is idempotent — a
`docker compose restart` will not double-load.

Health check:

```bash
curl -s http://localhost:3000/health | jq
# {
#   "status": "ok",
#   "dbConnection": "connected",
#   "queueLag": 0,
#   "timestamp": "...",
#   "dbLatencyMs": 1
# }
```

---

## Auth — the kickoff JWT

All endpoints except `/health` require `Authorization: Bearer <jwt>`. The
shared HS256 secret is the canonical kickoff value:

```
97791d4db2aa5f689c3cc39356ce35762f0a73aa70923039d8ef72a2840a1b02
```

**Mint a token for any seed user:**

```bash
docker compose exec api node /app/src/../../scripts/mint-token.js \
  f412f236-4edc-47a2-8f54-8763a6ed2ce8

# or from the host (no Docker required):
node scripts/mint-token.js fcd434aa-2201-4060-aeb2-f44c77aa0683
```

Or use the **admin UI** at http://localhost:8080 — pick a trader from the
dropdown and click "Mint dev token".

### Row-level tenancy rule

`jwt.sub` must equal the `userId` referenced by the request. Any mismatch
returns **HTTP 403** (never 404). Proven in `api/test/api.test.js`.

---

## Curl tour

Set a token first:

```bash
TOKEN=$(node scripts/mint-token.js fcd434aa-2201-4060-aeb2-f44c77aa0683)
USER=fcd434aa-2201-4060-aeb2-f44c77aa0683
```

### POST /trades — idempotent on `tradeId`

```bash
TID=$(uuidgen | tr A-Z a-z)
SID=$(uuidgen | tr A-Z a-z)
curl -s -X POST http://localhost:3000/trades \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"tradeId\":\"$TID\",
    \"userId\":\"$USER\",
    \"sessionId\":\"$SID\",
    \"asset\":\"NVDA\",\"assetClass\":\"equity\",\"direction\":\"long\",
    \"entryPrice\":120.5,\"exitPrice\":121.7,\"quantity\":10,
    \"entryAt\":\"2026-04-26T15:00:00Z\",\"exitAt\":\"2026-04-26T15:14:00Z\",
    \"status\":\"closed\",\"planAdherence\":4,\"emotionalState\":\"calm\",
    \"entryRationale\":\"breakout above resistance\"
  }" | jq

# Send the exact same body again — same 200, same record (idempotent):
curl -s -X POST http://localhost:3000/trades \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{...same body...}" | jq
```

### GET /users/:id/metrics — pre-aggregated read path

```bash
curl -s "http://localhost:3000/users/$USER/metrics?from=2026-01-01&to=2026-04-30&granularity=daily" \
  -H "Authorization: Bearer $TOKEN" | jq
```

Available granularities: `hourly | daily | rolling30d`. Includes
`planAdherenceScore`, `winRateByEmotionalState`, `sessionTiltIndex`, plus
the timeseries for the requested bucket size.

### GET /sessions/:id — full trade list

```bash
SESSION_ID=<one of the seed session ids>
curl -s "http://localhost:3000/sessions/$SESSION_ID" \
  -H "Authorization: Bearer $TOKEN" | jq
```

### POST /sessions/:id/debrief — post-session reflection

```bash
curl -s -X POST "http://localhost:3000/sessions/$SESSION_ID/debrief" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "userId":"'"$USER"'",
    "emotionalReview":"calmer than last session",
    "lessonsLearned":"smaller size on choppy days",
    "planAdherenceSelf":4,
    "keyTakeaway":"trust the plan"
  }' | jq
```

### Cross-tenant attempt → 403

```bash
ALEX=$(node scripts/mint-token.js f412f236-4edc-47a2-8f54-8763a6ed2ce8)
JORDAN=fcd434aa-2201-4060-aeb2-f44c77aa0683
curl -s -o /dev/null -w "%{http_code}\n" \
  "http://localhost:3000/users/$JORDAN/metrics" \
  -H "Authorization: Bearer $ALEX"
# 403
```

---

## Behavioural metrics — all five computed off the write path

| # | Metric                        | Where it lives                                                    |
|---|-------------------------------|--------------------------------------------------------------------|
| 1 | Plan Adherence (rolling 10)   | `worker/src/metrics/planAdherence.js` → `plan_adherence_rolling`  |
| 2 | Revenge Trade Flag            | `worker/src/metrics/revengeFlag.js` → `trades.revenge_flag`       |
| 3 | Session Tilt Index            | `worker/src/metrics/sessionTilt.js` → `session_tilt`              |
| 4 | Win Rate by Emotional State   | `worker/src/metrics/winRateByEmotion.js` → `winrate_by_emotion`   |
| 5 | Overtrading Detector          | `worker/src/metrics/overtrading.js` → `overtrading_events` + event |

The worker subscribes to the `nevup:events` Redis Stream as the
`metrics-workers` consumer group. Each `trade.closed` event is processed in
a single Postgres transaction so the five aggregate tables are mutually
consistent. Producer-side, `POST /trades` only `XADD`s on the **first**
insert of a closed trade — duplicate-tradeId calls do not re-fire metrics.

---

## Tests

```bash
# from inside the api container (uses the live pg + redis):
docker compose exec api npm test

# or from the host (faster feedback during dev):
DATABASE_URL=postgres://nevup:nevup@localhost:5432/nevup \
REDIS_URL=redis://localhost:6379 \
JWT_SECRET=97791d4db2aa5f689c3cc39356ce35762f0a73aa70923039d8ef72a2840a1b02 \
LOG_LEVEL=warn API_PORT=3001 RUN_MIGRATIONS=false RUN_SEED=false \
node --test api/test/
```

Coverage of the spec's hard auth/idempotency requirements:

```
✓ GET /health is public and returns 200
✓ protected route without Authorization → 401 with traceId
✓ malformed token → 401
✓ expired token → 401
✓ cross-tenant read → 403 (NOT 404)
✓ cross-tenant POST /trades → 403 when body.userId != jwt.sub
✓ GET /users/:id/metrics returns the requested granularity
✓ POST /trades is idempotent on tradeId — same body twice returns same record
✓ POST /trades with bad enum → 400 with traceId
✓ GET /sessions/:id returns full trade list and 403s cross-tenant
```

---

## Load test

```bash
# install k6 once
sudo gpg -k && sudo gpg --no-default-keyring \
  --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 \
  --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install -y k6

# run
docker compose up -d
k6 run load/trades.k6.js
# → load/results/report.html, load/results/summary.json
```

**Latest run on this repo (60 s, constant-arrival-rate 200 req/s, cold-started stack with both API and worker active):**

```
http_reqs ............ 12000  (199.897 req/s)
http_req_duration ... avg=4.34ms p(95)=5.70ms p(99)=15.57ms max=205ms
http_req_failed ...... 0.00%   (0 failures / 12000)
checks ............... 100.00% ✓ 24000 / ✗ 0
```

p95 = **5.7ms** vs the 150ms target = ~26x headroom.

---

## Repo layout

```
nevup-track1/
├── api/                # Fastify HTTP service (the System of Record)
│   ├── src/
│   │   ├── auth/jwt.js
│   │   ├── db/{pool,migrate,seed}.js
│   │   ├── db/migrations/001_init.sql
│   │   ├── lib/{logger,errors}.js
│   │   ├── queue/producer.js
│   │   ├── routes/{health,trades,sessions,users}.js
│   │   └── server.js
│   ├── test/api.test.js
│   ├── Dockerfile
│   └── package.json
├── worker/             # Redis Streams consumer, metric pipeline
│   ├── src/
│   │   ├── metrics/{planAdherence,revengeFlag,sessionTilt,winRateByEmotion,overtrading}.js
│   │   ├── lib.js
│   │   └── index.js
│   ├── Dockerfile
│   └── package.json
├── web/                # React + Tailwind admin dashboard (Vite, Nginx)
│   ├── src/{App.jsx,api.js,components/*.jsx,...}
│   ├── Dockerfile
│   ├── nginx.conf.template
│   └── package.json
├── load/               # k6 script + HTML report
│   ├── trades.k6.js
│   └── results/{report.html,summary.json}
├── scripts/            # mint-token.js (host-side dev token util)
├── docs/               # EXPLAIN plans, runbook
├── fly/                # Fly.io deploy config (api/worker/web)
├── docker-compose.yml
├── nevup_openapi.yaml  # canonical contract (unmodified)
├── nevup_seed_dataset.csv
├── nevup_seed_dataset.json
├── DECISIONS.md
└── README.md
```

---

## Deployment

A live deployment URL is required for hackathon scoring. The same
`docker-compose.yml` runs on Fly.io as three Fly apps (`nevup-api`,
`nevup-worker`, `nevup-web`) backed by Fly Postgres + Upstash Redis. See
[`fly/README.md`](./fly/README.md) for the exact deploy commands.

---

## Submission checklist

- [ ] Live deployment URL — see [`fly/README.md`](./fly/README.md) for the
      one-shot Fly.io deploy. (Run `fly auth login && fly deploy …` once
      and paste the URL into this checklist before submitting.)
- [x] OpenAPI 3.0 spec — `nevup_openapi.yaml` (consumed verbatim, also
      served live at `GET /docs` and `GET /docs.json`)
- [x] k6 load script — `load/trades.k6.js`
- [x] HTML load report — `load/results/report.html`
- [x] DECISIONS.md — yes
- [x] `docker compose up` — single command, no manual steps
- [x] Idempotent POST /trades — proven by automated test
- [x] 200 RPS, p95 ≤ 150ms — proven (5.7ms — see `load/results/summary.json`)
- [x] Async metrics pipeline — Redis Streams + dedicated worker
- [x] Multi-tenancy auth — JWT HS256 + 403 on `sub` mismatch
- [x] Structured JSON logs with `traceId`, `userId`, `latency`, `statusCode`
- [x] `/health` with queue lag + DB connection state
