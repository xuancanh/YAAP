/** Apps gallery: every mini app your agents have built (save_app), across
 *  the whole fleet — open full-screen or embed beside the agent's chat. */
import { Suspense, lazy, useState } from 'react';
import { useApp, grad } from '../store';
import type { Agent, AgentApp } from '../lib/api';
import { CapReviewModal, pendingCaps } from './AppHost';

/** Lazy so the eager gallery doesn't pull the whole AgentsView chunk in. */
const AppViewer = lazy(() => import('./AgentsView').then((m) => ({ default: m.AppViewer })));

function parseApps(a: Agent): AgentApp[] {
  try { return JSON.parse(a.apps) as AgentApp[]; } catch { return []; }
}

function ago(iso: string): string {
  const m = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (m < 60) return `${m} m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function AppsGallery() {
  const app = useApp();
  const [openApp, setOpenApp] = useState<{ agentId: string; app: AgentApp } | null>(null);
  const [review, setReview] = useState<{ agentId: string; app: AgentApp } | null>(null);
  const groups = app.agents
    .map((a) => ({ agent: a, apps: parseApps(a) }))
    .filter((g) => g.apps.length > 0);
  const total = groups.reduce((n, g) => n + g.apps.length, 0);

  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '30px 28px 60px' }}>
        <div style={{ fontSize: 23, fontWeight: 700, letterSpacing: '-.4px' }}>Apps</div>
        <div style={{ color: 'var(--text-dim)', fontSize: 13.5, marginTop: 4, maxWidth: 560 }}>
          {total > 0
            ? `${total} mini app${total === 1 ? '' : 's'} built by your agents — sandboxed, no network. Open one here or embed it beside its agent's chat.`
            : 'Mini apps your agents build (save_app) appear here — sandboxed HTML tools like trackers, calculators, and dashboards.'}
        </div>

        {groups.map(({ agent, apps }) => (
          <div key={agent.id} style={{ marginTop: 26 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 10 }}>
              <span style={{ width: 26, height: 26, borderRadius: 8, background: grad(agent.colors), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, flex: 'none' }}>{agent.emoji}</span>
              <span onClick={() => app.openAgent(agent.id)} style={{ fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>{agent.name}</span>
              <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{apps.length}/12</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: app.stacked ? '1fr' : 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
              {apps.map((x) => (
                <div key={x.id} onClick={() => setOpenApp({ agentId: agent.id, app: x })} style={{ border: '1px solid var(--border)', borderRadius: 13, background: 'var(--panel)', padding: '13px 15px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{x.name}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.45, minHeight: 16 }}>{x.description || 'no description'}</span>
                  {(x.capabilities ?? []).length > 0 && (
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {(x.capabilities ?? []).map((c) => (
                        <span key={c} style={{ fontSize: 9, fontFamily: 'var(--mono)', borderRadius: 5, padding: '1px 6px', border: '1px solid var(--border-soft)', color: (x.approved ?? []).includes(c) ? 'var(--green)' : 'var(--text-faint)' }}>{c}</span>
                      ))}
                      {pendingCaps(x).length > 0 && (
                        <button onClick={(e) => { e.stopPropagation(); setReview({ agentId: agent.id, app: x }); }}
                          style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--amber)', border: '1px solid var(--amber)', background: 'none', borderRadius: 5, padding: '1px 7px', cursor: 'pointer' }}>
                          review {pendingCaps(x).length}
                        </button>
                      )}
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
                    <span style={{ fontSize: 9.5, color: 'var(--text-faint)', flex: 1, fontFamily: 'var(--mono)' }}>updated {ago(x.updatedAt)}</span>
                    <button title={`Open beside ${agent.name}'s latest conversation`} onClick={(e) => { e.stopPropagation(); void app.embedApp(agent.id, x); }}
                      style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 7, padding: '4px 11px', fontSize: 11, fontWeight: 600, cursor: 'pointer', flex: 'none' }}>
                      Embed in chat
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}

        {groups.length === 0 && (
          <div style={{ marginTop: 24, border: '1px solid var(--border)', borderRadius: 13, background: 'var(--panel)', padding: 20, fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.6 }}>
            None yet. Ask any agent to build one — “make me a mortgage calculator”, “build a tracker for my reading list” —
            and it will write a self-contained HTML tool with <span style={{ fontFamily: 'var(--mono)' }}>save_app</span> that shows up here.
          </div>
        )}
      </div>
      {openApp && <Suspense fallback={null}><AppViewer agentId={openApp.agentId} miniApp={openApp.app} onClose={() => setOpenApp(null)} /></Suspense>}
      {review && <CapReviewModal agentId={review.agentId} miniApp={review.app} onClose={() => setReview(null)} />}
    </div>
  );
}
