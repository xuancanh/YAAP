/**
 * Memory importers (execution-plan item 9.2, docs/agent-memory.md §8): turn
 * what other assistants export into *proposals* for one of our agents.
 *
 * Pure functions: text in, a classified bundle out. Nothing here touches the
 * database — PortabilityService decides where each bucket lands, and every
 * bucket lands behind a human click (quarantined lesson, profile proposal,
 * charter diff). An importer that wrote trusted memory would be the same
 * injection path docs/agent-memory.md §5 closes for apps and channels, with
 * a wider mouth.
 *
 * Formats, and what is actually known about each:
 *  - `claude-memory` — Claude has no file export. Its help article
 *    (support.claude.com/articles/12123587) tells users to copy memory from
 *    Settings → Your Claude → Manage, or ask Claude to "write out your
 *    memories of me verbatim"; the import side expects lines shaped
 *    "[date saved] - memory content". We therefore accept any of: a JSON
 *    array of `{ topic?, text }` (or of strings), a markdown bullet list,
 *    or "[date] - text" lines, and treat each entry as one memory.
 *  - `muse` — Meta Muse's data export: `Soul.md` (who the assistant is),
 *    `Identity.md` (how it behaves), `Memory.md` (what it remembers).
 *  - `hermes` — Hermes Agent's `MEMORY.md` (the agent's own notes) and
 *    `USER.md` (facts about the user).
 *  - `openclaw` — OpenClaw's `MEMORY.md`, `USER.md` and `SOUL.md`.
 *
 * Mapping: SOUL/Soul → a charter addendum shown as a diff; USER / user-facts →
 * profile proposals (the consent flow the profile already has); everything
 * else → quarantined lessons.
 */

export type ImportFormat = 'claude-memory' | 'muse' | 'hermes' | 'openclaw';
export const IMPORT_FORMATS: readonly ImportFormat[] = ['claude-memory', 'muse', 'hermes', 'openclaw'];

/** Either one file's text, or several files keyed by filename. */
export type ImportContent = string | Record<string, string>;

export interface ImportBundle {
  /** Agent-side conclusions → quarantined lessons. */
  lessons: string[];
  /** Facts about the user → profile proposals. */
  profile: string[];
  /** Persona text → charter addendum (applied by the user, as a diff). */
  charter: string;
  /** Files recognized and files ignored, for the summary. */
  files: { used: string[]; ignored: string[] };
}

const ENTRY_CAP = 2_000;
const ENTRIES_MAX = 300;
const CHARTER_CAP = 8_000;

/** Pull discrete entries out of markdown/plain text. Bullets and numbered
 *  items are one entry each; "[date] - text" lines lose the date; runs of
 *  plain lines between blank lines become one entry; headings, rules and
 *  frontmatter are dropped. */
export function extractEntries(text: string): string[] {
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { out.push(para.join(' ')); para = []; } };
  const body = text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^#{1,6}\s/.test(line) || /^(-{3,}|\*{3,}|_{3,})$/.test(line) || /^```/.test(line)) { flush(); continue; }
    const bullet = /^(?:[-*+•]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      out.push(stripDate(bullet[1]));
      continue;
    }
    const dated = /^\[[^\]]{1,40}\]\s*[-–—:]\s*(.+)$/.exec(line);
    if (dated) { flush(); out.push(dated[1]); continue; }
    para.push(line);
  }
  flush();
  return out
    .map((e) => e.replace(/\s+/g, ' ').trim().slice(0, ENTRY_CAP))
    .filter((e) => e.length >= 3)
    .slice(0, ENTRIES_MAX);
}

/** "[2026-03-01] - text" / "2026-03-01 - text" → "text". */
function stripDate(s: string): string {
  return s.replace(/^\[?\d{4}-\d{2}-\d{2}(?:[T ][\d:]+Z?)?\]?\s*[-–—:]\s*/, '').replace(/^\[[^\]]{1,40}\]\s*[-–—:]\s*/, '');
}

/** Facts about the user, by shape: first person, "the user", or the
 *  second person an assistant uses when it talks about its user. */
export function looksLikeUserFact(entry: string): boolean {
  return /\b(the user|user's|users?)\b/i.test(entry)
    || /^(i|i'm|i am|i've|my|me|we|our)\b/i.test(entry)
    || /\b(you|your|you're)\b/i.test(entry);
}

/** Claude's memory, in any of the shapes we know users can get it in. */
export function parseClaudeMemory(content: string): string[] {
  const trimmed = content.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const list = Array.isArray(parsed) ? parsed
        : parsed && typeof parsed === 'object'
          ? (Object.values(parsed as Record<string, unknown>).find(Array.isArray) as unknown[] | undefined) ?? []
          : [];
      const entries = list.map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const o = item as Record<string, unknown>;
          const text = [o.text, o.content, o.memory, o.value].find((v) => typeof v === 'string') as string | undefined;
          if (!text) return '';
          const topic = typeof o.topic === 'string' ? o.topic : typeof o.title === 'string' ? o.title : '';
          return topic ? `${topic}: ${text}` : text;
        }
        return '';
      });
      const clean = entries.map((e) => e.replace(/\s+/g, ' ').trim().slice(0, ENTRY_CAP)).filter((e) => e.length >= 3);
      if (clean.length > 0) return clean.slice(0, ENTRIES_MAX);
    } catch { /* not JSON after all: fall through to text */ }
  }
  return extractEntries(content);
}

function files(content: ImportContent, singleAs: string): Record<string, string> {
  if (typeof content === 'string') return { [singleAs]: content };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(content)) if (typeof v === 'string') out[k] = v;
  return out;
}

/** Case-insensitive, extension- and path-tolerant file lookup. */
function pick(map: Record<string, string>, ...names: string[]): { name: string; text: string } | undefined {
  const want = names.map((n) => n.toLowerCase().replace(/\.md$/, ''));
  for (const [k, v] of Object.entries(map)) {
    const base = k.split('/').pop()!.toLowerCase().replace(/\.(md|markdown|txt)$/, '');
    if (want.includes(base)) return { name: k, text: v };
  }
  return undefined;
}

export function importBundle(format: ImportFormat, content: ImportContent): ImportBundle {
  const bundle: ImportBundle = { lessons: [], profile: [], charter: '', files: { used: [], ignored: [] } };
  const split = (entries: string[]) => {
    for (const e of entries) (looksLikeUserFact(e) ? bundle.profile : bundle.lessons).push(e);
  };

  if (format === 'claude-memory') {
    const map = files(content, 'claude-memory.txt');
    for (const [name, text] of Object.entries(map)) {
      bundle.files.used.push(name);
      // Claude's memory is memory *about the user*; entries that do not read
      // that way (a workflow it learned, a convention) go to lessons instead.
      split(parseClaudeMemory(text));
    }
    return bundle;
  }

  const map = files(content, format === 'muse' ? 'Memory.md' : 'MEMORY.md');
  const used = new Set<string>();
  const soul = pick(map, 'SOUL', 'Soul');
  if (soul && (format === 'muse' || format === 'openclaw' || format === 'hermes')) {
    used.add(soul.name);
    bundle.charter = soul.text.trim().slice(0, CHARTER_CAP);
  }
  if (format === 'muse') {
    const identity = pick(map, 'Identity');
    if (identity) { used.add(identity.name); bundle.lessons.push(...extractEntries(identity.text)); }
  }
  const memory = pick(map, 'MEMORY', 'Memory');
  if (memory) {
    used.add(memory.name);
    // Hermes/OpenClaw MEMORY.md is the agent's own notebook: lessons, not
    // user facts, unless a line plainly is one. Muse's Memory.md mixes both.
    if (format === 'muse') split(extractEntries(memory.text));
    else bundle.lessons.push(...extractEntries(memory.text));
  }
  const user = pick(map, 'USER', 'User');
  if (user) { used.add(user.name); bundle.profile.push(...extractEntries(user.text)); }

  bundle.files.used = [...used];
  bundle.files.ignored = Object.keys(map).filter((k) => !used.has(k));
  bundle.lessons = dedupe(bundle.lessons).slice(0, ENTRIES_MAX);
  bundle.profile = dedupe(bundle.profile).slice(0, ENTRIES_MAX);
  return bundle;
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  return list.filter((e) => {
    const k = e.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
