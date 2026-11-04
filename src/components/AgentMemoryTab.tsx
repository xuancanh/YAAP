/** The agent's Memory tab (docs/agent-memory.md): what it has learned, with
 *  the evidence and the counts; what it learned this week; its own "How I
 *  work" section and where each change came from; the guidance proposals
 *  waiting on a decision. Injected memory has to be inspectable and
 *  revocable: a lesson silently shapes every future turn, so a memory nobody
 *  can see is one nobody can correct — every lesson can be pinned, edited,
 *  retired or forgotten here. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { api, type Agent, type AgentGuidanceView, type AgentLesson, type GuidanceChange } from '../lib/api';

const card: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 14, background: 'var(--panel)' };
const label: React.CSSProperties = { fontSize: 11, fontWeight: 600, letterSpacing: '.6px', textTransform: 'uppercase', color: 'var(--text-faint)' };
const btn: React.CSSProperties = { background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 8, padding: '5px 11px', fontSize: 11.5, cursor: 'pointer' };
const primary: React.CSSProperties = { background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, padding: '5px 11px', fontSize: 11.5, fontWeight: 700, cursor: 'pointer' };
const chip: React.CSSProperties = { fontSize: 9.5, fontWeight: 600, borderRadius: 4, padding: '0 5px', border: '1px solid var(--border)', color: 'var(--text-dim)', fontFamily: 'var(--mono)' };
const area: React.CSSProperties = { width: '100%', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 9, padding: '9px 12px', color: 'var(--text)', fontSize: 13, lineHeight: 1.5, outline: 'none', resize: 'vertical', fontFamily: 'inherit' };

const WEEK_MS = 7 * 24 * 60 * 60_000;
const CAUSE_LABEL: Record<string, string> = {
  distill: 'from a conversation', note: 'noted while working', review: 'review sent it back', failure: 'a run was stopped',
  feedback: 'a person corrected it', decision: 'the CEO turned it down', retro: 'from a retro', import: 'imported',
};

export function parseRefs(raw: string | undefined | null): string[] {
  try { const v = JSON.parse(raw || '[]') as unknown; return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}
/** `task:REJ-35` → `REJ-35`; `meeting:ab12…` → `meeting ab12cd34`; session refs are not shown. */
export function refLabel(ref: string): string | null {
  const [kind, ...rest] = ref.split(':');
  const id = rest.join(':');
  if (kind === 'session') return null;
  if (kind === 'task') return id;
  if (kind === 'message') return 'a reply';
  return id ? `${kind} ${id.slice(0, 8)}` : ref;
}
export const shortId = (id: string): string => id.replace(/^les_/, '').slice(0, 8);
/** Learned (created) or learned again (a repeat freshens updatedAt) within the week. */
export const learnedThisWeek = (r: AgentLesson, now = Date.now()): boolean =>
  now - Date.parse(r.createdAt) < WEEK_MS || (r.useCount > 1 && now - Date.parse(r.updatedAt) < WEEK_MS);

type Filter = 'all' | 'week' | 'retired';

export function MemoryTab({ a }: { a: Agent }) {
  const app = useApp();
  const [rows, setRows] = useState<AgentLesson[]>([]);
  const [guidance, setGuidance] = useState<AgentGuidanceView | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [editingGuidance, setEditingGuidance] = useState(false);
  const [guidanceDraft, setGuidanceDraft] = useState('');
  const isOwner = !app.me || app.me.role === 'owner';
  /** 'shared' | 'private:<member>' → a badge label (docs/shared-agents.md §4). */
  const audienceOf = (r: AgentLesson): { label: string; privateTo: string | null } => {
    const aud = r.audience ?? 'shared';
    if (!aud.startsWith('private:')) return { label: 'shared', privateTo: null };
    const member = aud.slice('private:'.length);
    return { label: `private · ${app.nameOf(member)}`, privateTo: member };
  };
  const reload = useCallback(() => {
    void api.agentLessons(a.id).then(setRows).catch(() => setRows([]));
    void api.agentGuidance(a.id).then(setGuidance).catch(() => setGuidance(null));
  }, [a.id]);
  useEffect(reload, [reload]);

  const act = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); reload(); } finally { setBusy(false); } };
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const trusted = rows.filter((r) => r.trusted === 1);
  const active = trusted.filter((r) => (r.status ?? 'active') !== 'retired');
  const retired = trusted.filter((r) => r.status === 'retired');
  const pending = rows.filter((r) => r.trusted === 0);
  const week = active.filter((r) => learnedThisWeek(r));
  const shown = filter === 'retired' ? retired : filter === 'week' ? week : active;

  const lessonChips = (c: GuidanceChange) => parseRefs(c.lessonIds).map((id) => (
    <span key={id} style={chip} title={byId.get(id)?.text ?? 'a lesson since forgotten'}>[{shortId(id)}]</span>
  ));

  // A render function, not a component: a component defined here would be a
  // new type every render and remount the row (losing the textarea's focus).
  const renderRow = (r: AgentLesson) => {
    const refs = parseRefs(r.evidence).map(refLabel).filter((x): x is string => Boolean(x));
    const isRetired = r.status === 'retired';
    return (
      <div key={r.id} data-testid="lesson-row" style={{ ...card, padding: '11px 14px', display: 'flex', gap: 12, alignItems: 'flex-start', opacity: isRetired ? 0.7 : 1 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {editing === r.id ? (
            <textarea aria-label="Lesson text" value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} style={area} />
          ) : (
            <div style={{ fontSize: 13, lineHeight: 1.5, textDecoration: isRetired ? 'line-through' : undefined }}>{r.text}</div>
          )}
          {r.context && editing !== r.id && <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 3 }}>{r.context}</div>}
          <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 4, fontFamily: 'var(--mono)', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>
              {r.cause && CAUSE_LABEL[r.cause] ? CAUSE_LABEL[r.cause] : r.sourceKind}
              {r.useCount > 1 ? ` · learned ${r.useCount}×` : ''}
              {(r.recalls ?? 0) > 0 ? ` · recalled ${r.recalls}×` : ''}
              {r.pinned ? ' · pinned' : ''} · {r.updatedAt.slice(0, 10)}
            </span>
            {refs.map((ref) => <span key={ref} style={chip}>{ref}</span>)}
            {isRetired && r.statusNote && <span>· {r.statusNote}</span>}
            {app.me?.hasMembers && (
              <span title={audienceOf(r).privateTo ? 'Injected only into turns this member starts' : 'Injected for every member'}
                style={{ ...chip, color: audienceOf(r).privateTo ? 'var(--amber)' : 'var(--accent)', border: `1px solid ${audienceOf(r).privateTo ? 'var(--amber)' : 'var(--accent)'}` }}>
                {audienceOf(r).label}
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {editing === r.id ? (
            <>
              <button disabled={busy || !draft.trim()} onClick={() => void act(async () => { await api.patchLesson(a.id, r.id, { text: draft }); setEditing(null); })} style={primary}>Save</button>
              <button disabled={busy} onClick={() => setEditing(null)} style={btn}>Cancel</button>
            </>
          ) : (
            <>
              {app.me?.hasMembers && isOwner && audienceOf(r).privateTo && (
                <button disabled={busy} title="Make this lesson visible to every member (the owner's call — no agent tool can do this)" onClick={() => void act(() => api.patchLesson(a.id, r.id, { audience: 'shared' }))} style={btn}>Share</button>
              )}
              {r.trusted === 0 && (
                <button disabled={busy} onClick={() => void act(() => api.patchLesson(a.id, r.id, { trusted: true }))} style={primary}>Promote</button>
              )}
              {r.trusted === 1 && !isRetired && (
                <button disabled={busy} onClick={() => void act(() => api.patchLesson(a.id, r.id, { pinned: !r.pinned }))} style={btn}>{r.pinned ? 'Unpin' : 'Pin'}</button>
              )}
              <button disabled={busy} onClick={() => { setEditing(r.id); setDraft(r.text); }} style={btn}>Edit</button>
              {r.trusted === 1 && (
                <button disabled={busy} title={isRetired ? 'Use it again' : 'Keep it on record but stop using it'} onClick={() => void act(() => api.patchLesson(a.id, r.id, { status: isRetired ? 'active' : 'retired' }))} style={btn}>{isRetired ? 'Restore' : 'Retire'}</button>
              )}
              <button disabled={busy} onClick={() => void act(() => api.deleteLesson(a.id, r.id))} style={{ ...btn, color: 'var(--text-dim)' }}>Forget</button>
            </>
          )}
        </div>
      </div>
    );
  };

  const self = guidance?.selfGuidance ?? '';
  const selfLog = (guidance?.changes ?? []).filter((c) => c.kind === 'self').slice(0, 3);
  const proposals = guidance?.pending ?? [];

  return (
    <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div data-testid="how-i-work">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginBottom: 10 }}>
          <span style={label}>How {a.name} works</span>
          <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>its own notes, kept as it learns — right after the charter in every turn</span>
        </div>
        <div style={{ ...card, padding: '12px 14px' }}>
          {editingGuidance ? (
            <>
              <textarea aria-label="How I work" value={guidanceDraft} onChange={(e) => setGuidanceDraft(e.target.value)} rows={6} style={area} />
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <button disabled={busy} onClick={() => void act(async () => { await api.putAgentGuidance(a.id, guidanceDraft); setEditingGuidance(false); })} style={primary}>Save</button>
                <button disabled={busy} onClick={() => setEditingGuidance(false)} style={btn}>Cancel</button>
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <div style={{ flex: 1, fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap', color: self ? 'var(--text)' : 'var(--text-dim)' }}>
                {self || `Nothing yet. ${a.name} writes this with memory_guidance when a lesson keeps repeating; you can write it too.`}
              </div>
              <button disabled={busy || !guidance} onClick={() => { setGuidanceDraft(self); setEditingGuidance(true); }} style={btn}>Edit</button>
            </div>
          )}
          {selfLog.length > 0 && !editingGuidance && (
            <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--border-soft)', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {selfLog.map((c) => (
                <div key={c.id} data-testid="guidance-change" style={{ fontSize: 10.5, color: 'var(--text-faint)', fontFamily: 'var(--mono)', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span>{c.createdAt.slice(0, 10)} · {c.by === 'user' ? 'edited by a person' : `revised by ${a.name}`}{c.why ? `: ${c.why}` : ''}</span>
                  {parseRefs(c.lessonIds).length > 0 && <span>· from</span>}
                  {lessonChips(c)}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {proposals.length > 0 && (
        <div data-testid="guidance-proposals">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginBottom: 10 }}>
            <span style={label}>Waiting on a decision · {proposals.length}</span>
            <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>lessons learned often enough to change {a.name}&rsquo;s charter or a playbook — proposed, never written</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {proposals.map((c) => (
              <div key={c.id} style={{ ...card, padding: '11px 14px' }}>
                <div style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 4 }}>{c.kind === 'charter' ? 'Charter change — the CEO decides the card' : 'Playbook revision — its owner has a revise task'}</div>
                <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{c.text}</div>
                <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 4, fontFamily: 'var(--mono)', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span>{c.createdAt.slice(0, 10)}{c.why ? ` · ${c.why}` : ''} · from</span>{lessonChips(c)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 10, flexWrap: 'wrap' }}>
          <span style={label}>Lessons · {active.length}</span>
          <div role="tablist" aria-label="Lesson filter" style={{ display: 'inline-flex', gap: 2, padding: 2, borderRadius: 8, background: 'var(--panel-2)', border: '1px solid var(--border-soft)' }}>
            {([['all', `All ${active.length}`], ['week', `Learned this week ${week.length}`], ['retired', `Retired ${retired.length}`]] as Array<[Filter, string]>).map(([k, text]) => (
              <button key={k} role="tab" aria-selected={filter === k} onClick={() => setFilter(k)} style={{
                background: filter === k ? 'var(--panel)' : 'none', border: filter === k ? '1px solid var(--border)' : '1px solid transparent', borderRadius: 6,
                padding: '3px 9px', fontSize: 11, color: filter === k ? 'var(--text)' : 'var(--text-dim)', cursor: 'pointer',
              }}>{text}</button>
            ))}
          </div>
          <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
            {filter === 'retired' ? 'stale or proved wrong — kept for the record, never in the prompt' : `the most learned go into every turn; the rest when they match the work`}
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {shown.map(renderRow)}
          {shown.length === 0 && (
            <div style={{ ...card, padding: 14, fontSize: 12.5, color: 'var(--text-dim)' }}>
              {filter === 'retired' ? 'Nothing retired.' : filter === 'week' ? 'Nothing new this week.' : `Nothing learned yet. Lessons appear as ${a.name} works: a review that sends work back, a stopped run, a correction, a note it takes, a conversation that goes idle.`}
            </div>
          )}
        </div>
      </div>

      {pending.length > 0 && (
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginBottom: 10 }}>
            <span style={label}>Awaiting review · {pending.length}</span>
            <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
              learned from a mini app, a chat channel or an import — never used until you promote it
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {pending.map(renderRow)}
          </div>
        </div>
      )}
    </div>
  );
}
