/** Direction › Overview: the CEO's "where are we going" page. The vision as
 *  one statement with its horizon; what needs attention (key results at risk
 *  or with a check-in due, unowned goals and projects, projects over their
 *  appetite or missing an update, resource requests waiting); the objectives
 *  with health and owner; the projects in Now with their next milestone; the
 *  latest decisions as one-liners; the program matrix's health. Every row
 *  opens the page it summarises. */
import { useEffect, useMemo, useState } from 'react';
import { useApp, type OrgFocus, type OrgPane } from '../store';
import { api, type OrgDecision, type OrgDetail, type OrgVisionInfo, type RoadmapData } from '../lib/api';
import { directionLede, laneCounts, objectivesOf } from '../lib/company-dash';
import { attentionItems, decisionLine, HEALTH_LABEL, HEALTH_TONE, horizonOf, inDays, nextMilestone, objectiveHealth, objectivesOfTree, plural, projectHealth, shortDate, SOURCE_LABEL, krHealth } from '../lib/direction';
import { decisionSource } from '../lib/org';
import { ago, useAgentNames } from './org-ui';
import { AttentionList, Bar, Card, Empty, Owner, Pill, Skeleton, SkeletonRows } from './CompanyKit';
import { ProgramHealthCard, useProgram } from './ProgramMatrixView';

function useLoad<T>(load: (wsId: string) => Promise<T>, wsId: string): T | null | undefined {
  const [state, setState] = useState<{ k: string; v: T | null } | null>(null);
  useEffect(() => {
    let live = true;
    load(wsId).then((v) => { if (live) setState({ k: wsId, v }); }).catch(() => { if (live) setState({ k: wsId, v: null }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId]);
  return state && state.k === wsId ? state.v : undefined;
}

export function DirectionOverview({ org }: { org: OrgDetail }) {
  const app = useApp();
  const names = useAgentNames();
  const ws = org.workspaceId;
  const vision = useLoad<OrgVisionInfo>(api.orgVision, ws);
  const roadmap = useLoad<RoadmapData>(api.orgRoadmap, ws);
  const decisions = useLoad<OrgDecision[]>((w) => api.orgDecisions(w), ws);
  const matrix = useProgram(ws);
  const intent = useMemo(() => app.orgIntent ?? [], [app.orgIntent]);
  const objectives = useMemo(() => objectivesOfTree(intent).filter((o) => o.kind === 'objective' && o.status !== 'abandoned'), [intent]);
  const lanes = roadmap ? laneCounts(roadmap.projects) : null;
  const pending = app.wsOrg?.pendingApprovals ?? 0;
  const owners = useMemo(() => new Map((matrix?.items ?? []).map((i) => [`${i.refType}:${i.id}`, i.owner])), [matrix]);
  const attention = useMemo(() => (roadmap === undefined || matrix === undefined ? null : attentionItems({ intent, projects: roadmap?.projects ?? [], program: matrix, hasVision: vision === undefined ? undefined : Boolean(vision?.vision) })), [intent, roadmap, matrix, vision]);
  const nowProjects = (roadmap?.projects ?? []).filter((p) => p.lane === 'now' && p.status !== 'done' && p.status !== 'cancelled').sort((a, b) => a.rank - b.rank);
  const open = (pane: OrgPane, focus: OrgFocus | null = null) => { app.setOrgFocus(focus); app.setOrgUnitId(null); app.setOrgPane(pane); app.setMobileDetail(true); };
  const v = vision?.vision ?? null;
  const horizon = horizonOf(v);

  return (
    <div className="co-page" data-testid="direction-overview">
      {/* The one memorable thing: the vision, said once, with its horizon. */}
      <section data-testid="dash-card-vision" aria-label="Vision" style={{ marginBottom: 18, maxWidth: 860 }}>
        {vision === undefined ? (
          <div style={{ display: 'grid', gap: 10 }}><Skeleton w="70%" h={26} /><Skeleton w="45%" h={12} /></div>
        ) : !v ? (
          <Empty title="Write the one sentence the company works toward" action={<button className="co-btn primary" onClick={() => open('vision')}>Write the vision</button>}>The chief of staff plans objectives and key results from it, and every task traces back to it.</Empty>
        ) : (
          <>
            <button onClick={() => open('vision')} style={{ all: 'unset', cursor: 'pointer', display: 'block' }} aria-label={`Vision: ${v.title}. Open the vision`}>
              <p style={{ margin: 0, fontSize: 'clamp(22px, 2.6vw, 30px)', lineHeight: 1.2, fontWeight: 650, letterSpacing: '-.022em', color: 'var(--text)', textWrap: 'balance', maxWidth: '28ch' } as React.CSSProperties}>{v.title}</p>
            </button>
            {v.description && <p style={{ margin: '8px 0 0', fontSize: 14, lineHeight: 1.55, color: 'var(--text-dim)', maxWidth: '68ch', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{v.description}</p>}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
              {horizon ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontSize: 12.5, color: 'var(--text-dim)' }} data-testid="vision-horizon">
                  <Bar value={horizon.elapsed} tone={v.atRisk ? 'warn' : undefined} label="Time elapsed toward the horizon" width={120} />
                  {horizon.label}
                </span>
              ) : <span className="co-faint">No horizon set</span>}
              {v.atRisk === 1 && <Pill tone="warn" title={v.atRiskReason}>Vision at risk</Pill>}
              <button className="co-link" onClick={() => open('vision')}>Open vision</button>
            </div>
          </>
        )}
        <p data-testid="dash-lede" style={{ margin: '14px 0 0', fontSize: 13, color: 'var(--text-dim)' }}>{directionLede(objectivesOf(intent), lanes)}</p>
      </section>

      {pending > 0 && (
        <button data-testid="dash-inbox-row" onClick={() => { app.setOrgFocus(null); app.setOrgPane('approvals'); }} className="co-note warn" style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 10, marginBottom: 14, cursor: 'pointer', font: 'inherit', fontSize: 13, textAlign: 'left' }}>
          <span style={{ flex: 1 }}>{plural(pending, 'decision card')} wait{pending === 1 ? 's' : ''} on you.</span>
          <span className="co-link">Open the Inbox</span>
        </button>
      )}

      <div className="co-split">
        <div className="co-stack">
          <Card id="attention" title="Needs attention" aside={attention && attention.length ? attention.length : undefined}>
            {attention === null ? <SkeletonRows rows={3} /> : <AttentionList limit={6} items={attention.map((a) => ({ id: a.id, tone: a.tone, title: a.title, why: a.why, go: a.go, onOpen: () => open(a.target.pane, a.target.focus ?? null) }))} clear="Nothing needs you: every key result is on pace, owned and checked in." />}
          </Card>
          <Card id="goals" title="Objectives" onOpen={() => open('goals')} aside={objectives.length ? plural(objectives.length, 'objective') : undefined} action={<button className="co-link" onClick={() => open('goals')}>Open goals</button>}>
            {objectives.length === 0 ? <Empty compact title="No objectives yet">{v ? 'Planning runs when the vision is written or revised; Plan now on the Vision page runs it at once.' : 'Write the vision first; the chief plans objectives from it.'}</Empty> : (
              <div className="co-rows" style={{ margin: '0 -10px' }}>
                {objectives.map((o) => {
                  const h = objectiveHealth(o);
                  const krs = o.children.filter((c) => c.kind === 'key_result' && c.status === 'active');
                  const onTrack = krs.filter((k) => { const x = krHealth(k); return x === 'on_track' || x === 'done'; }).length;
                  const owner = owners.get(`goal:${o.id}`);
                  return (
                    <button key={o.id} className="co-row" onClick={() => open('goals', { kind: 'goal', id: o.id })} data-testid="objective-row" data-health={h}>
                      <span className="co-row-main">
                        <span className="co-row-title wrap">{o.title}</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
                          <Bar value={o.progress} tone={HEALTH_TONE[h] === 'muted' ? undefined : HEALTH_TONE[h]} label={`${o.title} progress`} />
                          <span className="co-num" style={{ fontSize: 12, color: 'var(--text-dim)', width: 34, textAlign: 'right' }}>{Math.round(o.progress * 100)}%</span>
                        </span>
                        <span className="co-row-meta">{krs.length ? `${onTrack} of ${plural(krs.length, 'key result')} on track` : 'No key results yet'}</span>
                      </span>
                      <span className="co-row-end" style={{ flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                        <Pill tone={HEALTH_TONE[h]}>{HEALTH_LABEL[h]}</Pill>
                        {owner && owner.role !== 'none' ? <Owner agent={owner.agentId ? names.get(owner.agentId) : undefined} name={owner.name} role={owner.role === 'acting_chief' ? 'acting PM' : owner.role === 'pm' ? 'PM' : undefined} /> : <Owner agent={o.ownerAgentId ? names.get(o.ownerAgentId) : undefined} name={o.ownerName} />}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </Card>
        </div>
        <div className="co-stack">
          <Card id="roadmap" title="In Now" onOpen={() => open('roadmap')} aside={lanes ? `${lanes.now} now · ${lanes.next} next · ${lanes.later} later` : undefined} action={<button className="co-link" onClick={() => open('roadmap')}>Open roadmap</button>}>
            {roadmap === undefined ? <SkeletonRows rows={2} /> : !roadmap ? <Empty compact title="The roadmap did not load">Open the roadmap to try again.</Empty> : nowProjects.length === 0 ? <Empty compact title="Nothing in Now">Move a shaped project to Now on the roadmap to bet on it.</Empty> : (
              <div className="co-rows" style={{ margin: '0 -10px' }}>
                {nowProjects.slice(0, 5).map((p) => {
                  const h = projectHealth(p.health);
                  const ms = nextMilestone(p);
                  return (
                    <button key={p.id} className="co-row" onClick={() => open('roadmap', { kind: 'project', id: p.id })} data-testid="now-project">
                      <span className="co-row-main">
                        <span className="co-row-title wrap">{p.key && <span className="co-key">{p.key}</span>}{p.title}</span>
                        <span className="co-row-meta">{ms ? `Next: ${ms.name}, ${shortDate(ms.date)} (${inDays(ms.date)})` : p.targetDate ? `Target ${shortDate(p.targetDate)}` : 'No milestone yet'}{p.update?.state === 'missing' ? ' · update missing' : ''}</span>
                      </span>
                      <span className="co-row-end" style={{ flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                        <Pill tone={HEALTH_TONE[h]}>{h === 'unknown' ? 'No update' : HEALTH_LABEL[h]}</Pill>
                        <span className="co-num">{p.progress.pct}%</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </Card>
          <Card id="decisions" title="Recent decisions" onOpen={() => open('decisions')} action={<button className="co-link" onClick={() => open('decisions')}>Decision log</button>}>
            {decisions === undefined ? <SkeletonRows rows={3} /> : !decisions || decisions.length === 0 ? <Empty compact title="Nothing decided yet">Decisions from meetings and your cards land here.</Empty> : (
              <div className="co-rows" style={{ margin: '0 -10px' }}>
                {decisions.slice(0, 5).map((d) => {
                  const { kind, line } = decisionLine(d);
                  return (
                    <button key={d.id} className="co-row" onClick={() => open('decisions', { kind: 'decision', id: d.id })} data-testid="decision-line">
                      <span className="co-row-main">
                        <span className="co-row-title wrap" style={{ fontWeight: 550 }}>{line}</span>
                        <span className="co-row-meta">{[kind ? kind[0].toUpperCase() + kind.slice(1) : null, SOURCE_LABEL[decisionSource(d)]].filter(Boolean).join(' · ')}</span>
                      </span>
                      <span className="co-row-end">{ago(d.createdAt)}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </Card>
          <ProgramHealthCard matrix={matrix} />
        </div>
      </div>
    </div>
  );
}

