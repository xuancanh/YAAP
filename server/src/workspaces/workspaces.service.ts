/**
 * WorkspacesService — workspace CRUD + durable workspace chat memory (§12).
 * A default workspace is ensured on first use so the app works zero-config.
 * Workspace files live in S3-compatible object storage (see StorageService);
 * deleting a workspace also deletes its object prefix.
 */
import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { workspaces } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { StorageService } from '../storage/storage.service';
import { workspacePrefix } from '../storage/storage.keys';

export interface ProfileProposal {
  id: string;
  entry: string;
  agentName: string;
  sessionId: string;
  at: string;
}

const PROFILE_CAP = 20_000;
const PENDING_LIMIT = 30;

function parsePending(raw: string): ProfileProposal[] {
  try { return JSON.parse(raw) as ProfileProposal[]; } catch { return []; }
}

@Injectable()
export class WorkspacesService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly storage: StorageService,
  ) {}

  async list() {
    const all = await this.db.select().from(workspaces);
    if (all.length > 0) return all;
    const def = { id: newId(), name: 'Default', color: '#F5C451', memory: '', profile: '', profilePending: '[]', createdAt: nowIso() };
    await this.db.insert(workspaces).values(def);
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
      createdAt: nowIso(),
    };
    await this.db.insert(workspaces).values(row);
    return row;
  }

  async update(id: string, patch: Partial<{ name: string; color: string; memory: string; profile: string }>) {
    await this.get(id);
    if (patch.profile !== undefined) patch.profile = patch.profile.slice(0, PROFILE_CAP);
    await this.db.update(workspaces).set(patch).where(eq(workspaces.id, id));
    return this.get(id);
  }

  // ---- consented user profile (roadmap phase 1) ----
  // Agents never write the profile directly: update_user_profile queues a
  // proposal here, and only an explicit user approval lands it.

  /** Called by the agent's update_user_profile tool. */
  async addProfileProposal(id: string, input: { entry: string; agentName?: string; sessionId?: string }): Promise<string> {
    const ws = await this.get(id);
    const entry = (input.entry ?? '').trim().slice(0, 500);
    if (!entry) throw new Error('profile entry is empty');
    const pending = parsePending(ws.profilePending);
    if (pending.length >= PENDING_LIMIT) {
      return 'Proposal queue is full; the user has pending proposals to review first.';
    }
    // duplicate of an existing proposal or an already-known fact: no-op
    if (pending.some((p) => p.entry === entry) || ws.profile.includes(entry)) {
      return 'Already known or already proposed.';
    }
    pending.push({ id: newId(), entry, agentName: input.agentName ?? '', sessionId: input.sessionId ?? '', at: nowIso() });
    await this.db.update(workspaces).set({ profilePending: JSON.stringify(pending) }).where(eq(workspaces.id, id));
    return 'Proposed. The user will review it before it enters the profile; do not assume it is remembered yet.';
  }

  async resolveProfileProposal(id: string, proposalId: string, approve: boolean) {
    const ws = await this.get(id);
    const pending = parsePending(ws.profilePending);
    const proposal = pending.find((p) => p.id === proposalId);
    if (!proposal) throw new NotFoundException(`proposal ${proposalId}`);
    const rest = pending.filter((p) => p.id !== proposalId);
    const patch: Record<string, string> = { profilePending: JSON.stringify(rest) };
    if (approve) {
      patch.profile = `${ws.profile.trimEnd()}\n- ${proposal.entry}`.trim().slice(0, PROFILE_CAP);
    }
    await this.db.update(workspaces).set(patch).where(eq(workspaces.id, id));
    return this.get(id);
  }

  async remove(id: string) {
    await this.db.delete(workspaces).where(eq(workspaces.id, id));
    await this.storage.deletePrefix(workspacePrefix(id));
    return { ok: true };
  }
}
