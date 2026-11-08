/** Automatic model selection by task complexity (docs/agent-types.md "Model
 *  selection"): the score and the tier rules (retries escalate, a record
 *  moves it, the agent's request is capped, a tight envelope downgrades,
 *  the risk floor holds, the CEO's routing pins), the provider choice
 *  (own type, preference order, health, another family for a verifier),
 *  the culture-derived tunables, the provider presets and the boot seed,
 *  the type-default repair (a DeepSeek type on a Claude model), and the
 *  end-to-end path: a chat turn and a channel turn of an auto agent resolve
 *  the same way and record their decision; an org task run records tier,
 *  model and reasons. No real provider is called. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { agentTypes, chatTurns, chatSessions, orgBudgets, orgRuns, workspaces as workspacesTable } from '../server/src/database/schema';
import { testDb, memStorage, skillsStub, mcpStub, pgliteQueryable } from './helpers';
import { runPgMigrations } from '../server/src/database/migrator';
import { repairTypeDefaults } from '../server/src/database/model-repair';
import { AgentTypesService } from '../server/src/agent-types/agent-types.service';
import { vendorTierModel } from '../server/src/agent-types/model-resolution';
import { PROVIDER_PRESETS } from '../server/src/agent-types/provider-presets';
import {
  chatSignals, chooseProvider, chooseTier, DEFAULT_POLICY, effectiveMode, parseWorkspaceSelection, riskReasonsOf, taskSignals,
  type ComplexitySignals, type ProviderCandidate,
} from '../server/src/agent-types/model-selection';
import { deriveModelTunables, MODEL_TUNABLES } from '../server/src/org/model-tunables';
import { deriveOperatingSystem } from '../server/src/org/chief-os';
import { priceFor } from '../server/src/ai/pricing';
import { contextWindowFor } from '../server/src/ai/context-windows';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import { TurnContextService } from '../server/src/chats/turn-context.service';
import { ModelSelectionService } from '../server/src/chats/model-selection.service';
import { ModelTierTools } from '../server/src/chats/model-tier.tools';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { TriggerBus } from '../server/src/chats/trigger-bus';
import { AgentsService } from '../server/src/agents/agents.service';
import { AgentMemoryService } from '../server/src/agents/agent-memory.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { OrgAuditService } from '../server/src/org/org-audit.service';
import { OrgService } from '../server/src/org/org.service';
import { OrgTasksService } from '../server/src/org/org-tasks.service';
import { OrgApprovalsService } from '../server/src/org/org-approvals.service';
import { OrgBriefService } from '../server/src/org/org-brief.service';
import { OrgRuntimeService } from '../server/src/org/org-runtime.service';
import { OrgAnnouncer } from '../server/src/org/org-announcer';
import { setAddressLookup } from '../server/src/common/url-guard';
import type { AiProvider, AiRequest, AiStreamEvent } from '../server/src/ai/ai-provider.interface';
import type { AiProviderFactory } from '../server/src/ai/providers.factory';

setAddressLookup(async () => [{ address: '93.184.216.34', family: 4 }]);

// ---- the score and the tier ----

const task = (over: Partial<ComplexitySignals> = {}): ComplexitySignals => ({ kind: 'task', taskClass: 'general', chars: 400, briefFields: 3, criteria: 1, ...over });

test('tier: simple triage is cheap, a long criteria-heavy synthesis is strong, ordinary work is standard — each with its reasons', () => {
  const triage = chooseTier(task({ taskClass: 'triage', chars: 90, criteria: 0 }));
  assert.equal(triage.tier, 'cheap');
  assert.ok(triage.reasons.some((r) => /class triage/.test(r)) && triage.reasons.some((r) => /short brief/.test(r)));
  const hard = chooseTier(task({ taskClass: 'synthesis', chars: 2400, briefFields: 4, criteria: 5, checks: 2, strictStandard: true }));
  assert.equal(hard.tier, 'strong');
  assert.ok(hard.score >= DEFAULT_POLICY.strongMinScore, `score ${hard.score}`);
  assert.equal(chooseTier(task({ criteria: 3 })).tier, 'standard');
});

test('tier: retries escalate, a strong record downgrades, a poor one escalates, a request is capped, a tight envelope downgrades', () => {
  const base = task({ criteria: 3 }); // standard
  assert.equal(chooseTier({ ...base, attempts: 1 }).tier, 'strong', 'a failed attempt escalates one tier');
  assert.equal(chooseTier({ ...task({ taskClass: 'triage', chars: 90, criteria: 0 }), reworkRounds: 2 }).tier, 'strong', 'two reworks: two tiers');
  assert.equal(chooseTier({ ...base, history: { rate: 0.95, runs: 8 } }).tier, 'cheap');
  assert.equal(chooseTier({ ...base, history: { rate: 0.95, runs: 2 } }).tier, 'standard', 'too few runs to judge');
  assert.equal(chooseTier({ ...base, history: { rate: 0.3, runs: 8 } }).tier, 'strong');
  const asked = chooseTier({ ...task({ taskClass: 'triage', chars: 90, criteria: 0 }), requested: { tier: 'strong', reason: 'hard proof' } });
  assert.equal(asked.tier, 'standard', 'capped at one tier by default');
  assert.ok(asked.reasons.some((r) => /asked for strong/.test(r) && /capped/.test(r)));
  assert.equal(chooseTier({ ...task({ taskClass: 'triage', chars: 90, criteria: 0 }), requested: { tier: 'strong', reason: 'x' } }, { ...DEFAULT_POLICY, requestCap: 2 }).tier, 'strong');
  assert.equal(chooseTier({ ...base, requested: { tier: 'strong', reason: 'x' } }, { ...DEFAULT_POLICY, requestCap: 0 }).tier, 'standard', 'requestCap 0: recorded, not applied');
  const tight = chooseTier({ ...base, budgetLeft: 0.1 });
  assert.equal(tight.tier, 'cheap');
  assert.ok(tight.reasons.some((r) => /envelope left/.test(r)));
  assert.equal(chooseTier({ ...base, budgetLeft: 0.5 }).tier, 'standard');
});

test('tier: risky work never runs cheap — not on a tight budget, a cheap request, a low ceiling or a CEO pin; floor and ceiling clamp the rest', () => {
  const risky = task({ taskClass: 'triage', chars: 90, criteria: 0, risky: true, riskReasons: ['production'] });
  assert.notEqual(chooseTier({ ...risky, budgetLeft: 0.01, requested: { tier: 'cheap', reason: 'save' } }).tier, 'cheap');
  assert.equal(chooseTier({ ...risky, routedTier: 'cheap' }).tier, 'standard');
  assert.equal(chooseTier(risky, { ...DEFAULT_POLICY, ceilingTier: 0 }).tier, 'standard');
  assert.equal(chooseTier(risky, { ...DEFAULT_POLICY, riskFloorTier: 2 }).tier, 'strong');
  assert.equal(chooseTier(task({ taskClass: 'triage', chars: 90, criteria: 0 }), { ...DEFAULT_POLICY, floorTier: 1 }).tier, 'standard');
  assert.equal(chooseTier(task({ taskClass: 'synthesis', chars: 2400, criteria: 6 }), { ...DEFAULT_POLICY, ceilingTier: 1 }).tier, 'standard');
  const routed = chooseTier({ ...task({ taskClass: 'synthesis', chars: 2400, criteria: 6 }), routedTier: 'cheap' });
  assert.equal(routed.tier, 'cheap', 'the CEO routing pin overrides the score');
  assert.ok(routed.reasons.some((r) => /CEO routes/.test(r)));
  assert.equal(chooseTier({ ...task(), declaredTier: 'strong' }).tier, 'strong', 'a declared step tier sets the base');
});

test('signals: a task row and a chat message become signals model-free', () => {
  const s = taskSignals({ class: 'research', title: 'Deploy the pricing page to production', brief: JSON.stringify({ outcome: 'Live page', context: 'x'.repeat(500), constraints: 'no downtime', done_when: '- page loads\n- prices match\n- analytics fire' }), checks: '[{"kind":"file_exists"}]', dependsOn: '["a","b"]', reviewRounds: 1, noProgressCount: 0, failRepeats: 2, modelTier: 'strong' });
  assert.equal(s.taskClass, 'research'); assert.equal(s.briefFields, 4); assert.equal(s.criteria, 3); assert.equal(s.checks, 1); assert.equal(s.dependencies, 2);
  assert.equal(s.attempts, 2); assert.equal(s.reworkRounds, 1); assert.equal(s.declaredTier, 'strong');
  assert.equal(s.risky, true);
  assert.ok(riskReasonsOf('refund the customer and email our customers').length >= 2);
  assert.equal(chooseTier(chatSignals('thanks!')).tier, 'cheap');
  const big = chatSignals(`Please analyze these three vendor contracts and draft a pricing comparison with a recommendation.\n${'Detail. '.repeat(120)}`);
  assert.ok(big.mentionsWork && big.risky);
  assert.equal(chooseTier(big).tier, 'strong');
});

test('mode: the agent\'s own, else its type\'s, else the workspace\'s, else fixed; the workspace JSON is parsed defensively', () => {
  assert.equal(effectiveMode('', '', ''), 'fixed');
  assert.equal(effectiveMode('', '', 'auto'), 'auto');
  assert.equal(effectiveMode('', 'fixed', 'auto'), 'fixed');
  assert.equal(effectiveMode('auto', 'fixed', ''), 'auto');
  assert.deepEqual(parseWorkspaceSelection('nope'), { order: [], crossProvider: true });
  assert.deepEqual(parseWorkspaceSelection('{"mode":"auto","order":["a","a",3],"crossProvider":false}'), { mode: 'auto', order: ['a'], crossProvider: false });
});

// ---- provider choice ----

const claude: ProviderCandidate = { id: 'tC', name: 'Claude', provider: 'anthropic', model: 'claude-sonnet-5-5', models: JSON.stringify(PROVIDER_PRESETS.anthropic.models), tierModels: JSON.stringify(PROVIDER_PRESETS.anthropic.tierModels), usable: true };
const openai: ProviderCandidate = { id: 'tO', name: 'OpenAI', provider: 'openai', model: 'gpt-6.1-sol', models: JSON.stringify(PROVIDER_PRESETS.openai.models), tierModels: JSON.stringify(PROVIDER_PRESETS.openai.tierModels), usable: true };
const price = (m: string) => { const p = priceFor(m); return p ? p.input + p.output : null; };

test('provider: the own type first; the owner\'s order wins; degraded providers drop out; a verifier avoids the maker\'s family; no cross-provider stays home', () => {
  assert.deepEqual(pick({ ownTypeId: 'tC' }), ['tC', 'claude-opus-5-5']);
  assert.deepEqual(pick({ ownTypeId: 'tC', order: ['tO', 'tC'] }), ['tO', 'gpt-6-astra']);
  assert.deepEqual(pick({ ownTypeId: 'tC', degraded: (p) => p === 'anthropic' }), ['tO', 'gpt-6-astra']);
  assert.deepEqual(pick({ ownTypeId: 'tC', avoidFamily: 'anthropic' }), ['tO', 'gpt-6-astra']);
  assert.deepEqual(pick({ ownTypeId: 'tC', avoidFamily: 'anthropic', crossProvider: false }), ['tC', 'claude-opus-5-5'], 'staying on the own type beats independence when crossing is off');
  assert.deepEqual(pick({ ownTypeId: 'tC', pinnedModel: 'claude-fable-5-1' }), ['tC', 'claude-fable-5-1'], 'a CEO-pinned tier model the type serves');
  assert.deepEqual(pick({ ownTypeId: null }), ['tC', 'claude-opus-5-5'], 'no own type: the cheaper strong model (Opus 5.5 is $4/$20, astra $10/$50)');
  assert.equal(chooseProvider([{ ...openai, usable: false }], { tier: 'cheap', ownTypeId: null, order: [], crossProvider: true }), null, 'no usable type');
  function pick(o: { ownTypeId: string | null; order?: string[]; degraded?: (p: string) => boolean; avoidFamily?: string; crossProvider?: boolean; pinnedModel?: string }) {
    const r = chooseProvider([claude, openai], { tier: 'strong', ownTypeId: o.ownTypeId, order: o.order ?? [], crossProvider: o.crossProvider ?? true, degraded: o.degraded, avoidFamily: o.avoidFamily, price, pinnedModel: o.pinnedModel });
    return r ? [r.type.id, r.model] : null;
  }
});

// ---- tunables from culture ----

test('tunables: derived from values and culture, inside their bounds — rigour escalates sooner, frugality downgrades sooner; the operating system carries them', () => {
  const rigor = Object.fromEntries(deriveModelTunables({ stage: 'growth', cultureType: 'hierarchy', speed: false, rigor: true, values: [] }).map((t) => [t.key, t.value]));
  const frugal = Object.fromEntries(deriveModelTunables({ stage: 'growth', cultureType: 'market', speed: true, rigor: false, values: ['Frugality', 'Customers first'] }).map((t) => [t.key, t.value]));
  assert.ok(rigor['model.strongMinScore'] < frugal['model.strongMinScore']);
  assert.ok(rigor['model.cheapMaxScore'] < frugal['model.cheapMaxScore']);
  assert.ok(rigor['model.riskFloorTier'] > frugal['model.riskFloorTier']);
  assert.ok(frugal['model.budgetTightPct'] > rigor['model.budgetTightPct']);
  for (const set of [rigor, frugal]) for (const [k, v] of Object.entries(set)) assert.ok(v >= MODEL_TUNABLES[k].min && v <= MODEL_TUNABLES[k].max, `${k}=${v}`);
  const plan = deriveOperatingSystem({ name: 'Acme', mission: 'x', values: 'Rigour; correctness' } as never);
  assert.ok(plan.tunables.some((t) => t.key === 'model.strongMinScore'));
});

// ---- presets, ids, prices ----

test('presets: Claude and OpenAI tier maps on current ids; vendor guesses follow; prices and windows know them; old ids keep working', () => {
  assert.deepEqual(PROVIDER_PRESETS.anthropic.tierModels, { cheap: 'claude-haiku-5-5', standard: 'claude-sonnet-5-5', strong: 'claude-opus-5-5' });
  assert.deepEqual(PROVIDER_PRESETS.openai.tierModels, { cheap: 'gpt-6-luna', standard: 'gpt-6.1-sol', strong: 'gpt-6-astra' });
  assert.equal(PROVIDER_PRESETS.deepseek.model, 'deepseek-flash');
  assert.equal(vendorTierModel('openai', 'strong'), 'gpt-6-astra');
  assert.deepEqual(priceFor('claude-opus-5-5'), { input: 4, output: 20 });
  assert.deepEqual(priceFor('claude-haiku-5-5'), { input: 0.1, output: 0.5 });
  assert.deepEqual(priceFor('gpt-6.1-sol'), { input: 2, output: 10 });
  assert.deepEqual(priceFor('claude-sonnet-4-5'), { input: 3, output: 15 }, 'older ids stay priced');
  assert.equal(contextWindowFor('claude-sonnet-5-5'), 1_000_000);
  assert.equal(contextWindowFor('claude-sonnet-4-5'), 200_000);
  for (const p of Object.values(PROVIDER_PRESETS)) for (const m of Object.values(p.tierModels)) assert.ok(p.models.includes(m), `${p.provider}: ${m} on its list`);
});

test('seed and quick add: env keys create Claude and OpenAI types with tier maps once; the key is sealed, never returned; quick add from a preset', async () => {
  const db = await testDb();
  const types = new AgentTypesService(db);
  assert.deepEqual(await types.seedDefaults({ ANTHROPIC_API_KEY: 'sk-test-a', OPENAI_API_KEY: 'sk-test-o' }), ['anthropic', 'openai']);
  assert.deepEqual(await types.seedDefaults({ ANTHROPIC_API_KEY: 'sk-test-a', OPENAI_API_KEY: 'sk-test-o' }), [], 'idempotent');
  const list = await types.list();
  const c = list.find((t) => t.provider === 'anthropic')!;
  assert.equal(c.name, 'Claude'); assert.equal(c.model, 'claude-sonnet-5-5'); assert.equal(c.hasApiKey, true);
  assert.equal(JSON.parse(c.tierModels).strong, 'claude-opus-5-5');
  assert.ok(!('apiKey' in c));
  const raw = (await db.select().from(agentTypes).where(eq(agentTypes.id, c.id)))[0];
  assert.notEqual(raw.apiKey, 'sk-test-a', 'sealed at rest');
  const ds = await types.createFromPreset('deepseek');
  assert.equal(ds.model, 'deepseek-flash');
  const presets = await types.presets();
  assert.deepEqual(presets.filter((p) => p.default).map((p) => p.provider), ['anthropic', 'openai']);
  assert.ok(presets.every((p) => !('env' in p) || p.env === undefined));
});

test('type-default repair: a DeepSeek type left on claude-sonnet-4-5 moves to deepseek-flash; placeable, matching and custom types are left alone; idempotent', async () => {
  const pg = new PGlite();
  const q = pgliteQueryable(pg);
  await runPgMigrations(q, { log: () => {} });
  const now = new Date().toISOString();
  await q.query(`INSERT INTO agent_types ("id","name","provider","model","models","baseUrl","apiKey","persona","enabled","createdAt") VALUES
    ('tDS','DeepSeek','deepseek','claude-sonnet-4-5','[]',null,null,'',1,$1),
    ('tDS2','DS via openai','openai','claude-sonnet-4-5','["deepseek-v4-pro","claude-sonnet-4-5"]','https://api.deepseek.com/v1',null,'',1,$1),
    ('tC','Claude','anthropic','claude-sonnet-5-5','[]',null,null,'',1,$1),
    ('tX','Gateway','custom','claude-sonnet-4-5','[]','https://llm.example.com/v1',null,'',1,$1)`, [now]);
  assert.equal(await repairTypeDefaults(q), 2);
  const rows = (await q.query(`SELECT "id","model" FROM agent_types ORDER BY "id"`)).rows as Array<{ id: string; model: string }>;
  assert.deepEqual(rows.map((r) => [r.id, r.model]), [['tC', 'claude-sonnet-5-5'], ['tDS', 'deepseek-flash'], ['tDS2', 'deepseek-v4-pro'], ['tX', 'claude-sonnet-4-5']]);
  assert.equal(await repairTypeDefaults(q), 0);
  await pg.close();
});

// ---- end to end ----

class RecordingProvider implements AiProvider {
  readonly name = 'anthropic';
  readonly requests: AiRequest[] = [];
  async *stream(req: AiRequest): AsyncGenerator<AiStreamEvent> {
    this.requests.push(req);
    yield { type: 'answer', text: 'ok' };
    yield { type: 'done' };
  }
}

async function stack() {
  const db = await testDb();
  const { stub } = memStorage();
  const bus = new TriggerBus();
  const agents = new AgentsService(db, stub, bus);
  const types = new AgentTypesService(db);
  const workspaces = new WorkspacesService(db, stub);
  const memory = new AgentMemoryService(db, stub);
  const provider = new RecordingProvider();
  const resolved: string[] = [];
  const factory = { resolve: (name: string) => { resolved.push(name); return provider; }, defaultBaseUrl: () => undefined } as unknown as AiProviderFactory;
  const cfg = { get: (k: string) => (k === 'maxToolRounds' ? 24 : k === 'companiesEnabled' ? true : k === 'loopsEnabled' ? false : undefined) } as unknown as ConfigService;
  const selection = new ModelSelectionService(db, agents, cfg);
  const context = new TurnContextService(factory, types, agents, memory, workspaces, cfg, undefined, undefined, undefined, undefined, selection);
  const repo = new ChatsRepository(db);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), context, skillsStub(), stub, mcpStub(), agents, workspaces);
  new ModelTierTools(selection, agents, turns);
  const ws = (await workspaces.list())[0];
  const c = await types.create({ name: 'Claude', provider: 'anthropic', model: PROVIDER_PRESETS.anthropic.model, models: PROVIDER_PRESETS.anthropic.models, tierModels: PROVIDER_PRESETS.anthropic.tierModels, apiKey: 'sk-test-c' });
  const o = await types.create({ name: 'OpenAI', provider: 'openai', model: PROVIDER_PRESETS.openai.model, models: PROVIDER_PRESETS.openai.models, tierModels: PROVIDER_PRESETS.openai.tierModels, apiKey: 'sk-test-o' });
  return { db, stub, bus, agents, types, workspaces, provider, resolved, cfg, selection, context, repo, turns, ws, claude: c, openai: o };
}

async function run(s: Awaited<ReturnType<typeof stack>>, sessionId: string, text: string) {
  for await (const ev of s.turns.run(sessionId, { text })) void ev;
  const turns = await s.db.select().from(chatTurns).where(eq(chatTurns.sessionId, sessionId));
  return turns.sort((a, b) => b.seq - a.seq)[0];
}

test('chat parity: an auto agent resolves the same way in a private chat and a channel session; the decision is on the turn; a hand-picked chat model and a fixed agent are left alone', async () => {
  const s = await stack();
  const a = await s.agents.create({ name: 'Ada', workspaceId: s.ws.id, agentTypeId: s.claude.id });
  await s.agents.update(a.id, { modelMode: 'auto' });
  const dm = await s.repo.createSession({ workspaceId: s.ws.id, agentId: a.id, name: 'chat' });
  const channel = await s.repo.createSession({ workspaceId: s.ws.id, agentId: a.id, name: '#general · Ada', kind: 'work' });
  const t1 = await run(s, dm.id, 'thanks!');
  const t2 = await run(s, channel.id, 'thanks!');
  assert.equal(t1.model, 'claude-haiku-5-5');
  assert.equal(t2.model, t1.model, 'channel = private chat');
  const d = JSON.parse(t1.modelDecision) as { tier: string; reasons: string[]; agentTypeId: string };
  assert.equal(d.tier, 'cheap'); assert.equal(d.agentTypeId, s.claude.id);
  assert.ok(d.reasons.length > 0);
  const hard = await run(s, dm.id, `Please analyze our three vendor contracts and draft a pricing recommendation for the board.\n${'Context. '.repeat(200)}`);
  assert.equal(hard.model, 'claude-opus-5-5');
  assert.equal(s.provider.requests.at(-1)?.model, 'claude-opus-5-5', 'the provider got the chosen model');

  // the agent asks for a cheaper tier: applied to the next turn, capped and recorded
  const tools = await s.turns.offeredTools(dm);
  assert.ok(tools.specs.some((t) => t.name === 'request_model_tier'), 'offered to auto agents');
  s.selection.requestTier(dm.id, 'cheap', 'routine follow-up');
  const asked = await run(s, dm.id, `Please analyze our three vendor contracts and draft a pricing recommendation for the board.\n${'Context. '.repeat(200)}`);
  assert.equal(asked.model, 'claude-sonnet-5-5', 'one tier down (requestCap 1), not below the risk floor');
  assert.ok((JSON.parse(asked.modelDecision) as { reasons: string[] }).reasons.some((r) => /asked for cheap/.test(r)));

  // a model picked by hand in the chat header wins for that chat
  await s.db.update(chatSessions).set({ model: 'claude-opus-4-8' }).where(eq(chatSessions.id, dm.id));
  const picked = await run(s, dm.id, 'thanks!');
  assert.equal(picked.model, 'claude-opus-4-8'); assert.equal(picked.modelDecision, '');

  // a fixed agent: no decision, no tool
  const b = await s.agents.create({ name: 'Bo', workspaceId: s.ws.id, agentTypeId: s.claude.id });
  const bs = await s.repo.createSession({ workspaceId: s.ws.id, agentId: b.id, name: 'chat' });
  const fixed = await run(s, bs.id, 'thanks!');
  assert.equal(fixed.modelDecision, '');
  assert.ok(!(await s.turns.offeredTools(bs)).specs.some((t) => t.name === 'request_model_tier'));

  // the workspace default turns Bo auto; the owner's order sends it to OpenAI
  await s.db.update(workspacesTable).set({ modelSelection: JSON.stringify({ mode: 'auto', order: [s.openai.id, s.claude.id] }) }).where(eq(workspacesTable.id, s.ws.id));
  const viaWs = await run(s, bs.id, 'thanks!');
  assert.equal(viaWs.model, 'gpt-6-luna');
  assert.equal(s.resolved.at(-1), 'openai', 'the turn ran on the OpenAI adapter');
  // agents stay in their workspace: another workspace's setting does not reach them
  const ws2 = await s.workspaces.create({ name: 'Other' });
  const c2 = await s.agents.create({ name: 'Cy', workspaceId: ws2.id, agentTypeId: s.claude.id });
  const cs = await s.repo.createSession({ workspaceId: ws2.id, agentId: c2.id, name: 'chat' });
  assert.equal((await run(s, cs.id, 'thanks!')).modelDecision, '');
});

test('org run: an auto member\'s task run records tier, model and reasons on the run and the turn; a retry escalates; the envelope downgrades', async () => {
  const s = await stack();
  const audit = new OrgAuditService(s.db);
  const org = new OrgService(s.db, s.agents, audit, s.bus);
  const tasks = new OrgTasksService(s.db, org, audit, s.bus);
  const approvals = new OrgApprovalsService(s.db, org, tasks, s.agents, audit, undefined, s.bus);
  const brief = new OrgBriefService(s.db, org, tasks, approvals, audit, s.agents, s.workspaces);
  const runtime = new OrgRuntimeService(s.db, org, tasks, approvals, audit, brief, s.turns, s.repo, s.agents, s.workspaces, s.cfg, new OrgAnnouncer(), s.bus,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, s.selection);
  const o = await org.create({ workspaceId: s.ws.id, name: 'Acme', mission: 'Ship.', chief: { name: 'Chief', charter: 'You run Acme.' } });
  const writer = await s.agents.create({ name: 'Writer', workspaceId: s.ws.id, agentTypeId: s.claude.id });
  await s.agents.update(writer.id, { modelMode: 'auto' });
  await org.addMember(o.id, { agentId: writer.id, title: 'Writer', reportsToAgentId: o.chiefOfStaffAgentId });
  const t = await tasks.create(o.id, { title: 'Sort the inbox', class: 'triage', brief: { outcome: 'Sorted', done_when: 'sorted' }, assigneeAgentId: writer.id });
  runtime.cancelWakesFor(o.id, writer.id);
  assert.equal(await runtime.runTask(o.id, t.id, writer.id, 'manual'), 'ran');
  const r1 = (await s.db.select().from(orgRuns).where(eq(orgRuns.taskId, t.id)))[0];
  assert.equal(r1.tier, 'cheap');
  const d1 = JSON.parse(r1.modelDecision) as { model: string; reasons: string[]; kind: string };
  assert.equal(d1.model, 'claude-haiku-5-5'); assert.equal(d1.kind, 'task');
  assert.equal(s.provider.requests.at(-1)?.model, 'claude-haiku-5-5');
  const turn = (await s.db.select().from(chatTurns).where(eq(chatTurns.sessionId, r1.sessionId!)))[0];
  assert.equal(JSON.parse(turn.modelDecision).tier, 'cheap', 'the work log sees the decision');
  const session = await s.repo.getSession(r1.sessionId!);
  assert.equal(session!.model, '', 'the per-task session is not pinned');

  // no progress twice: the next run escalates
  await tasks.update(o.id, t.id, { noProgressCount: 2 }, 'system');
  runtime.cancelWakesFor(o.id, writer.id);
  assert.equal(await runtime.runTask(o.id, t.id, writer.id, 'manual'), 'ran');
  const runs = (await s.db.select().from(orgRuns).where(eq(orgRuns.taskId, t.id))).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  assert.equal(runs.at(-1)!.tier, 'strong');

  // outcomes per tier for tuning
  const out = await s.selection.outcomes(s.ws.id);
  assert.equal(out.tiers.find((x) => x.tier === 'cheap')!.runs, 1);
  assert.ok(out.tiers.find((x) => x.tier === 'cheap')!.turns >= 1);

  // a tight agent envelope downgrades a standard task
  const t2 = await tasks.create(o.id, { title: 'Write the update', class: 'general', brief: { outcome: 'An update', context: 'c'.repeat(400), done_when: '- one\n- two\n- three' }, assigneeAgentId: writer.id });
  await org.setBudget(o.id, { scope: 'agent', refId: writer.id, monthlyUsd: 100 });
  await s.db.update(orgBudgets).set({ spentUsd: 95, month: new Date().toISOString().slice(0, 7) }).where(eq(orgBudgets.refId, writer.id));
  runtime.cancelWakesFor(o.id, writer.id);
  assert.equal(await runtime.runTask(o.id, t2.id, writer.id, 'manual'), 'ran');
  const r2 = (await s.db.select().from(orgRuns).where(eq(orgRuns.taskId, t2.id)))[0];
  assert.equal(r2.tier, 'cheap');
  assert.ok((JSON.parse(r2.modelDecision) as { reasons: string[] }).reasons.some((x) => /envelope left/.test(x)));
});
