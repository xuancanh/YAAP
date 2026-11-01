/** Company memory (docs/company-vision.md §6; execution plan item 22):
 *  Ask the company — a focused question to the chief answered read-only
 *  with verified citations drawn as chips that open what they name, the
 *  recall pack behind the answer as "sources", a session history; the
 *  Playbooks pane — the procedures the company wrote for itself with their
 *  status, owner, roles, version and outcomes; and the Related drawer — the
 *  record around any goal, task, decision or meeting as grouped lists. */
/* eslint-disable react-refresh/only-export-components */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import { api, type AskResult, type Citation, type OrgDetail, type OrgGraph, type OrgPlaybook, type RecallPack } from '../lib/api';
import { Markdown, type RefKind, type RefResolver } from '../lib/md';
import { fmtUsd } from '../lib/pricing';
import { ASK_STATUS_COPY, citationLabel, citationsToChips, groupGraph, parseCitations, PLAYBOOK_STATUS_COLOR, playbookOutcomeLine, playbookRoles } from '../lib/org2';
import { card, input, btn, pill, h2, faint, label, linkBtn, ago, useAgentNames, useFollowRef, Avatar, Drawer } from './org-ui';

const mono: React.CSSProperties = { fontFamily: 'var(--mono)' };

/** A Markdown `refs` resolver for the chips an answer cites: the verified
 *  title as the label, the pane that shows the thing on click. An audit
 *  citation opens the replay of the day its row was written when the pack
 *  knows it, else the audit log. */
export function useCitationRefs(citations: Citation[], pack?: RecallPack | null): RefResolver {
  const follow = useFollowRef();
  return useCallback((kind: RefKind, id: string) => {
    const label = citationLabel(kind, id, citations);
    const onClick = () => {
      if (kind === 'audit') {
        const row = pack?.audit.find((r) => String(r.seq) === id);
        if (row) { follow('day', row.createdAt.slice(0, 10)); return; }
      }
      follow(kind, id);
    };
    return { label, onClick };
  }, [citations, pack, follow]);
}

interface Exchange { id: number; question: string; result: AskResult | null; error: string | null; loading: boolean; sources: RecallPack | null | 'loading'; showSources: boolean }

export function AskPane({ org }: { org: OrgDetail }) {
  const app = useApp();
  const wsId = org.workspaceId;
  const [q, setQ] = useState('');
  const [history, setHistory] = useState<Exchange[]>([]);
  const seq = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);
  const busy = history.some((h) => h.loading);
  const patch = (id: number, p: Partial<Exchange>) => setHistory((h) => h.map((x) => (x.id === id ? { ...x, ...p } : x)));
  const ask = async () => {
    const question = q.trim();
    if (!question || busy) return;
    const id = ++seq.current;
    setHistory((h) => [...h, { id, question, result: null, error: null, loading: true, sources: null, showSources: false }]);
    setQ('');
    try { patch(id, { result: await api.orgAsk(wsId, question), loading: false }); }
    catch (e) { patch(id, { error: e instanceof Error ? e.message.slice(0, 200) : 'the question failed', loading: false }); }
    requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: 'end' }));
  };
  const toggleSources = async (x: Exchange) => {
    if (x.showSources) { patch(x.id, { showSources: false }); return; }
    patch(x.id, { showSources: true });
    if (x.sources === null) {
      if (x.result?.pack) { patch(x.id, { sources: x.result.pack }); return; }
      patch(x.id, { sources: 'loading' });
      try { patch(x.id, { sources: await api.orgRecall(wsId, x.question) }); } catch { patch(x.id, { sources: null, showSources: false }); app.showToast('Recall is unavailable'); }
    }
  };
  const chief = useAgentNames().get(org.chiefOfStaffAgentId ?? '');
  return (
    <div style={{ maxWidth: 820, display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <div style={{ marginBottom: 10 }}>
        <h2 style={h2}>Ask the company</h2>
        <div style={faint}>One question, answered by {chief?.name ?? 'the chief of staff'} from the record alone — goals, tasks, decisions, minutes, signals and the audit log — read-only, with every claim cited. Unverifiable citations are stripped and listed. Capped by <code>memory.askUsdCap</code>.</div>
      </div>
      <div style={{ flex: 1 }}>
        {history.length === 0 && (
          <div style={{ ...card, ...faint, display: 'grid', gap: 6 }}>
            <div>Try:</div>
            {['Why did we drop the onboarding objective?', 'What did the research unit decide last week?', 'Which key results are at risk and who owns them?', 'What did we spend on review tasks this month, and what did it buy?'].map((s) => (
              <button key={s} style={{ ...linkBtn, textAlign: 'left', fontWeight: 500 }} onClick={() => setQ(s)}>“{s}”</button>
            ))}
          </div>
        )}
        {history.map((x) => <AskExchange key={x.id} x={x} chiefName={chief?.name ?? 'chief of staff'} onSources={() => void toggleSources(x)} />)}
        <div ref={endRef} />
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 12, position: 'sticky', bottom: 0, background: 'var(--bg)', padding: '8px 0' }}>
        <input aria-label="Your question" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void ask(); }} placeholder="Ask about anything in the record…" style={input} disabled={busy} />
        <button style={btn(true)} disabled={!q.trim() || busy} onClick={() => void ask()}>{busy ? 'Asking…' : 'Ask'}</button>
      </div>
    </div>
  );
}

function AskExchange({ x, chiefName, onSources }: { x: Exchange; chiefName: string; onSources: () => void }) {
  const r = x.result;
  const refs = useCitationRefs(r?.citations ?? [], r?.pack);
  const cited = r ? parseCitations(r.answer) : [];
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 6 }}>
        <span style={{ fontSize: 16 }}>🧑‍💼</span>
        <div style={{ ...card, padding: '8px 12px', fontSize: 13.5, background: 'var(--accent-dim)', borderColor: 'transparent' }}>{x.question}</div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', paddingLeft: 12 }}>
        <span style={{ fontSize: 16 }}>🤖</span>
        <div style={{ ...card, padding: '10px 14px', flex: 1, minWidth: 0 }}>
          {x.loading && <div style={faint}>{chiefName} is reading the record…</div>}
          {x.error && <div style={{ color: 'var(--red)', fontSize: 12.5 }}>{x.error}</div>}
          {r && (
            <>
              {r.status !== 'answered' && <div style={{ ...pill(r.status === 'budget_stop' ? 'var(--amber)' : 'var(--red)', '#fff'), display: 'inline-block', marginBottom: 6 }}>{ASK_STATUS_COPY[r.status]}</div>}
              {r.answer ? <div style={{ fontSize: 13.5, lineHeight: 1.6 }}><Markdown text={citationsToChips(r.answer)} refs={refs} compact /></div> : r.status === 'answered' ? <div style={faint}>No answer text.</div> : null}
              {r.citations.length > 0 && (
                <div style={{ marginTop: 8, borderTop: '1px solid var(--border-soft)', paddingTop: 6 }}>
                  <div style={label}>Verified citations · {r.citations.length}</div>
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 4 }}>
                    {r.citations.map((c) => { const res = refs(c.kind, c.id); return <button key={`${c.kind}:${c.id}`} onClick={res?.onClick} title={`${c.kind} ${c.id}`} style={{ ...pill('var(--panel-2)', 'var(--text)'), cursor: 'pointer', display: 'inline-flex', gap: 4, alignItems: 'center', padding: '2px 8px' }}><span style={{ ...faint, ...mono, fontSize: 10 }}>{c.kind}</span>{res?.label ?? c.title}</button>; })}
                  </div>
                </div>
              )}
              {r.stripped.length > 0 && <div style={{ ...faint, marginTop: 6 }}>Stripped (not in the record): {r.stripped.map((s) => <code key={s} style={{ marginRight: 6 }}>{s}</code>)}</div>}
              <div style={{ ...faint, marginTop: 6, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span>{fmtUsd(r.usd)} · {cited.length} citation{cited.length === 1 ? '' : 's'} in the text</span>
                <button style={linkBtn} onClick={onSources} aria-expanded={x.showSources}>{x.showSources ? 'Hide sources' : 'Show sources'}</button>
              </div>
            </>
          )}
          {!r && !x.loading && !x.error && null}
          {x.showSources && (x.sources === 'loading' ? <div style={{ ...faint, marginTop: 6 }}>Recalling…</div> : x.sources ? <RecallView pack={x.sources} /> : null)}
        </div>
      </div>
    </div>
  );
}

/** The recall pack: what the chief read before answering, grouped, each row a link. */
export function RecallView({ pack }: { pack: RecallPack }) {
  const follow = useFollowRef();
  const section = (title: string, n: number) => n > 0 && <div style={{ ...label, marginTop: 8 }}>{title} · {n}</div>;
  const row: React.CSSProperties = { fontSize: 12.5, padding: '3px 0', borderBottom: '1px solid var(--border-soft)', display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' };
  const link = (kind: string, id: string, text: string) => <button onClick={() => follow(kind, id)} style={{ ...linkBtn, fontWeight: 600, textAlign: 'left' }}>{text}</button>;
  const total = pack.goals.length + pack.tasks.length + pack.decisions.length + pack.meetings.length + pack.signals.length + pack.audit.length + pack.messages.length;
  return (
    <div style={{ marginTop: 8, borderTop: '1px solid var(--border-soft)', paddingTop: 6 }}>
      <div style={faint}>Recall pack · keywords: {pack.keywords.length ? pack.keywords.map((k) => <code key={k} style={{ marginRight: 4 }}>{k}</code>) : 'none'} · {total} row(s), model-free</div>
      {total === 0 && <div style={{ ...faint, marginTop: 4 }}>Nothing in the record matches these keywords.</div>}
      {section('Goals', pack.goals.length)}
      {pack.goals.map((g) => <div key={g.id} style={row}>{link('goal', g.id, g.title)}<span style={pill()}>{g.kind.replace('_', ' ')}</span><span style={faint}>{g.status}{g.atRisk ? ' · at risk' : ''}{g.owner ? ` · ${g.owner}` : ''}</span></div>)}
      {section('Tasks', pack.tasks.length)}
      {pack.tasks.map((t) => <div key={t.id} style={row}>{link('task', t.id, t.title)}<span style={pill()}>{t.status.replace('_', ' ')}</span><span style={faint}>{t.owner ?? 'unowned'} · {ago(t.updatedAt)}</span>{t.outcome && <span style={{ ...faint, flexBasis: '100%' }}>{t.outcome.slice(0, 160)}</span>}</div>)}
      {section('Decisions', pack.decisions.length)}
      {pack.decisions.map((d) => <div key={d.id} style={row}>{link('decision', d.id, d.title)}<span style={faint}>{d.decidedBy} · {ago(d.createdAt)}</span>{d.decision && <span style={{ fontSize: 12, flexBasis: '100%' }}>{d.decision.slice(0, 200)}</span>}</div>)}
      {section('Meetings', pack.meetings.length)}
      {pack.meetings.map((m) => <div key={m.id} style={row}>{link('meeting', m.id, m.title || m.kind)}<span style={faint}>{m.decisions} decision(s) · {m.actions} action(s) · {m.lessons} lesson(s){m.endedAt ? ` · ${ago(m.endedAt)}` : ''}</span>{m.summary && <span style={{ fontSize: 12, flexBasis: '100%' }}>{m.summary.slice(0, 200)}</span>}</div>)}
      {section('Signals', pack.signals.length)}
      {pack.signals.map((s) => <div key={s.id} style={row}><span style={{ fontWeight: 600 }}>{s.title}</span><span style={pill()}>{s.severity}</span><span style={faint}>{s.kind.replace(/_/g, ' ')} · {s.status}</span></div>)}
      {section('Audit rows', pack.audit.length)}
      {pack.audit.map((a) => <div key={a.seq} style={{ ...row, ...mono, fontSize: 11.5 }}>{link('day', a.createdAt.slice(0, 10), `#${a.seq}`)}<span>{a.actor}</span><b>{a.action}</b><span style={faint}>{a.refType}{a.refId ? `:${a.refId.slice(0, 8)}` : ''}</span></div>)}
      {section('Messages', pack.messages.length)}
      {pack.messages.map((m) => <div key={m.id} style={row}><span style={{ color: 'var(--accent-hi)', fontWeight: 600 }}>#{m.channel}</span><span style={faint}>{m.author} · {ago(m.createdAt)}</span><span style={{ fontSize: 12, flexBasis: '100%' }}>{m.text.slice(0, 200)}</span></div>)}
    </div>
  );
}

// ---- playbooks ----

export function PlaybooksPane({ org }: { org: OrgDetail }) {
  const app = useApp();
  const wsId = org.workspaceId;
  const names = useAgentNames();
  const follow = useFollowRef();
  const [rows, setRows] = useState<OrgPlaybook[] | null>(null);
  const [status, setStatus] = useState('');
  const [role, setRole] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setRows(await api.orgPlaybooks(wsId, { status: status || undefined, role: role.trim() || undefined }).catch((): OrgPlaybook[] => []));
  }, [wsId, status, role]);
  useEffect(() => { void refresh(); const t = setInterval(() => { void refresh(); }, 60_000); return () => clearInterval(t); }, [refresh]);
  useEffect(() => {
    if (app.orgFocus?.kind !== 'playbook' || !rows) return;
    const p = rows.find((x) => x.id === app.orgFocus!.id || x.skillId === app.orgFocus!.id || x.name === app.orgFocus!.id);
    if (p) { setOpen(p.id); app.setOrgFocus(null); requestAnimationFrame(() => document.getElementById(`playbook-${p.id}`)?.scrollIntoView({ block: 'center' })); }
  }, [rows, app]);
  const roleOptions = useMemo(() => [...new Set(org.members.filter((m) => m.status === 'active').map((m) => m.title).filter(Boolean))], [org.members]);
  return (
    <div style={{ maxWidth: 860 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h2 style={h2}>Playbooks</h2>
          <div style={faint}>Procedures the company wrote for itself (§6): a member writes one from a task that worked, a reviewer who is not the author accepts it, and it becomes a skill offered to the roles it names. Outcomes come from the turns that used it. Retros propose revisions; a revise task goes to the owner.</div>
        </div>
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} style={{ ...input, width: 'auto' }}>
          <option value="">any status</option>{['draft', 'in_review', 'active', 'retired'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
        </select>
        <input aria-label="Role" list="playbook-roles" value={role} onChange={(e) => setRole(e.target.value)} placeholder="offered to role…" style={{ ...input, width: 160 }} />
        <datalist id="playbook-roles">{roleOptions.map((r) => <option key={r} value={r} />)}</datalist>
      </div>
      {rows === null && <div style={faint}>Loading…</div>}
      {rows && rows.length === 0 && <div style={{ ...card, ...faint }}>No playbook yet. Members write them with <code>org_write_playbook</code> after a task that went well; each one arrives here as a draft with a review task.</div>}
      {rows?.map((p) => {
        const owner = p.ownerAgentId ? names.get(p.ownerAgentId) : undefined;
        const expanded = open === p.id;
        const preview = p.body.length > 480 && !expanded ? `${p.body.slice(0, 480)}…` : p.body;
        return (
          <div key={p.id} id={`playbook-${p.id}`} style={{ ...card, marginBottom: 8, borderLeft: `3px solid ${PLAYBOOK_STATUS_COLOR[p.status] ?? 'var(--border)'}` }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span>{p.title}</span>
                  <span style={{ ...faint, ...mono, fontSize: 10.5 }}>/{p.name}</span>
                  <span style={pill(PLAYBOOK_STATUS_COLOR[p.status], '#fff')}>{p.status.replace('_', ' ')}</span>
                  <span style={pill()}>v{p.version}</span>
                </div>
                <div style={{ ...faint, marginTop: 3, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  {owner ? <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><Avatar a={owner} size={14} />{owner.name}</span> : <span>no owner</span>}
                  <span>offered to {playbookRoles(p.roles).map((r) => <span key={r} style={{ ...pill(), marginLeft: 3 }}>{r}</span>)}</span>
                  <span>{playbookOutcomeLine(p.outcomes)}</span>
                  <span>{ago(p.updatedAt)}</span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 5, flex: 'none' }}>
                {(p.status === 'active' || p.status === 'draft') && <button style={btn()} onClick={() => { void api.retireOrgPlaybook(wsId, p.id).then(() => refresh()).catch((e: unknown) => app.showToast(e instanceof Error ? e.message : String(e))); }} title="Disable the playbook's skill and stop offering it">Retire</button>}
                {p.status === 'in_review' && p.reviewTaskId && <button style={btn()} onClick={() => follow('task', p.reviewTaskId!)} title="The review task whose acceptance activates this version">Review task</button>}
                {p.sourceTaskId && <button style={btn()} onClick={() => follow('task', p.sourceTaskId!)} title="The task it was written from">Source</button>}
                <button style={btn()} onClick={() => setOpen(expanded ? null : p.id)} aria-expanded={expanded}>{expanded ? 'Less' : 'Read'}</button>
              </div>
            </div>
            {p.why && <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 6 }}><b>Why:</b> {p.why}</div>}
            <div style={{ fontSize: 13, lineHeight: 1.55, marginTop: 8, borderTop: '1px solid var(--border-soft)', paddingTop: 8 }}>
              {p.body ? <Markdown text={preview} compact /> : <span style={faint}>empty body</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---- the graph around a thing ----

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
