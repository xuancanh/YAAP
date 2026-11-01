/** Sensing and executable acceptance (docs/sensing.md, execution-plan item
 *  27): metric sources of every kind with provenance (http_json through the
 *  SSRF guard with a selector and sealed secret headers, webhook with its own
 *  token, connection queries over a workspace agent's grant, human
 *  attestations); agents never write samples and only propose sources, which
 *  the CEO approves in both modes; key results bound to a source take their
 *  value only from samples while check-ins keep confidence; pace and risk on
 *  the measured value; stale sources signal the chief; every check kind
 *  passes, fails and errors model-free; review short-circuits on all-pass and
 *  returns failures to the owner as a round; the board's verification field,
 *  the brief's lines and the tunables' bounds. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { connectionGrants, connections, orgGoals, orgMetricSources, orgTasks } from '../server/src/database/schema';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub, ScriptedProvider } from './helpers';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { TriggerBus } from '../server/src/chats/trigger-bus';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { ConnectionsService } from '../server/src/connections/connections.service';
import { seal } from '../server/src/common/secretbox';
import { setAddressLookup } from '../server/src/common/url-guard';
import { isPublicRoute } from '../server/src/common/auth-strategy.interface';
import { runWithViewer, type Viewer } from '../server/src/accounts/account-context';
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
import { OrgSignalsService } from '../server/src/org/org-signals.service';
import { OrgController } from '../server/src/org/org.controller';
import { WorkspaceOrgController } from '../server/src/org/workspace-org.controller';
import { OrgSensingService } from '../server/src/org/org-sensing.service';
import { OrgSensingController, WorkspaceOrgSensingController } from '../server/src/org/org-sensing.controller';
import { normalizeChecks, selectNumber, selectValue } from '../server/src/org/org-checks';
import { TUNABLES, checkTunable, describeTunables } from '../server/src/org/org-tunables';
import '../server/src/org/sensing-tunables';

process.env.YAAM_ALLOW_PRIVATE_URLS = 'true';
setAddressLookup(async () => [{ address: '93.184.216.34', family: 4 }]);

const DAY = 24 * 60 * 60_000;
const iso = (offsetDays: number, from = Date.now()) => new Date(from + offsetDays * DAY).toISOString();

// ---- a local HTTP server for http_json sources and http checks ----

const seen: IncomingMessage[] = [];
let body: Record<string, unknown> = { stats: { subscribers: 42 }, items: [{ amount: 3 }, { amount: 4.5 }, { amount: 'x' }], status: 'green', tags: ['live', 'beta'] };
const server: Server = createServer((req, res) => {
  seen.push(req);
  // No keep-alive: a pooled socket the server closes between tests would surface as "fetch failed".
  res.setHeader('connection', 'close');
  if (req.url?.startsWith('/missing')) { res.writeHead(404); res.end('no'); return; }
  if (req.url?.startsWith('/text')) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('not json'); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
});
const ready = new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
after(() => server.close());
const runtimes: OrgRuntimeService[] = [];
after(() => { for (const r of runtimes) r.onModuleDestroy(); });
const base = async () => `http://127.0.0.1:${await ready}`;

/** Google APIs, faked at the connection's fetch seam. */
function fakeGoogle(counts: { gmail?: number; calendar?: number; drive?: number }, urls: string[] = []): typeof fetch {
  return (async (u: RequestInfo | URL) => {
    const url = String(u);
    urls.push(url);
    const json = url.includes('gmail') ? { messages: Array.from({ length: counts.gmail ?? 0 }, (_, i) => ({ id: `m${i}` })) }
      : url.includes('calendar') ? { items: Array.from({ length: counts.calendar ?? 0 }, (_, i) => ({ id: `e${i}` })) }
        : { files: Array.from({ length: counts.drive ?? 0 }, (_, i) => ({ id: `f${i}` })) };
    return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) } as unknown as Response;
  }) as typeof fetch;
}

async function setup() {
  const db = await testDb();
  const { stub, map } = memStorage();
  const bus = new TriggerBus();
  const agents = new AgentsService(db, stub, bus);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const provider = new ScriptedProvider([]);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(provider), skillsStub(), stub, mcpStub(), agents, workspaces);
  const config = { get: (k: string) => (k === 'companiesEnabled' ? true : k === 'loopsEnabled' ? false : undefined) } as unknown as ConfigService;
  const announcer = new OrgAnnouncer();
  const audit = new OrgAuditService(db);
  const org = new OrgService(db, agents, audit, bus);
  const units = new OrgUnitsService(db, org, agents, audit, announcer);
  const intent = new OrgIntentService(db, org, units, agents, audit, bus);
  const tasks = new OrgTasksService(db, org, audit, bus, units);
  const approvals = new OrgApprovalsService(db, org, tasks, agents, audit, undefined, bus);
  const signals = new OrgSignalsService(db, org, tasks, audit, agents, workspaces, bus, units);
  const brief = new OrgBriefService(db, org, tasks, approvals, audit, agents, workspaces, signals, undefined, intent);
  const runtime = new OrgRuntimeService(db, org, tasks, approvals, audit, brief, turns, repo, agents, workspaces, config, announcer, bus, undefined, undefined, undefined, undefined, undefined, units, signals, undefined, intent);
  runtime.debounceMs = 60_000;
  runtime.planningDebounceMs = 60_000;
  runtimes.push(runtime);
  const wakes: Array<{ taskId: string; agentId: string; reason: string }> = [];
  bus.onOrgWake((ev) => wakes.push(ev));
  const mode = new OrgModeService(org, workspaces, agents, runtime, approvals, audit, announcer);
  const orgs = new OrgController(org, tasks, approvals, audit, brief, runtime, config, units, signals, undefined, undefined, intent);
  const controller = new WorkspaceOrgController(mode, orgs, config);
  const conns = new ConnectionsService(db, config);
  const sensing = new OrgSensingService(db, org, audit, tasks, approvals, agents, config, turns, runtime, units, signals, conns, stub, undefined);
  const sensingApi = new OrgSensingController(org, sensing, config, intent);
  const wsSensing = new WorkspaceOrgSensingController(mode, sensingApi, config);
  const ws = (await workspaces.list())[0];
  const chief = await agents.create({ name: 'Chief', charter: 'You run the company.' });
  const writer = await agents.create({ name: 'Writer', charter: 'You write.' });
  const editor = await agents.create({ name: 'Editor', charter: 'You edit.' });
  return { wakes, db, map, agents, workspaces, repo, bus, audit, org, units, intent, tasks, approvals, signals, brief, runtime, mode, orgs, controller, conns, sensing, sensingApi, wsSensing, ws, chief, writer, editor };
}
type S = Awaited<ReturnType<typeof setup>>;

async function enable(s: S, modeName: 'supervised' | 'autonomous' = 'autonomous') {
  const st = await s.mode.setMode(s.ws.id, { mode: modeName, chiefOfStaffAgentId: s.chief.id, monthlyUsd: 50, agentCap: 10 });
  return st.orgId!;
}

const session = (s: S, agentId: string, name = 'chat') => s.repo.createSession({ workspaceId: s.ws.id, agentId, name });

/** An objective and a key result owned by the writer (target 100 by +10 days, created 10 days ago). */
async function keyResult(s: S, orgId: string, opts: { backdays?: number } = {}) {
  const objective = await s.units.addGoal(orgId, { title: 'Grow the list' });
  const kr = await s.intent.setKeyResult(orgId, { title: 'Subscribers', objectiveId: objective.id, metric: 'subscribers', targetValue: 100, startValue: 0, dueAt: iso(10), ownerAgentId: s.writer.id });
  if (opts.backdays) await s.db.update(orgGoals).set({ createdAt: iso(-opts.backdays) }).where(eq(orgGoals.id, kr.id));
  return { objective, kr };
}

/** A Gmail-read + Drive connection granted to an agent of the workspace. */
async function grantConnection(s: S, agentId: string, services: Array<'gmail' | 'calendar' | 'drive'> = ['gmail', 'calendar', 'drive']) {
  await s.db.insert(connections).values({
    id: 'conn1', provider: 'google', accountEmail: 'owner@example.com',
    scopes: JSON.stringify(['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file']),
    accessToken: seal('live-token'), refreshToken: seal('refresh'), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), createdAt: new Date().toISOString(),
  });
  for (const service of services) await s.db.insert(connectionGrants).values({ id: `g-${service}`, connectionId: 'conn1', agentId, service, level: service === 'gmail' ? 'write' : 'read', memberAccountId: '', createdAt: new Date().toISOString() });
}

// ---- 1. the selector ----

test('selector: dot and bracket paths, length/count of arrays, sum over a field; no evaluation, bad selectors refused', () => {
  const doc = { a: { b: [{ n: 2, m: { v: 1 } }, { n: 3, m: { v: 4 } }] }, 'odd.key': { x: '7' }, flag: true };
  assert.equal(selectNumber(doc, '$.a.b[1].n'), 3);
  assert.equal(selectNumber(doc, 'a.b.length'), 2);
  assert.equal(selectNumber(doc, 'a.b.count'), 2);
  assert.equal(selectNumber(doc, 'a.b.sum(n)'), 5);
  assert.equal(selectNumber(doc, 'a.b.sum(m.v)'), 5);
  assert.equal(selectNumber(doc, 'a.b.count(m)'), 2);
  assert.equal(selectNumber(doc, '["odd.key"].x'), 7, 'a numeric string reads as a number');
  assert.equal(selectNumber(doc, 'flag'), 1);
  assert.equal(selectValue(doc, 'a.nope.deeper'), undefined);
  assert.throws(() => selectNumber(doc, 'a.b'), /not a number/);
  for (const bad of ['', 'a.b[x]', 'constructor()', 'a;process.exit()', 'a.b[0', 'eval(1)']) assert.throws(() => selectValue(doc, bad), /selector/, bad);
});

// ---- 2. http_json ----

test('http_json: the CEO creates a source; a poll extracts the number with the selector and records provenance (url, status, response hash); secret headers are sealed, sent, and never returned', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const url = `${await base()}/stats`;
  await assert.rejects(s.sensingApi.create(orgId, { name: 'Bad', kind: 'http_json', config: { url, selector: 'stats.subscribers', headers: { Authorization: 'Bearer plain' } } }), /\{\{secret:NAME\}\}/, 'a credential header must be a secret reference');
  await assert.rejects(s.sensingApi.create(orgId, { name: 'Bad', kind: 'http_json', config: { url, selector: 'stats.subscribers', headers: { Authorization: '{{secret:API}}' } } }), /not set/);
  const created = await s.wsSensing.create(s.ws.id, { name: 'Mailing list', kind: 'http_json', unit: 'subscribers', pollMinutes: 30, config: { url, selector: 'stats.subscribers', headers: { Authorization: 'Bearer {{secret:API}}', 'X-Plain': 'hello' } }, secrets: { API: 's3cr3t-value' } });
  assert.equal(created.source.status, 'ok', 'the CEO creates it live');
  assert.deepEqual(created.source.secretNames, ['API']);
  const r = await s.sensing.poll(orgId, created.source.id);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value, 42);
  const req = seen.at(-1)!;
  assert.equal(req.headers.authorization, 'Bearer s3cr3t-value', 'the sealed secret reaches the endpoint');
  assert.equal(req.headers['x-plain'], 'hello');
  const [sample] = await s.wsSensing.samples(s.ws.id, created.source.id);
  const prov = JSON.parse(sample.provenance);
  assert.equal(prov.kind, 'http_json'); assert.equal(prov.url, url); assert.equal(prov.status, 200); assert.match(prov.responseHash, /^[0-9a-f]{64}$/);
  // the sum selector over an array field
  const sum = await s.sensingApi.create(orgId, { name: 'Revenue', kind: 'http_json', config: { url, selector: 'items.sum(amount)' } });
  assert.equal((await s.sensing.poll(orgId, sum.source.id)).value, 7.5);
  // nothing the API, the tools or the audit log return carries the secret
  const listed = JSON.stringify(await s.sensingApi.sources(orgId));
  const audited = JSON.stringify(await s.audit.list(orgId, { limit: 200 }));
  const toolText = await s.sensing.execute(await session(s, s.chief.id), 'org_metric_sources', {});
  for (const text of [listed, audited, toolText]) assert.ok(!text.includes('s3cr3t-value'), 'secret never echoed');
  assert.match(toolText, /"Mailing list" \(http_json, ok\) — 42 subscribers/);
  assert.ok((await s.audit.list(orgId, { action: 'metric_sample', limit: 10 })).length >= 2, 'every sample is audited');
  // a selector that finds no number is an error on the source, not a sample
  body = { ...body, stats: { subscribers: 'many' } };
  const bad = await s.sensing.poll(orgId, created.source.id);
  assert.equal(bad.ok, false); assert.match(bad.error!, /not a number/);
  body = { ...body, stats: { subscribers: 42 } };
});

test('http_json: https only without the dev flag, and the SSRF guard refuses private targets — the source goes to error with backoff and the chief hears once', async () => {
  const s = await setup();
  const orgId = await enable(s);
  process.env.YAAM_ALLOW_PRIVATE_URLS = 'false';
  try {
    await assert.rejects(s.sensingApi.create(orgId, { name: 'Plain', kind: 'http_json', config: { url: 'http://example.com/x', selector: 'a' } }), /must use https/);
    const internal = await s.sensingApi.create(orgId, { name: 'Internal', kind: 'http_json', pollMinutes: 10, config: { url: `https://127.0.0.1:${await ready}/stats`, selector: 'stats.subscribers' } });
    const r = await s.sensing.poll(orgId, internal.source.id);
    assert.equal(r.ok, false);
    assert.match(r.error!, /private\/internal/);
    setAddressLookup(async () => [{ address: '10.0.0.7', family: 4 }]);
    const rebind = await s.sensingApi.create(orgId, { name: 'Rebind', kind: 'http_json', config: { url: 'https://metrics.example.com/x', selector: 'a' } });
    assert.match((await s.sensing.poll(orgId, rebind.source.id)).error!, /private\/internal/, 'a hostname resolving to a private address is refused');
    const src = (await s.db.select().from(orgMetricSources).where(eq(orgMetricSources.id, internal.source.id)))[0];
    assert.equal(src.status, 'error'); assert.equal(src.failures, 1);
    assert.ok(Date.parse(src.nextPollAt!) > Date.now() + 9 * 60_000, 'backs off by the poll interval at least');
    await s.sensing.poll(orgId, internal.source.id);
    const again = (await s.db.select().from(orgMetricSources).where(eq(orgMetricSources.id, internal.source.id)))[0];
    assert.equal(again.failures, 2);
    assert.ok(Date.parse(again.nextPollAt!) > Date.now() + 19 * 60_000, 'exponential backoff');
    const events = (await s.agents.listEvents(s.chief.id, 50)).filter((e) => e.title.includes('Metric source "Internal" failed'));
    assert.equal(events.length, 1, 'the first failure reaches the chief; the rest back off quietly');
  } finally {
    process.env.YAAM_ALLOW_PRIVATE_URLS = 'true';
    setAddressLookup(async () => [{ address: '93.184.216.34', family: 4 }]);
  }
});

// ---- 3. webhook ----

test('webhook: a token shown once, timing-safe ingest, rotation retires the old token, the route is public, bad bodies are refused', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const created = await s.sensingApi.create(orgId, { name: 'Signups', kind: 'webhook', unit: 'signups' });
  assert.ok(created.token && created.token.length > 20);
  assert.equal((await s.sensingApi.sources(orgId))[0].hasToken, true);
  assert.ok(!JSON.stringify(await s.sensingApi.sources(orgId)).includes(created.token!), 'the token is not listed');
  assert.ok(!JSON.stringify(await s.audit.list(orgId, { limit: 50 })).includes(created.token!), 'nor audited');
  await assert.rejects(s.sensing.ingest(created.source.id, 'wrong', { value: 1 }), /bad token/);
  await assert.rejects(s.sensing.ingest(created.source.id, '', { value: 1 }), /bad token/);
  await assert.rejects(s.sensing.ingest('nope', created.token!, { value: 1 }), /bad token/);
  await assert.rejects(s.sensing.ingest(created.source.id, created.token!, { value: 'lots' }), /value: number/);
  await assert.rejects(s.sensing.ingest(created.source.id, created.token!, { value: 3, observedAt: iso(2) }), /future/);
  const ok = await s.sensing.ingest(created.source.id, created.token!, { value: 17, observedAt: iso(-1) });
  assert.equal(ok.accepted, true);
  const [sample] = await s.sensing.samples(orgId, created.source.id);
  assert.equal(sample.value, 17); assert.equal(JSON.parse(sample.provenance).kind, 'webhook');
  const rotated = await s.wsSensing.rotate(s.ws.id, created.source.id);
  await assert.rejects(s.sensing.ingest(created.source.id, created.token!, { value: 18 }), /bad token/, 'the old token stops working');
  await s.sensing.ingest(created.source.id, rotated.token, { value: 19 });
  assert.equal((await s.sensing.describe(orgId, created.source.id)).lastValue, 19);
  assert.equal(isPublicRoute({ method: 'POST', path: `/api/metrics/${created.source.id}/ingest` }), true);
  assert.equal(isPublicRoute({ method: 'GET', path: `/api/metrics/${created.source.id}/ingest` }), false);
  assert.equal(isPublicRoute({ method: 'POST', path: `/api/metrics/${created.source.id}/attest` }), false);
  // the rate limit
  const now = new Date();
  for (let i = 0; i < 26; i++) await s.sensing.ingest(created.source.id, rotated.token, { value: i }, now);
  await assert.rejects(s.sensing.ingest(created.source.id, rotated.token, { value: 99 }, now), /rate limited/);
  await assert.rejects(s.sensing.poll(orgId, created.source.id), /not polled/);
});

// ---- 4. connection ----

test('connection: refused without a workspace agent holding the grant; with one, the fixed menu counts gmail, calendar and drive with provenance', async () => {
  const s = await setup();
  const orgId = await enable(s);
  await assert.rejects(s.sensingApi.create(orgId, { name: 'Inbox', kind: 'connection', config: { query: 'gmail_matching', q: 'from:stripe', days: 7 } }), /no agent of this workspace holds a gmail grant/);
  await assert.rejects(s.sensingApi.create(orgId, { name: 'Free form', kind: 'connection', config: { query: 'gmail_send', q: 'x' } }), /connection query must be one of/);
  // a grant held by an agent of another workspace does not count
  const other = await s.workspaces.create({ name: 'Elsewhere' });
  const outsider = await s.agents.create({ name: 'Outsider', workspaceId: other.id });
  await grantConnection(s, outsider.id, ['gmail']);
  await assert.rejects(s.sensingApi.create(orgId, { name: 'Inbox', kind: 'connection', config: { query: 'gmail_matching', q: 'from:stripe' } }), /no agent of this workspace/);
  await s.db.insert(connectionGrants).values({ id: 'g-in', connectionId: 'conn1', agentId: s.editor.id, service: 'gmail', level: 'write', memberAccountId: '', createdAt: new Date().toISOString() });
  for (const service of ['calendar', 'drive']) await s.db.insert(connectionGrants).values({ id: `g-in-${service}`, connectionId: 'conn1', agentId: s.editor.id, service, level: 'read', memberAccountId: '', createdAt: new Date().toISOString() });
  const urls: string[] = [];
  s.conns.fetchImpl = fakeGoogle({ gmail: 5, calendar: 3, drive: 2 }, urls);
  const inbox = await s.sensingApi.create(orgId, { name: 'Inbox', kind: 'connection', config: { query: 'gmail_matching', q: 'from:stripe', days: 7 } });
  const r = await s.sensing.poll(orgId, inbox.source.id);
  assert.equal(r.value, 5, r.error);
  assert.match(decodeURIComponent(urls.at(-1)!.replace(/\+/g, ' ')), /q=from:stripe newer_than:7d/);
  const prov = JSON.parse(r.sample!.provenance);
  assert.deepEqual([prov.kind, prov.connection, prov.service], ['connection', 'conn1', 'gmail']);
  assert.match(prov.query, /gmail_matching "from:stripe" 7d/);
  const cal = await s.sensingApi.create(orgId, { name: 'Meetings', kind: 'connection', config: { query: 'calendar_events_week', q: 'demo' } });
  assert.equal((await s.sensing.poll(orgId, cal.source.id)).value, 3);
  const drive = await s.sensingApi.create(orgId, { name: 'Docs touched', kind: 'connection', config: { query: 'drive_changed', days: 3 } });
  assert.equal((await s.sensing.poll(orgId, drive.source.id)).value, 2);
  const unread = await s.sensingApi.create(orgId, { name: 'Unread', kind: 'connection', config: { query: 'gmail_unread' } });
  assert.equal((await s.sensing.poll(orgId, unread.source.id)).value, 5);
  assert.match(decodeURIComponent(urls.at(-1)!), /is:unread/);
});

// ---- 5. manual attestation; agents never write samples ----

test('manual_attested: the CEO, a board member or an employee attests with a note and the provenance names them; an observer cannot; agents have no way to write a sample', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const src = await s.sensingApi.create(orgId, { name: 'Revenue (bank)', kind: 'manual_attested', unit: 'USD' });
  await assert.rejects(s.sensingApi.attest(orgId, src.source.id, { value: 1200, note: '' }), /needs a note/);
  const sample = await s.sensingApi.attest(orgId, src.source.id, { value: 1200, note: 'from the bank statement' });
  assert.deepEqual(JSON.parse(sample.provenance), { kind: 'manual_attested', by: 'user', note: 'from the bank statement' });
  await s.org.setHuman(orgId, { memberAccountId: 'bob', role: 'board' });
  await s.org.setHuman(orgId, { memberAccountId: 'olga', role: 'observer' });
  const as = (id: string): Viewer => ({ memberAccountId: id, role: 'member', workspaceId: s.ws.id, displayName: id });
  const boardSample = await runWithViewer('single', as('bob'), () => s.sensingApi.attest(orgId, src.source.id, { value: 1300, note: 'Stripe payout' }));
  assert.equal(JSON.parse(boardSample.provenance).by, 'human:bob');
  await assert.rejects(runWithViewer('single', as('olga'), () => s.sensingApi.attest(orgId, src.source.id, { value: 1, note: 'x' })), /observers/);
  await assert.rejects(runWithViewer('single', as('mallory'), () => s.sensingApi.attest(orgId, src.source.id, { value: 1, note: 'x' })), /no standing/);
  await assert.rejects(runWithViewer('single', as('bob'), () => s.sensingApi.create(orgId, { name: 'X', kind: 'manual_attested' })), /CEO/, 'only the CEO creates a source');
  // agents: no tool writes a sample, whatever the role
  const chiefSpecs = (await s.sensing.specsFor(await session(s, s.chief.id))).map((t) => t.name);
  const memberSpecs = (await s.sensing.specsFor(await session(s, s.writer.id))).map((t) => t.name);
  assert.deepEqual(memberSpecs.sort(), ['org_metric_read', 'org_metric_sources', 'org_run_checks', 'org_task_checks']);
  assert.ok(chiefSpecs.includes('org_propose_metric_source'));
  const runtimeSpecs = (await s.runtime.specsFor(await session(s, s.chief.id))).map((t) => t.name);
  for (const n of [...chiefSpecs, ...runtimeSpecs]) assert.ok(!/attest|ingest|sample/.test(n) || n === 'org_metric_read', `no sample-writing tool (${n})`);
  await assert.rejects(s.sensing.execute(await session(s, s.writer.id), 'org_metric_attest', { source: src.source.id, value: 5 }), /unknown tool/);
  // even a direct call naming an agent as the writer is refused at the one write path
  await assert.rejects((s.sensing as unknown as { recordSample: (...a: unknown[]) => Promise<unknown> }).recordSample(await s.org.get(orgId), (await s.db.select().from(orgMetricSources))[0], 9, new Date().toISOString(), { kind: 'manual_attested' }, `agent:${s.writer.id}`), /agents never write metric samples/);
  await assert.rejects(s.sensingApi.attest(orgId, (await s.sensingApi.create(orgId, { name: 'Hook', kind: 'webhook' })).source.id, { value: 1, note: 'x' }), /only manual_attested/);
});

// ---- 6. proposals and the approval card ----

for (const modeName of ['supervised', 'autonomous'] as const) {
  test(`metric_source approval (${modeName}): a lead or the chief proposes, a plain member cannot; the source is pending and measures nothing until the CEO approves; a board member cannot decide it; rejection marks it rejected`, async () => {
    const s = await setup();
    const orgId = await enable(s, modeName);
    const chief = await session(s, s.chief.id);
    await assert.rejects(s.sensing.execute(await session(s, s.writer.id), 'org_propose_metric_source', { name: 'x', kind: 'manual_attested', why: 'y' }), /chief of staff and unit leads/);
    await assert.rejects(s.sensing.execute(chief, 'org_propose_metric_source', { name: 'x', kind: 'manual_attested' }), /why is required/);
    const out = await s.sensing.execute(chief, 'org_propose_metric_source', { name: 'List size', kind: 'http_json', url: `${await base()}/stats`, selector: 'stats.subscribers', headers: { Authorization: '{{secret:KEY}}' }, unit: 'subscribers', why: 'the subscribers KR' });
    assert.match(out, /pending the CEO's approval/);
    const src = (await s.sensingApi.sources(orgId)).find((x) => x.name === 'List size')!;
    assert.equal(src.status, 'pending_approval');
    assert.equal(src.createdBy, 'chief');
    await assert.rejects(s.sensing.poll(orgId, src.id), /pending_approval/);
    const { kr } = await keyResult(s, orgId);
    await assert.rejects(s.intent.bindSource(orgId, kr.id, src.id), /pending approval/);
    const card = (await s.approvals.pending(orgId)).find((a) => a.kind === 'metric_source')!;
    assert.ok(card, `a card in ${modeName} mode too`);
    assert.match(JSON.stringify(JSON.parse(card.payload)), /List size/);
    await s.org.setHuman(orgId, { memberAccountId: 'bob', role: 'board' });
    await assert.rejects(runWithViewer('single', { memberAccountId: 'bob', role: 'member', workspaceId: s.ws.id, displayName: 'Bob' }, () => s.orgs.decide(orgId, card.id, { decision: 'approve' } as never)), /CEO/);
    // the agent never handles the secret: approving before the CEO sets it is refused
    await assert.rejects(s.orgs.decide(orgId, card.id, { decision: 'approve' } as never), /set the secret/);
    await s.sensingApi.update(orgId, src.id, { secrets: { KEY: 'k-123' } });
    const decided = await s.orgs.decide(orgId, card.id, { decision: 'approve' } as never);
    assert.equal(decided.approval.status, 'approved');
    assert.equal((await s.sensing.describe(orgId, src.id)).status, 'ok');
    assert.equal((await s.sensing.poll(orgId, src.id)).value, 42);
    assert.equal(seen.at(-1)!.headers.authorization, 'k-123');
    // a second proposal, rejected
    await s.sensing.execute(chief, 'org_propose_metric_source', { name: 'Vanity', kind: 'manual_attested', why: 'nice to have' });
    const card2 = (await s.approvals.pending(orgId)).find((a) => a.kind === 'metric_source')!;
    await s.orgs.decide(orgId, card2.id, { decision: 'reject', note: 'not a real metric' } as never);
    assert.equal((await s.sensingApi.sources(orgId)).find((x) => x.name === 'Vanity')!.status, 'rejected');
    // agents cannot hand a secret value over
    await assert.rejects(s.sensing.create(orgId, { name: 'Leaky', kind: 'http_json', config: { url: `${await base()}/x`, selector: 'a' }, secrets: { K: 'v' } }, 'chief', { propose: true, why: 'x' }), /never handles secrets/);
  });
}

// ---- 7. key results bound to a source ----

test('a bound key result takes its value only from samples: binding copies the latest, polls move it, check-in values and goal edits are refused while confidence and notes are kept; the tree says measuredBy / selfReported and the brief counts self-reported KRs', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const { kr } = await keyResult(s, orgId);
  const { kr: other } = await keyResult(s, orgId);
  const hook = await s.sensingApi.create(orgId, { name: 'Subscribers', kind: 'webhook', unit: 'subscribers' });
  await s.sensing.ingest(hook.source.id, hook.token!, { value: 20 });
  const bound = await s.wsSensing.bind(s.ws.id, kr.id, { sourceId: hook.source.id });
  assert.equal(bound.metricSourceId, hook.source.id);
  assert.equal(bound.currentValue, 20, 'binding copies the latest sample');
  await s.sensing.ingest(hook.source.id, hook.token!, { value: 35 });
  // an older observation arriving late does not overwrite the latest
  await s.sensing.ingest(hook.source.id, hook.token!, { value: 1, observedAt: iso(-3) });
  const g = await s.org.goal(orgId, kr.id);
  assert.equal(g.currentValue, 35); assert.ok(g.lastMeasuredAt);
  // the owner's check-in: a value is refused, confidence and a note are kept
  const writer = await session(s, s.writer.id);
  await assert.rejects(s.runtime.execute(writer, 'org_check_in', { goalId: kr.id, currentValue: 90, confidence: 0.9 }), /measured by a metric source/);
  await assert.rejects(s.intent.checkIn(orgId, kr.id, { currentValue: 90 }), /measured by "Subscribers" \(webhook\)/);
  const out = await s.runtime.execute(writer, 'org_check_in', { goalId: kr.id, confidence: 0.6, note: 'launch next week' });
  assert.match(out, /35 of 100/);
  const after1 = await s.org.goal(orgId, kr.id);
  assert.equal(after1.confidence, 0.6); assert.equal(after1.currentValue, 35);
  const [checkin] = await s.intent.checkIns(orgId, kr.id);
  assert.equal(checkin.currentValue, 35, 'the check-in records the measured value next to the judged forecast');
  await assert.rejects(s.org.updateGoal(orgId, kr.id, { currentValue: 99 }), /measured by a metric source/);
  // the intent tree
  const flat = (await s.intent.intentTree(orgId)).flatMap(function walk(n): typeof n[] { return [n, ...n.children.flatMap(walk)]; });
  const node = flat.find((n) => n.id === kr.id)!;
  assert.deepEqual({ ...node.measuredBy!, lastFetchedAt: undefined }, { sourceId: hook.source.id, name: 'Subscribers', kind: 'webhook', status: 'ok', lastFetchedAt: undefined });
  assert.equal(node.selfReported, false);
  assert.equal(flat.find((n) => n.id === other.id)!.selfReported, true);
  assert.match(await s.intent.describeTree(orgId), /measured by "Subscribers" \(ok\)/);
  // the brief's standing note
  const b = await s.brief.compose(orgId);
  assert.match(b.text, /Note: 1 of 2 key result\(s\) are self-reported/);
  // org_set_key_result binds on creation
  const chief = await session(s, s.chief.id);
  const objective = (await s.org.goals(orgId)).find((x) => x.kind === 'objective')!;
  const set = await s.runtime.execute(chief, 'org_set_key_result', { title: 'Signups', objectiveId: objective.id, targetValue: 50, dueAt: iso(20), owner: 'Writer', source: 'Subscribers' });
  assert.match(set, /Measured by the metric source/);
  // unbind: self-reported again, the last measured value stays
  const unbound = await s.sensingApi.bind(orgId, kr.id, { sourceId: null });
  assert.equal(unbound.metricSourceId, null); assert.equal(unbound.currentValue, 35);
  // deleting a source unbinds what it measured
  await s.sensingApi.bind(orgId, kr.id, { sourceId: hook.source.id });
  const removed = await s.sensingApi.remove(orgId, hook.source.id);
  assert.equal(removed.unbound, 2);
  assert.equal((await s.org.goal(orgId, kr.id)).metricSourceId, null);
});

test('pace and at-risk read the measured value: a sourced key result behind its linear pace is at risk, and a new sample clears it', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const { kr } = await keyResult(s, orgId, { backdays: 10 });
  await s.intent.checkIn(orgId, kr.id, { confidence: 0.9, note: 'fine' });
  const src = await s.sensingApi.create(orgId, { name: 'Count', kind: 'manual_attested' });
  await s.sensingApi.bind(orgId, kr.id, { sourceId: src.source.id });
  await s.sensingApi.attest(orgId, src.source.id, { value: 10, note: 'counted' });
  const r1 = await s.intent.assessRisk(orgId);
  const v1 = r1.keyResults.find((v) => v.goal.id === kr.id)!;
  assert.equal(v1.atRisk, true);
  assert.match(v1.reasons.join(' '), /behind pace: 10% done where 50% was expected/);
  await s.sensingApi.attest(orgId, src.source.id, { value: 55, note: 'recount' });
  const r2 = await s.intent.assessRisk(orgId);
  assert.equal(r2.keyResults.find((v) => v.goal.id === kr.id)!.atRisk, false);
  assert.equal((await s.org.goal(orgId, kr.id)).atRisk, 0);
});

// ---- 8. staleness ----

test('stale: no sample in staleMultiplier × pollMinutes marks the source stale and signals the chief (once a day); a fresh sample resolves it; the tunable moves the line', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const hook = await s.sensingApi.create(orgId, { name: 'Orders', kind: 'webhook', pollMinutes: 60 });
  await s.sensing.ingest(hook.source.id, hook.token!, { value: 3 });
  const now = Date.now();
  assert.deepEqual(await s.sensing.sweep(orgId, new Date(now + 2.5 * 3_600_000)), { polled: 0, stale: 0 }, 'under 3× the interval it is fresh');
  await s.org.setTunable(orgId, 'sensing.staleMultiplier', 2, { actor: 'user' });
  const r = await s.sensing.sweep(orgId, new Date(now + 2.5 * 3_600_000));
  assert.equal(r.stale, 1, 'the tunable moved the line');
  assert.equal((await s.sensing.describe(orgId, hook.source.id)).status, 'stale');
  const sig = (await s.signals.list(orgId, { kind: 'metric_stale' }))[0];
  assert.ok(sig); assert.equal(sig.addresseeKind, 'chief'); assert.equal(sig.refId, hook.source.id); assert.match(sig.title, /"Orders" is stale/);
  await s.sensing.sweep(orgId, new Date(now + 2.6 * 3_600_000));
  assert.equal((await s.signals.list(orgId, { kind: 'metric_stale' })).length, 1, 'deduplicated per day');
  await s.sensing.ingest(hook.source.id, hook.token!, { value: 4 });
  assert.equal((await s.sensing.describe(orgId, hook.source.id)).status, 'ok');
  assert.equal((await s.signals.list(orgId, { kind: 'metric_stale' }))[0].status, 'resolved');
  assert.ok((await s.audit.list(orgId, { action: 'metric_stale', limit: 5 })).length === 1);
});

test('the tick polls due sources only, and pollMinutes is clamped to sensing.minPollMinutes', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const src = await s.sensingApi.create(orgId, { name: 'List', kind: 'http_json', pollMinutes: 1, config: { url: `${await base()}/stats`, selector: 'stats.subscribers' } });
  assert.equal(src.source.pollMinutes, 5, 'clamped up to the default minimum');
  const before = seen.length;
  await s.sensing.tick(new Date());
  assert.equal(seen.length, before + 1, 'due at once after creation');
  await s.sensing.tick(new Date());
  assert.equal(seen.length, before + 1, 'not due again within the interval');
  await s.sensing.tick(new Date(Date.now() + 6 * 60_000));
  assert.equal(seen.length, before + 2);
  assert.equal((await s.sensing.samples(orgId, src.source.id)).length, 2);
});

// ---- 9. checks ----

test('checks validate at write time: unknown kinds, traversal, bad regexes and github_check (no GitHub connection) are refused with the index', () => {
  assert.throws(() => normalizeChecks([{ kind: 'file_exists', path: '../etc/passwd' }]), /check 1: invalid path segment/);
  assert.throws(() => normalizeChecks([{ kind: 'http_status', url: 'https://a.example' }, { kind: 'shell', cmd: 'rm' }]), /check 2: kind must be one of/);
  assert.throws(() => normalizeChecks([{ kind: 'github_check', repo: 'a/b', ref: 'main', conclusion: 'success' }]), /no GitHub connection/);
  assert.throws(() => normalizeChecks([{ kind: 'file_matches', path: 'a.txt', regex: '(' }]), /does not compile/);
  assert.throws(() => normalizeChecks([{ kind: 'http_json_match', url: 'https://a.example', selector: 'x' }]), /equals, contains or atLeast/);
  assert.throws(() => normalizeChecks(Array.from({ length: 11 }, () => ({ kind: 'file_exists', path: 'a' }))), /at most 10/);
  assert.deepEqual(normalizeChecks([{ kind: 'metric_increased', sourceId: 'abc', by: 2 }]), [{ kind: 'metric_increased', sourceId: 'abc', by: 2, sinceTaskStart: true }]);
});

test('every check kind passes, fails and errors without a model, and the results are stored per check', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const url = await base();
  const hook = await s.sensingApi.create(orgId, { name: 'Subs', kind: 'webhook' });
  await s.sensing.ingest(hook.source.id, hook.token!, { value: 10, observedAt: iso(-1) });
  const pending = await s.sensing.create(orgId, { name: 'Pending', kind: 'manual_attested' }, 'chief', { propose: true, why: 'x' });
  await s.db.insert(connectionGrants).values({ id: 'g1', connectionId: 'conn1', agentId: s.editor.id, service: 'gmail', level: 'write', memberAccountId: '', createdAt: new Date().toISOString() });
  await grantConnection(s, s.editor.id, []);
  s.conns.fetchImpl = fakeGoogle({ gmail: 4 });
  s.map.set(`workspaces/${s.ws.id}/reports/issue.json`, Buffer.from(JSON.stringify({ title: 'Issue 12', sources: ['a', 'b'] })));
  s.map.set(`workspaces/${s.ws.id}/reports/notes.md`, Buffer.from('# Issue 12\nSource: example.com'));
  const t = await s.tasks.create(orgId, { title: 'Ship issue 12', brief: { outcome: 'out', done_when: '' }, assigneeAgentId: s.writer.id, checks: [
    { kind: 'metric_at_least', sourceId: hook.source.id, value: 10 }, // pass
    { kind: 'metric_at_least', sourceId: hook.source.id.slice(0, 8), value: 11 }, // fail (by prefix)
    { kind: 'metric_at_least', sourceId: pending.source.id, value: 1 }, // error: pending
    { kind: 'metric_increased', sourceId: 'Subs', by: 5 }, // fail until it moves
    { kind: 'http_status', url: `${url}/stats`, status: 200 }, // pass
    { kind: 'http_status', url: `${url}/missing`, status: 200 }, // fail
    { kind: 'http_json_match', url: `${url}/stats`, selector: 'status', equals: 'green' }, // pass
    { kind: 'http_json_match', url: `${url}/stats`, selector: 'tags', contains: 'stable' }, // fail
    { kind: 'http_json_match', url: `${url}/text`, selector: 'a', atLeast: 1 }, // error: not JSON
    { kind: 'file_exists', path: 'reports/issue.json' }, // pass
  ] });
  const r = await s.sensing.runChecks(orgId, t.id);
  assert.deepEqual(r.results.map((x) => x.status), ['pass', 'fail', 'error', 'fail', 'pass', 'fail', 'pass', 'fail', 'error', 'pass'], JSON.stringify(r.results.map((x) => x.detail)));
  assert.equal(r.outcome, 'fail');
  assert.match(r.results[1].detail, /"Subs" is 10 \(needs ≥ 11/);
  assert.match(r.results[2].detail, /pending_approval/);
  assert.match(r.results[5].detail, /answered 404/);
  assert.match(r.results[8].detail, /did not return JSON/);
  // the metric moves after the task started
  await s.sensing.ingest(hook.source.id, hook.token!, { value: 16 });
  assert.equal((await s.sensing.runChecks(orgId, t.id)).results[3].status, 'pass');
  const stored = await s.wsSensing.checks(s.ws.id, t.id);
  assert.equal(stored.length, 10); assert.equal(stored[3].status, 'pass');
  // files, connection queries, a network error
  const t2 = await s.tasks.create(orgId, { title: 'Files', brief: { outcome: 'o' }, checks: [
    { kind: 'file_exists', path: 'reports/missing.md' }, // fail
    { kind: 'file_matches', path: 'reports/notes.md', contains: 'Source:', regex: '^# Issue \\d+' }, // pass
    { kind: 'file_matches', path: 'reports/issue.json', jsonSchemaKeys: ['title', 'sources', 'author'] }, // fail
    { kind: 'file_matches', path: 'reports/notes.md', jsonSchemaKeys: ['title'] }, // fail: not JSON
    { kind: 'connection_query', service: 'gmail_matching', query: 'subject:issue', days: 2, atLeast: 3 }, // pass
    { kind: 'connection_query', service: 'drive_changed', atLeast: 1 }, // error: no drive grant
    { kind: 'http_status', url: 'http://127.0.0.1:1/x', status: 200 }, // error: refused connection
  ] });
  const r2 = await s.sensing.runChecks(orgId, t2.id);
  assert.deepEqual(r2.results.map((x) => x.status), ['fail', 'pass', 'fail', 'fail', 'pass', 'error', 'error']);
  assert.match(r2.results[2].detail, /missing key\(s\) author/);
  assert.match(r2.results[4].detail, /counts 4 \(needs ≥ 3\)/);
  assert.match(r2.results[5].detail, /drive grant/);
  // the tools
  const writer = await session(s, s.writer.id);
  assert.match(await s.sensing.execute(writer, 'org_task_checks', { taskId: t.id }), /6\. GET .*missing answers 200 — fail/);
  assert.match(await s.sensing.execute(writer, 'org_run_checks', { taskId: t.id }), /some fail/);
  await assert.rejects(s.sensing.execute(await session(s, s.editor.id), 'org_run_checks', { taskId: t.id }), /owner, its reviewer or the chief/);
  assert.equal((await s.tasks.get(orgId, t.id)).status, 'todo', 'running checks changes nothing');
});

// ---- 10. review short-circuit ----

test('review: all checks pass → accepted by check with no reviewer; the tunable asks for a review too when done_when has text; a failure returns the task to its owner with the details as a counted round, and the cap escalates; an error falls through to review with a note; the board says how each done task was verified', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const url = await base();
  const writer = await session(s, s.writer.id);
  const chief = await session(s, s.chief.id);
  // created through the tool, with checks
  const made = await s.runtime.execute(chief, 'org_create_task', { title: 'Publish status page', outcome: 'status page live', done_when: 'the page is up and reads green', assignee: 'Writer', checks: [{ kind: 'http_json_match', url: `${url}/stats`, selector: 'status', equals: 'green' }] });
  assert.match(made, /with 1 check\(s\)/);
  await assert.rejects(s.runtime.execute(chief, 'org_create_task', { title: 'Bad', outcome: 'o', done_when: 'd', checks: [{ kind: 'file_exists', path: '../x' }] }), /refused: check 1/);
  const pass = (await s.tasks.list(orgId)).find((t) => t.title === 'Publish status page')!;
  const reply = await s.runtime.execute(writer, 'org_request_review', { taskId: pass.id });
  assert.match(reply, /passed all its checks and is accepted/);
  const done = await s.tasks.get(orgId, pass.id);
  assert.equal(done.status, 'done'); assert.equal(done.acceptedBy, 'check'); assert.equal(done.reviewerAgentId, null, 'no reviewer was asked');
  assert.ok((await s.audit.list(orgId, { action: 'review_accept', limit: 5 })).some((r) => r.actor === 'check'));
  // the tunable: also review when done_when has qualitative text
  await s.org.setTunable(orgId, 'acceptance.alsoReviewWhenChecksPass', 1, { actor: 'user' });
  const both = await s.tasks.create(orgId, { title: 'Both', brief: { outcome: 'o', done_when: 'reads well' }, assigneeAgentId: s.writer.id, checks: [{ kind: 'http_status', url: `${url}/stats`, status: 200 }] });
  const inReview = await s.tasks.requestReview(orgId, both.id, { fromAgentId: s.writer.id });
  assert.equal(inReview.status, 'in_review'); assert.ok(inReview.reviewerAgentId);
  assert.ok((await s.tasks.messages(orgId, { taskId: both.id })).some((m) => /All checks passed/.test(m.text)));
  await s.org.setTunable(orgId, 'acceptance.alsoReviewWhenChecksPass', 0, { actor: 'user' });
  // failure: back to the owner, a round, the details on the timeline; the cap escalates
  const failing = await s.tasks.create(orgId, { title: 'Failing', brief: { outcome: 'o', done_when: 'x' }, assigneeAgentId: s.writer.id, checks: [{ kind: 'http_status', url: `${url}/missing`, status: 200 }] });
  const back = await s.runtime.execute(writer, 'org_request_review', { taskId: failing.id });
  assert.match(back, /did not pass its checks — it is back with you \(todo, review round 1 of 3\)/);
  const f1 = await s.tasks.get(orgId, failing.id);
  assert.equal(f1.status, 'todo'); assert.equal(f1.reviewRounds, 1);
  const comment = (await s.tasks.messages(orgId, { taskId: failing.id })).at(-1)!;
  assert.match(comment.text, /Changes requested \(round 1\/3\): checks failed — 1\. GET .*\/missing answers 200: fail — GET .* answered 404/);
  assert.ok(s.wakes.some((w) => w.taskId === failing.id && w.agentId === s.writer.id && w.reason === 'comment'), 'the owner is woken');
  await s.tasks.requestReview(orgId, failing.id, { fromAgentId: s.writer.id });
  await s.tasks.requestReview(orgId, failing.id, { fromAgentId: s.writer.id });
  await s.tasks.requestReview(orgId, failing.id, { fromAgentId: s.writer.id });
  const capped = await s.tasks.get(orgId, failing.id);
  assert.equal(capped.status, 'blocked', 'the fourth failing round escalates');
  assert.ok((await s.approvals.pending(orgId)).some((a) => a.kind === 'escalation' && JSON.parse(a.payload).taskId === failing.id));
  // error: normal review plus a note
  const erring = await s.tasks.create(orgId, { title: 'Erring', brief: { outcome: 'o' }, assigneeAgentId: s.writer.id, checks: [{ kind: 'metric_at_least', sourceId: 'nope', value: 1 }] });
  const er = await s.tasks.requestReview(orgId, erring.id, { fromAgentId: s.writer.id });
  assert.equal(er.status, 'in_review');
  assert.ok((await s.tasks.messages(orgId, { taskId: erring.id })).some((m) => /Checks could not run .*no metric source "nope"/.test(m.text)));
  // a review acceptance and a hand-set done
  await s.tasks.review(orgId, erring.id, { verdict: 'accept', byAgentId: er.reviewerAgentId });
  const manual = await s.tasks.create(orgId, { title: 'Manual', brief: { outcome: 'o' } });
  await s.tasks.update(orgId, manual.id, { status: 'done' });
  const board = await s.controller.board(s.ws.id);
  const v = (title: string) => (board as Array<{ title: string; verification: string | null }>).find((t) => t.title === title)!.verification;
  assert.equal(v('Publish status page'), 'check');
  assert.equal(v('Erring'), 'review');
  assert.equal(v('Manual'), 'none');
  assert.equal(v('Both'), null, 'not done yet');
  // the brief
  const b = await s.brief.compose(orgId);
  assert.match(b.text, /33% of tasks accepted by check this week \(1 of 3\)/);
  // a task without checks reviews as before
  const plain = await s.tasks.create(orgId, { title: 'Plain', brief: { outcome: 'o' }, assigneeAgentId: s.writer.id });
  assert.equal((await s.tasks.requestReview(orgId, plain.id, { fromAgentId: s.writer.id })).status, 'in_review');
  await s.db.update(orgTasks).set({ status: 'todo' }).where(eq(orgTasks.id, plain.id));
});

// ---- 11. tunables ----

test('sensing tunables register with defaults and bounds in the sensing area; values outside the fence are refused', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const want: Record<string, [number, number, number]> = { 'sensing.staleMultiplier': [3, 1, 20], 'sensing.minPollMinutes': [5, 1, 1_440], 'acceptance.alsoReviewWhenChecksPass': [0, 0, 1], 'acceptance.checkTimeoutSeconds': [10, 2, 60] };
  for (const [k, [d, min, max]] of Object.entries(want)) {
    assert.deepEqual([TUNABLES[k].default, TUNABLES[k].min, TUNABLES[k].max, TUNABLES[k].area], [d, min, max, 'sensing'], k);
    assert.equal(checkTunable(k, min - 1).ok, false);
    assert.equal(checkTunable(k, max + 1).ok, false);
    assert.equal(checkTunable(k, max).ok, true);
  }
  await assert.rejects(s.org.setTunable(orgId, 'sensing.staleMultiplier', 50, { actor: 'user' }), /1–20|between 1 and 20|within 1/);
  await s.org.setTunable(orgId, 'sensing.minPollMinutes', 30, { actor: 'user' });
  const src = await s.sensingApi.create(orgId, { name: 'Slow', kind: 'manual_attested', pollMinutes: 10 });
  assert.equal(src.source.pollMinutes, 30);
  assert.ok(describeTunables(await s.org.get(orgId)).some((t) => t.key === 'sensing.minPollMinutes' && t.value === 30));
});
