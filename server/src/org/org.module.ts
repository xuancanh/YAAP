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
import { TaskMentionsService } from './task-mentions.service';
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
import { ConnectionsModule } from '../connections/connections.module';
import { OrgSensingService } from './org-sensing.service';
import { OrgSensingController, WorkspaceOrgSensingController, MetricsIngestController } from './org-sensing.controller';
import { OrgIncidentsService } from './org-incidents.service';
import { OrgRedTeamService } from './org-redteam.service';
import { IncidentsController } from './incidents.controller';
import { ActionsModule } from '../actions/actions.module';
import { OrgTrustBridge } from './org-trust-bridge';
import { OrgRerunBridge } from './org-rerun.bridge';
import { OrgExperimentsService } from './org-experiments.service';
import { OrgPredictionsService } from './org-predictions.service';
import { OrgReconciliationService } from './org-reconciliation.service';
import { ExperimentsController } from './experiments.controller';
import { OrgBoundaryService } from './org-boundary.service';
import { OrgEvalsService } from './org-evals.service';
import { OrgCapacityService } from './org-capacity.service';
import { OrgSeatService } from './org-seat.service';
import { OrgDecisionsService } from './org-decisions.service';
import { OrgMirrorService } from './org-mirror.service';
import { OrgLayoutService } from './org-layout.service';
import { OrgGovernanceTools } from './org-governance.tools';
import { OrgFoundryTools } from './org-foundry.tools';
import { FoundryModule } from '../foundry/foundry.module';
import { OrgDataTools } from './org-data.tools';
import { OrgProjectsService } from './org-projects.service';
import { OrgProjectsTools } from './org-projects.tools';
import { OrgBriefingService } from './org-briefing.service';
import { OrgNextWorkService } from './org-next-work.service';
import { OrgProjectTeamsService } from './org-project-teams.service';
import { WorkController } from './work.controller';
import { OrgProgramService } from './org-program.service';
import { OrgProgramTools } from './org-program.tools';
import { ProgramController } from './program.controller';
import { GovernanceController } from './governance.controller';
import { OrgChiefService } from './org-chief.service';
import { OrgMeetingMinutesService } from './meeting-minutes.service';
import { MeetingsCalendarService, WorkspaceMeetingsController } from './meetings-calendar';
import { OrgLifecycleService } from './org-lifecycle.service';
import { PluginsModule } from '../plugins/plugins.module';

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
 * Sensing (docs/sensing.md, item 27): OrgSensingService holds the metric
 * sources and their samples, polls and marks staleness on its own minute
 * tick, binds itself as OrgTasksService's acceptance gate (task checks run
 * before review), activates `metric_source` approvals and offers its tools;
 * it reads connections through ConnectionsModule.
 * Incidents (docs/incidents.md, item 29): OrgIncidentsService detects from
 * the runtime's breakers, the auditor's findings, connection and provider
 * health and the tool-error streak, contains by severity, tells the owner,
 * schedules the postmortem and leads the brief; OrgRedTeamService runs the
 * record-only canary passes; IncidentsController adds the workspace routes.
 * Trust (docs/actions-and-trust.md, item 28): OrgTrustBridge binds the
 * action contract and the trust ledger (ActionsModule) to the audit chain,
 * signals, `two_key` approvals, review verdicts, incidents and the freeze.
 * Experiments (docs/experiments.md, item 30): OrgExperimentsService runs
 * changes as measured hypotheses (start, daily revert-rule check, verdict,
 * revert) and holds structural ones in plans; OrgPredictionsService is the
 * prediction ledger and registers the calibration the trust ledger reads
 * (calibration-registry.ts); OrgReconciliationService compares claims with
 * ground truth daily and feeds the brief and the auditor's sample;
 * ExperimentsController adds the workspace routes.
 * Governance (item 31): OrgBoundaryService binds the self-modification
 * boundary into OrgService (docs/boundary.md); OrgEvalsService harvests
 * golden sets and gates charter, playbook and routing rollouts
 * (docs/evals.md); OrgCapacityService is the WIP, duration and deadline
 * model; OrgSeatService holds decision-card defaults, delegations and value
 * accounting (docs/owners-seat.md); OrgGovernanceTools offers their tools and
 * GovernanceController their routes. OrgDataTools offers the company's data
 * as read tools (docs/agent-data-access.md).
 * The chief of staff (docs/chief-of-staff.md): OrgChiefService computes the
 * operating system's state (rituals due, overdue decisions, stale risks,
 * breached handoffs) for the chief's heartbeat; onboarding seeds the ledger
 * and the derived tunables through OrgBootstrapService.
 * Lifecycle (docs/owners-seat.md "Archive or delete the company"):
 * OrgLifecycleService archives (reversible), restores and permanently
 * deletes the company; the final delete entry lands on the workspace's
 * audit chain (PluginsModule's PluginAuditService).
 * Next work (docs/work-tracking.md "Pull next"): OrgNextWorkService pulls a
 * member's next task when one leaves its hands and on every heartbeat, and
 * writes the heartbeat's "Your next work" section.
 */
@Module({
  imports: [AgentsModule, ChatsModule, WorkspacesModule, SkillsModule, SettingsModule, ActionReviewModule, AiModule, RegistryModule, ConnectionsModule, ActionsModule, PluginsModule, FoundryModule],
  controllers: [OrgController, WorkspaceOrgController, WorkController, ProgramController, BlueprintsController, CompaniesController, OrgSensingController, WorkspaceOrgSensingController, MetricsIngestController, IncidentsController, ExperimentsController, GovernanceController, WorkspaceMeetingsController],
  providers: [OrgService, OrgUnitsService, OrgIntentService, OrgTasksService, OrgApprovalsService, OrgAuditService, OrgSignalsService, OrgSloService, OrgCapitalService, OrgBriefService, OrgRuntimeService, OrgAuditorService, OrgAnnouncer, OrgModeService, OrgController, OrgMeetingsService, OrgMeetingRuntime, OrgPlaybooksService, OrgKnowledgeService, OrgMemoryService, OrgRolesService, OrgBlueprintsService, OrgBootstrapService, OrgSensingService, OrgSensingController, OrgIncidentsService, OrgRedTeamService, OrgTrustBridge, OrgRerunBridge, OrgPredictionsService, OrgExperimentsService, OrgReconciliationService, OrgBoundaryService, OrgEvalsService, OrgCapacityService, OrgSeatService, OrgDecisionsService, OrgGovernanceTools, OrgDataTools, OrgProjectsService, OrgProjectsTools, OrgChiefService, OrgMirrorService, OrgLayoutService, OrgMeetingMinutesService, MeetingsCalendarService, TaskMentionsService, OrgLifecycleService, OrgBriefingService, OrgNextWorkService, OrgProjectTeamsService, OrgProgramService, OrgProgramTools, OrgFoundryTools],
  exports: [OrgApprovalsService, OrgAuditService, OrgBriefService, OrgService, OrgUnitsService, OrgIntentService, OrgTasksService, OrgRuntimeService, OrgModeService, OrgAnnouncer, OrgSignalsService, OrgSloService, OrgAuditorService, OrgMeetingsService, OrgMeetingRuntime, OrgCapitalService, OrgPlaybooksService, OrgKnowledgeService, OrgMemoryService, OrgRolesService, OrgBlueprintsService, OrgBootstrapService, OrgSensingService, OrgIncidentsService, OrgRedTeamService, OrgExperimentsService, OrgPredictionsService, OrgReconciliationService, OrgBoundaryService, OrgEvalsService, OrgCapacityService, OrgSeatService, OrgProjectsService, OrgDecisionsService, OrgChiefService, OrgMirrorService, OrgLayoutService, OrgMeetingMinutesService, MeetingsCalendarService, TaskMentionsService, OrgLifecycleService, OrgNextWorkService, OrgProjectTeamsService, OrgProgramService, OrgFoundryTools],
})
export class OrgModule {}
