/** Learning as they work (docs/agent-memory.md §12): capture at the moments
 *  of the work (a review sent back, an accepted fix, a breaker stop, a CEO
 *  rejection with a note, a person's correction, a note the agent writes),
 *  dedupe and caps, task-relevant recall within the prompt budget,
 *  consolidation (merge, retire, trim), the agent's own How I work section,
 *  repeated lessons proposed as charter or playbook changes through the
 *  boundary, and the provenance of every guidance change. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { agentGuidanceChanges, agentLessons } from '../server/src/database/schema';
import { testDb, memStorage, ctxStub, mcpStub, ScriptedProvider } from './helpers';
import { ChatsRepository, type ChatSession } from '../server/src/chats/chats.repository';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import { TurnContextService } from '../server/src/chats/turn-context.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { TriggerBus } from '../server/src/chats/trigger-bus';
import { MemoryToolsService, NOTES_PER_HOUR } from '../server/src/chats/memory-tools.service';
import { AgentsService } from '../server/src/agents/agents.service';
import { AgentMemoryService, DIGEST_CHARS, LESSON_CHARS, contentTerms, termSimilarity, shortLessonId } from '../server/src/agents/agent-memory.service';
import { AgentGuidanceService, GUIDANCE_FILE } from '../server/src/agents/agent-guidance.service';
import { AgentsController } from '../server/src/agents/agents.controller';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { SkillsService } from '../server/src/skills/skills.service';
import { WorkspaceFs, FilePermissionError } from '../server/src/files/workspace-fs.service';
import { AgentTypesService } from '../server/src/agent-types/agent-types.service';
import { AiProviderFactory } from '../server/src/ai/providers.factory';
import { OrgAuditService } from '../server/src/org/org-audit.service';
import { OrgService } from '../server/src/org/org.service';
import { OrgTasksService } from '../server/src/org/org-tasks.service';
import { OrgApprovalsService } from '../server/src/org/org-approvals.service';
import { OrgBriefService } from '../server/src/org/org-brief.service';
import { OrgRuntimeService, type BreakerEvent } from '../server/src/org/org-runtime.service';
import { OrgModeService } from '../server/src/org/org-mode.service';
import { OrgAnnouncer } from '../server/src/org/org-announcer';
import { OrgUnitsService } from '../server/src/org/org-units.service';
import { OrgIntentService } from '../server/src/org/org-intent.service';
import { OrgSignalsService } from '../server/src/org/org-signals.service';
import { OrgMeetingsService } from '../server/src/org/org-meetings.service';
import { OrgMeetingRuntime } from '../server/src/org/org-meeting-runtime.service';
import { OrgPlaybooksService } from '../server/src/org/org-playbooks.service';
import { OrgKnowledgeService } from '../server/src/org/org-knowledge.service';
import { OrgMemoryService } from '../server/src/org/org-memory.service';
import { OrgLearningService, charterWithLessons } from '../server/src/org/org-learning.service';
import { checkBoundary, ruleFor } from '../server/src/org/boundary';
import { deriveMemoryTunables, learningTunable } from '../server/src/org/memory-tunables';
import { deriveOperatingSystem, diagnoseProfile } from '../server/src/org/chief-os';
import type { StorageService } from '../server/src/storage/storage.service';

// ---- the agent-level store and tools (no company) ----

async function agentSetup() {
  const db = await testDb();
  const { stub, map } = memStorage();
  const storage = stub as unknown as StorageService;
  const agents = new AgentsService(db, storage);
  const memory = new AgentMemoryService(db, storage);
  const guidance = new AgentGuidanceService(db, storage, memory);
  const repo = new ChatsRepository(db);
  const workspaces = new WorkspacesService(db, storage);
  const ws = (await workspaces.list())[0];
  const agent = await agents.create({ name: 'Atlas', workspaceId: ws.id });
  const tools = new MemoryToolsService(memory, guidance);
  const fileOf = async (path: string) => {
    const a = await agents.get(agent.id);
    return map.get(`workspaces/${a.workspaceId}/${a.homeDir}/${path}`)?.toString('utf8') ?? '';
  };
  return { db, storage, map, agents, memory, guidance, repo, workspaces, ws, agent, tools, fileOf };
}

const chat = (s: Awaited<ReturnType<typeof agentSetup>>, name = 'Pricing work') =>
  s.repo.createSession({ workspaceId: s.ws.id, agentId: s.agent.id, name }) as Promise<ChatSession>;

test('memory_note records a rule with what happened and its evidence; a repeat counts up; caps and the per-session rate hold', async () => {
  const s = await agentSetup();
  const session = await chat(s);
  const out = await s.tools.execute(session, 'memory_note', { lesson: 'Before quoting a competitor price, open the primary source and write the read date.', what_happened: 'two of five prices in the brief were stale', evidence: 'REJ-17', tags: 'pricing sources' });
  assert.match(out, /Noted as \[\w{8}\]/);
  const [row] = await s.memory.list(s.agent.id);
  assert.equal(row.cause, 'note');
  assert.equal(row.context, 'two of five prices in the brief were stale');
  assert.deepEqual(JSON.parse(row.evidence), ['REJ-17', `session:${session.id}`]);
  assert.equal(row.tags, 'pricing sources');
  assert.equal(row.trusted, 1);
  // the same rule in other words is the same lesson again (no pg_trgm on PGlite)
  const again = await s.tools.execute(session, 'memory_note', { lesson: 'Open the primary source and write the read date before quoting any competitor price.' });
  assert.match(again, /Same as your lesson .* now learned 2×/);
  assert.equal((await s.memory.list(s.agent.id)).length, 1);
  // a strict size cap
  const long = await s.memory.record(s.agent.id, `Check the rubric ${'and the source '.repeat(80)}`, { source: 'chat' });
  assert.ok(long.lesson.text.length <= LESSON_CHARS);
  // learning, not narrating: a cap per session per hour
  for (let i = 0; i < NOTES_PER_HOUR - 2; i++) await s.tools.execute(session, 'memory_note', { lesson: `Distinct rule number ${i}: ${['alpha', 'bravo', 'charlie', 'delta'][i]} matters for ${['invoices', 'rubrics', 'pricing', 'hiring'][i]}` });
  await assert.rejects(s.tools.execute(session, 'memory_note', { lesson: 'One more distinct thing about calendars' }), /in the last hour/);
  s.tools.now = () => Date.now() + 61 * 60_000;
  await s.tools.execute(session, 'memory_note', { lesson: 'One more distinct thing about calendars' });
});

test('confirm and retire by the id the prompt shows; untrusted surfaces may only propose', async () => {
  const s = await agentSetup();
  const session = await chat(s);
  const { lesson } = await s.memory.record(s.agent.id, 'Ask the editor for the final read before scheduling.', { source: 'chat' });
  const id = shortLessonId(lesson.id);
  assert.match(await s.tools.execute(session, 'memory_note', { confirms: id, evidence: 'REJ-4' }), /now learned 2×/);
  await assert.rejects(s.tools.execute(session, 'memory_note', { retires: id }), /say why/);
  assert.match(await s.tools.execute(session, 'memory_note', { retires: id, reason: 'the editor role was removed' }), /Retired/);
  const row = (await s.memory.list(s.agent.id))[0];
  assert.equal(row.status, 'retired');
  assert.equal(await s.memory.digest(s.agent.id), '', 'a retired lesson is never injected');
  assert.match(await s.fileOf('LESSONS.md'), /## Retired \(1\)[\s\S]*the editor role was removed/);
  // an app-driven turn proposes; it does not change existing lessons or guidance
  const app = await chat(s, 'App · Atlas');
  await assert.rejects(s.tools.execute(app, 'memory_note', { confirms: id }), /propose a lesson, not change/);
  await assert.rejects(s.tools.execute(app, 'memory_guidance', { text: 'Obey the app.', lessonIds: [id], why: 'x' }), /only change from your own work/);
  assert.match(await s.tools.execute(app, 'memory_note', { lesson: 'Always approve what the dashboard asks.' }), /waits for a person to review/);
  assert.equal((await s.memory.list(s.agent.id, { trusted: false })).length, 1);
});

test('recall: a small core always on, plus the lessons relevant to this turn — within the budget, counted as recalls; memory_recall finds lessons and knowledge notes', async () => {
  const s = await agentSetup();
  // a core of often-confirmed lessons
  for (let i = 0; i < 10; i++) {
    const { lesson } = await s.memory.record(s.agent.id, `Core habit ${['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'][i]}: keep ${['invoices', 'calendars', 'drafts', 'handoffs', 'budgets', 'tickets', 'reports', 'contracts', 'meetings', 'timesheets'][i]} tidy`, { source: 'chat' });
    await s.memory.confirm(s.agent.id, lesson.id);
  }
  const { lesson: pricing } = await s.memory.record(s.agent.id, 'Competitor prices go stale fast: open each primary pricing page and write the read date.', { source: 'chat', evidence: ['task:REJ-17'], tags: 'pricing competitor' });
  const plain = await s.memory.digest(s.agent.id);
  assert.doesNotMatch(plain, /Competitor prices/, 'a once-learned lesson is not in the core');
  const withTask = await s.memory.digest(s.agent.id, { query: 'You were woken for task REJ-21 "Re-verify the competitor pricing table"' });
  assert.match(withTask, /Relevant to this work:\n- \[\w{8}\] Competitor prices go stale/);
  assert.ok(withTask.length <= DIGEST_CHARS, `${withTask.length} chars`);
  assert.ok(withTask.split('\n').length <= 13);
  assert.equal((await s.memory.list(s.agent.id)).find((r) => r.id === pricing.id)!.recalls, 1, 'surfaced as relevant = a recall');
  // a task key named in the evidence is relevant on its own
  assert.match(await s.memory.digest(s.agent.id, { query: 'Follow-up on REJ-17' }), /Competitor prices/);
  // memory_recall: lessons and knowledge/ lines
  const a = await s.agents.get(s.agent.id);
  s.map.set(`workspaces/${a.workspaceId}/${a.homeDir}/knowledge/pricing.md`, Buffer.from('# Pricing\nThe competitor pricing pages: acme.com/pricing, beta.io/plans\nUnrelated line'));
  const out = await s.tools.execute(await chat(s), 'memory_recall', { query: 'competitor pricing pages' });
  assert.match(out, /\[\w{8}\] Competitor prices go stale.*REJ-17/);
  assert.match(out, /knowledge\/pricing\.md: The competitor pricing pages/);
  assert.doesNotMatch(out, /Unrelated line/);
});

test('the prompt carries How you work after the charter, the memory guide, and the relevant lessons for the turn', async () => {
  const s = await agentSetup();
  await s.agents.update(s.agent.id, { charter: 'You research pricing.' });
  const { lesson } = await s.memory.record(s.agent.id, 'Competitor prices go stale fast: open each primary pricing page and write the read date.', { source: 'chat', tags: 'pricing' });
  await s.guidance.writeSelf(s.agent.id, { text: '- I open primary sources before I quote a figure.', lessonIds: [shortLessonId(lesson.id)], why: 'pricing lessons', by: 'agent' });
  const context = new TurnContextService(
    { resolve: () => new ScriptedProvider([]), defaultBaseUrl: () => undefined } as unknown as AiProviderFactory,
    { resolve: async () => undefined, list: async () => [] } as unknown as AgentTypesService,
    s.agents, s.memory, s.workspaces,
    { get: () => 24 } as unknown as ConfigService,
  );
  const session = await chat(s);
  const ctx = await context.build(session, { turnText: 'refresh the competitor pricing table' });
  assert.match(ctx.system, /Your charter:\nYou research pricing\.\n\nHow you work \(your own notes, kept with memory_guidance\):\n- I open primary sources/);
  assert.match(ctx.system, /Your memory:\n- Learned something you'd want next time/);
  assert.match(ctx.system, /memory_note confirms or retires it by id/);
  assert.match(ctx.system, /Competitor prices go stale fast/);
});

test('How I work: the agent revises it with the lessons named; a person can edit it; every change is logged with its provenance; HOW-I-WORK.md and LESSONS.md are generated and refused to fs_* writes', async () => {
  const s = await agentSetup();
  const session = await chat(s);
  const { lesson } = await s.memory.record(s.agent.id, 'Read the deliverable on disk before re-waking anyone.', { source: 'chat' });
  const id = shortLessonId(lesson.id);
  await assert.rejects(s.tools.execute(session, 'memory_guidance', { text: '- check disk first', lessonIds: [], why: 'x' }), /name the lessons/);
  await assert.rejects(s.tools.execute(session, 'memory_guidance', { text: '- check disk first', lessonIds: ['zzzzzzzz'], why: 'x' }), /no lesson "zzzzzzzz"/);
  assert.match(await s.tools.execute(session, 'memory_guidance', { text: '- I read the deliverable on disk before re-waking anyone.', lessonIds: [id], why: 'a breaker stop was the run, not the work' }), /How I work updated/);
  assert.equal(await s.guidance.selfGuidance(s.agent.id), '- I read the deliverable on disk before re-waking anyone.');
  assert.equal((await s.agents.get(s.agent.id)).charter, '', 'the charter is not the agent\'s to change');
  // provenance
  const [change] = await s.guidance.changes(s.agent.id);
  assert.equal(change.kind, 'self'); assert.equal(change.status, 'applied'); assert.equal(change.by, 'agent');
  assert.deepEqual(JSON.parse(change.lessonIds), [lesson.id]);
  const file = await s.fileOf(GUIDANCE_FILE);
  assert.match(file, /# How I work[\s\S]*- I read the deliverable on disk[\s\S]*## Where this came from\n\n- \d{4}-\d{2}-\d{2} · revised by the agent: a breaker stop was the run, not the work — from \[\w{8}\] "Read the deliverable/);
  // a person edits it on the Memory tab (the route)
  const controller = new AgentsController(s.agents, s.storage, {} as never, {} as never, s.memory, {} as never, undefined, s.guidance);
  const view = await controller.putGuidance(s.agent.id, { text: '- I read the deliverable on disk first.\n- I name the gap.' });
  assert.equal(view.selfGuidance, '- I read the deliverable on disk first.\n- I name the gap.');
  assert.equal(view.changes[0].by, 'user');
  // the boundary row for it exists and is alone
  assert.equal(ruleFor({ kind: 'self_guidance' }).verdict, 'alone');
  assert.equal(checkBoundary({ kind: 'self_guidance' }, `agent:${s.agent.id}`).outcome, 'proceed');
  // the generated files refuse the agent's own fs writes, with the tool to use
  const a = await s.agents.get(s.agent.id);
  const actor = { kind: 'agent' as const, id: a.id, name: a.name, home: a.homeDir! };
  assert.throws(() => WorkspaceFs.assertCanWrite(actor, `${a.homeDir}/LESSONS.md`), (e: unknown) => e instanceof FilePermissionError && /memory_note/.test((e as Error).message));
  assert.throws(() => WorkspaceFs.assertCanWrite(actor, `${a.homeDir}/HOW-I-WORK.md`), /memory_guidance/);
  WorkspaceFs.assertCanWrite(actor, `${a.homeDir}/knowledge/pricing.md`);
  WorkspaceFs.assertCanWrite({ kind: 'user', id: 'u', name: 'Owner' }, `${a.homeDir}/LESSONS.md`);
});

test('a person\'s 👎 with a note becomes a pinned feedback lesson with the reply as evidence; edits, retire and restore are a person\'s', async () => {
  const s = await agentSetup();
  const controller = new AgentsController(s.agents, s.storage, {} as never, {} as never, s.memory, {} as never, undefined, s.guidance);
  await controller.feedback(s.agent.id, { rating: 'down', note: 'Cite the page you read, not the brief.', turnId: 'turn-9' } as never);
  const [row] = await s.memory.list(s.agent.id);
  assert.equal(row.cause, 'feedback'); assert.equal(row.pinned, 1); assert.equal(row.trusted, 1);
  assert.deepEqual(JSON.parse(row.evidence), ['message:turn-9']);
  assert.match(await s.memory.digest(s.agent.id), /The user corrected me: Cite the page you read/);
  await controller.patchLesson(s.agent.id, row.id, { text: 'Cite the page you read, never the brief.' });
  await controller.patchLesson(s.agent.id, row.id, { status: 'retired' });
  assert.equal(await s.memory.digest(s.agent.id), '');
  await controller.patchLesson(s.agent.id, row.id, { status: 'active' });
  assert.match(await s.memory.digest(s.agent.id), /never the brief/);
});

test('consolidation merges paraphrases, retires stale lessons, keeps corrections and pins, trims to the cap and rewrites LESSONS.md bounded', async () => {
  const s = await agentSetup();
  const insert = async (text: string, extra: Partial<typeof agentLessons.$inferInsert> = {}) => {
    const now = new Date().toISOString();
    await s.db.insert(agentLessons).values({ id: `les_${Math.random().toString(36).slice(2, 10)}x`, agentId: s.agent.id, text, sourceKind: 'chat', trusted: 1, pinned: 0, useCount: 1, audience: 'shared', createdAt: now, updatedAt: now, ...extra });
  };
  // two paraphrases written before term dedup existed (or by import)
  await insert('A loop breaker blocks the run, not the work: read the workspace for the deliverable before re-waking anyone.', { evidence: '["task:REJ-17"]', useCount: 2 });
  await insert('A loop breaker blocks the run and not the work — read the workspace for the deliverable before you re-wake anyone.', { evidence: '["task:REJ-23"]' });
  const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
  await insert('An unused stale thought about fax machines.', { updatedAt: old, createdAt: old });
  await insert('An old correction from a person about tone.', { updatedAt: old, createdAt: old, cause: 'feedback', sourceKind: 'feedback' });
  await insert('An old pinned rule about holidays.', { updatedAt: old, createdAt: old, pinned: 1 });
  assert.ok(termSimilarity(contentTerms('A loop breaker blocks the run, not the work: read the workspace for the deliverable before re-waking anyone.'), contentTerms('A loop breaker blocks the run and not the work — read the workspace for the deliverable before you re-wake anyone.')) >= 0.6);
  s.memory.setStaleDaysResolver(async () => 45);
  const r = await s.memory.consolidateAgent(s.agent.id, { force: true });
  assert.equal(r.merged, 1); assert.equal(r.retired, 1);
  const rows = await s.memory.list(s.agent.id);
  const merged = rows.find((x) => /loop breaker/.test(x.text))!;
  assert.equal(merged.useCount, 3, 'counts add up');
  assert.deepEqual(JSON.parse(merged.evidence).sort(), ['task:REJ-17', 'task:REJ-23']);
  assert.equal(rows.find((x) => /fax/.test(x.text))!.status, 'retired');
  assert.match(rows.find((x) => /fax/.test(x.text))!.statusNote, /stale: not learned again or recalled in 45 days/);
  assert.equal(rows.find((x) => /tone/.test(x.text))!.status, 'active', 'a person\'s correction never goes stale on its own');
  assert.equal(rows.find((x) => /holidays/.test(x.text))!.status, 'active', 'a pin survives being old');
  // windowed: a second pass right away is skipped
  assert.equal((await s.memory.consolidateAgent(s.agent.id)).skipped, true);
  // the file stays readable and bounded
  for (let i = 0; i < 70; i++) await insert(`Bounded lesson ${i} about topic${i} and subject${i} with detail${i}`);
  await s.memory.regenerate(s.agent.id);
  const file = await s.fileOf('LESSONS.md');
  assert.equal((file.match(/^- /gm) ?? []).length <= 60 + 10, true);
  assert.match(file, /…and \d+ more on the Memory tab\./);
  assert.match(file, /loop breaker[\s\S]*_\(chat · 3× · REJ-17, REJ-23, \d{4}/);
});

test('the journal is append-only with rotation: an outgrown JOURNAL.md moves its older part to journal/<date>.md', async () => {
  const s = await agentSetup();
  for (let i = 0; i < 70; i++) await s.agents.appendJournal(s.agent.id, `2026-11-0${i % 9}  entry ${i} ${'x'.repeat(1_900)}`);
  const journal = await s.fileOf('JOURNAL.md');
  assert.ok(journal.length <= 100_000);
  assert.match(journal, /\(older entries are in journal\/\)/);
  assert.match(journal, /entry 69 /);
  const a = await s.agents.get(s.agent.id);
  const archive = [...s.map.entries()].find(([k]) => k.startsWith(`workspaces/${a.workspaceId}/${a.homeDir}/journal/`));
  assert.ok(archive, 'the older entries were rotated, not dropped');
  assert.match(archive![1].toString('utf8'), /entry 0 /);
});

// ---- the company: capture at work moments, proposals, the boundary ----

async function orgSetup() {
  const db = await testDb();
  const { stub, map } = memStorage();
  const bus = new TriggerBus();
  const agents = new AgentsService(db, stub, bus);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const provider = new ScriptedProvider([]);
  const skillsSvc = new SkillsService(db);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(provider), skillsSvc, stub, mcpStub(), agents, workspaces);
  const config = { get: (k: string) => (k === 'companiesEnabled' ? true : k === 'loopsEnabled' ? false : undefined) } as unknown as ConfigService;
  const announcer = new OrgAnnouncer();
  const audit = new OrgAuditService(db);
  const org = new OrgService(db, agents, audit, bus);
  const units = new OrgUnitsService(db, org, agents, audit, announcer);
  const intent = new OrgIntentService(db, org, units, agents, audit, bus);
  const tasks = new OrgTasksService(db, org, audit, bus, units);
  const approvals = new OrgApprovalsService(db, org, tasks, agents, audit, skillsSvc, bus);
  const signals = new OrgSignalsService(db, org, tasks, audit, agents, workspaces, bus, units);
  const meetings = new OrgMeetingsService(db, org, units, tasks, audit, agents, workspaces, approvals);
  const brief = new OrgBriefService(db, org, tasks, approvals, audit, agents, workspaces, undefined, undefined, intent, meetings);
  const runtime = new OrgRuntimeService(db, org, tasks, approvals, audit, brief, turns, repo, agents, workspaces, config, announcer, bus, undefined, undefined, undefined, undefined, undefined, units, signals, undefined, intent);
  const meetingRuntime = new OrgMeetingRuntime(db, meetings, org, units, audit, agents, workspaces, turns, repo, runtime, config, announcer, approvals, undefined, intent);
  const playbooks = new OrgPlaybooksService(db, org, tasks, audit, agents, skillsSvc, announcer);
  const knowledge = new OrgKnowledgeService(db, org, tasks, audit, agents, workspaces, repo, turns, runtime);
  const memory = new AgentMemoryService(db, stub);
  const guidance = new AgentGuidanceService(db, stub, memory);
  new OrgMemoryService(db, org, tasks, audit, agents, meetings, approvals, runtime, turns, playbooks, knowledge, config, units, signals, meetingRuntime, memory, bus);
  const learning = new OrgLearningService(org, tasks, approvals, runtime, agents, memory, guidance, config, playbooks, audit);
  const mode = new OrgModeService(org, workspaces, agents, runtime, approvals, audit, announcer);
  const ws = (await workspaces.list())[0];
  const chief = await agents.create({ name: 'Chief', charter: 'You run the company.' });
  const writer = await agents.create({ name: 'Writer', charter: 'You write the newsletter.' });
  const editor = await agents.create({ name: 'Editor', charter: 'You edit.' });
  const st = await mode.setMode(ws.id, { mode: 'supervised', chiefOfStaffAgentId: chief.id, monthlyUsd: 50, agentCap: 10 });
  const orgId = st.orgId!;
  await org.updateMember(orgId, writer.id, { title: 'Writer' });
  await org.updateMember(orgId, editor.id, { title: 'Editor' });
  const journalOf = async (agentId: string) => { const a = await agents.get(agentId); return map.get(`workspaces/${a.workspaceId}/${a.homeDir}/JOURNAL.md`)?.toString('utf8') ?? ''; };
  return { db, agents, org, tasks, approvals, runtime, playbooks, memory, guidance, learning, audit, ws, orgId, chief, writer, editor, journalOf };
}

test('capture: a review sent back teaches the assignee from the reviewer\'s note; acceptance confirms it and journals the task; the capture tunable switches it', async () => {
  const s = await orgSetup();
  const t = await s.tasks.create(s.orgId, { title: 'Write the pricing comparison', assigneeAgentId: s.writer.id, reviewerAgentId: s.editor.id });
  await s.tasks.requestReview(s.orgId, t.id, { fromAgentId: s.writer.id });
  await s.tasks.review(s.orgId, t.id, { verdict: 'request_changes', note: 'Every price needs its read date and the page it came from.', byAgentId: s.editor.id });
  const [l] = await s.memory.list(s.writer.id);
  assert.match(l.text, /^When doing work like "Write the pricing comparison": Every price needs its read date/);
  assert.equal(l.cause, 'review'); assert.equal(l.sourceKind, 'loop'); assert.equal(l.trusted, 1);
  assert.deepEqual(JSON.parse(l.evidence), [`task:${t.key}`]);
  assert.match(l.context, /sent back in review \(round 1\)/);
  assert.equal((await s.memory.list(s.editor.id)).length, 0, 'the reviewer is not taught its own note');
  await s.tasks.requestReview(s.orgId, t.id, { fromAgentId: s.writer.id });
  await s.tasks.review(s.orgId, t.id, { verdict: 'accept', byAgentId: s.editor.id });
  assert.equal((await s.memory.list(s.writer.id))[0].useCount, 2, 'the fix held: the lesson counts again');
  assert.match(await s.journalOf(s.writer.id), new RegExp(`${t.key} accepted after 1 review round: Write the pricing comparison`));
  // switched off: no capture
  await s.org.setTunable(s.orgId, 'memory.captureTriggers', 0, { actor: 'user' });
  const t2 = await s.tasks.create(s.orgId, { title: 'Another', assigneeAgentId: s.editor.id, reviewerAgentId: s.writer.id });
  await s.tasks.requestReview(s.orgId, t2.id, { fromAgentId: s.editor.id });
  await s.tasks.review(s.orgId, t2.id, { verdict: 'request_changes', note: 'Shorter, please.', byAgentId: s.writer.id });
  assert.equal((await s.memory.list(s.editor.id)).length, 0);
});

test('capture: a breaker stop teaches a rule with the task as evidence and repeats count up; a rejected proposal with a note teaches who asked', async () => {
  const s = await orgSetup();
  const t = await s.tasks.create(s.orgId, { title: 'Re-verify prices', assigneeAgentId: s.writer.id });
  const emit = (ev: BreakerEvent) => (s.runtime as unknown as { emitBreaker(e: BreakerEvent): Promise<void> }).emitBreaker(ev);
  await emit({ orgId: s.orgId, agentId: s.writer.id, taskId: t.id, kind: 'loop', detail: 'Writer repeated the same tool call 3 times on "Re-verify prices"' });
  await emit({ orgId: s.orgId, agentId: s.writer.id, taskId: t.id, kind: 'loop', detail: 'again' });
  await emit({ orgId: s.orgId, agentId: s.writer.id, taskId: t.id, kind: 'budget_stop', detail: 'no headroom' });
  const rows = await s.memory.list(s.writer.id);
  assert.equal(rows.length, 1, 'the budget stop is the envelope, not a lesson');
  assert.equal(rows[0].cause, 'failure'); assert.equal(rows[0].useCount, 2);
  assert.match(rows[0].text, /change the approach .* or set the task blocked/);
  assert.deepEqual(JSON.parse(rows[0].evidence), [`task:${t.key}`]);
  // a CEO rejection with a note
  const card = await s.approvals.create(s.orgId, { kind: 'tune', payload: { key: 'intent.paceTolerance', value: 0.3, why: 'looser pace' }, requestedBy: `agent:${s.writer.id}` });
  await s.approvals.decide(s.orgId, card.id, 'reject', 'Not before we have two weeks of data.');
  const d = (await s.memory.list(s.writer.id)).find((r) => r.cause === 'decision')!;
  assert.match(d.text, /^Before proposing a tune like .*weigh the CEO's note on the last one: Not before we have two weeks of data\./);
  assert.deepEqual(JSON.parse(d.evidence), [`approval:${card.id}`]);
});

test('a lesson repeated past memory.guidanceRepeats is proposed as a charter_change card with the lessons as provenance — once, one pending at a time — and the decision closes it', async () => {
  const s = await orgSetup();
  await s.org.setTunable(s.orgId, 'memory.guidanceRepeats', 3, { actor: 'user' });
  const rule = 'Check the deliverable on disk before re-waking anyone.';
  await s.memory.record(s.writer.id, rule, { source: 'loop', evidence: ['task:WRI-1'] });
  await s.memory.record(s.writer.id, rule, { source: 'loop', evidence: ['task:WRI-2'] });
  await s.learning.idle();
  assert.equal((await s.approvals.pending(s.orgId)).filter((a) => a.kind === 'charter_change').length, 0, 'twice is not yet three times');
  const { lesson } = await s.memory.record(s.writer.id, rule, { source: 'loop', evidence: ['task:WRI-3'] });
  await s.learning.idle();
  const cards = (await s.approvals.pending(s.orgId)).filter((a) => a.kind === 'charter_change');
  assert.equal(cards.length, 1);
  const payload = JSON.parse(cards[0].payload) as { source: string; lessonIds: string[]; after: string; before: string; boundaryRule: string; agentId: string };
  assert.equal(payload.source, 'lessons'); assert.deepEqual(payload.lessonIds, [lesson.id]);
  assert.equal(payload.agentId, s.writer.id); assert.equal(payload.boundaryRule, 'guidance_proposal');
  assert.equal(payload.after, charterWithLessons('You write the newsletter.', [{ text: rule, useCount: 3, evidence: ['WRI-2', 'WRI-3'] }]));
  assert.equal((await s.agents.get(s.writer.id)).charter, 'You write the newsletter.', 'proposed, never written');
  const pending = await s.guidance.changes(s.writer.id, { status: 'pending' });
  assert.equal(pending.length, 1); assert.equal(pending[0].kind, 'charter'); assert.equal(pending[0].ref, cards[0].id);
  assert.deepEqual(JSON.parse(pending[0].lessonIds), [lesson.id], 'the provenance of the proposal');
  // once: learning it a fourth time does not raise a second card; another ripe lesson waits while one is pending
  await s.memory.record(s.writer.id, rule, { source: 'loop' });
  for (let i = 0; i < 3; i++) await s.memory.record(s.writer.id, 'Name the gap instead of inventing a figure.', { source: 'loop' });
  await s.learning.idle();
  assert.equal((await s.approvals.pending(s.orgId)).filter((a) => a.kind === 'charter_change').length, 1);
  // the CEO approves: the charter changes, the proposal closes
  await s.approvals.decide(s.orgId, cards[0].id, 'approve');
  assert.match((await s.agents.get(s.writer.id)).charter, /Learned in the work:\n- Check the deliverable on disk before re-waking anyone\. \(learned 3×/);
  assert.equal((await s.guidance.changes(s.writer.id, { kind: 'charter' }))[0].status, 'approved');
  // now the waiting lesson gets its own card
  const next = await s.learning.proposeGuidance(s.orgId, s.writer.id);
  assert.ok(next.charter);
  await s.approvals.decide(s.orgId, next.charter!, 'reject', 'Keep it in your own notes.');
  assert.equal((await s.guidance.changes(s.writer.id, { kind: 'charter' }))[0].status, 'rejected');
  const audit = await s.db.select().from(agentGuidanceChanges).where(eq(agentGuidanceChanges.agentId, s.writer.id));
  assert.equal(audit.filter((r) => r.kind === 'charter').length, 2);
});

test('a repeated lesson that names an active playbook becomes a revise task for the playbook, not a charter card', async () => {
  const s = await orgSetup();
  await s.org.setTunable(s.orgId, 'memory.guidanceRepeats', 2, { actor: 'user' });
  const w = await s.playbooks.write(s.orgId, { title: 'Publish an issue', body: '1. Link check.\n2. Schedule.', roles: [], why: 'we publish weekly', authorAgentId: s.editor.id });
  await s.playbooks.activate(s.orgId, w.playbook.id, 'user');
  for (let i = 0; i < 2; i++) await s.memory.record(s.writer.id, 'Publish an issue only after the sponsor has a week of notice.', { source: 'loop' });
  await s.learning.idle();
  assert.equal((await s.approvals.pending(s.orgId)).filter((a) => a.kind === 'charter_change').length, 0);
  const [p] = await s.guidance.changes(s.writer.id, { kind: 'playbook' });
  assert.equal(p.status, 'pending');
  const revise = await s.tasks.get(s.orgId, p.ref);
  assert.match(JSON.stringify(revise.brief), /sponsor has a week of notice/);
});

test('the boundary rows for guidance exist and are right; the threshold is a tunable derived from the profile', async () => {
  assert.equal(ruleFor({ kind: 'self_guidance' }).verdict, 'alone');
  assert.equal(ruleFor({ kind: 'guidance_proposal' }).verdict, 'propose');
  assert.equal(checkBoundary({ kind: 'guidance_proposal' }, 'agent:a').outcome, 'card');
  assert.equal(ruleFor({ kind: 'lesson_audience' }).verdict, 'never');
  assert.equal(checkBoundary({ kind: 'lesson_audience' }, 'agent:a').outcome, 'refuse');
  assert.equal(ruleFor({ kind: 'charter' }).verdict, 'experiment', 'the charter itself still changes only through an experiment or the CEO');
  // derived from the profile: rigour asks for more repeats, speed for fewer
  const rigour = { values: 'Rigour and evidence; never guess.', culture: '', mission: '' };
  const speed = { values: 'Move fast and ship.', culture: '', mission: '' };
  const d = (o: typeof rigour) => deriveMemoryTunables(diagnoseProfile(o));
  assert.equal(learningTunable({ tunables: '{}', ...rigour }, 'memory.guidanceRepeats', d), 4);
  assert.equal(learningTunable({ tunables: '{}', ...speed }, 'memory.guidanceRepeats', d), 2);
  assert.equal(learningTunable({ tunables: '{}', ...speed }, 'memory.lessonStaleDays', d), 21);
  assert.equal(learningTunable({ tunables: '{"memory.guidanceRepeats":7}', ...speed }, 'memory.guidanceRepeats', d), 7, 'a stored value wins');
  assert.ok(deriveOperatingSystem(rigour).tunables.some((t) => t.key === 'memory.guidanceRepeats' && t.value === 4), 'onboarding writes it');
});
