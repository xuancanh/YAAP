/**
 * WorkspacesService — workspace CRUD + durable workspace chat memory (§12).
 * A default workspace is ensured on first use so the app works zero-config.
 */
import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { workspaces } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';

@Injectable()
export class WorkspacesService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  list() {
    const all = this.db.select().from(workspaces).all();
    if (all.length > 0) return all;
    const def = { id: newId(), name: 'Default', color: '#F5C451', memory: '', createdAt: nowIso() };
    this.db.insert(workspaces).values(def).run();
    return [def];
  }

  create(input: { name: string; color?: string }) {
    const row = {
      id: newId(),
      name: input.name,
      color: input.color ?? '#F5C451',
      memory: '',
      createdAt: nowIso(),
    };
    this.db.insert(workspaces).values(row).run();
    return row;
  }

  update(id: string, patch: Partial<{ name: string; color: string; memory: string }>) {
    const found = this.db.select().from(workspaces).where(eq(workspaces.id, id)).get();
    if (!found) throw new NotFoundException(`workspace ${id}`);
    this.db.update(workspaces).set(patch).where(eq(workspaces.id, id)).run();
    return { ...found, ...patch };
  }

  remove(id: string) {
    this.db.delete(workspaces).where(eq(workspaces.id, id)).run();
    return { ok: true };
  }
}
