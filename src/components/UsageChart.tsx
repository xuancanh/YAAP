/** The cost dashboard pieces (roadmap phase 2.5): a compact per-day bar
 *  chart in plain SVG (no chart library — it is one series and a baseline)
 *  and the per-kind / per-agent breakdown rows. Shared by the agent home
 *  and Settings → Usage. */
import { useState } from 'react';
import type { UsageDay, UsageBucket } from '../lib/api';
import { fmtTokens } from '../lib/util';
import { fmtUsd } from '../lib/pricing';

const mono: React.CSSProperties = { fontFamily: 'var(--mono)' };

/** Bars are tokens (always known); the hover label adds dollars when the
 *  day had any priced usage. */
export function UsageBars({ series, height = 72 }: { series: UsageDay[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...series.map((d) => d.tokensIn + d.tokensOut));
  const n = Math.max(1, series.length);
  const w = 100 / n;
  const h = hover !== null ? series[hover] : null;
  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" style={{ width: '100%', height, display: 'block' }} role="img" aria-label="Tokens per day">
        <line x1={0} x2={100} y1={height - 0.5} y2={height - 0.5} stroke="var(--border)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {series.map((d, i) => {
          const total = d.tokensIn + d.tokensOut;
          const bh = total > 0 ? Math.max(1.5, (total / max) * (height - 4)) : 0;
          const active = hover === i;
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              {/* full-height hit area so thin bars are hoverable */}
              <rect x={i * w} y={0} width={w} height={height} fill="transparent" />
              <rect x={i * w + w * 0.15} y={height - 1 - bh} width={w * 0.7} height={bh} rx={0.6}
                fill={active ? 'var(--accent-hi)' : 'var(--accent)'} opacity={total > 0 ? 1 : 0} />
            </g>
          );
        })}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-faint)', marginTop: 4, ...mono }}>
        <span>{series[0]?.day.slice(5) ?? ''}</span>
        <span style={{ color: 'var(--text-dim)' }}>
          {h ? `${h.day} · ${fmtTokens(h.tokensIn + h.tokensOut)} tokens · ${fmtUsd(h.usd)}` : `${series.length} days`}
        </span>
        <span>{series.at(-1)?.day.slice(5) ?? ''}</span>
      </div>
    </div>
  );
}

export function UsageRows({ rows, onOpen }: {
  rows: Array<Pick<UsageBucket, 'key' | 'label' | 'tokensIn' | 'tokensOut' | 'usd' | 'turns'> & { kind?: string; sessionId?: string }>;
  onOpen?: (sessionId: string) => void;
}) {
  if (rows.length === 0) return <div style={{ fontSize: 12, color: 'var(--text-faint)', padding: '6px 2px' }}>No turns in this window.</div>;
  const maxUsd = Math.max(...rows.map((r) => r.usd), 0);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {rows.map((r) => (
        <div key={r.key} onClick={() => r.sessionId && onOpen?.(r.sessionId)}
          style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 72px 64px', gap: 10, alignItems: 'center', padding: '6px 8px', borderRadius: 8, cursor: r.sessionId && onOpen ? 'pointer' : 'default' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {r.kind && r.kind !== 'chat' && <span style={{ fontSize: 9.5, color: 'var(--text-faint)', border: '1px solid var(--border)', borderRadius: 4, padding: '0 5px', textTransform: 'uppercase', letterSpacing: '.4px' }}>{r.kind}</span>}
              <span style={{ fontWeight: 600 }}>{r.label}</span>
              <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{r.turns} turn{r.turns === 1 ? '' : 's'}</span>
            </div>
            <div style={{ height: 3, background: 'var(--panel-2)', borderRadius: 2, marginTop: 4, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${maxUsd > 0 ? (r.usd / maxUsd) * 100 : 0}%`, background: 'var(--accent)', borderRadius: 2 }} />
            </div>
          </div>
          <span style={{ fontSize: 11.5, color: 'var(--text-dim)', textAlign: 'right', ...mono }}>{fmtTokens(r.tokensIn + r.tokensOut)}</span>
          <span style={{ fontSize: 12, fontWeight: 600, textAlign: 'right', ...mono }}>{fmtUsd(r.usd)}</span>
        </div>
      ))}
    </div>
  );
}
