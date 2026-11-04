/**
 * Builds server/src/knowledge/knowledge.generated.ts from knowledge/ — the
 * curated, read-only knowledge base each agent pack ships with
 * (docs/knowledge-base.md).
 *
 *   node scripts/build-knowledge.mjs          validate and write the module
 *   node scripts/build-knowledge.mjs --check  validate only (writes nothing)
 *
 * Source layout:
 *   knowledge/<pack-file-basename>/README.md     the overview (required)
 *   knowledge/<pack-file-basename>/<slug>.md     the docs (1–8; aim for 3–6)
 *   knowledge/_shared/<topic>/<slug>.md          cross-role topics (1–5 docs each)
 *
 * Every file starts with JSON front matter:
 *   ---json
 *   { "title": "…", "summary": "one sentence", "tags": ["…"], "updated": "2026-11-04",
 *     "sources": [{ "title": "…", "url": "https://…" }],     (optional)
 *     "shared": ["_shared/okrs"] }                          (optional, README.md only)
 *   ---
 *   <markdown body>
 *
 * The validation is strict (a broken file fails the build): the front matter
 * shape, the size caps, every pack folder naming a real packs/<folder>.md,
 * every `shared` ref naming a topic folder, every relative link resolving
 * inside knowledge/. A pack with no folder is fine (it gets a warning):
 * knowledge is added pack by pack.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
// KNOWLEDGE_SRC / PACKS_SRC / KNOWLEDGE_OUT redirect the build (tests build a scratch copy).
const SRC = process.env.KNOWLEDGE_SRC || join(ROOT, 'knowledge');
const PACKS = process.env.PACKS_SRC || join(ROOT, 'packs');
const OUT = process.env.KNOWLEDGE_OUT || join(ROOT, 'server/src/knowledge/knowledge.generated.ts');
const CHECK = process.argv.includes('--check');

/** The caps (docs/knowledge-base.md "Caps"). Mirrored in server/src/knowledge/knowledge.ts. */
const CAPS = {
  docChars: 16_000,
  readmeChars: 8_000,
  packChars: 90_000,
  docsPerPack: 8,
  docsPerTopic: 5,
  minDocChars: 200,
  minReadmeChars: 80,
  tags: 12,
  sources: 20,
};
const SHARED = '_shared';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FRONT_KEYS = new Set(['title', 'summary', 'tags', 'updated', 'sources', 'shared']);
const SOURCE_KEYS = new Set(['title', 'url', 'date', 'accessed', 'publisher', 'author', 'note']);

const errors = [];
const warnings = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);

/** Pack folder name → { id, name } from packs/<folder>.md. */
function readPacks() {
  const out = new Map();
  for (const f of readdirSync(PACKS).filter((x) => x.endsWith('.md')).sort()) {
    const raw = readFileSync(join(PACKS, f), 'utf8');
    const fm = /^---json\n([\s\S]*?)\n---\n/.exec(raw);
    if (!fm) continue;
    const meta = JSON.parse(fm[1]);
    out.set(f.slice(0, -3), { id: meta.id, name: meta.name, segment: meta.segment ?? 'personal', level: meta.level ?? null });
  }
  return out;
}

/** Parse one file: its front matter (validated) and its body. */
function parseDoc(rel, opts) {
  const raw = readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
  const m = /^---json\n([\s\S]*?)\n---\n/.exec(raw);
  if (!m) { fail(rel, 'missing ---json front matter (the file must start with ---json, the JSON, then ---)'); return null; }
  let meta;
  try { meta = JSON.parse(m[1]); } catch (err) { fail(rel, `front matter is not valid JSON: ${err.message}`); return null; }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) { fail(rel, 'front matter must be a JSON object'); return null; }
  for (const k of Object.keys(meta)) if (!FRONT_KEYS.has(k)) fail(rel, `unknown front matter key "${k}" (allowed: ${[...FRONT_KEYS].join(', ')})`);
  const str = (k, min, max) => {
    const v = meta[k];
    if (typeof v !== 'string' || v.trim().length < min || v.trim().length > max) { fail(rel, `"${k}" must be a string of ${min}–${max} characters`); return ''; }
    return v.trim();
  };
  const title = str('title', 3, 120);
  const summary = str('summary', 10, 300);
  let tags = [];
  if (!Array.isArray(meta.tags) || meta.tags.length < 1 || meta.tags.length > CAPS.tags || !meta.tags.every((t) => typeof t === 'string' && t.trim().length > 0 && t.trim().length <= 40)) {
    fail(rel, `"tags" must be an array of 1–${CAPS.tags} non-empty strings (≤ 40 chars each)`);
  } else tags = [...new Set(meta.tags.map((t) => t.trim().toLowerCase()))];
  let updated = '';
  if (typeof meta.updated !== 'string' || !DATE_RE.test(meta.updated) || Number.isNaN(Date.parse(meta.updated))) fail(rel, '"updated" must be a date written YYYY-MM-DD');
  else updated = meta.updated;
  let sources;
  if (meta.sources !== undefined) {
    if (!Array.isArray(meta.sources) || meta.sources.length > CAPS.sources) fail(rel, `"sources" must be an array of at most ${CAPS.sources} entries`);
    else {
      sources = [];
      meta.sources.forEach((s, i) => {
        if (!s || typeof s !== 'object' || Array.isArray(s)) { fail(rel, `sources[${i}] must be an object { title, url }`); return; }
        for (const k of Object.keys(s)) if (!SOURCE_KEYS.has(k)) fail(rel, `sources[${i}]: unknown key "${k}"`);
        if (typeof s.title !== 'string' || !s.title.trim()) fail(rel, `sources[${i}].title must be a non-empty string`);
        if (typeof s.url !== 'string' || !/^https?:\/\/[^\s]+$/.test(s.url)) fail(rel, `sources[${i}].url must be an http(s) URL`);
        for (const k of ['date', 'accessed', 'publisher', 'author', 'note']) if (s[k] !== undefined && typeof s[k] !== 'string') fail(rel, `sources[${i}].${k} must be a string`);
        const out = { title: String(s.title ?? '').trim(), url: String(s.url ?? '') };
        for (const k of ['date', 'accessed', 'publisher', 'author', 'note']) if (typeof s[k] === 'string' && s[k].trim()) out[k] = s[k].trim();
        sources.push(out);
      });
    }
  }
  let shared;
  if (meta.shared !== undefined) {
    if (!opts.readme) fail(rel, '"shared" belongs in a pack\'s README.md only');
    else if (!Array.isArray(meta.shared) || !meta.shared.every((x) => typeof x === 'string')) fail(rel, '"shared" must be an array of "_shared/<topic>" strings');
    else shared = [...new Set(meta.shared.map((x) => x.trim().replace(/\/+$/, '')))];
  }
  const body = raw.slice(m[0].length).trim();
  const cap = opts.readme ? CAPS.readmeChars : CAPS.docChars;
  const min = opts.readme ? CAPS.minReadmeChars : CAPS.minDocChars;
  if (body.length > cap) fail(rel, `body is ${body.length} characters; the cap is ${cap}`);
  if (body.length < min) fail(rel, `body is ${body.length} characters; at least ${min} expected`);
  const words = body.split(/\s+/).filter(Boolean).length;
  if (!opts.readme && words > 1_400) warnings.push(`${rel}: ${words} words (aim for 300–900)`);
  return { path: rel, title, summary, tags, updated, ...(sources && sources.length ? { sources } : {}), ...(shared ? { shared } : {}), body, words };
}

const isDir = (p) => existsSync(p) && statSync(p).isDirectory();

/** The .md files of a folder, README.md first, refusing anything else. */
function docFiles(dirRel, where) {
  const names = readdirSync(join(SRC, dirRel)).filter((n) => !n.startsWith('.')).sort();
  const files = [];
  for (const n of names) {
    if (isDir(join(SRC, dirRel, n))) { fail(`${where}/${n}`, 'sub-folders are not allowed inside a knowledge folder'); continue; }
    if (!n.endsWith('.md')) { fail(`${where}/${n}`, 'only .md files belong in a knowledge folder'); continue; }
    const slug = n.slice(0, -3);
    if (n !== 'README.md' && !SLUG_RE.test(slug)) { fail(`${where}/${n}`, 'a doc file name is a lowercase slug (a-z, 0-9, dashes) ending in .md'); continue; }
    files.push(n);
  }
  return files.sort((a, b) => (a === 'README.md' ? -1 : b === 'README.md' ? 1 : a < b ? -1 : 1));
}

const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const canon = (docs) => docs.map((d) => JSON.stringify([d.path, d.title, d.summary, d.tags, d.updated, d.sources ?? [], d.shared ?? [], d.body])).join('\n');

function build() {
  const packs = readPacks();
  const out = { packs: {}, shared: {} };
  if (!isDir(SRC)) {
    warnings.push(`no knowledge/ folder at ${SRC}: every pack is without a knowledge base`);
    return { out, packs };
  }
  const top = readdirSync(SRC).filter((n) => !n.startsWith('.')).sort();
  // Shared topics first: pack READMEs reference them.
  if (top.includes(SHARED)) {
    if (!isDir(join(SRC, SHARED))) fail(SHARED, 'must be a folder of topic folders');
    else for (const topic of readdirSync(join(SRC, SHARED)).filter((n) => !n.startsWith('.')).sort()) {
      const where = `${SHARED}/${topic}`;
      if (!isDir(join(SRC, where))) { fail(where, '_shared/ holds topic folders only'); continue; }
      if (!SLUG_RE.test(topic)) { fail(where, 'a topic folder name is a lowercase slug'); continue; }
      const docs = docFiles(where, where).map((n) => parseDoc(`${where}/${n}`, { readme: n === 'README.md' })).filter(Boolean);
      if (docs.length === 0) { fail(where, 'an empty topic folder; add a doc or remove it'); continue; }
      if (docs.filter((d) => !d.path.endsWith('/README.md')).length > CAPS.docsPerTopic) fail(where, `at most ${CAPS.docsPerTopic} docs per shared topic`);
      out.shared[topic] = { topic, version: hash(canon(docs)), docs };
    }
  }
  for (const folder of top) {
    if (folder === SHARED) continue;
    const where = folder;
    if (!isDir(join(SRC, folder))) { if (folder !== 'README.md') fail(where, 'only pack folders (and _shared/) belong at the top of knowledge/'); continue; }
    const pack = packs.get(folder);
    if (!pack) { fail(where, `no pack file packs/${folder}.md — a knowledge folder is named after its pack file`); continue; }
    const files = docFiles(folder, where);
    if (!files.includes('README.md')) fail(where, 'missing README.md (the overview: what this knowledge base covers, when to use which doc)');
    const docs = files.map((n) => parseDoc(`${folder}/${n}`, { readme: n === 'README.md' })).filter(Boolean);
    const nDocs = docs.filter((d) => !d.path.endsWith('/README.md')).length;
    if (nDocs === 0) fail(where, 'no docs besides the README');
    if (nDocs > CAPS.docsPerPack) fail(where, `${nDocs} docs; at most ${CAPS.docsPerPack} per pack`);
    const total = docs.reduce((n, d) => n + d.body.length, 0);
    if (total > CAPS.packChars) fail(where, `${total} characters in all; the cap per pack is ${CAPS.packChars}`);
    const readme = docs.find((d) => d.path.endsWith('/README.md'));
    const shared = readme?.shared ?? [];
    for (const ref of shared) {
      const topic = ref.startsWith(`${SHARED}/`) ? ref.slice(SHARED.length + 1) : null;
      if (!topic || topic.includes('/') || !out.shared[topic]) fail(`${folder}/README.md`, `shared ref "${ref}" is not a topic folder under knowledge/_shared/`);
    }
    out.packs[folder] = {
      folder, packId: pack.id, packName: pack.name,
      title: readme?.title ?? pack.name, summary: readme?.summary ?? '',
      shared: shared.map((r) => r.slice(SHARED.length + 1)),
      version: '', docs,
    };
  }
  // Links: every relative link resolves inside knowledge/ (doc-relative, or
  // knowledge-root-relative like "_shared/okrs/x.md"); stored doc-relative.
  const all = new Map();
  for (const t of Object.values(out.shared)) for (const d of t.docs) all.set(d.path, d);
  for (const p of Object.values(out.packs)) for (const d of p.docs) all.set(d.path, d);
  const folders = new Set([...all.keys()].map((k) => posix.dirname(k)));
  for (const d of all.values()) d.body = fixLinks(d, all, folders);
  for (const p of Object.values(out.packs)) p.version = hash(canon(p.docs) + p.shared.map((t) => out.shared[t]?.version ?? '').join(','));
  for (const t of Object.values(out.shared)) t.version = hash(canon(t.docs));
  return { out, packs };
}

/** Check and normalise a doc's relative links. */
function fixLinks(doc, all, folders) {
  const dir = posix.dirname(doc.path);
  return doc.body.replace(/(!?)\[([^\]\n]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (whole, bang, text, target, title) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) return whole;
    const [pathPart, anchor] = target.split('#');
    let candidate = pathPart.startsWith('/library/') ? pathPart.slice('/library/'.length) : null;
    if (candidate === null && pathPart.startsWith('/')) { fail(doc.path, `link "${target}" is absolute; link to knowledge docs relatively (e.g. ../_shared/okrs/writing-key-results.md)`); return whole; }
    const exists = (p) => all.has(p) || folders.has(p.replace(/\/+$/, ''));
    if (candidate === null) {
      const rel = posix.normalize(posix.join(dir, pathPart));
      const fromRoot = posix.normalize(pathPart);
      candidate = exists(rel) ? rel : exists(fromRoot) ? fromRoot : null;
    }
    if (!candidate || candidate.startsWith('..') || !exists(candidate)) { fail(doc.path, `broken link "${target}" — no such knowledge doc`); return whole; }
    const isFolder = !all.has(candidate);
    let relative = posix.relative(dir, candidate.replace(/\/+$/, '')) || '.';
    if (isFolder) relative += '/';
    if (!relative.startsWith('.')) relative = `./${relative}`;
    return `${bang}[${text}](${relative}${anchor !== undefined ? `#${anchor}` : ''}${title ?? ''})`;
  });
}

const { out, packs } = build();
const without = [...packs.keys()].filter((f) => !out.packs[f]);
if (without.length) warnings.push(`${without.length} of ${packs.size} packs have no knowledge folder yet: ${without.slice(0, 8).join(', ')}${without.length > 8 ? ', …' : ''}`);
for (const w of warnings) console.warn(`warning: ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`error: ${e}`);
  console.error(`knowledge build failed: ${errors.length} error(s)`);
  process.exit(1);
}
const nPacks = Object.keys(out.packs).length;
const nShared = Object.keys(out.shared).length;
const nDocs = Object.values(out.packs).reduce((n, p) => n + p.docs.length, 0) + Object.values(out.shared).reduce((n, t) => n + t.docs.length, 0);
if (CHECK) {
  console.log(`knowledge ok: ${nPacks} packs, ${nShared} shared topics, ${nDocs} files`);
  process.exit(0);
}
const header = `/**
 * AUTO-GENERATED by scripts/build-knowledge.mjs from knowledge/ — do not
 * edit by hand. Regenerate with: npm run knowledge:build
 */
import type { KnowledgeBundle } from './knowledge.types';

export const KNOWLEDGE: KnowledgeBundle = `;
writeFileSync(OUT, header + JSON.stringify(out, null, 1) + ';\n');
console.log(`wrote ${OUT}: ${nPacks} packs, ${nShared} shared topics, ${nDocs} files`);
