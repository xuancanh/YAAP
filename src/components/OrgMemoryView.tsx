/** Company memory (docs/company-vision.md §6; execution plan item 22): the
 *  Related drawer — the record around any goal, task, decision or meeting as
 *  grouped lists. Playbooks are mirrored to /org/playbooks/ in Artifacts
 *  (docs/filesystem.md); asking the company is a chat with the chief. */
/* eslint-disable react-refresh/only-export-components */
import { useEffect, useState } from 'react';
import { api, type OrgGraph } from '../lib/api';
import { groupGraph } from '../lib/org2';
import { card, btn, pill, h2, faint, label, linkBtn, ago, useFollowRef, Drawer } from './org-ui';

const mono: React.CSSProperties = { fontFamily: 'var(--mono)' };

/** The record around one goal, task, decision or meeting (§6): neighbours
 *  grouped by kind with the relation that links them, one or two hops out,
 *  each a link to its pane. Lists, not a force graph. */
export function RelatedDrawer({ wsId, ref: refKey, title, onClose }: { wsId: string; ref: string; title: string; onClose: () => void }) {
  const follow = useFollowRef();
  const [depth, setDepth] = useState<1 | 2>(1);
  const [graph, setGraph] = useState<OrgGraph | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setGraph(null);
    void api.orgGraph(wsId, refKey, depth).then((g) => { setGraph(g); setErr(null); }).catch((e) => setErr(e instanceof Error ? e.message.slice(0, 160) : 'failed'));
  }, [wsId, refKey, depth]);
  const groups = graph ? groupGraph(graph) : [];
  return (
    <Drawer onClose={onClose} width={520}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 style={{ ...h2, flex: 1 }}>Related · {title}</h2>
        <div role="tablist" aria-label="Depth" style={{ display: 'flex', gap: 4 }}>
          {([1, 2] as const).map((d) => <button key={d} role="tab" aria-selected={depth === d} style={btn(depth === d)} onClick={() => setDepth(d)}>{d} hop{d === 1 ? '' : 's'}</button>)}
        </div>
        <button style={btn()} onClick={onClose} aria-label="Close">×</button>
      </div>
      <div style={faint}><span style={mono}>{refKey}</span> · the links the record holds: goal ↔ project ↔ task, task ↔ runs and decisions, meeting ↔ decisions and lessons, signal ↔ what it names.</div>
      {err && <div style={{ color: 'var(--red)', fontSize: 12.5 }}>{err}</div>}
      {!graph && !err && <div style={faint}>Walking the graph…</div>}
      {graph && groups.length === 0 && <div style={{ ...card, ...faint }}>Nothing is linked to this yet.</div>}
      {groups.map((g) => (
        <div key={g.kind} style={card}>
          <div style={label}>{g.label} · {g.rows.length}</div>
          {g.rows.map((n) => (
            <div key={n.key} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '5px 0', borderBottom: '1px solid var(--border-soft)', flexWrap: 'wrap' }}>
              <button onClick={() => { if (follow(n.kind, n.id)) onClose(); }} style={{ ...linkBtn, fontWeight: 600, textAlign: 'left', fontSize: 12.5 }}>{n.title || `${n.kind} ${n.id.slice(0, 8)}`}</button>
              {n.status && <span style={pill()}>{n.status.replace('_', ' ')}</span>}
              {n.rel && <span style={faint}>{n.rel.replace(/_/g, ' ')}</span>}
              {n.hops > 1 && <span style={{ ...faint, fontSize: 10.5 }}>2 hops</span>}
              {n.at && <span style={{ ...faint, marginLeft: 'auto' }}>{ago(n.at)}</span>}
            </div>
          ))}
        </div>
      ))}
      {graph?.truncated && <div style={faint}>Truncated at 200 nodes.</div>}
    </Drawer>
  );
}
