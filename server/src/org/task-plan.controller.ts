/**
 * Task plan routes (docs/task-execution.md), read-only — the plan is the
 * performing agent's; people read it on the task and in the Work log:
 *
 *  GET /api/chats/:sid/task-plan                        the plan the session takes part in (master, lead or worker), or { plan: null }
 *  GET /api/workspaces/:id/org/tasks/:taskId/plan       a company task's plan, or { plan: null }
 *
 * Each answers the plan view: steps with status, the session that ran each,
 * outputs and criteria, cost per step; the master/worker session tree; the
 * decision log; the handoff packets; the versions with their diffs.
 */
import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatsService } from '../chats/chats.service';
import { OrgModeService } from './org-mode.service';
import { OrgTasksService } from './org-tasks.service';
import { TaskPlanService } from './task-plan.service';

@Controller()
export class TaskPlanController {
  constructor(
    private readonly plans: TaskPlanService,
    private readonly chats: ChatsService,
    private readonly mode: OrgModeService,
    private readonly tasks: OrgTasksService,
    private readonly config: ConfigService,
  ) {}

  @Get('chats/:sid/task-plan') async forSession(@Param('sid') sid: string) {
    await this.chats.get(sid);
    const plan = await this.plans.forSession(sid);
    return plan ? this.plans.view(plan) : { plan: null };
  }

  @Get('workspaces/:id/org/tasks/:taskId/plan') async forTask(@Param('id') id: string, @Param('taskId') taskId: string) {
    if (this.config.get<boolean>('companiesEnabled') === false) throw new NotFoundException('organizations are disabled (COMPANIES_ENABLED=false)');
    const orgId = await this.mode.orgIdOf(id);
    const task = await this.tasks.get(orgId, taskId);
    const plan = await this.plans.forTask(task.id);
    return plan ? this.plans.view(plan) : { plan: null };
  }
}
