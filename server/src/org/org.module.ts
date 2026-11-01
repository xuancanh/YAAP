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
import { OrgIntentService } from './org-intent.service';
import { WorkspaceOrgController } from './workspace-org.controller';
import { OrgSignalsService } from './org-signals.service';
import { OrgSloService } from './org-slo.service';
import { OrgAuditorService } from './org-auditor.service';
import { OrgMeetingsService } from './org-meetings.service';
import { OrgMeetingRuntime } from './org-meeting-runtime.service';
import { OrgCapitalService } from './org-capital.service';
import { OrgPlaybooksService } from './org-playbooks.service';
import { OrgKnowledgeService } from './org-knowledge.service';
import { OrgMemoryService } from './org-memory.service';
import { RegistryModule } from '../registry/registry.module';
import { OrgRolesService } from './org-roles.service';
import { OrgBlueprintsService } from './org-blueprints.service';
import { BlueprintsController } from './blueprints/blueprints.controller';
import { CompaniesController } from './blueprints/companies.controller';
import { OrgBootstrapService } from './org-bootstrap.service';

/**
 * Organization mode (docs/group-chat.md §5, item 16) adds OrgModeService,
 * the workspace-scoped controller and the Announcer seam. `#company`
 * announcements reach the group chat (item 15) because GroupChatService
 * binds itself into the exported OrgAnnouncer wrapper (see org-announcer.ts);
 * without that module the wrapper drops them and everything else works.
 * Units (docs/group-chat.md §7, item 17): OrgUnitsService derives a board, a
 * channel and a goal tree per org level from the chart, through the same seam.
 * Assurance (docs/company-vision.md §5, item 20): OrgSignalsService and
 * OrgSloService are model-free and run on the runtime's tick; the
 * OrgAuditorService drives an audit run through the runtime on its own
 * cadence timer.
 * Intent (docs/company-vision.md §1b–§2, item 18): OrgIntentService holds the
 * vision, key results, check-ins and the model-free risk assessment; the
 * runtime runs the planning cascade and reads the org's tunables; it also
 * registers the org's reasons (open tasks, due check-ins) and the operating
 * profile on the gated heartbeat (docs/company-vision.md §13, item 21).
 * Rituals (docs/company-vision.md §3, item 19): OrgMeetingsService and
 * OrgMeetingRuntime run meetings as unit-channel threads through the
 * `MeetingChannels` half of the seam; the group chat's `/meeting` command
 * reaches the runtime because GroupChatModule imports this module.
 * Capital (docs/company-vision.md §7–§8, item 23): OrgCapitalService is the
 * model-free cost roll-up, forecast, plan preview and replay; the runtime
 * binds the one way a plan's action becomes a change (`bindApplier`).
 * Memory (docs/company-vision.md §6, item 22): OrgPlaybooksService (skills
 * the company reviews), OrgKnowledgeService (recall, ask-the-company, the
 * graph) and OrgMemoryService (the tools, postmortem triggers, lessons, the
 * decision-log rows of approvals and autonomous actions).
 * Blueprints (docs/company-vision.md §9, item 24): OrgRolesService is the role
 * catalog as data; OrgBlueprintsService exports and imports COMPANY.json and
 * applies the `blueprint` approval; the two controllers add the workspace
 * routes and `/api/market/companies` over RegistryModule's review gate.
 * Onboarding (item 25): OrgBootstrapService runs the whole company setup
 * behind `POST /api/workspaces/:id/org/bootstrap`, calling the services
 * above in order so no step has a second code path.
 */
@Module({
  imports: [AgentsModule, ChatsModule, WorkspacesModule, SkillsModule, SettingsModule, ActionReviewModule, AiModule, RegistryModule],
  controllers: [OrgController, WorkspaceOrgController, BlueprintsController, CompaniesController],
  providers: [OrgService, OrgUnitsService, OrgIntentService, OrgTasksService, OrgApprovalsService, OrgAuditService, OrgSignalsService, OrgSloService, OrgCapitalService, OrgBriefService, OrgRuntimeService, OrgAuditorService, OrgAnnouncer, OrgModeService, OrgController, OrgMeetingsService, OrgMeetingRuntime, OrgPlaybooksService, OrgKnowledgeService, OrgMemoryService, OrgRolesService, OrgBlueprintsService, OrgBootstrapService],
  exports: [OrgService, OrgUnitsService, OrgIntentService, OrgTasksService, OrgRuntimeService, OrgModeService, OrgAnnouncer, OrgSignalsService, OrgSloService, OrgAuditorService, OrgMeetingsService, OrgMeetingRuntime, OrgCapitalService, OrgPlaybooksService, OrgKnowledgeService, OrgMemoryService, OrgRolesService, OrgBlueprintsService, OrgBootstrapService],
})
export class OrgModule {}
