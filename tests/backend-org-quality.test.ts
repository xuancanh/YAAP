/** Quality control of results and policies (docs/quality.md): standards as
 *  data with criteria graded 1–5; evidence-gated submissions verified
 *  model-free with remediation that names what is missing; an independent
 *  verifier whose scores gate the accept; QC results, first-pass yield,
 *  rework and escapes; spot checks of accepted work; policies as
 *  enforceable predicates before tool calls (through the turn loop) and at
 *  review, with violations, exceptions, signals and incidents; authoring
 *  routed by the boundary, the mode and the tunables. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { setup, enable, sessionOf, call, say, type S } from './org-governance-harness';
import { memStorage } from './helpers';
import { WorkspaceFs } from '../server/src/files/workspace-fs.service';
import { OrgQualityService } from '../server/src/org/org-quality.service';
import { OrgQualityTools } from '../server/src/org/org-quality.tools';
import { deriveOperatingSystem } from '../server/src/org/chief-os';
import { QUALITY_TUNABLES, deriveQualityTunables } from '../server/src/org/quality-tunables';
import { checkBoundary, ruleFor } from '../server/src/org/boundary';
import {
  evaluateRule, evidenceGaps, grade, normalizeCriteria, normalizeEvidence, normalizePolicy, normalizeScores, normalizeStandard, parseEvidenceRef,
  policyLoosens, qualityFigures, sampled, standardLoosens,
} from '../server/src/org/quality-model';
import { orgQcResults, actionLog } from '../server/src/database/schema';
import { summarize } from '../server/src/org/org-approvals.service';
import type { ChatSession } from '../server/src/chats/chats.repository';

function wire(s: S) {
  const fs = new WorkspaceFs(memStorage().stub as never, s.db);
  const quality = new OrgQualityService(s.db, s.org, s.tasks, s.audit, s.approvals, s.agents, s.config, s.units, s.signals, s.incidents, s.actions, s.trust, fs, undefined, s.workspaces);
  const tools = new OrgQualityTools(s.org, quality, s.tasks, s.config, s.units, s.runtime, s.turns);
  return { fs, quality, tools };
}

const RESEARCH = {
  name: 'Research brief', scopeKind: 'deliverable', scopeRef: 'research', passScore: 3.5,
  criteria: [
    { id: 'answer', text: 'Answers the question', weight: 2, evidence: ['file'] },
    { id: 'sources', text: 'Claims cite fetched sources', weight: 3, min: 3, evidence: ['url'] },
    { id: 'clarity', text: 'Clear', weight: 1, evidence: ['none'] },
  ],
};

async function researchTask(s: S, orgId: string) {
  return s.tasks.create(orgId, { title: 'Research competitor pricing', brief: { outcome: 'A pricing summary', done_when: 'a file under /org/research/' }, assigneeAgentId: s.writer.id, status: 'in_progress', class: 'research' });
}

// ---- the pure half ----

test('standards, evidence refs, grading and predicates are pure and validated with messages that name the fix', () => {
  assert.throws(() => normalizeCriteria([]), /at least one criterion/);
  assert.throws(() => normalizeCriteria([{ text: 'x', min: 9 }]), /min must be within 1–5/);
  assert.throws(() => normalizeCriteria([{ text: 'x', evidence: ['vibes'] }]), /evidence "vibes"/);
  assert.throws(() => normalizeStandard({ name: 'X', scopeKind: 'deliverable', criteria: ['a'] }, { passScore: 3.5 }), /scopeRef is required/);
  const std = normalizeStandard(RESEARCH, { passScore: 3 });
  assert.equal(std.slug, 'research-brief');
  assert.equal(std.criteria[1].min, 3);
  assert.deepEqual(parseEvidenceRef('file:/org/a.md#sha256=abcdef12'), { kind: 'file', ref: '/org/a.md', hash: 'abcdef12', raw: 'file:/org/a.md#sha256=abcdef12' });
  assert.equal(parseEvidenceRef('https://x.test/a')?.kind, 'url');
  assert.equal(parseEvidenceRef('/org/a.md')?.kind, 'file');
  assert.equal(parseEvidenceRef('trust me'), null);
  const { cited, bad } = normalizeEvidence([{ criterion: 'answer', refs: ['file:/org/a.md'] }, { criterion: 'sources', refs: ['url:https://x.test', 'nonsense'] }]);
  assert.deepEqual(bad, ['nonsense']);
  const gaps = evidenceGaps(std.criteria, cited, (raw) => raw === 'file:/org/a.md');
  assert.deepEqual(gaps.map((g) => g.criterion.id), ['sources'], 'clarity is judged; sources lacks a verified url');
  const g = grade(std.criteria, normalizeScores([{ criterion: 'answer', score: 4 }, { criterion: 'sources', score: 2 }, { criterion: 'clarity', score: 5 }]), 3.5);
  assert.equal(g.pass, false);
  assert.deepEqual(g.below.map((b) => b.criterion.id), ['sources']);
  assert.equal(grade(std.criteria, normalizeScores({ answer: 4, sources: 4, clarity: 3 }), 3.5).pass, true);
  assert.equal(grade(std.criteria, normalizeScores({ answer: 4 }), 3.5).missing.length, 2);
  assert.equal(standardLoosens({ passScore: 4, criteria: std.criteria, requireEvidence: true }, { passScore: 3.5, criteria: std.criteria, requireEvidence: true }), true);
  assert.equal(standardLoosens({ passScore: 3.5, criteria: std.criteria, requireEvidence: true }, { passScore: 4, criteria: std.criteria, requireEvidence: true }), false);
  // policies: a price floor, a discount cap, a required disclaimer
  assert.throws(() => normalizePolicy({ statement: 'No sale below cost', rule: { require: [{ field: 'price', op: 'gte', value: 10 }] } }), /names the tools/);
  assert.throws(() => normalizePolicy({ statement: 'x', rule: { tools: ['shop_*'] } }), /require or rule.forbid/);
  assert.throws(() => normalizePolicy({ statement: 'x', rule: { tools: ['shop_*'], require: [{ field: 'price', op: 'gte', value: 'ten' }] } }), /needs a number/);
  const floor = normalizePolicy({ statement: 'No price below $10', rule: { tools: ['shop_set_*'], require: [{ field: 'price', op: 'gte', value: 10 }] }, remediation: 'Ask the CEO for a promotion' });
  assert.equal(evaluateRule(floor.rule, { price: 5 }).violated, true);
  assert.equal(evaluateRule(floor.rule, { price: 12 }).violated, false);
  const cap = normalizePolicy({ statement: 'Discounts at most 20%', rule: { tools: ['*'], when: [{ field: 'discount', op: 'exists' }], require: [{ field: 'discount', op: 'lte', value: 20 }] } });
  assert.equal(evaluateRule(cap.rule, { to: 'x' }).applies, false, 'when: no discount, no rule');
  assert.equal(evaluateRule(cap.rule, { discount: 35 }).violated, true);
  const disclaimer = normalizePolicy({ statement: 'Outward emails carry the disclaimer', appliesAt: 'both', rule: { tools: ['gmail_*'], require: [{ field: '*', op: 'contains', value: 'Not financial advice' }] } });
  assert.match(evaluateRule(disclaimer.rule, { body: 'Buy now' }).failed[0], /required: \* contains Not financial advice/);
  assert.equal(policyLoosens({ enforcement: 'block', severity: 'high', status: 'active' }, { enforcement: 'warn', severity: 'high', status: 'active' }), true);
  // metrics and sampling
  const row = (taskId: string, outcome: string, at: string, extra: Record<string, unknown> = {}) => ({ taskId, kind: 'review', outcome, round: 0, makerAgentId: 'a', unitId: null, standardId: null, escapedAt: null, createdAt: at, independence: 'different_family', ...extra });
  const f = qualityFigures([row('t1', 'pass', '1'), row('t2', 'rework', '1'), row('t2', 'pass', '2', { escapedAt: '3' }), row('t3', 'pending', '1')]);
  assert.equal(f.tasks, 2);
  assert.equal(f.firstPassYield, 0.5);
  assert.equal(f.reworkRate, 0.5);
  assert.equal(f.escapes, 1);
  assert.equal(sampled('task-1', 100), true);
  assert.equal(sampled('task-1', 0), false);
  assert.equal(sampled('task-x', 37), sampled('task-x', 37), 'deterministic');
});

test('quality tunables come from the profile within their bounds; the boundary keeps loosening for the CEO', () => {
  const strict = deriveOperatingSystem({ values: 'Rigour, evidence and compliance', culture: 'formal process and audit' });
  const light = deriveOperatingSystem({ values: 'Move fast, ship daily', culture: 'experiment and iterate' });
  const val = (os: ReturnType<typeof deriveOperatingSystem>, k: string) => os.tunables.find((t) => t.key === k)?.value;
  for (const k of Object.keys(QUALITY_TUNABLES)) assert.ok(strict.tunables.some((t) => t.key === k), `derived ${k}`);
  assert.ok(val(strict, 'quality.defaultPassScore')! > val(light, 'quality.defaultPassScore')!);
  assert.ok(val(strict, 'quality.spotCheckPct')! > val(light, 'quality.spotCheckPct')!);
  assert.equal(val(strict, 'quality.verifierIndependence'), 2);
  for (const t of deriveQualityTunables({ stage: 'early', cultureType: 'clan', speed: false, rigor: false })) {
    const def = QUALITY_TUNABLES[t.key];
    assert.ok(t.value >= def.min && t.value <= def.max, t.key);
  }
  assert.equal(ruleFor({ kind: 'policy' }).verdict, 'alone');
  assert.equal(ruleFor({ kind: 'policy', loosens: true }).verdict, 'propose');
  assert.equal(ruleFor({ kind: 'quality_standard', loosens: true }).verdict, 'propose');
  assert.equal(ruleFor({ kind: 'tunable', key: 'quality.spotCheckPct' }).verdict, 'propose');
  assert.equal(checkBoundary({ kind: 'policy', loosens: true }, 'chief').outcome, 'card');
  assert.equal(checkBoundary({ kind: 'policy', loosens: true }, 'user').outcome, 'proceed');
});

// ---- results ----

test('a submission must cite real evidence per criterion: refusals name what is missing; verified refs open a QC round', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const { fs, quality } = wire(s);
  const created = await quality.createStandard(orgId, RESEARCH, 'user');
  assert.equal(created.applied, true, 'a person sets it at once');
  const t = await researchTask(s, orgId);
  await assert.rejects(() => s.tasks.requestReview(orgId, t.id, { fromAgentId: s.writer.id, note: 'done' }), (err: Error) => {
    assert.match(err.message, /quality standard "Research brief" v1/);
    assert.match(err.message, /Missing evidence for: answer .*cite file:.*sources .*cite url:/);
    assert.doesNotMatch(err.message, /Missing evidence for: [^.]*clarity/, 'a judged criterion needs no evidence');
    assert.match(err.message, /org_request_review again with evidence/);
    return true;
  });
  // fabricated: a file that does not exist and a URL nothing fetched
  await assert.rejects(() => s.tasks.requestReview(orgId, t.id, { fromAgentId: s.writer.id, evidence: [{ criterion: 'answer', refs: ['file:/org/research/pricing.md'] }, { criterion: 'sources', refs: ['url:https://rival.test/pricing'] }] }), (err: Error) => {
    assert.match(err.message, /Not verifiable: file:\/org\/research\/pricing\.md \(no file \/org\/research\/pricing\.md\); url:https:\/\/rival\.test\/pricing \(no tool call of yours fetched it/);
    return true;
  });
  assert.equal((await s.tasks.get(orgId, t.id)).status, 'in_progress', 'nothing moved');
  // real: the file exists, the URL was fetched by the maker's tool call
  await fs.write(s.ws.id, 'org/research/pricing.md', Buffer.from('Rival charges $12 (source: https://rival.test/pricing)'), { by: { kind: 'system', id: 'system', name: 'system' } });
  quality.noteToolCall(s.writer.id, 'web_fetch', { url: 'https://rival.test/pricing' }, false);
  const after = await s.tasks.requestReview(orgId, t.id, { fromAgentId: s.writer.id, evidence: [{ criterion: 'answer', refs: ['file:/org/research/pricing.md'] }, { criterion: 'sources', refs: ['https://rival.test/pricing'] }] });
  assert.equal(after.status, 'in_review');
  const [qc] = await quality.results(orgId, { taskId: t.id });
  assert.equal(qc.outcome, 'pending');
  assert.equal(qc.standardVersion, 1);
  assert.ok(JSON.parse(qc.evidence).every((c: { refs: Array<{ ok: boolean }> }) => c.refs.every((r) => r.ok)));
  const comments = await s.tasks.messages(orgId, { taskId: t.id });
  assert.ok(comments.some((m) => /Evidence verified: 2 reference\(s\) against quality standard "Research brief" v1/.test(m.text)));
});

test('the verifier must score every criterion; below the bar is rework, above it passes; FPY, rework and a reopened escape are measured', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const { fs, quality } = wire(s);
  await quality.createStandard(orgId, RESEARCH, 'user');
  const t = await researchTask(s, orgId);
  await fs.write(s.ws.id, 'org/research/pricing.md', Buffer.from('summary'), { by: { kind: 'system', id: 'system', name: 'system' } });
  quality.noteToolCall(s.writer.id, 'web_fetch', { url: 'https://rival.test/pricing' }, false);
  const evidence = [{ criterion: 'answer', refs: ['file:/org/research/pricing.md'] }, { criterion: 'sources', refs: ['url:https://rival.test/pricing'] }];
  await s.tasks.requestReview(orgId, t.id, { fromAgentId: s.writer.id, evidence, reviewerHumanId: null });
  await s.tasks.update(orgId, t.id, { reviewerAgentId: s.editor.id });
  await assert.rejects(() => s.tasks.review(orgId, t.id, { verdict: 'accept', byAgentId: s.editor.id }), /needs a score \(1–5\) for every criterion .*Missing: answer/);
  await assert.rejects(() => s.tasks.review(orgId, t.id, { verdict: 'accept', byAgentId: s.editor.id, scores: [{ criterion: 'answer', score: 4, evidence: ['file:/org/nope.md'] }, { criterion: 'sources', score: 4 }, { criterion: 'clarity', score: 4 }] }), /do not check out: file:\/org\/nope\.md/);
  const back = await s.tasks.review(orgId, t.id, { verdict: 'accept', byAgentId: s.editor.id, scores: [{ criterion: 'answer', score: 4 }, { criterion: 'sources', score: 2, note: 'two claims unsourced' }, { criterion: 'clarity', score: 4 }] });
  assert.equal(back.status, 'todo', 'below the bar: rework');
  let rows = await quality.results(orgId, { taskId: t.id });
  assert.equal(rows[0].outcome, 'rework');
  assert.equal(rows[0].independence, 'different_family');
  const msgs = await s.tasks.messages(orgId, { taskId: t.id });
  assert.ok(msgs.some((m) => /Below the bar of "Research brief": weighted score 3 is under the bar of 3\.5; sources scored 2 \(needs 3\).*Fix: sources: two claims unsourced/.test(m.text)), msgs.map((m) => m.text).join('\n'));
  // round two passes
  await s.tasks.requestReview(orgId, t.id, { fromAgentId: s.writer.id, evidence });
  await s.tasks.update(orgId, t.id, { reviewerAgentId: s.editor.id });
  const done = await s.tasks.review(orgId, t.id, { verdict: 'accept', byAgentId: s.editor.id, scores: { answer: 4, sources: 4, clarity: 4 } });
  assert.equal(done.status, 'done');
  rows = await quality.results(orgId, { taskId: t.id });
  assert.equal(rows[0].outcome, 'pass');
  assert.equal(rows[0].score, 4);
  let m = await quality.metrics(orgId);
  assert.equal(m.overall.firstPassYield, 0);
  assert.equal(m.overall.reworkRate, 1);
  assert.equal(m.byAgent[s.writer.id].tasks, 1);
  // reopened after acceptance: an escape, a rejection on the trust ledger, a signal
  await s.tasks.update(orgId, t.id, { status: 'todo' });
  m = await quality.metrics(orgId);
  assert.equal(m.overall.escapes, 1);
  const ledger = await s.trust.recent(s.ws.id, s.writer.id, 50) as unknown as Array<{ refType: string; outcome: string }>;
  assert.ok(ledger.some((r) => r.refType === 'qc' && r.outcome === 'rejected'), 'an escape is a rejection on the trust ledger');
  assert.ok((await s.signals.list(orgId)).some((x) => x.kind === 'quality_escape'));
});

test('verifier independence: at quality.verifierIndependence 2 the board picks another model family, and a same-family accept is refused', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const { quality } = wire(s);
  await s.org.setTunable(orgId, 'quality.verifierIndependence', 2, { actor: 'user' });
  // the chief and writer share a family; the editor is on another
  const t = await s.tasks.create(orgId, { title: 'Tidy the list', brief: { done_when: 'tidy' }, assigneeAgentId: s.writer.id, status: 'in_progress' });
  const models = new Map([[s.chief.id, { provider: 'anthropic', model: 'claude-sonnet-4-5' }], [s.writer.id, { provider: 'anthropic', model: 'claude-sonnet-4-5' }], [s.editor.id, { provider: 'openai', model: 'gpt-5' }]]);
  const r = await s.tasks.requestReview(orgId, t.id, { fromAgentId: s.writer.id, agentModels: models });
  assert.equal(r.reviewerAgentId, s.editor.id);
  await assert.rejects(() => s.tasks.review(orgId, t.id, { verdict: 'accept', byAgentId: s.chief.id }), /another model family than its maker's .*Editor is one/);
  const ok = await s.tasks.review(orgId, t.id, { verdict: 'accept', byAgentId: s.editor.id });
  assert.equal(ok.status, 'done', 'no standard: no scores required');
  assert.equal((await quality.results(orgId, { taskId: t.id }))[0].outcome, 'pass');
});

test('a result policy over the deliverable blocks the submission with its remediation; a judged one becomes a criterion the verifier scores', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const { fs, quality } = wire(s);
  await quality.createPolicy(orgId, { key: 'disclaimer', statement: 'Customer-facing copy carries the disclaimer', appliesAt: 'result', rule: { require: [{ field: 'text', op: 'contains', value: 'Not financial advice' }] }, enforcement: 'block', severity: 'high', remediation: 'Add "Not financial advice" at the end' }, 'user');
  await quality.createPolicy(orgId, { key: 'tone', statement: 'Never promise returns', kind: 'judged', appliesAt: 'result', rule: {}, enforcement: 'block' }, 'user');
  const t = await s.tasks.create(orgId, { title: 'Draft the newsletter', brief: { done_when: 'draft in /org/news.md' }, assigneeAgentId: s.writer.id, status: 'in_progress' });
  await fs.write(s.ws.id, 'org/news.md', Buffer.from('Buy our fund!'), { by: { kind: 'system', id: 'system', name: 'system' } });
  await assert.rejects(() => s.tasks.requestReview(orgId, t.id, { fromAgentId: s.writer.id, evidence: ['file:/org/news.md'] }), /Refused by policy "disclaimer" \(high\).*Instead: Add "Not financial advice" at the end/);
  assert.ok((await quality.violations(orgId)).some((v) => v.stage === 'result' && v.outcome === 'blocked'));
  assert.ok((await s.signals.list(orgId)).some((x) => x.kind === 'policy_violation'), 'a high violation reaches the chief');
  await fs.write(s.ws.id, 'org/news.md', Buffer.from('Buy our fund! Not financial advice.'), { by: { kind: 'system', id: 'system', name: 'system' } });
  await s.tasks.requestReview(orgId, t.id, { fromAgentId: s.writer.id, evidence: ['file:/org/news.md'] });
  await s.tasks.update(orgId, t.id, { reviewerAgentId: s.editor.id });
  await assert.rejects(() => s.tasks.review(orgId, t.id, { verdict: 'accept', byAgentId: s.editor.id }), /Missing: policy-tone/);
  const back = await s.tasks.review(orgId, t.id, { verdict: 'accept', byAgentId: s.editor.id, scores: [{ criterion: 'policy-tone', score: 2, note: 'promises 10% returns' }] });
  assert.equal(back.status, 'todo');
  const m = await quality.metrics(orgId);
  assert.equal(m.policies.resultConformance, 1, 'the deterministic check passed on the second submission');
});

// ---- policies at actions ----

/** A fake outward tool so the turn loop has something to guard. */
function shopTool(s: S) {
  const ran: Array<Record<string, unknown>> = [];
  s.turns.addToolProvider({
    specsFor: async () => [{ name: 'shop_set_price', description: 'Set a price', inputSchema: { type: 'object', properties: { price: { type: 'number' } } } }],
    owns: (n: string) => n === 'shop_set_price',
    isReadOnly: () => false,
    execute: async (_s: ChatSession, _n: string, input: Record<string, unknown>) => { ran.push(input); return 'price set'; },
    contextFor: async () => null,
  });
  return ran;
}

test('a predicate policy refuses a tool call before it runs, in a real turn, with remediation and a violation id; an approved exception lets the identical call through once', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const { quality } = wire(s);
  const ran = shopTool(s);
  await quality.createPolicy(orgId, { key: 'price-floor', statement: 'No price below $10', rule: { tools: ['shop_set_*'], require: [{ field: 'price', op: 'gte', value: 10 }] }, enforcement: 'block', severity: 'high', remediation: 'Keep the price at $10 or more, or ask the CEO for a promotion' }, 'user');
  const session = await sessionOf(s, s.writer.id);
  let price = 5;
  s.provider.plan = (_req, round) => (round === 0 ? call('shop_set_price', { price }) : say('done'));
  const events: Array<{ type: string; output?: string; name?: string }> = [];
  for await (const ev of s.turns.run(session.id, { text: 'set it', origin: 'loop' })) events.push(ev as never);
  const res = events.find((e) => e.type === 'tool_result' && e.name === 'shop_set_price');
  assert.match(res?.output ?? '', /Refused by policy "price-floor" \(high\): No price below \$10 — shop_set_price failed required: price gte 10\. Instead: Keep the price at \$10 or more.*org_policy_exception.*\(violation [0-9a-z]{8}\)/);
  assert.equal(ran.length, 0, 'nothing ran');
  const logged = await s.db.select().from(actionLog).where(eq(actionLog.tool, 'shop_set_price'));
  assert.equal(logged[0].status, 'refused');
  assert.equal(logged[0].decision, 'policy');
  const [v] = await quality.violations(orgId);
  assert.equal(v.outcome, 'blocked');
  // the exception: a card; approved → waived; the identical call runs once
  const { approvalId } = await quality.requestException(orgId, v.id.slice(0, 8), s.writer.id, 'A one-day launch promotion the CEO asked for');
  const card = await s.approvals.get(orgId, approvalId);
  assert.equal(card.kind, 'policy_exception');
  assert.match(summarize(card.kind, JSON.parse(card.payload)), /exception to policy "price-floor"/);
  await s.approvals.decide(orgId, approvalId, 'approve');
  assert.equal((await quality.violations(orgId))[0].status, 'waived');
  const g1 = await s.actions.guard(s.ws.id, { agentId: s.writer.id, sessionId: session.id, tool: 'shop_set_price', input: { price: 5 }, cls: 'external_reversible' });
  assert.equal(g1, null, 'waived once');
  const g2 = await s.actions.guard(s.ws.id, { agentId: s.writer.id, sessionId: session.id, tool: 'shop_set_price', input: { price: 5 }, cls: 'external_reversible' });
  assert.equal(g2?.outcome, 'block', 'and only once');
  price = 12;
  assert.equal(await s.actions.guard(s.ws.id, { agentId: s.writer.id, sessionId: session.id, tool: 'shop_set_price', input: { price }, cls: 'external_reversible' }), null);
  assert.equal(await s.actions.guard(s.ws.id, { agentId: s.writer.id, sessionId: session.id, tool: 'org_policy_exception', input: { price: 1 }, cls: 'internal_write' }), null, 'the quality tools are never blocked');
});

test('a warn policy lets the call run and tells the agent; repeated violations open an incident; a judged action policy asks a second key', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const { quality } = wire(s);
  const ran = shopTool(s);
  await s.org.setTunable(orgId, 'policy.repeatForIncident', 2, { actor: 'user' });
  await quality.createPolicy(orgId, { key: 'round-prices', statement: 'Prices end in .99', rule: { tools: ['shop_set_price'], require: [{ field: 'price', op: 'matches', value: '\\.99$' }] }, enforcement: 'warn', severity: 'low', remediation: 'Use a .99 price' }, 'user');
  const session = await sessionOf(s, s.writer.id);
  s.provider.plan = (_req, round) => (round === 0 ? call('shop_set_price', { price: 12 }) : say('done'));
  const events: Array<{ type: string; output?: string; name?: string }> = [];
  for await (const ev of s.turns.run(session.id, { text: 'set it', origin: 'loop' })) events.push(ev as never);
  const res = events.find((e) => e.type === 'tool_result' && e.name === 'shop_set_price');
  assert.equal(ran.length, 1, 'a warning does not stop it');
  assert.match(res?.output ?? '', /price set/);
  await s.actions.guard(s.ws.id, { agentId: s.writer.id, sessionId: session.id, tool: 'shop_set_price', input: { price: 13 }, cls: 'external_reversible' });
  const incidents = await s.incidents.list(orgId);
  assert.ok(incidents.some((i) => i.kind === 'policy_violation' && i.agentId === s.writer.id), 'two violations in the window');
  await quality.createPolicy(orgId, { key: 'fair', statement: 'Never mislead a customer about stock', kind: 'judged', rule: { tools: ['shop_*'] }, enforcement: 'block' }, 'user');
  const g = await s.actions.guard(s.ws.id, { agentId: s.writer.id, sessionId: session.id, tool: 'shop_set_price', input: { price: 9.99 }, cls: 'external_reversible' });
  assert.equal(g?.outcome, 'cosign');
  assert.match(g?.rules ?? '', /"fair": Never mislead a customer/);
});

// ---- authoring ----

test('authoring: supervised → a quality_change card the CEO approves; autonomous applies a warn policy but a blocking one is the CEO\'s; loosening is always a card; heads stay in their unit', async () => {
  const s = await setup();
  const orgId = await enable(s, 'supervised');
  const { quality, tools } = wire(s);
  const chiefSession = await sessionOf(s, s.chief.id);
  const out = await tools.execute(chiefSession, 'org_quality_standard', { action: 'create', template: 'research', why: 'research keeps coming back unsourced' });
  assert.match(out, /proposed \(card [0-9a-z]{8}\)/);
  const std = (await quality.listStandards(orgId))[0];
  assert.equal(std.status, 'proposed');
  const card = (await s.approvals.pending(orgId)).find((a) => a.kind === 'quality_change')!;
  assert.match(summarize(card.kind, JSON.parse(card.payload)), /create quality standard "Research brief"/);
  await s.approvals.decide(orgId, card.id, 'approve');
  assert.equal((await quality.standard(orgId, std.slug)).status, 'active');
  // autonomous
  await s.mode.setMode(s.ws.id, { mode: 'autonomous' });
  const warn = await tools.execute(chiefSession, 'org_policy', { action: 'create', key: 'tone', statement: 'Keep outward tone polite', rule: { tools: ['gmail_*'], forbid: [{ field: '*', op: 'contains', value: 'stupid' }] }, enforcement: 'warn', remediation: 'Rephrase' });
  assert.match(warn, /Policy "tone" v1 is active/);
  const block = await tools.execute(chiefSession, 'org_policy', { action: 'create', key: 'floor', statement: 'No price below $10', rule: { tools: ['shop_*'], require: [{ field: 'price', op: 'gte', value: 10 }] }, enforcement: 'block' });
  assert.match(block, /proposed \(card/, 'policy.authoringApproval 1: a blocking policy is the CEO\'s');
  const retire = await tools.execute(chiefSession, 'org_policy', { action: 'retire', policy: 'tone' });
  assert.match(retire, /waits on the CEO's card/, 'loosening is the boundary\'s propose');
  assert.equal((await quality.policy(orgId, 'tone')).status, 'active', 'unchanged until decided');
  const revise = await tools.execute(chiefSession, 'org_quality_standard', { action: 'revise', standard: 'research-brief', passScore: 4.5 });
  assert.match(revise, /is now v2/, 'raising the bar applies in autonomous mode');
  const lower = await tools.execute(chiefSession, 'org_quality_standard', { action: 'revise', standard: 'research-brief', passScore: 3 });
  assert.match(lower, /waits on the CEO's card/);
  // a specialist cannot author; the tool is not even offered
  const writerSession = await sessionOf(s, s.writer.id);
  const specs = await tools.specsFor(writerSession);
  assert.ok(!specs.some((x) => x.name === 'org_policy'));
  assert.ok(specs.some((x) => x.name === 'org_policy_exception'));
  await assert.rejects(() => quality.createPolicy(orgId, { key: 'x', statement: 'x', rule: { tools: ['a'], require: [{ field: 'a', op: 'exists' }] } }, `agent:${s.writer.id}`), /the chief of staff authors company standards and policies/);
});

// ---- spot checks ----

test('spot checks: a sampled accepted task is re-verified and re-graded by an independent member; a failed grade is an escape', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const { quality, tools } = wire(s);
  await s.org.setTunable(orgId, 'quality.spotCheckPct', 100, { actor: 'user' });
  const t = await s.tasks.create(orgId, { title: 'List the vendors', brief: { done_when: 'a list' }, assigneeAgentId: s.writer.id, status: 'in_progress' });
  await s.tasks.requestReview(orgId, t.id, { fromAgentId: s.writer.id });
  await s.tasks.update(orgId, t.id, { reviewerAgentId: s.chief.id });
  await s.tasks.review(orgId, t.id, { verdict: 'accept', byAgentId: s.chief.id });
  const r = await quality.spotCheck(orgId);
  assert.equal(r.sampled, 1);
  assert.equal(r.tasks, 1);
  const spot = (await quality.results(orgId, { taskId: t.id })).find((x) => x.kind === 'spot_check')!;
  assert.ok(spot.spotTaskId);
  const spotTask = await s.tasks.get(orgId, spot.spotTaskId!);
  assert.match(spotTask.title, /^QA spot check: /);
  assert.notEqual(spotTask.assigneeAgentId, s.writer.id, 'not its maker');
  assert.notEqual(spotTask.assigneeAgentId, s.chief.id, 'not its reviewer');
  const checker = spotTask.assigneeAgentId!;
  const out = await tools.execute(await sessionOf(s, checker), 'org_qc_grade', { task: t.key, pass: false, note: 'two vendors are invented' });
  assert.match(out, /Spot check recorded: fail/);
  assert.equal((await s.tasks.get(orgId, spotTask.id)).status, 'done');
  const m = await quality.metrics(orgId);
  assert.equal(m.overall.escapes, 1);
  assert.equal(m.overall.spotCheckFails, 1);
  const rows = await s.db.select().from(orgQcResults).where(eq(orgQcResults.taskId, t.id));
  assert.ok(rows.some((x) => x.kind === 'review' && x.escapeReason.startsWith('failed a spot check')));
});

test('the maker and the verifier see the standard in their run context; the tools describe the company\'s quality', async () => {
  const s = await setup();
  const orgId = await enable(s);
  const { quality, tools } = wire(s);
  await quality.createStandard(orgId, RESEARCH, 'user');
  const t = await researchTask(s, orgId);
  const brief = await quality.taskBrief(orgId, t, 'maker');
  assert.match(brief!, /Quality standard for .*"Research brief" v1/);
  assert.match(brief!, /- sources \(weight 3, min 3, evidence url\)/);
  assert.match(brief!, /org_request_review evidence/);
  assert.match((await quality.taskBrief(orgId, t, 'verifier'))!, /org_review with scores/);
  const text = await tools.execute(await sessionOf(s, s.writer.id), 'org_quality', {});
  assert.match(text, /research-brief v1 \[active\] Research brief — deliverable research/);
  const one = await tools.execute(await sessionOf(s, s.writer.id), 'org_quality', { task: t.key });
  assert.match(one, /Pass: weighted 3\.5 of 5/);
});
