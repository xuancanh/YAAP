/**
 * FollowsService — who follows which thread or task, and what changed since
 * they last looked (docs/follows.md).
 *
 * Agents and people follow three kinds of target: a channel thread (its root
 * message id), an org task and an agent kanban task. Following is automatic
 * for whoever started, commented on, owns, is assigned, reviews or was
 * mentioned in the target (the hooks live in the services that make those
 * changes and call `autoFollow`), and manual through the `follow` tool or the
 * SPA toggle. An unfollow sets `mutedAt` and keeps the row: auto-follow never
 * resubscribes a follower who left.
 *
 * Activity (`recordActivity`) is fanned out to every live follower except
 * the actor — whose own activity marks the target seen for it instead, so an
 * agent never notifies itself. Each row carries a compact "new since you last
 * looked" (count, latest line, who) and, when the change needs the follower
 * (blocked, review requested, reopened, a comment naming it), `attentionAt`.
 * The heartbeat reads both: `wakeReasons` (a gated, debounced reason — never
 * for agents an existing mechanism already wakes for the same change, like a
 * mention or the org wake of an owner or reviewer) and `digest` (the
 * "Following" section of the beat's prompt), then `markSeen`. People get one
 * addressed inbox event per target until they look again.
 *
 * Model-free and workspace-scoped: every lookup is keyed by the workspace,
 * and the tools resolve ids only inside the agent's own workspace.
 */
import { Inject, Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { agentEvents, agents, follows, organizations, workspaces } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { normalizeTaskKey } from '../common/task-keys';
import { currentAccountId } from '../accounts/account-context';
import { deliveryFor } from '../workspaces/quiet-hours';
import { followTunable } from './follow-tunables';
import { spaPath } from '../common/spa-links';

export type FollowerKind = 'agent' | 'user';
/** `channel`: a sub-channel — a discussion or a meeting (docs/group-chat.md §9). */
export type FollowTargetKind = 'thread' | 'org_task' | 'agent_task' | 'channel';
export type FollowReason = 'started' | 'commented' | 'owner' | 'assignee' | 'reviewer' | 'mentioned' | 'participant' | 'manual';
export const FOLLOW_TARGET_KINDS: readonly FollowTargetKind[] = ['thread', 'org_task', 'agent_task', 'channel'];
export type Follow = typeof follows.$inferSelect;

export interface Follower { kind: FollowerKind; id: string }

export interface FollowTarget {
  kind: FollowTargetKind;
  id: string;
  workspaceId: string;
  /** Shown in the digest and notifications ("#general: launch plan", the task title). */
  title?: string;
  /** SPA deep link for notifications. */
  link?: string;
}

export interface FollowActivity {
  /** Who made the change; null for the system (checks, the runtime). */
  actor: Follower | null;
  actorName?: string;
  /** One line: "replied: …", "moved to blocked: waits on X". */
  summary: string;
  /** Why this change needs every follower (blocked, review requested,
   *  reopened); null/undefined for ordinary activity (a reply, a comment). */
  attention?: string | null;
  /** Followers this change is aimed at (a comment naming them): attention
   *  for them alone. */
  directedTo?: Follower[];
  /** Text to look for `@name` of agent followers in (a task comment):
   *  those named count as `directedTo`. */
  mentionText?: string;
  /** Agents an existing mechanism already wakes for this very change (a
   *  mention, the org wake of an owner or reviewer): no follow wake for
   *  them, so nobody is woken twice. */
  alreadyWoken?: string[];
  /** People already notified for it (a mention): no follow event for them. */
  alreadyNotified?: string[];
  /** The target's state after the change: true closed (done, cancelled,
   *  abandoned), false reopened, undefined unchanged. */
  closed?: boolean;
}

/** A follow as the SPA and `list_follows` show it. */
export interface FollowView {
  followerKind: FollowerKind;
  followerId: string;
  reason: string;
  muted: boolean;
  createdAt: string;
}

const SUMMARY_CAP = 240;
const ATTENTION_CAP = 200;
const prefixOk = (s: string) => s.replace(/[^A-Za-z0-9-]/g, '');

@Injectable()
export class FollowsService {
  private readonly logger = new Logger(FollowsService.name);

  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  // ---- the follow rows ----

  async get(who: Follower, kind: FollowTargetKind, targetId: string): Promise<Follow | undefined> {
    return (await this.db.select().from(follows).where(and(
      eq(follows.followerKind, who.kind), eq(follows.followerId, who.id), eq(follows.targetKind, kind), eq(follows.targetId, targetId),
    )).limit(1)).at(0);
  }

  /**
   * Auto-follow: idempotent, and never against an unfollow — an existing row
   * (muted or not) is left as it is, except that a missing title is filled
   * in and the link is brought up to date. Empty follower ids (a system actor) are ignored.
   */
  async autoFollow(target: FollowTarget, who: Follower | null | undefined, reason: Exclude<FollowReason, 'manual'>): Promise<void> {
    if (!who || !who.id || !target.id || !target.workspaceId) return;
    try {
      const existing = await this.get(who, target.kind, target.id);
      if (existing) {
        const patch: Partial<Follow> = {};
        if (!existing.title && target.title) patch.title = target.title.slice(0, 200);
        if (target.link && existing.link !== target.link) patch.link = target.link; // links made before the task deep link
        if (Object.keys(patch).length) await this.db.update(follows).set(patch).where(eq(follows.id, existing.id));
        return;
      }
      await this.db.insert(follows).values(this.newRow(target, who, reason)).onConflictDoNothing();
    } catch (err) {
      this.logger.warn(`auto-follow failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** A manual follow: creates the row, or lifts an unfollow. */
  async follow(target: FollowTarget, who: Follower): Promise<Follow> {
    const existing = await this.get(who, target.kind, target.id);
    if (existing) {
      if (existing.mutedAt) await this.db.update(follows).set({ mutedAt: null, lastSeenAt: nowIso(), unseenCount: 0, attentionAt: null, attention: '' }).where(eq(follows.id, existing.id));
      return (await this.get(who, target.kind, target.id))!;
    }
    await this.db.insert(follows).values(this.newRow(target, who, 'manual')).onConflictDoNothing();
    return (await this.get(who, target.kind, target.id))!;
  }

  /** Unfollow = mute: the row stays (so auto-follow cannot resubscribe) and
   *  stops counting, notifying and waking. A follow never made is recorded
   *  muted too, so a later auto-follow respects the choice. */
  async unfollow(target: FollowTarget, who: Follower): Promise<Follow> {
    const existing = await this.get(who, target.kind, target.id);
    const now = nowIso();
    if (!existing) {
      await this.db.insert(follows).values({ ...this.newRow(target, who, 'manual'), mutedAt: now }).onConflictDoNothing();
    } else if (!existing.mutedAt) {
      await this.db.update(follows).set({ mutedAt: now, unseenCount: 0, attentionAt: null, attention: '' }).where(eq(follows.id, existing.id));
    }
    return (await this.get(who, target.kind, target.id))!;
  }

  /** Alias kept for callers that say what they mean. */
  mute(target: FollowTarget, who: Follower): Promise<Follow> { return this.unfollow(target, who); }

  /** A follower's live follows in one workspace, most recent activity first. */
  async list(who: Follower, workspaceId: string): Promise<Follow[]> {
    const rows = await this.db.select().from(follows).where(and(
      eq(follows.followerKind, who.kind), eq(follows.followerId, who.id), eq(follows.workspaceId, workspaceId), isNull(follows.mutedAt),
    ));
    return rows.sort((a, b) => ((b.lastActivityAt ?? b.createdAt) > (a.lastActivityAt ?? a.createdAt) ? 1 : -1));
  }

  /** Live followers of a target (muted rows excluded unless asked). */
  async followersOf(kind: FollowTargetKind, targetId: string, opts: { includeMuted?: boolean } = {}): Promise<Follow[]> {
    const rows = await this.db.select().from(follows).where(and(eq(follows.targetKind, kind), eq(follows.targetId, targetId)));
    return opts.includeMuted ? rows : rows.filter((r) => !r.mutedAt);
  }

  /** The SPA's view: every live follower plus the caller's own row. */
  async view(kind: FollowTargetKind, targetId: string, me: Follower): Promise<{ following: boolean; reason: string | null; followers: FollowView[] }> {
    const rows = await this.followersOf(kind, targetId, { includeMuted: true });
    const mine = rows.find((r) => r.followerKind === me.kind && r.followerId === me.id);
    return {
      following: Boolean(mine && !mine.mutedAt),
      reason: mine?.reason ?? null,
      followers: rows.filter((r) => !r.mutedAt).map((r) => ({ followerKind: r.followerKind as FollowerKind, followerId: r.followerId, reason: r.reason, muted: false, createdAt: r.createdAt })),
    };
  }

  /** The follower looked: nothing is new any more. */
  async markSeenFor(who: Follower, kind: FollowTargetKind, targetId: string): Promise<void> {
    const row = await this.get(who, kind, targetId);
    if (row) await this.markSeen([row.id]);
  }

  async markSeen(ids: string[], at: Date = new Date()): Promise<void> {
    if (ids.length === 0) return;
    await this.db.update(follows).set({ unseenCount: 0, attentionAt: null, attention: '', lastSeenAt: at.toISOString() }).where(inArray(follows.id, ids));
  }

  private newRow(target: FollowTarget, who: Follower, reason: FollowReason): typeof follows.$inferInsert {
    const now = nowIso();
    return {
      accountId: currentAccountId(), id: newId(), workspaceId: target.workspaceId,
      followerKind: who.kind, followerId: who.id, targetKind: target.kind, targetId: target.id,
      reason, title: (target.title ?? '').slice(0, 200), link: target.link ?? '',
      createdAt: now, mutedAt: null, lastSeenAt: now, unseenCount: 0,
      lastActivityAt: null, lastActivity: '', lastActorName: '', attentionAt: null, attention: '', wokeAt: null, closedAt: null,
    };
  }

  // ---- activity ----

  /**
   * Something happened on a target: count it for every live follower but
   * the actor (whose own activity marks it seen), set attention where it
   * needs the follower, record the open/closed state on every row, and give
   * people one inbox event per target until they look again. Never throws.
   */
  async recordActivity(target: FollowTarget, act: FollowActivity): Promise<void> {
    try {
      const rows = await this.followersOf(target.kind, target.id, { includeMuted: true });
      if (rows.length === 0) return;
      const now = nowIso();
      const actorName = act.actorName ?? (act.actor ? await this.nameOf(act.actor) : 'system');
      const summary = act.summary.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_CAP);
      const woken = new Set(act.alreadyWoken ?? []);
      const notified = new Set(act.alreadyNotified ?? []);
      const directed = new Set((act.directedTo ?? []).map((f) => `${f.kind}:${f.id}`));
      if (act.mentionText) for (const id of await this.namedIn(act.mentionText, rows)) directed.add(`agent:${id}`);
      const toNotify: Follow[] = [];
      for (const r of rows) {
        const patch: Partial<Follow> = {};
        if (act.closed === true && !r.closedAt) patch.closedAt = now;
        if (act.closed === false && r.closedAt) patch.closedAt = null;
        if (target.title && target.title !== r.title) patch.title = target.title.slice(0, 200);
        if (target.link && target.link !== r.link) patch.link = target.link;
        const isActor = act.actor && r.followerKind === act.actor.kind && r.followerId === act.actor.id;
        if (!r.mutedAt) {
          if (isActor) {
            Object.assign(patch, { unseenCount: 0, attentionAt: null, attention: '', lastSeenAt: now });
          } else {
            Object.assign(patch, { unseenCount: r.unseenCount + 1, lastActivityAt: now, lastActivity: summary, lastActorName: actorName.slice(0, 80) });
            const aimed = directed.has(`${r.followerKind}:${r.followerId}`);
            const needs = act.attention ? act.attention : aimed ? `${actorName} addressed you` : '';
            if (needs && !(r.followerKind === 'agent' && woken.has(r.followerId))) Object.assign(patch, { attentionAt: now, attention: needs.slice(0, ATTENTION_CAP) });
            if (r.followerKind === 'user' && r.unseenCount === 0 && !notified.has(r.followerId)) toNotify.push(r);
          }
        }
        if (Object.keys(patch).length) await this.db.update(follows).set(patch).where(eq(follows.id, r.id));
      }
      for (const r of toNotify) await this.notifyUser(target, r, actorName, summary).catch(() => undefined);
    } catch (err) {
      this.logger.warn(`follow activity failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** One addressed inbox event for a person: the first update since they
   *  last looked (later ones only count), under the workspace's quiet hours. */
  private async notifyUser(target: FollowTarget, r: Follow, actorName: string, summary: string): Promise<void> {
    const ws = (await this.db.select().from(workspaces).where(eq(workspaces.id, r.workspaceId)).limit(1)).at(0) ?? null;
    const label = r.title || target.title || labelOf(r.targetKind as FollowTargetKind, r.targetId, '');
    const agentId = `follow:${r.workspaceId}`;
    const delivery = deliveryFor(ws, 'info');
    await this.db.insert(agentEvents).values({
      id: newId(), agentId,
      forMemberAccountId: r.followerId === currentAccountId() ? '' : r.followerId,
      kind: 'follow', title: `Following · ${label}`.slice(0, 200),
      body: `${actorName}: ${summary}`.slice(0, 1_000),
      payload: JSON.stringify({ link: target.link || r.link || '', from: 'Following', targetKind: r.targetKind, targetId: r.targetId }),
      sessionId: null, readAt: null, createdAt: nowIso(),
      deliverAfter: delivery.deliverAfter, silent: delivery.silent ? 1 : 0,
      origin: 'user', channel: 1, deliveredAt: null,
    });
    await this.db.execute(sql`
      DELETE FROM agent_events WHERE "agentId" = ${agentId} AND "id" NOT IN (
        SELECT "id" FROM agent_events WHERE "agentId" = ${agentId} ORDER BY "createdAt" DESC LIMIT 200)
    `);
  }

  /** Agent followers named as `@Name` (or `@name-handle`) in `text`. */
  private async namedIn(text: string, rows: Follow[]): Promise<string[]> {
    const ids = [...new Set(rows.filter((r) => r.followerKind === 'agent' && !r.mutedAt).map((r) => r.followerId))];
    if (ids.length === 0 || !text.includes('@')) return [];
    const hay = text.toLowerCase();
    const named = await this.db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, ids));
    return named.filter((a) => {
      const n = a.name.toLowerCase().trim();
      return n && (hay.includes(`@${n}`) || hay.includes(`@${n.replace(/\s+/g, '-')}`) || hay.includes(`@${n.replace(/\s+/g, '')}`));
    }).map((a) => a.id);
  }

  private async nameOf(who: Follower): Promise<string> {
    if (who.kind === 'agent') {
      return (await this.db.select({ name: agents.name }).from(agents).where(eq(agents.id, who.id)).limit(1)).at(0)?.name ?? 'an agent';
    }
    try {
      const row = (await this.db.execute(sql`SELECT "name", "email" FROM accounts WHERE "id" = ${who.id} LIMIT 1`)).rows[0] as { name?: string; email?: string } | undefined;
      return row?.name || row?.email?.split('@')[0] || 'a person';
    } catch { return 'a person'; }
  }

  // ---- the heartbeat ----

  /** The tunables of the workspace's organization (defaults without one). */
  private async orgOf(workspaceId: string): Promise<{ tunables: string | null } | null> {
    try {
      return (await this.db.select({ tunables: organizations.tunables }).from(organizations)
        .where(and(eq(organizations.workspaceId, workspaceId), ne(organizations.status, 'archived'))).limit(1)).at(0) ?? null;
    } catch { return null; }
  }

  /** Live rows of an agent that still report: not muted, and the target is
   *  open or closed less than `follow.closedWindowHours` ago. */
  private async reporting(agentId: string, now: Date): Promise<{ rows: Follow[]; org: { tunables: string | null } | null }> {
    const rows = await this.db.select().from(follows).where(and(eq(follows.followerKind, 'agent'), eq(follows.followerId, agentId), isNull(follows.mutedAt)));
    if (rows.length === 0) return { rows, org: null };
    const org = await this.orgOf(rows[0].workspaceId);
    const cutoff = new Date(now.getTime() - followTunable(org, 'follow.closedWindowHours') * 3_600_000).toISOString();
    return { rows: rows.filter((r) => !r.closedAt || r.closedAt > cutoff), org };
  }

  /**
   * The heartbeat reason: followed targets with an attention the agent has
   * not been woken for yet. Debounced per agent — no second follow wake
   * within `follow.wakeDebounceMinutes` of the last one — and the rows it
   * names are stamped `wokeAt` so the same change never wakes twice.
   */
  async wakeReasons(agentId: string, now: Date = new Date()): Promise<string[]> {
    const { rows, org } = await this.reporting(agentId, now);
    const due = rows.filter((r) => r.attentionAt && (!r.wokeAt || r.attentionAt > r.wokeAt));
    if (due.length === 0) return [];
    const debounceMs = followTunable(org, 'follow.wakeDebounceMinutes') * 60_000;
    const lastWoke = rows.reduce<string | null>((m, r) => (r.wokeAt && (!m || r.wokeAt > m) ? r.wokeAt : m), null);
    if (debounceMs > 0 && lastWoke && now.getTime() - new Date(lastWoke).getTime() < debounceMs) return [];
    due.sort((a, b) => (a.attentionAt! < b.attentionAt! ? -1 : 1));
    await this.db.update(follows).set({ wokeAt: now.toISOString() }).where(inArray(follows.id, due.map((r) => r.id)));
    return due.map((r) => `Following ${labelOf(r.targetKind as FollowTargetKind, r.targetId, r.title)}: ${r.attention || 'needs you'}${r.lastActorName ? ` (${r.lastActorName})` : ''}`);
  }

  /**
   * The "Following — new since your last beat" section: one line per
   * followed target with unseen activity (bounded by `follow.contextItems`),
   * and the row ids the caller marks seen once the beat ran.
   */
  async digest(agentId: string, now: Date = new Date()): Promise<{ text: string; ids: string[] }> {
    const { rows, org } = await this.reporting(agentId, now);
    const unseen = rows.filter((r) => r.unseenCount > 0).sort((a, b) => ((b.lastActivityAt ?? '') > (a.lastActivityAt ?? '') ? 1 : -1));
    if (unseen.length === 0) return { text: '', ids: [] };
    const cap = Math.round(followTunable(org, 'follow.contextItems'));
    const shown = unseen.slice(0, cap);
    const lines = shown.map((r) => {
      const n = r.unseenCount;
      const what = r.targetKind === 'thread' ? `${n} new repl${n === 1 ? 'y' : 'ies'}` : `${n} update${n === 1 ? '' : 's'}`;
      return `- ${labelOf(r.targetKind as FollowTargetKind, r.targetId, r.title)}: ${what}, last from ${r.lastActorName || 'someone'} — ${r.lastActivity}${r.attention ? ` [needs you: ${r.attention}]` : ''}${r.closedAt ? ' (closed)' : ''}`;
    });
    if (unseen.length > shown.length) lines.push(`- …and ${unseen.length - shown.length} more (list_follows)`);
    return { text: lines.join('\n'), ids: shown.map((r) => r.id) };
  }

  // ---- resolving what a tool names ----

  /**
   * Resolve a tool's `kind` + `id` inside one workspace: a thread by any of
   * its message ids (full or a prefix of at least 4), a task by an org task
   * or agent kanban task id (full or prefix). A private channel resolves only
   * for its members. Throws on no match or an ambiguous prefix.
   */
  async resolve(workspaceId: string, kind: string, rawId: string, forAgentId?: string | null): Promise<FollowTarget> {
    const id = prefixOk(String(rawId ?? '').trim().replace(/^\[|\]$/g, ''));
    if (id.length < 4) throw new BadRequestException('id is required (a message id, or a task id — at least 4 characters)');
    const like = `${id}%`;
    if (kind === 'thread') {
      const rows = (await this.db.execute(sql`
        SELECT m."id", m."threadRootId", m."channelId", c."slug", c."kind" FROM channel_messages m JOIN channels c ON c."id" = m."channelId"
        WHERE c."workspaceId" = ${workspaceId} AND (m."id" = ${id} OR m."id" LIKE ${like}) LIMIT 3
      `)).rows as Array<{ id: string; threadRootId: string | null; channelId: string; slug: string; kind: string }>;
      const hit = rows.find((r) => r.id === id) ?? (rows.length === 1 ? rows[0] : null);
      if (!hit) throw new NotFoundException(rows.length ? `message id "${id}" matches ${rows.length} messages — use more of it` : `no message "${id}" in this workspace's channels`);
      if (hit.kind === 'private' && forAgentId) {
        const member = (await this.db.execute(sql`SELECT 1 FROM channel_members WHERE "channelId" = ${hit.channelId} AND "memberKind" = 'agent' AND "memberId" = ${forAgentId} LIMIT 1`)).rows.length > 0;
        if (!member) throw new NotFoundException(`no message "${id}" in this workspace's channels`);
      }
      const rootId = hit.threadRootId ?? hit.id;
      const root = (await this.db.execute(sql`SELECT "text" FROM channel_messages WHERE "id" = ${rootId} LIMIT 1`)).rows[0] as { text?: string } | undefined;
      return threadTarget(workspaceId, hit.slug, rootId, root?.text ?? '');
    }
    if (kind === 'task' || kind === 'org_task' || kind === 'agent_task') {
      // A key (ENG-12, any case) names one task in the workspace (docs/tasks-keys.md).
      const key = normalizeTaskKey(id) ?? '';
      const org = kind === 'agent_task' ? [] : (await this.db.execute(sql`
        SELECT t."id", t."key", t."title" FROM org_tasks t JOIN organizations o ON o."id" = t."orgId"
        WHERE o."workspaceId" = ${workspaceId} AND (t."id" = ${id} OR t."id" LIKE ${like} OR t."key" = ${key}) LIMIT 3
      `)).rows as Array<{ id: string; key: string | null; title: string }>;
      const own = kind === 'org_task' ? [] : (await this.db.execute(sql`
        SELECT t."id", t."key", t."title", t."agentId" FROM agent_tasks t JOIN agents a ON a."id" = t."agentId"
        WHERE a."workspaceId" = ${workspaceId} AND (t."id" = ${id} OR t."id" LIKE ${like} OR t."key" = ${key}) LIMIT 3
      `)).rows as Array<{ id: string; key: string | null; title: string; agentId: string }>;
      const all = [...org.map((t) => ({ ...t, kind: 'org_task' as const })), ...own.map((t) => ({ ...t, kind: 'agent_task' as const }))];
      const exact = all.filter((t) => t.id === id || (key && t.key === key));
      const hits = exact.length ? exact : all;
      if (hits.length !== 1) throw new NotFoundException(hits.length ? `task "${id}" matches ${hits.length} tasks — use its key` : `no task "${id}" in this workspace`);
      const t = hits[0];
      return t.kind === 'org_task' ? orgTaskTarget(workspaceId, t.id, t.title, t.key) : agentTaskTarget(workspaceId, t.id, t.title, t.key);
    }
    if (kind === 'discussion' || kind === 'channel') {
      // A sub-channel (docs/group-chat.md §9) by its slug or id; private ones for members only.
      const slug = String(rawId ?? '').trim().replace(/^#/, '').toLowerCase();
      const rows = (await this.db.execute(sql`
        SELECT c."id", c."slug", c."name", c."kind" FROM channels c
        WHERE c."workspaceId" = ${workspaceId} AND c."channelKind" = 'sub' AND (c."id" = ${slug} OR c."slug" = ${slug}) LIMIT 2
      `)).rows as Array<{ id: string; slug: string; name: string; kind: string }>;
      const hit = rows[0];
      if (!hit) throw new NotFoundException(`no discussion "${slug}" in this workspace`);
      if (hit.kind === 'private' && forAgentId) {
        const member = (await this.db.execute(sql`SELECT 1 FROM channel_members WHERE "channelId" = ${hit.id} AND "memberKind" = 'agent' AND "memberId" = ${forAgentId} LIMIT 1`)).rows.length > 0;
        if (!member) throw new NotFoundException(`no discussion "${slug}" in this workspace`);
      }
      return { kind: 'channel', id: hit.id, workspaceId, title: `#${hit.slug}: ${hit.name}`.slice(0, 200), link: spaPath.channel(workspaceId, hit.slug) };
    }
    throw new BadRequestException('kind must be thread, task or discussion');
  }

  /** A target by its exact kind and id, checked to be in the workspace (the
   *  SPA's routes). */
  async target(workspaceId: string, kind: FollowTargetKind, id: string): Promise<FollowTarget> {
    if (!FOLLOW_TARGET_KINDS.includes(kind)) throw new BadRequestException('targetKind must be thread, org_task, agent_task or channel');
    const t = await this.resolve(workspaceId, kind, id);
    if (t.id !== id && kind !== 'thread') throw new NotFoundException(`no ${kind} "${id}"`);
    return t;
  }
}

/** How the digest and the reasons name a target. */
export function labelOf(kind: FollowTargetKind, id: string, title: string): string {
  // A task's title carries its key (docs/tasks-keys.md): `ENG-12 Title`.
  const keyed = kind !== 'thread' ? /^([A-Z][A-Z0-9]{1,5}-\d+) (.*)$/s.exec(title) : null;
  const ref = keyed ? keyed[1] : `[${id.slice(0, 8)}]`;
  const body = keyed ? keyed[2] : title;
  const t = body ? ` "${body.slice(0, 80)}"` : '';
  if (kind === 'thread') return `thread${t || ` ${id.slice(0, 8)}`} (${id.slice(0, 8)})`;
  if (kind === 'channel') return `discussion${t || ` ${id.slice(0, 8)}`}`;
  if (kind === 'org_task') return `task ${ref}${t}`;
  return `board task ${ref}${t}`;
}

/** A task's follow title: `ENG-12 Title` (the key leads, docs/tasks-keys.md). */
function keyedTitle(title: string, key?: string | null): string { return key ? `${key} ${title}` : title; }

export function threadTarget(workspaceId: string, slug: string, rootId: string, rootText: string): FollowTarget {
  return { kind: 'thread', id: rootId, workspaceId, title: `#${slug}: ${rootText.replace(/\s+/g, ' ').trim().slice(0, 60)}`, link: spaPath.channel(workspaceId, slug, rootId) };
}

/** The SPA link to one org task (`/<workspaceId>/tasks/<id>`, docs/routes.md): Operations › Board with its drawer open. */
export function orgTaskLink(workspaceId: string, taskId: string): string {
  return spaPath.task(workspaceId, taskId);
}

export function orgTaskTarget(workspaceId: string, taskId: string, title: string, key?: string | null): FollowTarget {
  return { kind: 'org_task', id: taskId, workspaceId, title: keyedTitle(title, key), link: orgTaskLink(workspaceId, taskId) };
}

export function agentTaskTarget(workspaceId: string, taskId: string, title: string, key?: string | null): FollowTarget {
  return { kind: 'agent_task', id: taskId, workspaceId, title: keyedTitle(title, key), link: '' };
}

/** `agent:<id>` / `human:<id>` / `user` → a follower (the user = `userId`);
 *  system actors (check, cadence, postmortem, …) → null. */
export function followerFromActor(actor: string | null | undefined, userId: string): Follower | null {
  const a = (actor ?? '').trim();
  if (a.startsWith('agent:')) return a.slice(6) ? { kind: 'agent', id: a.slice(6) } : null;
  if (a.startsWith('human:')) return a.slice(6) ? { kind: 'user', id: a.slice(6) } : null;
  if (a === 'user') return userId ? { kind: 'user', id: userId } : null;
  return null;
}
