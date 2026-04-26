import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import yaml from 'yaml';

import { logger } from './lib/logger.js';
import { errorBody } from './lib/errors.js';
import { authPlugin, signDevToken } from './auth/jwt.js';
import { runMigrations } from './db/migrate.js';
import { seedFromCsv } from './db/seed.js';
import { ensureConsumerGroup, getRedis } from './queue/producer.js';
import { pool } from './db/pool.js';

import healthRoutes from './routes/health.js';
import tradeRoutes from './routes/trades.js';
import sessionRoutes from './routes/sessions.js';
import userRoutes from './routes/users.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp() {
  const app = Fastify({
    logger,
    genReqId: () => randomUUID(),
    requestIdHeader: 'x-trace-id',
    requestIdLogLabel: 'traceId',
    // We emit our own structured one-line-per-request log in the onResponse
    // hook below (matches the spec's traceId/userId/latency/statusCode shape).
    // Letting Fastify also log req/res automatically would mean 3 records per
    // request — measurably costly at the 200 RPS load-test target.
    disableRequestLogging: true,
    bodyLimit: 1024 * 256,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });

  await app.register(cors, {
    origin: true,
    credentials: false,
    exposedHeaders: ['x-trace-id'],
  });

  // Per-request structured log: traceId, userId, latency, statusCode.
  app.addHook('onResponse', (req, reply, done) => {
    req.log.info(
      {
        traceId: req.id,
        userId: req.user?.sub || null,
        method: req.method,
        url: req.url,
        statusCode: reply.statusCode,
        latency: reply.elapsedTime,
      },
      'request'
    );
    done();
  });

  // Echo trace id on every response — error or success.
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-trace-id', req.id);
  });

  // Validation errors → 400 with envelope
  app.setErrorHandler((err, req, reply) => {
    if (err.validation) {
      return reply
        .code(400)
        .send(errorBody('BAD_REQUEST', err.message, req.id));
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply
        .code(err.statusCode)
        .send(errorBody(err.code || 'CLIENT_ERROR', err.message, req.id));
    }
    req.log.error({ err }, 'unhandled error');
    return reply
      .code(500)
      .send(errorBody('INTERNAL_ERROR', 'Internal server error.', req.id));
  });

  app.setNotFoundHandler((req, reply) => {
    reply
      .code(404)
      .send(errorBody('NOT_FOUND', `Route ${req.method} ${req.url} not found.`, req.id));
  });

  authPlugin(app);

  // ── Public routes ──
  app.register(healthRoutes);

  // /docs serves the OpenAPI YAML used as the contract.
  app.get(
    '/docs',
    { config: { public: true } },
    async (req, reply) => {
      const candidates = [
        '/app/nevup_openapi.yaml',
        path.resolve(__dirname, '../../nevup_openapi.yaml'),
        path.resolve(process.cwd(), 'nevup_openapi.yaml'),
      ];
      for (const p of candidates) {
        try {
          const buf = await fs.readFile(p, 'utf8');
          reply.type('application/yaml');
          return buf;
        } catch {
          // try next
        }
      }
      return reply
        .code(404)
        .send(errorBody('NOT_FOUND', 'OpenAPI spec not found.', req.id));
    }
  );

  // /docs.json — same spec but JSON (some clients prefer it)
  app.get(
    '/docs.json',
    { config: { public: true } },
    async (req, reply) => {
      const candidates = [
        '/app/nevup_openapi.yaml',
        path.resolve(__dirname, '../../nevup_openapi.yaml'),
        path.resolve(process.cwd(), 'nevup_openapi.yaml'),
      ];
      for (const p of candidates) {
        try {
          const buf = await fs.readFile(p, 'utf8');
          return yaml.parse(buf);
        } catch {
          // try next
        }
      }
      return reply
        .code(404)
        .send(errorBody('NOT_FOUND', 'OpenAPI spec not found.', req.id));
    }
  );

  // Dev-only token mint for the admin UI / curl examples.
  // Public route — purely a developer convenience. Returns a 24h trader token.
  app.get(
    '/auth/dev-token/:userId',
    { config: { public: true } },
    async (req, reply) => {
      const { userId } = req.params;
      const userRes = await pool.query(
        'SELECT id, name FROM users WHERE id = $1',
        [userId]
      );
      const name = userRes.rows[0]?.name || 'Dev User';
      const token = signDevToken(userId, name);
      return reply.send({ token, userId, name });
    }
  );

  app.get(
    '/auth/users',
    { config: { public: true } },
    async () => {
      const r = await pool.query('SELECT id, name FROM users ORDER BY name');
      return { users: r.rows };
    }
  );

  // ── Protected routes ──
  app.register(tradeRoutes);
  app.register(sessionRoutes);
  app.register(userRoutes);

  return app;
}

export async function start() {
  if (process.env.RUN_MIGRATIONS !== 'false') {
    logger.info('running migrations');
    await runMigrations();
  }
  if (process.env.RUN_SEED !== 'false') {
    logger.info('seeding db (idempotent)');
    await seedFromCsv();
  }

  // Log a redacted form of REDIS_URL at boot so deploy logs immediately
  // show *which* Redis we're talking to and over which scheme. Saves a
  // round-trip with reviewers when a wrong env var is the problem.
  if (process.env.REDIS_URL) {
    try {
      const u = new URL(process.env.REDIS_URL);
      logger.info(
        { host: u.hostname, port: u.port, scheme: u.protocol.replace(':', '') },
        'connecting to redis'
      );
    } catch {
      logger.warn('REDIS_URL is set but unparseable as a URL');
    }
  }

  await ensureConsumerGroup();

  const app = await buildApp();
  // Render (and most PaaS) inject PORT; honour it before our own
  // API_PORT default so the container Just Works on those hosts.
  const port = Number(process.env.PORT || process.env.API_PORT || 3000);
  await app.listen({ host: '0.0.0.0', port });
  logger.info({ port }, 'API listening');

  // Embedded worker mode for free-tier hosts (Render, Koyeb, etc.) where
  // running a separate worker container costs extra. The Redis Streams
  // bus is unchanged — XADD on the producer side, XREADGROUP on the
  // consumer side, just in the same Node process. The metric pipeline is
  // still asynchronous with respect to the HTTP write path.
  if (process.env.EMBED_WORKER === 'true') {
    logger.info('starting embedded worker loop');
    // From /app/src/server.js → ../worker/src/index.js = /app/worker/src/index.js,
    // matching the layout the API Dockerfile creates with COPY worker/src ./worker/src.
    const { consume } = await import('../worker/src/index.js');
    consume().catch((err) => {
      logger.error({ err }, 'embedded worker loop crashed');
    });
  }

  return app;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  start().catch((err) => {
    logger.fatal({ err }, 'startup failed');
    process.exit(1);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      logger.info({ sig }, 'shutting down');
      try {
        await pool.end();
        const r = getRedis();
        await r.quit();
      } catch (err) {
        logger.warn({ err }, 'shutdown cleanup error');
      }
      process.exit(0);
    });
  }
}
