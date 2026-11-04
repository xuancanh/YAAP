/** Direction › Decisions: the decision log as a record people consult
 *  (docs/company-vision.md §6). A searchable, filterable list grouped by
 *  day — by where it came from (your cards, meetings, the chief on its own,
 *  cadence changes), by who decided, by period and by what it links to —
 *  beside a reading pane with the whole record: what was decided, by whom
 *  and where, why, the alternatives, whether it can be reversed, and its
 *  links (the meeting, the approval card, the goal or project, everything
 *  related). On a phone the list and the record are one column. */
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { api, type OrgDecision, type OrgDetail, type OrgMeeting } from '../lib/api';
import { decidedByLabel, decisionSource, MEETING_KIND_TITLES } from '../lib/org';
import { decisionLine, filterDecisions, groupByDay, plural, reversibilityOf, SOURCE_LABEL, type DecisionFilter } from '../lib/direction';
import { Markdown } from '../lib/md';
import { I, P } from '../lib/icons';
import { ago, useAgentNames, useUnits } from './org-ui';
import { CopyRef, Empty, PageHeader, Pill, SearchBox, SkeletonRows } from './CompanyKit';
import { useOpenMeeting } from './OrgMeetingsView';

const RelatedDrawer = lazy(() => import('./OrgMemoryView').then((m) => ({ default: m.RelatedDrawer })));

const SOURCES = ['all', 'approval', 'meeting', 'autonomous', 'cadence'] as const;
const SOURCE_TONE: Record<string, 'accent' | 'ok' | 'warn' | undefined> = { approval: 'ok', meeting: 'accent', autonomous: 'warn' };

export function DecisionsPane({ org }: { org: OrgDetail }) {
  const app = useApp();
  const wsId = org.workspaceId;
  const names = useAgentNames();
  const { units, current, isCompany, byId } = useUnits();
  const [rows, setRows] = useState<OrgDecision[] | null>(null);
  const [meetings, setMeetings] = useState<Map<string, OrgMeeting>>(new Map());
  const [sel, setSel] = useState<string | null>(null);
  const [related, setRelated] = useState<OrgDecision | null>(null);
  const [f, setF] = useState<DecisionFilter>({ q: '', source: 'all', decider: 'all', since: 'all', link: 'all' });
  const unitId = isCompany ? null : current?.id ?? null;
  const refresh = useCallback(async () => {
    const [d, m] = await Promise.all([api.orgDecisions(wsId, unitId).catch((): OrgDecision[] => []), api.orgMeetings(wsId).catch((): OrgMeeting[] => [])]);
    setRows(d); setMeetings(new Map(m.map((x) => [x.id, x])));
  }, [wsId, unitId]);
  useEffect(() => { void refresh(); const t = setInterval(() => { void refresh(); }, 60_000); return () => clearInterval(t); }, [refresh]);
  // A `#decision:` chip deep-linked here (an id or its prefix): select it.
  useEffect(() => {
    if (app.orgFocus?.kind !== 'decision' || !rows) return;
    const id = app.orgFocus.id;
    const d = rows.find((x) => x.id === id || x.id.startsWith(id));
    app.setOrgFocus(null);
    if (!d) { if (rows.length) app.showToast('That decision is not in this department’s log'); return; }
    setSel(d.id);
    requestAnimationFrame(() => document.getElementById(`decision-${d.id}`)?.scrollIntoView({ block: 'nearest' }));
  }, [rows, app]);
  const by = useCallback((d: OrgDecision) => decidedByLabel(d.decidedBy, (id) => names.get(id)?.name, (id) => app.nameOf(id)), [names, app]);
  const deciders = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of rows ?? []) m.set(d.decidedBy, (m.get(d.decidedBy) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: rows?.length ?? 0 };
    for (const d of rows ?? []) { const s = decisionSource(d); c[s] = (c[s] ?? 0) + 1; }
    return c;
  }, [rows]);
  const shown = useMemo(() => filterDecisions(rows ?? [], f), [rows, f]);
  const groups = useMemo(() => groupByDay(shown), [shown]);
  const selected = shown.find((d) => d.id === sel) ?? (app.stacked ? null : shown[0] ?? null);
  const filtered = f.q || f.source !== 'all' || f.decider !== 'all' || f.since !== 'all' || f.link !== 'all';
  const set = (patch: Partial<DecisionFilter>) => setF((x) => ({ ...x, ...patch }));
  const showList = !app.stacked || !sel;

  return (
    <div className="co-page" data-testid="decisions-page">
      <PageHeader title={isCompany ? 'Decisions' : `${current?.name ?? 'Department'} decisions`} purpose="Every decision the company made, with who made it, why, and what else was on the table. Reference one in a channel with its copy-link." />
      <div className="co-toolbar">
        <SearchBox value={f.q} onChange={(q) => set({ q })} label="Search decisions" placeholder="Search what, why, alternatives" />
        <select className="co-input" style={{ width: 'auto' }} aria-label="Decided by" value={f.decider} onChange={(e) => set({ decider: e.target.value })}>
          <option value="all">Anyone decided</option>
          {deciders.map(([id, n]) => <option key={id} value={id}>{by({ decidedBy: id } as OrgDecision)} ({n})</option>)}
        </select>
        <select className="co-input" style={{ width: 'auto' }} aria-label="Period" value={f.since} onChange={(e) => set({ since: e.target.value as DecisionFilter['since'] })}>
          <option value="all">Any time</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option><option value="90d">Last 90 days</option>
        </select>
        <select className="co-input" style={{ width: 'auto' }} aria-label="Linked to" value={f.link} onChange={(e) => set({ link: e.target.value as DecisionFilter['link'] })}>
          <option value="all">Linked to anything</option><option value="goal">A goal</option><option value="project">A project</option><option value="meeting">A meeting</option>
        </select>
        {units.length > 1 && (
          <select className="co-input" style={{ width: 'auto' }} aria-label="Department" value={app.orgUnitId ?? ''} onChange={(e) => app.setOrgUnitId(e.target.value || null)}>
            {units.map((u) => <option key={u.id} value={u.parentUnitId === null ? '' : u.id}>{u.parentUnitId === null ? 'Whole company' : u.name}</option>)}
          </select>
        )}
      </div>
      <div className="co-chips" role="tablist" aria-label="Where it came from" style={{ marginBottom: 12 }}>
        {SOURCES.filter((s) => s === 'all' || counts[s]).map((s) => (
          <button key={s} role="tab" aria-selected={f.source === s} className={`co-chip${f.source === s ? ' on' : ''}`} onClick={() => set({ source: s })}>
            {s === 'all' ? 'All' : SOURCE_LABEL[s]}<span className="co-chip-n">{counts[s] ?? 0}</span>
          </button>
        ))}
      </div>
      {rows === null ? <div className="co-card"><SkeletonRows rows={5} label="Loading decisions" /></div>
        : rows.length === 0 ? <div className="co-card"><Empty title="No decision logged yet" icon={P.check}>Meetings log theirs when they close; your decision cards and cadence changes log themselves.</Empty></div>
          : (
            <div style={{ display: 'grid', gap: 14, gridTemplateColumns: app.stacked ? 'minmax(0, 1fr)' : 'minmax(300px, 0.9fr) minmax(0, 1.3fr)', alignItems: 'start' }}>
              {showList && (
                <div className="co-card" style={{ padding: '4px 6px 8px', maxHeight: app.stacked ? undefined : 'calc(100vh - 250px)', overflowY: app.stacked ? undefined : 'auto' }} role="listbox" aria-label="Decisions" data-testid="decision-list"
                  onKeyDown={(e) => {
                    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                    e.preventDefault();
                    const i = shown.findIndex((d) => d.id === selected?.id);
                    const next = shown[Math.max(0, Math.min(shown.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
                    if (next) { setSel(next.id); document.getElementById(`decision-${next.id}`)?.focus(); }
                  }}>
                  <div className="co-faint" style={{ padding: '8px 10px 2px' }} aria-live="polite">{filtered ? `${shown.length} of ${plural(rows.length, 'decision')}` : plural(rows.length, 'decision')}{filtered && <> · <button className="co-link" style={{ fontSize: 12 }} onClick={() => setF({ q: '', source: 'all', decider: 'all', since: 'all', link: 'all' })}>Clear filters</button></>}</div>
                  {shown.length === 0 && <Empty compact title="No decision matches">Try fewer filters or other words.</Empty>}
                  {groups.map((g) => (
                    <div key={g.day}>
                      <div style={{ padding: '12px 10px 4px', fontSize: 12, fontWeight: 600, color: 'var(--text-dim)' }}>{g.label}</div>
                      {g.rows.map((d) => {
                        const { kind, line } = decisionLine(d);
                        const src = decisionSource(d);
                        const on = selected?.id === d.id;
                        return (
                          <button key={d.id} id={`decision-${d.id}`} role="option" aria-selected={on} className="co-row" data-testid="decision-row" onClick={() => setSel(d.id)}
                            style={on ? { background: 'var(--sel)', boxShadow: 'inset 2px 0 0 var(--accent)' } : undefined}>
                            <span className="co-row-main">
                              <span className="co-row-title wrap" style={{ fontWeight: 560 }}>{line}</span>
                              <span className="co-row-meta">{[kind ? kind[0].toUpperCase() + kind.slice(1) : null, SOURCE_LABEL[src], src === 'autonomous' && d.decidedBy === 'chief' ? null : by(d)].filter(Boolean).map((x) => x![0].toUpperCase() + x!.slice(1)).join(' · ')}</span>
                            </span>
                            <span className="co-row-end">{new Date(d.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
              {selected && (!app.stacked || sel) && (
                <DecisionRecord d={selected} by={by(selected)} meeting={selected.meetingId ? meetings.get(selected.meetingId) : undefined} unitName={selected.unitId ? (byId.get(selected.unitId)?.name ?? null) : null}
                  onBack={app.stacked ? () => setSel(null) : undefined} onRelated={() => setRelated(selected)} />
              )}
            </div>
          )}
      {related && <Suspense fallback={null}><RelatedDrawer wsId={wsId} ref={`decision:${related.id}`} title={decisionLine(related).line} onClose={() => setRelated(null)} /></Suspense>}
    </div>
  );
}

function DecisionRecord({ d, by, meeting, unitName, onBack, onRelated }: { d: OrgDecision; by: string; meeting?: OrgMeeting; unitName: string | null; onBack?: () => void; onRelated: () => void }) {
  const app = useApp();
  const openMeeting = useOpenMeeting();
  const { kind, line } = decisionLine(d);
  const src = decisionSource(d);
  const rev = reversibilityOf(d);
  const linkLabel = d.refType === 'goal' ? 'Open the goal' : d.refType === 'project' ? 'Open the project' : null;
  const openLink = () => {
    if (d.refType === 'goal') { app.setOrgFocus({ kind: 'goal', id: d.refId }); app.setOrgUnitId(null); app.setOrgPane('goals'); }
    else if (d.refType === 'project') { app.setOrgFocus({ kind: 'project', id: d.refId }); app.setOrgPane('roadmap'); }
  };
  return (
    <article className="co-card" style={{ padding: '16px 18px', position: app.stacked ? undefined : 'sticky', top: 0 }} data-testid="decision-record" aria-labelledby={`dr-${d.id}`}>
      {onBack && <button className="co-btn ghost small" style={{ marginBottom: 10 }} onClick={onBack}><I d={P.chevL} size={12} />All decisions</button>}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        <Pill tone={SOURCE_TONE[src]} plain>{SOURCE_LABEL[src]}</Pill>
        {kind && <Pill plain>{kind[0].toUpperCase() + kind.slice(1)}</Pill>}
        {unitName && <Pill plain>{unitName}</Pill>}
        <span style={{ flex: 1 }} />
        <CopyRef text={`#decision:${d.id.slice(0, 8)}`} />
      </div>
      <h3 id={`dr-${d.id}`} style={{ margin: 0, fontSize: 17, lineHeight: 1.35, fontWeight: 650, letterSpacing: '-.01em', overflowWrap: 'anywhere' }}>{line}</h3>
      {d.decision && <div className="co-prose" style={{ marginTop: 10, fontSize: 13.5 }}><Markdown text={d.decision} compact /></div>}
      <dl className="co-dl" style={{ marginTop: 14 }}>
        <dt>Decided by</dt><dd>{by}</dd>
        <dt>When</dt><dd>{new Date(d.createdAt).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} ({ago(d.createdAt)})</dd>
        <dt>Where</dt><dd>{meeting ? <button className="co-link" onClick={() => openMeeting(meeting)}>{meeting.title || MEETING_KIND_TITLES[meeting.kind]}</button> : d.approvalId ? 'A decision card you answered' : src === 'cadence' ? 'A cadence change' : 'The chief of staff, within its caps'}</dd>
        <dt>Reversible</dt><dd>{rev ?? <span className="co-dim">Not recorded</span>}</dd>
      </dl>
      <h4 style={{ margin: '18px 0 4px', fontSize: 13, fontWeight: 650 }}>Why</h4>
      <div className="co-prose" style={{ fontSize: 13.5, color: d.rationale ? 'var(--text)' : 'var(--text-faint)' }}>{d.rationale ? <Markdown text={d.rationale} compact /> : 'No rationale was recorded.'}</div>
      <h4 style={{ margin: '16px 0 4px', fontSize: 13, fontWeight: 650 }}>Alternatives considered</h4>
      <div className="co-prose" style={{ fontSize: 13.5, color: d.alternatives ? 'var(--text)' : 'var(--text-faint)' }}>{d.alternatives ? <Markdown text={d.alternatives} compact /> : 'None recorded.'}</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 18 }}>
        <button className="co-btn small" onClick={onRelated}>Everything related</button>
        {linkLabel && <button className="co-btn small" onClick={openLink}>{linkLabel}</button>}
        {d.approvalId && <button className="co-btn small" onClick={() => { app.setOrgPane('approvals'); }}>Open the card</button>}
      </div>
    </article>
  );
}
