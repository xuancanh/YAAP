/**
 * OrgRerunBridge — the Work log's Rerun of an org task run (docs/work-log.md
 * "Intervening"): the task is re-dispatched through the org runtime — the
 * same seat (owner or reviewer), claim, capacity and budget reservation, and
 * the task's own wake prompt — instead of replaying the old prompt. Kanban
 * (agent) tasks fall through to the default (the run's input again).
 */
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { currentAccountId } from '../accounts/account-context';
import { WorkRerunService } from '../chats/work-rerun.service';
import { OrgRuntimeService } from './org-runtime.service';

@Injectable()
export class OrgRerunBridge implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly reruns: WorkRerunService,
    private readonly runtime: OrgRuntimeService,
  ) {}

  onModuleInit(): void {
    this.reruns.register('task', async ({ run, session }) => {
      if (run.task?.kind !== 'org' || !session.agentId) return null;
      const res = await this.db.execute(sql`SELECT "orgId" FROM org_tasks WHERE "id" = ${run.task.id} AND "accountId" = ${currentAccountId()} LIMIT 1`);
      const orgId = ((res as unknown as { rows?: Array<{ orgId: string }> }).rows ?? [])[0]?.orgId;
      if (!orgId) return null;
      return this.runtime.runTask(orgId, run.task.id, session.agentId, 'manual');
    });
  }
}
