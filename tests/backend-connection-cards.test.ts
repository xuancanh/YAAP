/** Connection context cards (docs/company-vision.md §12, docs/integrations.md
 *  "Context cards and suggested loops"): the catalog validates, the card
 *  block reaches the system context only for held grants, the install route
 *  respects grant levels, a new grant writes the suggestion event, and the
 *  operating profile ranks suggested uses. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { CARDS, cardById, cardContextBlock, cardFor, loopForUse, mcpCardFor, rankUses, validateCards } from '../server/src/connections/cards';
import { CONNECTION_TOOLS } from '../server/src/connections/connections.tools';
import { ConnectionsService } from '../server/src/connections/connections.service';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { seal } from '../server/src/common/secretbox';
import { agentEvents, connections } from '../server/src/database/schema';
import type { LoopDef } from '../server/src/chats/loop-def';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub, ScriptedProvider } from './helpers';

const configStub = { get: (key: string) => ({ googleClientId: 'c', googleClientSecret: 's' })[key] } as unknown as ConfigService;
const FULL_GOOGLE_SCOPES = JSON.stringify([
  'https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file',
]);

async function setup() {
  const db = await testDb();
  const { stub } = memStorage();
  const agents = new AgentsService(db, stub);
  const workspaces = new WorkspacesService(db, stub);
  const conns = new ConnectionsService(db, configStub);
  await db.insert(connections).values({
    id: 'conn1', provider: 'google', accountEmail: 'user@example.com', scopes: FULL_GOOGLE_SCOPES,
    accessToken: seal('t'), refreshToken: seal('r'), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), createdAt: new Date().toISOString(),
  });
  return { db, stub, agents, workspaces, conns };
}

test('the catalog is sound: every card validates, every connection card names a real provider/service with tools, ids are unique', () => {
  assert.deepEqual(validateCards(), []);
  const expected = ['google-gmail', 'google-calendar', 'google-drive', 'microsoft-mail', 'microsoft-calendar', 'microsoft-files', 'telegram', 'email', 'web-push', 'browser', 'computer'];
  assert.deepEqual(CARDS.map((c) => c.id), expected);
  for (const card of CARDS.filter((c) => c.provider)) {
    assert.ok(CONNECTION_TOOLS.some((t) => t.provider === card.provider && t.service === card.service), `${card.id} matches a tool's provider/service`);
    // The capability lines name the real tools of that provider + service.
    const toolNames = CONNECTION_TOOLS.filter((t) => t.provider === card.provider && t.service === card.service).map((t) => t.name);
    for (const line of [...card.capabilities.read, ...card.capabilities.write]) {
      const name = line.split(':')[0].trim();
      if (/^(gcal|gmail|drive|mscal|msmail|msdrive)_/.test(name)) assert.ok(toolNames.includes(name), `${card.id}: ${name} is a real tool`);
    }
    assert.ok(card.suggestedUses.length >= 2, `${card.id} has suggestions`);
  }
  // An MCP card builds from a server row and validates like the rest.
  const mcp = mcpCardFor({ id: 'srv1', name: 'Linear', tools: JSON.stringify(['list_issues', 'create_issue']) });
  assert.equal(mcp.id, 'mcp-linear');
  assert.deepEqual(mcp.capabilities, { read: ['list_issues'], write: ['create_issue'] });
  assert.deepEqual(validateCards([mcp]), []);
  // A broken card is caught.
  const broken = { ...cardById('browser')!, id: 'broken', suggestedUses: [{ id: 'x', title: 'x', why: 'x', grantLevel: 'read' as const, loop: { name: 'x', cron: '61 * * * *' } }] };
  assert.match(validateCards([broken]).join('; '), /never matches/);
});

test('the card block reaches the system context only for held grants, at the held level', async () => {
  const s = await setup();
  const a = await s.agents.create({ name: 'Planner' });
  assert.equal(await s.conns.cardContext(a.id), null, 'nothing held, nothing injected');
  await s.conns.setGrant('conn1', a.id, 'calendar', 'read');
  const block = (await s.conns.cardContext(a.id))!;
  assert.match(block, /## Google Calendar \(read\)/);
  assert.match(block, /gcal_upcoming/);
  assert.doesNotMatch(block, /gcal_create_event/, 'write tools are not listed for a read grant');
  assert.doesNotMatch(block, /Gmail/, 'ungranted services are absent');
  await s.conns.setGrant('conn1', a.id, 'calendar', 'write');
  assert.match((await s.conns.cardContext(a.id))!, /gcal_create_event/);
  // Surface cards appear only when the caller says the tools are on offer.
  const withBrowser = (await s.conns.cardContext(a.id, '', { browser: true, mcp: [{ id: 's1', name: 'Linear', tools: '["list_issues"]' }] }))!;
  assert.match(withBrowser, /## Browser tool/);
  assert.match(withBrowser, /## MCP server: Linear/);
  // Bounded: many cards collapse to a named tail rather than growing the prompt.
  const many = cardContextBlock(CARDS.map((card) => ({ card, level: 'write' as const })))!;
  assert.ok(many.length <= 2_700, `block is ${many.length} chars`);
  assert.match(many, /Also granted/);

  // End to end: a real agent turn carries the block in its system prompt.
  const provider = new ScriptedProvider([[{ type: 'answer', text: 'ok' }, { type: 'done' }], [{ type: 'answer', text: 'ok' }, { type: 'done' }]]);
  const repo = new ChatsRepository(s.db);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(s.stub), ctxStub(provider), skillsStub(), s.stub, mcpStub(), s.agents, s.workspaces, s.conns);
  const ws = (await s.workspaces.list())[0];
  const session = await repo.createSession({ workspaceId: ws.id, agentId: a.id, name: 'cards' });
  for await (const ev of turns.run(session.id, { text: 'hello' })) void ev;
  assert.match(provider.requests[0].system ?? '', /Your connections[\s\S]*## Google Calendar \(write\)/);
  const other = await s.agents.create({ name: 'Nobody' });
  const bare = await repo.createSession({ workspaceId: ws.id, agentId: other.id, name: 'bare' });
  for await (const ev of turns.run(bare.id, { text: 'hello' })) void ev;
  assert.doesNotMatch(provider.requests[1].system ?? '', /Your connections/);
});

test('installing a suggested loop needs the grant level; the loop lands uniquely named and editable', async () => {
  const s = await setup();
  const a = await s.agents.create({ name: 'Installer' });
  await assert.rejects(s.agents.installSuggestedLoop(a.id, 'google-calendar', 'day-plan', null), /holds no calendar grant/);
  await s.conns.setGrant('conn1', a.id, 'calendar', 'read');
  await s.conns.setGrant('conn1', a.id, 'drive', 'read');
  const held = (await s.conns.grantLevels(a.id)).find((g) => g.service === 'calendar')!.level;
  const { loop } = await s.agents.installSuggestedLoop(a.id, 'google-calendar', 'day-plan', held);
  assert.equal(loop.name, 'Plan of the day');
  assert.equal(loop.cron, '0 7 * * 1-5');
  const loops = JSON.parse((await s.agents.get(a.id)).loops) as LoopDef[];
  assert.ok(loops.some((l) => l.name === 'Plan of the day' && !l.builtin), 'an ordinary loop afterwards');
  // Same use twice: a unique name.
  const second = await s.agents.installSuggestedLoop(a.id, 'google-calendar', 'day-plan', held);
  assert.equal(second.loop.name, 'Plan of the day 2');
  // A write-level use is refused on a read grant.
  await assert.rejects(s.agents.installSuggestedLoop(a.id, 'google-drive', 'export-weekly-report', 'read'), /needs a write grant/);
  await assert.rejects(s.agents.installSuggestedLoop(a.id, 'google-drive', 'nope', 'read'), /no suggested use/);
  await assert.rejects(s.agents.installSuggestedLoop(a.id, 'no-such-card', 'x', null), /no context card/);
  // A trigger loop installs with its trigger intact.
  const brief = await s.agents.installSuggestedLoop(a.id, 'google-calendar', 'external-briefing', held);
  assert.equal(brief.loop.trigger?.kind, 'calendar');
  // Surface cards need no grant.
  const browser = await s.agents.installSuggestedLoop(a.id, 'browser', 'competitor-check', null);
  assert.equal(browser.loop.name, 'Competitor page check');
  assert.equal(loopForUse(cardFor('google', 'gmail')!.suggestedUses[0], [{ name: 'Morning mail digest' }, { name: 'Morning mail digest 2' }]).name, 'Morning mail digest 3');
});

test('a new grant writes the "New connection" event with the card id and the uses the level unlocks', async () => {
  const s = await setup();
  const a = await s.agents.create({ name: 'Granted' });
  await s.conns.setGrant('conn1', a.id, 'gmail', 'write');
  const events = await s.db.select().from(agentEvents).where(eq(agentEvents.agentId, a.id));
  const ev = events.find((e) => e.title.startsWith('New connection: Gmail'));
  assert.ok(ev, 'event written');
  assert.match(ev!.title, /3 suggested uses/);
  const payload = JSON.parse(ev!.payload) as { cardId: string; service: string; level: string; useIds: string[] };
  assert.equal(payload.cardId, 'google-gmail');
  assert.equal(payload.level, 'write');
  assert.deepEqual(payload.useIds, ['weekday-digest', 'vip-reply-draft', 'invoice-watch']);
  assert.equal(ev!.silent, 1, 'inbox-only, never pushed');
  assert.ok(ev!.readAt, 'informational: never lights the badge');
  assert.equal(ev!.forMemberAccountId, '', 'the owner\'s grant is for everyone');
  // Re-granting (a level change) does not repeat the event.
  await s.conns.setGrant('conn1', a.id, 'gmail', 'write');
  assert.equal((await s.db.select().from(agentEvents).where(eq(agentEvents.agentId, a.id))).filter((e) => e.title.startsWith('New connection')).length, 1);
  // A read grant only lists the read-level uses.
  const b = await s.agents.create({ name: 'Reader' });
  await s.conns.setGrant('conn1', b.id, 'drive', 'read');
  const rev = (await s.db.select().from(agentEvents).where(eq(agentEvents.agentId, b.id))).find((e) => e.title.startsWith('New connection: Google Drive'))!;
  assert.match(rev.title, /1 suggested use$/);
});

test('the operating profile ranks suggested uses without a model call', async () => {
  const gmail = cardById('google-gmail')!;
  assert.deepEqual(gmail.suggestedUses.map((u) => u.id), ['weekday-digest', 'vip-reply-draft', 'invoice-watch']);
  assert.deepEqual(rankUses(gmail.suggestedUses, 'A finance operations team closing the books monthly.').map((u) => u.id), ['invoice-watch', 'weekday-digest', 'vip-reply-draft']);
  assert.deepEqual(rankUses(gmail.suggestedUses, '').map((u) => u.id), ['weekday-digest', 'vip-reply-draft', 'invoice-watch'], 'no profile keeps the card order');
  // Untagged uses sit between tagged hits and tagged misses.
  const mixed = [
    { ...gmail.suggestedUses[0], id: 'a', fits: ['sales'] },
    { ...gmail.suggestedUses[0], id: 'b', fits: undefined },
    { ...gmail.suggestedUses[0], id: 'c', fits: ['research'] },
  ];
  assert.deepEqual(rankUses(mixed, 'a research lab').map((u) => u.id), ['c', 'b', 'a']);
  const s = await setup();
  const ranked = s.conns.cards('sales').find((c) => c.id === 'google-gmail')!;
  assert.equal(ranked.suggestedUses[0].id, 'weekday-digest', 'two hits tie on card order; sales fits digest and vip');
  assert.equal(s.conns.cards('finance').find((c) => c.id === 'google-gmail')!.suggestedUses[0].id, 'invoice-watch');
});
