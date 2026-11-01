/**
 * Mention parsing (docs/group-chat.md §2): `@name` tokens resolved against a
 * channel's members. Pure, so the backend tests and the frontend autocomplete
 * agree on the shape. A member's handle is its name lowercased with runs of
 * non-alphanumerics collapsed to `-` (`Research Lead` → `research-lead`); a
 * token also matches a member when it equals the first segment of exactly one
 * member's handle (`@research`), or a human's email local part.
 */
export interface MentionableMember {
  kind: 'agent' | 'human';
  id: string;
  name: string;
  /** Extra handles (an email local part, a short name). */
  aliases?: string[];
}

/** `goal` entries (docs/group-chat.md §3) are `#goal:<id>` references
 *  resolved against the organization's goals; `decision` entries (§8,
 *  docs/company-vision.md §6) are `#decision:<id>` references into the
 *  decision log. Neither notifies anybody. */
export interface Mention { kind: 'agent' | 'human' | 'goal' | 'decision'; id: string }

export function handleOf(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const TOKEN_RE = /(^|[^\w@])@([\w][\w.-]*)/g;

/** Every member the text mentions, in order of first appearance, deduplicated. */
export function parseMentions(text: string, members: MentionableMember[]): Mention[] {
  const out: Mention[] = [];
  const seen = new Set<string>();
  const handles = members.map((m) => ({
    m,
    full: handleOf(m.name),
    first: handleOf(m.name).split('-')[0] ?? '',
    aliases: (m.aliases ?? []).map(handleOf).filter(Boolean),
  }));
  for (const match of text.matchAll(TOKEN_RE)) {
    const raw = match[2].replace(/[.,;:!?]+$/, '');
    if (!raw) continue;
    const token = handleOf(raw);
    if (!token) continue;
    const flat = token.replace(/-/g, '');
    let hit = handles.filter((h) => h.full === token || h.full.replace(/-/g, '') === flat || h.aliases.includes(token));
    if (hit.length === 0) {
      const byFirst = handles.filter((h) => h.first === token);
      if (byFirst.length === 1) hit = byFirst;
    }
    for (const h of hit) {
      const key = `${h.m.kind}:${h.m.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: h.m.kind, id: h.m.id });
    }
  }
  return out;
}

/** The slug a channel name becomes: `Product Launch` → `product-launch`. */
export function slugify(name: string): string {
  return handleOf(name).slice(0, 48);
}

/** `#goal:<id-or-prefix>` references (docs/group-chat.md §3, §7): the raw
 *  ids as written, deduplicated, in order. Resolution against the org's
 *  goals happens in the service. */
export const GOAL_REF_RE = /(^|[^\w#])#goal:([\w-]{4,})/g;

export function parseGoalRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(GOAL_REF_RE)) { const id = m[2].replace(/[.,;:!?]+$/, ''); if (id && !out.includes(id)) out.push(id); }
  return out;
}

/** `#decision:<id-or-prefix>` references (docs/group-chat.md §8): the raw
 *  ids as written, deduplicated, in order; resolved against the decision log
 *  in the service. */
export const DECISION_REF_RE = /(^|[^\w#])#decision:([\w-]{4,})/g;

export function parseDecisionRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(DECISION_REF_RE)) { const id = m[2].replace(/[.,;:!?]+$/, ''); if (id && !out.includes(id)) out.push(id); }
  return out;
}

/** The per-agent, per-channel session name (docs/group-chat.md §2):
 *  `#<slug> · <agent>`. Shared by the channel runtime and meetings (§8) so
 *  every turn an agent takes in a channel lands in one transcript. */
export function channelSessionName(slug: string, agentName: string): string {
  return `#${slug} · ${agentName}`;
}
