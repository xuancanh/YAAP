/**
 * The owner's Home (docs/home.md): the response of
 * `GET /api/workspaces/:id/home`. One request composes what the owner needs
 * on opening the app, ordered by what deserves attention. The SPA mirrors
 * these shapes in src/lib/api.ts (HomeData) and checks them loosely in
 * src/lib/schemas.ts (homeDataSchema).
 */

/** What a Needs-you card can do inline; the SPA maps each to an existing route. */
export type HomeNeedAction = 'approve' | 'reject' | 'veto' | 'apply_now' | 'ack' | 'dismiss';

export type HomeNeedKind =
  /** An org approval (a decision card, docs/owners-seat.md §1). */
  | 'approval'
  /** An escalation to the CEO (an approval of kind `escalation`). */
  | 'escalation'
  /** A held or staged action waiting for the owner's key (docs/actions-and-trust.md). */
  | 'held_action'
  /** An autonomous plan inside its veto window (docs/company-vision.md §8). */
  | 'plan'
  /** An open incident (docs/incidents.md). */
  | 'incident'
  /** An open assurance signal addressed to the owner (docs/company-vision.md §5). */
  | 'signal'
  /** A background action an agent queued for approval (agent_events `action_pending`). */
  | 'queued_action';

export interface HomeNeed {
  id: string;
  kind: HomeNeedKind;
  /** The approval kind, action class or signal kind, for the badge. */
  subkind: string;
  title: string;
  detail: string;
  severity: 'critical' | 'high' | 'normal';
  createdAt: string;
  /** When the default applies (a card's deadline, a plan's applyAt); null = never. */
  deadline: string | null;
  /** What happens at the deadline if the owner says nothing. */
  defaultAction: 'approve' | 'deny' | 'apply' | '';
  recommendation: string;
  recommendedAction: string;
  reversibility: string;
  confidence: number | null;
  /** Who asked, as a display name. */
  requestedBy: string;
  ref: { approvalId?: string; actionId?: string; planId?: string; incidentId?: string; signalId?: string; agentId?: string; eventId?: string; taskId?: string; sessionId?: string };
  actions: HomeNeedAction[];
}

export interface HomeRecapItem { at: string; kind: 'auto' | 'default' | 'delegate' | 'decision' | 'hire' | 'pause' | 'terminate'; title: string; detail: string; ref: { type: string; id: string } | null }

export interface HomeRecap {
  tasksDone: number;
  tasksBlocked: number;
  /** Decisions taken without the owner: autonomous actions, defaults at a deadline, delegates, logged decisions. */
  decisions: HomeRecapItem[];
  decisionsCount: number;
  /** Hires, pauses and terminations. */
  people: HomeRecapItem[];
  artifactsChanged: number;
  /** The Chief of Staff's latest brief (markdown). */
  brief: { at: string; text: string } | null;
  pulse: { score: number; breaches: number } | null;
}

export interface HomeKeyResult {
  id: string; title: string; currentValue: number | null; targetValue: number | null; unitLabel: string;
  progress: number; confidence: number | null; atRisk: boolean; atRiskReason: string; rag: 'red' | 'amber' | 'green' | 'grey'; dueAt: string | null;
}
export interface HomeGoal {
  id: string; title: string; ownerName: string | null; progress: number; confidence: number | null;
  atRisk: boolean; atRiskReason: string; rag: 'red' | 'amber' | 'green' | 'grey'; dueAt: string | null;
  keyResults: HomeKeyResult[];
}

export type HomeAgentState = 'working' | 'idle' | 'blocked' | 'paused' | 'error';
export interface HomeAgent {
  id: string; name: string; emoji: string; colors: string; title: string;
  state: HomeAgentState;
  /** What it is doing: the current task, or the blocker, or ''. */
  doing: string;
  taskId: string | null;
  lastActiveAt: string | null;
  lastBeatAt: string | null;
  /** Loud problems: a turn the provider rejected, a loop error, a breaker trip, a degraded provider. */
  errors: Array<{ kind: 'turn' | 'loop' | 'breaker' | 'provider' | 'budget'; message: string; at: string }>;
  isChief: boolean;
}

export type HomeActivityKind = 'task' | 'hire' | 'decision' | 'meeting' | 'incident' | 'file' | 'agent';
/** One agent loop run (a heartbeat beat), raw. */
export interface HomeRun { id: string; at: string; title: string; detail: string }
export interface HomeActivity {
  id: string; at: string; kind: HomeActivityKind; title: string; detail: string; actor: string; ref: { type: string; id: string } | null;
  /** A loop run that did something notable: the loop's name (the row says what it did). */
  loop?: string;
  /** Routine loop runs of one agent in one day, collapsed into this row. */
  runs?: { count: number; loops: string[]; from: string; items: HomeRun[] };
}

export interface HomeSpend {
  todayUsd: number | null;
  monthUsd: number | null;
  /** The company envelope (org mode) — 0 or null = none. */
  monthCapUsd: number | null;
  projectedUsd: number | null;
  forecastState: 'onTrack' | 'warn' | 'stop' | null;
  /** The workspace token budget (no company). */
  tokens: { spent: number; budget: number; over: boolean } | null;
}

export interface HomeHealth {
  status: 'ok' | 'degraded' | 'incident';
  openIncidents: Array<{ id: string; title: string; severity: string; status: string; openedAt: string }>;
  providers: Array<{ provider: string; state: string; lastError: string }>;
  audit: { id: string; at: string; status: string; findings: number; top: Array<{ severity: string; title: string }>; summary: string } | null;
}

export interface HomeUpcoming {
  id: string; at: string; kind: 'meeting' | 'ritual' | 'deadline' | 'decision' | 'loop' | 'plan'; title: string; detail: string; ref: { type: string; id: string } | null;
  /** The cadence (rituals, loops): five-field cron in server-local time; the page puts it in words. */
  cron?: string;
  /** Rituals: the units holding it at this time (one row for all of them). */
  units?: string[];
}

export interface HomeArtifact { path: string; version: number; size: number; updatedAt: string; updatedBy: { kind: string; id: string; name: string } }

export interface HomeData {
  workspaceId: string;
  generatedAt: string;
  /** The start of the window "since you were last here" summarises. */
  since: string;
  /** True on the owner's first visit (no stored visit; `since` is a day ago). */
  firstVisit: boolean;
  company: null | {
    orgId: string; name: string; mode: 'off' | 'supervised' | 'autonomous'; status: 'active' | 'paused';
    chiefAgentId: string | null; chiefName: string | null; memberCount: number;
  };
  headline: { tasksDone: number; needsYou: number; todayUsd: number | null; monthUsd: number | null; monthCapUsd: number | null };
  needs: HomeNeed[];
  recap: HomeRecap;
  goals: HomeGoal[];
  team: HomeAgent[];
  activity: HomeActivity[];
  spend: HomeSpend;
  health: HomeHealth;
  upcoming: HomeUpcoming[];
  artifacts: HomeArtifact[];
  /** Sections that failed to load; the rest still render. */
  partial: string[];
}
