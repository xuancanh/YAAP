/** Item 31 on screen (docs/boundary.md, docs/evals.md, docs/owners-seat.md;
 *  SPA item 32 part two): Settings' delegations and the boundary table, the
 *  capacity strip on the board, and the eval line a gated charter or routing
 *  card carries. Eval results and outcomes are mirrored to /org/evals/ and
 *  /org/outcomes.md in Artifacts (docs/filesystem.md). */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { api, type BoundaryRule, type CardEval, type HumanRole, type OrgCapacity, type OrgDelegation, type OrgHuman } from '../lib/api';
import { delegationOptions, evalRunText, fmtUsd2, VERDICT_COLOR, VERDICT_LABEL_B, wipLabel, CLASS_LABEL } from '../lib/org3';
import { card, input, btn, pill, faint, label, linkBtn, ago, useAgentNames, Avatar } from './org-ui';

const mono: React.CSSProperties = { fontFamily: 'var(--mono)' };
const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^\d{3} /, '').slice(0, 220) : 'failed');

// ---- Evals ----

/** The eval result a gated charter or routing card carries (`payload.eval`). */
export function CardEvalLine({ ev }: { ev: CardEval | undefined }) {
  if (!ev) return null;
  const t = evalRunText({ passRate: ev.passRate, baselinePassRate: ev.baselinePassRate, verdict: ev.verdict });
  return (
    <div role="status" style={{ fontSize: 12.5, marginTop: 6, padding: '6px 8px', borderRadius: 8, border: `1px solid ${t.color}`, color: t.color }}>
      Eval{ev.roleKey ? ` (${ev.roleKey})` : ''}: {ev.passRate === null && ev.baselinePassRate === null ? ev.verdict : t.text}{ev.summary ? <div style={{ ...faint, marginTop: 2 }}>{ev.summary}</div> : null}
    </div>
  );
}

// ---- Outcomes ----

export function GovernanceSettings({ wsId }: { wsId: string }) {
  const app = useApp();
  const [rules, setRules] = useState<BoundaryRule[]>([]);
  const [dels, setDels] = useState<OrgDelegation[] | null>(null);
  const [humans, setHumans] = useState<{ me: HumanRole | null; list: OrgHuman[] }>({ me: null, list: [] });
  const [err, setErr] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const [b, d, h] = await Promise.all([api.orgBoundary(wsId), api.orgDelegations(wsId), api.orgHumans(wsId).catch(() => null)]);
      setRules(b.rules); setDels(d); if (h) setHumans({ me: h.me.role, list: h.humans }); setErr(null);
    } catch (e) { setErr(errText(e)); }
  }, [wsId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const isCeo = humans.me === 'ceo';
  if (err) return null;
  return (
    <>
      <div style={{ ...card, padding: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Delegated approvals</div>
        <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 3 }}>Routine cards can be decided by someone else: a person with standing, or a member role (judged on another model family; "ask" leaves the card to you). The constitution, caps, the kill switch, the external floor, trust ceilings, audit settings, delegation itself and metric sources are never delegable.</div>
        {dels !== null && dels.length === 0 && <div style={{ ...faint, marginTop: 8 }}>No delegations — every card comes to you.</div>}
        {(dels ?? []).map((d) => (
          <div key={d.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '6px 0', borderTop: '1px solid var(--border-soft)', marginTop: 6 }}>
            <span style={pill('var(--accent-dim)', 'var(--text)')}>{CLASS_LABEL[d.kind] ? `${CLASS_LABEL[d.kind]} actions` : d.kind}</span>
            <span style={{ fontSize: 12.5, flex: 1, minWidth: 160 }}>→ {d.delegateType === 'human' ? `🧑 ${app.nameOf(d.delegateRef)}` : `the ${d.delegateRef} role`}{d.maxUsd !== null ? ` · up to ${fmtUsd2(d.maxUsd)}` : ''}</span>
            <span style={faint}>{ago(d.createdAt)}</span>
            {isCeo && <button style={{ ...linkBtn, color: 'var(--red)' }} onClick={() => void (async () => { try { await api.revokeOrgDelegation(wsId, d.id); await refresh(); app.showToast('Revoked'); } catch (e) { app.showToast(errText(e)); } })()}>Revoke</button>}
          </div>
        ))}
        {isCeo && <DelegationForm wsId={wsId} rules={rules} humans={humans.list} onDone={refresh} />}
      </div>
      <div style={{ ...card, padding: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>The self-modification boundary</div>
        <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 3 }}>What the organization may change about itself, and how. Read-only: it is the rule every self-change path asks first. Humans are not bound, except where it says everyone.</div>
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
            <thead><tr>{['Change', 'Scope', 'Verdict', 'Why'].map((h) => <th key={h} scope="col" style={{ textAlign: 'left', padding: '4px 6px', ...label }}>{h}</th>)}</tr></thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} style={{ borderTop: '1px solid var(--border-soft)' }}>
                  <td style={{ padding: '5px 6px', ...mono, whiteSpace: 'nowrap' }}>{r.kind}</td>
                  <td style={{ padding: '5px 6px', minWidth: 120 }}>{r.match}</td>
                  <td style={{ padding: '5px 6px', whiteSpace: 'nowrap' }}><span style={pill(VERDICT_COLOR[r.verdict] ?? 'var(--panel-2)', '#fff')}>{VERDICT_LABEL_B[r.verdict] ?? r.verdict}</span>{r.everyone ? <span style={{ ...faint, marginLeft: 4 }}>everyone</span> : null}{r.verdict === 'propose' && !r.delegable ? <span style={{ ...faint, marginLeft: 4 }} title="A card of this change is never decided by a delegate">not delegable</span> : null}</td>
                  <td style={{ padding: '5px 6px', minWidth: 180, color: 'var(--text-dim)' }}>{r.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function DelegationForm({ wsId, rules, humans, onDone }: { wsId: string; rules: BoundaryRule[]; humans: OrgHuman[]; onDone: () => Promise<void> }) {
  const app = useApp();
  const options = useMemo(() => delegationOptions(rules), [rules]);
  const [kind, setKind] = useState('');
  const [maxUsd, setMaxUsd] = useState('');
  const [type, setType] = useState<'human' | 'role'>('human');
  const [ref, setRef] = useState('');
  const opt = options.find((o) => o.kind === kind);
  const people = humans.filter((h) => h.role === 'ceo' || h.role === 'board' || h.role === 'employee');
  const ok = kind && !opt?.disabled && ref.trim() && (maxUsd.trim() === '' || Number.isFinite(Number(maxUsd)));
  const save = async () => {
    try { await api.addOrgDelegation(wsId, { kind, maxUsd: maxUsd.trim() === '' ? null : Number(maxUsd), delegateType: type, delegateRef: ref.trim() }); setKind(''); setRef(''); setMaxUsd(''); await onDone(); app.showToast('Delegated (audited)'); } catch (e) { app.showToast(errText(e)); }
  };
  return (
    <div role="form" aria-label="Add a delegation" style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', alignItems: 'end', marginTop: 10 }}>
      <div><label style={label} htmlFor="dl-kind">Cards of</label>
        <select id="dl-kind" value={kind} onChange={(e) => setKind(e.target.value)} style={input}>
          <option value="">Pick a kind or class…</option>
          {options.map((o) => <option key={o.kind} value={o.kind} disabled={o.disabled} title={o.note}>{o.label}{o.disabled ? ' — never delegable' : ''}</option>)}
        </select></div>
      <div><label style={label} htmlFor="dl-max">Up to (USD, optional)</label><input id="dl-max" value={maxUsd} onChange={(e) => setMaxUsd(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" style={{ ...input, ...mono }} /></div>
      <div><label style={label} htmlFor="dl-type">Delegate</label>
        <select id="dl-type" value={type} onChange={(e) => { setType(e.target.value as 'human' | 'role'); setRef(''); }} style={input}><option value="human">a person</option><option value="role">a member role</option></select></div>
      <div>{type === 'human'
        ? <><label style={label} htmlFor="dl-ref">Person</label><select id="dl-ref" value={ref} onChange={(e) => setRef(e.target.value)} style={input}><option value="">Pick…</option>{people.map((h) => <option key={h.id} value={h.memberAccountId}>{app.nameOf(h.memberAccountId)} ({h.role})</option>)}</select></>
        : <><label style={label} htmlFor="dl-ref">Role (member title)</label><input id="dl-ref" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="controller" style={input} /></>}</div>
      <button style={btn(true)} disabled={!ok} onClick={() => void save()}>Delegate</button>
      {opt?.note && <div style={{ gridColumn: '1 / -1', fontSize: 12, color: opt.disabled ? 'var(--red)' : 'var(--amber)' }}>{opt.disabled ? 'Never delegable: ' : 'Note: '}{opt.note}</div>}
    </div>
  );
}

// ---- capacity on the board ----

/** Members' open work against the WIP limit (GET …/org/capacity). */
export function CapacityStrip({ wsId, refreshKey }: { wsId: string; refreshKey?: unknown }) {
  const names = useAgentNames();
  const [cap, setCap] = useState<OrgCapacity | null>(null);
  useEffect(() => { void api.orgCapacity(wsId).then(setCap).catch(() => setCap(null)); }, [wsId, refreshKey]);
  if (!cap || cap.members.length === 0) return null;
  return (
    <div aria-label="Work in progress per member" style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
      <span style={label} title="capacity.wipPerMember: open tasks (todo, claimed, in progress, blocked) a member may hold">WIP ≤ {cap.wip}</span>
      {cap.members.map((m) => {
        const w = wipLabel(m);
        return (
          <span key={m.agentId} title={`${m.name}${m.title ? ` (${m.title})` : ''}: ${m.open} open of ${m.wip}${m.atLimit ? ' — at the limit, assignments are refused' : ''}${m.tasks.length ? `\n${m.tasks.map((t) => `· ${t.title} (${t.status})`).join('\n')}` : ''}`}
            style={{ ...pill('var(--panel-2)', w.color), display: 'inline-flex', gap: 4, alignItems: 'center', borderColor: m.atLimit ? 'var(--red)' : undefined }}>
            <Avatar a={names.get(m.agentId)} size={13} />{m.name} {w.text}
          </span>
        );
      })}
    </div>
  );
}
