/**
 * OrgModule — the autonomous company (docs/autonomous-company.md, execution
 * plan item 14, phases A–D; organization mode of docs/group-chat.md §5, item
 * 16): organisations, the shared board, the
 * event-driven runtime, approvals, the hash-chained audit log and the CEO
 * brief. Depends on ChatsModule for TurnLoopService (org runs are ordinary
 * turns) and registers its tool matrix on it at boot; ChatsModule never
 * imports this module.
 */
import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { ChatsModule } from '../chats/chats.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { SkillsModule } from '../skills/skills.module';
import { SettingsModule } from '../settings/settings.module';
import { ActionReviewModule } from '../review/action-review.module';
import { AiModule } from '../ai/ai.module';
import { OrgController } from './org.controller';
import { OrgService } from './org.service';
import { OrgTasksService } from './org-tasks.service';
import { OrgApprovalsService } from './org-approvals.service';
import { OrgAuditService } from './org-audit.service';
import { OrgBriefService } from './org-brief.service';
import { OrgRuntimeService } from './org-runtime.service';
import { OrgModeService } from './org-mode.service';
import { OrgAnnouncer } from './org-announcer';
import { OrgUnitsService } from './org-units.service';
import { WorkspaceOrgController } from './workspace-org.controller';

/**
 * Organization mode (docs/group-chat.md §5, item 16) adds OrgModeService,
 * the workspace-scoped controller and the Announcer seam. `#company`
 * announcements reach the group chat (item 15) because GroupChatService
 * binds itself into the exported OrgAnnouncer wrapper (see org-announcer.ts);
 * without that module the wrapper drops them and everything else works.
 * Units (docs/group-chat.md §7, item 17): OrgUnitsService derives a board, a
 * channel and a goal tree per org level from the chart, through the same seam.
 */
@Module({
  imports: [AgentsModule, ChatsModule, WorkspacesModule, SkillsModule, SettingsModule, ActionReviewModule, AiModule],
  controllers: [OrgController, WorkspaceOrgController],
  providers: [OrgService, OrgUnitsService, OrgTasksService, OrgApprovalsService, OrgAuditService, OrgBriefService, OrgRuntimeService, OrgAnnouncer, OrgModeService, OrgController],
  exports: [OrgService, OrgUnitsService, OrgTasksService, OrgRuntimeService, OrgModeService, OrgAnnouncer],
})
export class OrgModule {}
