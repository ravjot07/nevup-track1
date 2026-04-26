import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function TradesTable({ userId, token }) {
  const [profile, setProfile] = useState({ state: 'idle' });

  useEffect(() => {
    if (!userId || !token) return;
    setProfile({ state: 'loading' });
    api(`/users/${userId}/profile`, { token })
      .then(({ body }) => setProfile({ state: 'ready', data: body }))
      .catch((err) => setProfile({ state: 'error', error: err }));
  }, [userId, token]);

  if (!userId) return null;
  if (profile.state === 'loading') {
    return (
      <section className="card">
        <h2 className="text-lg font-semibold mb-3">Behavioural profile</h2>
        <p className="text-sm text-zinc-400">Loading…</p>
      </section>
    );
  }
  if (profile.state === 'error') {
    return (
      <section className="card">
        <h2 className="text-lg font-semibold mb-3">Behavioural profile</h2>
        <p className="text-sm text-red-400">
          {profile.error.status} — {profile.error.message}
        </p>
      </section>
    );
  }
  if (profile.state !== 'ready') return null;

  const p = profile.data;
  return (
    <section className="card space-y-3">
      <h2 className="text-lg font-semibold">Behavioural profile</h2>

      {p.peakPerformanceWindow && (
        <p className="text-sm text-zinc-300">
          Peak performance window:{' '}
          <span className="font-mono">
            {p.peakPerformanceWindow.startHour}:00 – {p.peakPerformanceWindow.endHour}:00 UTC
          </span>{' '}
          ·{' '}
          <span className="text-emerald-400 font-mono">
            {(p.peakPerformanceWindow.winRate * 100).toFixed(1)}% win rate
          </span>
        </p>
      )}

      {p.dominantPathologies?.length === 0 ? (
        <p className="text-sm text-emerald-400">
          No dominant behavioural pathology detected — control profile.
        </p>
      ) : (
        <ul className="divide-y divide-zinc-800">
          {p.dominantPathologies?.map((d) => (
            <li key={d.pathology} className="py-2 flex items-center justify-between gap-2">
              <div>
                <div className="font-medium capitalize">
                  {d.pathology.replace(/_/g, ' ')}
                </div>
                <div className="text-xs text-zinc-500 font-mono">
                  {d.evidenceTrades?.length || 0} trade(s) · {d.evidenceSessions?.length || 0} session(s)
                </div>
              </div>
              <ConfidenceBar value={d.confidence} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ConfidenceBar({ value }) {
  const v = Math.max(0, Math.min(1, Number(value || 0)));
  return (
    <div className="flex items-center gap-2 min-w-[140px]">
      <div className="h-1.5 w-24 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className="h-full bg-amber-500"
          style={{ width: `${(v * 100).toFixed(0)}%` }}
        />
      </div>
      <span className="font-mono text-xs">{(v * 100).toFixed(0)}%</span>
    </div>
  );
}
