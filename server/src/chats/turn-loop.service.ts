/**
 * TurnLoopService — runs one chat turn end to end (§3, §4, §7):
 *
 *  1. refuse before any API call if the session's token ceiling is already
 *     reached (FR-2.6 / FR-13.4);
 *  2. take the per-chat busy lock shared with compaction (FR-7.5);
 *  3. build provider history from persisted user/assistant messages past the
 *     compaction cutoff, prefixed by the compaction summary when present
 *     (FR-7.4 / FR-8.1), plus the resolved system context (FR-3.6);
 *  4. stream the provider loop for up to maxToolRounds rounds (FR-3.1),
 *     executing tool calls between rounds under the Ask/Auto policy (§4):
 *     read-only tools run automatically; mutations and raw HTTP pause for an
 *     inline approval, with allow-once / allow-always (exact input) /
 *     allow-tool / deny, remembered per chat (FR-4.3/4.5);
 *  5. record the structured work record on the turn: tool inputs/results,
 *     status, token usage (FR-6.6).
 *
 * Unknown tools and malformed calls are refused (FR-3.4): adapters throw on
 * unparseable arguments, and unknown tool names return an error result to the
 * model instead of executing.
 */
import { Injectable, ConflictException, ForbiddenException, NotFoundException, OnModuleDestroy, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ChatsRepository, ChatSession } from './chats.repository';
import { ChatLocks } from './chat-locks';
import { CompactionService } from './compaction.service';
import { ToolsService, FileRoot, fileRootKey } from './tools.service';
import { TranscriptionService, transcriptPathFor } from '../voice/transcription.service';
import { RunnerService } from '../runner/runner.service';
import { BrowserService, BrowserStep, BrowserTurnEvent } from '../browser/browser.service';
import { TurnContextService } from './turn-context.service';
import { SkillsService, SKILL_TOOL_PREFIX } from '../skills/skills.service';
import { McpService, MCP_TOOL_PREFIX } from '../mcp/mcp.module';
import { StorageService } from '../storage/storage.service';
import { AgentsService, CUSTOM_TOOL_PREFIX } from '../agents/agents.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { deliveryFor } from '../workspaces/quiet-hours';
import { spendStatus } from '../workspaces/spend.util';
import { AccountsService } from '../accounts/accounts.service';
import { actorId, currentAccountId } from '../accounts/account-context';
import { SharedService } from '../shared/shared.service';
import { ConnectionsService } from '../connections/connections.service';
import { ActionReviewService, ReviewRecord } from '../review/action-review.service';
import { ComputerService } from '../computer/computer.service';
import { REMEMBERABLE_COMPUTER_TOOLS, summarizeInput as summarizeComputerInput } from '../computer/computer-scopes';

import { AiImagePart, AiMessage, AiStreamEvent, AiToolCall, AiToolSpec } from '../ai/ai-provider.interface';
import { contentTypeFor, previewKindFor } from '../storage/preview.util';

export type ApprovalDecision = 'allow-once' | 'allow-always' | 'allow-tool' | 'deny';

/** Where a turn was started: the app, a scheduled loop, or a presence
 *  channel (Telegram). Channels are untrusted surfaces (docs/agent-memory.md)
 *  and their events are never echoed back to them. */
export type TurnOrigin = 'user' | 'loop' | 'channel';

/** Org tools and org-run context (docs/autonomous-company.md), supplied by
 *  OrgRuntimeService through `setOrgTools` so this module never imports the
 *  org domain. Specs appear only for agents that belong to an organisation;
 *  `onToolCall` lets an org run stop itself on a repeated identical call. */
export interface OrgToolsHook {
  specsFor(session: ChatSession): Promise<AiToolSpec[]>;
  owns(name: string): boolean;
  isReadOnly(name: string): boolean;
  execute(session: ChatSession, name: string, input: Record<string, unknown>): Promise<string>;
  /** Extra system context for the session (the task brief), or null. */
  contextFor(session: ChatSession): Promise<string | null>;
  /** Returns a stop message when this call should end the run (loop detected). */
  onToolCall(sessionId: string, call: AiToolCall): string | null;
  /** When set for a session, the only tool names offered and accepted in it
   *  (the auditor's read-only run, docs/company-vision.md §5.3); null = no
   *  restriction. Calls outside the set are refused, never executed. */
  restrictTo?(session: ChatSession): Promise<Set<string> | null>;
}

/** The generic shape of the org hook, for other domains that offer tools to
 *  agents (the group chat's channel tools, docs/group-chat.md §2). Registered
 *  with `addToolProvider`; consulted after the org hook, never instead of it. */
export interface ToolProviderHook {
  specsFor(session: ChatSession): Promise<AiToolSpec[]>;
  owns(name: string): boolean;
  isReadOnly(name: string): boolean;
  execute(session: ChatSession, name: string, input: Record<string, unknown>): Promise<string>;
  contextFor(session: ChatSession): Promise<string | null>;
  onToolCall?(sessionId: string, call: AiToolCall): string | null;
  /** A workspace folder to mount as shared/ for this session instead of the
   *  agent's assigned one (a channel session sees its channel folder). */
  sharedFolderFor?(session: ChatSession): Promise<string | null>;
}

export type TurnEvent =
  | { type: 'turn'; turnId: string }
  | AiStreamEvent
  /** `routedTo` (docs/shared-agents.md §3): the approval belongs to another
   *  member — the one whose connection the tool would use — and this client
   *  can only wait; the addressee answers from their inbox. */
  | { type: 'approval_required'; callId: string; tool: string; input: Record<string, unknown>; review?: ReviewRecord; routedTo?: { memberAccountId: string; name: string } }
  | { type: 'tool_result'; id: string; name: string; output: string; isError: boolean; review?: ReviewRecord }
  /** The workspace's monthly spend stop is reached (phase 2.5): user turns
   *  still run, the client shows the badge; loop turns are refused instead. */
  | { type: 'budget'; month: string; spentTokens: number; budgetTokens: number }
  /** A browser tool rendered a page: the client shows the screenshot live
   *  in the artifact panel's Browser tab (docs/browser-tool.md §4). */
  | BrowserTurnEvent
  /** A computer_* action settled on the paired companion (docs/computer-control.md):
   *  feeds the live "Computer" tab. `screenshotPath` is a workspace file. */
  | {
    type: 'computer'; callId: string; tool: string; summary: string; status: 'ok' | 'error';
    workspaceId: string; screenshotPath?: string; width?: number; height?: number; at: string;
  }
  | { type: 'error'; message: string };

interface ToolRecord {
  tool: string;
  input: Record<string, unknown>;
  result: string;
  approved: 'auto' | 'read-only' | 'remembered' | 'queued' | ApprovalDecision;
  isError: boolean;
  /** Independent reviewer's verdict when the call was reviewed (docs/permissions.md §6). */
  review?: ReviewRecord;
  /** Screenshot step a browser tool produced, so the Browser panel can be
   *  rebuilt from the transcript after the turn. */
  browser?: BrowserStep;
  /** Whose connection a connection tool ran on (an actor id), so distillation
   *  can keep what it fetched private to them (docs/shared-agents.md §4). */
  usedConnectionOf?: string;
}

/** Tools that modify the agent/chat configuration itself can never receive a
 *  blanket "always allow tool" grant (FR-4.5). */
const SELF_MOD_TOOLS = new Set<string>(['update_dashboard', 'save_app']);

/** Self-maintenance tools, offered only in chats owned by a durable agent
 *  (§11): the agent keeps its own home page and builds mini apps for it. */
const AGENT_TOOLS: AiToolSpec[] = [
  {
    name: 'update_dashboard',
    description: 'Replace your home-page dashboard with new markdown. The user sees it when they open your agent page — keep it a current, scannable status board of your work.',
    inputSchema: {
      type: 'object',
      properties: { markdown: { type: 'string', description: 'The full new dashboard content (markdown).' } },
      required: ['markdown'],
    },
  },
  {
    name: 'save_app',
    description: 'Create or update (same name replaces) one of your mini apps: a single self-contained HTML file shown on your home page and embeddable into chats. It runs in a sandboxed iframe with no network access, so inline all CSS/JS. Apps may request capabilities from the window.yaam bridge (all promise-based, feature-detect with `if (window.yaam)`): storage (app-private state), chat.compose (prefill the chat box), files.read (list/read your working folder incl. shared/, with files.watch to poll for changes), files.write (the app\'s own folder) and files.propose (save into your folder proper, user-approved per file), tasks.read, tasks.write, agent.ask (ask you a question, Ask-mode, budgeted), llm (a plain model call with optional JSON-schema output, no tools — prefer it over agent.ask for the app\'s own tagging/extraction/summary work), data (queryable collections for more rows than storage holds, plus yaam.sql for SQLite in the page), connections (fixed-shape reads of granted calendar/mail/drive, and proposals the user approves; sending mail is not available to apps), compute (run javascript/python in the sandboxed runner). storage and chat.compose activate immediately; the rest stay parked until the user reviews them on the app card, so request only what the app really uses.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short app name (also the update key).' },
        description: { type: 'string', description: 'One line on what the app does.' },
        html: { type: 'string', description: 'The complete self-contained HTML document.' },
        capabilities: { type: 'array', items: { type: 'string' }, description: 'Bridge capabilities the app uses: storage, chat.compose, files.read, files.write, tasks.read, tasks.write, agent.ask, llm, data, connections, compute.' },
      },
      required: ['name', 'html'],
    },
  },
  {
    name: 'list_tasks',
    description: 'Read your kanban board: every task with its short id, status (todo/doing/done), and title. Check it at the start of scheduled loops.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_task',
    description: 'Add a task to your kanban board (status starts at todo). Use it to queue work you notice but are not doing right now.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short imperative task title.' },
        note: { type: 'string', description: 'Optional detail or acceptance criteria.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_task',
    description: 'Update one of your tasks by the short id from list_tasks: move it between todo/doing/done or refine its title/note. Move a task to doing when you start it and done when you finish.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The short task id shown by list_tasks.' },
        status: { type: 'string', enum: ['todo', 'doing', 'done'] },
        title: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'save_tool',
    description: 'Turn a recurring user request into a reusable HTTP tool: give it a name, a description, and a GET/POST URL template with {param} placeholders in the path/query (the host must be literal). The tool is inert until the user reviews and enables it; then it appears as tool_<name> in future turns.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short tool name, e.g. city-weather.' },
        description: { type: 'string', description: 'One line on what it does and when to use it.' },
        method: { type: 'string', enum: ['GET', 'POST'] },
        url: { type: 'string', description: 'URL template, e.g. https://api.example.com/v1/weather?q={city}' },
        body: { type: 'string', description: 'POST body template, may contain {param} placeholders.' },
      },
      required: ['name', 'url'],
    },
  },
  {
    name: 'delegate_task',
    description: 'Hand a task to another durable agent by putting it on their kanban board. Use when work belongs to a colleague agent (their charter covers it); they will see it on their board and in their activity feed.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'The name of the agent to delegate to.' },
        title: { type: 'string', description: 'Short imperative task title.' },
        note: { type: 'string', description: 'Context the other agent needs to do the work.' },
      },
      required: ['agent', 'title'],
    },
  },
  {
    name: 'search_history',
    description: 'Full-text search across all of your past conversations with the user. Use it when the user refers to something discussed before, or to recall earlier decisions, names, and context.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Keywords to search for (plain words, not operators).' } },
      required: ['query'],
    },
  },
  {
    name: 'draft_skill',
    description: 'After completing multi-step work the user was happy with, capture the reusable procedure as a skill draft: a named, step-by-step instruction pack. The user reviews and approves drafts before they become callable; draft sparingly, only genuinely reusable procedures.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short kebab-case skill name, e.g. weekly-dependency-audit.' },
        description: { type: 'string', description: 'One line on when to use this skill.' },
        instructions: { type: 'string', description: 'The complete step-by-step procedure, written for your future self.' },
      },
      required: ['name', 'instructions'],
    },
  },
  {
    name: 'revise_skill',
    description: 'Propose corrected instructions for one of your skills after the user rated a reply that used it 👎 (pending feedback names the skill and its id). Send the complete new instruction text, not a patch, plus the reason. The user reviews the change as a diff and accepts or rejects it; nothing changes until they do.',
    inputSchema: {
      type: 'object',
      properties: {
        skillId: { type: 'string', description: 'The skill id (or exact name) named in the feedback.' },
        instructions: { type: 'string', description: 'The full revised step-by-step instructions.' },
        reason: { type: 'string', description: 'What went wrong and what the revision fixes.' },
      },
      required: ['skillId', 'instructions', 'reason'],
    },
  },
  {
    name: 'update_user_profile',
    description: 'Propose one durable fact about the user (a preference, constraint, or piece of stable context) for their consented profile. The user reviews every proposal before it is remembered; propose sparingly and only things worth keeping across all future conversations.',
    inputSchema: {
      type: 'object',
      properties: { entry: { type: 'string', description: 'One self-contained sentence, under 500 characters.' } },
      required: ['entry'],
    },
  },
];
const AGENT_TOOL_NAMES = new Set(AGENT_TOOLS.map((t) => t.name));
/** Agent tools that auto-run even in Ask mode: pure reads, plus
 *  update_user_profile — it only queues a proposal, and the durable write is
 *  gated on explicit user approval in the profile UI. */
const AGENT_READONLY_TOOLS = new Set(['list_tasks', 'search_history', 'update_user_profile', 'draft_skill', 'save_tool', 'revise_skill']);

const exactKey = (call: AiToolCall): string =>
  `${call.name}:${createHash('sha256').update(JSON.stringify(call.input)).digest('hex').slice(0, 16)}`;

/** Pending approvals auto-deny after this long, so an orphaned approval
 *  (dead client, lost UI) cannot park a turn — and the chat lock — forever. */
const APPROVAL_TTL_MS = 10 * 60_000;

@Injectable()
export class TurnLoopService implements OnModuleDestroy {
  /** Abort registry keyed by chat id (FR-8.3 / FR-5.4). */
  private readonly aborts = new Map<string, AbortController>();
  /** Pending Ask-mode approvals keyed by `${sessionId}:${callId}`. */
  private readonly pending = new Map<string, (d: ApprovalDecision) => void>();
  /** Approvals routed to one member (the owner of the connection in use):
   *  key → that member's actor id. Only they may resolve it. */
  private readonly routed = new Map<string, string>();
  /** Who started the turn in flight per chat (an actor id), for tool
   *  executors that pick a member's connection. */
  private readonly turnActors = new Map<string, string>();
  /** Origin of the turn in flight per chat, so tool executors deep in the
   *  call tree can stamp the events they write without threading it through
   *  every signature. */
  private readonly turnOrigins = new Map<string, TurnOrigin>();
  /** See OrgToolsHook. Registered by OrgRuntimeService at boot. */
  private orgTools?: OrgToolsHook;
  /** Further tool providers (ToolProviderHook), in registration order. */
  private readonly extraProviders: ToolProviderHook[] = [];
  /** How long a paused approval waits before auto-deny (test seam). */
  approvalTtlMs = APPROVAL_TTL_MS;

  setOrgTools(hook: OrgToolsHook | undefined): void {
    this.orgTools = hook;
  }

  /** Offer another domain's tools to agent sessions (see ToolProviderHook). */
  addToolProvider(hook: ToolProviderHook): () => void {
    this.extraProviders.push(hook);
    return () => { const i = this.extraProviders.indexOf(hook); if (i >= 0) this.extraProviders.splice(i, 1); };
  }

  /** Every registered provider: the org hook first, then the extras. */
  private providers(): ToolProviderHook[] {
    return [...(this.orgTools ? [this.orgTools] : []), ...this.extraProviders];
  }

  private providerOf(name: string): ToolProviderHook | undefined {
    return this.providers().find((p) => p.owns(name));
  }

  constructor(
    private readonly repo: ChatsRepository,
    private readonly locks: ChatLocks,
    private readonly tools: ToolsService,
    private readonly context: TurnContextService,
    private readonly skills: SkillsService,
    private readonly storage: StorageService,
    private readonly mcp: McpService,
    private readonly agents: AgentsService,
    private readonly workspaces: WorkspacesService,
    /** Optional so test constructors without connections keep working. */
    @Optional() private readonly connections?: ConnectionsService,
    /** Optional so test constructors without compaction keep working. */
    @Optional() private readonly compaction?: CompactionService,
    /** Optional so test constructors without a runner keep working. */
    @Optional() private readonly runner?: RunnerService,
    /** Optional so test constructors without a reviewer keep working. */
    @Optional() private readonly review?: ActionReviewService,
    /** Optional so test constructors without a browser keep working. */
    @Optional() private readonly browser?: BrowserService,
    /** Optional so test constructors without computer control keep working. */
    @Optional() private readonly computer?: ComputerService,
    /** Optional so test constructors without accounts keep working. With
     *  it, every settled turn rolls into the account's month (docs/accounts.md §4). */
    @Optional() private readonly accounts?: AccountsService,
    /** Optional: without it the workspace has one human and nothing is
     *  attributed, routed or wrapped (docs/shared-agents.md). */
    @Optional() private readonly shared?: SharedService,
  ) {}

  /** Graceful shutdown: abort every in-flight turn through the same path as
   *  /stop, so providers stop streaming and turns settle as 'stopped' before
   *  the module graph (and the pg pool) tears down under them. */
  onModuleDestroy(): void {
    for (const sessionId of [...this.aborts.keys()]) this.stop(sessionId);
  }

  /** Stop the in-flight turn for a chat; the partial turn is retained (FR-5.4). */
  stop(sessionId: string): boolean {
    const ctl = this.aborts.get(sessionId);
    if (!ctl) return false;
    ctl.abort();
    return true;
  }

  isBusy(sessionId: string): boolean {
    return this.locks.isBusy(sessionId);
  }

  /** Resolve a paused tool approval (POST /:id/approve, or the addressee's
   *  inbox for a routed one). `by` is the actor answering; a routed approval
   *  answers only to the member it was routed to. */
  resolveApproval(sessionId: string, callId: string, decision: ApprovalDecision, by?: string): boolean {
    const key = `${sessionId}:${callId}`;
    const resolve = this.pending.get(key);
    if (!resolve) return false;
    const addressee = this.routed.get(key);
    if (addressee !== undefined && by !== undefined && by !== addressee) return false;
    resolve(decision);
    return true;
  }

  /** Whether an approval is still open, and for whom (the inbox's decide route). */
  pendingApproval(sessionId: string, callId: string): { open: boolean; routedTo?: string } {
    const key = `${sessionId}:${callId}`;
    return { open: this.pending.has(key), routedTo: this.routed.get(key) };
  }

  async *run(sessionId: string, input: { text: string; attachments?: unknown[]; origin?: TurnOrigin }): AsyncGenerator<TurnEvent> {
    const session = await this.repo.getSession(sessionId);
    if (!session) throw new NotFoundException(`chat ${sessionId}`);
    if (session.tokenCeiling > 0 && session.tokensIn + session.tokensOut >= session.tokenCeiling) {
      throw new ForbiddenException('token ceiling reached');
    }
    // The workspace's monthly spend stop (phase 2.5). Background turns are
    // refused outright before any model call; a person typing still gets
    // their answer and a visible notice — the stop exists to catch unattended
    // spend, not to lock the user out of their own chat. Tolerant of a
    // missing row: tests and legacy sessions reference workspaces that do
    // not exist, and a budget check must never be the thing that fails a turn.
    const ws = await this.workspaces.get(session.workspaceId).catch(() => null);
    const spend = spendStatus(ws);
    if (spend.over && input.origin === 'loop') throw new ForbiddenException('workspace budget reached');
    // The account's plan (docs/accounts.md §4): no key for the provider on a
    // BYO plan, or the hosted ceiling spent, is a hard stop before the lock
    // and before any row is written — a 402 with the reason, for every origin.
    if (this.accounts && typeof (this.context as { resolveKey?: unknown }).resolveKey === 'function') {
      await this.context.resolveKey(session);
    }
    if (!this.locks.tryAcquire(sessionId)) throw new ConflictException('chat is busy');
    this.turnOrigins.set(sessionId, input.origin ?? 'user');
    // Who is acting (docs/shared-agents.md): the member who sent this turn, or
    // the owner — the connection-grant lookup, approval routing, message
    // attribution and lesson audiences all key on it.
    const actor = actorId();
    const ownerActor = currentAccountId();
    this.turnActors.set(sessionId, actor);
    const hasMembers = this.shared ? await this.shared.hasMembers(session.workspaceId).catch(() => false) : false;
    const names = hasMembers && this.shared ? await this.shared.displayNames(session.workspaceId).catch(() => new Map<string, string>()) : new Map<string, string>();
    const nameOf = (id: string) => names.get(id) ?? (id === ownerActor ? 'the owner' : id.slice(0, 8));

    const ctl = new AbortController();
    this.aborts.set(sessionId, ctl);

    const turn = await this.repo.createTurn(sessionId, { ...input, model: session.model });
    await this.repo.appendMessage({ sessionId, turnId: turn.id, role: 'user', content: input.text });
    // Auto-title from the first message when the chat is unnamed (FR-1.3).
    if (!session.name && !session.autoTitle) {
      await this.repo.updateSession(sessionId, { autoTitle: input.text.replace(/\s+/g, ' ').slice(0, 64) });
    }
    yield { type: 'turn', turnId: turn.id };
    if (spend.over) yield { type: 'budget', ...spend };

    let tokensIn = 0;
    let tokensOut = 0;
    let overheadChars = 0;
    /** Which key paid for this turn and which model ran, for the account's
     *  monthly rollup in `finally` (set once the context is built). */
    let hosted = false;
    let turnModel = session.model;
    const toolRecords: ToolRecord[] = [];
    /** Skills whose skill_* tool loaded this turn (execution-plan item 10):
     *  persisted on the turn so a later rating can reach them. */
    const skillsUsed: string[] = [];
    try {
      const ctx = await this.context.build(session);
      hosted = ctx.hosted ?? false;
      turnModel = ctx.model || turnModel;
      const history = await this.buildHistory(session.id, session.compactSummary, session.compactCutoff,
        hasMembers && session.shared === 1 ? { names, ownerActor } : undefined);
      // Attachments: inject workspace-file contents into the provider input —
      // text inline, images as vision parts (descriptors persist on the turn;
      // the transcript stays clean, FR-2.2).
      const fileRoot = await this.fileRootFor(session);
      const attached = await this.loadAttachments(fileRoot, input.attachments);
      if (history.length > 0 && (attached.text || attached.images.length > 0)) {
        const lastMsg = history[history.length - 1];
        if (lastMsg.role === 'user') {
          if (attached.text) lastMsg.content = `${lastMsg.content}\n\n${attached.text}`;
          if (attached.images.length > 0) lastMsg.images = attached.images;
        }
      }
      const approvals = parseApprovals(session.approvals);
      // Core tools + the workspace's enabled skills (FR-10.2) + tools
      // discovered from enabled MCP servers (FR-10.3).
      const restrictTo = (session.agentId && this.orgTools?.restrictTo) ? await this.orgTools.restrictTo(session) : null;
      const toolSpecs = [
        ...this.tools.specs(),
        ...(session.agentId ? AGENT_TOOLS : []),
        ...(session.agentId ? await this.agents.customToolSpecs(session.agentId) : []),
        ...await this.skills.toolSpecs(session.workspaceId, session.agentId ?? undefined),
        ...await this.mcp.toolSpecs(),
        // Connection tools appear only for agents the user granted (activation
        // gate) — the acting member's own grants plus the agent's defaults.
        ...(session.agentId && this.connections ? await this.connections.toolSpecs(session.agentId, actor) : []),
        // Code runner tools exist only when a sandbox backend is available
        // (docs/code-execution.md §5); they are mutation-class, so Ask mode
        // pauses on the full code.
        ...(this.runner?.specs() ?? []),
        // Browser tools exist only when a backend is available
        // (docs/browser-tool.md §2); browser_act is mutation-class.
        ...(this.browser?.specs() ?? []),
        // Computer tools exist only while a companion is paired, unpaused and
        // scoped for them (docs/computer-control.md §3); every one is Ask-gated.
        ...(this.computer ? await this.computer.specs() : []),
        // Org tools appear for agents that belong to an organisation
        // (docs/autonomous-company.md §4.3): the bounded task set in an org
        // run, the manager set for a chief of staff.
        // …and any other domain that registered a provider (channel tools in
        // a channel session, docs/group-chat.md §2).
        ...(session.agentId ? (await Promise.all(this.providers().map((p) => p.specsFor(session)))).flat() : []),
      ].filter((t) => !restrictTo || restrictTo.has(t.name));
      const extraContext = session.agentId
        ? (await Promise.all(this.providers().map((p) => p.contextFor(session)))).filter((c): c is string => Boolean(c))
        : [];
      // Connection context cards (docs/integrations.md "Context cards"): the
      // manual for every connection the agent holds a grant on, plus the
      // browser / companion / MCP cards when those tools are on offer.
      if (session.agentId && this.connections) {
        const names = new Set(toolSpecs.map((t) => t.name));
        const mcpList = typeof (this.mcp as { list?: unknown }).list === 'function'
          ? await (this.mcp as unknown as { list(): Promise<Array<{ id: string; name: string; tools: string; enabled: number }>> }).list().catch(() => [])
          : [];
        const cards = await this.connections.cardContext(session.agentId, actor, {
          browser: names.has('browser_open'),
          computer: names.has('computer_screenshot'),
          mcp: mcpList.filter((s) => s.enabled === 1).map((s) => ({ id: s.id, name: s.name, tools: s.tools })),
        }).catch(() => null);
        if (cards) extraContext.push(cards);
      }
      const system = [ctx.system, ...extraContext].join('\n\n');
      // Per-round overhead every provider call also carries: the resolved
      // system prompt plus the full tool-spec JSON (tens of KB once MCP
      // servers are enabled). Fed into the auto-compaction estimate below so
      // it fires before the provider's real context limit, not after.
      overheadChars = system.length + JSON.stringify(toolSpecs).length;

      for (let round = 0; ; round++) {
        let answer = '';
        const calls: AiToolCall[] = [];
        for await (const ev of ctx.provider.stream({
          model: ctx.model,
          system,
          messages: history,
          tools: toolSpecs,
          thinkingEffort: session.thinkingEffort,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
          signal: ctl.signal,
        })) {
          if (ev.type === 'answer') answer += ev.text;
          if (ev.type === 'usage') { tokensIn += ev.inputTokens; tokensOut += ev.outputTokens; }
          if (ev.type === 'done' && calls.length > 0) continue; // round continues after tools
          if (ev.type === 'tool_call') calls.push({ id: ev.id, name: ev.name, input: ev.input });
          yield ev;
        }

        if (answer) await this.repo.appendMessage({ sessionId, turnId: turn.id, role: 'assistant', content: answer });
        if (calls.length === 0 || ctl.signal.aborted) break;
        // The ceiling is re-checked per round, not only at turn start:
        // cumulative usage across rounds can blow past it mid-turn.
        if (session.tokenCeiling > 0 && session.tokensIn + tokensIn + session.tokensOut + tokensOut >= session.tokenCeiling) {
          yield { type: 'error', message: 'token ceiling reached' };
          break;
        }
        history.push({ role: 'assistant', content: answer, toolCalls: calls });

        for (const call of calls) {
          if (ctl.signal.aborted) break;
          // Computer tools act on the user's own machine and run only from a
          // turn the user started in the app. A loop or channel turn has
          // nobody at the keyboard to approve, so the call is refused — not
          // queued for later — and the refusal lands in the agent inbox
          // (docs/computer-control.md §4).
          if (this.computer?.owns(call.name) && (input.origin ?? 'user') !== 'user') {
            const output = 'Refused: computer tools act on the user\'s own computer and only run from a conversation the user is having in the app right now — never from a scheduled loop or a channel. Do not retry; tell the user what you wanted to do and why.';
            if (session.agentId) {
              await this.agents.addEvent(session.agentId, {
                kind: 'info',
                title: `Computer action refused (${input.origin} turn): ${call.name}`,
                body: summarizeComputerInput(call.name, call.input),
                sessionId: session.id,
                payload: JSON.stringify({ tool: call.name, origin: input.origin }),
                origin: input.origin ?? 'user',
                ...deliveryFor(ws, 'info'),
              }).catch(() => undefined);
            }
            await this.repo.appendMessage({ sessionId, turnId: turn.id, role: 'tool', content: output, toolName: call.name });
            history.push({ role: 'tool', content: output, toolCallId: call.id, isError: true });
            toolRecords.push({ tool: call.name, input: call.input, result: output, approved: 'deny', isError: true });
            yield { type: 'tool_result', id: call.id, name: call.name, output, isError: true };
            continue;
          }
          // A restricted session (the auditor's run) accepts only its own set.
          if (restrictTo && !restrictTo.has(call.name)) {
            const output = `Refused: ${call.name} is not available in this run — it is read-only; only ${[...restrictTo].join(', ')} may be called.`;
            await this.repo.appendMessage({ sessionId, turnId: turn.id, role: 'tool', content: output, toolName: call.name });
            history.push({ role: 'tool', content: output, toolCallId: call.id, isError: true });
            toolRecords.push({ tool: call.name, input: call.input, result: output, approved: 'deny', isError: true });
            yield { type: 'tool_result', id: call.id, name: call.name, output, isError: true };
            continue;
          }
          // Org runs stop on a repeated identical call (the same-call loop
          // breaker, docs/autonomous-company.md §4.2) instead of spending
          // more rounds on it.
          let stopMsg: string | null = null;
          for (const p of this.providers()) { stopMsg = p.onToolCall?.(session.id, call) ?? null; if (stopMsg) break; }
          if (stopMsg) {
            await this.repo.appendMessage({ sessionId, turnId: turn.id, role: 'tool', content: stopMsg, toolName: call.name });
            toolRecords.push({ tool: call.name, input: call.input, result: stopMsg, approved: 'deny', isError: true });
            yield { type: 'tool_result', id: call.id, name: call.name, output: stopMsg, isError: true };
            yield { type: 'error', message: stopMsg };
            ctl.abort();
            break;
          }
          // Loop turns are background turns: outward-facing (connection)
          // mutations and code execution queue as pending approvals in the
          // agent inbox, never silently execute — even in Auto mode
          // (docs/integrations.md §5, docs/code-execution.md §5).
          if (input.origin === 'loop' && session.agentId
            && ((this.connections?.owns(call.name) && this.connections.isReadOnly(call.name) === false)
              || this.runner?.owns(call.name)
              || (this.browser?.owns(call.name) && this.browser.isReadOnly(call.name) === false))) {
            const summary = JSON.stringify(call.input).slice(0, 280);
            await this.agents.addEvent(session.agentId, {
              kind: 'action_pending',
              title: `Needs your approval: ${call.name}`,
              body: summary,
              sessionId: session.id,
              payload: JSON.stringify({ tool: call.name, input: call.input }),
              origin: input.origin ?? 'user',
              ...deliveryFor(ws, 'action_pending'),
            });
            const output = `Queued for the user's approval: ${call.name} was recorded in the user's inbox and will run only if they approve it. Do not retry — tell the user what you queued and why.`;
            await this.repo.appendMessage({ sessionId, turnId: turn.id, role: 'tool', content: output, toolName: call.name });
            history.push({ role: 'tool', content: output, toolCallId: call.id, isError: false });
            toolRecords.push({ tool: call.name, input: call.input, result: output, approved: 'queued', isError: false });
            yield { type: 'tool_result', id: call.id, name: call.name, output, isError: false };
            continue;
          }
          // Whose connection would this call run on? In a shared workspace a
          // mutating call on *another* member's connection is theirs to
          // approve (docs/shared-agents.md §3): the turn pauses, an
          // approval_request lands in that member's inbox and channels, and
          // everyone else only sees "waiting for <name>".
          let connOwner: string | null = null;
          if (session.agentId && this.connections?.owns(call.name)) {
            const o = await this.connections.resolveConnectionOwner(session.agentId, call.name, actor).catch(() => null);
            connOwner = o === null ? null : (o || ownerActor);
          }
          if (connOwner !== null && connOwner !== actor && hasMembers && this.connections?.isReadOnly(call.name) === false && session.agentId) {
            const addressee = connOwner;
            const tool = call.name;
            const decided = this.awaitDecision(sessionId, call.id, ctl.signal, addressee);
            const ev = await this.agents.addEvent(session.agentId, {
              kind: 'approval_request',
              title: `${nameOf(actor)} asks to run ${tool} with your connection`,
              body: JSON.stringify(call.input).slice(0, 280),
              sessionId: session.id,
              payload: JSON.stringify({ tool, input: call.input, callId: call.id, requestedBy: actor, requestedByName: nameOf(actor) }),
              origin: input.origin ?? 'user',
              channel: true,
              forMemberAccountId: addressee,
              ...deliveryFor(ws, 'action_pending'),
            }).catch(() => null);
            yield { type: 'approval_required', callId: call.id, tool, input: call.input, routedTo: { memberAccountId: addressee, name: nameOf(addressee) } };
            const routedDecision = await decided;
            const allowed = routedDecision !== 'deny';
            if (ev) await this.agents.patchEvent(ev.id, { kind: allowed ? 'approval_granted' : 'approval_denied', readAt: new Date().toISOString() }).catch(() => undefined);
            let output: string;
            let isError = false;
            if (!allowed) {
              output = `Denied: ${nameOf(addressee)} did not approve using their connection for ${tool} (or did not answer in time). Do not retry — tell the user.`;
              isError = true;
            } else {
              try {
                output = await this.executeTool(session, tool, call.input, skillsUsed);
              } catch (err) {
                output = `tool error: ${err instanceof Error ? err.message : String(err)}`;
                isError = true;
              }
              if (!isError) output = await this.wrapConnectionContent(session, output, addressee, actor, nameOf(addressee));
            }
            await this.repo.appendMessage({ sessionId, turnId: turn.id, role: 'tool', content: output, toolName: tool });
            history.push({ role: 'tool', content: output, toolCallId: call.id, isError });
            toolRecords.push({ tool, input: call.input, result: output.slice(0, 2000), approved: allowed ? 'allow-once' : 'deny', isError, usedConnectionOf: addressee });
            yield { type: 'tool_result', id: call.id, name: tool, output: output.slice(0, 500), isError };
            continue;
          }
          const policy = this.checkPolicy(session, call, approvals);
          let { verdict } = policy;
          const { remember } = policy;
          // Independent reviewer (docs/permissions.md §6): a mutating call that
          // would run WITHOUT a fresh human decision — Auto mode, or a
          // remembered approval — gets a second, tool-free read against what
          // the user actually asked. Read-only tools and confirm-always tools
          // (already pausing) are not reviewed.
          let review: ReviewRecord | undefined;
          let reviewDenial: string | undefined;
          if ((verdict === 'auto' || verdict === 'remembered') && policy.readOnly === false && this.review
            && (await this.review.config()).enabled) {
            const agent = session.agentId ? await this.agents.get(session.agentId).catch(() => null) : null;
            const r = await this.review.review({
              userRequest: input.text,
              conversationSummary: summarizeForReview(session.compactSummary, history),
              agentCharter: (agent as { charter?: string } | null)?.charter || undefined,
              recentContent: recentToolContent(history),
              call: { name: call.name, input: call.input },
              origin: input.origin === 'loop' ? 'loop' : 'user',
            }, { provider: ctx.provider, model: ctx.model, apiKey: ctx.apiKey, baseUrl: ctx.baseUrl, signal: ctl.signal });
            tokensIn += r.usage.inputTokens; tokensOut += r.usage.outputTokens;
            review = { verdict: r.verdict, reason: r.reason, sensitive: r.sensitive, model: r.model };
            if (r.verdict !== 'allow') {
              // Nobody is there to answer a background or channel turn: hold
              // the action and leave a note in the agent inbox instead of
              // pausing forever.
              if (r.verdict === 'deny' || (input.origin ?? 'user') !== 'user') {
                reviewDenial = `Denied by the action reviewer: ${r.reason} Do not retry the same call — explain to the user what you wanted to do and why, and let them decide.`;
                if (session.agentId) {
                  await this.agents.addEvent(session.agentId, {
                    kind: 'info',
                    title: `Action held by reviewer: ${call.name}`,
                    body: `${r.reason}\n${JSON.stringify(call.input).slice(0, 240)}`,
                    sessionId: session.id,
                    payload: JSON.stringify({ tool: call.name, verdict: r.verdict, sensitive: r.sensitive }),
                  }).catch(() => undefined);
                }
              } else {
                verdict = 'ask';
              }
            }
          }
          let decision: ToolRecord['approved'] = verdict === 'ask' || reviewDenial ? 'deny' : verdict;
          if (verdict === 'ask' && !reviewDenial) {
            // Register the resolver BEFORE yielding: the client may answer the
            // moment it sees the event, and the generator only resumes when the
            // consumer pulls again — approving into an unregistered slot would
            // deadlock the turn.
            const decided = this.awaitDecision(sessionId, call.id, ctl.signal);
            yield { type: 'approval_required', callId: call.id, tool: call.name, input: call.input, ...(review ? { review } : {}) };
            decision = await decided;
            if ((decision === 'allow-always' || decision === 'allow-tool') && remember) {
              if (decision === 'allow-always') approvals.exact.push(exactKey(call));
              if (decision === 'allow-tool' && !SELF_MOD_TOOLS.has(call.name)) approvals.tools.push(call.name);
              await this.repo.updateSession(sessionId, { approvals: JSON.stringify(approvals) });
            }
          }

          let output: string;
          let isError = false;
          if (reviewDenial) {
            output = reviewDenial;
            isError = true;
          } else if (decision === 'deny') {
            output = 'Denied by user.';
            isError = true;
          } else {
            try {
              output = await this.executeTool(session, call.name, call.input, skillsUsed);
            } catch (err) {
              output = `tool error: ${err instanceof Error ? err.message : String(err)}`;
              isError = true;
            }
            // Content fetched through a member's connection in a session others
            // can read is tagged so the model keeps it to its owner and
            // distillation keeps the lesson private (docs/shared-agents.md §4).
            if (!isError && connOwner !== null && hasMembers && (session.shared === 1 || connOwner !== actor)) {
              output = await this.wrapConnectionContent(session, output, connOwner, actor, nameOf(connOwner));
            }
          }
          // A settled computer action: the screenshot rides along to the model
          // as a vision part on this tool result (never persisted in the
          // transcript — the file store holds it) and the client gets a
          // `computer` event for the live tab.
          const step = this.computer?.owns(call.name) ? this.computer.takeStep(session.id, call.id) : undefined;
          await this.repo.appendMessage({ sessionId, turnId: turn.id, role: 'tool', content: output, toolName: call.name });
          history.push({
            role: 'tool', content: output, toolCallId: call.id, isError,
            ...(step?.imageBase64 ? { images: [{ mediaType: 'image/png', dataBase64: step.imageBase64 }] } : {}),
          });
          // Browser steps stream before the tool_result so the panel shows
          // the page as the model receives it; the step is also recorded on
          // the tool record for the transcript view.
          const browserStep = this.browser?.owns(call.name) ? this.browser.lastStep(session.id) : null;
          for (const bev of this.browser?.takeEvents(session.id) ?? []) yield bev;
          toolRecords.push({ tool: call.name, input: call.input, result: output.slice(0, 2000), approved: decision, isError, ...(review ? { review } : {}), ...(browserStep ? { browser: browserStep } : {}), ...(connOwner !== null && hasMembers ? { usedConnectionOf: connOwner } : {}) });
          yield { type: 'tool_result', id: call.id, name: call.name, output: output.slice(0, 500), isError, ...(review ? { review } : {}) };
          if (step && decision !== 'deny') {
            yield {
              type: 'computer', callId: call.id, tool: step.tool, summary: step.summary, status: step.status,
              workspaceId: session.workspaceId, at: step.at,
              ...(step.screenshotPath ? { screenshotPath: step.screenshotPath, width: step.width, height: step.height } : {}),
            };
          }
        }

        // An abort during a tool run or approval wait must end the turn here
        // as 'stopped' — starting another round would fetch with an aborted
        // signal and mis-record the turn as 'error'.
        if (ctl.signal.aborted) break;
        if (round + 1 >= ctx.maxToolRounds) {
          yield { type: 'error', message: `tool round limit (${ctx.maxToolRounds}) reached` };
          break;
        }
      }

      await this.repo.updateTurn(turn.id, {
        status: ctl.signal.aborted ? 'stopped' : 'done',
        toolCalls: JSON.stringify(toolRecords),
        skillsUsed: JSON.stringify([...new Set(skillsUsed)]),
        tokensIn, tokensOut,
      });
      if (skillsUsed.length > 0) await this.skills.recordUse(skillsUsed).catch(() => {});
      await this.repo.updateSession(sessionId, {
        tokensIn: session.tokensIn + tokensIn,
        tokensOut: session.tokensOut + tokensOut,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.repo.updateTurn(turn.id, {
        status: 'error', error: message, toolCalls: JSON.stringify(toolRecords), skillsUsed: JSON.stringify([...new Set(skillsUsed)]), tokensIn, tokensOut,
      });
      yield { type: 'error', message };
    } finally {
      // Every token the provider billed counts against the workspace month,
      // whether the turn ended well, stopped, or errored.
      if (ws && tokensIn + tokensOut > 0) await this.workspaces.addSpend(ws.id, tokensIn + tokensOut).catch(() => {});
      // …and against the account's month, in dollars, for the plan ceiling.
      if (this.accounts && tokensIn + tokensOut > 0) await this.accounts.recordUsage({ model: turnModel, tokensIn, tokensOut, hosted }).catch(() => {});
      this.turnOrigins.delete(sessionId);
      this.turnActors.delete(sessionId);
      // The browser session is per turn: cookies, logins and the page itself
      // end here, whether the turn finished, stopped or errored.
      if (this.browser) await this.browser.endTurn(sessionId).catch(() => {});
      this.locks.release(sessionId);
      this.aborts.delete(sessionId);
      // Post-turn auto-compaction with the real per-round overhead. It cannot
      // run mid-turn — compaction shares this busy lock (FR-7.5) — so the
      // estimate must be pessimistic enough to fire before the NEXT turn
      // starts. Loop turns rely on this path (no controller around them);
      // for user turns it races the controller's call and the loser skips.
      if (this.compaction) void this.compaction.maybeAutoCompact(sessionId, overheadChars);
    }
  }

  /** Read attached workspace files: text inline (bounded), images as vision
   *  parts (bounded count + size). */
  private async loadAttachments(root: FileRoot, attachments?: unknown[]): Promise<{ text: string; images: AiImagePart[] }> {
    const parts: string[] = [];
    const images: AiImagePart[] = [];
    for (const a of (attachments ?? []).slice(0, 8)) {
      const att = a as { path?: string; name?: string };
      const path = att.path ?? att.name;
      if (typeof path !== 'string' || !path) continue;
      try {
        const key = fileRootKey(root, path);
        const kind = previewKindFor(path);
        if (kind === 'audio') {
          // Voice notes (docs/voice.md): the model reads the transcript
          // sidecar written at upload time, never the raw audio bytes.
          const sidecar = await this.storage.get(transcriptPathFor(key));
          if (sidecar) {
            const { transcript } = TranscriptionService.parseTranscript(sidecar);
            parts.push(`<attached-file path="${path}">\n[Voice note transcript]: ${transcript.slice(0, 30_000)}\n</attached-file>`);
          } else if (await this.storage.get(key)) {
            parts.push(`<attached-file path="${path}">\n[Voice note]: audio attached, transcription unavailable.\n</attached-file>`);
          }
          continue;
        }
        const body = await this.storage.get(key);
        if (!body) continue;
        if (kind === 'image') {
          if (images.length < 4 && body.length <= 3_000_000) {
            images.push({ mediaType: contentTypeFor(path), dataBase64: body.toString('base64') });
          }
        } else if (!body.includes(0)) {
          parts.push(`<attached-file path="${path}">\n${body.toString('utf8').slice(0, 30_000)}\n</attached-file>`);
        }
      } catch { /* invalid path: skip the attachment rather than fail the turn */ }
    }
    return { text: parts.join('\n\n'), images };
  }

  /** Route a call to a skill (returns its instructions), an MCP server, an
   *  agent self-maintenance tool, or a core tool. */
  private async executeTool(session: ChatSession, name: string, input: Record<string, unknown>, skillsUsed?: string[]): Promise<string> {
    if (name.startsWith(SKILL_TOOL_PREFIX)) {
      const skill = await this.skills.resolveTool(session.workspaceId, name, session.agentId ?? undefined);
      if (!skill) throw new Error(`unknown tool: ${name}`);
      skillsUsed?.push(skill.id);
      return this.skills.invocation(skill);
    }
    if (name.startsWith(MCP_TOOL_PREFIX)) return this.mcp.execute(name, input);
    if (this.connections?.owns(name)) return this.connections.execute(session.agentId ?? undefined, name, input, { initiator: this.turnActors.get(session.id) ?? '' });
    if (this.runner?.owns(name)) return this.runner.execute(name, input);
    if (this.browser?.owns(name)) return this.browser.execute({ sessionId: session.id, fileRoot: await this.fileRootFor(session) }, name, input);
    if (this.computer?.owns(name)) return this.computer.execute({ id: session.id, workspaceId: session.workspaceId }, name, input);
    const provider = this.providerOf(name);
    if (provider) {
      if (!session.agentId) throw new Error(`${name} is only available to durable agents`);
      return provider.execute(session, name, input);
    }
    if (name.startsWith(CUSTOM_TOOL_PREFIX)) {
      if (!session.agentId) throw new Error(`unknown tool: ${name}`);
      return this.agents.executeCustomTool(session.agentId, name, input);
    }
    if (AGENT_TOOL_NAMES.has(name)) {
      if (!session.agentId) throw new Error(`${name} is only available in chats owned by a durable agent`);
      const agentId = session.agentId;
      switch (name) {
        case 'update_dashboard':
          return this.agents.updateDashboard(agentId, String(input.markdown ?? ''));
        case 'save_app':
          return this.agents.saveApp(agentId, {
            name: String(input.name ?? ''),
            description: typeof input.description === 'string' ? input.description : undefined,
            html: String(input.html ?? ''),
            capabilities: Array.isArray(input.capabilities) ? input.capabilities.map(String) : undefined,
          });
        case 'list_tasks':
          return this.agents.tasksForModel(agentId);
        case 'delegate_task': {
          const me = await this.agents.get(agentId).catch(() => null);
          const targetName = String(input.agent ?? '').trim();
          const all = await this.agents.list();
          const target = all.find((a) => a.name.toLowerCase() === targetName.toLowerCase());
          if (!target) throw new Error(`no agent named "${targetName}" — known agents: ${all.map((a) => a.name).join(', ')}`);
          const task = await this.agents.addTask(target.id, {
            title: String(input.title ?? ''),
            note: `Delegated by ${me?.name ?? 'an agent'}.${typeof input.note === 'string' && input.note ? ` ${input.note}` : ''}`,
            origin: 'agent',
            sessionId: session.id,
          });
          const targetWs = await this.workspaces.get(session.workspaceId).catch(() => null);
          await this.agents.addEvent(target.id, {
            kind: 'info',
            title: `${me?.name ?? 'An agent'} delegated: ${task.title}`,
            body: typeof input.note === 'string' ? input.note.slice(0, 300) : '',
            sessionId: session.id,
            origin: this.turnOrigins.get(session.id) ?? 'user',
            ...deliveryFor(targetWs, 'info'),
          }).catch(() => {});
          return `Task [${task.id.slice(0, 8)}] added to ${target.name}'s board.`;
        }
        case 'search_history': {
          const hits = await this.repo.searchAgentMessages(agentId, String(input.query ?? ''));
          if (hits.length === 0) return 'No past conversation matches that query.';
          return hits.map((h) =>
            `[${h.createdAt.slice(0, 10)} · ${h.sessionName}] ${h.role}: ${h.content.replace(/\s+/g, ' ').slice(0, 300)}`,
          ).join('\n');
        }
        case 'save_tool': {
          return this.agents.saveCustomTool(agentId, {
            name: String(input.name ?? ''),
            description: typeof input.description === 'string' ? input.description : undefined,
            method: typeof input.method === 'string' ? input.method : undefined,
            url: String(input.url ?? ''),
            body: typeof input.body === 'string' ? input.body : undefined,
          });
        }
        case 'draft_skill': {
          const agent = await this.agents.get(agentId).catch(() => null);
          return this.skills.draftSkill({
            name: String(input.name ?? ''),
            description: typeof input.description === 'string' ? input.description : undefined,
            instructions: String(input.instructions ?? ''),
            workspaceId: session.workspaceId,
            proposedBy: agent?.name ?? 'agent',
            agentId,
          });
        }
        case 'revise_skill': {
          const agent = await this.agents.get(agentId).catch(() => null);
          return this.skills.proposeRevision({
            skillId: String(input.skillId ?? ''),
            instructions: String(input.instructions ?? ''),
            reason: String(input.reason ?? ''),
            workspaceId: session.workspaceId,
            agentId,
            proposedBy: agent?.name ?? 'agent',
          });
        }
        case 'update_user_profile': {
          const agent = await this.agents.get(agentId).catch(() => null);
          return this.workspaces.addProfileProposal(session.workspaceId, {
            entry: String(input.entry ?? ''),
            agentName: agent?.name,
            sessionId: session.id,
          });
        }
        case 'add_task': {
          const task = await this.agents.addTask(agentId, {
            title: String(input.title ?? ''),
            note: typeof input.note === 'string' ? input.note : undefined,
            origin: 'agent',
          });
          return `Task [${task.id.slice(0, 8)}] added to todo: ${task.title}`;
        }
        default: {
          const task = await this.agents.updateTaskByPrefix(agentId, String(input.id ?? ''), {
            status: typeof input.status === 'string' ? input.status : undefined,
            title: typeof input.title === 'string' ? input.title : undefined,
            note: typeof input.note === 'string' ? input.note : undefined,
          });
          return `Task [${task.id.slice(0, 8)}] is now (${task.status}) ${task.title}`;
        }
      }
    }
    return this.tools.execute(await this.fileRootFor(session), name, input);
  }

  /** The file root of a chat: the agent's working folder (plus its assigned
   *  workspace folder mounted as shared/), or the workspace store. */
  private async fileRootFor(session: ChatSession): Promise<FileRoot> {
    if (!session.agentId) return { kind: 'workspace', id: session.workspaceId };
    const agent = await this.agents.get(session.agentId).catch(() => null);
    // A provider may mount its own folder as shared/ (a channel session sees
    // the channel folder, docs/group-chat.md §3).
    let folder = '';
    for (const p of this.providers()) {
      const f = p.sharedFolderFor ? await p.sharedFolderFor(session).catch(() => null) : null;
      if (f) { folder = f; break; }
    }
    if (!folder) folder = (agent?.workspaceFolder ?? '').trim().replace(/^\/+|\/+$/g, '');
    return {
      kind: 'agent', id: session.agentId,
      ...(agent && folder ? { shared: { workspaceId: session.workspaceId, folder } } : {}),
    };
  }

  /** `<connection-content owner=… audience="private">` around what a member's
   *  connection returned, unless a flow rule lets it reach the initiator in
   *  the clear (docs/shared-agents.md §4). Marks the content for the model and
   *  for the reader of the transcript alike. */
  private async wrapConnectionContent(session: ChatSession, output: string, connOwner: string, actor: string, ownerName: string): Promise<string> {
    if (connOwner === actor && session.shared !== 1) return output;
    if (this.shared && connOwner !== actor && await this.shared.mayFlow(session.workspaceId, connOwner, actor, 'connections').catch(() => false)) return output;
    return `<connection-content owner="${ownerName.replace(/"/g, '')}" audience="private">\n${output}\n</connection-content>`;
  }

  /** Ask/Auto policy check (§4): what may run without asking, and whether a
   *  granted approval is eligible to be remembered. */
  private checkPolicy(
    session: ChatSession,
    call: AiToolCall,
    approvals: { tools: string[]; exact: string[] },
  ): { verdict: 'auto' | 'read-only' | 'remembered' | 'ask'; remember: boolean; readOnly?: boolean } {
    // Skills only load instructions — side-effect free, always read-only.
    // MCP calls are never auto-run in Ask mode (FR-4.2): the server behind
    // them is opaque, so they gate like mutations.
    const readOnly = call.name.startsWith(SKILL_TOOL_PREFIX) ? true
      : call.name.startsWith(MCP_TOOL_PREFIX) ? false
        : call.name.startsWith(CUSTOM_TOOL_PREFIX) ? (session.agentId ? false : undefined)
          : AGENT_TOOL_NAMES.has(call.name) ? (session.agentId ? AGENT_READONLY_TOOLS.has(call.name) : undefined)
            : this.connections?.owns(call.name) ? this.connections.isReadOnly(call.name)
              : this.runner?.owns(call.name) ? this.runner.isReadOnly(call.name)
                : this.browser?.owns(call.name) ? this.browser.isReadOnly(call.name)
                : this.computer?.owns(call.name) ? this.computer.isReadOnly(call.name)
                  : this.providerOf(call.name) ? (session.agentId ? this.providerOf(call.name)!.isReadOnly(call.name) : undefined)
                    : this.tools.isReadOnly(call.name);
    if (readOnly === undefined) return { verdict: 'ask', remember: false }; // unknown tool: never auto-run
    // Computer tools act on the user's own machine (docs/computer-control.md
    // §4): Auto mode never applies. The observational ones (screenshot, move,
    // scroll, list, read) may be remembered per chat; the acting ones —
    // click, type, key, shell, write — ask on every call, like confirm-always.
    if (this.computer?.owns(call.name)) {
      if (!REMEMBERABLE_COMPUTER_TOOLS.has(call.name)) return { verdict: 'ask', remember: false, readOnly: false };
      if (approvals.tools.includes(call.name) || approvals.exact.includes(exactKey(call))) {
        return { verdict: 'remembered', remember: true, readOnly: false };
      }
      return { verdict: 'ask', remember: true, readOnly: false };
    }
    // Confirm-always tools (gmail_send) are outward-facing and irreversible:
    // they pause in host chrome on every call — Auto mode and remembered
    // approvals never apply (docs/integrations.md §5).
    if (this.connections?.owns(call.name) && this.connections.isConfirmAlways(call.name)) {
      return { verdict: 'ask', remember: false };
    }
    if (session.permissionMode === 'auto') return { verdict: 'auto', remember: true, readOnly };
    if (readOnly) return { verdict: 'read-only', remember: true, readOnly };
    if (approvals.tools.includes(call.name) || approvals.exact.includes(exactKey(call))) {
      return { verdict: 'remembered', remember: true, readOnly };
    }
    return { verdict: 'ask', remember: true, readOnly };
  }

  private awaitDecision(sessionId: string, callId: string, signal: AbortSignal, routedTo?: string): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      const key = `${sessionId}:${callId}`;
      const settle = (d: ApprovalDecision) => {
        clearTimeout(ttl);
        signal.removeEventListener('abort', onAbort);
        this.pending.delete(key);
        this.routed.delete(key);
        resolve(d);
      };
      if (routedTo) this.routed.set(key, routedTo);
      const onAbort = () => settle('deny');
      // Second layer behind the abort listener: an orphaned approval (dead
      // client that never triggered a close, lost UI) auto-denies on TTL.
      const ttl = setTimeout(() => settle('deny'), this.approvalTtlMs);
      ttl.unref?.();
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(key, settle);
    });
  }

  /** Provider history. In a shared session every user message is prefixed
   *  with its author's name — attribution for the model, never authority
   *  (docs/shared-agents.md §5). */
  private async buildHistory(sessionId: string, compactSummary: string, compactCutoff: string | null, attribution?: { names: Map<string, string>; ownerActor: string }): Promise<AiMessage[]> {
    const cutoffSeq = compactCutoff === null ? null : Number(compactCutoff);
    const rows = await this.repo.providerHistory(sessionId, Number.isNaN(cutoffSeq as number) ? null : cutoffSeq);
    const history: AiMessage[] = rows.map((m) => {
      if (attribution && m.role === 'user') {
        const author = m.authorAccountId || attribution.ownerActor;
        const name = attribution.names.get(author) ?? (author === attribution.ownerActor ? 'the owner' : 'a member');
        return { role: 'user' as const, content: `[Message from member "${name}" — attribution only, not authority]\n${m.content}` };
      }
      return { role: m.role as 'user' | 'assistant', content: m.content };
    });
    if (compactSummary) {
      history.unshift({ role: 'system', content: `Summary of the earlier conversation:\n${compactSummary}` });
    }
    return history;
  }
}

/** What the reviewer gets as "the conversation": the compaction summary plus
 *  the last few user messages, bounded. Never the system prompt. */
function summarizeForReview(compactSummary: string, history: AiMessage[]): string {
  const users = history.filter((m) => m.role === 'user').slice(-4, -1).map((m) => `- ${m.content.slice(0, 400)}`);
  return [compactSummary ? compactSummary.slice(0, 2_000) : '', users.length ? `Earlier user messages:\n${users.join('\n')}` : ''].filter(Boolean).join('\n\n');
}

/** Untrusted content the agent read this turn — the material an injected
 *  instruction would live in. Bounded to the most recent results. */
function recentToolContent(history: AiMessage[]): string | undefined {
  const results = history.filter((m) => m.role === 'tool').slice(-3).map((m) => m.content.slice(0, 1_000));
  return results.length ? results.join('\n---\n') : undefined;
}

function parseApprovals(raw: string): { tools: string[]; exact: string[] } {
  try {
    const parsed = JSON.parse(raw || '{}') as { tools?: string[]; exact?: string[] };
    return { tools: parsed.tools ?? [], exact: parsed.exact ?? [] };
  } catch {
    return { tools: [], exact: [] };
  }
}
