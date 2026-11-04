/**
 * The Inbox's reading pane (docs/owners-seat.md "Inbox and notifications"):
 * one feed item in full, so a decision is taken with its context and not
 * from a two-line preview. In order: who it is from and when, the title,
 * what is being asked in plain words, the deadline and what happens if you
 * do nothing, the why (the card's reason or the message), the card's facts
 * (a hire's role, name, who it reports to, budget, pack, access), the route
 * it climbed, the recommendation, and its context (task, project, channel,
 * meeting) — then the actions. An escalation is a question: it gets an
 * answer box (the answer goes to the task as your decision and unblocks
 * it) and "Cancel the task" behind a confirm. A decision can carry a note.
 * Wide screens show it beside the list; a phone shows it full screen with
 * Back. `a` / `r` decide only here, once an item is open.
 */
import { useEffect, useRef, useState } from 'react';
import type { FeedAction, FeedItem } from '../lib/api';
import { askOf, contextChips, defaultLine, FEED_LABEL, feedActionLabel, feedFacts, feedLongText, feedOpen, feedTone, openLabel, relLabel, whenLabel, yesNo } from '../lib/feed';
import { I, P } from '../lib/icons';
import { FeedAvatar } from './FeedRow';

export interface InboxDetailProps {
  item: FeedItem;
  now: Date;
  /** Phone or narrow: a full-screen pane with Back. */
  stacked: boolean;
  busy: boolean;
  onBack?: () => void;
  onAct: (i: FeedItem, a: FeedAction, note?: string) => void;
  /** Open it where it lives (the task, the chat, the queue…). */
  onGo: (i: FeedItem) => void;
  onMarkRead: (i: FeedItem) => void;
  /** Open the task / the agent named in its context. */
  onTask: (taskId: string) => void;
}

/** "Approve" with its key ("A") on wide screens. */
function Kbd({ k, show }: { k: string; show: boolean }) {
  return show ? <kbd className="ibx-kbd" aria-hidden>{k}</kbd> : null;
}

export function InboxDetail({ item: i, now, stacked, busy, onBack, onAct, onGo, onMarkRead, onTask }: InboxDetailProps) {
  const [note, setNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [confirm, setConfirm] = useState<FeedAction | null>(null);
  const headRef = useRef<HTMLHeadingElement>(null);
  // A different item: a fresh note and no pending confirm.
  useEffect(() => { setNote(''); setNoteOpen(false); setConfirm(null); }, [i.id]);

  const tone = feedTone(i);
  const ask = askOf(i);
  const deadline = defaultLine(i, now);
  const facts = feedFacts(i);
  const long = feedLongText(i);
  const go = openLabel(i);
  const need = i.need;
  const { yes, no } = yesNo(i);
  const escalation = i.type === 'escalation' && yes === 'approve' && no === 'reject';
  const takesNote = Boolean(need?.ref.approvalId || need?.ref.actionId || need?.ref.signalId);
  const keys = !stacked && !escalation; // an escalation is answered in its box, not with a key
  const who = i.actor && i.actor.kind !== 'system' ? i.actor.name : i.actor?.name ?? '';
  const urgentDeadline = Boolean(i.deadline && (i.expiresSoon || Date.parse(i.deadline) <= now.getTime()));

  // Context: the task (opens it), the project, the channel, the meeting.
  const c = i.context;
  const task = c.taskId ? { id: c.taskId, label: [c.taskKey, c.taskTitle].filter(Boolean).join(' ') || 'The task' } : null;
  const otherChips = contextChips({ ...i, title: `${i.title} ${c.taskKey ?? ''}` }).filter((x) => x !== c.taskKey);

  const run = (a: FeedAction) => {
    // Cancelling a task or rejecting a hire is final: confirm once.
    if ((a === 'reject' || a === 'deny' || a === 'veto') && confirm !== a && (escalation || a === 'veto')) { setConfirm(a); return; }
    setConfirm(null);
    onAct(i, a, takesNote ? note : undefined);
  };
  const label = (a: FeedAction) => {
    if (escalation && a === 'approve') return 'Answer and unblock';
    if (escalation && a === 'reject') return confirm === 'reject' ? `Confirm: cancel ${c.taskKey ?? 'the task'}` : 'Cancel the task';
    if (a === 'veto' && confirm === 'veto') return 'Confirm veto';
    return feedActionLabel(i, a);
  };

  return (
    <article className="ibx-detail" data-testid={`inbox-detail-${i.id}`} aria-labelledby="ibx-detail-title">
      <header className="ibx-dhead">
        {onBack && (
          <button type="button" className="ibx-ghost" onClick={onBack} data-testid="inbox-detail-back" aria-label="Back to the list">
            <I d={P.chevL} size={16} sw={2} /> {stacked ? 'Inbox' : ''}
          </button>
        )}
        <span className={`ibx-kind tone-${tone}`}>{FEED_LABEL[i.type]}</span>
        <span className="ibx-spacer" />
        {!i.read && <button type="button" className="ibx-ghost" onClick={() => onMarkRead(i)} data-testid="inbox-detail-read" title="Mark read (m)"><I d={P.check} size={14} sw={2.2} /> Mark read</button>}
        {go && feedOpen(i).to !== 'inbox' && (
          <button type="button" className="ibx-ghost" onClick={() => onGo(i)} data-testid="inbox-detail-go" title="Open where it lives (o)">
            {go} <I d={P.external} size={13} sw={2} />
          </button>
        )}
      </header>

      <div className="ibx-dscroll">
        <div className="ibx-dbody">
          <div className="ibx-from">
            <FeedAvatar item={i} size={34} />
            <div style={{ minWidth: 0 }}>
              <div className="ibx-from-name">{who || 'System'}</div>
              <div className="ibx-from-meta" title={new Date(i.at).toLocaleString()}>
                {whenLabel(i.at, now)} · {relLabel(i.at, now)}{i.count > 1 ? ` · ${i.count} updates` : ''}{i.company ? ` · ${i.company}` : ''}
              </div>
            </div>
          </div>

          <h1 id="ibx-detail-title" ref={headRef} className="ibx-dtitle" tabIndex={-1}>{i.title}</h1>
          {ask && <p className="ibx-ask" data-testid="inbox-detail-ask">{ask}</p>}

          {deadline && (
            <div className={`ibx-deadline${urgentDeadline ? ' warn' : ''}`} data-testid="inbox-detail-deadline" role="note">
              <I d={P.clock} size={15} sw={2} />
              <span>{deadline}</span>
            </div>
          )}

          {i.body && (
            <section className="ibx-sec" aria-label={i.section === 'mentions' ? 'Message' : 'Why'}>
              <h2 className="ibx-h">{i.section === 'mentions' ? 'Message' : i.section === 'needs' ? 'Why' : 'What happened'}</h2>
              <p className="ibx-prose" data-testid="inbox-detail-body">{i.body}</p>
            </section>
          )}

          {facts.length > 0 && (
            <section className="ibx-sec" aria-label="Details">
              <h2 className="ibx-h">Details</h2>
              <dl className="ibx-facts" data-testid="inbox-detail-facts">
                {facts.map((f) => (
                  <div key={f.label} className="ibx-fact"><dt>{f.label}</dt><dd>{f.value}</dd></div>
                ))}
              </dl>
            </section>
          )}

          {long && (
            <section className="ibx-sec" aria-label={long.label}>
              <h2 className="ibx-h">{long.label}</h2>
              <p className="ibx-prose dim">{long.text}</p>
            </section>
          )}

          {need?.chain && (
            <section className="ibx-sec" aria-label="How it reached you" data-testid="feed-route">
              <h2 className="ibx-h">How it reached you</h2>
              <ol className="ibx-route">
                {need.chain.line.split(/\s*→\s*/).map((step, n, all) => (
                  <li key={`${step}-${n}`} className={n === all.length - 1 ? 'last' : ''}>
                    {n > 0 && <span className="arrow" aria-hidden>→</span>}<span className="step">{step}</span>
                  </li>
                ))}
              </ol>
              {need.chain.hops.filter((h) => h.recommendation || h.reasoning).map((h, n) => (
                <p key={n} className="ibx-hop"><strong>{h.by}</strong>{h.recommendation ? ` recommends ${h.recommendation}` : ` ${h.action.replace(/_/g, ' ')}`}{h.reasoning ? `: ${h.reasoning}` : '.'}</p>
              ))}
              {need.chain.reserved && <p className="ibx-hop dim">Only you can decide this: {need.chain.reserved}</p>}
            </section>
          )}

          {need && (need.recommendation || need.reversibility) && (
            <section className="ibx-sec" aria-label="Recommendation">
              <h2 className="ibx-h">Recommendation</h2>
              {need.recommendation && <p className="ibx-prose">{need.recommendation}</p>}
              <p className="ibx-hop dim">
                {[need.recommendedAction ? `Suggests: ${need.recommendedAction}` : '', need.confidence !== null ? `${Math.round(need.confidence * 100)}% confident` : '', need.reversibility ? `Reversibility: ${need.reversibility.replace(/_/g, ' ')}` : ''].filter(Boolean).join(' · ')}
              </p>
            </section>
          )}

          {(task || otherChips.length > 0) && (
            <section className="ibx-sec" aria-label="Context">
              <h2 className="ibx-h">Context</h2>
              <div className="ibx-ctx">
                {task && <button type="button" className="ibx-ctx-chip link" onClick={() => onTask(task.id)} data-testid="inbox-detail-task">{task.label}</button>}
                {otherChips.map((x) => <span key={x} className="ibx-ctx-chip">{x}</span>)}
              </div>
            </section>
          )}
        </div>
      </div>

      {(i.actions.length > 0 || (go && feedOpen(i).to !== 'inbox')) && (
        <footer className="ibx-dfoot" data-testid="inbox-detail-actions">
          {escalation && (
            <label className="ibx-answer">
              <span className="ibx-h">Your answer</span>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} data-testid="inbox-answer"
                placeholder={`Tell ${who || 'them'} what to do. The task goes on with your answer.`} />
            </label>
          )}
          {!escalation && takesNote && noteOpen && (
            <label className="ibx-answer">
              <span className="ibx-h">Note</span>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} data-testid="inbox-note" placeholder="Why, for the record (optional)" autoFocus />
            </label>
          )}
          <div className="ibx-btns">
            {i.actions.map((a, n) => (
              <button key={a} type="button" disabled={busy || (escalation && a === 'approve' && !note.trim())} data-testid={`feed-action-${a}`}
                className={`ibx-btn${n === 0 && confirm !== a ? ' primary' : ''}${confirm === a ? ' danger' : ''}`} onClick={() => run(a)}>
                {label(a)}
                {a === yes && <Kbd k="A" show={keys} />}
                {a === no && <Kbd k="R" show={keys} />}
              </button>
            ))}
            {confirm && <button type="button" className="ibx-btn quiet" onClick={() => setConfirm(null)}>Keep it</button>}
            {!escalation && takesNote && !noteOpen && i.actions.length > 0 && <button type="button" className="ibx-btn quiet" onClick={() => setNoteOpen(true)} data-testid="inbox-add-note">Add a note</button>}
            {i.actions.length === 0 && go && feedOpen(i).to !== 'inbox' && (
              <button type="button" className="ibx-btn primary" onClick={() => onGo(i)} data-testid="inbox-detail-open">{go}<Kbd k="O" show={keys} /></button>
            )}
          </div>
        </footer>
      )}
    </article>
  );
}

/** The pane when nothing is open: what the keys do. */
export function InboxPaneEmpty({ clear }: { clear: boolean }) {
  return (
    <div className="ibx-pane-empty" data-testid="inbox-pane-empty">
      <I d={P.inbox} size={26} sw={1.6} />
      <p className="ibx-pane-empty-title">{clear ? 'Nothing to read here' : 'Pick something to read'}</p>
      <p className="ibx-pane-empty-keys">
        <kbd className="ibx-kbd">J</kbd> <kbd className="ibx-kbd">K</kbd> move · <kbd className="ibx-kbd">Enter</kbd> open · <kbd className="ibx-kbd">E</kbd> done · <kbd className="ibx-kbd">O</kbd> open where it lives
      </p>
    </div>
  );
}
