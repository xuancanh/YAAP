/**
 * WorkspacesService — workspace CRUD + durable workspace chat memory (§12).
 * A default workspace is ensured on first use so the app works zero-config.
 * Workspace files live in S3-compatible object storage (see StorageService);
 * deleting a workspace also deletes its object prefix.
 */
import { Injectable, Inject, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { actorId, currentAccountId, currentViewer } from '../accounts/account-context';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { agents, workspaceFileRevisions, workspaceFiles, workspaces } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { StorageService } from '../storage/storage.service';
import { workspacePrefix } from '../storage/storage.keys';
import { moveAgentHome } from '../files/agent-home';
import { validateQuietHours } from './quiet-hours';
import { validateHeartbeatDefaults } from '../chats/heartbeat-config';
import { monthKey, spendStatus, SpendStatus } from './spend.util';

export interface ProfileProposal {
  id: string;
  entry: string;
  agentName: string;
  sessionId: string;
  at: string;
  /** 'shared' or 'private:<memberAccountId>' (docs/shared-agents.md §4):
   *  where the entry lands when approved, and who may approve it. */
  audience?: string;
}

/** Per-member private profile sections: { [memberAccountId]: text }. */
export function parsePrivateProfile(raw: string | undefined): Record<string, string> {
  try { const v = JSON.parse(raw || '{}') as unknown; return v && typeof v === 'object' ? (v as Record<string, string>) : {}; } catch { return {}; }
}

export type OrgMode = 'off' | 'supervised' | 'autonomous';
export const ORG_MODES: readonly OrgMode[] = ['off', 'supervised', 'autonomous'];
export const DEFAULT_ORG_AGENT_CAP = 12;
const ORG_OFF = { orgMode: 'off' as OrgMode, chiefOfStaffAgentId: null as string | null, orgMonthlyUsd: 0, orgAgentCap: DEFAULT_ORG_AGENT_CAP };

const PROFILE_CAP = 20_000;
const PENDING_LIMIT = 30;

function parsePending(raw: string): ProfileProposal[] {
  try { return JSON.parse(raw) as ProfileProposal[]; } catch { return []; }
}

/** Runs after a workspace row is created (the lazy default included), under
 *  the creating context. GroupChatService registers `#general` here so this
 *  module never imports the group-chat domain. */
export type WorkspaceCreatedHook = (workspace: { id: string; name: string }) => Promise<void>;

@Injectable()
export class WorkspacesService {
  private readonly createdHooks: WorkspaceCreatedHook[] = [];

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly storage: StorageService,
  ) {}

  onCreated(hook: WorkspaceCreatedHook): void {
    this.createdHooks.push(hook);
  }

  private async fireCreated(ws: { id: string; name: string }): Promise<void> {
    for (const h of this.createdHooks) await h(ws).catch(() => undefined);
  }

  async list() {
    const all = await this.db.select().from(workspaces);
    if (all.length > 0) return all;
    const def = { id: newId(), name: 'Default', color: '#F5C451', memory: '', profile: '', profilePending: '[]', profilePrivate: '{}', quietHours: '', spendBudgetTokens: 0, spendMonth: '', spendTokens: 0, ...ORG_OFF, heartbeatDefaults: '{}', createdAt: nowIso() };
    await this.db.insert(workspaces).values(def);
    await this.fireCreated(def);
    return [def];
  }

  async get(id: string) {
    const rows = await this.db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    if (!rows[0]) throw new NotFoundException(`workspace ${id}`);
    return rows[0];
  }

  async create(input: { name: string; color?: string }) {
    const row = {
      id: newId(),
      name: input.name,
      color: input.color ?? '#F5C451',
      memory: '',
      profile: '',
      profilePending: '[]',
      profilePrivate: '{}',
      quietHours: '',
      spendBudgetTokens: 0,
      spendMonth: '',
      spendTokens: 0,
      ...ORG_OFF,
      heartbeatDefaults: '{}',
      createdAt: nowIso(),
    };
    await this.db.insert(workspaces).values(row);
    await this.fireCreated(row);
    return row;
  }

  /** Organization-mode fields (docs/group-chat.md §5). Written only by
   *  OrgModeService, which keeps the 1:1 `organizations` row in step. */
  async setOrgFields(id: string, patch: Partial<{ orgMode: OrgMode; chiefOfStaffAgentId: string | null; orgMonthlyUsd: number; orgAgentCap: number }>): Promise<void> {
    await this.get(id);
    await this.db.update(workspaces).set(patch).where(eq(workspaces.id, id));
  }

  async update(id: string, patch: Partial<{ name: string; color: string; memory: string; profile: string; quietHours: string; spendBudgetTokens: number; heartbeatDefaults: string }>) {
    await this.get(id);
    if (patch.profile !== undefined) patch.profile = patch.profile.slice(0, PROFILE_CAP);
    if (patch.heartbeatDefaults !== undefined) {
      // Stored normalized and bounds-checked (chats/heartbeat-config.ts);
      // '' or '{}' falls back to the built-in defaults.
      let parsed: unknown = {};
      if (patch.heartbeatDefaults.trim()) {
        try { parsed = JSON.parse(patch.heartbeatDefaults) as unknown; } catch { throw new BadRequestException('heartbeatDefaults must be JSON'); }
      }
      patch.heartbeatDefaults = JSON.stringify(validateHeartbeatDefaults(parsed));
    }
    if (patch.quietHours !== undefined && patch.quietHours.trim() !== '') {
      // Stored normalized so every reader can trust the shape; '' turns it off.
      try {
        patch.quietHours = JSON.stringify(validateQuietHours(JSON.parse(patch.quietHours) as unknown));
      } catch (err) {
        throw new BadRequestException(err instanceof Error ? err.message : 'invalid quietHours');
      }
    }
    if (patch.spendBudgetTokens !== undefined && (!Number.isInteger(patch.spendBudgetTokens) || patch.spendBudgetTokens < 0)) {
      throw new BadRequestException('spendBudgetTokens must be a non-negative integer');
    }
    await this.db.update(workspaces).set(patch).where(eq(workspaces.id, id));
    return this.get(id);
  }

  // ---- monthly spend stop (roadmap phase 2.5) ----

  /** Add a completed turn's tokens to the month counter. One SQL statement:
   *  concurrent turns must not lose each other's increments, and a new month
   *  starts the counter over instead of carrying last month's total. */
  async addSpend(id: string, tokens: number, now: Date = new Date()): Promise<void> {
    if (tokens <= 0) return;
    const month = monthKey(now);
    await this.db.execute(sql`
      UPDATE workspaces
      SET "spendTokens" = CASE WHEN "spendMonth" = ${month} THEN "spendTokens" + ${tokens} ELSE ${tokens} END,
          "spendMonth" = ${month}
      WHERE "id" = ${id}
    `);
  }

  async spend(id: string, now: Date = new Date()): Promise<SpendStatus> {
    return spendStatus(await this.get(id), now);
  }

  // ---- consented user profile (roadmap phase 1) ----
  // Agents never write the profile directly: update_user_profile queues a
  // proposal here, and only an explicit user approval lands it.

  /** Called by the agent's update_user_profile tool. */
  async addProfileProposal(id: string, input: { entry: string; agentName?: string; sessionId?: string; audience?: string }): Promise<string> {
    const ws = await this.get(id);
    const entry = (input.entry ?? '').trim().slice(0, 500);
    if (!entry) throw new Error('profile entry is empty');
    const pending = parsePending(ws.profilePending);
    if (pending.length >= PENDING_LIMIT) {
      return 'Proposal queue is full; the user has pending proposals to review first.';
    }
    const audience = input.audience ?? 'shared';
    const known = audience === 'shared' ? ws.profile : (parsePrivateProfile(ws.profilePrivate)[audience.slice('private:'.length)] ?? '');
    // duplicate of an existing proposal or an already-known fact: no-op
    if (pending.some((p) => p.entry === entry) || known.includes(entry)) {
      return 'Already known or already proposed.';
    }
    pending.push({ id: newId(), entry, agentName: input.agentName ?? '', sessionId: input.sessionId ?? '', at: nowIso(), audience });
    await this.db.update(workspaces).set({ profilePending: JSON.stringify(pending) }).where(eq(workspaces.id, id));
    return 'Proposed. The user will review it before it enters the profile; do not assume it is remembered yet.';
  }

  /** Who decides a proposal: the owner for shared entries; the member it is
   *  about for private ones (the owner may too). */
  async resolveProfileProposal(id: string, proposalId: string, approve: boolean) {
    const ws = await this.get(id);
    const pending = parsePending(ws.profilePending);
    const proposal = pending.find((p) => p.id === proposalId);
    if (!proposal) throw new NotFoundException(`proposal ${proposalId}`);
    const viewer = currentViewer();
    const audience = proposal.audience ?? 'shared';
    const member = audience.startsWith('private:') ? audience.slice('private:'.length) : null;
    if (viewer && viewer.role !== 'owner' && member !== viewer.memberAccountId) {
      throw new ForbiddenException(member ? 'this proposal is about another member' : 'only the owner reviews the shared profile');
    }
    const rest = pending.filter((p) => p.id !== proposalId);
    const patch: Record<string, string> = { profilePending: JSON.stringify(rest) };
    if (approve) {
      if (member) {
        const priv = parsePrivateProfile(ws.profilePrivate);
        priv[member] = `${(priv[member] ?? '').trimEnd()}\n- ${proposal.entry}`.trim().slice(0, PROFILE_CAP);
        patch.profilePrivate = JSON.stringify(priv);
      } else {
        patch.profile = `${ws.profile.trimEnd()}\n- ${proposal.entry}`.trim().slice(0, PROFILE_CAP);
      }
    }
    await this.db.update(workspaces).set(patch).where(eq(workspaces.id, id));
    return this.get(id);
  }

  /** The profile text a turn initiated by `actor` may see: the shared profile
   *  plus that actor's own private section. Never another member's. */
  profileFor(ws: { profile: string; profilePrivate?: string }, actor: string = actorId()): string {
    const priv = parsePrivateProfile(ws.profilePrivate);
    const own = actor === currentAccountId() ? '' : (priv[actor] ?? '');
    return [ws.profile, own].filter((t) => t.trim()).join('\n');
  }

  async remove(id: string) {
    await this.db.delete(workspaces).where(eq(workspaces.id, id));
    // Its agents are not deleted with it: they re-home to the oldest remaining
    // workspace (an agent always has an owner — execution-plan item 26).
    const rest = (await this.db.select({ id: workspaces.id, createdAt: workspaces.createdAt }).from(workspaces))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    // Their homes live in this workspace's tree (docs/filesystem.md), so they
    // move first — the prefix delete below would take them with it.
    if (rest[0]) {
      for (const a of await this.db.select().from(agents).where(eq(agents.workspaceId, id))) {
        await moveAgentHome(this.db, this.storage, a, rest[0].id).catch(() => {});
      }
    }
    await this.db.update(agents).set({ workspaceId: rest[0]?.id ?? '' }).where(eq(agents.workspaceId, id));
    await this.storage.deletePrefix(workspacePrefix(id));
    await this.db.delete(workspaceFiles).where(eq(workspaceFiles.workspaceId, id));
    await this.db.delete(workspaceFileRevisions).where(eq(workspaceFileRevisions.workspaceId, id));
    return { ok: true };
  }
}
