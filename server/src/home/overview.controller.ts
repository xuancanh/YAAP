/**
 * The overviews (docs/mission-control.md):
 *
 *  GET /api/agents/:id/overview                   an agent's Dashboard tab (AgentOverview)
 *  GET /api/workspaces/:id/org/mission-control    the org chart's mission control (MissionControl)
 *
 * Both are workspace-scoped reads: the agent's own workspace, or the named
 * one, must be visible to the caller (WorkspacesService.get 404s otherwise).
 */
import { Controller, Get, Param } from '@nestjs/common';
import { OverviewService } from './overview.service';

@Controller('agents')
export class AgentOverviewController {
  constructor(private readonly overview: OverviewService) {}

  @Get(':id/overview') get(@Param('id') id: string) {
    return this.overview.agent(id);
  }
}

@Controller('workspaces/:id/org/mission-control')
export class MissionControlController {
  constructor(private readonly overview: OverviewService) {}

  @Get() get(@Param('id') id: string) {
    return this.overview.missionControl(id);
  }
}
