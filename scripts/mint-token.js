#!/usr/bin/env node
/**
 * Mint a 24h JWT for any seeded userId.
 *
 *   node scripts/mint-token.js f412f236-4edc-47a2-8f54-8763a6ed2ce8
 *
 * Uses the canonical kickoff secret. Override with JWT_SECRET if needed.
 */
import crypto from 'node:crypto';

const SECRET =
  process.env.JWT_SECRET ||
  '97791d4db2aa5f689c3cc39356ce35762f0a73aa70923039d8ef72a2840a1b02';

const userId = process.argv[2];
const name = process.argv[3] || 'Dev User';
if (!userId) {
  console.error('Usage: node scripts/mint-token.js <userId> [name]');
  process.exit(1);
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

const now = Math.floor(Date.now() / 1000);
const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const payload = b64url(
  JSON.stringify({ sub: userId, iat: now, exp: now + 86400, role: 'trader', name })
);
const sig = b64url(
  crypto.createHmac('sha256', SECRET).update(`${header}.${payload}`).digest()
);
console.log(`${header}.${payload}.${sig}`);
