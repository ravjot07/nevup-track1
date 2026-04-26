import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { htmlReport } from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const SECRET =
  __ENV.JWT_SECRET ||
  '97791d4db2aa5f689c3cc39356ce35762f0a73aa70923039d8ef72a2840a1b02';

const SEED_USERS = [
  ['f412f236-4edc-47a2-8f54-8763a6ed2ce8', 'Alex Mercer'],
  ['fcd434aa-2201-4060-aeb2-f44c77aa0683', 'Jordan Lee'],
  ['84a6a3dd-f2d0-4167-960b-7319a6033d49', 'Sam Rivera'],
  ['4f2f0816-f350-4684-b6c3-29bbddbb1869', 'Casey Kim'],
  ['75076413-e8e8-44ac-861f-c7acb3902d6d', 'Morgan Bell'],
  ['8effb0f2-f16b-4b5f-87ab-7ffca376f309', 'Taylor Grant'],
  ['50dd1053-73b0-43c5-8d0f-d2af88c01451', 'Riley Stone'],
  ['af2cfc5e-c132-4989-9c12-2913f89271fb', 'Drew Patel'],
  ['9419073a-3d58-4ee6-a917-be2d40aecef2', 'Quinn Torres'],
  ['e84ea28c-e5a7-49ef-ac26-a873e32667bd', 'Avery Chen'],
];

const writeLatency = new Trend('trade_write_latency', true);
const idempotentHits = new Counter('idempotent_hits');

function b64url(input) {
  return encoding
    .b64encode(typeof input === 'string' ? input : JSON.stringify(input))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function signJwt(sub, name) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({ sub, iat: now, exp: now + 3600, role: 'trader', name })
  );
  const sig = crypto
    .hmac('sha256', SECRET, `${header}.${payload}`, 'base64rawurl');
  return `${header}.${payload}.${sig}`;
}

export const options = {
  scenarios: {
    closed_trades: {
      executor: 'constant-arrival-rate',
      rate: 200,
      timeUnit: '1s',
      duration: '60s',
      preAllocatedVUs: 80,
      maxVUs: 200,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<150'],
    trade_write_latency: ['p(95)<150'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const tokens = {};
function tokenFor(sub, name) {
  if (!tokens[sub]) tokens[sub] = signJwt(sub, name);
  return tokens[sub];
}

export default function () {
  const [userId, name] = SEED_USERS[Math.floor(Math.random() * SEED_USERS.length)];
  const token = tokenFor(userId, name);

  const tradeId = uuidv4();
  const sessionId = uuidv4();
  const entry = 100 + Math.random() * 50;
  const exit = entry + (Math.random() - 0.5) * 5;
  const direction = Math.random() < 0.5 ? 'long' : 'short';
  const emotions = ['calm', 'anxious', 'greedy', 'fearful', 'neutral'];
  const assets = ['AAPL', 'MSFT', 'NVDA', 'BTC/USD', 'ETH/USD', 'EUR/USD'];
  const classes = { AAPL: 'equity', MSFT: 'equity', NVDA: 'equity', 'BTC/USD': 'crypto', 'ETH/USD': 'crypto', 'EUR/USD': 'forex' };
  const asset = assets[Math.floor(Math.random() * assets.length)];

  const now = new Date();
  const entryAt = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  const exitAt = now.toISOString();

  const body = JSON.stringify({
    tradeId,
    userId,
    sessionId,
    asset,
    assetClass: classes[asset],
    direction,
    entryPrice: +entry.toFixed(4),
    exitPrice: +exit.toFixed(4),
    quantity: 10,
    entryAt,
    exitAt,
    status: 'closed',
    planAdherence: 1 + Math.floor(Math.random() * 5),
    emotionalState: emotions[Math.floor(Math.random() * emotions.length)],
    entryRationale: 'load test',
  });

  const t0 = Date.now();
  const res = http.post(`${BASE_URL}/trades`, body, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    timeout: '5s',
  });
  writeLatency.add(Date.now() - t0);

  check(res, {
    'status is 200': (r) => r.status === 200,
    'has tradeId': (r) => {
      try {
        return JSON.parse(r.body).tradeId === tradeId;
      } catch {
        return false;
      }
    },
  });
}

export function handleSummary(data) {
  const summary = {
    'load/results/summary.json': JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
  if (__ENV.K6_REPORT) {
    summary[__ENV.K6_REPORT] = htmlReport(data);
  } else {
    summary['load/results/report.html'] = htmlReport(data);
  }
  return summary;
}
