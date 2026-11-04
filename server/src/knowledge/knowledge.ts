/**
 * The knowledge base (docs/knowledge-base.md): curated, read-only reference
 * each agent pack ships with, embedded at build time from knowledge/ by
 * scripts/build-knowledge.mjs. Pure functions over the bundle — scoping (an
 * agent sees its own role's docs plus the shared topics its README names),
 * keyword search (BM25F over title, tags, summary and body), paged reads,
 * the system-prompt pointer and the installed library files — so the
 * service, the tools and the tests agree.
 */
import { AUTHORED_PACKS } from '../market/authored-packs.generated';
import { KNOWLEDGE } from './knowledge.generated';
import type { KbDoc, KbPack, KbTopic, KnowledgeBundle } from './knowledge.types';

export type { KbDoc, KbPack, KbTopic, KnowledgeBundle } from './knowledge.types';

/** The workspace folder the library is installed under (docs/filesystem.md). */
export const LIBRARY_DIR = 'library';
export const SHARED_DIR = '_shared';
/** kb_read returns a doc in pages of about this many characters. */
export const KB_PAGE_CHARS = 6_000;
/** kb_search returns at most this many hits. */
export const KB_SEARCH_MAX = 8;
/** The system-prompt pointer stays within this many characters. */
export const KB_POINTER_CAP = 700;

/** The caps the build enforces (scripts/build-knowledge.mjs CAPS). */
export const KB_CAPS = { docChars: 16_000, readmeChars: 8_000, packChars: 90_000, docsPerPack: 8, docsPerTopic: 5 } as const;

/** What an agent may search and read: its pack's KB (null when the pack
 *  has none, or the agent has no pack) and the shared topics it sees. */
export interface KbScope {
  pack: KbPack | null;
  topics: KbTopic[];
}

const PACK_META = new Map(AUTHORED_PACKS.map((p) => [p.id, { name: p.name, segment: p.segment === 'business' ? 'business' : 'personal' }]));

/** A pack's knowledge base by pack id (null: none yet). */
export function kbPackById(packId: string | null | undefined, bundle: KnowledgeBundle = KNOWLEDGE): KbPack | null {
  if (!packId) return null;
  return Object.values(bundle.packs).find((p) => p.packId === packId) ?? null;
}

/**
 * The scope of an agent:
 *  - a pack with a knowledge base: its docs, plus the shared topics its README lists;
 *  - a business pack with none yet, or an agent created outside packs that
 *    works in a company: every shared topic (they are company know-how);
 *  - anything else (a personal pack without a KB, a personal custom agent): nothing.
 */
export function scopeFor(packId: string | null | undefined, opts: { company: boolean }, bundle: KnowledgeBundle = KNOWLEDGE): KbScope {
  const pack = kbPackById(packId, bundle);
  if (pack) return { pack, topics: pack.shared.map((t) => bundle.shared[t]).filter((t): t is KbTopic => Boolean(t)) };
  const business = packId ? PACK_META.get(packId)?.segment === 'business' : false;
  if (business || (!packId && opts.company) || (packId && !PACK_META.has(packId) && opts.company)) {
    return { pack: null, topics: Object.values(bundle.shared) };
  }
  return { pack: null, topics: [] };
}

export function scopeDocs(scope: KbScope): KbDoc[] {
  return [...(scope.pack?.docs ?? []), ...scope.topics.flatMap((t) => t.docs)];
}

export function scopeIsEmpty(scope: KbScope): boolean {
  return !scope.pack && scope.topics.length === 0;
}

/** A content signature of the scope (what is installed for it). */
export function scopeVersion(scope: KbScope): string {
  return [scope.pack ? `${scope.pack.folder}@${scope.pack.version}` : '', ...scope.topics.map((t) => `${SHARED_DIR}/${t.topic}@${t.version}`)].filter(Boolean).join(',');
}

// ---- paths ----

/** `biz-finance-manager/budget-memo.md` → `library/biz-finance-manager/budget-memo.md`. */
export function libraryPath(docPath: string): string {
  return `${LIBRARY_DIR}/${docPath}`;
}

/** The forms an agent may write a doc path in, reduced to the
 *  knowledge-relative path: `/library/x/y.md`, `library/x/y.md`, `x/y`,
 *  `(KB: x/y.md)`. */
export function normalizeKbPath(input: string): string {
  let p = String(input ?? '').trim().replace(/^\(?\s*KB:\s*/i, '').replace(/\)\s*$/, '').trim();
  p = p.replace(/^\/+/, '');
  if (p.startsWith(`${LIBRARY_DIR}/`)) p = p.slice(LIBRARY_DIR.length + 1);
  p = p.replace(/#.*$/, '').replace(/\/+$/, '');
  if (p && !p.endsWith('.md')) p = `${p}.md`;
  return p;
}

// ---- search (BM25F over weighted fields) ----

const STOP = new Set('a an and are as at be but by can do for from has have how i if in into is it its of on or our so that the their them then there these this to was we what when where which who why will with you your'.split(' '));

/** Lowercase word tokens, stop words out, a light plural fold. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of String(text).toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (STOP.has(raw)) continue;
    let t = raw;
    if (t.length > 4 && t.endsWith('ies')) t = `${t.slice(0, -3)}y`;
    else if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us')) t = t.slice(0, -1);
    out.push(t);
  }
  return out;
}

const FIELDS = ['title', 'tags', 'summary', 'body'] as const;
type Field = typeof FIELDS[number];
/** BM25F: per-field weights, length normalisation on the body only (a long
 *  doc is not punished for a title match). */
const FIELD_WEIGHTS: Record<Field, number> = { title: 3, tags: 2.5, summary: 2, body: 1 };
const FIELD_B: Record<Field, number> = { title: 0, tags: 0, summary: 0, body: 0.75 };
interface Indexed { tf: Record<Field, Map<string, number>>; len: Record<Field, number> }
const indexCache = new Map<string, Indexed>();

function indexed(doc: KbDoc): Indexed {
  const key = `${doc.path}\u0000${doc.body.length}\u0000${doc.title}`;
  const hit = indexCache.get(key);
  if (hit) return hit;
  const text: Record<Field, string> = { title: doc.title, tags: doc.tags.join(' '), summary: doc.summary, body: doc.body };
  const out = { tf: {} as Indexed['tf'], len: {} as Indexed['len'] };
  for (const f of FIELDS) {
    const m = new Map<string, number>();
    const toks = tokenize(text[f]);
    for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1);
    out.tf[f] = m;
    out.len[f] = toks.length;
  }
  indexCache.set(key, out);
  return out;
}

export interface KbHit { doc: KbDoc; score: number; snippet: string }

/** Rank the scope's docs for `query` (BM25F, k1 = 1.2). */
export function searchKb(docs: KbDoc[], query: string, limit = KB_SEARCH_MAX): KbHit[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0 || docs.length === 0) return [];
  const idx = docs.map(indexed);
  const avg = Object.fromEntries(FIELDS.map((f) => [f, idx.reduce((n, d) => n + d.len[f], 0) / idx.length || 1])) as Record<Field, number>;
  const N = docs.length;
  const k1 = 1.2;
  const hits: KbHit[] = [];
  const df = new Map(terms.map((t) => [t, idx.filter((d) => FIELDS.some((f) => d.tf[f].has(t))).length]));
  docs.forEach((doc, i) => {
    let score = 0;
    for (const t of terms) {
      let tf = 0;
      for (const f of FIELDS) {
        const n = idx[i].tf[f].get(t) ?? 0;
        if (n) tf += (FIELD_WEIGHTS[f] * n) / (1 - FIELD_B[f] + (FIELD_B[f] * idx[i].len[f]) / avg[f]);
      }
      if (!tf) continue;
      const n = df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1));
    }
    if (score > 0) hits.push({ doc, score, snippet: snippetOf(doc, terms) });
  });
  return hits.sort((a, b) => b.score - a.score || (a.doc.path < b.doc.path ? -1 : 1)).slice(0, limit);
}

/** The body line that holds the most query terms (else the summary). */
function snippetOf(doc: KbDoc, terms: string[]): string {
  let best = '';
  let bestN = 0;
  for (const line of doc.body.split('\n')) {
    const l = line.trim();
    if (!l || l.startsWith('```') || l.startsWith('#')) continue;
    const toks = new Set(tokenize(l));
    const n = terms.filter((t) => toks.has(t)).length;
    if (n > bestN) { best = l; bestN = n; }
  }
  const s = (best || doc.summary).replace(/\s+/g, ' ');
  return s.length > 200 ? `${s.slice(0, 197)}…` : s;
}

/** kb_search's text. */
export function renderHits(hits: KbHit[], query: string): string {
  if (hits.length === 0) return `No knowledge-base doc matches "${query}". Try other words, or kb_list to see every doc.`;
  return hits.map((h, i) => `${i + 1}. ${h.doc.path} — ${h.doc.title}\n   ${h.doc.summary}\n   …${h.snippet}`).join('\n');
}

// ---- reads ----

export interface KbPage { doc: KbDoc; page: number; pages: number; text: string }

/** Split a body into pages of about KB_PAGE_CHARS, on line boundaries. */
export function pagesOf(body: string, size = KB_PAGE_CHARS): string[] {
  if (body.length <= size) return [body];
  const pages: string[] = [];
  let cur = '';
  for (const line of body.split('\n')) {
    const next = cur ? `${cur}\n${line}` : line;
    if (next.length > size && cur) { pages.push(cur); cur = line; } else cur = next;
    while (cur.length > size) { pages.push(cur.slice(0, size)); cur = cur.slice(size); }
  }
  if (cur) pages.push(cur);
  return pages;
}

/** Find a doc of the scope by any path form, or by a bare slug that is unique in it. */
export function findDoc(docs: KbDoc[], input: string): KbDoc | null {
  const p = normalizeKbPath(input);
  if (!p) return null;
  const exact = docs.find((d) => d.path === p);
  if (exact) return exact;
  if (!p.includes('/')) {
    const bySlug = docs.filter((d) => d.path.endsWith(`/${p}`));
    if (bySlug.length === 1) return bySlug[0];
  }
  return null;
}

export function readPage(doc: KbDoc, page = 1, size = KB_PAGE_CHARS): KbPage {
  const all = pagesOf(doc.body, size);
  const n = Math.min(Math.max(1, Math.floor(page) || 1), all.length);
  return { doc, page: n, pages: all.length, text: all[n - 1] };
}

/** kb_read's text: a header, the page, the sources on the last page. */
export function renderPage(p: KbPage): string {
  const header = `[${p.doc.path} · ${p.doc.title} · page ${p.page} of ${p.pages} · updated ${p.doc.updated} · cite as (KB: ${p.doc.path})]`;
  const more = p.page < p.pages ? `\n…(continued: kb_read with page ${p.page + 1})` : '';
  const sources = p.page === p.pages && p.doc.sources?.length
    ? `\n\nSources:\n${p.doc.sources.map((s) => `- ${s.title}${s.date ? ` (${s.date})` : ''}: ${s.url}`).join('\n')}`
    : '';
  return `${header}\n${p.text}${more}${sources}`;
}

/** kb_list's text. */
export function renderList(scope: KbScope): string {
  const lines: string[] = [];
  if (scope.pack) {
    lines.push(`${scope.pack.packName} — ${scope.pack.summary}`);
    for (const d of scope.pack.docs) lines.push(`- ${d.path} — ${d.title}: ${d.summary}`);
  }
  for (const t of scope.topics) {
    lines.push(`Shared: ${t.topic}`);
    for (const d of t.docs) lines.push(`- ${d.path} — ${d.title}: ${d.summary}`);
  }
  return lines.length ? lines.join('\n') : 'You have no knowledge base.';
}

// ---- the prompt pointer ----

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * One short section of the system prompt: what the KB holds and when to use
 * it, within KB_POINTER_CAP. Null for an empty scope.
 */
export function promptPointer(scope: KbScope): string | null {
  if (scopeIsEmpty(scope)) return null;
  const how = 'Before you plan a deliverable in your field, when you\'re unsure of a method, or when a checklist may apply, kb_search it and kb_read the doc; say which doc you used as (KB: <path>). It\'s shipped reference, not your memory: what you learn yourself still goes in LESSONS.md and your knowledge/ notes.';
  const topics = scope.topics.map((t) => t.topic.replace(/-/g, ' '));
  let lead: string;
  let titles: string[];
  if (scope.pack) {
    lead = `Your role's knowledge base (curated, read-only, at /${LIBRARY_DIR}/${scope.pack.folder}/): ${clip(scope.pack.summary, 160)}`;
    titles = scope.pack.docs.filter((d) => !d.path.endsWith('/README.md')).map((d) => d.title);
  } else {
    lead = `A shared knowledge base of company know-how (curated, read-only, at /${LIBRARY_DIR}/${SHARED_DIR}/)`;
    titles = [];
  }
  const build = (n: number, m: number) => {
    const docs = titles.length ? ` Docs: ${titles.slice(0, n).join('; ')}${titles.length > n ? `; +${titles.length - n} more` : ''}.` : '';
    const shared = topics.length ? ` ${scope.pack ? 'Also shared topics' : 'Topics'}: ${topics.slice(0, m).join(', ')}${topics.length > m ? `, +${topics.length - m} more` : ''}.` : '';
    return `# Knowledge base\n${lead.replace(/\.$/, '')}.${docs}${shared} ${how}`;
  };
  let n = titles.length;
  let m = topics.length;
  let text = build(n, m);
  while (text.length > KB_POINTER_CAP && (n > 2 || m > 3)) {
    if (m > 3) m--; else n--;
    text = build(n, m);
  }
  return text.length > KB_POINTER_CAP ? `${text.slice(0, KB_POINTER_CAP - 1)}…` : text;
}

// ---- the installed library (docs/knowledge-base.md "Install") ----

/** The installed text of a doc: a read-only note, the body, its sources. */
export function renderLibraryFile(doc: KbDoc, owner: string): string {
  const note = `> Read-only reference from the ${owner} knowledge base (updated ${doc.updated}). Agents search it with kb_search; edits are refused and it is refreshed when the knowledge base changes.`;
  const hasSources = /^##\s+Sources\b/im.test(doc.body);
  const sources = doc.sources?.length && !hasSources
    ? `\n\n## Sources\n\n${doc.sources.map((s) => `- [${s.title}](${s.url})${s.publisher ? `, ${s.publisher}` : ''}${s.date ? ` (${s.date})` : ''}${s.accessed ? `, accessed ${s.accessed}` : ''}`).join('\n')}`
    : '';
  return `${note}\n\n${doc.body.trim()}${sources}\n`;
}

/** The files of a scope's library: workspace path → text. */
export function libraryFiles(scope: KbScope): Map<string, string> {
  const out = new Map<string, string>();
  if (scope.pack) for (const d of scope.pack.docs) out.set(libraryPath(d.path), renderLibraryFile(d, scope.pack.packName));
  for (const t of scope.topics) for (const d of t.docs) out.set(libraryPath(d.path), renderLibraryFile(d, `shared "${t.topic}"`));
  return out;
}

/** `/library/README.md`: what is installed, generated. */
export function libraryIndex(packs: KbPack[], topics: KbTopic[]): string {
  const lines = [
    '# Library',
    '',
    'Curated, read-only reference that ships with the agents\' packs (docs/knowledge-base.md). Each role\'s agents search their own folder and the shared topics it names with kb_search and kb_read. Agents and people can read these files; nobody edits them here. Edits are refused and the files are refreshed when a pack\'s knowledge base changes. An agent\'s own notes live in its home\'s knowledge/ folder.',
    '',
  ];
  if (packs.length) {
    lines.push('## Roles', '');
    for (const p of [...packs].sort((a, b) => a.packName.localeCompare(b.packName))) lines.push(`- [${p.packName}](./${p.folder}/README.md): ${p.summary} (${p.docs.length} docs)`);
    lines.push('');
  }
  if (topics.length) {
    lines.push('## Shared topics', '');
    for (const t of [...topics].sort((a, b) => a.topic.localeCompare(b.topic))) lines.push(`- ${t.topic}: ${t.docs.map((d) => `[${d.title}](./${d.path})`).join(', ')}`);
    lines.push('');
  }
  lines.push('_Generated: edits here are overwritten._', '');
  return lines.join('\n');
}

/** For the market card and the agent page: a pack's KB in brief. */
export interface KbSummary {
  folder: string;
  docs: number;
  titles: string[];
  shared: string[];
  version: string;
}

export function kbSummary(packId: string, bundle: KnowledgeBundle = KNOWLEDGE): KbSummary | null {
  const p = kbPackById(packId, bundle);
  if (!p) return null;
  const docs = p.docs.filter((d) => !d.path.endsWith('/README.md'));
  return { folder: p.folder, docs: docs.length, titles: docs.map((d) => d.title), shared: p.shared, version: p.version };
}

export function packNameOf(packId: string): string | null {
  return PACK_META.get(packId)?.name ?? null;
}
