/**
 * Mention parsing (docs/group-chat.md §2): `@name` tokens resolved against a
 * channel's members. Pure, so the backend tests and the frontend agree on the
 * shape (src/lib/channels.ts mirrors it for autocomplete and mention chips).
 *
 * At each `@` (not inside a word or an email address, not inside a fenced
 * code block) the longest member **display name** the text continues with
 * wins, case-insensitively and up to a word boundary — so `@Tutor Lead`,
 * `@Chief of staff:` and `**@Unit Test Alpha**` resolve even when another
 * member's name shares the first word, and `@Tutor Lead` beats a member
 * named `Tutor`. Otherwise the single-token forms apply: a member's handle
 * (its name lowercased with runs of non-alphanumerics collapsed to `-`,
 * `Research Lead` → `research-lead`, also written `@ResearchLead`), an alias
 * (a human's email local part), or the first segment of exactly one
 * member's handle (`@research`). Names in any script resolve (`@Đức Anh`,
 * `@小明`, `@🤖 Robo`).
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

/** Letters with no Unicode decomposition that still have an obvious ASCII
 *  spelling (NFKD plus stripping combining marks handles the rest: é → e). */
const FOLD: Record<string, string> = { 'đ': 'd', 'ł': 'l', 'ø': 'o', 'æ': 'ae', 'œ': 'oe', 'ß': 'ss', 'þ': 'th', 'ð': 'd', 'ı': 'i' };

export function handleOf(name: string): string {
  return name.toLowerCase().replace(/[đłøæœßþðı]/g, (ch) => FOLD[ch] ?? ch).normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** A letter, digit or mark in any script: the boundary test around a
 *  mention (`_` is not one, so `_@Name_` emphasis still mentions). */
const WORD_CH = /[\p{L}\p{N}\p{M}]/u;
/** The single-token form after `@`: a word in any script, dots and dashes inside. */
const TOKEN_AT = /^[\p{L}\p{N}_][\p{L}\p{N}\p{M}_.-]*/u;
/** Emphasis or code markers between `@` and the name: `@**Name**`. */
const LEAD_MARKS = /^[*_~`]{1,3}/;

/** One `@mention` in a text: where it sits (the `@` to the end of the name)
 *  and the members it names — none when the token resolves to nobody. */
export interface MentionSpan { start: number; end: number; members: MentionableMember[] }

/** Blank out fenced code blocks (same length, so offsets hold): a mention
 *  inside a code sample is not addressed to anybody. */
function maskFences(text: string): string {
  return text.replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(\n\2[^\n]*(?=\n|$)|$)/g, (block) => block.replace(/[^\n]/g, ' '));
}

/** Every `@mention` in the text, in order, with the members it resolves to. */
export function mentionSpans(text: string, members: MentionableMember[]): MentionSpan[] {
  const masked = maskFences(text);
  const named = members.map((m) => ({
    m,
    names: [m.name, ...(m.aliases ?? [])].map((x) => x.trim().normalize('NFC')).filter(Boolean).map((raw) => ({ len: raw.length, low: raw.toLowerCase() })),
    full: handleOf(m.name),
    first: handleOf(m.name).split('-')[0] ?? '',
    aliases: (m.aliases ?? []).map(handleOf).filter(Boolean),
  }));
  const out: MentionSpan[] = [];
  for (let at = masked.indexOf('@'); at >= 0; at = masked.indexOf('@', at + 1)) {
    const before = at > 0 ? masked[at - 1] : '';
    if (before && (before === '@' || WORD_CH.test(before))) continue; // an email address, not a mention (`_@x_` is emphasis)
    let from = at + 1;
    const marks = LEAD_MARKS.exec(masked.slice(from));
    if (marks) from += marks[0].length;
    // 1. the longest display name (or alias) the text continues with
    let best = 0; let hit: MentionableMember[] = [];
    for (const h of named) {
      for (const n of h.names) {
        if (n.len < best || masked.slice(from, from + n.len).toLowerCase() !== n.low) continue;
        const next = masked[from + n.len];
        if (next && WORD_CH.test(next) && WORD_CH.test(n.low[n.low.length - 1] ?? '')) continue; // `@Al` is not `@Alfred`
        if (n.len > best) { best = n.len; hit = []; }
        if (!hit.includes(h.m)) hit.push(h.m);
      }
    }
    if (hit.length > 0) { out.push({ start: at, end: from + best, members: hit }); continue; }
    // 2. the single-token forms: handle, flattened handle, alias, unique first segment
    const tok = TOKEN_AT.exec(masked.slice(from));
    if (!tok) continue;
    const raw = tok[0].replace(/[.,;:!?-]+$/, '');
    const token = handleOf(raw);
    let found: typeof named = [];
    if (token) {
      const flat = token.replace(/-/g, '');
      found = named.filter((h) => h.full === token || h.full.replace(/-/g, '') === flat || h.aliases.includes(token));
      if (found.length === 0) {
        const byFirst = named.filter((h) => h.first === token);
        if (byFirst.length === 1) found = byFirst;
      }
    }
    out.push({ start: at, end: from + raw.length, members: found.map((h) => h.m) });
  }
  return out;
}

/** Every member the text mentions, in order of first appearance, deduplicated. */
export function parseMentions(text: string, members: MentionableMember[]): Mention[] {
  const out: Mention[] = [];
  const seen = new Set<string>();
  for (const span of mentionSpans(text, members)) {
    for (const m of span.members) {
      const key = `${m.kind}:${m.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: m.kind, id: m.id });
    }
  }
  return out;
}

/** The `@tokens` (as written) that name nobody in the channel, so a poster
 *  can be told its mention woke no one. */
export function unresolvedMentions(text: string, members: MentionableMember[]): string[] {
  const out: string[] = [];
  for (const span of mentionSpans(text, members)) {
    if (span.members.length > 0) continue;
    const tok = text.slice(span.start, span.end);
    if (!out.includes(tok)) out.push(tok);
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
