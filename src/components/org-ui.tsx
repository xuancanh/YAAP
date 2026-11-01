/** Shared primitives of the organization panes (OrganizationView and the
 *  CEO's-seat panes of docs/company-vision.md §8): the card, input, button
 *  and pill styles, the agent avatar, relative time, and the unit lookups. */
/* eslint-disable react-refresh/only-export-components */
import { useMemo } from 'react';
import { decisionExtras } from '../lib/org3';
import { useApp, grad } from '../store';
import type { Agent, OrgUnitNode } from '../lib/api';

export const card: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 13, background: 'var(--panel)', padding: '14px 16px' };
export const input: React.CSSProperties = { background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '7px 10px', color: 'var(--text)', fontSize: 12.5, outline: 'none', width: '100%' };
export const btn = (primary = false, danger = false): React.CSSProperties => ({
  background: primary ? 'var(--accent)' : danger ? 'var(--red)' : 'var(--panel-2)', color: primary || danger ? '#fff' : 'var(--text)',
  border: primary || danger ? 'none' : '1px solid var(--border)', borderRadius: 8, padding: '6px 11px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
});
export const pill = (bg = 'var(--panel-2)', color = 'var(--text-dim)'): React.CSSProperties => ({ fontSize: 10.5, background: bg, color, border: '1px solid var(--border-soft)', borderRadius: 6, padding: '1px 7px', whiteSpace: 'nowrap' });
export const h2: React.CSSProperties = { fontSize: 15, fontWeight: 700, margin: 0 };
export const faint: React.CSSProperties = { fontSize: 12, color: 'var(--text-faint)' };
export const linkBtn: React.CSSProperties = { background: 'none', border: 'none', color: 'var(--accent-hi)', cursor: 'pointer', padding: 0, fontSize: 12, fontWeight: 600 };
export const label: React.CSSProperties = { fontSize: 10.5, fontWeight: 600, letterSpacing: '.4px', textTransform: 'uppercase', color: 'var(--text-faint)' };

export function ago(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'now'; if (m < 60) return `${m}m ago`; if (m < 1440) return `${Math.floor(m / 60)}h ago`; return `${Math.floor(m / 1440)}d ago`;
}

export function useAgentNames() {
  const app = useApp();
  return useMemo(() => new Map(app.agents.map((a) => [a.id, a])), [app.agents]);
}

/** Every unit, depth-first, with its depth (docs/group-chat.md §7). */
export function flattenUnits(nodes: OrgUnitNode[], depth = 0): Array<OrgUnitNode & { depth: number }> {
  return nodes.flatMap((n) => [{ ...n, depth }, ...flattenUnits(n.children, depth + 1)]);
}

/** The unit tree of the current workspace plus the lookups the panes share. */
export function useUnits() {
  const app = useApp();
  const units = useMemo(() => flattenUnits(app.wsOrg?.units ?? []), [app.wsOrg]);
  const root = units.find((u) => u.parentUnitId === null) ?? null;
  const byId = useMemo(() => new Map(units.map((u) => [u.id, u])), [units]);
  /** The pane's unit: the selected one, else the root. */
  const current = app.orgUnitId ? byId.get(app.orgUnitId) ?? root : root;
  return { units, root, byId, current, isCompany: !app.orgUnitId || app.orgUnitId === root?.id };
}

export function Avatar({ a, size = 22 }: { a?: Agent; size?: number }) {
  return <span style={{ width: size, height: size, borderRadius: 7, background: a ? grad(a.colors) : 'var(--panel-2)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.55, flex: 'none' }}>{a?.emoji ?? '?'}</span>;
}

/** The unit filter chips every scoped pane shows (Board, Goals, Vision, Meetings, Decisions). */
export function UnitChips({ count, title }: { count?: (u: OrgUnitNode) => number | string | null; title?: (u: OrgUnitNode) => string }) {
  const app = useApp();
  const names = useAgentNames();
  const { units, isCompany } = useUnits();
  if (units.length <= 1) return null;
  return (
    <div role="tablist" aria-label="Unit" style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 12 }}>
      {units.map((u) => {
        const active = (u.parentUnitId === null && isCompany) || (u.parentUnitId !== null && app.orgUnitId === u.id);
        const n = count?.(u);
        return (
          <button key={u.id} role="tab" aria-selected={active} title={title?.(u)} onClick={() => app.setOrgUnitId(u.parentUnitId === null ? null : u.id)}
            style={{ ...pill(active ? 'var(--accent)' : 'var(--panel-2)', active ? '#fff' : 'var(--text)'), display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', cursor: 'pointer', marginLeft: u.depth > 1 ? (u.depth - 1) * 6 : 0 }}>
            {u.parentUnitId === null ? '🏢 Company' : <><Avatar a={names.get(u.leadAgentId)} size={14} />{u.name}</>}
            {n !== null && n !== undefined && n !== 0 && <span style={{ opacity: .7 }}>{n}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** A right-hand drawer over the pane (the task drawer, the Why drawer). */
export function Drawer({ onClose, children, width = 560 }: { onClose: () => void; children: React.ReactNode; width?: number }) {
  return (
    <div role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 90, display: 'flex', justifyContent: 'flex-end' }} onClick={onClose} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: `min(${width}px, 100%)`, background: 'var(--bg)', borderLeft: '1px solid var(--border)', height: '100%', overflowY: 'auto', padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {children}
      </div>
    </div>
  );
}

/** Follow a reference to the pane that shows it (docs/company-vision.md §6,
 *  §8): a task opens the board drawer, a decision the log, a goal the vision
 *  page, a meeting its thread, a plan the Plans pane, an audit row or a day
 *  the Replay pane (`id` is the YYYY-MM-DD), a member its home page; a metric
 *  source, an incident or an experiment its pane (items 27–30), a held action
 *  the Approvals pane's key list. Used by
 *  citation chips, the Related drawer and the replay timeline. */
export function useFollowRef() {
  const app = useApp();
  return (kind: string, id: string) => {
    app.setMobileDetail(true);
    if (kind === 'task') { app.setOrgFocus({ kind: 'task', id }); app.setOrgPane('board'); }
    else if (kind === 'decision') { app.setOrgFocus({ kind: 'decision', id }); app.setOrgPane('decisions'); }
    else if (kind === 'goal' || kind === 'objective' || kind === 'key_result' || kind === 'vision') { app.setOrgFocus({ kind: 'goal', id }); app.setOrgUnitId(null); app.setOrgPane('vision'); }
    else if (kind === 'meeting') { app.setOrgFocus({ kind: 'meeting', id }); app.setOrgPane('meetings'); }
    else if (kind === 'plan') { app.setOrgFocus({ kind: 'plan', id }); app.setOrgPane('plans'); }
    else if (kind === 'playbook') { app.setOrgFocus({ kind: 'playbook', id }); app.setOrgPane('playbooks'); }
    else if (kind === 'day' || kind === 'replay') { app.setOrgFocus({ kind: 'replay', id }); app.setOrgPane('replay'); }
    else if (kind === 'source' || kind === 'metric_source') { app.setOrgFocus({ kind: 'source', id }); app.setOrgPane('metrics'); }
    else if (kind === 'incident') { app.setOrgFocus({ kind: 'incident', id }); app.setOrgPane('incidents'); }
    else if (kind === 'experiment') { app.setOrgFocus({ kind: 'experiment', id }); app.setOrgPane('experiments'); }
    else if (kind === 'action') { app.setOrgFocus({ kind: 'action', id }); app.setOrgPane('approvals'); }
    else if (kind === 'audit') app.setOrgPane('audit');
    else if (kind === 'signal') app.setOrgPane('pulse');
    else if (kind === 'approval') app.setOrgPane('approvals');
    else if (kind === 'agent' || kind === 'member') app.openAgent(id);
    else if (kind === 'unit') { app.setOrgUnitId(id); app.setOrgPane('board'); }
    else return false;
    return true;
  };
}

/** The decision card (execution-plan item 31, docs/owners-seat.md §1):
 *  recommended action, alternatives, reversibility, confidence, the deadline
 *  with its countdown and the default applied at it — whichever the card
 *  carries. `skip` drops fields the caller already shows. */
export function DecisionExtras({ source, skip }: { source: Record<string, unknown> | null | undefined; skip?: string[] }) {
  const rows = decisionExtras(source, skip);
  if (rows.length === 0) return null;
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(90px, max-content) 1fr', gap: '3px 10px', margin: '6px 0', fontSize: 12.5 }}>
      {rows.map((r) => (
        <div key={r.key} style={{ display: 'contents' }}>
          <dt style={{ ...label, alignSelf: 'baseline' }}>{r.label}</dt>
          <dd style={{ margin: 0, overflowWrap: 'anywhere', color: r.tone === 'red' ? 'var(--red)' : r.tone === 'amber' ? 'var(--amber)' : undefined, fontWeight: r.key === 'recommendedAction' ? 600 : undefined }}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}
