/**
 * HomeModule — `GET /api/workspaces/:id/home` and the Inbox's History,
 * `GET /api/workspaces/:id/inbox/history` (docs/home.md), and the two
 * overviews built on the same per-agent status (docs/mission-control.md):
 * `GET /api/agents/:id/overview` and `GET /api/workspaces/:id/org/mission-control`;
 * and the top bar's status, switcher rows and notifications (topbar.controller.ts).
 * It owns no state beyond the per-person visit row: everything it shows
 * comes from the services that already own it (org approvals, plans,
 * incidents, intent, pulse, the brief, capital, the action log and trust,
 * agents, heartbeats, follows, usage and the workspace filesystem).
 */
import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ActionsModule } from '../actions/actions.module';
import { UsageModule } from '../usage/usage.module';
import { AiModule } from '../ai/ai.module';
import { OrgModule } from '../org/org.module';
import { ChatsModule } from '../chats/chats.module';
import { HomeController } from './home.controller';
import { HomeService } from './home.service';
import { InboxController } from './inbox.controller';
import { InboxMessagesController } from './inbox-messages.controller';
import { InboxHistoryService } from './inbox-history.service';
import { OverviewService } from './overview.service';
import { AgentOverviewController, MissionControlController } from './overview.controller';
import { TopBarService } from './topbar.service';
import { TopBarController, TopBarWorkspacesController } from './topbar.controller';

@Module({
  imports: [AgentsModule, WorkspacesModule, ActionsModule, UsageModule, AiModule, OrgModule, ChatsModule],
  controllers: [HomeController, InboxController, InboxMessagesController, AgentOverviewController, MissionControlController, TopBarController, TopBarWorkspacesController],
  providers: [HomeService, InboxHistoryService, OverviewService, TopBarService],
})
export class HomeModule {}
