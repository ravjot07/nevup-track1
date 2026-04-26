FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache wget

COPY api/package.json api/package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY api/src ./src
COPY api/test ./test

COPY worker/src ./worker/src

COPY nevup_openapi.yaml /app/nevup_openapi.yaml
COPY nevup_seed_dataset.csv /app/nevup_seed_dataset.csv

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/server.js"]
