import jwt from 'jsonwebtoken';
import { errorBody, Forbidden, Unauthorized } from '../lib/errors.js';

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  throw new Error('JWT_SECRET is required');
}

/**
 * Verify the bearer token and attach req.user = { sub, role, name, iat, exp }.
 * Public routes register `config.public = true` to skip this hook.
 */
export function authPlugin(app) {
  app.addHook('onRequest', async (req, reply) => {
    if (req.routeOptions?.config?.public) return;

    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return reply
        .code(401)
        .send(errorBody('UNAUTHORIZED', 'Missing Authorization header.', req.id));
    }
    const token = auth.slice(7).trim();

    try {
      const decoded = jwt.verify(token, SECRET, {
        algorithms: ['HS256'],
        clockTolerance: 0,
      });
      if (!decoded.sub || !decoded.role) {
        return reply
          .code(401)
          .send(errorBody('UNAUTHORIZED', 'Token missing required claims.', req.id));
      }
      req.user = decoded;
    } catch (err) {
      const message =
        err.name === 'TokenExpiredError' ? 'Token expired.' : 'Invalid token.';
      return reply.code(401).send(errorBody('UNAUTHORIZED', message, req.id));
    }
  });

  /**
   * Tenancy guard. Pass the userId resolved from the request — typically
   * req.params.userId, but for /trades it's the body's userId.
   *
   * Returns true if access is allowed; otherwise sends 403 and returns false.
   */
  app.decorateRequest('assertTenant', null);
  app.addHook('preHandler', async (req) => {
    req.assertTenant = (resourceUserId, reply) => {
      if (!req.user) {
        reply.code(401).send(errorBody('UNAUTHORIZED', 'Auth required.', req.id));
        return false;
      }
      if (resourceUserId && resourceUserId !== req.user.sub) {
        reply
          .code(403)
          .send(errorBody('FORBIDDEN', 'Cross-tenant access denied.', req.id));
        return false;
      }
      return true;
    };
  });
}

/**
 * Convenience for tests + the admin UI's "mint dev token" button.
 */
export function signDevToken(userId, name = 'Dev User', ttlSeconds = 86400) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { sub: userId, iat: now, exp: now + ttlSeconds, role: 'trader', name },
    SECRET,
    { algorithm: 'HS256' }
  );
}
