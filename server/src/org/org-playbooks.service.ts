/**
 * OrgPlaybooksService — playbooks: repeatable procedures the company
 * discovers, written as skills by the agents that do them, reviewed like any
 * task, versioned, offered to the right roles (docs/company-vision.md §6,
 * execution-plan item 22).
 *
 * A playbook is a row of `org_playbooks` and a skill named `org-<slug>` in
 * the organization's workspace (skill names are slugs, so the `org/` namespace
 * of the vision is spelled `org-`). `write` creates or re-versions it, parks
 * the skill as a draft (not callable), and opens a review task owned by the
 * author that goes straight to review with a reviewer other than the author —
 * the same path `org_request_review` takes. The reviewer's `accept` is what
 * activates the version: `syncReviews` (the memory tick, every read) sees the
 * task `done`, copies the body into the skill, enables it, and announces it.
 * Active playbooks whose `roles` name a member's title (or nobody in
 * particular) are listed in that member's org context with one-line
 * summaries; the agent loads one with the ordinary `skill_org_<slug>` tool.
 * Skill outcome tracking (item 10) feeds `outcomes` (uses, 👍/👎), which the
 * retro reads. Every write is audited; nothing here calls a model.
 */
import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { orgPlaybooks, skills } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { currentAccountId } from '../accounts/account-context';
import { AgentsService } from '../agents/agents.service';
import { SkillsService, SKILL_TOOL_PREFIX } from '../skills/skills.service';
import { OrgService, type OrgMember } from './org.service';
import { OrgTasksService } from './org-tasks.service';
import { OrgAuditService } from './org-audit.service';
import { OrgMirrorService } from './org-mirror.service';
import { OrgAnnouncer } from './org-announcer';

export type OrgPlaybook = typeof orgPlaybooks.$inferSelect;
export const PLAYBOOK_STATUSES = ['draft', 'in_review', 'active', 'retired'] as const;
export type PlaybookStatus = typeof PLAYBOOK_STATUSES[number];

export interface PlaybookOutcomes { uses: number; up: number; down: number; successRate: number | null; lastUsedAt: string | null; refreshedAt: string }

const PLAYBOOK_PREFIX = 'org-';
const BODY_CAP = 20_000;
const PLAYBOOK_LIMIT = 200;

export function playbookSlug(title: string): string {
  const base = (title ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  return base ? `${PLAYBOOK_PREFIX}${base}` : '';
}

export function parseRoles(raw: string | null | undefined): string[] {
  try { const v = JSON.parse(raw || '[]') as unknown; return Array.isArray(v) ? v.map(String).map((r) => r.trim()).filter(Boolean) : []; } catch { return []; }
}

export function parseOutcomes(raw: string | null | undefined): PlaybookOutcomes | null {
  try { const v = JSON.parse(raw || '{}') as Partial<PlaybookOutcomes>; return typeof v.uses === 'number' ? { uses: v.uses, up: v.up ?? 0, down: v.down ?? 0, successRate: v.successRate ?? null, lastUsedAt: v.lastUsedAt ?? null, refreshedAt: v.refreshedAt ?? '' } : null; } catch { return null; }
}

/** Whether a playbook offered to `roles` is for a member with `title`:
 *  an empty list is for everyone; otherwise the title (or the agent id)
 *  must be named, case-insensitively. */
export function offeredToRole(roles: string[], member: Pick<OrgMember, 'title' | 'agentId'>): boolean {
  if (roles.length === 0) return true;
  const title = (member.title ?? '').trim().toLowerCase();
  return roles.some((r) => { const q = r.toLowerCase(); return q === '*' || q === 'all' || q === 'everyone' || (title && q === title) || q === member.agentId || member.agentId.startsWith(r); });
}

@Injectable()
export class OrgPlaybooksService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly org: OrgService,
    private readonly tasks: OrgTasksService,
    private readonly audit: OrgAuditService,
    private readonly agents: AgentsService,
    /** Optional: without it a playbook is a record with no callable skill. */
    @Optional() private readonly skills?: SkillsService,
    @Optional() private readonly announcer?: OrgAnnouncer,
    /** Optional: mirrors each playbook to /org/playbooks/<name>.md (docs/filesystem.md). */
    @Optional() private readonly mirror?: OrgMirrorService,
  ) {}

  // ---- reads ----

  async list(orgId: string, opts: { status?: string | null; role?: string | null; sync?: boolean } = {}): Promise<OrgPlaybook[]> {
    if (opts.sync !== false) await this.syncReviews(orgId).catch(() => undefined);
    const rows = await this.db.select().from(orgPlaybooks).where(eq(orgPlaybooks.orgId, orgId));
    const role = (opts.role ?? '').trim().toLowerCase();
    return rows
      .filter((p) => (!opts.status || p.status === opts.status) && (!role || offeredToRole(parseRoles(p.roles), { title: role, agentId: role })))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  async get(orgId: string, id: string): Promise<OrgPlaybook> {
    const p = (await this.db.select().from(orgPlaybooks).where(and(eq(orgPlaybooks.orgId, orgId), eq(orgPlaybooks.id, id))).limit(1)).at(0);
    if (!p) throw new NotFoundException(`playbook ${id}`);
    return p;
  }

  /** By id, id prefix, skill name (`org-…`), skill tool name or title. */
  async byRef(orgId: string, ref: string): Promise<OrgPlaybook> {
    const q = (ref ?? '').trim();
    if (!q) throw new BadRequestException('playbookId is required');
    const lower = q.toLowerCase();
    const all = await this.list(orgId, { sync: false });
    const hits = all.filter((p) => p.id === q || p.id.startsWith(q) || p.name === lower || `${SKILL_TOOL_PREFIX}${p.name.replace(/-/g, '_')}` === lower || p.title.toLowerCase() === lower);
    if (hits.length !== 1) throw new BadRequestException(`playbook "${q}" matches ${hits.length} playbooks`);
    return hits[0];
  }

  /** Active playbooks a member is offered (its title, or everyone's). */
  async offeredTo(orgId: string, agentId: string): Promise<OrgPlaybook[]> {
    const member = await this.org.member(orgId, agentId);
    if (!member) return [];
    return (await this.list(orgId, { status: 'active' })).filter((p) => offeredToRole(parseRoles(p.roles), member));
  }

  /** The one-line-per-playbook block an org session's context carries. */
  async contextBlock(orgId: string, agentId: string): Promise<string | null> {
    const mine = await this.offeredTo(orgId, agentId);
    if (mine.length === 0) return null;
    await this.refreshOutcomes(orgId).catch(() => undefined);
    const fresh = await this.list(orgId, { status: 'active', sync: false });
    const lines = mine.map((p) => {
      const cur = fresh.find((x) => x.id === p.id) ?? p;
      const o = parseOutcomes(cur.outcomes);
      const stats = o && o.uses > 0 ? ` — ${o.uses} use(s)${o.successRate !== null ? `, ${Math.round(o.successRate * 100)}% rated well` : ''}` : '';
      return `- ${SKILL_TOOL_PREFIX}${p.name.replace(/-/g, '_')} (v${p.version}): ${p.title}${summaryOf(p.body) ? ` — ${summaryOf(p.body)}` : ''}${stats}`;
    });
    return ['## Playbooks for your role (docs/company-vision.md §6)', 'Repeatable procedures the company reviewed; load one with its skill tool before doing that kind of work, and write a new one with org_write_playbook when you find a procedure worth repeating.', ...lines].join('\n');
  }

  // ---- writes ----

  /**
   * Write a playbook (`org_write_playbook`): a new one, or a new version of
   * one with the same title/slug. The skill is parked as a draft and a review
   * task opens with a reviewer other than the author; `syncReviews` activates
   * the version when that task is accepted.
   */
  async write(orgId: string, input: { title: string; body: string; roles?: string[]; why: string; authorAgentId: string; sourceTaskId?: string | null }): Promise<{ playbook: OrgPlaybook; task: { id: string; reviewerAgentId: string | null }; created: boolean }> {
    const org = await this.org.get(orgId);
    const title = (input.title ?? '').trim().slice(0, 120);
    const body = (input.body ?? '').trim().slice(0, BODY_CAP);
    const why = (input.why ?? '').trim().slice(0, 600);
    if (!title) throw new BadRequestException('a playbook needs a title');
    if (body.length < 20) throw new BadRequestException('the playbook body (its SKILL.md) is too short to be a procedure');
    if (!why) throw new BadRequestException('why is required: one line on what this procedure repeats and why the company should keep it');
    const name = playbookSlug(title);
    if (!name) throw new BadRequestException('could not derive a slug from that title');
    const author = await this.org.member(orgId, input.authorAgentId);
    if (!author || author.status !== 'active') throw new BadRequestException('only an active member writes a playbook');
    const roles = (input.roles ?? []).map(String).map((r) => r.trim()).filter(Boolean).slice(0, 12);
    const all = await this.list(orgId, { sync: false });
    const existing = all.find((p) => p.name === name);
    if (!existing && all.length >= PLAYBOOK_LIMIT) throw new BadRequestException(`playbook limit (${PLAYBOOK_LIMIT}) reached — retire some first`);
    if (existing && existing.status === 'in_review') throw new BadRequestException(`"${existing.title}" v${existing.version} is already in review (task ${existing.reviewTaskId?.slice(0, 8) ?? '?'}); wait for that verdict`);
    const now = nowIso();
    let row: OrgPlaybook;
    if (existing) {
      const version = existing.version + 1;
      await this.db.update(orgPlaybooks).set({ title, body, roles: JSON.stringify(roles.length ? roles : parseRoles(existing.roles)), version, status: 'in_review', why, updatedAt: now, sourceTaskId: input.sourceTaskId ?? existing.sourceTaskId }).where(eq(orgPlaybooks.id, existing.id));
      row = await this.get(orgId, existing.id);
    } else {
      let skillId: string | null = null;
      if (this.skills) {
        const skill = await this.skills.create({ name, description: title.slice(0, 300), instructions: body, workspaceId: org.workspaceId, draft: true, proposedBy: `agent:${input.authorAgentId}` })
          .catch(async (err: unknown) => {
            // A same-named skill already in the workspace (an earlier playbook retired and deleted the row, or a hand-made skill): adopt it.
            const taken = (await this.skills!.list(org.workspaceId)).find((s) => s.name === name);
            if (!taken) throw new BadRequestException(`could not create the skill: ${err instanceof Error ? err.message : String(err)}`);
            return taken;
          });
        skillId = skill.id;
      }
      row = {
        accountId: currentAccountId(), id: newId(), orgId, skillId, name, title, body, ownerAgentId: input.authorAgentId,
        roles: JSON.stringify(roles), status: 'in_review', version: 1, sourceTaskId: input.sourceTaskId ?? null, reviewTaskId: null,
        outcomes: '{}', why, createdAt: now, updatedAt: now,
      };
      await this.db.insert(orgPlaybooks).values(row);
    }
    // The review task: owned by the author, straight into review with a reviewer ≠ author (the org_request_review path).
    const task = await this.tasks.create(orgId, {
      title: `Review playbook "${title}" v${row.version}`,
      brief: {
        outcome: `The playbook "${title}" (skill ${name}, v${row.version}) is accepted as a company procedure, or sent back with what to change.`,
        context: `Written by ${(await this.agents.get(input.authorAgentId).catch(() => null))?.name ?? 'a member'}. Why: ${why}. Offered to: ${roles.length ? roles.join(', ') : 'every role'}.${input.sourceTaskId ? ` From task [${input.sourceTaskId.slice(0, 8)}].` : ''}\n\n--- SKILL.md ---\n${body.slice(0, 6_000)}`,
        constraints: 'Review the procedure as written: is it correct, safe within the company\'s rules and values, repeatable by the roles it is offered to. Do not perform it.',
        done_when: 'The reviewer accepts (the playbook activates and its skill becomes callable) or requests changes with a concrete note (the author re-writes it with org_write_playbook).',
      },
      assigneeAgentId: input.authorAgentId, status: 'in_review', createdBy: `agent:${input.authorAgentId}`,
    });
    const models = new Map((await this.agents.list()).map((a) => [a.id, { provider: a.provider, model: a.model }]));
    const reviewed = await this.tasks.requestReview(orgId, task.id, { note: `Playbook "${title}" v${row.version} — ${why}`, fromAgentId: input.authorAgentId, agentModels: models });
    await this.db.update(orgPlaybooks).set({ reviewTaskId: task.id, updatedAt: nowIso() }).where(eq(orgPlaybooks.id, row.id));
    await this.audit.append(orgId, { actor: `agent:${input.authorAgentId}`, action: existing ? 'playbook_revise' : 'playbook_write', refType: 'playbook', refId: row.id, payload: { title, name, version: row.version, roles, reviewTaskId: task.id, reviewerAgentId: reviewed.reviewerAgentId, why, chars: body.length } });
    this.mirror?.playbookChanged(orgId, row.id);
    return { playbook: await this.get(orgId, row.id), task: { id: task.id, reviewerAgentId: reviewed.reviewerAgentId }, created: !existing };
  }

  /** Playbooks in review whose task closed: `done` activates the version,
   *  `cancelled` parks it as a draft. Idempotent; returns what changed. */
  async syncReviews(orgId: string): Promise<Array<{ id: string; status: PlaybookStatus }>> {
    const out: Array<{ id: string; status: PlaybookStatus }> = [];
    const rows = (await this.db.select().from(orgPlaybooks).where(and(eq(orgPlaybooks.orgId, orgId), eq(orgPlaybooks.status, 'in_review'))));
    for (const p of rows) {
      if (!p.reviewTaskId) continue;
      const t = await this.tasks.get(orgId, p.reviewTaskId).catch(() => null);
      if (!t) continue;
      if (t.status === 'done') {
        // The eval gate (docs/evals.md §3): a new version replays its roles' golden set first.
        if (this.activationGate) {
          const live = p.skillId ? (await this.db.select().from(skills).where(eq(skills.id, p.skillId)).limit(1)).at(0)?.instructions ?? null : null;
          const g = await this.activationGate(orgId, p, live).catch((err: unknown) => ({ ok: true, summary: `eval gate error: ${err instanceof Error ? err.message : String(err)}` }));
          if (!g.ok) {
            await this.db.update(orgPlaybooks).set({ status: 'draft', updatedAt: nowIso() }).where(eq(orgPlaybooks.id, p.id));
            await this.audit.append(orgId, { actor: 'system', action: 'playbook_blocked_by_eval', refType: 'playbook', refId: p.id, payload: { version: p.version, summary: g.summary.slice(0, 400) } });
            if (p.ownerAgentId) await this.agents.addEvent(p.ownerAgentId, { kind: 'info', title: `Playbook "${p.title}" v${p.version} was not activated: it regressed in evals`, body: g.summary.slice(0, 1_000), payload: JSON.stringify({ orgId, playbookId: p.id }), origin: 'loop' }).catch(() => undefined);
            out.push({ id: p.id, status: 'draft' }); this.mirror?.playbookChanged(orgId, p.id);
            continue;
          }
        }
        await this.activate(orgId, p.id, `review:${t.reviewerAgentId ?? 'user'}`); out.push({ id: p.id, status: 'active' });
      }
      else if (t.status === 'cancelled') { await this.db.update(orgPlaybooks).set({ status: 'draft', updatedAt: nowIso() }).where(eq(orgPlaybooks.id, p.id)); await this.audit.append(orgId, { actor: 'system', action: 'playbook_review_cancelled', refType: 'playbook', refId: p.id, payload: { taskId: t.id } }); out.push({ id: p.id, status: 'draft' }); this.mirror?.playbookChanged(orgId, p.id); }
    }
    return out;
  }

  private activationGate?: PlaybookActivationGate;

  /** OrgEvalsService binds the eval gate for new versions (docs/evals.md §3). */
  setActivationGate(fn: PlaybookActivationGate | undefined): void { this.activationGate = fn; }

  /** Activate the current version: the body becomes the skill's instructions
   *  and the skill is enabled; announced in #company. */
  async activate(orgId: string, id: string, actor = 'user'): Promise<OrgPlaybook> {
    const p = await this.get(orgId, id);
    await this.org.gate(orgId, { kind: 'playbook', key: id, summary: `activate playbook "${p.title}" v${p.version}` }, actor);
    const org = await this.org.get(orgId);
    if (p.skillId && this.skills) {
      const live = await this.skills.get(p.skillId).catch(() => null);
      if (live) await this.db.update(skills).set({ instructions: p.body, description: p.title.slice(0, 300), enabled: 1, draft: 0 }).where(eq(skills.id, p.skillId));
    }
    await this.db.update(orgPlaybooks).set({ status: 'active', updatedAt: nowIso() }).where(eq(orgPlaybooks.id, id));
    await this.audit.append(orgId, { actor, action: 'playbook_activate', refType: 'playbook', refId: id, payload: { name: p.name, version: p.version, roles: parseRoles(p.roles) } });
    const owner = p.ownerAgentId ? await this.agents.get(p.ownerAgentId).catch(() => null) : null;
    await this.announcer?.announce(org.workspaceId, `Playbook active: "${p.title}" v${p.version} (${SKILL_TOOL_PREFIX}${p.name.replace(/-/g, '_')})${owner ? ` by ${owner.name}` : ''}${parseRoles(p.roles).length ? ` — for ${parseRoles(p.roles).join(', ')}` : ''}.`).catch(() => undefined);
    if (p.ownerAgentId) await this.agents.addEvent(p.ownerAgentId, { kind: 'info', title: `Playbook "${p.title}" v${p.version} is active`, body: `Reviewed and accepted; its skill is callable for ${parseRoles(p.roles).join(', ') || 'every role'}.`, payload: JSON.stringify({ orgId, playbookId: id }), origin: 'loop' }).catch(() => undefined);
    this.mirror?.playbookChanged(orgId, id);
    return this.get(orgId, id);
  }

  async retire(orgId: string, id: string, actor = 'user', why = ''): Promise<OrgPlaybook> {
    const p = await this.get(orgId, id);
    if (p.skillId) await this.db.update(skills).set({ enabled: 0 }).where(eq(skills.id, p.skillId));
    await this.db.update(orgPlaybooks).set({ status: 'retired', updatedAt: nowIso() }).where(eq(orgPlaybooks.id, id));
    await this.audit.append(orgId, { actor, action: 'playbook_retire', refType: 'playbook', refId: id, payload: { name: p.name, version: p.version, why: why.slice(0, 300) } });
    this.mirror?.playbookChanged(orgId, id);
    return this.get(orgId, id);
  }

  /** A retro proposed a change: a revise task for the owner, briefed with the note. */
  async reviseTask(orgId: string, id: string, input: { note: string; by: string; meetingId?: string | null }): Promise<{ taskId: string }> {
    const p = await this.get(orgId, id);
    const owner = p.ownerAgentId ? await this.org.member(orgId, p.ownerAgentId) : null;
    const org = await this.org.get(orgId);
    const assignee = owner && owner.status === 'active' ? owner.agentId : org.chiefOfStaffAgentId;
    const t = await this.tasks.create(orgId, {
      title: `Revise playbook "${p.title}" (v${p.version})`,
      brief: {
        outcome: `A new version of the playbook "${p.title}" that addresses the retro's note.`,
        context: `Current version v${p.version} (skill ${p.name}). The retro${input.meetingId ? ` [meeting ${input.meetingId.slice(0, 8)}]` : ''} proposed: ${input.note.slice(0, 1_500)}`,
        constraints: 'Keep what works; change only what the note names. The new version goes through review like the first.',
        done_when: `org_write_playbook was called with the same title and the revised body (v${p.version + 1}) and the reviewer accepted it.`,
      },
      assigneeAgentId: assignee ?? null, status: assignee ? 'todo' : 'backlog', createdBy: `agent:${input.by}`,
    });
    await this.audit.append(orgId, { actor: `agent:${input.by}`, action: 'playbook_revise_requested', refType: 'playbook', refId: id, payload: { taskId: t.id, assignee, meetingId: input.meetingId ?? null, note: input.note.slice(0, 300) } });
    return { taskId: t.id };
  }

  // ---- outcomes (item 10 → the retro) ----

  /** Copy the skills' outcome counters onto the playbooks. */
  async refreshOutcomes(orgId: string): Promise<number> {
    const rows = await this.db.select().from(orgPlaybooks).where(eq(orgPlaybooks.orgId, orgId));
    let n = 0;
    for (const p of rows) {
      if (!p.skillId) continue;
      const s = (await this.db.select().from(skills).where(eq(skills.id, p.skillId)).limit(1)).at(0);
      if (!s) continue;
      const rated = s.upCount + s.downCount;
      const o: PlaybookOutcomes = { uses: s.useCount, up: s.upCount, down: s.downCount, successRate: rated > 0 ? s.upCount / rated : null, lastUsedAt: s.lastUsedAt, refreshedAt: nowIso() };
      await this.db.update(orgPlaybooks).set({ outcomes: JSON.stringify(o) }).where(eq(orgPlaybooks.id, p.id));
      this.mirror?.playbookChanged(orgId, p.id);
      n++;
    }
    return n;
  }

  /** The retro's view: every non-retired playbook with its uses and rating,
   *  the unloved and the unused called out. No model. */
  async outcomesSummary(orgId: string): Promise<string | null> {
    await this.refreshOutcomes(orgId).catch(() => undefined);
    const rows = (await this.list(orgId, { sync: false })).filter((p) => p.status !== 'retired');
    if (rows.length === 0) return null;
    const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
    const lines = rows.map((p) => {
      const o = parseOutcomes(p.outcomes);
      const flag = !o || o.uses === 0 ? 'never used' : o.successRate !== null && o.successRate < 0.5 ? 'RATED POORLY — revise or retire' : '';
      return `- [${p.id.slice(0, 8)}] ${p.title} v${p.version} (${p.status}; owner ${p.ownerAgentId ? names.get(p.ownerAgentId) ?? p.ownerAgentId.slice(0, 8) : 'nobody'}; for ${parseRoles(p.roles).join(', ') || 'everyone'}): ${o ? `${o.uses} use(s), ${o.up} 👍 / ${o.down} 👎` : 'no data'}${flag ? ` — ${flag}` : ''}`;
    });
    return ['## Playbooks and how they fared (skill outcomes, item 10)', ...lines, 'Propose a playbook change with meeting_propose_lesson {proposedPlaybookChange: {playbookId, note}} when one misleads; its owner gets a revise task.'].join('\n');
  }
}

/** Runs before a reviewed playbook version activates; `ok: false` keeps it a draft. */
export type PlaybookActivationGate = (orgId: string, p: OrgPlaybook, liveBody: string | null) => Promise<{ ok: boolean; summary: string }>;

/** The first meaningful line of a SKILL.md body, for the one-line summary. */
export function summaryOf(body: string): string {
  const line = (body ?? '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#') && !l.startsWith('---') && !/^[a-z]+:\s/i.test(l)) ?? '';
  return line.replace(/^[-*]\s+/, '').slice(0, 140);
}
