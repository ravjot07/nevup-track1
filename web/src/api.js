function resolveBase() {
  const fromBuild = import.meta.env.VITE_API_BASE_URL || '';
  if (typeof window !== 'undefined' && window.location?.host) {
    const { protocol, host, hostname } = window.location;
    if (host.endsWith('.onrender.com')) {
      return `${protocol}//${host.replace('-web', '-api')}`;
    }
    if (host.endsWith('.fly.dev') && host.includes('-web')) {
      return `${protocol}//${host.replace('-web', '-api')}`;
    }
    const pointsAtLoopback =
      /localhost|127\.0\.0\.1/i.test(fromBuild) || fromBuild === '';
    if (
      pointsAtLoopback &&
      hostname &&
      hostname !== 'localhost' &&
      hostname !== '127.0.0.1'
    ) {
      return `${protocol}//${hostname}:3000`;
    }
  }
  if (fromBuild) return fromBuild;
  return 'http://localhost:3000';
}

const BASE = resolveBase();

export function tokenKey(userId) {
  return `nevup.token.${userId}`;
}

export async function api(path, { token, ...opts } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  const traceId = res.headers.get('x-trace-id');
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const err = new Error(
      (body && body.message) || `HTTP ${res.status}`
    );
    err.status = res.status;
    err.body = body;
    err.traceId = traceId;
    throw err;
  }
  return { body, traceId };
}

export async function listSeedUsers() {
  const r = await fetch(`${BASE}/auth/users`);
  if (!r.ok) throw new Error('failed to load seed users');
  return (await r.json()).users;
}

export async function mintDevToken(userId) {
  const r = await fetch(`${BASE}/auth/dev-token/${userId}`);
  if (!r.ok) throw new Error('failed to mint token');
  return (await r.json()).token;
}

export const baseUrl = BASE;
