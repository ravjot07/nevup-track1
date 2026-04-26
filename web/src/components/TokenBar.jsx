import { useState } from 'react';

export default function TokenBar({ users, activeUser, onSelect, token, onMint, tokenError }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  const display = !token
    ? '—'
    : revealed
    ? token
    : `${token.slice(0, 12)}…${token.slice(-12)}`;

  const handleCopy = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
    }
  };

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-sm text-zinc-400" htmlFor="user-select">
            Trader
          </label>
          <select
            id="user-select"
            value={activeUser?.id || ''}
            onChange={(e) => onSelect(users.find((u) => u.id === e.target.value))}
            className="bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1 text-sm font-mono"
          >
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} — {u.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn"
            onClick={() => setRevealed((v) => !v)}
            disabled={!token}
          >
            {revealed ? 'Hide' : 'Reveal'} token
          </button>
          <button type="button" className="btn" onClick={handleCopy} disabled={!token}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button type="button" className="btn-primary" onClick={onMint}>
            Mint fresh 24h token
          </button>
        </div>
      </div>

      <div className="font-mono text-xs break-all text-zinc-300 bg-zinc-950/60 border border-zinc-800 rounded-lg p-3">
        {display}
      </div>

      {tokenError && (
        <div className="text-amber-400 text-xs">
          Token error: {tokenError}. The API may still be starting — refresh in a few seconds.
        </div>
      )}
    </div>
  );
}
