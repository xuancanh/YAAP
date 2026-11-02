/**
 * HomeModule — `GET /api/workspaces/:id/home` and the Inbox's History,
 * `GET /api/workspaces/:id/inbox/history` (docs/home.md). It owns no
 * state beyond the per-person visit row: everything it shows comes from the
 * services that already own it (org approvals, plans, incidents, intent,
 * pulse, the brief, capital, the action log, agents, heartbeats, usage and
 * the workspace filesystem).
 */
import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ActionsModule } from '../actions/actions.module';
import { UsageModule } from '../usage/usage.module';
import { AiModule } from '../ai/ai.module';
import { OrgModule } from '../org/org.module';
import { HomeController } from './home.controller';
import { HomeService } from './home.service';
import { InboxController } from './inbox.controller';
import { InboxHistoryService } from './inbox-history.service';

@Module({
  imports: [AgentsModule, WorkspacesModule, ActionsModule, UsageModule, AiModule, OrgModule],
  controllers: [HomeController, InboxController],
  providers: [HomeService, InboxHistoryService],
})
export class HomeModule {}
