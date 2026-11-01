/**
 * OrgModule — the autonomous company (docs/autonomous-company.md, execution
 * plan item 14, phases A–C): organisations, the shared board, the
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

@Module({
  imports: [AgentsModule, ChatsModule, WorkspacesModule, SkillsModule, SettingsModule, ActionReviewModule, AiModule],
  controllers: [OrgController],
  providers: [OrgService, OrgTasksService, OrgApprovalsService, OrgAuditService, OrgBriefService, OrgRuntimeService],
  exports: [OrgService, OrgTasksService, OrgRuntimeService],
})
export class OrgModule {}
