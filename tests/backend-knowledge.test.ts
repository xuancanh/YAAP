/** The knowledge base (docs/knowledge-base.md): the build's validation, the
 *  committed module, the scope per agent (its pack's KB plus its shared
 *  topics, never another role's), the install into /library/ on hire —
 *  read-only to agents and people, refreshed when the version changes —
 *  kb_search ranking, kb_read paging, the prompt pointer's cap, the market
 *  summary, and the pack of an agent from before agents.packId. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { testDb, memStorage } from './helpers';
import { agents as agentsTable, workspaces as workspacesTable } from '../server/src/database/schema';
import { WorkspaceFs, FilePermissionError, type FsActor } from '../server/src/files/workspace-fs.service';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { SkillsService } from '../server/src/skills/skills.service';
import { MarketService } from '../server/src/market/market.service';
import { KnowledgeService } from '../server/src/knowledge/knowledge.service';
import { KnowledgeTools, KB_TOOL_NAMES } from '../server/src/knowledge/knowledge.tools';
import { KNOWLEDGE } from '../server/src/knowledge/knowledge.generated';
import {
  KB_POINTER_CAP, findDoc, pagesOf, promptPointer, readPage, renderPage, scopeDocs, scopeFor, searchKb, tokenize,
  type KbDoc, type KnowledgeBundle,
} from '../server/src/knowledge/knowledge';
import { TOOL_CLASSES } from '../server/src/actions/action-classes';
import { BUILTIN_SKILLS } from '../server/src/skills/builtin-skills';
import type { ChatSession } from '../server/src/chats/chats.repository';

const ROOT = process.cwd();
const FM = (o: Record<string, unknown>) => `---json\n${JSON.stringify(o)}\n---\n\n`;
const META = { title: 'A doc', summary: 'What this doc helps with, in one line.', tags: ['test'], updated: '2026-11-04' };
const BODY = '# A doc\n\n' + 'Plain words about the method, with a checklist and an example. '.repeat(8);

/** Run the build on a scratch knowledge/ tree (the real packs/). */
function build(files: Record<string, string>): { status: number | null; stderr: string; stdout: string; out: string } {
  const src = mkdtempSync(join(tmpdir(), 'kb-src-'));
  const dir = mkdtempSync(join(tmpdir(), 'kb-out-'));
  const out = join(dir, 'out.ts');
  try {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(src, rel, '..'), { recursive: true });
      writeFileSync(join(src, rel), text);
    }
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts/build-knowledge.mjs')], { env: { ...process.env, KNOWLEDGE_SRC: src, KNOWLEDGE_OUT: out }, encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr, stdout: r.stdout, out: r.status === 0 && existsSync(out) ? readFileSync(out, 'utf8') : '' };
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

const GOOD = {
  '_shared/okrs/writing-key-results.md': FM({ ...META, title: 'Writing key results' }) + BODY,
  'biz-finance-manager/README.md': FM({ ...META, title: 'Finance KB', shared: ['_shared/okrs'] }) + '# Finance\n\n- [Budget memo](./budget-memo.md)\n- [KRs](_shared/okrs/writing-key-results.md)\n',
  'biz-finance-manager/budget-memo.md': FM({ ...META, title: 'Budget memo', sources: [{ title: 'A source', url: 'https://example.com/x', date: '2025-01' }] }) + BODY,
};

test('build: a good tree validates, is embedded, and root-relative links are stored doc-relative', () => {
  const r = build(GOOD);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 packs, 1 shared topics, 3 files/);
  assert.match(r.stderr, /packs have no knowledge folder yet/, 'packs without a folder warn, not fail');
  const json = JSON.parse(r.out.slice(r.out.indexOf('= ') + 2).replace(/;\s*$/, '')) as KnowledgeBundle;
  const p = json.packs['biz-finance-manager'];
  assert.equal(p.packId, 'pack-biz-finance-manager');
  assert.deepEqual(p.shared, ['okrs']);
  assert.equal(p.docs[0].path, 'biz-finance-manager/README.md', 'README first');
  assert.match(p.docs[0].body, /\]\(\.\.\/_shared\/okrs\/writing-key-results\.md\)/);
  assert.match(p.version, /^[0-9a-f]{12}$/);
  assert.equal(p.docs[1].sources![0].date, '2025-01');
});

test('build: broken front matter, unknown keys, an unknown pack, a missing README, broken refs and links, caps — all fail', () => {
  const cases: Array<[string, Record<string, string>, RegExp]> = [
    ['no front matter', { ...GOOD, 'biz-finance-manager/budget-memo.md': BODY }, /missing ---json front matter/],
    ['bad JSON', { ...GOOD, 'biz-finance-manager/budget-memo.md': '---json\n{ title: x }\n---\n' + BODY }, /not valid JSON/],
    ['unknown key', { ...GOOD, 'biz-finance-manager/budget-memo.md': FM({ ...META, author: 'me' }) + BODY }, /unknown front matter key "author"/],
    ['bad date', { ...GOOD, 'biz-finance-manager/budget-memo.md': FM({ ...META, updated: 'Nov 4' }) + BODY }, /"updated" must be a date/],
    ['shared outside README', { ...GOOD, 'biz-finance-manager/budget-memo.md': FM({ ...META, shared: ['_shared/okrs'] }) + BODY }, /belongs in a pack's README.md only/],
    ['unknown pack', { ...GOOD, 'biz-not-a-pack/README.md': FM(META) + BODY }, /no pack file packs\/biz-not-a-pack\.md/],
    ['missing README', { '_shared/okrs/a.md': FM(META) + BODY, 'biz-sales-manager/a.md': FM(META) + BODY }, /missing README\.md/],
    ['unknown shared ref', { ...GOOD, 'biz-finance-manager/README.md': FM({ ...META, shared: ['_shared/nope'] }) + '# R\n\nAn overview of the finance knowledge base and its docs here.' }, /shared ref "_shared\/nope"/],
    ['broken link', { ...GOOD, 'biz-finance-manager/budget-memo.md': FM(META) + BODY + '\n[x](./missing.md)' }, /broken link "\.\/missing\.md"/],
    ['doc size cap', { ...GOOD, 'biz-finance-manager/budget-memo.md': FM(META) + 'x '.repeat(9_000) }, /the cap is 16000/],
    ['too short', { ...GOOD, 'biz-finance-manager/budget-memo.md': FM(META) + 'short' }, /at least 200 expected/],
    ['not a slug', { ...GOOD, 'biz-finance-manager/Budget Memo.md': FM(META) + BODY }, /lowercase slug/],
    ['docs per pack', { ...GOOD, ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`biz-finance-manager/d${i}.md`, FM(META) + BODY])) }, /at most 8 per pack/],
  ];
  for (const [name, files, re] of cases) {
    const r = build(files);
    assert.equal(r.status, 1, `${name}: should fail`);
    assert.match(r.stderr, re, name);
  }
  const big = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`biz-finance-manager/d${i}.md`, FM(META) + 'word '.repeat(2_800)]));
  const r = build({ ...GOOD, ...big });
  assert.equal(r.status, 1); assert.match(r.stderr, /the cap per pack is 90000/);
});

test('build: the committed module is what the build emits from knowledge/', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-real-'));
  try {
    const out = join(dir, 'out.ts');
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts/build-knowledge.mjs')], { env: { ...process.env, KNOWLEDGE_OUT: out }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(out, 'utf8'), readFileSync(join(ROOT, 'server/src/knowledge/knowledge.generated.ts'), 'utf8'), 'regenerate with npm run knowledge:build');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('coverage: packs without a knowledge base are reported (a warning, not a failure)', () => {
  const packs = readdirSync(join(ROOT, 'packs')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
  const missing = packs.filter((p) => !KNOWLEDGE.packs[p]);
  if (missing.length) console.warn(`knowledge base: ${missing.length} of ${packs.length} packs have none yet: ${missing.join(', ')}`);
  for (const p of Object.values(KNOWLEDGE.packs)) for (const t of p.shared) assert.ok(KNOWLEDGE.shared[t], `${p.folder} names shared topic ${t}`);
});

// ---- a fixture bundle, independent of the shipped content ----

const doc = (path: string, title: string, body: string, extra: Partial<KbDoc> = {}): KbDoc => ({ path, title, summary: `${title} in one line.`, tags: extra.tags ?? [], updated: '2026-11-04', body, words: body.split(/\s+/).length, ...extra });
const FIXTURE: KnowledgeBundle = {
  packs: {
    'biz-finance-manager': {
      folder: 'biz-finance-manager', packId: 'pack-biz-finance-manager', packName: 'Head of Finance', title: 'Finance KB', summary: 'Finance reference: budgets, runway, the close.', shared: ['okrs'], version: 'v1',
      docs: [
        doc('biz-finance-manager/README.md', 'Finance KB', '# Finance\n\n- [Budget memo](./budget-memo.md)'),
        doc('biz-finance-manager/budget-memo.md', 'Budget memo', '# Budget memo\n\nA memo asking for budget: the ask, the options, the runway impact.', { tags: ['budget'] }),
        doc('biz-finance-manager/runway.md', 'Runway and burn', '# Runway\n\nRunway = cash / net burn. Net burn is cash out minus cash in per month.\n' + 'More detail about cash planning and forecasts. '.repeat(400), { tags: ['cash', 'runway'], sources: [{ title: 'Src', url: 'https://example.com' }] }),
      ],
    },
    'biz-sales-manager': {
      folder: 'biz-sales-manager', packId: 'pack-biz-sales-manager', packName: 'Head of Sales', title: 'Sales KB', summary: 'Sales reference.', shared: [], version: 'v1',
      docs: [doc('biz-sales-manager/README.md', 'Sales KB', '# Sales'), doc('biz-sales-manager/forecast-call.md', 'Forecast call', '# Forecast call\n\nCommit, best case, runway of the quarter.')],
    },
  },
  shared: {
    okrs: { topic: 'okrs', version: 's1', docs: [doc('_shared/okrs/writing-key-results.md', 'Writing key results', '# KRs\n\nA key result is measurable: a baseline, a target, a date.', { tags: ['okrs'] })] },
    risk: { topic: 'risk', version: 's1', docs: [doc('_shared/risk/risk-registers.md', 'Risk registers', '# Risks\n\nIf … then …; likelihood × impact; an owner.')] },
  },
};

test('scope: a pack sees its own docs and its shared topics; others by the rules', () => {
  const fin = scopeFor('pack-biz-finance-manager', { company: true }, FIXTURE);
  assert.equal(fin.pack?.folder, 'biz-finance-manager');
  assert.deepEqual(fin.topics.map((t) => t.topic), ['okrs']);
  assert.ok(!scopeDocs(fin).some((d) => d.path.startsWith('biz-sales-manager/')), 'never another role');
  assert.deepEqual(scopeFor('pack-biz-marketing-manager', { company: false }, FIXTURE).topics.map((t) => t.topic), ['okrs', 'risk'], 'a business pack without a KB: every shared topic');
  assert.deepEqual(scopeFor(null, { company: true }, FIXTURE).topics.length, 2, 'a custom agent in a company: the shared topics');
  assert.equal(scopeFor(null, { company: false }, FIXTURE).topics.length, 0, 'a custom personal agent: nothing');
  assert.equal(scopeFor('pack-trip-planner', { company: true }, FIXTURE).topics.length, 0, 'a personal pack without a KB: nothing');
});

test('kb_search ranks by title, tags and body (BM25F), and stays inside the scope', () => {
  assert.deepEqual(tokenize('The runways of Companies'), ['runway', 'company']);
  const docs = scopeDocs(scopeFor('pack-biz-finance-manager', { company: true }, FIXTURE));
  const hits = searchKb(docs, 'runway');
  assert.equal(hits[0].doc.path, 'biz-finance-manager/runway.md', 'title and tag match first');
  assert.ok(hits.some((h) => h.doc.path === 'biz-finance-manager/budget-memo.md'), 'a body match ranks too');
  assert.ok(!hits.some((h) => h.doc.path.startsWith('biz-sales-manager/')), 'the sales forecast doc mentions runway but is another role');
  assert.equal(searchKb(docs, 'key result baseline')[0].doc.path, '_shared/okrs/writing-key-results.md');
  assert.deepEqual(searchKb(docs, 'the of and'), [], 'stop words only: nothing');
  assert.match(hits[0].snippet, /Runway = cash \/ net burn/);
});

test('kb_read pages a long doc on line boundaries; any path form finds it', () => {
  const docs = scopeDocs(scopeFor('pack-biz-finance-manager', { company: true }, FIXTURE));
  const long = findDoc(docs, '/library/biz-finance-manager/runway.md')!;
  assert.ok(long);
  assert.equal(findDoc(docs, '(KB: biz-finance-manager/runway.md)'), long);
  assert.equal(findDoc(docs, 'runway'), long, 'a bare slug unique in scope');
  assert.equal(findDoc(docs, 'biz-sales-manager/forecast-call.md'), null, 'another role is not readable');
  const pages = pagesOf(long.body);
  assert.ok(pages.length >= 3);
  assert.equal(pages.join('\n').length >= long.body.length - pages.length, true);
  const p1 = renderPage(readPage(long, 1));
  assert.match(p1, /^\[biz-finance-manager\/runway\.md · Runway and burn · page 1 of \d+/);
  assert.match(p1, /continued: kb_read with page 2/);
  assert.doesNotMatch(p1, /Sources:/);
  const last = renderPage(readPage(long, 999));
  assert.match(last, new RegExp(`page ${pages.length} of ${pages.length}`), 'past the end: the last page');
  assert.match(last, /Sources:\n- Src: https:\/\/example\.com/);
});

test('the prompt pointer: README summary and titles, the shared topics, the citation form — within its cap', () => {
  const fin = promptPointer(scopeFor('pack-biz-finance-manager', { company: true }, FIXTURE))!;
  assert.match(fin, /^# Knowledge base\n/);
  assert.match(fin, /\/library\/biz-finance-manager\//);
  assert.match(fin, /Budget memo; Runway and burn/);
  assert.match(fin, /shared topics: okrs/);
  assert.match(fin, /\(KB: <path>\)/);
  assert.match(fin, /LESSONS\.md/);
  assert.ok(fin.length <= KB_POINTER_CAP);
  const many: KnowledgeBundle = structuredClone(FIXTURE);
  many.packs['biz-finance-manager'].docs.push(...Array.from({ length: 8 }, (_, i) => doc(`biz-finance-manager/d${i}.md`, `A rather long document title number ${i} about something`, 'x')));
  const capped = promptPointer(scopeFor('pack-biz-finance-manager', { company: true }, many))!;
  assert.ok(capped.length <= KB_POINTER_CAP, `${capped.length}`);
  assert.match(capped, /\+\d+ more/);
  assert.equal(promptPointer(scopeFor(null, { company: false }, FIXTURE)), null);
  // the shipped content, every pack: within the cap
  for (const p of Object.values(KNOWLEDGE.packs)) assert.ok(promptPointer(scopeFor(p.packId, { company: true }))!.length <= KB_POINTER_CAP, p.folder);
});

test('the tools are read-only everywhere: classed read, the auditor may use them, a skill says how', () => {
  for (const n of KB_TOOL_NAMES) assert.equal(TOOL_CLASSES[n], 'read', n);
  const src = readFileSync(join(ROOT, 'server/src/org/org-runtime.service.ts'), 'utf8');
  assert.match(src, /AUDIT_TOOL_NAMES = new Set\(\[[^\]]*'kb_search', 'kb_read', 'kb_list'/);
  const skill = BUILTIN_SKILLS.find((s) => s.name === 'use-the-knowledge-base')!;
  assert.match(skill.instructions, /kb_search/); assert.match(skill.instructions, /\(KB: /);
});

// ---- the workspace: hire, install, permissions, versions ----

async function setup() {
  const db = await testDb();
  const { stub, map } = memStorage();
  const fs = new WorkspaceFs(stub, db);
  const agents = new AgentsService(db, stub);
  const workspaces = new WorkspacesService(db, stub);
  const skills = new SkillsService(db);
  const ws = await workspaces.create({ name: 'Acme' });
  const knowledge = new KnowledgeService(db, fs);
  knowledge.bundle = structuredClone(FIXTURE);
  const market = new MarketService(agents, skills, knowledge);
  const tools = new KnowledgeTools(knowledge);
  return { db, map, fs, agents, workspaces, skills, ws, knowledge, market, tools };
}
const session = (agentId: string, workspaceId: string) => ({ id: 's1', agentId, workspaceId }) as unknown as ChatSession;
const text = async (fs: WorkspaceFs, ws: string, path: string) => (await fs.read(ws, path))?.body.toString('utf8') ?? null;

test('hire: the role\'s library installs once under /library/, by the system, read-only to agents and people', async () => {
  const s = await setup();
  const { agent } = await s.market.hire('pack-biz-finance-manager', s.ws.id);
  assert.equal((await s.agents.get(agent.id)).packId, 'pack-biz-finance-manager', 'the hire records the pack');
  const memo = await text(s.fs, s.ws.id, 'library/biz-finance-manager/budget-memo.md');
  assert.ok(memo, 'installed');
  assert.match(memo!, /^> Read-only reference from the Head of Finance knowledge base/);
  assert.ok(await text(s.fs, s.ws.id, 'library/_shared/okrs/writing-key-results.md'), 'its shared topic too');
  assert.equal(await text(s.fs, s.ws.id, 'library/_shared/risk/risk-registers.md'), null, 'not a topic it does not name');
  assert.equal(await text(s.fs, s.ws.id, 'library/biz-sales-manager/forecast-call.md'), null, 'not another role');
  assert.match((await text(s.fs, s.ws.id, 'library/README.md'))!, /\[Head of Finance\]\(\.\/biz-finance-manager\/README\.md\)/);
  assert.match((await text(s.fs, s.ws.id, 'library/biz-finance-manager/runway.md'))!, /## Sources\n\n- \[Src\]\(https:\/\/example\.com\)/);
  assert.equal((await s.fs.meta(s.ws.id, 'library/biz-finance-manager/budget-memo.md'))!.updatedBy.kind, 'system');
  // read-only
  const home = (await s.agents.home(agent)).home;
  const me: FsActor = { kind: 'agent', id: agent.id, name: agent.name, home };
  await assert.rejects(async () => s.fs.write(s.ws.id, 'library/biz-finance-manager/budget-memo.md', Buffer.from('mine'), { by: me }), FilePermissionError);
  await assert.rejects(async () => s.fs.delete(s.ws.id, 'library/biz-finance-manager/budget-memo.md', { by: { kind: 'user', id: 'u', name: 'U' } }), FilePermissionError);
  await assert.rejects(async () => s.fs.write(s.ws.id, 'library/notes.md', Buffer.from('x'), { by: me }), /read-only knowledge base/);
  // a second agent of the role shares the copy: nothing rewritten
  const v = (await s.fs.meta(s.ws.id, 'library/biz-finance-manager/budget-memo.md'))!.version;
  const twin = await s.agents.create({ name: 'Finance 2', workspaceId: s.ws.id, packId: 'pack-biz-finance-manager' });
  const again = await s.knowledge.installFor(twin.id);
  assert.deepEqual(again.written, []);
  assert.equal((await s.fs.meta(s.ws.id, 'library/biz-finance-manager/budget-memo.md'))!.version, v);
});

test('a new version refreshes the library: changed docs rewritten, dropped docs removed', async () => {
  const s = await setup();
  const { agent } = await s.market.hire('pack-biz-finance-manager', s.ws.id);
  const p = s.knowledge.bundle.packs['biz-finance-manager'];
  p.docs = p.docs.filter((d) => !d.path.endsWith('/runway.md'));
  p.docs[1] = { ...p.docs[1], body: '# Budget memo\n\nThe new text of the memo.' };
  p.version = 'v2';
  s.knowledge.invalidate();
  await s.knowledge.ensureInstalled(agent.id);
  assert.match((await text(s.fs, s.ws.id, 'library/biz-finance-manager/budget-memo.md'))!, /The new text of the memo/);
  assert.equal(await text(s.fs, s.ws.id, 'library/biz-finance-manager/runway.md'), null, 'a doc no longer shipped is removed');
  assert.ok((await s.fs.revisions(s.ws.id, 'library/biz-finance-manager/runway.md')).length > 0, 'kept as a revision');
  const before = s.map.size;
  await s.knowledge.ensureInstalled(agent.id);
  assert.equal(s.map.size, before, 'same version: no writes');
});

test('the tools through the provider: offered with the pointer, scoped, paged', async () => {
  const s = await setup();
  const { agent } = await s.market.hire('pack-biz-finance-manager', s.ws.id);
  const sess = session(agent.id, s.ws.id);
  assert.deepEqual((await s.tools.specsFor(sess)).map((t) => t.name), ['kb_search', 'kb_read', 'kb_list']);
  assert.match((await s.tools.contextFor(sess))!, /# Knowledge base/);
  assert.match(await s.tools.execute(sess, 'kb_search', { query: 'runway' }), /^1\. biz-finance-manager\/runway\.md — Runway and burn/);
  assert.match(await s.tools.execute(sess, 'kb_read', { path: 'biz-sales-manager/forecast-call.md' }), /not in your knowledge base/);
  assert.match(await s.tools.execute(sess, 'kb_read', { path: 'runway', page: 2 }), /page 2 of/);
  assert.match(await s.tools.execute(sess, 'kb_list', {}), /_shared\/okrs\/writing-key-results\.md/);
  await assert.rejects(s.tools.execute(sess, 'kb_read', { path: 'runway', page: 0 }), /positive integer/);
  // a custom agent outside a company: no tools, no pointer
  const solo = await s.agents.create({ name: 'Solo', workspaceId: s.ws.id });
  assert.deepEqual(await s.tools.specsFor(session(solo.id, s.ws.id)), []);
  assert.equal(await s.tools.contextFor(session(solo.id, s.ws.id)), null);
  // …in a company: the shared topics
  await s.db.update(workspacesTable).set({ orgMode: 'supervised' }).where(eq(workspacesTable.id, s.ws.id));
  s.knowledge.invalidate();
  assert.match(await s.tools.execute(session(solo.id, s.ws.id), 'kb_list', {}), /Shared: okrs[\s\S]*Shared: risk/);
});

test('an agent from before agents.packId: its pack is read from its seat or its playbooks', async () => {
  const s = await setup();
  const legacy = await s.agents.create({ name: 'Money', workspaceId: s.ws.id });
  const pack = (await import('../server/src/market/authored-packs.generated')).AUTHORED_PACKS.find((p) => p.id === 'pack-biz-finance-manager')!;
  for (const sk of pack.skills!.slice(0, 2)) await s.skills.create({ name: sk.name, description: sk.description, instructions: sk.instructions, agentId: legacy.id });
  assert.equal(await s.knowledge.packOf(await s.agents.get(legacy.id)), 'pack-biz-finance-manager');
  const chief = await s.agents.create({ name: 'Chief', workspaceId: s.ws.id });
  await s.db.update(workspacesTable).set({ chiefOfStaffAgentId: chief.id }).where(eq(workspacesTable.id, s.ws.id));
  assert.equal(await s.knowledge.packOf(await s.agents.get(chief.id)), 'pack-chief-of-staff');
  const row = (await s.db.select().from(agentsTable).where(eq(agentsTable.id, legacy.id)))[0];
  assert.equal(row.packId, null);
  // the agent page's view
  const page = (await s.knowledge.forAgent(legacy.id))!;
  assert.equal(page.folder, 'biz-finance-manager');
  assert.equal(page.docs.find((d) => d.path.endsWith('budget-memo.md'))!.file, '/library/biz-finance-manager/budget-memo.md');
  assert.equal(await s.knowledge.forAgent('nope'), null);
});

test('AGENT.json carries the pack by id, and an import keeps it', async () => {
  const s = await setup();
  const { agent } = await s.market.hire('pack-biz-finance-manager', s.ws.id);
  const json = await s.agents.exportJson(agent.id) as Record<string, unknown>;
  assert.equal(json.packId, 'pack-biz-finance-manager');
  assert.equal(JSON.stringify(json).includes('Budget memo'), false, 'never the docs inline');
  const back = await s.agents.importJson({ ...json, name: 'Imported finance' }, { workspaceId: s.ws.id });
  assert.equal(back.packId, 'pack-biz-finance-manager');
});

test('the market lists each pack\'s knowledge base in brief', async () => {
  const s = await setup();
  const items = await s.market.list(s.ws.id) as Array<{ id: string; knowledge?: { docs: number; titles: string[] } }>;
  for (const p of Object.values(KNOWLEDGE.packs)) {
    const it = items.find((i) => i.id === p.packId)!;
    assert.equal(it.knowledge!.docs, p.docs.length - 1, `${p.folder}: README not counted`);
  }
  const none = items.find((i) => !Object.values(KNOWLEDGE.packs).some((p) => p.packId === i.id));
  if (none) assert.equal(none.knowledge, undefined);
});

test('prompt size in a real company: the pointer is one section, within its cap, chief and members alike', async () => {
  const { setupCompany, systemOf } = await import('./company-briefing-fixture');
  const c = await setupCompany();
  const before = { chief: await systemOf(c, c.chief.id), junior: await systemOf(c, c.junior.id) };
  const service = new KnowledgeService(c.db, new WorkspaceFs(c.storage, c.db));
  new KnowledgeTools(service, c.turns).onModuleInit();
  const after = { chief: await systemOf(c, c.chief.id), junior: await systemOf(c, c.junior.id) };
  for (const k of ['chief', 'junior'] as const) {
    assert.equal(after[k].split('# Knowledge base').length - 1, 1, `${k}: one pointer`);
    const grew = after[k].length - before[k].length;
    assert.ok(grew > 0 && grew <= KB_POINTER_CAP + 2, `${k}: grew by ${grew} ≤ ${KB_POINTER_CAP + 2}`);
  }
  assert.match(after.chief, /\/library\/chief-of-staff\//, 'the chief\'s seat brings the Chief of Staff knowledge base');
  assert.match(after.junior, /\/library\/_shared\//, 'a custom member: the shared topics');
});
