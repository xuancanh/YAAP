/** A seeded company for the briefing tests (docs/agent-data-access.md
 *  "What every agent knows without asking"): the org governance harness
 *  plus the project and data tools, a real TurnContextService so a turn's
 *  whole system prompt can be measured, and a company with a mission,
 *  values, a vision, key results, two units, projects, tasks, decisions and
 *  a card waiting on a head. Not a test file itself. */
import { ConfigService } from '@nestjs/config';
import { setup as harness, enable, sessionOf, type S } from './org-governance-harness';
import { OrgProjectsService } from '../server/src/org/org-projects.service';
import { OrgProjectsTools } from '../server/src/org/org-projects.tools';
import { OrgDataTools } from '../server/src/org/org-data.tools';
import { OrgChiefService } from '../server/src/org/org-chief.service';
import { OrgBriefingService } from '../server/src/org/org-briefing.service';
import { TurnContextService } from '../server/src/chats/turn-context.service';
import { AgentMemoryService } from '../server/src/agents/agent-memory.service';
import type { AiProviderFactory } from '../server/src/ai/providers.factory';
import type { AgentTypesService } from '../server/src/agent-types/agent-types.service';
import type { StorageService } from '../server/src/storage/storage.service';
import type { ChatSession } from '../server/src/chats/chats.repository';

export const MISSION = 'Help independent publishers grow a loyal paid readership with a newsletter that is worth opening every week, written and edited by a small team of agents and humans.';
export const VALUES = 'Readers first: every decision starts from what a subscriber gets out of it.\nCandour: say what is true, especially when it is bad news.\nShip weekly: a good issue on Friday beats a perfect one next month.\nOwn the outcome: the owner of a task sees it through review.\nFrugality: spend like it is your own money.';
export const CULTURE = 'A small, written-first team. Decisions are recorded with their reasons; status goes in writing, meetings are for decisions. We prefer reversible bets and short cycles, and we argue about ideas, never people. New members read /org/README.md and the decision log before their first task.';

export async function setupCompany(opts: { briefing?: boolean } = {}) {
  const s = await harness();
  const storage = (s.agents as unknown as { storage: StorageService }).storage;
  const projects = new OrgProjectsService(s.db, s.org, s.tasks, s.approvals, s.audit, s.agents, s.units, undefined, s.decisions);
  new OrgProjectsTools(s.org, projects, s.tasks, s.agents, s.config, s.runtime, s.turns);
  new OrgDataTools(s.org, s.units, s.tasks, s.meetings, s.approvals, s.agents, s.config, s.workspaces, s.runtime, s.turns);
  const chiefOs = new OrgChiefService(s.org, s.tasks, s.approvals, s.agents, s.units, s.meetings, s.signals);
  // The briefing is opt-out for the audit's "before" measurement (BRIEFING=off).
  const briefing = opts.briefing === false ? null : new OrgBriefingService(s.db, s.org, s.audit, s.tasks, s.agents, s.config, storage, s.units, s.intent, s.runtime, s.turns);
  if (briefing) briefing.standingDebounceMs = 600_000;
  const memory = new AgentMemoryService(s.db, storage);
  const context = new TurnContextService(
    { resolve: () => s.provider, defaultBaseUrl: () => undefined } as unknown as AiProviderFactory,
    { resolve: async () => undefined, list: async () => [] } as unknown as AgentTypesService,
    s.agents, memory, s.workspaces,
    { get: () => 24 } as unknown as ConfigService,
  );
  // The harness stubs the context; measure the real one.
  (s.turns as unknown as { context: TurnContextService }).context = context;

  const orgId = await enable(s);
  await s.org.update(orgId, { mission: MISSION });
  await s.org.setProfile(orgId, { values: VALUES, culture: CULTURE });
  const junior = await s.agents.create({ name: 'Junior', charter: 'You draft newsletter sections from briefs.', provider: 'anthropic', model: 'claude-haiku-4-5' });
  const proof = await s.agents.create({ name: 'Proof', charter: 'You proofread drafts.', provider: 'anthropic', model: 'claude-haiku-4-5' });
  await s.org.addMember(orgId, { agentId: junior.id, title: 'Junior writer', reportsToAgentId: s.writer.id });
  await s.org.addMember(orgId, { agentId: proof.id, title: 'Proofreader', reportsToAgentId: s.editor.id });
  await s.units.syncMembership(orgId);
  const writerUnit = (await s.units.isLead(orgId, s.writer.id))!;
  const editorUnit = (await s.units.isLead(orgId, s.editor.id))!;

  // Intent: a vision, an objective, three key results.
  await s.intent.setVision(orgId, { title: '10,000 paying readers by the end of 2027', dueAt: '2027-12-31' });
  const objective = await s.org.addGoal(orgId, { title: 'Grow paid subscribers', kind: 'objective', ownerAgentId: s.chief.id });
  const krSubs = await s.org.addGoal(orgId, { title: 'Paid subscribers', kind: 'key_result', parentGoalId: objective.id, metric: 'paid subscribers', startValue: 0, currentValue: 120, targetValue: 1000, dueAt: '2026-12-31', ownerAgentId: s.writer.id });
  const krOpen = await s.org.addGoal(orgId, { title: 'Open rate', kind: 'key_result', parentGoalId: objective.id, metric: 'open rate', startValue: 30, currentValue: 41, targetValue: 45, unitLabel: '%', dueAt: '2026-12-31', ownerAgentId: s.editor.id });
  await s.org.addGoal(orgId, { title: 'Error-free issues', kind: 'key_result', parentGoalId: objective.id, metric: 'issues without a correction', startValue: 0, currentValue: 3, targetValue: 12, dueAt: '2027-03-31', ownerAgentId: s.editor.id });

  // Projects: one per unit, each with a lead, milestones and a budget envelope.
  const pWriting = await s.org.addProject(orgId, { title: 'Weekly issue pipeline', ownerAgentId: s.writer.id, unitId: writerUnit.id, goalIds: [krSubs.id], targetDate: '2026-12-15', milestones: [{ name: 'Template v2', date: '2026-11-20' }, { name: 'Referral block', date: '2026-12-05' }], appetiteUsd: 40, status: 'active', lane: 'now' });
  const pEditing = await s.org.addProject(orgId, { title: 'House style guide', ownerAgentId: s.editor.id, unitId: editorUnit.id, goalIds: [krOpen.id], targetDate: '2026-12-01', milestones: [{ name: 'Draft guide', date: '2026-11-15' }], appetiteUsd: 25, status: 'active', lane: 'now' });
  await s.org.updateProject(orgId, pWriting.id, { health: 'at_risk', healthReason: 'Template v2 slipped a week', healthAt: new Date().toISOString() });
  await s.org.setBudget(orgId, { scope: 'project', refId: pEditing.id, monthlyUsd: 77.77 }).catch(() => undefined);

  // Tasks: Junior has three on the writing project (one blocked), Proof two on editing; one review for Writer.
  const t1 = await s.tasks.create(orgId, { title: 'Draft the lead story for issue 14', projectId: pWriting.id, assigneeAgentId: junior.id, status: 'in_progress', createdBy: 'chief' });
  await s.tasks.create(orgId, { title: 'Write the referral block copy', projectId: pWriting.id, assigneeAgentId: junior.id, status: 'todo', createdBy: 'chief' });
  const t3 = await s.tasks.create(orgId, { title: 'Collect reader quotes', projectId: pWriting.id, assigneeAgentId: junior.id, status: 'todo', createdBy: 'chief' });
  await s.tasks.update(orgId, t3.id, { status: 'blocked', blockers: ['waiting on the survey export'] } as never, 'chief').catch(() => undefined);
  await s.tasks.create(orgId, { title: 'Proofread issue 13', projectId: pEditing.id, assigneeAgentId: proof.id, status: 'in_progress', createdBy: 'chief' });
  await s.tasks.create(orgId, { title: 'List banned phrases', projectId: pEditing.id, assigneeAgentId: proof.id, status: 'todo', createdBy: 'chief' });
  const t4 = await s.tasks.create(orgId, { title: 'Outline the welcome email', projectId: pWriting.id, assigneeAgentId: junior.id, reviewerAgentId: s.writer.id, status: 'todo', createdBy: 'chief' });
  await s.tasks.update(orgId, t4.id, { status: 'in_review' }, 'chief').catch(() => undefined);
  void t1;
  await s.tasks.create(orgId, { title: 'Unassigned: pick a sponsor slot', projectId: pWriting.id, createdBy: 'chief', unitId: writerUnit.id });

  // Decisions: one company-level, one per unit.
  await s.meetings.logDecision(orgId, { title: 'Publish every Friday at 8:00', decision: 'Friday 8:00 UTC', decidedBy: 'CEO' });
  await s.meetings.logDecision(orgId, { title: 'Lead stories stay under 900 words', decision: '900 words', decidedBy: 'Writer', unitId: writerUnit.id });
  await s.meetings.logDecision(orgId, { title: 'Editing budget is secret-sauce-42', decision: 'internal', decidedBy: 'Editor', unitId: editorUnit.id });

  return { ...s, storage, projects, chiefOs, briefing: briefing!, context, memory, orgId, junior, proof, writerUnit, editorUnit, pWriting, pEditing, krSubs, krOpen, objective };
}
export type C = Awaited<ReturnType<typeof setupCompany>>;

/** The system prompt a turn of `agentId` sends, in a fresh session (or `session`). */
export async function systemOf(c: C, agentId: string, session?: ChatSession): Promise<string> {
  const sess = session ?? await sessionOf(c as unknown as S, agentId);
  const before = c.provider.requests.length;
  for await (const ev of c.turns.run(sess.id, { text: 'status?' })) void ev;
  const req = c.provider.requests[before];
  if (!req) throw new Error('no provider request was made');
  return req.system ?? '';
}

/** The heartbeat's org context lines (what HeartbeatService puts in the beat's prompt). */
export async function heartbeatOrgContext(c: C, agentId: string): Promise<string> {
  const now = new Date();
  const parts = [
    await c.chiefOs.heartbeatContext(agentId, now),
    await c.projects.heartbeatContext(agentId, now),
    await c.decisions.heartbeatContext(agentId),
  ].filter((x): x is string => Boolean(x));
  return parts.join('\n\n');
}

/** Sections of a prompt: its "# " headings and how many chars each holds. */
export function sections(system: string): Array<{ title: string; chars: number }> {
  const out: Array<{ title: string; chars: number }> = [];
  for (const block of system.split('\n\n')) {
    const title = block.startsWith('#') ? block.split('\n')[0].slice(0, 60) : block.slice(0, 40).replace(/\n/g, ' ');
    out.push({ title, chars: block.length });
  }
  return out;
}

export { sessionOf };
