// Smoke + correctness tests. Run via `npm test` from inside the api container
// (it has DATABASE_URL and REDIS_URL wired up). Reviewer command:
//
//   docker compose exec api npm test
//
// The tests use Fastify's in-process inject(); no network listener is needed.
//
// All tests are idempotent against the seeded dataset — they POST trades with
// fresh UUIDs and never delete existing ones.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';

import { runMigrations } from '../src/db/migrate.js';
import { seedFromCsv } from '../src/db/seed.js';
import { ensureConsumerGroup, getRedis } from '../src/queue/producer.js';
import { buildApp } from '../src/server.js';
import { pool } from '../src/db/pool.js';

const SECRET = process.env.JWT_SECRET;

const ALEX = 'f412f236-4edc-47a2-8f54-8763a6ed2ce8';
const JORDAN = 'fcd434aa-2201-4060-aeb2-f44c77aa0683';

function tokenFor(sub, opts = {}) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      sub,
      iat: now,
      exp: opts.expired ? now - 60 : now + 3600,
      role: 'trader',
      name: 'Test Trader',
    },
    SECRET,
    { algorithm: 'HS256' }
  );
}

let app;

before(async () => {
  await runMigrations();
  await seedFromCsv();
  await ensureConsumerGroup();
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app.close();
  await pool.end();
  try {
    await getRedis().quit();
  } catch {
    // ignore — best-effort shutdown
  }
});

test('GET /health is public and returns 200', async () => {
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.dbConnection, 'connected');
  assert.equal(typeof body.queueLag, 'number');
});

test('protected route without Authorization → 401 with traceId', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/users/${ALEX}/metrics?from=2025-01-01T00:00:00Z&to=2025-12-31T23:59:59Z&granularity=daily`,
  });
  assert.equal(res.statusCode, 401);
  const body = res.json();
  assert.equal(body.error, 'UNAUTHORIZED');
  assert.ok(body.traceId, 'traceId must be present');
});

test('malformed token → 401', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/users/${ALEX}/metrics?from=2025-01-01T00:00:00Z&to=2025-12-31T23:59:59Z&granularity=daily`,
    headers: { authorization: 'Bearer not-a-jwt' },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'UNAUTHORIZED');
});

test('expired token → 401', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/users/${ALEX}/metrics?from=2025-01-01T00:00:00Z&to=2025-12-31T23:59:59Z&granularity=daily`,
    headers: { authorization: `Bearer ${tokenFor(ALEX, { expired: true })}` },
  });
  assert.equal(res.statusCode, 401);
});

test('cross-tenant read → 403 (NOT 404)', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/users/${JORDAN}/metrics?from=2025-01-01T00:00:00Z&to=2025-12-31T23:59:59Z&granularity=daily`,
    headers: { authorization: `Bearer ${tokenFor(ALEX)}` },
  });
  assert.equal(res.statusCode, 403, 'cross-tenant must be 403, never 404');
  const body = res.json();
  assert.equal(body.error, 'FORBIDDEN');
  assert.ok(body.traceId);
});

test('cross-tenant POST /trades → 403 when body.userId != jwt.sub', async () => {
  const tradeId = randomUUID();
  const res = await app.inject({
    method: 'POST',
    url: '/trades',
    headers: {
      authorization: `Bearer ${tokenFor(ALEX)}`,
      'content-type': 'application/json',
    },
    payload: {
      tradeId,
      userId: JORDAN,
      sessionId: randomUUID(),
      asset: 'AAPL',
      assetClass: 'equity',
      direction: 'long',
      entryPrice: 100,
      quantity: 10,
      entryAt: '2025-04-01T09:00:00Z',
      status: 'open',
    },
  });
  assert.equal(res.statusCode, 403);
});

test('GET /users/:id/metrics returns the requested granularity', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/users/${ALEX}/metrics?from=2025-01-01T00:00:00Z&to=2025-12-31T23:59:59Z&granularity=daily`,
    headers: { authorization: `Bearer ${tokenFor(ALEX)}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.granularity, 'daily');
  assert.equal(body.userId, ALEX);
  assert.ok(Array.isArray(body.timeseries));
  assert.ok(body.winRateByEmotionalState);
});

test('POST /trades is idempotent on tradeId — same body twice returns same record', async () => {
  const tradeId = randomUUID();
  const sessionId = randomUUID();
  const payload = {
    tradeId,
    userId: ALEX,
    sessionId,
    asset: 'AAPL',
    assetClass: 'equity',
    direction: 'long',
    entryPrice: 178.45,
    exitPrice: 182.3,
    quantity: 10,
    entryAt: '2025-04-01T09:35:00Z',
    exitAt: '2025-04-01T11:20:00Z',
    status: 'closed',
    planAdherence: 4,
    emotionalState: 'calm',
    entryRationale: 'Idempotency test',
  };

  const r1 = await app.inject({
    method: 'POST',
    url: '/trades',
    headers: {
      authorization: `Bearer ${tokenFor(ALEX)}`,
      'content-type': 'application/json',
    },
    payload,
  });
  assert.equal(r1.statusCode, 200, 'first POST must be 200');
  const b1 = r1.json();
  assert.equal(b1.tradeId, tradeId);

  const r2 = await app.inject({
    method: 'POST',
    url: '/trades',
    headers: {
      authorization: `Bearer ${tokenFor(ALEX)}`,
      'content-type': 'application/json',
    },
    payload,
  });
  assert.equal(r2.statusCode, 200, 'duplicate POST must be 200, not 409 or 500');
  const b2 = r2.json();
  assert.equal(b2.tradeId, tradeId);
  assert.equal(b2.createdAt, b1.createdAt, 'createdAt must be stable across duplicate POSTs');
});

test('POST /trades with bad enum → 400 with traceId', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/trades',
    headers: {
      authorization: `Bearer ${tokenFor(ALEX)}`,
      'content-type': 'application/json',
    },
    payload: {
      tradeId: randomUUID(),
      userId: ALEX,
      sessionId: randomUUID(),
      asset: 'AAPL',
      assetClass: 'invalid',
      direction: 'long',
      entryPrice: 100,
      quantity: 1,
      entryAt: '2025-04-01T09:00:00Z',
      status: 'open',
    },
  });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.error, 'BAD_REQUEST');
  assert.ok(body.traceId);
});

test('GET /sessions/:id returns full trade list and 403s cross-tenant', async () => {
  // Pick an existing seeded session for Alex
  const r = await pool.query(
    `SELECT id FROM sessions WHERE user_id = $1 LIMIT 1`,
    [ALEX]
  );
  const sessionId = r.rows[0].id;

  const ok = await app.inject({
    method: 'GET',
    url: `/sessions/${sessionId}`,
    headers: { authorization: `Bearer ${tokenFor(ALEX)}` },
  });
  assert.equal(ok.statusCode, 200);
  const body = ok.json();
  assert.ok(Array.isArray(body.trades));
  assert.ok(body.trades.length > 0);

  const forbidden = await app.inject({
    method: 'GET',
    url: `/sessions/${sessionId}`,
    headers: { authorization: `Bearer ${tokenFor(JORDAN)}` },
  });
  assert.equal(forbidden.statusCode, 403);
});
