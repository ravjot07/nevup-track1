# Build context for this Dockerfile is the repo root (see docker-compose.yml
# and fly/api.toml), not the api/ folder. That way we can COPY the canonical
# OpenAPI spec and the seed CSV into the image without any volume gymnastics
# and the same image runs identically on Compose, Fly, or any other runtime.
FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache wget

COPY api/package.json api/package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY api/src ./src
COPY api/test ./test

# The worker source is also baked into the API image so the API can run
# the metric loop in-process when EMBED_WORKER=true (used on free-tier
# hosts like Render where background workers cost extra). The standalone
# worker container (worker/Dockerfile) still works locally via Compose.
COPY worker/src ./worker/src

COPY nevup_openapi.yaml /app/nevup_openapi.yaml
COPY nevup_seed_dataset.csv /app/nevup_seed_dataset.csv

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/server.js"]
