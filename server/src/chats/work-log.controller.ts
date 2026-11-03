/**
 * The Work log HTTP surface (docs/work-log.md):
 *
 *   GET /api/agents/:agentId/work-log?trigger=&key=&outcome=&task=&session=&from=&to=&q=&limit=&cursor=
 *       one page of the agent's runs, newest first, plus the trigger groups
 *   GET /api/agents/:agentId/work-log/runs/:turnId
 *       one run: thinking, tool calls with inputs and outputs, files, cost
 *   GET /api/agents/:agentId/work-log/sessions/:sessionId/latest
 *       the newest run of a session (deep links to a work session)
 *   POST /api/agents/:agentId/work-log/runs/:turnId/rerun
 *       run a failed or stopped run again, by its trigger, in its session
 */
import { Controller, Get, NotFoundException, Optional, Param, Post, Query } from '@nestjs/common';
import { WorkLogService } from './work-log.service';
import { WorkRerunService } from './work-rerun.service';

@Controller('agents/:agentId/work-log')
export class WorkLogController {
  constructor(private readonly log: WorkLogService, @Optional() private readonly reruns?: WorkRerunService) {}

  @Get()
  list(@Param('agentId') agentId: string, @Query('trigger') trigger?: string, @Query('key') key?: string, @Query('outcome') outcome?: string,
    @Query('task') task?: string, @Query('session') session?: string, @Query('from') from?: string, @Query('to') to?: string,
    @Query('q') q?: string, @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.log.list(agentId, {
      trigger, key, outcome, task, sessionId: session || undefined, from, to, q,
      limit: limit ? Number(limit) || undefined : undefined, cursor: cursor || null,
    });
  }

  @Get('runs/:turnId')
  run(@Param('agentId') agentId: string, @Param('turnId') turnId: string) {
    return this.log.run(agentId, turnId);
  }

  @Post('runs/:turnId/rerun')
  rerun(@Param('agentId') agentId: string, @Param('turnId') turnId: string) {
    if (!this.reruns) throw new NotFoundException('rerun is not available');
    return this.reruns.rerun(agentId, turnId);
  }

  @Get('sessions/:sessionId/latest')
  latest(@Param('agentId') agentId: string, @Param('sessionId') sessionId: string) {
    return this.log.latestRunOf(agentId, sessionId);
  }
}
