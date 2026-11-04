/** Program management on screen (docs/work-tracking.md "Program management:
 *  the matrix"): who owns a goal or project (a Program Manager, or the chief
 *  acting as one — said so), its rhythms with their next occurrence, the
 *  resource requests waiting on heads; the Direction card with the matrix's
 *  health; and People's matrix — members × projects with each allocation,
 *  the line manager and the stretched total. Data: GET …/org/program. */
/* eslint-disable react-refresh/only-export-components */
import { useEffect, useState, type CSSProperties } from 'react';
import { api, type ProgramCadence, type ProgramItem, type ProgramMatrix, type ProgramOwner, type ResourceRequest } from '../lib/api';
import { faint, pill } from './org-ui';
import { Card, Metric, SkeletonRows } from './CompanyKit';

/** The matrix for a workspace: undefined while loading, null when it failed. */
export function useProgram(wsId: string, key = ''): ProgramMatrix | null | undefined {
  const [state, setState] = useState<{ k: string; v: ProgramMatrix | null } | null>(null);
  const k = `${wsId}|${key}`;
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => api.orgProgram(wsId)).then((v) => { if (live) setState({ k, v }); }).catch(() => { if (live) setState({ k, v: null }); });
    return () => { live = false; };
  }, [wsId, k]);
  return state && state.k === k ? state.v : undefined;
}

const ROLE_WORD: Record<ProgramOwner['role'], string> = {
  pm: 'Program Manager', acting_chief: 'acting PM', head: 'a head, not a PM', member: 'not a PM', person: 'a person', inactive: 'owner inactive', none: 'no owner',
};

function when(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** "Pat · Program Manager", "Chief · acting PM", or a warning when nobody owns it. */
export function ProgramOwnerBadge({ owner }: { owner: ProgramOwner }) {
  const warn = owner.role === 'none' || owner.role === 'inactive';
  const soft = owner.role === 'head' || owner.role === 'member' || owner.role === 'acting_chief';
  const style: CSSProperties = warn ? pill('var(--red)', '#fff') : soft ? pill('var(--panel-2)', 'var(--amber)') : pill();
  return (
    <span data-testid="program-owner" data-role={owner.role} style={style} title={owner.role === 'acting_chief' ? 'The company has no Program Manager: the chief of staff acts as one' : undefined}>
      {owner.role === 'none' ? 'No owner' : `${owner.name} · ${ROLE_WORD[owner.role]}`}
    </span>
  );
}

function CadenceRow({ c }: { c: ProgramCadence }) {
  return (
    <div data-testid="program-cadence" data-kind={c.kind} data-stale={c.stale ? '1' : '0'} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, padding: '3px 0', borderTop: '1px solid var(--border-soft)', flexWrap: 'wrap' }}>
      <span style={{ minWidth: 130 }}>{c.label}</span>
      {c.enabled
        ? <span style={faint}>{c.everyDays !== null ? `every ~${c.everyDays}d` : ''}{c.cron ? ` · ${c.cron}` : ''}</span>
        : <span style={pill('var(--panel-2)', 'var(--amber)')}>off</span>}
      <span style={{ flex: 1 }} />
      {c.enabled && <span style={faint}>next {when(c.nextAt)}</span>}
      {c.stale && <span style={pill('var(--amber)', '#fff')}>stale</span>}
    </div>
  );
}

const STATUS_TONE: Record<string, string> = { open: 'var(--panel-2)', hiring: 'var(--panel-2)', granted: 'var(--accent)', escalated: 'var(--amber)', declined: 'var(--red)' };

function RequestRow({ r }: { r: ResourceRequest }) {
  const tone = STATUS_TONE[r.status] ?? 'var(--panel-2)';
  return (
    <div data-testid="program-request" data-status={r.status} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, padding: '4px 0', borderTop: '1px solid var(--border-soft)', flexWrap: 'wrap' }}>
      <b>{r.role}</b>
      <span style={pill()}>{r.allocation}%</span>
      {r.agentName && <span style={faint}>{r.agentName}</span>}
      <span style={pill(tone, tone === 'var(--panel-2)' ? 'var(--text-dim)' : '#fff')}>{r.status}{r.overdue ? ' · overdue' : ''}</span>
      <span style={{ flex: 1 }} />
      <span style={faint}>head {r.headName}{r.status === 'open' && r.answerBy ? ` · answer by ${when(r.answerBy)}` : ''}</span>
      {r.decisionNote && <div style={{ ...faint, flexBasis: '100%' }}>{r.decisionNote}</div>}
    </div>
  );
}

/** The project page's program block: the PM owner, the rhythms, the requests waiting on heads. */
export function ProgramBlock({ item }: { item: ProgramItem }) {
  return (
    <section data-testid="program-block" style={{ border: '1px solid var(--border)', borderRadius: 13, background: 'var(--panel)', padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 13 }}>Program</b>
        <ProgramOwnerBadge owner={item.owner} />
        <span style={{ flex: 1 }} />
        <span style={faint}>The PM owns the outcome and its rhythm; the heads own the people they lend.</span>
      </div>
      {item.cadences.map((c) => <CadenceRow key={c.kind} c={c} />)}
      <div style={{ ...faint, marginTop: 8 }}>Resource requests{item.requests.length ? ` · ${item.requests.length}` : ''}</div>
      {item.requests.length === 0 ? <div style={faint}>None waiting on a head.</div> : item.requests.map((r) => <RequestRow key={r.id} r={r} />)}
    </section>
  );
}

/** A goal row's program line: its owner and its review rhythm. */
export function GoalProgramLine({ item }: { item: ProgramItem }) {
  const review = item.cadences.find((c) => c.kind === 'goal_review') ?? item.cadences.find((c) => c.kind === 'kr_checkin');
  return (
    <span data-testid="goal-program" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <ProgramOwnerBadge owner={item.owner} />
      {review && (
        <span style={review.stale ? pill('var(--panel-2)', 'var(--amber)') : pill()} title={review.cron ?? undefined}>
          {review.label}{review.enabled ? ` · next ${when(review.nextAt)}` : ' · off'}{review.stale ? ' · stale' : ''}
        </span>
      )}
    </span>
  );
}


/** Direction › Program matrix: who owns the outcomes and how healthy the matrix is. */
export function ProgramHealthCard({ matrix }: { matrix: ProgramMatrix | null | undefined }) {
  return (
    <Card id="program" title="Program matrix">
      {matrix === undefined ? <SkeletonRows rows={2} /> : !matrix ? <div style={faint}>The program matrix is not available.</div> : (
        <>
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginBottom: 10, lineHeight: 1.5 }}>
            {matrix.chiefActing
              ? <>No Program Manager yet: <span style={{ color: 'var(--text)' }}>{matrix.chiefName}</span> acts as PM.</>
              : <>Program Managers: {matrix.pms.map((p) => `${p.name} (${p.owns})`).join(', ')}.</>}
          </div>
          <div className="co-metrics">
            <Metric testid="program-fig-unowned" n={matrix.health.unowned} label="unowned" tone={matrix.health.unowned ? 'bad' : undefined} />
            <Metric testid="program-fig-acting" n={matrix.health.acting} label="chief acting" tone={matrix.health.acting ? 'warn' : undefined} />
            <Metric testid="program-fig-stretched" n={matrix.health.stretched} label="stretched" tone={matrix.health.stretched ? 'warn' : undefined} />
            <Metric testid="program-fig-stale" n={matrix.health.staleCadences} label="stale rhythms" tone={matrix.health.staleCadences ? 'warn' : undefined} />
            <Metric testid="program-fig-requests" n={matrix.health.openRequests} label={`open requests${matrix.health.overdueRequests ? ` (${matrix.health.overdueRequests} overdue)` : ''}`} />
          </div>
        </>
      )}
    </Card>
  );
}

/** People › the matrix: members × projects with allocations, the line manager and the total. */
export function ProgramMatrixTable({ matrix }: { matrix: ProgramMatrix }) {
  const projects = matrix.items.filter((i) => i.refType === 'project');
  const members = matrix.members.filter((m) => m.assignments.length > 0 || m.owns.length > 0 || m.isHead);
  const cell: CSSProperties = { padding: '5px 8px', borderTop: '1px solid var(--border-soft)', fontSize: 12.5, whiteSpace: 'nowrap' };
  if (projects.length === 0) return <div style={faint}>No projects yet: nothing to staff.</div>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table data-testid="program-matrix" style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            <th style={{ ...cell, textAlign: 'left', borderTop: 'none', ...faint }}>Member</th>
            <th style={{ ...cell, textAlign: 'left', borderTop: 'none', ...faint }}>Line manager</th>
            {projects.map((p) => <th key={p.id} style={{ ...cell, borderTop: 'none', ...faint }} title={`${p.title} · ${p.owner.name}`}>{p.key ?? p.title}</th>)}
            <th style={{ ...cell, borderTop: 'none', ...faint, textAlign: 'right' }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.agentId} data-testid="program-matrix-row" data-stretched={m.stretched ? '1' : '0'}>
              <td style={cell}>{m.name}{m.title ? <span style={faint}> · {m.title}</span> : null}</td>
              <td style={{ ...cell, ...faint }}>{m.lineManager}</td>
              {projects.map((p) => {
                const a = m.assignments.find((x) => x.projectId === p.id);
                const owns = p.owner.agentId === m.agentId;
                return (
                  <td key={p.id} style={{ ...cell, textAlign: 'center' }} title={a ? `${a.role || 'member'} · PM ${a.pmName}${a.status === 'pending' ? ' · pending' : ''}` : owns ? 'owns it' : undefined}>
                    {a ? <span style={a.status === 'pending' ? { color: 'var(--amber)' } : undefined}>{a.allocation}%</span> : owns ? <span style={pill()}>PM</span> : <span style={faint}>·</span>}
                  </td>
                );
              })}
              <td style={{ ...cell, textAlign: 'right', fontWeight: 600, color: m.stretched ? 'var(--amber)' : 'var(--text)' }}>{m.total}%{m.stretched ? ' · stretched' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ ...faint, marginTop: 6 }}>A member is stretched past {matrix.bounds.allocationWarnPct}% on projects; its head and each PM it serves are told.</div>
    </div>
  );
}

/** People › Program matrix card (self-contained: loads its own data). */
export function ProgramPeopleCard({ wsId }: { wsId: string }) {
  const matrix = useProgram(wsId);
  return (
    <Card id="matrix" title="Members × projects" span>
      {matrix === undefined ? <SkeletonRows rows={3} /> : !matrix ? <div style={faint}>The matrix is not available.</div> : <ProgramMatrixTable matrix={matrix} />}
    </Card>
  );
}

/** Direction › Program matrix card (self-contained). */
export function ProgramDirectionCard({ wsId }: { wsId: string }) {
  return <ProgramHealthCard matrix={useProgram(wsId)} />;
}
