/**
 * The org chart as mission control (docs/mission-control.md): Company →
 * People & money → Org chart. One request
 * (`GET /api/workspaces/:id/org/mission-control`) draws it:
 *
 *  - a strip of totals (erroring, blocked, working, idle, paused; tasks in
 *    flight; what waits on you; spend today against the envelope), the
 *    filters (all, needs attention, blocked, erroring; a unit; a search);
 *  - the hierarchy, chief → leads → members (and human employees), each a
 *    card with its live status, what it is doing or blocked on, WIP against
 *    the limit, its last heartbeat and its spend; subtrees fold; a long
 *    row of members stacks; the chart scrolls sideways inside its own box;
 *    on a phone it is an indented list;
 *  - the waiting chains: pick an agent and everyone on its chain (who it
 *    waits on, who waits on it, up to you) is outlined;
 *  - a side panel with the agent's overview in compact form, and links to
 *    its page, a chat and its unit's board.
 *
 * The structure editor (add, hire, scopes, pause, terminate, the humans) is
 * one click away: "Edit structure" in the pane header.
 *
 * `MissionControlBoard` is presentational (web-tests/mission-control.test.tsx);
 * `MissionControlPane` loads it and keeps it live.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp, grad } from '../store';
import { api, type MissionControl, type MissionNode, type OrgDetail } from '../lib/api';
import { usd, when } from '../lib/home';
import {
  NO_FILTER, STATE_COLOR, STATE_WORD, buildForest, chainHighlight, flattenForest, matching, nodeLine, totalsLine, waitChain,
  type MissionFilter, type MissionOnly, type TreeNode,
} from '../lib/overview';
import { AgentOverviewPanel } from './AgentDashboard';
import { Drawer } from './org-ui';

const panel: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 12, background: 'var(--panel)' };
const faint: React.CSSProperties = { fontSize: 11.5, color: 'var(--text-faint)' };
const ctl: React.CSSProperties = { background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px', color: 'var(--text)', fontSize: 12.5, outline: 'none', font: 'inherit' };
const btn = (on = false): React.CSSProperties => ({ ...ctl, cursor: 'pointer', fontWeight: 600, fontSize: 12, background: on ? 'var(--accent)' : 'var(--panel-2)', color: on ? '#fff' : 'var(--text)', borderColor: on ? 'var(--accent)' : 'var(--border)', flex: 'none' });
const clamp = (lines: number): React.CSSProperties => ({ display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical', overflow: 'hidden' });
const LINE = 'var(--border)';
const CARD_W = 228;
/** A row of more leaves than this under one manager stacks into a column. */
const STACK_AT = 4;

const ONLY: Array<{ id: MissionOnly; label: string }> = [
  { id: 'all', label: 'Everyone' }, { id: 'attention', label: 'Needs attention' }, { id: 'blocked', label: 'Blocked' }, { id: 'error', label: 'Erroring' },
];

function Avatar({ emoji, colors, size = 26 }: { emoji: string; colors: string; size?: number }) {
  return <span aria-hidden style={{ width: size, height: size, borderRadius: size * 0.3, background: grad(colors), display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.55, flex: 'none' }}>{emoji}</span>;
}

export interface MissionBoardProps {
  mc: MissionControl;
  now?: Date;
  /** Phone width: the indented list instead of the tree. */
  narrow?: boolean;
  initialFilter?: MissionFilter;
  selected?: string | null;
  onSelect: (agentId: string) => void;
  onWaitingOnYou?: () => void;
  onOpenUnit?: (unitId: string) => void;
  nameOfHuman?: (memberAccountId: string) => string;
}

/** One agent's card. */
function NodeCard({ n, mc, now, selected, lit, dimmed, childCount, collapsed, onToggle, onSelect, onOpenUnit, wide }: {
  n: MissionNode; mc: MissionControl; now: Date; selected: boolean; lit: boolean; dimmed: boolean; childCount: number; collapsed: boolean;
  onToggle: () => void; onSelect: () => void; onOpenUnit?: (unitId: string) => void; wide?: boolean;
}) {
  const color = STATE_COLOR[n.state];
  const unit = n.leadsUnitId ? mc.units.find((u) => u.id === n.leadsUnitId) : null;
  const overWip = n.wip.open >= n.wip.limit;
  return (
    <div data-testid={`node-${n.agentId}`} data-state={n.state} data-lit={lit ? 'true' : undefined}
      style={{
        ...panel, width: wide ? '100%' : CARD_W, padding: '9px 11px 8px', borderTop: `3px solid ${color}`, position: 'relative', textAlign: 'left',
        outline: selected ? '2px solid var(--accent)' : lit ? '2px solid var(--amber)' : 'none', outlineOffset: 1, opacity: dimmed ? 0.45 : 1, boxSizing: 'border-box',
      }}>
      <button onClick={onSelect} aria-label={`${n.name}: ${STATE_WORD[n.state]}`} style={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%' }}>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Avatar emoji={n.emoji} colors={n.colors} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.name}</span>
              <span style={{ fontSize: 10.5, fontWeight: 650, color, flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {n.live && <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: color, animation: 'pulse 1.4s ease-in-out infinite' }} />}
                {STATE_WORD[n.state]}
              </span>
            </span>
            <span style={{ ...faint, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.isChief ? 'Chief of staff' : n.title || 'Member'}</span>
          </span>
        </span>
        <span style={{ display: 'block', fontSize: 12, marginTop: 6, color: n.state === 'error' ? 'var(--red)' : 'var(--text-dim)', minHeight: 32, ...clamp(2) }}>{nodeLine(n)}</span>
        <span style={{ ...faint, display: 'flex', gap: 8, marginTop: 5, flexWrap: 'wrap' }}>
          <span style={{ color: overWip ? 'var(--amber)' : undefined }} title="Open tasks against the WIP limit">{n.wip.open}/{n.wip.limit} WIP</span>
          <span title="Last heartbeat">{n.lastBeatAt ? `beat ${when(n.lastBeatAt, now)}` : 'no beat yet'}</span>
          <span title="Spend today">{usd(n.spend.todayUsd)}</span>
        </span>
      </button>
      {(n.waitingOnYou > 0 || unit || childCount > 0) && (
        <span style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
          {n.waitingOnYou > 0 && <span style={{ fontSize: 10.5, fontWeight: 650, color: 'var(--red)' }}>waits on you · {n.waitingOnYou}</span>}
          {unit && (
            <button onClick={() => onOpenUnit?.(unit.id)} title="Open the unit's board" style={{ all: 'unset', cursor: 'pointer', fontSize: 10.5, color: 'var(--accent-hi)', fontWeight: 600 }}>
              {unit.parentUnitId === null ? 'Company' : unit.name} · {unit.openTasks} open
            </button>
          )}
          <span style={{ flex: 1 }} />
          {childCount > 0 && (
            <button onClick={onToggle} aria-expanded={!collapsed} aria-label={`${collapsed ? 'Show' : 'Hide'} ${n.name}'s ${childCount} reports`}
              style={{ all: 'unset', cursor: 'pointer', fontSize: 10.5, color: 'var(--text-dim)', fontWeight: 600, padding: '0 2px' }}>
              {collapsed ? `▸ ${childCount}` : '▾'}
            </button>
          )}
        </span>
      )}
    </div>
  );
}

function HumanCard({ name, title, wide }: { name: string; title: string; wide?: boolean }) {
  return (
    <div style={{ ...panel, width: wide ? '100%' : CARD_W, padding: '8px 11px', borderTop: '3px solid var(--blue)', boxSizing: 'border-box', display: 'flex', gap: 8, alignItems: 'center' }}>
      <span aria-hidden style={{ width: 26, height: 26, borderRadius: 8, background: 'var(--panel-2)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, flex: 'none' }}>🧑</span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13, fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        <span style={{ ...faint, display: 'block' }}>Person{title ? ` · ${title}` : ''}</span>
      </span>
    </div>
  );
}

export function MissionControlBoard({ mc, now = new Date(), narrow = false, initialFilter = NO_FILTER, selected = null, onSelect, onWaitingOnYou, onOpenUnit, nameOfHuman = (id) => id.slice(0, 8) }: MissionBoardProps) {
  const [filter, setFilter] = useState<MissionFilter>(initialFilter);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const kept = useMemo(() => matching(mc, filter), [mc, filter]);
  const filtering = filter.only !== 'all' || Boolean(filter.unitId) || Boolean(filter.q.trim());
  const forest = useMemo(() => buildForest(mc.nodes, filtering ? kept : undefined), [mc.nodes, kept, filtering]);
  const lit = useMemo(() => chainHighlight(mc.edges, selected), [mc.edges, selected]);
  const toggle = (id: string) => setCollapsed((c) => { const next = new Set(c); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const humansOf = (agentId: string) => mc.humans.filter((h) => h.reportsToAgentId === agentId);
  const t = mc.totals;
  const cap = t.monthCapUsd ?? 0;
  const ratio = cap > 0 && t.monthUsd !== null ? t.monthUsd / cap : 0;
  const card = (n: MissionNode, childCount: number, wide = false) => (
    <NodeCard n={n} mc={mc} now={now} selected={selected === n.agentId} lit={lit.has(n.agentId)} dimmed={filtering && !kept.has(n.agentId)}
      childCount={childCount} collapsed={collapsed.has(n.agentId)} onToggle={() => toggle(n.agentId)} onSelect={() => onSelect(n.agentId)} onOpenUnit={onOpenUnit} wide={wide} />
  );

  /** A subtree: the card, a stem, and the children in a row joined by a rail (or stacked, when they are many leaves). */
  const subtree = (tn: TreeNode): React.ReactNode => {
    const humans = humansOf(tn.node.agentId);
    const count = tn.children.length + humans.length;
    const open = count > 0 && !collapsed.has(tn.node.agentId);
    const leaves = tn.children.every((c) => c.children.length === 0 && humansOf(c.node.agentId).length === 0);
    const stack = open && leaves && count > STACK_AT;
    return (
      <div key={tn.node.agentId} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {card(tn.node, count)}
        {open && <div aria-hidden style={{ width: 1, height: 14, background: LINE }} />}
        {stack && (
          <div role="group" aria-label={`${tn.node.name}'s reports`} style={{ display: 'flex', flexDirection: 'column', gap: 8, borderLeft: `1px solid ${LINE}`, paddingLeft: 12, marginLeft: 24 }}>
            {tn.children.map((c) => <div key={c.node.agentId}>{card(c.node, 0)}</div>)}
            {humans.map((h) => <HumanCard key={h.id} name={nameOfHuman(h.memberAccountId)} title={h.title} />)}
          </div>
        )}
        {open && !stack && (
          <div role="group" aria-label={`${tn.node.name}'s reports`} style={{ display: 'flex', alignItems: 'flex-start' }}>
            {[...tn.children.map((c) => ({ key: c.node.agentId, el: subtree(c) })), ...humans.map((h) => ({ key: h.id, el: <HumanCard name={nameOfHuman(h.memberAccountId)} title={h.title} /> }))].map((x, i, all) => (
              <div key={x.key} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative', padding: '0 7px' }}>
                {all.length > 1 && <div aria-hidden style={{ position: 'absolute', top: 0, height: 1, background: LINE, left: i === 0 ? '50%' : 0, right: i === all.length - 1 ? '50%' : 0 }} />}
                <div aria-hidden style={{ width: 1, height: 14, background: LINE }} />
                {x.el}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const rows = flattenForest(forest, collapsed);
  const chain = selected ? waitChain(mc.edges, selected) : [];
  const nameOf = (id: string) => (id === 'ceo' ? 'You' : mc.nodes.find((n) => n.agentId === id)?.name ?? id.slice(0, 8));

  return (
    <div data-testid="mission-control" style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      {/* the strip */}
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: narrow ? 'repeat(2, minmax(0, 1fr))' : 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <div style={{ ...panel, padding: '10px 12px', gridColumn: narrow ? '1 / -1' : 'span 2', minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {(['error', 'blocked', 'working', 'idle', 'paused'] as const).map((st) => (
              <button key={st} onClick={() => setFilter((f) => ({ ...f, only: st === 'error' || st === 'blocked' ? (f.only === st ? 'all' : st) : 'all' }))}
                disabled={st !== 'error' && st !== 'blocked'} data-testid={`total-${st}`}
                style={{ all: 'unset', cursor: st === 'error' || st === 'blocked' ? 'pointer' : 'default', display: 'flex', alignItems: 'baseline', gap: 5 }}>
                <span style={{ fontSize: 20, fontWeight: 700, color: t[st] > 0 && (st === 'error' || st === 'blocked') ? STATE_COLOR[st] : 'var(--text)' }}>{t[st]}</span>
                <span style={{ ...faint, color: STATE_COLOR[st] }}>{STATE_WORD[st].toLowerCase()}</span>
              </button>
            ))}
          </div>
        </div>
        <div style={{ ...panel, padding: '10px 12px', minWidth: 0 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{t.tasksInFlight}</div>
          <div style={faint}>tasks in flight</div>
        </div>
        <button onClick={onWaitingOnYou} data-testid="total-you" style={{ ...panel, padding: '10px 12px', textAlign: 'left', cursor: onWaitingOnYou ? 'pointer' : 'default', color: 'var(--text)', font: 'inherit', minWidth: 0 }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: t.waitingOnYou > 0 ? 'var(--red)' : undefined }}>{t.waitingOnYou}</div>
          <div style={faint}>waiting on you</div>
        </button>
        <div style={{ ...panel, padding: '10px 12px', minWidth: 0, gridColumn: narrow ? '1 / -1' : undefined }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{usd(t.spendTodayUsd)}</div>
          <div style={faint}>today{t.monthUsd !== null ? ` · ${usd(t.monthUsd)}${cap ? ` of ${usd(cap)}` : ''} this month` : ''}</div>
          {cap > 0 && <span aria-hidden style={{ display: 'block', height: 4, borderRadius: 2, background: 'var(--panel-2)', marginTop: 6, overflow: 'hidden' }}><span style={{ display: 'block', height: '100%', width: `${Math.min(100, Math.round(ratio * 100))}%`, background: ratio > 0.9 ? 'var(--red)' : ratio > 0.7 ? 'var(--amber)' : 'var(--green)' }} /></span>}
        </div>
      </div>

      {/* the filters */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <div role="radiogroup" aria-label="Show" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {ONLY.map((o) => <button key={o.id} role="radio" aria-checked={filter.only === o.id} onClick={() => setFilter((f) => ({ ...f, only: o.id }))} style={btn(filter.only === o.id)}>{o.label}</button>)}
        </div>
        {mc.units.length > 1 && (
          <select aria-label="Unit" value={filter.unitId ?? ''} onChange={(e) => setFilter((f) => ({ ...f, unitId: e.target.value || null }))} style={{ ...ctl, maxWidth: '100%' }}>
            <option value="">All units</option>
            {mc.units.filter((u) => u.parentUnitId !== null).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        )}
        <input aria-label="Search" type="search" value={filter.q} onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))} placeholder="Find an agent or a task" style={{ ...ctl, flex: '1 1 160px', minWidth: 0 }} />
      </div>
      <div style={faint} aria-live="polite">
        {totalsLine(t)}{filtering ? ` · showing ${kept.size} of ${mc.nodes.length}` : ''}{mc.edges.length > 0 ? ` · ${mc.edges.length} waiting ${mc.edges.length === 1 ? 'chain' : 'chains'}: pick an agent to trace it` : ''}
      </div>
      {mc.partial.length > 0 && <div role="status" style={{ ...faint, color: 'var(--amber)' }}>Some data could not load: {mc.partial.join(', ')}.</div>}
      {chain.length > 1 && (
        <div data-testid="wait-chain" style={{ fontSize: 12.5, color: 'var(--amber)' }}>Waiting chain: {chain.map(nameOf).join(' → ')}</div>
      )}

      {/* the chart */}
      {filtering && kept.size === 0 ? (
        <div style={{ ...panel, padding: '14px 16px', fontSize: 12.5, color: 'var(--text-dim)' }}>
          No one matches. <button style={{ all: 'unset', cursor: 'pointer', color: 'var(--accent-hi)', fontWeight: 600 }} onClick={() => setFilter(NO_FILTER)}>Show everyone</button>
        </div>
      ) : narrow ? (
        <ul data-testid="mission-list" aria-label="Org chart" style={{ margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((r) => (
            <li key={r.node.agentId} style={{ listStyle: 'none', paddingLeft: Math.min(r.depth, 6) * 14, borderLeft: r.depth > 0 ? `1px solid ${LINE}` : 'none', marginLeft: r.depth > 0 ? 6 : 0 }}>
              {card(r.node, r.childCount + humansOf(r.node.agentId).length, true)}
              {!collapsed.has(r.node.agentId) && humansOf(r.node.agentId).map((h) => <div key={h.id} style={{ paddingLeft: 14, marginTop: 6 }}><HumanCard name={nameOfHuman(h.memberAccountId)} title={h.title} wide /></div>)}
            </li>
          ))}
        </ul>
      ) : (
        <div data-testid="mission-tree" role="tree" aria-label="Org chart" style={{ overflowX: 'auto', overflowY: 'visible', padding: '6px 2px 14px', border: '1px solid var(--border-soft)', borderRadius: 12, background: 'var(--bg)' }}>
          <div style={{ display: 'flex', gap: 24, justifyContent: 'safe center', minWidth: 'max-content', padding: '6px 8px' }}>
            {forest.map((tn) => subtree(tn))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- the container ----

const POLL_MS = 20_000;
const DEBOUNCE_MS = 1_500;

export function MissionControlPane({ org, onEditStructure }: { org: OrgDetail; onEditStructure: () => void }) {
  const app = useApp();
  const wsId = org.workspaceId;
  const [mc, setMc] = useState<MissionControl | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const load = useCallback(async () => {
    try { const d = await api.missionControl(wsId); if (d.workspaceId === wsId) { setMc(d); setError(null); setNow(new Date()); } } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [wsId]);
  useEffect(() => { setMc(null); void load(); }, [load]);
  const soon = useCallback(() => { clearTimeout(timer.current); timer.current = setTimeout(() => { void load(); }, DEBOUNCE_MS); }, [load]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => app.onWorkspaceEvent((ev) => {
    if (ev.type === 'file.changed' || ev.type === 'file_changed' || ev.type === 'task_update' || ev.type === 'channel_typing' || ev.type === 'channel_approval') soon();
  }), [app, soon]);
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, POLL_MS);
    return () => clearInterval(id);
  }, [load]);
  const node = mc?.nodes.find((n) => n.agentId === selected) ?? null;
  const unitOf = (n: MissionNode | null) => (n?.leadsUnitId ? n.leadsUnitId : n?.reportsToAgentId ? mc?.nodes.find((x) => x.agentId === n.reportsToAgentId)?.leadsUnitId ?? null : null);
  const openUnit = (unitId: string) => {
    const u = mc?.units.find((x) => x.id === unitId);
    app.setOrgUnitId(u && u.parentUnitId !== null ? u.id : null);
    app.setOrgPane('board');
  };
  const narrow = app.width < 720;
  return (
    <div style={{ maxWidth: 1400, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>Org chart</h2>
          <div style={faint}>Who is doing what, who is stuck and on whom, live. Pick an agent for its overview and its waiting chain.</div>
        </div>
        <button style={btn()} onClick={onEditStructure} title="Add, hire, change scopes, pause or terminate members; seat people">Edit structure</button>
      </div>
      {!mc ? (
        error ? <div role="alert" style={{ fontSize: 12.5, color: 'var(--red)' }}>{error} <button style={{ ...btn(), marginLeft: 6 }} onClick={() => void load()}>Retry</button></div> : <div style={faint}>Loading…</div>
      ) : (
        <MissionControlBoard mc={mc} now={now} narrow={narrow} selected={selected} onSelect={(id) => setSelected((cur) => (cur === id ? null : id))}
          onWaitingOnYou={() => { app.setOrgFocus(null); app.setOrgPane('approvals'); }} onOpenUnit={openUnit} nameOfHuman={(id) => app.nameOf(id)} />
      )}
      {node && (
        <Drawer onClose={() => setSelected(null)} width={480}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Avatar emoji={node.emoji} colors={node.colors} size={34} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>{node.name}</div>
              <div style={faint}>{node.isChief ? 'Chief of staff' : node.title || 'Member'}</div>
            </div>
            <button style={btn()} onClick={() => setSelected(null)} aria-label="Close">×</button>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button style={btn(true)} onClick={() => app.openAgent(node.agentId)}>Open page</button>
            <button style={btn()} onClick={() => void app.newChat(node.agentId)}>Chat</button>
            {unitOf(node) && <button style={btn()} onClick={() => openUnit(unitOf(node)!)}>Board</button>}
          </div>
          {mc && waitChain(mc.edges, node.agentId).length > 1 && (
            <div style={{ fontSize: 12.5, color: 'var(--amber)' }}>Waiting chain: {waitChain(mc.edges, node.agentId).map((id) => (id === 'ceo' ? 'You' : mc.nodes.find((n) => n.agentId === id)?.name ?? id.slice(0, 8))).join(' → ')}</div>
          )}
          <AgentOverviewPanel key={node.agentId} agentId={node.agentId} compact onOpenTab={(tab) => app.openAgent(node.agentId, tab)} />
        </Drawer>
      )}
    </div>
  );
}
