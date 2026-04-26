import { useMemo } from 'react';

const RANGES = [
  { id: 'hourly', label: 'Hourly' },
  { id: 'daily', label: 'Daily' },
  { id: 'rolling30d', label: 'Rolling 30d' },
];

export default function MetricsView({ userId, metrics, range, onRangeChange }) {
  if (!userId) return null;

  if (metrics.state === 'loading') {
    return (
      <section className="card">
        <h2 className="text-lg font-semibold mb-3">Behavioural metrics</h2>
        <p className="text-sm text-zinc-400">Loading…</p>
      </section>
    );
  }

  if (metrics.state === 'error') {
    return (
      <section className="card">
        <h2 className="text-lg font-semibold mb-3">Behavioural metrics</h2>
        <p className="text-sm text-red-400">
          {metrics.error.status} — {metrics.error.message}
        </p>
      </section>
    );
  }

  if (metrics.state !== 'ready') return null;

  const m = metrics.data;

  return (
    <section className="card space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-lg font-semibold">Behavioural metrics</h2>
        <div className="flex items-center gap-1">
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`text-xs px-2 py-1 rounded-md border transition ${
                range.granularity === r.id
                  ? 'bg-emerald-500 text-zinc-950 border-emerald-400 font-semibold'
                  : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700'
              }`}
              onClick={() => onRangeChange({ ...range, granularity: r.id })}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat
          label="Plan adherence (rolling 10)"
          value={m.planAdherenceScore == null ? '—' : Number(m.planAdherenceScore).toFixed(2)}
          hint="1–5 self-rating"
        />
        <Stat
          label="Avg session tilt"
          value={Number(m.sessionTiltIndex || 0).toFixed(3)}
          hint="loss-following ratio"
        />
        <Stat label="Revenge trades" value={m.revengeTrades} hint="<90s after a loss" />
        <Stat
          label="Overtrading events"
          value={m.overtradingEvents}
          hint=">10 trades in 30m"
        />
      </div>

      <Sparkline points={m.timeseries} />
      <EmotionTable map={m.winRateByEmotionalState} />
    </section>
  );
}

function Stat({ label, value, hint }) {
  return (
    <div className="bg-zinc-950/40 border border-zinc-800 rounded-xl p-3">
      <div className="text-xs uppercase tracking-wider text-zinc-400">{label}</div>
      <div className="text-2xl font-semibold tabular-nums mt-1">{value ?? '—'}</div>
      <div className="text-[11px] text-zinc-500">{hint}</div>
    </div>
  );
}

function Sparkline({ points }) {
  const safe = useMemo(
    () => (Array.isArray(points) ? points.filter((p) => Number.isFinite(p.pnl)) : []),
    [points]
  );

  if (safe.length === 0) {
    return <p className="text-sm text-zinc-500">No timeseries data in range.</p>;
  }

  const W = 800;
  const H = 120;
  const min = Math.min(0, ...safe.map((p) => p.pnl));
  const max = Math.max(0, ...safe.map((p) => p.pnl));
  const span = max - min || 1;

  const x = (i) => (i * W) / Math.max(1, safe.length - 1);
  const y = (v) => H - ((v - min) / span) * H;

  const d = safe.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.pnl).toFixed(1)}`).join(' ');
  const baseline = y(0);

  return (
    <div className="bg-zinc-950/40 border border-zinc-800 rounded-xl p-3">
      <div className="text-xs uppercase tracking-wider text-zinc-400 mb-2">PnL by bucket</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-28" preserveAspectRatio="none">
        <line x1={0} y1={baseline} x2={W} y2={baseline} stroke="rgb(63 63 70)" strokeDasharray="3 3" />
        <path d={d} fill="none" stroke="rgb(52 211 153)" strokeWidth="2" />
      </svg>
      <div className="text-xs text-zinc-500 flex justify-between">
        <span>{safe[0].bucket?.slice(0, 10)}</span>
        <span>{safe[safe.length - 1].bucket?.slice(0, 10)}</span>
      </div>
    </div>
  );
}

function EmotionTable({ map }) {
  const rows = Object.entries(map || {});
  if (rows.length === 0) return null;
  return (
    <div className="bg-zinc-950/40 border border-zinc-800 rounded-xl p-3 overflow-x-auto">
      <div className="text-xs uppercase tracking-wider text-zinc-400 mb-2">
        Win rate by emotional state
      </div>
      <table className="text-sm w-full">
        <thead className="text-zinc-500 text-xs">
          <tr>
            <th className="text-left font-normal pb-1">State</th>
            <th className="text-right font-normal pb-1">Wins</th>
            <th className="text-right font-normal pb-1">Losses</th>
            <th className="text-right font-normal pb-1">Win rate</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {rows.map(([state, v]) => (
            <tr key={state} className="border-t border-zinc-800">
              <td className="py-1.5 capitalize">{state}</td>
              <td className="py-1.5 text-right text-emerald-400">{v.wins}</td>
              <td className="py-1.5 text-right text-rose-400">{v.losses}</td>
              <td className="py-1.5 text-right">{(v.winRate * 100).toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
