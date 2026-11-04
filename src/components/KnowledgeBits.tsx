/**
 * The knowledge base in the SPA (docs/knowledge-base.md):
 *  - `KnowledgeHireSection` — Foundry's agent detail (the hire review):
 *    "Knowledge base · N docs" with the titles and the shared topics;
 *  - `AgentKnowledgeCard` — the agent page's Overview: the role's knowledge
 *    base, each doc a link that opens its read-only file under /library/ in
 *    the side panel (Artifacts).
 */
import { useEffect, useRef, useState } from 'react';
import { api, type AgentKnowledge, type KbDocRef, type MarketItem } from '../lib/api';
import { openFileInPanel } from '../lib/file-links';

const label: React.CSSProperties = { fontSize: 11, fontWeight: 600, letterSpacing: '.5px', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 11 };
const faint: React.CSSProperties = { fontSize: 11.5, color: 'var(--text-faint)' };
const panel: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 12, background: 'var(--panel)' };
const chip: React.CSSProperties = { fontSize: 10.5, color: 'var(--text-dim)', background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 6, padding: '2px 8px' };

const topicLabel = (t: string) => t.replace(/-/g, ' ');

/** The hire review's knowledge-base block (absent when the pack has none). */
export function KnowledgeHireSection({ item }: { item: Pick<MarketItem, 'name' | 'knowledge'> }) {
  const kb = item.knowledge;
  if (!kb || kb.docs === 0) return null;
  return (
    <div style={{ marginTop: 18 }} data-testid="hire-knowledge">
      <div style={label}>Knowledge base · {kb.docs} doc{kb.docs === 1 ? '' : 's'}</div>
      <ul style={{ margin: 0, padding: '8px 12px 8px 28px', border: '1px solid var(--border-soft)', borderRadius: 10, background: 'var(--panel-2)', fontSize: 12.5, lineHeight: 1.6 }}>
        {kb.titles.map((t) => <li key={t}>{t}</li>)}
      </ul>
      {kb.shared.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
          <span style={faint}>Also shared topics:</span>
          {kb.shared.map((t) => <span key={t} style={chip}>{topicLabel(t)}</span>)}
        </div>
      )}
      <div style={{ ...faint, fontSize: 11, marginTop: 7 }}>
        Curated, read-only reference {item.name} searches while it works (kb_search). It installs once per workspace under /library/{kb.folder}/, shared by every agent of this role, and you can read it in Artifacts.
      </div>
    </div>
  );
}

/** The agent page's knowledge-base card (renders nothing when the agent has none). */
export function AgentKnowledgeCard({ agentId }: { agentId: string }) {
  const [kb, setKb] = useState<AgentKnowledge | null>(null);
  const installed = useRef(false);
  useEffect(() => {
    let live = true;
    installed.current = false;
    setKb(null);
    void api.agentKnowledge(agentId).then((k) => { if (live) setKb(k); }).catch(() => { if (live) setKb(null); });
    return () => { live = false; };
  }, [agentId]);
  if (!kb || (kb.docs.length === 0 && kb.shared.length === 0)) return null;
  // The files are installed on hire and at boot; a first open makes sure.
  const open = async (d: KbDocRef) => {
    if (!installed.current) {
      installed.current = true;
      await api.installAgentKnowledge(agentId).catch(() => undefined);
    }
    openFileInPanel(d.file.replace(/^\//, ''));
  };
  const link = (d: KbDocRef) => (
    <li key={d.path} style={{ padding: '6px 0', borderTop: '1px solid var(--border-soft)' }}>
      <button type="button" onClick={() => void open(d)} title={d.file}
        style={{ font: 'inherit', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent-hi)', fontWeight: 600, fontSize: 12.5, textAlign: 'left' }}>
        {d.title}
      </button>
      <div style={faint}>{d.summary}</div>
    </li>
  );
  const docs = kb.docs.filter((d) => !d.path.endsWith('/README.md'));
  const readme = kb.docs.find((d) => d.path.endsWith('/README.md'));
  return (
    <section aria-label="Knowledge base" data-testid="agent-knowledge" style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, margin: '0 2px 7px', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 650 }}>Knowledge base</h3>
        <span style={faint}>{docs.length ? `${docs.length} doc${docs.length === 1 ? '' : 's'}` : 'shared topics'}{kb.packName ? ` · ${kb.packName}` : ''}</span>
        <span style={{ flex: 1 }} />
        {readme && <button type="button" onClick={() => void open(readme)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent-hi)', fontSize: 11.5, fontWeight: 600 }}>Open in Artifacts</button>}
      </div>
      <div style={{ ...panel, padding: '10px 14px' }}>
        {kb.summary && <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginBottom: 6 }}>{kb.summary}</div>}
        {docs.length > 0 && <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{docs.map(link)}</ul>}
        {kb.shared.length > 0 && (
          <details style={{ marginTop: 8 }}>
            <summary style={{ ...faint, cursor: 'pointer' }}>Shared topics: {kb.shared.map((t) => topicLabel(t.topic)).join(', ')}</summary>
            <ul style={{ listStyle: 'none', margin: '4px 0 0', padding: 0 }}>{kb.shared.flatMap((t) => t.docs).map(link)}</ul>
          </details>
        )}
        <div style={{ ...faint, fontSize: 11, marginTop: 8 }}>Read-only reference that ships with the role. What this agent learns on the job lives in its Memory.</div>
      </div>
    </section>
  );
}
