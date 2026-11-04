/**
 * TaskMentionsService — `@mentions` in org task comments and briefs
 * (docs/work-tracking.md "Mentions").
 *
 * Names resolve with the channel resolver (server/src/groupchat/mentions.ts:
 * the longest display name, any script, markdown-aware, handles and email
 * aliases) against everyone who might be tagged on a task: the agents of the
 * workspace and its people (the owner and the workspace members). Only those
 * who can see the task may be tagged — the organization's live members and
 * the workspace's people; an agent outside the company or a terminated
 * member resolves, and is refused with the reason instead of being dropped.
 *
 * Delivery after the comment is stored:
 *  - a tagged agent follows the task (`mentioned`) and is woken for it with
 *    reason `mention` — through the org runtime, so the run is gated like any
 *    other wake (paused org or member, budgets, the per-task session) — unless
 *    the task is closed, it is the author, or the comment already woke it as
 *    the owner. An agent comment that tags another agent counts toward the
 *    task's chain: once `work.mentionChainCap` such comments followed the last
 *    person's comment, a tag wakes nobody until a person comments again.
 *  - a tagged person follows the task and gets one addressed inbox event
 *    (kind `mention`, pushed under the workspace's quiet hours) with the
 *    task's deep link.
 * Callers pass the result to the follow fan-out as `alreadyWoken` /
 * `alreadyNotified`, so a follower who is also tagged hears of it once.
 */
import { BadRequestException, Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { orgMessages, workspaces } from '../database/schema';
import { currentAccountId } from '../accounts/account-context';
import { AgentsService } from '../agents/agents.service';
import { SharedService } from '../shared/shared.service';
import { FollowsService, orgTaskTarget } from '../follows/follows.service';
import { spaPath } from '../common/spa-links';
import { TriggerBus } from '../chats/trigger-bus';
import { deliveryFor } from '../workspaces/quiet-hours';
import { mentionSpans, type Mention, type MentionableMember } from '../groupchat/mentions';
import { taskRef } from '../common/task-keys';
import { OrgService } from './org.service';
import { workTunable } from './work-tunables';
import { OrgTasksService, type OrgMessage, type OrgTask } from './org-tasks.service';

/** Someone who could be tagged on a task, and whether they can see it. */
export interface TaskMentionable extends MentionableMember {
  /** False: the tag is refused with `why`. */
  visible: boolean;
  why?: string;
  /** Agents: the member's org status (active | paused); people: their workspace role. */
  status?: string;
}

export interface MentionDelivery {
  /** Agents woken for the mention (or already woken by the comment as owner). */
  woken: string[];
  /** Agents tagged but not woken, with why (closed task, paused, the chain cap). */
  notWoken: Array<{ id: string; why: string }>;
  /** People given an inbox event. */
  notified: string[];
  /** The task's agent chain hit `work.mentionChainCap`. */
  capped: boolean;
}

/** The hook OrgTasksService calls (bound by `bind`). */
export interface TaskMentionHook {
  resolve(orgId: string, task: OrgTask, text: string, opts: { notify?: string[]; strict: boolean; authorAgentId: string | null; authorUserId: string | null }): Promise<Mention[]>;
  deliver(orgId: string, task: OrgTask, row: OrgMessage, mentions: Mention[], opts: { authorAgentId: string | null; authorUserId: string | null; ownerWoken: boolean; source: 'comment' | 'brief' }): Promise<MentionDelivery>;
}

const EMPTY: MentionDelivery = { woken: [], notWoken: [], notified: [], capped: false };

@Injectable()
export class TaskMentionsService implements TaskMentionHook, OnModuleInit {
  private readonly logger = new Logger(TaskMentionsService.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly org: OrgService,
    private readonly agents: AgentsService,
    @Optional() private readonly shared?: SharedService,
    @Optional() private readonly bus?: TriggerBus,
    @Optional() private readonly follows?: FollowsService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly tasks?: OrgTasksService,
  ) {}

  onModuleInit(): void { this.tasks?.setMentionHook(this); }

  /** Everyone who might be tagged on this org's tasks, with visibility. */
  async mentionables(orgId: string): Promise<TaskMentionable[]> {
    const org = await this.org.get(orgId);
    const members = new Map((await this.org.members(orgId)).map((m) => [m.agentId, m]));
    const out: TaskMentionable[] = [];
    for (const a of await this.agents.list()) {
      const m = members.get(a.id);
      // Agents belong to exactly one workspace: another workspace's agents are nobody here.
      if (!m && a.workspaceId && a.workspaceId !== org.workspaceId) continue;
      if (!m && !a.workspaceId) continue;
      const live = Boolean(m && m.status !== 'terminated');
      out.push({
        kind: 'agent', id: a.id, name: a.name, visible: live, status: m?.status,
        why: live ? undefined : m ? `${a.name} was let go from ${org.name}` : `${a.name} is not a member of ${org.name}`,
      });
    }
    const owner = currentAccountId();
    const names = this.shared ? await this.shared.displayNames(org.workspaceId).catch(() => new Map<string, string>()) : new Map<string, string>();
    out.push({ kind: 'human', id: owner, name: names.get(owner) ?? 'Owner', visible: true, status: 'owner' });
    for (const m of this.shared ? await this.shared.members(org.workspaceId).catch(() => []) : []) {
      if (m.memberAccountId === owner) continue;
      const alias = m.email ? m.email.split('@')[0] : '';
      out.push({ kind: 'human', id: m.memberAccountId, name: m.displayName || alias || m.memberAccountId.slice(0, 8), aliases: alias ? [alias] : [], visible: true, status: m.role });
    }
    return out;
  }

  /** The SPA's autocomplete list: who may be tagged (visible only). */
  async candidates(orgId: string): Promise<Array<{ kind: 'agent' | 'human'; id: string; name: string; status?: string }>> {
    return (await this.mentionables(orgId)).filter((m) => m.visible).map((m) => ({ kind: m.kind, id: m.id, name: m.name, status: m.status }));
  }

  /**
   * The mentions of a comment (or a brief): every `@name` the text names
   * plus the `notify` names, deduplicated, the author excluded. `strict`
   * refuses a tag of someone who cannot see the task, and a `notify` name
   * that names nobody; otherwise those are left out.
   */
  async resolve(orgId: string, task: OrgTask, text: string, opts: { notify?: string[]; strict: boolean; authorAgentId: string | null; authorUserId: string | null }): Promise<Mention[]> {
    const notify = (opts.notify ?? []).map((n) => String(n ?? '').trim().replace(/^@+/, '')).filter(Boolean).slice(0, 20);
    if (!text.includes('@') && notify.length === 0) return [];
    const pool = await this.mentionables(orgId);
    const hits: TaskMentionable[] = [];
    const unknown: string[] = [];
    for (const span of mentionSpans(text, pool)) for (const m of span.members) hits.push(m as TaskMentionable);
    for (const n of notify) {
      const found = mentionSpans(`@${n}`, pool).flatMap((s) => s.members) as TaskMentionable[];
      if (found.length === 0) unknown.push(n);
      hits.push(...found);
    }
    if (opts.strict && unknown.length) {
      throw new BadRequestException(`refused: notify names nobody who can be tagged here: ${unknown.join(', ')} — tag a member of the company or a person of the workspace by name`);
    }
    const out: Mention[] = [];
    const refused: TaskMentionable[] = [];
    const seen = new Set<string>();
    for (const m of hits) {
      const key = `${m.kind}:${m.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if ((m.kind === 'agent' && m.id === opts.authorAgentId) || (m.kind === 'human' && m.id === opts.authorUserId)) continue;
      if (!m.visible) { refused.push(m); continue; }
      out.push({ kind: m.kind, id: m.id });
    }
    if (opts.strict && refused.length) {
      throw new BadRequestException(`refused: ${refused.map((m) => m.why ?? `${m.name} cannot see this task`).join('; ')}, so they cannot see ${taskRef(task)} — remove the tag, or tag someone in the company.`);
    }
    return out;
  }

  /** Wake, follow and notify the mentioned (see the header). Never throws. */
  async deliver(orgId: string, task: OrgTask, row: OrgMessage, mentions: Mention[], opts: { authorAgentId: string | null; authorUserId: string | null; ownerWoken: boolean; source: 'comment' | 'brief' }): Promise<MentionDelivery> {
    if (mentions.length === 0) return EMPTY;
    const out: MentionDelivery = { woken: [], notWoken: [], notified: [], capped: false };
    try {
      const org = await this.org.get(orgId);
      const target = orgTaskTarget(org.workspaceId, task.id, task.title, task.key);
      const closed = task.status === 'done' || task.status === 'cancelled';
      const active = org.status === 'active';
      const agentsTagged = mentions.filter((m) => m.kind === 'agent' && m.id !== opts.authorAgentId).map((m) => m.id);
      // The ping-pong cap: agent comments tagging an agent since a person last commented.
      if (opts.source === 'comment' && opts.authorAgentId && agentsTagged.length) {
        const rounds = await this.chainRounds(orgId, task.id);
        out.capped = rounds > workTunable(org, 'work.mentionChainCap');
      }
      for (const id of agentsTagged) {
        await this.follows?.autoFollow(target, { kind: 'agent', id }, 'mentioned');
        if (id === task.assigneeAgentId && opts.ownerWoken) { out.woken.push(id); continue; }
        const member = await this.org.member(orgId, id);
        const why = closed ? `${taskRef(task)} is ${task.status}` : !active ? 'the company is paused'
          : !member || member.status !== 'active' ? 'the member is paused' : out.capped ? 'the agent chain on this task reached its cap — a person\'s comment resets it' : '';
        if (why) { out.notWoken.push({ id, why }); continue; }
        this.bus?.emitOrgWake({ orgId, taskId: task.id, agentId: id, reason: 'mention' });
        out.woken.push(id);
      }
      const people = mentions.filter((m) => m.kind === 'human' && m.id !== opts.authorUserId).map((m) => m.id);
      if (people.length) {
        const ws = (await this.db.select().from(workspaces).where(eq(workspaces.id, org.workspaceId)).limit(1)).at(0) ?? null;
        const author = opts.authorAgentId
          ? (await this.agents.get(opts.authorAgentId).catch(() => null))?.name ?? 'An agent'
          : opts.authorUserId && this.shared ? await this.shared.nameOf(org.workspaceId, opts.authorUserId).catch(() => 'Someone') : 'Someone';
        const base = (this.config?.get<string>('publicAppUrl') ?? 'http://localhost:5175').replace(/\/+$/, '');
        const link = `${base}${spaPath.task(org.workspaceId, task.key || task.id, ws?.name)}`;
        const owner = currentAccountId();
        const key = taskRef(task);
        for (const id of people) {
          await this.follows?.autoFollow(target, { kind: 'user', id }, 'mentioned');
          await this.agents.addEvent(`task:${orgId}`, {
            kind: 'mention',
            title: `${key} · ${author} mentioned you${opts.source === 'brief' ? ' in the brief' : ''}`.slice(0, 200),
            body: `${task.title}: ${row.text.replace(/\s+/g, ' ')}`.slice(0, 400),
            payload: JSON.stringify({ link, from: key, orgId, taskId: task.id, messageId: row.id, mention: true }),
            origin: 'org',
            channel: true,
            forMemberAccountId: id === owner ? '' : id,
            ...deliveryFor(ws, 'mention'),
          }).catch(() => undefined);
          out.notified.push(id);
        }
      }
    } catch (err) {
      this.logger.warn(`task mention delivery failed: ${err instanceof Error ? err.message : err}`);
    }
    return out;
  }

  /** Agent comments carrying an agent tag since the last person's comment (newest back). */
  private async chainRounds(orgId: string, taskId: string): Promise<number> {
    const rows = await this.db.select().from(orgMessages).where(and(eq(orgMessages.orgId, orgId), eq(orgMessages.taskId, taskId))).orderBy(desc(orgMessages.createdAt)).limit(100);
    let rounds = 0;
    for (const r of rows) {
      if (r.fromUserId) break;
      if (!r.fromAgentId) continue;
      if (parseMentionsJson(r.mentions).some((m) => m.kind === 'agent' && m.id !== r.fromAgentId)) rounds++;
    }
    return rounds;
  }

  /** The newest comment on the task that tagged this agent (its wake's context). */
  async latestMentionOf(orgId: string, taskId: string, agentId: string): Promise<OrgMessage | null> {
    const rows = await this.db.select().from(orgMessages).where(and(eq(orgMessages.orgId, orgId), eq(orgMessages.taskId, taskId))).orderBy(desc(orgMessages.createdAt)).limit(50);
    return rows.find((r) => parseMentionsJson(r.mentions).some((m) => m.kind === 'agent' && m.id === agentId)) ?? null;
  }
}

export function parseMentionsJson(raw: string | null | undefined): Mention[] {
  try {
    const v = JSON.parse(raw || '[]') as unknown;
    return Array.isArray(v) ? (v as Mention[]).filter((m) => m && (m.kind === 'agent' || m.kind === 'human') && typeof m.id === 'string') : [];
  } catch { return []; }
}
