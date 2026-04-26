FROM node:20-alpine

WORKDIR /app

COPY worker/package.json worker/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY worker/src ./src

ENV NODE_ENV=production

CMD ["node", "src/index.js"]
