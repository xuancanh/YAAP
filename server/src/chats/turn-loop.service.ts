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
import { TurnContextService } from './turn-context.service';
import { SkillsService, SKILL_TOOL_PREFIX } from '../skills/skills.service';
import { McpService, MCP_TOOL_PREFIX } from '../mcp/mcp.module';
import { StorageService } from '../storage/storage.service';
import { AgentsService, CUSTOM_TOOL_PREFIX } from '../agents/agents.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { ConnectionsService } from '../connections/connections.service';

import { AiImagePart, AiMessage, AiStreamEvent, AiToolCall, AiToolSpec } from '../ai/ai-provider.interface';
import { contentTypeFor, previewKindFor } from '../storage/preview.util';

export type ApprovalDecision = 'allow-once' | 'allow-always' | 'allow-tool' | 'deny';

export type TurnEvent =
  | { type: 'turn'; turnId: string }
  | AiStreamEvent
  | { type: 'approval_required'; callId: string; tool: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; output: string; isError: boolean }
  | { type: 'error'; message: string };

interface ToolRecord {
  tool: string;
  input: Record<string, unknown>;
  result: string;
  approved: 'auto' | 'read-only' | 'remembered' | 'queued' | ApprovalDecision;
  isError: boolean;
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
    description: 'Create or update (same name replaces) one of your mini apps: a single self-contained HTML file shown on your home page and embeddable into chats. It runs in a sandboxed iframe with no network access, so inline all CSS/JS. Apps may request capabilities from the window.yaam bridge (all promise-based, feature-detect with `if (window.yaam)`): storage (get/set app-private state), chat.compose (prefill the chat box), files.read (list/read your working folder incl. shared/), files.write (write inside the app\'s own folder), tasks.read, tasks.write (add/move board tasks), agent.ask (ask you a question, Ask-mode, budgeted). storage and chat.compose activate immediately; the rest stay parked until the user reviews them on the app card, so request only what the app really uses.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short app name (also the update key).' },
        description: { type: 'string', description: 'One line on what the app does.' },
        html: { type: 'string', description: 'The complete self-contained HTML document.' },
        capabilities: { type: 'array', items: { type: 'string' }, description: 'Bridge capabilities the app uses: storage, chat.compose, files.read, files.write, tasks.read, tasks.write, agent.ask.' },
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
const AGENT_READONLY_TOOLS = new Set(['list_tasks', 'search_history', 'update_user_profile', 'draft_skill', 'save_tool']);

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

  /** Resolve a paused tool approval (POST /:id/approve). */
  resolveApproval(sessionId: string, callId: string, decision: ApprovalDecision): boolean {
    const resolve = this.pending.get(`${sessionId}:${callId}`);
    if (!resolve) return false;
    resolve(decision);
    return true;
  }

  async *run(sessionId: string, input: { text: string; attachments?: unknown[]; origin?: 'user' | 'loop' }): AsyncGenerator<TurnEvent> {
    const session = await this.repo.getSession(sessionId);
    if (!session) throw new NotFoundException(`chat ${sessionId}`);
    if (session.tokenCeiling > 0 && session.tokensIn + session.tokensOut >= session.tokenCeiling) {
      throw new ForbiddenException('token ceiling reached');
    }
    if (!this.locks.tryAcquire(sessionId)) throw new ConflictException('chat is busy');

    const ctl = new AbortController();
    this.aborts.set(sessionId, ctl);

    const turn = await this.repo.createTurn(sessionId, { ...input, model: session.model });
    await this.repo.appendMessage({ sessionId, turnId: turn.id, role: 'user', content: input.text });
    // Auto-title from the first message when the chat is unnamed (FR-1.3).
    if (!session.name && !session.autoTitle) {
      await this.repo.updateSession(sessionId, { autoTitle: input.text.replace(/\s+/g, ' ').slice(0, 64) });
    }
    yield { type: 'turn', turnId: turn.id };

    let tokensIn = 0;
    let tokensOut = 0;
    let overheadChars = 0;
    const toolRecords: ToolRecord[] = [];
    try {
      const ctx = await this.context.build(session);
      const history = await this.buildHistory(session.id, session.compactSummary, session.compactCutoff);
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
      const toolSpecs = [
        ...this.tools.specs(),
        ...(session.agentId ? AGENT_TOOLS : []),
        ...(session.agentId ? await this.agents.customToolSpecs(session.agentId) : []),
        ...await this.skills.toolSpecs(session.workspaceId, session.agentId ?? undefined),
        ...await this.mcp.toolSpecs(),
        // Connection tools appear only for agents the user granted (activation gate).
        ...(session.agentId && this.connections ? await this.connections.toolSpecs(session.agentId) : []),
      ];
      // Per-round overhead every provider call also carries: the resolved
      // system prompt plus the full tool-spec JSON (tens of KB once MCP
      // servers are enabled). Fed into the auto-compaction estimate below so
      // it fires before the provider's real context limit, not after.
      overheadChars = ctx.system.length + JSON.stringify(toolSpecs).length;

      for (let round = 0; ; round++) {
        let answer = '';
        const calls: AiToolCall[] = [];
        for await (const ev of ctx.provider.stream({
          model: ctx.model,
          system: ctx.system,
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
          // Loop turns are background turns: outward-facing (connection)
          // mutations queue as pending approvals in the agent inbox, never
          // silently execute — even in Auto mode (docs/integrations.md §5).
          if (input.origin === 'loop' && session.agentId
            && this.connections?.owns(call.name) && this.connections.isReadOnly(call.name) === false) {
            const summary = JSON.stringify(call.input).slice(0, 280);
            await this.agents.addEvent(session.agentId, {
              kind: 'action_pending',
              title: `Needs your approval: ${call.name}`,
              body: summary,
              sessionId: session.id,
              payload: JSON.stringify({ tool: call.name, input: call.input }),
            });
            const output = `Queued for the user's approval: ${call.name} was recorded in the user's inbox and will run only if they approve it. Do not retry — tell the user what you queued and why.`;
            await this.repo.appendMessage({ sessionId, turnId: turn.id, role: 'tool', content: output, toolName: call.name });
            history.push({ role: 'tool', content: output, toolCallId: call.id, isError: false });
            toolRecords.push({ tool: call.name, input: call.input, result: output, approved: 'queued', isError: false });
            yield { type: 'tool_result', id: call.id, name: call.name, output, isError: false };
            continue;
          }
          const { verdict, remember } = this.checkPolicy(session, call, approvals);
          let decision: ToolRecord['approved'] = verdict === 'ask' ? 'deny' : verdict;
          if (verdict === 'ask') {
            // Register the resolver BEFORE yielding: the client may answer the
            // moment it sees the event, and the generator only resumes when the
            // consumer pulls again — approving into an unregistered slot would
            // deadlock the turn.
            const decided = this.awaitDecision(sessionId, call.id, ctl.signal);
            yield { type: 'approval_required', callId: call.id, tool: call.name, input: call.input };
            decision = await decided;
            if ((decision === 'allow-always' || decision === 'allow-tool') && remember) {
              if (decision === 'allow-always') approvals.exact.push(exactKey(call));
              if (decision === 'allow-tool' && !SELF_MOD_TOOLS.has(call.name)) approvals.tools.push(call.name);
              await this.repo.updateSession(sessionId, { approvals: JSON.stringify(approvals) });
            }
          }

          let output: string;
          let isError = false;
          if (decision === 'deny') {
            output = 'Denied by user.';
            isError = true;
          } else {
            try {
              output = await this.executeTool(session, call.name, call.input);
            } catch (err) {
              output = `tool error: ${err instanceof Error ? err.message : String(err)}`;
              isError = true;
            }
          }
          await this.repo.appendMessage({ sessionId, turnId: turn.id, role: 'tool', content: output, toolName: call.name });
          history.push({ role: 'tool', content: output, toolCallId: call.id, isError });
          toolRecords.push({ tool: call.name, input: call.input, result: output.slice(0, 2000), approved: decision, isError });
          yield { type: 'tool_result', id: call.id, name: call.name, output: output.slice(0, 500), isError };
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
        tokensIn, tokensOut,
      });
      await this.repo.updateSession(sessionId, {
        tokensIn: session.tokensIn + tokensIn,
        tokensOut: session.tokensOut + tokensOut,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.repo.updateTurn(turn.id, {
        status: 'error', error: message, toolCalls: JSON.stringify(toolRecords), tokensIn, tokensOut,
      });
      yield { type: 'error', message };
    } finally {
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
        const body = await this.storage.get(fileRootKey(root, path));
        if (!body) continue;
        if (previewKindFor(path) === 'image') {
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
  private async executeTool(session: ChatSession, name: string, input: Record<string, unknown>): Promise<string> {
    if (name.startsWith(SKILL_TOOL_PREFIX)) {
      const skill = await this.skills.resolveTool(session.workspaceId, name, session.agentId ?? undefined);
      if (!skill) throw new Error(`unknown tool: ${name}`);
      return this.skills.invocation(skill);
    }
    if (name.startsWith(MCP_TOOL_PREFIX)) return this.mcp.execute(name, input);
    if (this.connections?.owns(name)) return this.connections.execute(session.agentId ?? undefined, name, input);
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
          await this.agents.addEvent(target.id, {
            kind: 'info',
            title: `${me?.name ?? 'An agent'} delegated: ${task.title}`,
            body: typeof input.note === 'string' ? input.note.slice(0, 300) : '',
            sessionId: session.id,
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
    const folder = (agent?.workspaceFolder ?? '').trim().replace(/^\/+|\/+$/g, '');
    return {
      kind: 'agent', id: session.agentId,
      ...(agent && folder ? { shared: { workspaceId: session.workspaceId, folder } } : {}),
    };
  }

  /** Ask/Auto policy check (§4): what may run without asking, and whether a
   *  granted approval is eligible to be remembered. */
  private checkPolicy(
    session: ChatSession,
    call: AiToolCall,
    approvals: { tools: string[]; exact: string[] },
  ): { verdict: 'auto' | 'read-only' | 'remembered' | 'ask'; remember: boolean } {
    // Skills only load instructions — side-effect free, always read-only.
    // MCP calls are never auto-run in Ask mode (FR-4.2): the server behind
    // them is opaque, so they gate like mutations.
    const readOnly = call.name.startsWith(SKILL_TOOL_PREFIX) ? true
      : call.name.startsWith(MCP_TOOL_PREFIX) ? false
        : call.name.startsWith(CUSTOM_TOOL_PREFIX) ? (session.agentId ? false : undefined)
          : AGENT_TOOL_NAMES.has(call.name) ? (session.agentId ? AGENT_READONLY_TOOLS.has(call.name) : undefined)
            : this.connections?.owns(call.name) ? this.connections.isReadOnly(call.name)
              : this.tools.isReadOnly(call.name);
    if (readOnly === undefined) return { verdict: 'ask', remember: false }; // unknown tool: never auto-run
    // Confirm-always tools (gmail_send) are outward-facing and irreversible:
    // they pause in host chrome on every call — Auto mode and remembered
    // approvals never apply (docs/integrations.md §5).
    if (this.connections?.owns(call.name) && this.connections.isConfirmAlways(call.name)) {
      return { verdict: 'ask', remember: false };
    }
    if (session.permissionMode === 'auto') return { verdict: 'auto', remember: true };
    if (readOnly) return { verdict: 'read-only', remember: true };
    if (approvals.tools.includes(call.name) || approvals.exact.includes(exactKey(call))) {
      return { verdict: 'remembered', remember: true };
    }
    return { verdict: 'ask', remember: true };
  }

  private awaitDecision(sessionId: string, callId: string, signal: AbortSignal): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      const key = `${sessionId}:${callId}`;
      const settle = (d: ApprovalDecision) => {
        clearTimeout(ttl);
        signal.removeEventListener('abort', onAbort);
        this.pending.delete(key);
        resolve(d);
      };
      const onAbort = () => settle('deny');
      // Second layer behind the abort listener: an orphaned approval (dead
      // client that never triggered a close, lost UI) auto-denies on TTL.
      const ttl = setTimeout(() => settle('deny'), APPROVAL_TTL_MS);
      ttl.unref?.();
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(key, settle);
    });
  }

  private async buildHistory(sessionId: string, compactSummary: string, compactCutoff: string | null): Promise<AiMessage[]> {
    const cutoffSeq = compactCutoff === null ? null : Number(compactCutoff);
    const rows = await this.repo.providerHistory(sessionId, Number.isNaN(cutoffSeq as number) ? null : cutoffSeq);
    const history: AiMessage[] = rows.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));
    if (compactSummary) {
      history.unshift({ role: 'system', content: `Summary of the earlier conversation:\n${compactSummary}` });
    }
    return history;
  }
}

function parseApprovals(raw: string): { tools: string[]; exact: string[] } {
  try {
    const parsed = JSON.parse(raw || '{}') as { tools?: string[]; exact?: string[] };
    return { tools: parsed.tools ?? [], exact: parsed.exact ?? [] };
  } catch {
    return { tools: [], exact: [] };
  }
}
