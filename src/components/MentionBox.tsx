/** `@mentions` on tasks (docs/work-tracking.md "Mentions"): the comment box
 *  with @ autocomplete over the company's members and the workspace's
 *  people, and the chips a tag renders as in comments and snippets. The
 *  resolution is the channel one (src/lib/channels.ts, mirroring
 *  server/src/groupchat/mentions.ts), so a chip appears exactly where the
 *  server woke an agent or notified a person. */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useApp } from '../store';
import { api, type OrgMentionable } from '../lib/api';
import { applyMention, initials, mentionQuery, mentionSpans, mentionSuggestions, messageMentionSpans, type MentionCandidate } from '../lib/channels';
import type { MentionFinder } from '../lib/md';
import { Avatar } from './org-ui';

/** Per workspace, fetched once per page load (refreshed when a box mounts). */
const cache = new Map<string, Promise<OrgMentionable[]>>();

export function loadMentionables(wsId: string, fresh = false): Promise<OrgMentionable[]> {
  if (fresh || !cache.has(wsId)) cache.set(wsId, Promise.resolve().then(() => api.orgMentionables(wsId)).then((l) => (Array.isArray(l) ? l : [])).catch(() => []));
  return cache.get(wsId)!;
}

/** Who may be tagged on this workspace's company tasks ([] before it loads). */
export function useMentionables(wsId: string | null | undefined, fresh = false): MentionCandidate[] {
  const [list, setList] = useState<MentionCandidate[]>([]);
  useEffect(() => {
    if (!wsId) return;
    let live = true;
    void loadMentionables(wsId, fresh).then((l) => { if (live) setList(l.map((m) => ({ kind: m.kind, id: m.id, name: m.name }))); });
    return () => { live = false; };
  }, [wsId, fresh]);
  return list;
}

/** The chip finder for a stored comment: only what the server resolved. */
export function storedMentions(mentionsJson: string | undefined, members: MentionCandidate[]): MentionFinder {
  return (s) => messageMentionSpans(s, mentionsJson ?? '[]', members).map((x) => ({ start: x.start, end: x.end, kind: x.member.kind }));
}

const chip: CSSProperties = { display: 'inline', background: 'var(--accent-dim)', color: 'var(--accent-hi)', borderRadius: 4, padding: '0 3px', fontWeight: 600 };

/** Plain text (a snippet: Inbox, Home, follows) with the `@names` that
 *  name a member or a person drawn as chips. */
export function MentionText({ text, members }: { text: string; members: MentionCandidate[] }) {
  if (!text.includes('@') || members.length === 0) return <>{text}</>;
  const out: ReactNode[] = [];
  let last = 0;
  mentionSpans(text, members).forEach((s, i) => {
    if (s.members.length === 0 || s.start < last) return;
    if (s.start > last) out.push(text.slice(last, s.start));
    out.push(<span key={i} data-mention={s.members[0].kind} style={chip}>{text.slice(s.start, s.end)}</span>);
    last = s.end;
  });
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

/** A small face for a candidate: the agent's avatar, a person's initials. */
export function MentionFace({ c, size = 20 }: { c: MentionCandidate; size?: number }) {
  const app = useApp();
  if (c.kind === 'agent') return <Avatar a={app.agents.find((a) => a.id === c.id)} size={size} />;
  return <span title={c.name} style={{ width: size, height: size, borderRadius: Math.round(size * 0.3), flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--accent-dim)', color: 'var(--text)', fontWeight: 700, fontSize: size * 0.42 }}>{initials(c.name)}</span>;
}

/**
 * A one-line comment input with @ autocomplete: typing `@` lists the
 * members and people (avatars, kind), ↑/↓ moves, Enter or Tab picks, Esc
 * closes; Enter with no list open submits.
 */
export function MentionBox({ value, onChange, onSubmit, members, placeholder, ariaLabel, style, disabled }: {
  value: string; onChange: (v: string) => void; onSubmit: () => void; members: MentionCandidate[];
  placeholder?: string; ariaLabel?: string; style?: CSSProperties; disabled?: boolean;
}) {
  const [menu, setMenu] = useState<{ start: number; filter: string } | null>(null);
  const [sel, setSel] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  const suggestions = menu ? mentionSuggestions(menu.filter, members) : [];
  const pick = (c: MentionCandidate) => {
    const el = ref.current;
    // Replace exactly the `@query` being typed (its start plus what was typed).
    const start = menu?.start ?? value.length;
    const caret = menu ? Math.min(value.length, start + 1 + menu.filter.length) : value.length;
    const next = applyMention(value, start, caret, c.name);
    onChange(next.text);
    setMenu(null);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(next.caret, next.caret); });
  };
  return (
    <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      {menu && suggestions.length > 0 && (
        <div role="listbox" aria-label="Mention" data-testid="mention-menu" style={{ position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, width: 300, maxWidth: '100%', background: 'var(--elev, var(--panel))', border: '1px solid var(--border)', borderRadius: 10, boxShadow: 'var(--shadow)', zIndex: 40, padding: 4, maxHeight: 240, overflowY: 'auto' }}>
          {suggestions.map((c, i) => (
            <div key={`${c.kind}:${c.id}`} role="option" aria-selected={i === sel} onMouseDown={(e) => { e.preventDefault(); pick(c); }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 7, cursor: 'pointer', background: i === sel ? 'var(--accent-dim)' : 'none' }}>
              <MentionFace c={c} />
              <span style={{ flex: 1, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
              <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{c.kind === 'agent' ? 'member' : 'person'}</span>
            </div>
          ))}
        </div>
      )}
      <input ref={ref} value={value} disabled={disabled} aria-label={ariaLabel} placeholder={placeholder} style={{ ...style, width: '100%', boxSizing: 'border-box' }}
        onChange={(e) => { onChange(e.target.value); setMenu(mentionQuery(e.target.value, e.target.selectionStart ?? e.target.value.length)); setSel(0); }}
        onBlur={() => setMenu(null)}
        onKeyDown={(e) => {
          if (menu && suggestions.length > 0) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => (s + 1) % suggestions.length); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => (s - 1 + suggestions.length) % suggestions.length); return; }
            if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); pick(suggestions[Math.min(sel, suggestions.length - 1)]); return; }
            if (e.key === 'Escape') { e.preventDefault(); setMenu(null); return; }
          }
          if (e.key === 'Enter' && !e.nativeEvent.isComposing && value.trim()) { e.preventDefault(); onSubmit(); }
        }} />
    </div>
  );
}
