/** Agent types and their models (docs/agent-types.md): discovery per type
 *  (mocked fetch; a failure keeps the list), tier/default resolution on the
 *  type every creation path runs on (no claude-* on a DeepSeek type),
 *  validation refusals, the turn-loop self-heal on a provider's model
 *  rejection, and the idempotent boot repair. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { agents as agentsTable, agentTypes, appSettings, chatSessions } from '../server/src/database/schema';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub, ScriptedProvider, pgliteQueryable } from './helpers';
import { runPgMigrations } from '../server/src/database/migrator';
import { repairAgentModels } from '../server/src/database/model-repair';
import { AgentTypesService, parseModelList, modelsEndpoint } from '../server/src/agent-types/agent-types.service';
import { isKnownModel, isModelRejection, pickModel, tierModelForType, typeFamily } from '../server/src/agent-types/model-resolution';
import { tierModel } from '../server/src/org/org-routing';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import { TurnContextService } from '../server/src/chats/turn-context.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { TriggerBus } from '../server/src/chats/trigger-bus';
import { AgentsService } from '../server/src/agents/agents.service';
import { AgentMemoryService } from '../server/src/agents/agent-memory.service';
import { SkillsService } from '../server/src/skills/skills.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { PortabilityService } from '../server/src/portability/portability.service';
import { RegistryService } from '../server/src/registry/registry.service';
import { SettingsService } from '../server/src/settings/settings.module';
import { MarketService } from '../server/src/market/market.service';
import { OrgAuditService } from '../server/src/org/org-audit.service';
import { OrgService } from '../server/src/org/org.service';
import { OrgTasksService } from '../server/src/org/org-tasks.service';
import { OrgApprovalsService } from '../server/src/org/org-approvals.service';
import { OrgBriefService } from '../server/src/org/org-brief.service';
import { OrgRuntimeService } from '../server/src/org/org-runtime.service';
import { OrgModeService } from '../server/src/org/org-mode.service';
import { OrgAnnouncer } from '../server/src/org/org-announcer';
import { OrgUnitsService } from '../server/src/org/org-units.service';
import { OrgIntentService } from '../server/src/org/org-intent.service';
import { OrgMeetingsService } from '../server/src/org/org-meetings.service';
import { OrgBootstrapService } from '../server/src/org/org-bootstrap.service';
import { OrgRolesService } from '../server/src/org/org-roles.service';
import { OrgBlueprintsService } from '../server/src/org/org-blueprints.service';
import { OrgLayoutService } from '../server/src/org/org-layout.service';
import { WorkspaceFs } from '../server/src/files/workspace-fs.service';
import { BLUEPRINT_FORMAT, type Blueprint } from '../server/src/org/blueprints/format';
import { setAddressLookup } from '../server/src/common/url-guard';
import type { AiProvider, AiRequest, AiStreamEvent } from '../server/src/ai/ai-provider.interface';
import type { AiProviderFactory } from '../server/src/ai/providers.factory';

setAddressLookup(async () => [{ address: '93.184.216.34', family: 4 }]);

const DEEPSEEK_ERR = 'openai-compatible 400: "The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed claude-opus-4-5."';

/** A DeepSeek-backed OpenAI-compatible type, made the app default. */
async function deepseekType(db: Awaited<ReturnType<typeof testDb>>, over: Partial<typeof agentTypes.$inferInsert> = {}) {
  const row = { id: 'tDS', name: 'DeepSeek', provider: 'custom', model: 'deepseek-flash', models: JSON.stringify(['deepseek-flash', 'deepseek-v4-pro']), baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-ds', persona: '', enabled: 1, createdAt: new Date().toISOString(), ...over };
  await db.insert(agentTypes).values(row as never);
  await db.insert(appSettings).values({ key: 'defaultAgentTypeId', value: row.id });
  return row;
}

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return handler(String(url), init ?? {});
  }) as unknown as typeof fetch;
  return { fn, calls };
}

// ---- pure resolution ----

test('isKnownModel / pickModel: a list is authoritative; without one the vendor family decides; tiers resolve on the type', () => {
  const ds = { name: 'DeepSeek', provider: 'custom', model: 'deepseek-flash', models: '["deepseek-flash","deepseek-v4-pro"]', baseUrl: 'https://api.deepseek.com/v1', tierModels: '{}' };
  assert.equal(typeFamily(ds), 'deepseek', 'custom endpoint placed by its host');
  assert.equal(isKnownModel(ds, 'deepseek-v4-pro'), true);
  assert.equal(isKnownModel(ds, 'claude-opus-4-5'), false);
  assert.equal(isKnownModel(ds, 'deepseek-reasoner'), false, 'a listed type knows only its list');
  assert.equal(pickModel(ds, { tier: 'strong' }), 'deepseek-v4-pro', 'the vendor guess is used when it is on the list');
  assert.equal(pickModel(ds, { tier: 'cheap' }), 'deepseek-flash');
  assert.equal(pickModel(ds, { model: 'claude-opus-4-5', tier: 'strong' }), 'deepseek-v4-pro', 'an unserved explicit model falls through to the tier');
  assert.equal(pickModel(ds, { model: 'my-finetune', custom: true }), 'my-finetune', 'custom is the owner\'s escape hatch');
  assert.equal(pickModel({ ...ds, tierModels: '{"strong":"deepseek-flash"}' }, { tier: 'strong' }), 'deepseek-flash', 'a designated tier model wins');
  const gw = { name: 'Gateway', provider: 'custom', model: 'llama-70b', models: '["llama-70b","llama-8b"]', baseUrl: 'https://gw.example.com/v1' };
  assert.equal(tierModelForType(gw, 'strong'), 'llama-70b', 'no guess on an unplaceable gateway: the default');
  // no list: by family
  const bare = { name: 'DS', provider: 'deepseek', model: 'deepseek-flash', models: '[]' };
  assert.equal(isKnownModel(bare, 'claude-opus-4-5'), false);
  assert.equal(isKnownModel(bare, 'deepseek-whatever'), true);
  assert.equal(isKnownModel(bare, 'some-unknown-model'), true, 'benefit of the doubt for an unrecognisable id');
  assert.equal(isKnownModel({ name: 'Echo', provider: 'echo', model: 'echo', models: '[]' }, 'claude-opus-4-5'), true);
  // no type at all: the legacy vendor guess, current names
  assert.equal(pickModel(null, { tier: 'strong', provider: 'anthropic' }), 'claude-opus-5-5');
  assert.equal(pickModel(null, { tier: 'standard', provider: 'anthropic' }), '');
  // org routing with the type
  assert.equal(tierModel({ classes: {}, models: { strong: 'claude-opus-4-5' } }, 'strong', 'anthropic', '', undefined, ds), 'deepseek-v4-pro', 'a pinned tier model the type does not serve is skipped');
  assert.equal(tierModel({ classes: {}, models: {} }, 'standard', 'custom', 'deepseek-v4-pro', undefined, ds), 'deepseek-v4-pro');
});

test('isModelRejection is conservative: model-name 400/404s only', () => {
  assert.equal(isModelRejection(new Error(DEEPSEEK_ERR)), true);
  assert.equal(isModelRejection(new Error('anthropic 404: {"type":"error","error":{"type":"not_found_error","message":"model: claude-foo"}}')), false, 'ambiguous: not claimed');
  assert.equal(isModelRejection(new Error('openai-compatible 404: {"error":{"message":"The model `gpt-9` does not exist","code":"model_not_found"}}')), true);
  assert.equal(isModelRejection(new Error('anthropic 400: invalid model name')), true);
  assert.equal(isModelRejection(new Error('openai-compatible 401: invalid api key')), false);
  assert.equal(isModelRejection(new Error('openai-compatible 503: model overloaded')), false);
  assert.equal(isModelRejection(new Error('openai-compatible 400: maximum context length exceeded for model')), false);
  assert.equal(isModelRejection(new Error('fetch failed')), false);
});

// ---- discovery ----

test('discovery: GET {baseUrl}/models with the type key (to that endpoint only), cached on the type with modelsFetchedAt; a default not served moves; failure keeps the configured list', async () => {
  const db = await testDb();
  const types = new AgentTypesService(db);
  const t = await types.create({ name: 'DS', provider: 'custom', model: 'deepseek-chat', models: ['deepseek-chat'], baseUrl: 'https://api.deepseek.com/v1/', apiKey: 'sk-ds' });
  const ok = fakeFetch(() => new Response(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-flash' }] }), { status: 200 }));
  types.fetchFn = ok.fn;
  const before = await types.models(t.id);
  assert.deepEqual(before.models, ['deepseek-chat']);
  assert.equal(before.fetchedAt, null);
  const r = await types.refreshModels(t.id);
  assert.equal(ok.calls.length, 1);
  assert.equal(ok.calls[0].url, 'https://api.deepseek.com/v1/models');
  assert.equal(ok.calls[0].headers.authorization, 'Bearer sk-ds');
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, ['deepseek-flash', 'deepseek-v4-pro']);
  assert.deepEqual(r.defaultChanged, { from: 'deepseek-chat', to: 'deepseek-flash' });
  const after = await types.models(t.id);
  assert.ok(after.fetchedAt);
  assert.equal(after.default, 'deepseek-flash');
  assert.ok(!JSON.stringify(after).includes('sk-ds'), 'the key never leaves through the API');

  // tier picks: must be on the list
  await types.update(t.id, { tierModels: { strong: 'deepseek-v4-pro' } });
  assert.deepEqual((await types.models(t.id)).tierModels, { strong: 'deepseek-v4-pro' });
  await assert.rejects(types.update(t.id, { tierModels: { cheap: 'claude-haiku-5-5' } }), BadRequestException);

  // failure: nothing changes
  types.fetchFn = fakeFetch(() => new Response('nope', { status: 500 })).fn;
  const failed = await types.refreshModels(t.id);
  assert.equal(failed.ok, false);
  assert.match(String(failed.error), /500/);
  assert.deepEqual(failed.models, ['deepseek-flash', 'deepseek-v4-pro']);
  types.fetchFn = (async () => { throw new Error('getaddrinfo ENOTFOUND'); }) as unknown as typeof fetch;
  assert.equal((await types.refreshModels(t.id)).ok, false);
  assert.deepEqual((await types.models(t.id)).models, ['deepseek-flash', 'deepseek-v4-pro'], 'the cached list stays');

  // anthropic shape + endpoint
  const a = await types.create({ name: 'Claude', provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'sk-ant' });
  const af = fakeFetch(() => new Response(JSON.stringify({ data: [{ id: 'claude-opus-5-5', type: 'model' }, { id: 'claude-sonnet-5-5', type: 'model' }], has_more: false }), { status: 200 }));
  types.fetchFn = af.fn;
  assert.equal((await types.refreshModels(a.id)).ok, true);
  assert.equal(af.calls[0].url, 'https://api.anthropic.com/v1/models?limit=1000');
  assert.equal(af.calls[0].headers['x-api-key'], 'sk-ant');
  assert.equal(af.calls[0].headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(parseModelList({ models: [{ name: 'models/gemini-2.5-pro' }] }), ['gemini-2.5-pro']);
  assert.equal(modelsEndpoint({ provider: 'echo', baseUrl: null }), null);
  assert.equal(modelsEndpoint({ provider: 'deepseek', baseUrl: null })?.url, 'https://api.deepseek.com/v1/models');
});

// ---- creation paths ----

async function orgSetup() {
  const db = await testDb();
  const { stub } = memStorage();
  const bus = new TriggerBus();
  const agents = new AgentsService(db, stub, bus);
  const memory = new AgentMemoryService(db, stub);
  const workspaces = new WorkspacesService(db, stub);
  const skills = new SkillsService(db);
  const portability = new PortabilityService(agents, memory, skills, workspaces);
  const registry = new RegistryService(db, agents, skills, portability);
  const settings = new SettingsService(db);
  const repo = new ChatsRepository(db);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(new ScriptedProvider([])), skillsStub(), stub, mcpStub(), agents, workspaces);
  const config = { get: (k: string) => (k === 'companiesEnabled' ? true : k === 'loopsEnabled' ? false : undefined) } as unknown as ConfigService;
  const announcer = new OrgAnnouncer();
  const audit = new OrgAuditService(db);
  const org = new OrgService(db, agents, audit, bus);
  const units = new OrgUnitsService(db, org, agents, audit, announcer);
  const intent = new OrgIntentService(db, org, units, agents, audit, bus);
  const tasks = new OrgTasksService(db, org, audit, bus, units, agents);
  const approvals = new OrgApprovalsService(db, org, tasks, agents, audit, skills, bus);
  const meetings = new OrgMeetingsService(db, org, units, tasks, audit, agents, workspaces, approvals);
  const brief = new OrgBriefService(db, org, tasks, approvals, audit, agents, workspaces, undefined, undefined, intent, meetings);
  const runtime = new OrgRuntimeService(db, org, tasks, approvals, audit, brief, turns, repo, agents, workspaces, config, announcer, bus, undefined, undefined, undefined, undefined, undefined, units, undefined, undefined, intent);
  runtime.debounceMs = 15;
  const mode = new OrgModeService(org, workspaces, agents, runtime, approvals, audit, announcer);
  const roles = new OrgRolesService();
  const blueprints = new OrgBlueprintsService(db, org, mode, intent, approvals, units, agents, skills, workspaces, audit, settings, registry);
  const fs = new WorkspaceFs(stub, db);
  const bootstrap = new OrgBootstrapService(org, workspaces, agents, mode, approvals, runtime, audit, intent, units, meetings, roles, skills, stub, fs, new OrgLayoutService(db, fs));
  const market = new MarketService(agents, skills);
  const ws = (await workspaces.list())[0];
  return { db, agents, workspaces, skills, portability, repo, org, approvals, runtime, mode, blueprints, bootstrap, market, ws };
}

const noClaude = (model: string, where: string) => {
  assert.ok(model, `${where}: a model is stored`);
  assert.doesNotMatch(model, /claude/, `${where}: no claude-* on a DeepSeek type (got ${model})`);
  assert.ok(['deepseek-flash', 'deepseek-v4-pro'].includes(model), `${where}: one of the type's models (got ${model})`);
};

test('every creation path resolves the DeepSeek type and one of its models — manual, market, role hire, onboarding chief, org.create chief, blueprint import, portability import', async () => {
  const s = await orgSetup();
  await deepseekType(s.db);

  // manual New agent: no model → the type default; agentTypeId stored
  const manual = await s.agents.create({ name: 'Manual', workspaceId: s.ws.id });
  assert.equal(manual.agentTypeId, 'tDS'); assert.equal(manual.provider, 'custom'); assert.equal(manual.model, 'deepseek-flash');
  // the provider default 'anthropic' a caller may pass does not drag in a claude model
  const legacy = await s.agents.create({ name: 'Legacy', provider: 'anthropic' });
  noClaude(legacy.model, 'provider=anthropic caller'); assert.equal(legacy.agentTypeId, 'tDS');

  // market hire
  const items = await s.market.list(s.ws.id);
  const hired = await s.market.hire(items[0].id, s.ws.id);
  noClaude(hired.agent.model, 'market hire'); assert.equal(hired.agent.agentTypeId, 'tDS');

  // onboarding bootstrap: the chief
  const boot = await s.bootstrap.bootstrap(s.ws.id, { mode: 'autonomous', chief: { create: { name: 'Nova' } }, monthlyUsd: 40, agentCap: 10 } as never);
  const chief = await s.agents.get(boot.chief.agentId);
  noClaude(chief.model, 'onboarding chief'); assert.equal(chief.agentTypeId, 'tDS');

  // org hire: a strong role (engineer) through org_hire_agent → applyHire
  const orgId = (await s.org.byWorkspace(s.ws.id))!.id;
  const session = await s.repo.createSession({ workspaceId: s.ws.id, agentId: chief.id, name: 'chief chat' });
  const prepared = await s.approvals.prepareHire(orgId, { templateOrPack: 'role:engineer', requestedBy: 'chief' });
  assert.equal(prepared.modelTier, 'strong'); assert.equal(prepared.model, 'deepseek-v4-pro', 'the card shows the strong tier on the type');
  const out = await s.runtime.execute(session, 'org_hire_agent', { templateOrPack: 'role:engineer', title: 'Engineer', why: 'builder' });
  assert.match(out, /^Hired Engineer/);
  const eng = (await s.agents.list()).find((a) => a.name === 'Engineer')!;
  assert.equal(eng.model, 'deepseek-v4-pro'); assert.equal(eng.agentTypeId, 'tDS');
  // an old card carrying a stale vendor model still applies, on the type's tier model
  const stale = await s.approvals.applyHire(orgId, { ...prepared, name: 'Old card', model: 'claude-opus-4-5', reportsToAgentId: chief.id }, 'user', 'user');
  assert.equal((await s.agents.get(stale.agentId)).model, 'deepseek-v4-pro');
  // the chief asking for an unserved model is refused with the list
  await assert.rejects(s.approvals.prepareHire(orgId, { templateOrPack: 'role:engineer', model: 'claude-opus-4-5', reportsToAgentId: eng.id, requestedBy: 'chief' }), /not served by agent type "DeepSeek" — available: deepseek-flash, deepseek-v4-pro/);

  // portability import (an export from an Anthropic workspace)
  const imported = await s.portability.importAgent({ name: 'Imported', charter: 'x', provider: 'anthropic', model: 'claude-opus-4-5' }, { workspaceId: s.ws.id });
  noClaude(imported.agent.model, 'portability import');

  // org.create chief in another workspace, explicit unserved model refused, none → default
  const ws2 = await s.workspaces.create({ name: 'Second' } as never);
  await assert.rejects(s.org.create({ workspaceId: ws2.id, name: 'Co2', chief: { name: 'C2', model: 'claude-opus-4-5' } }), BadRequestException);
  const o2 = await s.org.create({ workspaceId: ws2.id, name: 'Co2', chief: { name: 'C2' } });
  noClaude((await s.agents.get(o2.chiefOfStaffAgentId!)).model, 'org.create chief');
});

test('blueprint import: the plan and the created chief and roles use the type\'s tier models', async () => {
  const s = await orgSetup();
  await deepseekType(s.db);
  const bp: Blueprint = {
    format: BLUEPRINT_FORMAT, name: 'DS Co', description: 'A DeepSeek company.',
    profile: { values: '', culture: '', rules: '' },
    roles: [
      { roleId: 'chief-of-staff', title: 'Chief of staff', charter: 'You run DS Co.', reportsTo: null, scopes: ['tool:fs_read'], modelTier: 'strong', monthlyUsd: 0 },
      { roleId: 'researcher', title: 'Researcher', charter: 'You research.', reportsTo: 'Chief of staff', scopes: ['tool:fs_read'], modelTier: 'cheap', monthlyUsd: 5 },
      { roleId: 'engineer', title: 'Engineer', charter: 'You build.', reportsTo: 'Chief of staff', scopes: ['tool:fs_read'], modelTier: 'strong', monthlyUsd: 5 },
    ],
    tunables: {}, playbooks: [], budget: { monthlyUsd: 40 },
  } as unknown as Blueprint;
  const plan = await s.blueprints.importPlan(s.ws.id, bp, { mode: 'autonomous' });
  assert.equal(plan.chief.model, 'deepseek-v4-pro');
  assert.deepEqual(plan.hires.map((h) => h.model), ['deepseek-flash', 'deepseek-v4-pro']);
  await s.blueprints.import(s.ws.id, bp, { mode: 'autonomous' });
  const all = await s.agents.list({ workspaceId: s.ws.id });
  for (const a of all) { noClaude(a.model, `blueprint ${a.name}`); assert.equal(a.agentTypeId, 'tDS'); }
  assert.equal(all.find((a) => a.role === 'Engineer')?.model, 'deepseek-v4-pro');
});

test('validation: create and update refuse a model the type does not serve, naming the list; customModel lets the owner through; org_update_member refuses too', async () => {
  const s = await orgSetup();
  await deepseekType(s.db);
  await assert.rejects(s.agents.create({ name: 'X', workspaceId: s.ws.id, model: 'claude-opus-4-5' }), (e: Error) => e instanceof BadRequestException && /available: deepseek-flash, deepseek-v4-pro/.test(e.message));
  const a = await s.agents.create({ name: 'Y', workspaceId: s.ws.id, model: 'deepseek-v4-pro' });
  assert.equal(a.model, 'deepseek-v4-pro');
  await assert.rejects(s.agents.update(a.id, { model: 'gpt-5.1' }), /not served by agent type "DeepSeek"/);
  assert.equal((await s.agents.update(a.id, { model: 'deepseek-flash' })).model, 'deepseek-flash');
  assert.equal((await s.agents.update(a.id, { model: 'ds-preview-0601', customModel: true })).model, 'ds-preview-0601', 'custom model id');
  const c = await s.agents.create({ name: 'Z', workspaceId: s.ws.id, model: 'ds-preview-0601', customModel: true });
  assert.equal(c.model, 'ds-preview-0601');

  // org_update_member
  await s.bootstrap.bootstrap(s.ws.id, { mode: 'autonomous', chief: { agentId: a.id }, monthlyUsd: 40, agentCap: 10 } as never);
  const session = await s.repo.createSession({ workspaceId: s.ws.id, agentId: a.id, name: 'chief chat' });
  await assert.rejects(s.runtime.execute(session, 'org_update_member', { agent: 'Z', model: 'claude-opus-4-5', why: 'quality' }), /not served by agent type "DeepSeek" — available/);
});

// ---- self-heal ----

class ModelPickyProvider implements AiProvider {
  readonly name = 'openai-compatible';
  readonly requests: AiRequest[] = [];
  constructor(private readonly served: string[]) {}
  async *stream(req: AiRequest): AsyncGenerator<AiStreamEvent> {
    this.requests.push(req);
    if (!this.served.includes(req.model)) throw new Error(`openai-compatible 400: "The supported API model names are ${this.served.join(', ')}, but you passed ${req.model}."`);
    yield { type: 'answer', text: 'ok' };
    yield { type: 'done' };
  }
}

function contextFor(db: Awaited<ReturnType<typeof testDb>>, provider: AiProvider) {
  const { stub } = memStorage();
  const agents = new AgentsService(db, stub);
  const types = new AgentTypesService(db);
  const workspaces = new WorkspacesService(db, stub);
  const memory = new AgentMemoryService(db, stub);
  const factory = { resolve: () => provider, defaultBaseUrl: () => undefined } as unknown as AiProviderFactory;
  const cfg = { get: (k: string) => (k === 'maxToolRounds' ? 24 : undefined) } as unknown as ConfigService;
  const context = new TurnContextService(factory, types, agents, memory, workspaces, cfg);
  const repo = new ChatsRepository(db);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), context, skillsStub(), stub, mcpStub(), agents, workspaces);
  return { agents, types, workspaces, repo, turns };
}

test('self-heal: a provider rejecting the model retries the turn once on the type default, switches the agent (and its pinned chats), and leaves an inbox notice', async () => {
  const db = await testDb();
  await deepseekType(db);
  const provider = new ModelPickyProvider(['deepseek-flash', 'deepseek-v4-pro']);
  const s = contextFor(db, provider);
  const ws = (await s.workspaces.list())[0];
  const a = await s.agents.create({ name: 'Broken', workspaceId: ws.id });
  // the user's state: a claude model stored before this fix
  await db.update(agentsTable).set({ model: 'claude-opus-4-5' }).where(eq(agentsTable.id, a.id));
  const session = await s.repo.createSession({ workspaceId: ws.id, agentId: a.id, name: 'chat' });
  await db.update(chatSessions).set({ model: 'claude-opus-4-5' }).where(eq(chatSessions.id, session.id));

  const events: Array<{ type: string; message?: string }> = [];
  for await (const ev of s.turns.run(session.id, { text: 'hello' })) events.push(ev as { type: string });
  assert.deepEqual(provider.requests.map((r) => r.model), ['claude-opus-4-5', 'deepseek-flash'], 'one retry on the default');
  assert.ok(events.some((e) => e.type === 'answer'));
  assert.ok(!events.some((e) => e.type === 'error'));
  assert.equal((await s.agents.get(a.id)).model, 'deepseek-flash');
  assert.equal((await s.agents.get(a.id)).agentTypeId, 'tDS');
  assert.equal((await s.repo.getSession(session.id))!.model, 'deepseek-flash');
  const inbox = await s.agents.listEvents(a.id);
  assert.ok(inbox.some((e) => e.title === "Model claude-opus-4-5 isn't served by DeepSeek; switched to deepseek-flash"), JSON.stringify(inbox.map((e) => e.title)));

  // no loop: when the default itself is refused (and the refresh cannot help) the turn fails once
  const p2 = new ModelPickyProvider(['nothing-served']);
  const s2 = contextFor(db, p2);
  s2.types.fetchFn = (async () => new Response('down', { status: 503 })) as unknown as typeof fetch;
  // TurnContextService builds its own AgentTypesService; reach the same failure by refusing everything
  const sess2 = await s2.repo.createSession({ workspaceId: ws.id, agentId: a.id, name: 'chat 2' });
  const ev2: Array<{ type: string }> = [];
  for await (const ev of s2.turns.run(sess2.id, { text: 'hello' })) ev2.push(ev as { type: string });
  assert.ok(p2.requests.length <= 2, `at most one retry (got ${p2.requests.length})`);
  assert.equal(ev2.at(-1)?.type, 'error');
});

// ---- backfill ----

test('boot repair: agents and pinned chat sessions on a model their type does not serve move to its default; counts; idempotent; echo and unplaceable models untouched', async () => {
  const pg = new PGlite();
  const q = pgliteQueryable(pg);
  await runPgMigrations(q, { log: () => {} });
  const now = new Date().toISOString();
  await q.query(`INSERT INTO agent_types ("id","name","provider","model","models","baseUrl","apiKey","persona","enabled","createdAt") VALUES ('tDS','DeepSeek','custom','deepseek-flash','["deepseek-flash","deepseek-v4-pro"]','https://api.deepseek.com/v1',null,'',1,$1), ('tEcho','Echo','echo','echo','[]',null,null,'',1,$1)`, [now]);
  await q.query(`INSERT INTO app_settings ("key","value") VALUES ('defaultAgentTypeId','tDS')`);
  const agent = (id: string, model: string, typeId: string | null, provider = 'anthropic') => q.query(`INSERT INTO agents ("id","name","provider","model","agentTypeId","createdAt") VALUES ($1,$1,$2,$3,$4,$5)`, [id, provider, model, typeId, now]);
  await agent('a1', 'claude-opus-4-5', null);           // the user's failing agent: no type, falls to the default DeepSeek type
  await agent('a2', 'deepseek-v4-pro', 'tDS');           // fine
  await agent('a3', 'claude-sonnet-4-5', 'tEcho', 'echo'); // echo: untouched
  await agent('a4', '', null);                            // '' = default: untouched
  const session = (id: string, agentId: string | null, typeId: string | null, model: string) => q.query(`INSERT INTO chat_sessions ("id","workspaceId","agentId","agentTypeId","model","createdAt","updatedAt") VALUES ($1,'w',$2,$3,$4,$5,$5)`, [id, agentId, typeId, model, now]);
  await session('s1', 'a1', null, 'claude-opus-4-5');
  await session('s2', 'a2', 'tDS', 'deepseek-flash');
  await session('s3', null, 'tDS', 'gpt-5.1');

  assert.deepEqual(await repairAgentModels(q), { agents: 1, sessions: 2 });
  const rows = (await q.query(`SELECT "id","model" FROM agents ORDER BY "id"`)).rows as Array<{ id: string; model: string }>;
  assert.deepEqual(rows.map((r) => [r.id, r.model]), [['a1', 'deepseek-flash'], ['a2', 'deepseek-v4-pro'], ['a3', 'claude-sonnet-4-5'], ['a4', '']]);
  const sess = (await q.query(`SELECT "id","model" FROM chat_sessions ORDER BY "id"`)).rows as Array<{ id: string; model: string }>;
  assert.deepEqual(sess.map((r) => [r.id, r.model]), [['s1', 'deepseek-flash'], ['s2', 'deepseek-flash'], ['s3', 'deepseek-flash']]);
  assert.deepEqual(await repairAgentModels(q), { agents: 0, sessions: 0 }, 'idempotent');
  // and it runs on boot
  await q.query(`UPDATE agents SET "model" = 'claude-opus-4-5' WHERE "id" = 'a2'`);
  const logs: string[] = [];
  await runPgMigrations(q, { log: (m) => logs.push(m) });
  assert.ok(logs.some((l) => /repaired models: 1 agent\(s\), 0 chat session\(s\)/.test(l)), logs.join('\n'));
});
