# Render.com deploy — NevUp Track 1

The Render free tier ships everything we need for the hackathon submission
**without a credit card**:

| Component | Render plan | Notes |
|---|---|---|
| API + embedded worker | Free Web Service (Docker) | Sleeps after 15 min idle, ~30s cold-start |
| Admin UI (Nginx) | Free Web Service (Docker) | Same sleep behaviour |
| PostgreSQL 16 | Free Postgres | 90-day trial, then dropped |
| Redis 7 (Streams) | **Upstash** free tier (separate provider) | Render Key Value isn't reliable on free tier |

The metric pipeline is unchanged — `XADD` from the API, `XREADGROUP` from
the embedded worker. The async-vs-sync property is the same; only the OS
process boundary collapses (`EMBED_WORKER=true`). The standalone
`worker/` container still works locally via `docker compose up`.

---

## Step 1 — push the repo to GitHub

```bash
cd /path/to/nevup-track1
git init
git add -A
git commit -m "NevUp Track 1 — System of Record"
gh repo create nevup-track1 --public --source=. --push
# or: create the repo on github.com and `git push -u origin main`
```

## Step 2 — provision Upstash Redis (free, no card)

1. https://console.upstash.com/login → sign in with GitHub.
2. **Create Database** → name `nevup-redis` → region close to Render's
   Oregon (e.g. `us-west-1`) → free plan → **Create**.
3. On the database page, copy the **Redis URL** under "Connect to your
   database" → "TLS" → it looks like `rediss://default:<token>@<host>:<port>`.

## Step 3 — connect Render to the GitHub repo

1. https://dashboard.render.com → **New +** → **Blueprint**.
2. Connect your GitHub account if you haven't, pick the `nevup-track1`
   repo, and click **Apply**. Render reads `render.yaml` and previews
   three resources: `nevup-api`, `nevup-web`, `nevup-pg`.
3. **Important** — before the first deploy completes, set the manual
   secrets:
   - On `nevup-api` → **Environment** → set `REDIS_URL` to the Upstash
     URL from Step 2.
4. Render will then build and deploy. The first build takes ~5 min
   (Docker layer cache is cold).

## Step 4 — verify the live API

Render assigns predictable URLs based on service name:

```bash
LIVE=https://nevup-api.onrender.com   # may differ if Render appended a hash
curl -s $LIVE/health | jq
# {
#   "status": "ok",
#   "dbConnection": "connected",
#   "queueLag": 0,
#   ...
# }
```

If `/health` returns a 502 or hangs, the dyno is asleep — give it ~30s and
retry. Subsequent requests within 15 min are warm.

```bash
# Smoke-test row-level auth on the live URL
TOKEN=$(node scripts/mint-token.js fcd434aa-2201-4060-aeb2-f44c77aa0683)

curl -s "$LIVE/users/fcd434aa-2201-4060-aeb2-f44c77aa0683/metrics?from=2025-01-01&to=2025-03-01&granularity=daily" \
  -H "Authorization: Bearer $TOKEN" | jq

# Cross-tenant 403
ALEX=$(node scripts/mint-token.js f412f236-4edc-47a2-8f54-8763a6ed2ce8)
curl -s -o /dev/null -w "%{http_code}\n" \
  "$LIVE/users/fcd434aa-2201-4060-aeb2-f44c77aa0683/metrics?from=2025-01-01&to=2025-03-01&granularity=daily" \
  -H "Authorization: Bearer $ALEX"
# → 403
```

## Step 5 — verify the admin UI

The web service auto-derives the API URL from its own hostname (see
`web/src/api.js`), so `https://nevup-web.onrender.com` will call
`https://nevup-api.onrender.com` out of the box.

Visit `https://nevup-web.onrender.com` in a browser, pick a trader from the
dropdown, click **Mint dev token**, and metrics should populate.

## Submission

Paste the live URL into the form and into the Submission Checklist in
[`README.md`](./README.md):

```
- [x] Live deployment URL — https://nevup-api.onrender.com
```

---

## Troubleshooting

**"DATABASE_URL not set"** — Render injects it automatically from the
`fromDatabase` block in `render.yaml`. If missing, on the dashboard:
`nevup-api` → Environment → confirm `DATABASE_URL` is bound.

**Seed didn't run** — check the API service's Logs tab in Render. The
boot sequence logs `running migrations`, `seeding db (idempotent)`,
`seed complete`, `API listening`. If you see the seed step skipped on a
fresh DB, redeploy with `RUN_MIGRATIONS=true` and `RUN_SEED=true`.

**Worker not consuming events** — confirm `EMBED_WORKER=true` is in the
API env vars. The startup log line is `starting embedded worker loop`.
You can also probe Upstash console → Data Browser → `XLEN nevup:events`.

**Port mismatch** — Render injects its own `PORT` env var. Our server
reads `API_PORT` (default 3000). Render's free Docker plan accepts the
3000 default; override with `API_PORT=$PORT` if you ever see binding
errors.

**Free tier sleep** — first request after 15 min idle wakes the dyno
(~30s). Hit `/health` once to warm it before judging starts.

**Free Postgres expiry** — the free Postgres is dropped 90 days after
creation. Set a calendar reminder if you need it for longer than the
hackathon window.
