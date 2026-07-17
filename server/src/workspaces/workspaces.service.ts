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

@Injectable()
export class WorkspacesService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly storage: StorageService,
  ) {}

  async list() {
    const all = await this.db.select().from(workspaces);
    if (all.length > 0) return all;
    const def = { id: newId(), name: 'Default', color: '#F5C451', memory: '', createdAt: nowIso() };
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
      createdAt: nowIso(),
    };
    await this.db.insert(workspaces).values(row);
    return row;
  }

  async update(id: string, patch: Partial<{ name: string; color: string; memory: string }>) {
    await this.get(id);
    await this.db.update(workspaces).set(patch).where(eq(workspaces.id, id));
    return this.get(id);
  }

  async remove(id: string) {
    await this.db.delete(workspaces).where(eq(workspaces.id, id));
    await this.storage.deletePrefix(workspacePrefix(id));
    return { ok: true };
  }
}
