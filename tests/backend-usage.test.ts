/** Cost dashboard + spend stop (roadmap phase 2.5): the price table and its
 *  override hatch, the per-day/per-kind usage aggregation, and the workspace
 *  month counter that turns feed and the budget check reads. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import { priceFor, usdFor, parsePriceOverrides, LIST_PRICES } from '../server/src/ai/pricing';
import { UsageService } from '../server/src/usage/usage.module';
import { SettingsService } from '../server/src/settings/settings.module';
import { AgentsService } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { spendStatus } from '../server/src/workspaces/spend.util';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub, ScriptedProvider } from './helpers';
import { AiStreamEvent } from '../server/src/ai/ai-provider.interface';

test('priceFor: exact ids, date suffixes, longest prefix, family fallback, unknown → null', () => {
  assert.deepEqual(priceFor('claude-sonnet-4-5'), { input: 3, output: 15 });
  assert.deepEqual(priceFor('claude-sonnet-4-5-20250929'), { input: 3, output: 15 }, 'dated release maps to its id');
  assert.deepEqual(priceFor('gpt-4.1-mini-2025-04-14'), { input: 0.4, output: 1.6 }, 'longest prefix, not gpt-4.1');
  assert.deepEqual(priceFor('kimi-k2-0905-preview'), LIST_PRICES['kimi-k2']);
  assert.deepEqual(priceFor('models/gemini-2.5-flash'), { input: 0.3, output: 2.5 }, 'gateway prefixes are stripped');
  assert.deepEqual(priceFor('claude-opus-5-5'), { input: 5, output: 25 }, 'unknown opus release prices as the family');
  assert.deepEqual(priceFor('glm-4.7-flash'), { input: 0, output: 0 });
  assert.equal(priceFor('llama-3-70b'), null, 'unknown models are unpriced, never $0');
  assert.equal(priceFor(''), null);
  assert.equal(usdFor('claude-sonnet-4-5', 1_000_000, 1_000_000), 18);
  assert.equal(usdFor('mystery-model', 10, 10), null);
});

test('pricingOverrides merge over the list table and drop malformed entries', () => {
  const overrides = parsePriceOverrides(JSON.stringify({
    'claude-sonnet-4-5': { input: 1, output: 2 },
    'my-gateway/llama-3-70b': { input: 0.5, output: 0.5 },
    'bad': { input: 'free' },
    'negative': { input: -1, output: 1 },
  }));
  assert.deepEqual(Object.keys(overrides).sort(), ['claude-sonnet-4-5', 'llama-3-70b']);
  assert.deepEqual(priceFor('claude-sonnet-4-5', overrides), { input: 1, output: 2 });
  assert.deepEqual(priceFor('llama-3-70b', overrides), { input: 0.5, output: 0.5 });
  assert.deepEqual(parsePriceOverrides('{nope'), {});
  assert.deepEqual(parsePriceOverrides(''), {});
});

const DAY = 24 * 60 * 60_000;

async function setup(rounds: AiStreamEvent[][] = []) {
  const db = await testDb();
  const { stub } = memStorage();
  const settings = new SettingsService(db);
  const agents = new AgentsService(db, stub);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const provider = new ScriptedProvider(rounds);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(provider), skillsStub(), stub, mcpStub(), agents, workspaces);
  const usage = new UsageService(db, settings);
  const ws = (await workspaces.list())[0];
  return { db, settings, agents, workspaces, repo, turns, usage, provider, ws };
}

/** A finished turn with the given tokens, stamped `daysAgo` days back. */
async function turnAt(repo: ChatsRepository, sessionId: string, daysAgo: number, tokensIn: number, tokensOut: number, now: Date, model = '') {
  const t = await repo.createTurn(sessionId, { text: 'x', model });
  await repo.updateTurn(t.id, { status: 'done', tokensIn, tokensOut, createdAt: new Date(now.getTime() - daysAgo * DAY).toISOString() });
}

test('agent usage: per-day series with zeros filled, per-kind buckets (chat / each loop / channel), USD from the price table', async () => {
  const { agents, repo, usage, ws, settings } = await setup();
  const now = new Date('2026-10-31T12:00:00Z');
  const agent = await agents.create({ name: 'Ledger', model: 'claude-sonnet-4-5' });
  const chat = await repo.createSession({ workspaceId: ws.id, agentId: agent.id, name: 'Invoices' });
  const loopA = await repo.createSession({ workspaceId: ws.id, agentId: agent.id, name: 'Loop · Nightly check', model: 'claude-haiku-4-5' });
  const loopB = await repo.createSession({ workspaceId: ws.id, agentId: agent.id, name: 'Loop · Weekly digest' });
  const tg = await repo.createSession({ workspaceId: ws.id, agentId: agent.id, name: 'Telegram · Ledger' });
  const other = await repo.createSession({ workspaceId: ws.id, agentId: (await agents.create({ name: 'Other' })).id, name: 'not mine' });

  await turnAt(repo, chat.id, 0, 1_000_000, 0, now);            // $3 at sonnet (agent default model)
  await turnAt(repo, chat.id, 2, 0, 1_000_000, now);            // $15
  await turnAt(repo, loopA.id, 1, 1_000_000, 1_000_000, now);   // haiku session model: $1 + $5
  await turnAt(repo, loopB.id, 5, 100, 100, now, 'mystery-model'); // unpriced
  await turnAt(repo, tg.id, 0, 10, 10, now);
  await turnAt(repo, other.id, 0, 999, 999, now);               // another agent: excluded
  await turnAt(repo, chat.id, 40, 1_000_000, 0, now);           // outside the 30-day window

  const report = await usage.agentUsage(agent.id, 30, now);
  assert.equal(report.series.length, 30);
  assert.equal(report.series[0].day, '2026-10-02');
  assert.equal(report.series.at(-1)!.day, '2026-10-31');
  assert.equal(report.series.at(-1)!.tokensIn, 1_000_010);
  assert.equal(report.series.at(-3)!.usd, 15, 'two days ago: the $15 output-heavy chat turn');
  assert.equal(report.series.at(-2)!.usd, 6, 'yesterday: the haiku loop');
  assert.equal(report.series[10].tokensIn, 0, 'quiet days are present as zeros');

  assert.equal(report.totals.tokensIn, 2_000_110);
  assert.equal(report.totals.tokensOut, 2_000_110);
  assert.equal(report.totals.turns, 5);
  assert.ok(Math.abs(report.totals.usd - (3 + 15 + 6 + 0.00018)) < 1e-9, `usd ${report.totals.usd}`);
  const kinds = Object.fromEntries(report.byKind.map((b) => [b.key, b]));
  assert.equal(kinds.chat.usd, 18);
  assert.equal(kinds.chat.turns, 2);
  assert.equal(kinds.chat.sessionId, undefined);
  assert.equal(kinds['loop:Nightly check'].label, 'Nightly check');
  assert.equal(kinds['loop:Nightly check'].kind, 'loop');
  assert.equal(kinds['loop:Nightly check'].sessionId, loopA.id);
  assert.equal(kinds['loop:Weekly digest'].usd, 0);
  assert.equal(kinds['loop:Weekly digest'].tokensIn, 100, 'tokens count even when dollars cannot');
  assert.equal(kinds.channel.label, 'Telegram');
  assert.deepEqual(report.unpricedModels, ['mystery-model']);

  // an override prices the mystery model and changes sonnet
  await settings.put({ pricingOverrides: JSON.stringify({ 'mystery-model': { input: 10, output: 10 }, 'claude-sonnet-4-5': { input: 1, output: 1 } }) });
  const priced = await usage.agentUsage(agent.id, 30, now);
  assert.deepEqual(priced.unpricedModels, []);
  assert.equal(Object.fromEntries(priced.byKind.map((b) => [b.key, b.usd]))['loop:Weekly digest'], 0.002);
  assert.ok(Math.abs(priced.totals.usd - (1 + 1 + 6 + 0.002 + 0.00002)) < 1e-9, `usd ${priced.totals.usd}`);

  const table = await usage.pricing();
  assert.deepEqual(table.overridden.sort(), ['claude-sonnet-4-5', 'mystery-model']);
  assert.deepEqual(table.prices['claude-sonnet-4-5'], { input: 1, output: 1 });
  assert.match(table.note, /List prices, Oct 2026/);
});

test('workspace usage: per-agent totals across the workspace plus the month budget state', async () => {
  const { agents, repo, usage, ws, workspaces } = await setup();
  const now = new Date('2026-10-31T12:00:00Z');
  const a = await agents.create({ name: 'Alpha', model: 'gpt-4o' });        // 2.5 / 10
  const b = await agents.create({ name: 'Beta', model: 'deepseek-chat' });  // 0.28 / 0.42
  const sa = await repo.createSession({ workspaceId: ws.id, agentId: a.id, name: 'a' });
  const sb = await repo.createSession({ workspaceId: ws.id, agentId: b.id, name: 'Loop · Pulse' });
  const direct = await repo.createSession({ workspaceId: ws.id, name: 'direct', model: 'gpt-4o-mini' });
  const elsewhere = await repo.createSession({ workspaceId: 'other-ws', agentId: a.id, name: 'elsewhere' });
  await turnAt(repo, sa.id, 0, 1_000_000, 0, now);
  await turnAt(repo, sb.id, 1, 1_000_000, 1_000_000, now);
  await turnAt(repo, direct.id, 1, 1_000_000, 0, now);
  await turnAt(repo, elsewhere.id, 0, 1_000_000, 0, now);
  await workspaces.update(ws.id, { spendBudgetTokens: 10_000_000 });
  await workspaces.addSpend(ws.id, 4_000_000, now);

  const report = await usage.workspaceUsage(ws.id, 7, now);
  assert.equal(report.series.length, 7);
  assert.equal(report.totals.turns, 3, 'the other workspace is excluded');
  assert.deepEqual(report.byAgent.map((x) => [x.name, x.usd]), [['Alpha', 2.5], ['Beta', 0.7], ['Direct chats', 0.15]], 'sorted by dollars');
  assert.equal(report.budget.month, '2026-10');
  assert.equal(report.budget.spentTokens, 4_000_000);
  assert.equal(report.budget.budgetTokens, 10_000_000);
  assert.equal(report.budget.over, false);
});

test('spend counter: completed turns add to the month, a new month starts over, concurrent adds do not lose increments', async () => {
  const { workspaces, ws } = await setup();
  const oct = new Date('2026-10-15T00:00:00Z');
  await Promise.all([1, 2, 3, 4, 5].map((n) => workspaces.addSpend(ws.id, n * 100, oct)));
  assert.equal((await workspaces.spend(ws.id, oct)).spentTokens, 1_500);
  assert.equal((await workspaces.spend(ws.id, oct)).over, false, 'no budget → never over');

  const nov = new Date('2026-11-01T00:00:00Z');
  assert.equal((await workspaces.spend(ws.id, nov)).spentTokens, 0, 'last month reads as zero in the new month');
  await workspaces.addSpend(ws.id, 42, nov);
  const row = await workspaces.get(ws.id);
  assert.equal(row.spendMonth, '2026-11');
  assert.equal(row.spendTokens, 42, 'the counter restarted instead of carrying October');
  assert.deepEqual(spendStatus({ spendBudgetTokens: 40, spendMonth: '2026-11', spendTokens: 42 }, nov),
    { month: '2026-11', spentTokens: 42, budgetTokens: 40, over: true });
});

test('turns feed the workspace counter; at the budget a user turn still runs with a `budget` notice and a loop turn is refused', async () => {
  const round: AiStreamEvent[] = [
    { type: 'answer', text: 'done.' },
    { type: 'usage', inputTokens: 600, outputTokens: 400 },
    { type: 'done' },
  ];
  const { agents, workspaces, repo, turns, ws, provider } = await setup([round, round, round]);
  const agent = await agents.create({ name: 'Worker' });
  const chat = await repo.createSession({ workspaceId: ws.id, agentId: agent.id, name: 'work' });
  const loop = await repo.createSession({ workspaceId: ws.id, agentId: agent.id, name: 'Loop · Tick', permissionMode: 'auto' });
  await workspaces.update(ws.id, { spendBudgetTokens: 1_500 });

  let types: string[] = [];
  for await (const ev of turns.run(chat.id, { text: 'go' })) types.push(ev.type);
  assert.ok(!types.includes('budget'), 'under budget: no notice');
  assert.equal((await workspaces.spend(ws.id)).spentTokens, 1_000, 'the turn’s tokens landed on the workspace month');

  for await (const ev of turns.run(loop.id, { text: 'tick', origin: 'loop' })) types.push(ev.type);
  assert.equal((await workspaces.spend(ws.id)).spentTokens, 2_000);
  assert.equal((await workspaces.spend(ws.id)).over, true);

  // over budget: the person still gets an answer, plus the notice right after the turn opens
  types = [];
  for await (const ev of turns.run(chat.id, { text: 'again' })) types.push(ev.type);
  assert.deepEqual(types.slice(0, 2), ['turn', 'budget']);
  assert.ok(types.includes('answer'), 'user turns are warned, not blocked');
  assert.equal(provider.requests.length, 3);

  // a loop turn is refused before the provider is touched
  await assert.rejects(async () => { for await (const _ of turns.run(loop.id, { text: 'tick', origin: 'loop' })) void _; }, ForbiddenException);
  assert.equal(provider.requests.length, 3, 'no model call for the refused loop turn');
  assert.equal((await repo.listTurns(loop.id)).length, 1, 'no turn row either');
});
