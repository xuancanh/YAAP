/** Direction › Alignment (docs/alignment.md): what the company builds
 *  toward, agreed with the CEO before tasks are created under it. One page
 *  in the shared language of the company sections: "Needs your alignment"
 *  first (what owners asked you, and what was aligned without you), the
 *  brief of the selected item — summary, why, options and trade-offs,
 *  measures, cost, what it unlocks, how the owner classified it — with its
 *  thread and the decision buttons; then what the agents decided not to
 *  escalate (pull one in), what is with the owners, the history of what was
 *  aligned and when, and the list of what needs the CEO here. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { api, type OrgAlignment, type OrgAlignmentClasses, type OrgAlignmentDecision, type OrgDetail, type OrgEscalationFinding } from '../lib/api';
import { VIA_LABEL, alignmentActions, alignmentBadge, alignmentGroups, criteriaLines, threadWho } from '../lib/alignment';
import { ago, useAgentNames } from './org-ui';
import { Card, Empty, Owner, PageHeader, Pill, SkeletonRows } from './CompanyKit';

export function AlignmentBadge({ a, testid = 'alignment-badge' }: { a: Pick<OrgAlignment, 'state' | 'aligner' | 'needsCeoReview' | 'reviewDue' | 'alignedVia'> | undefined; testid?: string }) {
  if (!a) return null;
  const b = alignmentBadge(a);
  return <Pill tone={b.tone} title={b.title} testid={testid}>{b.label}</Pill>;
}

/** The alignments of a workspace, reloaded on demand. */
export function useAlignments(wsId: string | null | undefined): { items: OrgAlignment[] | null | undefined; reload: () => Promise<void> } {
  const [state, setState] = useState<{ k: string; v: OrgAlignment[] | null } | null>(null);
  const reload = useCallback(async () => {
    if (!wsId) return;
    try { setState({ k: wsId, v: await api.orgAlignments(wsId) }); } catch { setState({ k: wsId, v: null }); }
  }, [wsId]);
  useEffect(() => { void reload(); }, [reload]);
  return { items: state && state.k === wsId ? state.v : undefined, reload };
}

export function AlignmentPane({ org }: { org: OrgDetail }) {
  const app = useApp();
  const ws = org.workspaceId;
  const { items, reload } = useAlignments(ws);
  const [classes, setClasses] = useState<OrgAlignmentClasses | null>(null);
  const [findings, setFindings] = useState<OrgEscalationFinding[]>([]);
  useEffect(() => {
    api.orgAlignmentClasses(ws).then(setClasses).catch(() => setClasses(null));
    api.orgAlignmentSpotCheck(ws).then(setFindings).catch(() => setFindings([]));
  }, [ws]);
  const groups = useMemo(() => alignmentGroups(items ?? []), [items]);
  const focus = app.orgFocus?.kind === 'alignment' ? app.orgFocus.id : null;
  const selectedId = focus ?? groups.needsYou[0]?.id ?? null;
  const selected = (items ?? []).find((a) => a.id === selectedId) ?? null;
  const select = (id: string) => app.setOrgFocus({ kind: 'alignment', id });
  const bundle = selected ? (items ?? []).filter((a) => a.bundleOf === selected.id || a.parentId === selected.itemId) : [];

  return (
    <div className="co-page" data-testid="alignment-pane">
      <PageHeader title="Alignment" purpose={<>
        What the company builds toward is agreed with you before tasks are created under it: the direction, the strategy, the OKRs, bets, money beyond the plan, external commitments, organisation design, values and one-way doors. Owners decide by the criteria whether an item needs you; some classes always do in a supervised company. Tasks under an item that is not aligned are refused, except a little discovery work. An autonomous company runs these without you and logs it, so you can review and override.
      </>} />
      {items === undefined ? <SkeletonRows rows={4} /> : items === null ? <div className="co-alert" role="alert">Alignment did not load.</div> : (
        <div className="co-split">
          <div className="co-stack">
            <Card id="needs-alignment" title="Needs your alignment" aside={groups.needsYou.length || undefined}>
              {groups.needsYou.length === 0
                ? <Empty compact title="Nothing waits on you" testid="alignment-clear">When an owner asks you to align on the direction, the strategy, an OKR or a bet, it lands here and in your Inbox.</Empty>
                : <ItemRows items={groups.needsYou} selectedId={selectedId} onSelect={select} />}
            </Card>
            {selected && <BriefCard a={selected} bundle={bundle} wsId={ws} onChanged={reload} />}
          </div>
          <div className="co-stack">
            <Card id="not-escalated" title="Not escalated" aside={groups.notEscalated.length || undefined}>
              {groups.notEscalated.length === 0 ? <Empty compact title="Nothing classified out">Items an owner decides do not need you appear here with the reasoning; pull one in if it should.</Empty> : (
                <ItemRows items={groups.notEscalated} selectedId={selectedId} onSelect={select} why={(a) => a.classification?.reasoning ?? ''} flags={new Map(findings.filter((f) => f.kind === 'under').map((f) => [f.alignmentId, f.why]))} />
              )}
            </Card>
            <Card id="with-owners" title="With the owners" aside={groups.inFlight.length || undefined}>
              {groups.inFlight.length === 0 ? <Empty compact title="Nothing in preparation">Drafts, send-backs and re-alignments the owners are working on.</Empty> : <ItemRows items={groups.inFlight} selectedId={selectedId} onSelect={select} />}
            </Card>
            <Card id="alignment-history" title="Aligned" aside={groups.history.length || undefined}>
              {groups.history.length === 0 ? <Empty compact title="Nothing aligned yet">Each alignment is kept with its version, who aligned it, when and on what conditions.</Empty> : (
                <div className="co-rows" style={{ margin: '0 -10px' }} data-testid="alignment-history">
                  {groups.history.slice(0, 12).map((a) => (
                    <button key={a.id} className="co-row" onClick={() => select(a.id)} aria-current={a.id === selectedId || undefined}>
                      <span className="co-row-main">
                        <span className="co-row-title wrap">{a.title}</span>
                        <span className="co-row-meta">{a.label} · v{a.alignedVersion ?? a.version} · {VIA_LABEL[a.alignedVia] ?? a.alignedVia} · {a.alignedAt ? new Date(a.alignedAt).toLocaleDateString() : ''}{a.conditions ? ' · with conditions' : ''}</span>
                      </span>
                      <span className="co-row-end"><AlignmentBadge a={a} /></span>
                    </button>
                  ))}
                </div>
              )}
            </Card>
            {classes && <ClassesCard classes={classes} />}
          </div>
        </div>
      )}
    </div>
  );
}

function ItemRows({ items, selectedId, onSelect, why, flags }: { items: OrgAlignment[]; selectedId: string | null; onSelect: (id: string) => void; why?: (a: OrgAlignment) => string; flags?: Map<string, string> }) {
  const names = useAgentNames();
  return (
    <div className="co-rows" style={{ margin: '0 -10px' }}>
      {items.map((a) => {
        const flag = flags?.get(a.id);
        const line = why?.(a) || a.brief.what || (a.reopenReasons[0] ? `Changed: ${a.reopenReasons[0]}` : '');
        return (
          <button key={a.id} className="co-row" onClick={() => onSelect(a.id)} aria-current={a.id === selectedId || undefined} data-testid="alignment-row" data-state={a.state}>
            <span className="co-row-main">
              <span className="co-row-title wrap">{a.title}</span>
              <span className="co-row-meta">{[a.label, line].filter(Boolean).join(' · ')}</span>
              {flag && <span className="co-row-meta" style={{ color: 'var(--warn-text)' }} data-testid="spot-check-flag">Spot-check: {flag}</span>}
            </span>
            <span className="co-row-end" style={{ flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
              <AlignmentBadge a={a} />
              <Owner compact agent={a.ownerAgentId ? names.get(a.ownerAgentId) : undefined} none="No owner" />
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The brief of one item: the decision card the CEO reads, its thread and its buttons. */
export function BriefCard({ a, bundle = [], wsId, onChanged }: { a: OrgAlignment; bundle?: OrgAlignment[]; wsId: string; onChanged: () => Promise<void> | void }) {
  const app = useApp();
  const names = useAgentNames();
  const [note, setNote] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [need, setNeed] = useState<string | null>(null);
  useEffect(() => { setNote(''); setComment(''); setNeed(null); }, [a.id]);
  const b = a.brief;
  const owner = a.ownerAgentId ? names.get(a.ownerAgentId) : undefined;
  const act = async (id: OrgAlignmentDecision, needsNote: boolean) => {
    if (needsNote && !note.trim()) { setNeed(id === 'send_back' ? 'Say what to change before sending it back.' : 'Write the changes or conditions first.'); return; }
    setBusy(true);
    try { await api.decideOrgAlignment(wsId, a.id, id, note.trim() || undefined); setNote(''); setNeed(null); await onChanged(); void app.refreshWsOrg(); } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); } finally { setBusy(false); }
  };
  const post = async () => {
    if (!comment.trim()) return;
    setBusy(true);
    try { await api.commentOrgAlignment(wsId, a.id, comment.trim()); setComment(''); await onChanged(); } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); } finally { setBusy(false); }
  };
  const actions = alignmentActions(a);
  const c = a.classification;
  return (
    <Card id="alignment-brief" title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>{a.title}</span>} aside={<AlignmentBadge a={a} testid="brief-badge" />}>
      <div data-testid="alignment-brief" style={{ display: 'grid', gap: 14 }}>
        <div className="co-row-meta" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <span>{a.label[0].toUpperCase() + a.label.slice(1)} · version {a.version}{a.alignedVersion && a.alignedVersion !== a.version ? ` (v${a.alignedVersion} aligned)` : ''}</span>
          <Owner agent={owner} none="No owner" role="owner" />
          {a.requestedAt && <span>asked {ago(a.requestedAt)}</span>}
        </div>
        {b.what ? <p className="co-prose" style={{ margin: 0, fontSize: 15, fontWeight: 550 }} data-testid="brief-what">{b.what}</p> : <p className="co-faint" style={{ margin: 0 }}>The owner has not written a brief yet.</p>}
        {a.reopenReasons.length > 0 && a.state !== 'aligned' && <div className="co-note warn">Re-opened: {a.reopenReasons.join('; ')}</div>}
        {(b.why || b.options.length || b.tradeoffs || b.measures || b.cost || b.unlocks) && (
          <dl className="co-dl" data-testid="brief-fields">
            {b.why && <><dt>Why</dt><dd>{b.why}</dd></>}
            {b.options.length > 0 && <><dt>Options considered</dt><dd><ol style={{ margin: 0, paddingLeft: 18 }}>{b.options.map((o, i) => <li key={i}>{o}</li>)}</ol></dd></>}
            {b.tradeoffs && <><dt>Trade-offs</dt><dd>{b.tradeoffs}</dd></>}
            {b.measures && <><dt>Success measures</dt><dd>{b.measures}</dd></>}
            {b.cost && <><dt>Cost</dt><dd>{b.cost}</dd></>}
            {b.unlocks && <><dt>Unlocks</dt><dd>{b.unlocks}</dd></>}
          </dl>
        )}
        {bundle.length > 0 && (
          <div>
            <div className="co-sub">Aligned with it</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{bundle.map((k) => <Pill key={k.id} tone="muted" plain>{k.label}: {k.title}</Pill>)}</div>
          </div>
        )}
        {c && (
          <div className="co-note" data-testid="brief-classification">
            <b>{c.needs ? 'Why it needs you' : 'Why the owner did not escalate it'}</b>{a.floor ? ' (this class always needs you here)' : ''}: {c.reasoning}
            {(c.assessed.reasons.length > 0 || criteriaLines(c.criteria).length > 0) && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                {criteriaLines(c.criteria).map((l) => <Pill key={l} plain tone="muted">{l}</Pill>)}
              </div>
            )}
          </div>
        )}
        {a.conditions && <div className="co-note"><b>Conditions:</b> {a.conditions}</div>}

        <div>
          <div className="co-sub">Discussion</div>
          {a.thread.length === 0 ? <p className="co-faint" style={{ margin: '4px 0' }}>No comments yet.</p> : (
            <ol data-testid="alignment-thread" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
              {a.thread.slice(-20).map((e, i) => (
                <li key={i} style={{ fontSize: 13, lineHeight: 1.5 }} data-kind={e.kind}>
                  <span style={{ fontWeight: 600 }}>{threadWho(e, (id) => names.get(id)?.name)}</span>
                  <span className="co-faint"> · {THREAD_KIND[e.kind] ?? e.kind} · {ago(e.at)}</span>
                  <div style={{ whiteSpace: 'pre-wrap', color: 'var(--text)' }}>{e.text}</div>
                </li>
              ))}
            </ol>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input className="co-input" aria-label="Comment to the owner" placeholder={`Ask ${owner?.name ?? 'the owner'} a question…`} value={comment} onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void post(); }} />
            <button className="co-btn" disabled={busy || !comment.trim()} onClick={() => void post()}>Comment</button>
          </div>
        </div>

        {actions.length > 0 && (
          <div style={{ display: 'grid', gap: 8, borderTop: '1px solid var(--border)', paddingTop: 12 }} data-testid="alignment-actions">
            <label className="co-field">
              <span>Your note</span>
              <textarea className="co-input" rows={2} value={note} onChange={(e) => { setNote(e.target.value); setNeed(null); }} placeholder="Conditions, changes or comments for the owner (needed for “with changes”, “send back” and “re-open”)" aria-label="Your note" />
              {need && <small style={{ color: 'var(--warn-text)' }} role="alert">{need}</small>}
            </label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {actions.map((x) => <button key={x.id} className={`co-btn${x.primary ? ' primary' : x.id === 'not_needed' ? ' ghost' : ''}`} disabled={busy} onClick={() => void act(x.id, x.needsNote)} data-action={x.id}>{x.label}</button>)}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

const THREAD_KIND: Record<string, string> = {
  request: 'asked for alignment', comment: 'comment', aligned: 'aligned', send_back: 'sent back', rejected: 'rejected', reopened: 're-opened', system: 'note',
  acknowledged: 'reviewed', classified: 'classified', pulled_in: 'pulled in', not_needed: 'not needed',
};

function ClassesCard({ classes }: { classes: OrgAlignmentClasses }) {
  const [open, setOpen] = useState(false);
  const who = { ceo: 'You', chief: 'Chief of staff', auto: 'Auto (logged)' };
  return (
    <Card id="alignment-classes" title="What needs you here" action={<button className="co-link" onClick={() => setOpen(!open)}>{open ? 'Hide why' : 'Show why'}</button>}>
      <div className="co-rows" style={{ margin: '0 -10px' }} data-testid="alignment-classes">
        {classes.classes.map((c) => (
          <div key={c.id} className="co-row" style={{ cursor: 'default' }}>
            <span className="co-row-main">
              <span className="co-row-title wrap">{c.label[0].toUpperCase() + c.label.slice(1)}</span>
              <span className="co-row-meta">{c.covers}</span>
              {open && <span className="co-row-meta">{c.rationale} {c.sources.map((s) => classes.sources[s]).filter(Boolean).map((s, i) => <a key={i} href={s!.url} target="_blank" rel="noreferrer" style={{ marginLeft: 6 }}>{s!.title}</a>)}</span>}
            </span>
            <span className="co-row-end" style={{ flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
              <Pill tone={c.aligner === 'ceo' ? 'accent' : 'muted'} plain>{who[c.aligner]}</Pill>
              {classes.mode === 'supervised' && <span className="co-faint" style={{ fontSize: 11.5 }}>{c.floor ? 'always' : 'owner decides'}</span>}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

