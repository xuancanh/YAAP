/** Direction › Alignment (docs/alignment.md): what the company builds
 *  toward, agreed with the CEO before tasks are created under it. One page
 *  in the shared language of the company sections: a count of what waits
 *  where, "Needs your alignment" first (what owners asked you, and what was
 *  aligned without you), the brief of the selected item — summary, why,
 *  options and trade-offs, measures, cost, what it unlocks, how the owner
 *  classified it — with its thread and a decision bar that stays in reach
 *  while you read; then what the agents decided not to escalate (pull one
 *  in), what is with the owners, the history of what was aligned and when,
 *  and who aligns each class here. With nothing yet, one empty state
 *  explains the flow instead of five empty cards. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import { api, type OrgAlignment, type OrgAlignmentClasses, type OrgAlignmentDecision, type OrgDetail, type OrgEscalationFinding } from '../lib/api';
import { VIA_LABEL, alignmentActions, alignmentBadge, alignmentGroups, classGroups, criteriaLines, notePrompt, threadWho } from '../lib/alignment';
import { plural, shortDate } from '../lib/direction';
import { ago, useAgentNames } from './org-ui';
import { Avatar, Card, Empty, Metric, Owner, PageHeader, Pill, SkeletonRows } from './CompanyKit';
import '../styles/align-improve.css';

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

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

export function AlignmentPane({ org }: { org: OrgDetail }) {
  const app = useApp();
  const ws = org.workspaceId;
  const { items, reload } = useAlignments(ws);
  const [classes, setClasses] = useState<OrgAlignmentClasses | null>(null);
  const [findings, setFindings] = useState<OrgEscalationFinding[]>([]);
  const briefRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    api.orgAlignmentClasses(ws).then(setClasses).catch(() => setClasses(null));
    api.orgAlignmentSpotCheck(ws).then(setFindings).catch(() => setFindings([]));
  }, [ws]);
  const groups = useMemo(() => alignmentGroups(items ?? []), [items]);
  const focus = app.orgFocus?.kind === 'alignment' ? app.orgFocus.id : null;
  const selectedId = focus ?? groups.needsYou[0]?.id ?? null;
  const selected = (items ?? []).find((a) => a.id === selectedId) ?? null;
  const select = (id: string) => {
    app.setOrgFocus({ kind: 'alignment', id });
    // The brief sits in the left column: bring it into view when it is off screen (a row on the right, a phone).
    requestAnimationFrame(() => {
      const el = briefRef.current;
      if (!el || typeof el.getBoundingClientRect !== 'function') return;
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.top > window.innerHeight - 120) el.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    });
  };
  const bundle = selected ? (items ?? []).filter((a) => a.bundleOf === selected.id || (selected.itemType !== 'key_result' && a.parentId === selected.itemId && a.id !== selected.id)) : [];
  const underFlags = useMemo(() => new Map(findings.filter((f) => f.kind === 'under').map((f) => [f.alignmentId, f.why])), [findings]);
  const nothing = items && items.length === 0;

  return (
    <div className="co-page al-page" data-testid="alignment-pane">
      <PageHeader title="Alignment" purpose={<>
        What the company builds toward is agreed with you before tasks are created under it: the direction, the strategy, OKRs, project bets, spend beyond the plan, outside commitments, organisation design, values and one-way doors. Owners judge by a few criteria whether an item needs you; in a supervised company some classes always do. Tasks under an item that is not aligned wait, except a little discovery work. An autonomous company aligns without you and logs it, so you can review and override.
      </>} />
      {items === undefined ? <SkeletonRows rows={4} /> : items === null ? <div className="co-alert" role="alert">Alignment did not load. Reload the page to try again.</div> : nothing ? (
        <div className="co-split">
          <Card id="alignment-empty">
            <Empty title="Nothing to align yet" testid="alignment-clear" action={<button className="co-btn" onClick={() => { app.setOrgFocus(null); app.setOrgPane('vision'); }}>Open the vision</button>}>
              When an owner drafts the direction, the strategy, an objective or a project bet that needs you, it lands here and in your Inbox with a written brief: what, why, the options, the cost and how success is measured. You approve it, approve with changes or send it back; work under it starts once it is aligned.
            </Empty>
          </Card>
          {classes && <ClassesCard classes={classes} />}
        </div>
      ) : (
        <>
          <div className="co-metrics al-counts" data-testid="alignment-counts">
            <Metric n={groups.needsYou.length} label="need you" tone={groups.needsYou.length ? 'warn' : undefined} onClick={() => jump('al-needs')} />
            <Metric n={groups.notEscalated.length} label="not escalated" tone={underFlags.size ? 'warn' : undefined} onClick={() => jump('al-not-escalated')} title={underFlags.size ? `${plural(underFlags.size, 'spot-check flag')}` : undefined} />
            <Metric n={groups.inFlight.length} label="with the owners" onClick={() => jump('al-with-owners')} />
            <Metric n={groups.history.length} label="aligned" tone={groups.history.length ? 'ok' : undefined} onClick={() => jump('al-history')} />
          </div>
          <div className="co-split">
            <div className="co-stack">
              <div id="al-needs" className="al-anchor">
                <Card id="needs-alignment" title="Needs your alignment" aside={groups.needsYou.length || undefined}>
                  {groups.needsYou.length === 0
                    ? <Empty compact title="Nothing waits on you" testid="alignment-clear">When an owner asks you to align on the direction, the strategy, an OKR or a bet, it lands here and in your Inbox.</Empty>
                    : <ItemRows items={groups.needsYou} selectedId={selectedId} onSelect={select} />}
                </Card>
              </div>
              <div ref={briefRef} className="al-anchor">
                {selected
                  ? <BriefCard a={selected} bundle={bundle} wsId={ws} onChanged={reload} classes={classes} flag={underFlags.get(selected.id)} />
                  : groups.needsYou.length === 0 && <p className="co-faint al-hint">Pick any item on this page to read its brief.</p>}
              </div>
            </div>
            <div className="co-stack">
              <div id="al-not-escalated" className="al-anchor">
                <Card id="not-escalated" title="Not escalated" aside={groups.notEscalated.length || undefined}>
                  {groups.notEscalated.length === 0 ? <Empty compact title="Nothing classified out">Items an owner decides do not need you appear here with the reasoning; pull one in if it should.</Empty> : (
                    <ItemRows items={groups.notEscalated} selectedId={selectedId} onSelect={select} why={(a) => a.classification?.reasoning ?? ''} flags={underFlags} />
                  )}
                </Card>
              </div>
              <div id="al-with-owners" className="al-anchor">
                <Card id="with-owners" title="With the owners" aside={groups.inFlight.length || undefined}>
                  {groups.inFlight.length === 0 ? <Empty compact title="Nothing in preparation">Drafts, send-backs and re-alignments the owners are working on.</Empty> : <ItemRows items={groups.inFlight} selectedId={selectedId} onSelect={select} />}
                </Card>
              </div>
              <div id="al-history" className="al-anchor"><HistoryCard items={groups.history} selectedId={selectedId} onSelect={select} /></div>
              {classes && <ClassesCard classes={classes} />}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ItemRows({ items, selectedId, onSelect, why, flags }: { items: OrgAlignment[]; selectedId: string | null; onSelect: (id: string) => void; why?: (a: OrgAlignment) => string; flags?: Map<string, string> }) {
  const names = useAgentNames();
  return (
    <div className="co-rows al-rows">
      {items.map((a) => {
        const flag = flags?.get(a.id);
        const owner = a.ownerAgentId ? names.get(a.ownerAgentId) : undefined;
        const line = why?.(a) || (a.state !== 'aligned' && a.reopenReasons[0] ? `Changed: ${a.reopenReasons.join('; ')}` : a.brief.what);
        const when = a.requestedAt && a.state === 'in_alignment' ? `asked ${ago(a.requestedAt)}` : a.state === 'aligned' && a.alignedAt ? `aligned ${ago(a.alignedAt)}` : '';
        return (
          <button key={a.id} className="co-row" onClick={() => onSelect(a.id)} aria-current={a.id === selectedId || undefined} data-testid="alignment-row" data-state={a.state}>
            <span className="co-row-main">
              <span className="co-row-title wrap">{a.title}</span>
              <span className="co-row-meta">{[cap(a.label), owner?.name, when].filter(Boolean).join(' · ')}</span>
              {line && <span className="co-row-meta al-clamp">{line}</span>}
              {flag && <span className="al-flag" data-testid="spot-check-flag">Spot-check: {flag}</span>}
            </span>
            <span className="co-row-end"><AlignmentBadge a={a} /></span>
          </button>
        );
      })}
    </div>
  );
}

function HistoryCard({ items, selectedId, onSelect }: { items: OrgAlignment[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 8);
  return (
    <Card id="alignment-history" title="Aligned" aside={items.length || undefined}>
      {items.length === 0 ? <Empty compact title="Nothing aligned yet">Each alignment is kept with its version, who aligned it, when and on what conditions.</Empty> : (
        <div className="co-rows al-rows" data-testid="alignment-history">
          {shown.map((a) => (
            <button key={a.id} className="co-row" onClick={() => onSelect(a.id)} aria-current={a.id === selectedId || undefined}>
              <span className="co-row-main">
                <span className="co-row-title wrap">{a.title}</span>
                <span className="co-row-meta">{cap(a.label)} · v{a.alignedVersion ?? a.version} · by {VIA_LABEL[a.alignedVia] ?? a.alignedVia} · {shortDate(a.alignedAt)}{a.conditions ? ' · with conditions' : ''}</span>
              </span>
              <span className="co-row-end"><AlignmentBadge a={a} /></span>
            </button>
          ))}
          {items.length > 8 && <button className="co-link al-more" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${items.length}`}</button>}
        </div>
      )}
    </Card>
  );
}

/** The brief of one item: the decision card the CEO reads, its thread and its decision bar. */
export function BriefCard({ a, bundle = [], wsId, onChanged, classes, flag }: { a: OrgAlignment; bundle?: OrgAlignment[]; wsId: string; onChanged: () => Promise<void> | void; classes?: OrgAlignmentClasses | null; flag?: string }) {
  const app = useApp();
  const names = useAgentNames();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setComment(''); }, [a.id]);
  const b = a.brief;
  const owner = a.ownerAgentId ? names.get(a.ownerAgentId) : undefined;
  const post = async () => {
    if (!comment.trim()) return;
    setBusy(true);
    try { await api.commentOrgAlignment(wsId, a.id, comment.trim()); setComment(''); await onChanged(); } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); } finally { setBusy(false); }
  };
  const c = a.classification;
  const classLabel = c ? classes?.classes.find((k) => k.id === c.class)?.label ?? c.class : '';
  const criteria = c ? criteriaLines(c.criteria) : [];
  const hasFields = Boolean(b.why || b.options.length || b.tradeoffs || b.measures || b.cost || b.unlocks);
  return (
    <section className="co-card al-brief" data-testid="dash-card-alignment-brief" aria-labelledby={`al-brief-${a.id}`}>
      <header className="al-brief-head">
        <div className="al-brief-kicker">
          <span>{cap(a.label)} · v{a.version}{a.alignedVersion && a.alignedVersion !== a.version ? ` (v${a.alignedVersion} aligned)` : ''}</span>
          <AlignmentBadge a={a} testid="brief-badge" />
        </div>
        <h3 className="al-brief-title" id={`al-brief-${a.id}`}>{a.title}</h3>
        <div className="al-brief-meta">
          <Owner agent={owner} none="No owner" role="owner" />
          {a.requestedAt && <span>asked {ago(a.requestedAt)}</span>}
          {a.state === 'aligned' && a.alignedAt && <span>aligned by {VIA_LABEL[a.alignedVia] ?? a.alignedVia}, {shortDate(a.alignedAt)}</span>}
        </div>
      </header>
      <div className="al-brief-body" data-testid="alignment-brief">
        {b.what ? <p className="al-what" data-testid="brief-what">{b.what}</p> : <p className="co-faint" style={{ margin: 0 }}>The owner has not written a brief yet. Ask them in the discussion below.</p>}
        {a.reopenReasons.length > 0 && a.state !== 'aligned' && <div className="co-note warn">Changed since it was aligned: {a.reopenReasons.join('; ')}</div>}
        {flag && <div className="co-note warn" data-testid="brief-flag">Spot-check: {flag}. Pull it in if it should have come to you.</div>}
        {hasFields && (
          <dl className="co-dl al-dl" data-testid="brief-fields">
            {b.why && <><dt>Why</dt><dd>{b.why}</dd></>}
            {b.options.length > 0 && <><dt>Options considered</dt><dd><ol className="al-options">{b.options.map((o, i) => <li key={i}>{o}</li>)}</ol></dd></>}
            {b.tradeoffs && <><dt>Trade-offs</dt><dd>{b.tradeoffs}</dd></>}
            {b.measures && <><dt>Success measures</dt><dd>{b.measures}</dd></>}
            {b.cost && <><dt>Cost</dt><dd>{b.cost}</dd></>}
            {b.unlocks && <><dt>Unlocks</dt><dd>{b.unlocks}</dd></>}
          </dl>
        )}
        {bundle.length > 0 && (
          <div>
            <div className="co-sub">Aligned with it</div>
            <ul className="al-bundle">{bundle.map((k) => <li key={k.id}><span className="co-faint">{cap(k.label)}</span> {k.title}</li>)}</ul>
          </div>
        )}
        {a.conditions && <div className="co-note" data-testid="brief-conditions"><b>Conditions:</b> {a.conditions}</div>}
        {c && (
          <div className="al-class" data-testid="brief-classification">
            <div className="al-class-head">
              <b>{c.needs ? 'Why it needs you' : 'Why the owner did not escalate it'}</b>
              {classLabel && <Pill plain tone="muted">{cap(classLabel)}</Pill>}
              {a.floor && <Pill plain tone="accent" title="In a supervised company this class always comes to you">Always yours here</Pill>}
            </div>
            <p>{c.reasoning}</p>
            {criteria.length > 0 && <div className="al-criteria" aria-label="The owner's answers to the criteria">{criteria.map((l) => <Pill key={l} plain tone="muted">{l}</Pill>)}</div>}
          </div>
        )}

        <div className="al-thread-wrap">
          <div className="co-sub">Discussion{a.thread.length ? ` · ${a.thread.length}` : ''}</div>
          {a.thread.length === 0 ? <p className="co-faint" style={{ margin: '2px 0 8px' }}>No comments yet. Questions go to {owner?.name ?? 'the owner'} and come back here.</p> : (
            <ol className="al-thread" data-testid="alignment-thread">
              {a.thread.slice(-20).map((e, i) => {
                const agentId = e.by.startsWith('agent:') ? e.by.slice(6) : null;
                const you = threadWho(e, () => undefined) === 'You';
                return (
                  <li key={i} data-kind={e.kind} className={you ? 'you' : undefined}>
                    {you ? <span className="al-you" aria-hidden>You</span> : <Avatar a={agentId ? names.get(agentId) : undefined} size={22} />}
                    <div>
                      <div className="al-thread-who"><b>{threadWho(e, (id) => names.get(id)?.name)}</b><span className="co-faint"> · {THREAD_KIND[e.kind] ?? e.kind} · {ago(e.at)}</span></div>
                      <div className="al-thread-text">{e.text}</div>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          <form className="al-comment" onSubmit={(e) => { e.preventDefault(); void post(); }}>
            <input className="co-input" aria-label="Comment to the owner" placeholder={`Ask ${owner?.name ?? 'the owner'} a question…`} value={comment} onChange={(e) => setComment(e.target.value)} />
            <button type="submit" className="co-btn" disabled={busy || !comment.trim()}>Comment</button>
          </form>
        </div>
      </div>
      <DecisionBar a={a} wsId={wsId} onChanged={onChanged} />
    </section>
  );
}

/** The decisions an item offers, in a bar that stays at the bottom of the
 *  screen while the brief scrolls. A decision that needs words opens a note
 *  with its own confirm; Reject asks once more; the rest act at once. */
function DecisionBar({ a, wsId, onChanged }: { a: OrgAlignment; wsId: string; onChanged: () => Promise<void> | void }) {
  const app = useApp();
  const [open, setOpen] = useState<OrgAlignmentDecision | null>(null);
  const [confirm, setConfirm] = useState<OrgAlignmentDecision | null>(null);
  const [note, setNote] = useState('');
  const [need, setNeed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setOpen(null); setConfirm(null); setNote(''); setNeed(null); }, [a.id]);
  const actions = alignmentActions(a);
  if (actions.length === 0) return null;
  const prompt = open ? notePrompt(open, a.state) : null;
  const decide = async (id: OrgAlignmentDecision, withNote?: string) => {
    setBusy(true);
    try {
      await api.decideOrgAlignment(wsId, a.id, id, withNote?.trim() || undefined);
      setOpen(null); setConfirm(null); setNote(''); setNeed(null);
      await onChanged(); void app.refreshWsOrg?.();
    } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); } finally { setBusy(false); }
  };
  const click = (id: OrgAlignmentDecision, needsNote: boolean) => {
    if (needsNote) { setOpen(open === id ? null : id); setConfirm(null); setNeed(null); return; }
    if (id === 'reject' && confirm !== 'reject') { setConfirm('reject'); setOpen(null); return; }
    void decide(id);
  };
  const submit = () => {
    if (!open || !prompt) return;
    if (!note.trim()) { setNeed(prompt.required); return; }
    void decide(open, note);
  };
  return (
    <div className="al-decide" data-testid="alignment-actions">
      {prompt && (
        <form className="al-note" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <label className="co-field">
            <span>{prompt.label}</span>
            <textarea className="co-input" rows={2} autoFocus value={note} onChange={(e) => { setNote(e.target.value); setNeed(null); }} placeholder={prompt.placeholder} aria-label="Your note"
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } if (e.key === 'Escape') setOpen(null); }} />
            {need && <small className="al-need" role="alert">{need}</small>}
          </label>
          <div className="al-btns">
            <button type="submit" className="co-btn primary" disabled={busy} data-confirm={open}>{prompt.confirm}</button>
            <button type="button" className="co-btn ghost" onClick={() => setOpen(null)}>Cancel</button>
          </div>
        </form>
      )}
      {!prompt && (
        <div className="al-btns">
          {actions.map((x) => {
            const confirming = confirm === x.id;
            return (
              <button key={x.id} type="button" disabled={busy} onClick={() => click(x.id, x.needsNote)} data-action={x.id} aria-haspopup={x.needsNote ? 'dialog' : undefined}
                className={`co-btn${confirming ? ' al-danger' : x.primary ? ' primary' : x.id === 'not_needed' ? ' ghost' : ''}`}
                title={x.id === 'not_needed' ? 'Clear it and tell the owner this kind of item does not need you next time' : undefined}>
                {confirming ? 'Confirm: reject it' : x.needsNote ? `${x.label}…` : x.label}
              </button>
            );
          })}
          {confirm && <button type="button" className="co-btn ghost" onClick={() => setConfirm(null)}>Keep it</button>}
        </div>
      )}
    </div>
  );
}

const THREAD_KIND: Record<string, string> = {
  request: 'asked for alignment', comment: 'comment', aligned: 'aligned', send_back: 'sent back', rejected: 'rejected', reopened: 're-opened', system: 'note',
  acknowledged: 'reviewed', classified: 'classified', pulled_in: 'pulled in', not_needed: 'not needed',
};

function ClassesCard({ classes }: { classes: OrgAlignmentClasses }) {
  const [open, setOpen] = useState(false);
  const groups = classGroups(classes.classes, classes.mode);
  return (
    <Card id="alignment-classes" title="What needs you here" aside={classes.mode === 'off' ? 'alignment is off' : undefined} action={<button className="co-link" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide why' : 'Show why'}</button>}>
      <div className="al-classes" data-testid="alignment-classes">
        {groups.map((g) => (
          <div key={g.group} data-group={g.group}>
            <div className="co-sub">{g.label}</div>
            <ul>
              {g.classes.map((c) => (
                <li key={c.id}>
                  <span className="al-class-name">{cap(c.label)}</span>
                  <span className={`co-row-meta${open ? ' al-open' : ''}`}>{c.covers}</span>
                  {open && <span className="co-row-meta al-open al-why">{c.rationale}{c.sources.map((s) => classes.sources[s]).filter(Boolean).map((s, i) => <a key={i} href={s!.url} target="_blank" rel="noreferrer">{s!.title}</a>)}</span>}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  );
}
