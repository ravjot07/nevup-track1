import { pool } from '../db/pool.js';
import { queueLag } from '../queue/producer.js';

export default async function healthRoutes(app) {
  app.get(
    '/health',
    { config: { public: true } },
    async (req, reply) => {
      const result = {
        status: 'ok',
        dbConnection: 'connected',
        queueLag: 0,
        timestamp: new Date().toISOString(),
      };
      let degraded = false;

      try {
        const t0 = Date.now();
        await pool.query('SELECT 1');
        result.dbLatencyMs = Date.now() - t0;
      } catch (err) {
        req.log.warn({ err }, 'db health probe failed');
        result.dbConnection = 'disconnected';
        degraded = true;
      }

      try {
        result.queueLag = await queueLag();
      } catch (err) {
        req.log.warn({ err }, 'queue health probe failed');
        result.queueLag = -1;
        degraded = true;
      }

      result.status = degraded ? 'degraded' : 'ok';
      return reply.code(degraded ? 503 : 200).send(result);
    }
  );
}
