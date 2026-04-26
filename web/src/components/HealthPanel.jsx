import { useEffect, useState } from 'react';
import { baseUrl } from '../api.js';

export default function HealthPanel() {
  const [state, setState] = useState({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`${baseUrl}/health`);
        const body = await r.json();
        if (!cancelled) setState(body);
      } catch (err) {
        if (!cancelled)
          setState({ status: 'unreachable', error: String(err.message) });
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const ok = state.status === 'ok';
  const color = ok ? 'bg-emerald-500' : state.status === 'loading' ? 'bg-zinc-500' : 'bg-amber-500';

  return (
    <div className="card flex items-center gap-3 min-w-[280px]">
      <span className={`inline-block w-2.5 h-2.5 rounded-full ${color}`} />
      <div className="text-sm font-mono leading-tight">
        <div>
          <span className="text-zinc-400">status:</span>{' '}
          <span className={ok ? 'text-emerald-400' : 'text-amber-400'}>
            {state.status}
          </span>
        </div>
        <div>
          <span className="text-zinc-400">db:</span>{' '}
          <span>{state.dbConnection || '?'}</span>
        </div>
        <div>
          <span className="text-zinc-400">queue lag:</span>{' '}
          <span>{state.queueLag ?? '?'}</span>
        </div>
      </div>
    </div>
  );
}
