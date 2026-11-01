/** The action contract and the trust ledger on screen
 *  (docs/actions-and-trust.md, execution-plan item 28; SPA item 32):
 *  Settings → Workspace → Trust (agents × action classes with level,
 *  ceiling, clean count and last incident; the owner's ceilings and
 *  overrides), the agent page's Trust tab (its levels, the class legend, its
 *  action log with "Report revert"), and the owner's key on a held or staged
 *  action — always with the exact call that will run. */
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../store';
import { api, type ActionClass, type ActionLogRow, type TrustOverview } from '../lib/api';
import {
  ACTION_CLASSES, actionCallText, actionDecisionLabel, CLASS_COLOR, CLASS_HINT, CLASS_LABEL, CLASS_SHORT, heldReason, keyButtonLabel, LEVEL_COLOR, LEVEL_LEGEND, trustRows, type TrustCell,
} from '../lib/org3';
import { card, input, btn, pill, faint, label, linkBtn, ago } from './org-ui';

const mono: React.CSSProperties = { fontFamily: 'var(--mono)' };
const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^\d{3} /, '').slice(0, 200) : 'failed');

/** The owner (or a solo workspace) holds the levers; the server also lets the organization's CEO in. */
function useIsOwner(): boolean {
  const app = useApp();
  return !app.me || app.me.role === 'owner' || !app.me.hasMembers;
}

export function ClassPill({ cls, title }: { cls: string; title?: string }) {
  return <span style={{ ...pill('var(--panel-2)', CLASS_COLOR[cls] ?? 'var(--text-dim)'), borderColor: CLASS_COLOR[cls] ?? 'var(--border-soft)' }} title={title ?? `${CLASS_LABEL[cls] ?? cls}: ${CLASS_HINT[cls] ?? ''}`}>{CLASS_SHORT[cls] ?? cls}</span>;
}

function LevelLegend() {
  return (
    <details>
      <summary style={{ cursor: 'pointer', ...faint }}>What the levels and classes mean</summary>
      <div style={{ display: 'grid', gap: 3, marginTop: 6, fontSize: 12 }}>
        {LEVEL_LEGEND.map((l) => <div key={l.level}><b style={{ color: LEVEL_COLOR[l.level] }}>{l.level} · {l.label}</b> — {l.text}</div>)}
        <div style={{ height: 4 }} />
        {ACTION_CLASSES.map((c) => <div key={c}><ClassPill cls={c} /> {CLASS_HINT[c]}</div>)}
        <div style={{ ...faint, marginTop: 4 }}>The level that governs a call is the lowest of the earned level, your ceiling and the organization mode. Levels rise after clean outcomes and fall at once on an incident, a reported revert or a run of rejections.</div>
      </div>
    </details>
  );
}

// ---- Settings → Workspace → Trust ----

export function TrustSection({ wsId }: { wsId: string }) {
  const app = useApp();
  const owner = useIsOwner();
  const [o, setO] = useState<TrustOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editCeilings, setEditCeilings] = useState(false);
  const [override, setOverride] = useState<{ agentId: string; name: string; cell: TrustCell } | null>(null);
  const refresh = useCallback(async () => {
    try { setO(await api.workspaceTrust(wsId)); setErr(null); } catch (e) { setErr(errText(e)); }
  }, [wsId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const rows = trustRows(o);
  return (
    <div style={{ ...card, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Trust</div>
          <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 3 }}>Autonomy per agent and per class of action, earned from the record. You set the ceilings; a level never rises above one.{o ? ` Organization mode: ${o.orgMode}.` : ''}</div>
        </div>
        {owner && o && <button style={btn(editCeilings)} onClick={() => setEditCeilings(!editCeilings)}>{editCeilings ? 'Done' : 'Set ceilings'}</button>}
      </div>
      {err && <div style={{ color: 'var(--red)', fontSize: 12.5, marginTop: 8 }}>{err}</div>}
      {o && editCeilings && <CeilingsEditor wsId={wsId} o={o} onSaved={refresh} />}
      {o && (
        <div style={{ overflowX: 'auto', marginTop: 10 }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
            <caption style={{ textAlign: 'left', ...faint, paddingBottom: 4 }}>Level / ceiling per class · click a cell to override</caption>
            <thead>
              <tr>
                <th scope="col" style={{ textAlign: 'left', padding: '4px 6px', ...label }}>Agent</th>
                {ACTION_CLASSES.filter((c) => c !== 'read').map((c) => <th key={c} scope="col" style={{ padding: '4px 6px', ...label, whiteSpace: 'nowrap' }} title={CLASS_HINT[c]}>{CLASS_SHORT[c]}<div style={{ ...mono, fontSize: 10, textTransform: 'none' }}>ceiling {o.ceilings[c]}</div></th>)}
                <th scope="col" style={{ padding: '4px 6px', ...label, whiteSpace: 'nowrap' }}>Last incident</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.agentId} style={{ borderTop: '1px solid var(--border-soft)' }}>
                  <th scope="row" style={{ textAlign: 'left', padding: '6px', fontWeight: 600, whiteSpace: 'nowrap' }}><button style={{ ...linkBtn, color: 'var(--text)' }} onClick={() => app.openAgent(r.agentId, 'Trust')}>{r.name}</button></th>
                  {r.cells.map((c) => (
                    <td key={c.cls} style={{ padding: '4px 6px', textAlign: 'center' }}>
                      <button disabled={!owner} onClick={() => setOverride({ agentId: r.agentId, name: r.name, cell: c })} title={c.title} aria-label={`${r.name}, ${CLASS_LABEL[c.cls]}: level ${c.level} of ${c.ceiling}`}
                        style={{ background: 'var(--panel-2)', border: `1px solid ${c.capped ? 'var(--amber)' : 'var(--border-soft)'}`, borderRadius: 7, padding: '3px 7px', cursor: owner ? 'pointer' : 'default', color: 'var(--text)', ...mono, fontSize: 12 }}>
                        <b style={{ color: LEVEL_COLOR[c.effective] }}>{c.effective}</b><span style={{ color: 'var(--text-faint)' }}>/{c.ceiling}</span>
                        <span style={{ display: 'block', fontSize: 9.5, color: 'var(--text-faint)' }}>{c.clean} clean{c.rejectStreak ? ` · ${c.rejectStreak}✗` : ''}</span>
                      </button>
                    </td>
                  ))}
                  <td style={{ padding: '4px 6px', whiteSpace: 'nowrap', ...faint }}>{r.lastIncidentAt ? ago(r.lastIncidentAt) : '—'}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={6} style={{ ...faint, padding: 8 }}>No agents in this workspace.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {override && <OverrideForm wsId={wsId} {...override} onClose={() => setOverride(null)} onSaved={async () => { setOverride(null); await refresh(); }} />}
      <div style={{ marginTop: 10 }}><LevelLegend /></div>
      <div style={{ marginTop: 12 }}><HeldActions wsId={wsId} /></div>
    </div>
  );
}

function CeilingsEditor({ wsId, o, onSaved }: { wsId: string; o: TrustOverview; onSaved: () => Promise<void> }) {
  const app = useApp();
  const [draft, setDraft] = useState<Record<string, number>>({ ...o.ceilings });
  const changed = ACTION_CLASSES.filter((c) => draft[c] !== o.ceilings[c]);
  const save = async () => {
    const lowered = changed.filter((c) => draft[c] < o.ceilings[c]);
    if (lowered.length && !confirm(`Lowering ${lowered.map((c) => CLASS_LABEL[c]).join(', ')} drops every level above the new ceiling at once. Continue?`)) return;
    try { await api.setTrustCeilings(wsId, Object.fromEntries(changed.map((c) => [c, draft[c]]))); await onSaved(); app.showToast('Ceilings saved (audited)'); } catch (e) { app.showToast(errText(e)); }
  };
  return (
    <div style={{ marginTop: 10, display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', alignItems: 'end' }}>
      {ACTION_CLASSES.map((c) => (
        <div key={c}><label style={label} htmlFor={`ceil-${c}`}>{CLASS_LABEL[c]}</label>
          <select id={`ceil-${c}`} value={draft[c]} onChange={(e) => setDraft({ ...draft, [c]: Number(e.target.value) })} style={input}>
            {[0, 1, 2, 3].map((l) => <option key={l} value={l}>{l} · {LEVEL_LEGEND[l].label}</option>)}
          </select></div>
      ))}
      <button style={btn(true)} disabled={changed.length === 0} onClick={() => void save()}>Save ceilings</button>
    </div>
  );
}

function OverrideForm({ wsId, agentId, name, cell, onClose, onSaved }: { wsId: string; agentId: string; name: string; cell: TrustCell; onClose: () => void; onSaved: () => Promise<void> }) {
  const app = useApp();
  const [level, setLevel] = useState(cell.level);
  const [reason, setReason] = useState('');
  const save = async () => {
    try { await api.overrideTrust(wsId, agentId, cell.cls, level, reason.trim()); await onSaved(); app.showToast(`${name}: ${CLASS_LABEL[cell.cls]} → ${level} (audited)`); } catch (e) { app.showToast(errText(e)); }
  };
  return (
    <div role="dialog" aria-label={`Override ${name}'s ${CLASS_LABEL[cell.cls]} level`} style={{ marginTop: 10, border: '1px solid var(--border)', borderRadius: 10, padding: 10, display: 'grid', gap: 8 }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{name} · {CLASS_LABEL[cell.cls]} <span style={faint}>now {cell.level} (ceiling {cell.ceiling}){cell.reason ? ` — ${cell.reason}` : ''}</span></div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} role="radiogroup" aria-label="Level">
        {[0, 1, 2, 3].map((l) => (
          <button key={l} role="radio" aria-checked={level === l} disabled={l > cell.ceiling} onClick={() => setLevel(l)} title={l > cell.ceiling ? 'Above the ceiling — raise the ceiling first' : LEVEL_LEGEND[l].text}
            style={{ ...pill(level === l ? 'var(--accent)' : 'var(--panel-2)', level === l ? '#fff' : 'var(--text)'), padding: '4px 10px', cursor: l > cell.ceiling ? 'not-allowed' : 'pointer', opacity: l > cell.ceiling ? 0.45 : 1 }}>{l} · {LEVEL_LEGEND[l].label}</button>
        ))}
      </div>
      <input aria-label="Reason (required, audited)" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required — it is the audit row)" style={input} />
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}><button style={btn()} onClick={onClose}>Cancel</button><button style={btn(true)} disabled={!reason.trim() || level === cell.level} onClick={() => void save()}>Set level {level}</button></div>
    </div>
  );
}

// ---- the owner's key ----

/** Actions held or staged for the owner's key (optionally one agent's). */
export function HeldActions({ wsId, agentId, onChanged }: { wsId: string; agentId?: string; onChanged?: () => void }) {
  const app = useApp();
  const [rows, setRows] = useState<ActionLogRow[] | null>(null);
  const refresh = useCallback(async () => {
    const [h, s] = await Promise.all([api.workspaceActions(wsId, { status: 'held', agentId, limit: 100 }).catch((): ActionLogRow[] => []), api.workspaceActions(wsId, { status: 'staged', agentId, limit: 100 }).catch((): ActionLogRow[] => [])]);
    setRows([...h, ...s].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
  }, [wsId, agentId]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (app.orgFocus?.kind !== 'action' || !rows) return;
    const el = document.querySelector<HTMLElement>(`[id^="action-${app.orgFocus.id}"]`);
    if (el) { el.scrollIntoView({ block: 'center' }); el.style.outline = '2px solid var(--accent)'; setTimeout(() => { el.style.outline = ''; }, 2400); app.setOrgFocus(null); }
  }, [rows, app]);
  if (rows === null) return null;
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Waiting for your key · {rows.length}</div>
      {rows.length === 0 && <div style={faint}>Nothing is held or staged.</div>}
      {rows.map((r) => <HeldActionCard key={r.id} wsId={wsId} row={r} onDone={async () => { await refresh(); onChanged?.(); void app.refreshWsOrg(); }} />)}
    </div>
  );
}

/** One held or staged action: the class, why it waits, the exact call, and the two keys. */
export function HeldActionCard({ wsId, row, onDone }: { wsId: string; row: ActionLogRow; onDone: () => Promise<void> | void }) {
  const app = useApp();
  const owner = useIsOwner();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const agent = row.agentId ? app.agents.find((a) => a.id === row.agentId) : undefined;
  const d = actionDecisionLabel(row);
  const key = async (approve: boolean) => {
    setBusy(true);
    try { const r = await api.giveActionKey(wsId, row.id, approve, note.trim() || undefined); app.showToast(`${r.status}: ${r.result.slice(0, 140)}`); await onDone(); } catch (e) { app.showToast(errText(e)); } finally { setBusy(false); }
  };
  return (
    <div id={`action-${row.id}`} style={{ ...card, marginBottom: 8, borderLeft: `3px solid ${d.color}` }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={pill(d.color, '#fff')}>{d.label}</span>
        <ClassPill cls={row.class} />
        <span style={{ ...mono, fontSize: 12.5, fontWeight: 600 }}>{row.tool}</span>
        <span style={faint}>{agent ? `by ${agent.name}` : ''} · {ago(row.createdAt)} · [{row.id.slice(0, 8)}]</span>
      </div>
      <div style={{ fontSize: 12.5, marginBottom: 6 }}>{heldReason(row)}</div>
      <div style={{ ...label, marginBottom: 3 }}>{row.status === 'staged' ? 'The draft that will be sent' : 'Exactly what will run'}</div>
      <pre style={{ ...mono, fontSize: 11.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--code)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 8, margin: 0, maxHeight: 260, overflowY: 'auto' }}>{actionCallText(row)}</pre>
      {row.status === 'staged' && row.note && <div style={{ ...faint, marginTop: 4, overflowWrap: 'anywhere' }}>Staged: {row.note.slice(0, 300)}{row.stagedRef ? ` (draft ${row.stagedRef.slice(0, 16)})` : ''}</div>}
      {owner ? (
        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <input aria-label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" style={{ ...input, flex: '1 1 160px', width: 'auto' }} />
          <button style={btn(true)} disabled={busy} onClick={() => void key(true)} title={`Runs ${row.tool} with the input shown above`}>{keyButtonLabel(row)}</button>
          <button style={btn(false, true)} disabled={busy} onClick={() => void key(false)}>{row.status === 'staged' ? 'Don\'t send' : 'Deny'}</button>
        </div>
      ) : <div style={{ ...faint, marginTop: 6 }}>Only the owner or the organization's CEO holds this key.</div>}
    </div>
  );
}

/** The exact call behind a `two_key` approval card (the card's own buttons decide it). */
export function ActionCallPreview({ wsId, actionId }: { wsId: string; actionId: string }) {
  const [row, setRow] = useState<ActionLogRow | null | undefined>(undefined);
  useEffect(() => { void api.workspaceAction(wsId, actionId).then(setRow).catch(() => setRow(null)); }, [wsId, actionId]);
  if (row === undefined) return <div style={faint}>Loading the call…</div>;
  if (row === null) return <div style={faint}>The action could not be loaded.</div>;
  if (row.status !== 'held' && row.status !== 'staged') return <div style={faint}>Already decided: {row.status}.</div>;
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}><ClassPill cls={row.class} /><span style={{ fontSize: 12.5 }}>{heldReason(row)}</span></div>
      <pre style={{ ...mono, fontSize: 11.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--code)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 8, margin: 0, maxHeight: 260, overflowY: 'auto' }}>{actionCallText(row)}</pre>
      <div style={faint}>Approve {row.status === 'staged' ? 'sends this draft' : 'runs exactly this call'}; reject drops it.</div>
    </div>
  );
}

/** In a chat tool card: the parked action (its id rides on the tool result) with the key inline. */
export function HeldInline({ wsId, actionId }: { wsId: string; actionId: string }) {
  const [row, setRow] = useState<ActionLogRow | null | undefined>(undefined);
  const load = useCallback(async () => { setRow(await api.workspaceAction(wsId, actionId).catch(() => null)); }, [wsId, actionId]);
  useEffect(() => { void load(); }, [load]);
  if (row === undefined) return <div style={{ ...faint, padding: '6px 0' }}>Loading the held action…</div>;
  if (row === null) return <div style={{ ...faint, padding: '6px 0' }}>The action could not be loaded.</div>;
  if (row.status !== 'held' && row.status !== 'staged') return <div style={{ ...faint, padding: '6px 0' }}>Decided: {row.status}{row.result ? ` — ${row.result.slice(0, 160)}` : ''}.</div>;
  return <HeldActionCard wsId={wsId} row={row} onDone={load} />;
}

// ---- the agent page's Trust tab ----

export function AgentTrustTab({ agentId, wsId }: { agentId: string; wsId: string }) {
  const app = useApp();
  const owner = useIsOwner();
  const [o, setO] = useState<TrustOverview | null>(null);
  const [log, setLog] = useState<ActionLogRow[]>([]);
  const [cls, setCls] = useState('');
  const [reverting, setReverting] = useState<string | null>(null);
  const [revertNote, setRevertNote] = useState('');
  const refresh = useCallback(async () => {
    const [t, l] = await Promise.all([api.workspaceTrust(wsId).catch(() => null), api.workspaceActions(wsId, { agentId, cls: cls || undefined, limit: 100 }).catch((): ActionLogRow[] => [])]);
    setO(t); setLog(l);
  }, [wsId, agentId, cls]);
  useEffect(() => { void refresh(); }, [refresh]);
  const mine = trustRows(o, { withRead: true }).find((r) => r.agentId === agentId);
  const revert = async (r: ActionLogRow) => {
    try { await api.reportActionRevert(wsId, r.id, revertNote.trim()); setReverting(null); setRevertNote(''); await refresh(); app.showToast('Reported — the ledger demotes this class (an incident for an org member)'); } catch (e) { app.showToast(errText(e)); }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 900 }}>
      <div style={{ ...card, padding: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Trust levels</div>
        {!mine && <div style={faint}>{o ? 'No ledger rows yet — they are created on first use.' : 'Loading…'}</div>}
        {mine && (
          <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
            {mine.cells.map((c) => (
              <div key={c.cls} title={c.title} style={{ border: '1px solid var(--border-soft)', borderRadius: 10, padding: '8px 10px' }}>
                <ClassPill cls={c.cls} />
                <div style={{ ...mono, fontSize: 20, fontWeight: 700, marginTop: 4, color: LEVEL_COLOR[c.effective] }}>{c.effective}<span style={{ fontSize: 12, color: 'var(--text-faint)' }}> / {c.ceiling}</span></div>
                <div style={{ fontSize: 11.5 }}>{LEVEL_LEGEND[c.effective]?.label}{c.capped ? ` (earned ${c.level})` : ''}</div>
                <div style={{ ...faint, fontSize: 11 }}>{c.clean} clean{c.rejectStreak ? ` · ${c.rejectStreak} rejected in a row` : ''}{c.lastIncidentAt ? ` · incident ${ago(c.lastIncidentAt)}` : ''}</div>
              </div>
            ))}
          </div>
        )}
        <div style={{ marginTop: 10 }}><LevelLegend /></div>
        {owner && <div style={{ ...faint, marginTop: 6 }}>Ceilings and overrides: Settings → Workspace → Trust.</div>}
      </div>
      <div style={{ ...card, padding: 16 }}><HeldActions wsId={wsId} agentId={agentId} onChanged={() => void refresh()} /></div>
      <div style={{ ...card, padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>Action log</div>
          <select aria-label="Filter by class" value={cls} onChange={(e) => setCls(e.target.value)} style={{ ...input, width: 'auto' }}>
            <option value="">Every class</option>{ACTION_CLASSES.map((c) => <option key={c} value={c}>{CLASS_LABEL[c]}</option>)}
          </select>
        </div>
        {log.length === 0 && <div style={faint}>No logged actions. Reads are never logged; everything that writes or leaves the workspace is.</div>}
        {log.map((r) => {
          const d = actionDecisionLabel(r);
          const outward = r.class === 'external_reversible' || r.class === 'external_irreversible' || r.class === 'money';
          return (
            <div key={r.id} style={{ borderTop: '1px solid var(--border-soft)', padding: '6px 0' }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={pill(d.color, '#fff')}>{d.label}</span>
                <ClassPill cls={r.class as ActionClass} />
                <span style={{ ...mono, fontSize: 12 }}>{r.tool}</span>
                <span style={{ ...faint, fontSize: 11 }}>{r.status}{r.level !== null ? ` · level ${r.level}` : ''}{r.dedupeCount ? ` · ×${r.dedupeCount + 1}` : ''} · {ago(r.createdAt)}</span>
                {r.revertedAt && <span style={pill('var(--red)', '#fff')}>reverted</span>}
                {owner && r.status === 'succeeded' && !r.revertedAt && outward && reverting !== r.id && <button style={{ ...linkBtn, marginLeft: 'auto', color: 'var(--red)' }} onClick={() => { setReverting(r.id); setRevertNote(''); }}>Report revert</button>}
              </div>
              <details><summary style={{ cursor: 'pointer', ...faint, fontSize: 11 }}>call and result</summary>
                <pre style={{ ...mono, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--panel-2)', padding: 6, borderRadius: 6, margin: '4px 0 0' }}>{actionCallText(r)}{r.result ? `\n→ ${r.result.slice(0, 600)}` : ''}{r.note ? `\nnote: ${r.note}` : ''}</pre>
              </details>
              {reverting === r.id && (
                <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                  <input aria-label="What had to be undone" value={revertNote} onChange={(e) => setRevertNote(e.target.value)} placeholder="What had to be undone, and why" style={{ ...input, flex: '1 1 200px', width: 'auto' }} />
                  <button style={btn(false, true)} onClick={() => void revert(r)}>Report revert</button>
                  <button style={btn()} onClick={() => setReverting(null)}>Cancel</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
