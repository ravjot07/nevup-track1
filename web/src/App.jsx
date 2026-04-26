import { useEffect, useState } from 'react';
import { api, baseUrl, listSeedUsers, mintDevToken, tokenKey } from './api.js';
import HealthPanel from './components/HealthPanel.jsx';
import TradesTable from './components/TradesTable.jsx';
import MetricsView from './components/MetricsView.jsx';
import TokenBar from './components/TokenBar.jsx';

const RANGE_DEFAULT = {
  from: '2025-01-01T00:00:00Z',
  to: '2025-12-31T23:59:59Z',
  granularity: 'daily',
};

export default function App() {
  const [users, setUsers] = useState([]);
  const [activeUser, setActiveUser] = useState(null);
  const [token, setToken] = useState('');
  const [tokenError, setTokenError] = useState(null);
  const [metrics, setMetrics] = useState({ state: 'idle' });
  const [trades, setTrades] = useState({ state: 'idle' });
  const [range, setRange] = useState(RANGE_DEFAULT);

  useEffect(() => {
    listSeedUsers()
      .then((us) => {
        setUsers(us);
        if (us[0]) setActiveUser(us[0]);
      })
      .catch((err) => setTokenError(err.message));
  }, []);

  useEffect(() => {
    if (!activeUser) return;
    const cached = localStorage.getItem(tokenKey(activeUser.id));
    if (cached) {
      setToken(cached);
    } else {
      mintDevToken(activeUser.id)
        .then((t) => {
          localStorage.setItem(tokenKey(activeUser.id), t);
          setToken(t);
        })
        .catch((err) => setTokenError(err.message));
    }
  }, [activeUser]);

  useEffect(() => {
    if (!activeUser || !token) return;
    setMetrics({ state: 'loading' });
    api(
      `/users/${activeUser.id}/metrics?from=${range.from}&to=${range.to}&granularity=${range.granularity}`,
      { token }
    )
      .then(({ body }) => setMetrics({ state: 'ready', data: body }))
      .catch((err) => setMetrics({ state: 'error', error: err }));
  }, [activeUser, token, range]);

  useEffect(() => {
    if (!activeUser || !token) return;
    setTrades({ state: 'loading' });
    fetch(`${baseUrl}/sessions/${activeUser.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    fetch(`${baseUrl}/users/${activeUser.id}/profile`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .catch(() => null)
      .finally(() => setTrades({ state: 'idle' }));
  }, [activeUser, token]);

  return (
    <div className="min-h-full max-w-7xl mx-auto p-6 space-y-6">
      <header className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            NevUp <span className="text-emerald-400">System of Record</span>
          </h1>
          <p className="text-sm text-zinc-400">
            Track 1 admin dashboard — JWT row-level tenancy, idempotent writes,
            async behavioural metrics.
          </p>
        </div>
        <HealthPanel />
      </header>

      <TokenBar
        users={users}
        activeUser={activeUser}
        onSelect={(u) => setActiveUser(u)}
        token={token}
        onMint={async () => {
          if (!activeUser) return;
          const t = await mintDevToken(activeUser.id);
          localStorage.setItem(tokenKey(activeUser.id), t);
          setToken(t);
        }}
        tokenError={tokenError}
      />

      <MetricsView
        userId={activeUser?.id}
        metrics={metrics}
        range={range}
        onRangeChange={setRange}
      />

      <TradesTable userId={activeUser?.id} token={token} />
    </div>
  );
}
