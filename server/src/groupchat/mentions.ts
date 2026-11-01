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

export interface Mention { kind: 'agent' | 'human'; id: string }

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
