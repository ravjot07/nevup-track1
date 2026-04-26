# Fly.io deploy — NevUp Track 1

Three Fly apps: `nevup-api`, `nevup-worker`, `nevup-web`. Backed by Fly
Postgres and Upstash Redis (which Fly provisions for you via
`fly redis create`).

## Pre-reqs

```bash
brew install flyctl   # or: curl -L https://fly.io/install.sh | sh
fly auth login
```

## One-time setup (Postgres + Redis)

```bash
# Postgres — Fly's managed offering
fly postgres create --name nevup-pg \
  --region iad --vm-size shared-cpu-1x --volume-size 1

# Redis — provisioned via Upstash, automatically peered with the Fly app
fly redis create --name nevup-redis --region iad
# capture the connection string for later:
REDIS_URL=$(fly redis status nevup-redis --json | jq -r .Url)
```

## Deploy the API

```bash
fly apps create nevup-api
fly postgres attach nevup-pg --app nevup-api      # sets DATABASE_URL secret

fly secrets set --app nevup-api \
  JWT_SECRET=97791d4db2aa5f689c3cc39356ce35762f0a73aa70923039d8ef72a2840a1b02 \
  REDIS_URL="$REDIS_URL"

# Build context is the repo root so the Dockerfile can COPY the OpenAPI
# yaml + seed CSV from sibling folders.
fly deploy --config fly/api.toml --dockerfile api/Dockerfile

# Verify
curl -s https://nevup-api.fly.dev/health | jq
```

The first boot will run the migrations + CSV seed against the freshly
created Fly Postgres. Subsequent deploys skip the seed (the loader is
idempotent — it checks if `trades` is non-empty and no-ops).

## Deploy the worker

```bash
fly apps create nevup-worker
fly secrets set --app nevup-worker \
  DATABASE_URL="$(fly secrets list --app nevup-api --json | jq -r '.[]|select(.Name=="DATABASE_URL").Value')" \
  REDIS_URL="$REDIS_URL"

fly deploy --config fly/worker.toml --dockerfile worker/Dockerfile
```

## Deploy the admin UI

```bash
fly apps create nevup-web
fly deploy --config fly/web.toml \
  --dockerfile web/Dockerfile \
  --build-arg VITE_API_BASE_URL=https://nevup-api.fly.dev
```

The dashboard then lives at `https://nevup-web.fly.dev`.

## End-to-end smoke test on the live URL

```bash
BASE=https://nevup-api.fly.dev
TOKEN=$(node scripts/mint-token.js fcd434aa-2201-4060-aeb2-f44c77aa0683)

curl -s "$BASE/health" | jq
curl -s "$BASE/users/fcd434aa-2201-4060-aeb2-f44c77aa0683/metrics?granularity=daily" \
  -H "Authorization: Bearer $TOKEN" | jq '.summary'
```

## Rollback

```bash
fly releases --app nevup-api
fly deploy --config fly/api.toml --image registry.fly.io/nevup-api:<previous-tag>
```
