/**
 * Memory tools (docs/agent-memory.md §12): what an agent uses to learn as it
 * works, instead of hoping distillation catches it hours later.
 *
 *  - `memory_note` — record a lesson the moment it is learned (the rule, what
 *    happened, the evidence), or confirm / retire one of its lessons by the
 *    8-character id the prompt shows. Rate-limited per session, deduped by
 *    the store, capped in size.
 *  - `memory_recall` — search its own lessons (retired ones marked) and its
 *    knowledge/ notes; `search_history` stays the search over conversations.
 *  - `memory_guidance` — rewrite its own "How I work" section, naming the
 *    lessons the change comes from (boundary row `self_guidance`: alone).
 *
 * Provenance holds here as in distillation (§3): a turn on an untrusted
 * surface (a mini app, a chat channel) may only *propose* — its notes are
 * quarantined, and it may not confirm, retire or rewrite guidance, because
 * an app that could do that could write its agent's instructions.
 *
 * Before this, an agent that wanted to remember appended to LESSONS.md with
 * fs_append, and the next regeneration of that file erased it.
 */
import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import type { AiToolSpec } from '../ai/ai-provider.interface';
import { AgentMemoryService, LESSON_CHARS, SHARED_AUDIENCE, isTrustedSource, privateAudience, shortLessonId, sourceForSession } from '../agents/agent-memory.service';
import { AgentGuidanceService, SELF_GUIDANCE_CHARS } from '../agents/agent-guidance.service';
import { SharedService } from '../shared/shared.service';
import { currentAccountId } from '../accounts/account-context';
import type { ChatSession } from './chats.repository';
import { TurnLoopService, type ToolProviderHook } from './turn-loop.service';

const NOTE = 'memory_note';
const RECALL = 'memory_recall';
const GUIDANCE = 'memory_guidance';
const NAMES = new Set([NOTE, RECALL, GUIDANCE]);
/** Notes one session may write per hour: learning, not narrating. */
export const NOTES_PER_HOUR = 6;

export const MEMORY_TOOL_SPECS: AiToolSpec[] = [
  {
    name: NOTE,
    description: 'Record what you just learned so you apply it next time: a correction, a review sent back, an approach that failed, a fix that worked. One rule in one sentence, with what happened and the evidence (task key, message, file). Repeats merge into the same lesson and count up. Or confirm (it held again) / retire (it was wrong or no longer holds) one of your lessons by the id shown before it.',
    inputSchema: {
      type: 'object',
      properties: {
        lesson: { type: 'string', description: `The rule, written for your future self (under ${LESSON_CHARS} characters): "Before X, check Y", not a diary line.` },
        what_happened: { type: 'string', description: 'One line: what happened that taught it.' },
        evidence: { type: 'string', description: 'What it rests on: a task key (REJ-35), a message, a file path.' },
        tags: { type: 'string', description: 'A few keywords for when it applies (e.g. "pricing sources review").' },
        confirms: { type: 'string', description: 'Id of one of your lessons this work proved right again.' },
        retires: { type: 'string', description: 'Id of one of your lessons that proved wrong or stale.' },
        reason: { type: 'string', description: 'Why it is retired (required with retires).' },
      },
    },
  },
  {
    name: RECALL,
    description: 'Search your own lessons and knowledge/ notes for what you learned about something ("pricing sources", "review rubric", a task key). Returns lessons with their ids, counts and evidence, and matching note lines. For past conversations use search_history.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
  },
  {
    name: GUIDANCE,
    description: `Rewrite your "How I work" section: your own working notes, injected right after your charter in every turn (under ${SELF_GUIDANCE_CHARS} characters, the whole new section). Use it when a lesson keeps repeating or several lessons add up to a way of working. Name the lessons it comes from; a person sees the change and can edit it. Your charter is not yours to change: a lesson that should change it is proposed for you when it repeats.`,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The complete new section: short lines, each a habit you keep.' },
        lessonIds: { type: 'array', items: { type: 'string' }, description: 'Ids of the lessons this comes from.' },
        why: { type: 'string', description: 'One line: what changed and why.' },
      },
      required: ['text', 'lessonIds', 'why'],
    },
  },
];

@Injectable()
export class MemoryToolsService implements ToolProviderHook, OnModuleInit {
  /** sessionId → note timestamps (ms) in the last hour. */
  private readonly notes = new Map<string, number[]>();
  /** Test seam: the clock. */
  now: () => number = () => Date.now();

  constructor(
    private readonly memory: AgentMemoryService,
    @Optional() private readonly guidance?: AgentGuidanceService,
    @Optional() private readonly shared?: SharedService,
    @Optional() private readonly turns?: TurnLoopService,
  ) {}

  onModuleInit(): void { this.turns?.addToolProvider(this); }

  async specsFor(session: ChatSession): Promise<AiToolSpec[]> {
    if (!session.agentId) return [];
    return this.guidance ? MEMORY_TOOL_SPECS : MEMORY_TOOL_SPECS.filter((s) => s.name !== GUIDANCE);
  }
  owns(name: string): boolean { return NAMES.has(name); }
  /** The agent's own bookkeeping, like update_user_profile: it never asks. */
  isReadOnly(name: string): boolean { return NAMES.has(name); }
  async contextFor(): Promise<string | null> { return null; }

  /** Who reads what this session teaches: shared without members; with
   *  members, private to the member whose session it is (the owner can share
   *  it on the Memory tab) — a note can quote content the others may not see. */
  private async audience(session: ChatSession): Promise<{ audience: string; actor: string; allowFrom?: ReadonlySet<string> }> {
    const actor = session.initiatedBy || currentAccountId();
    const hasMembers = this.shared ? await this.shared.hasMembers(session.workspaceId).catch(() => false) : false;
    if (!hasMembers) return { audience: SHARED_AUDIENCE, actor };
    const allowFrom = await this.shared!.allowedSources(session.workspaceId, actor, 'lessons').catch(() => new Set<string>());
    return { audience: privateAudience(actor), actor, allowFrom };
  }

  async execute(session: ChatSession, name: string, input: Record<string, unknown>): Promise<string> {
    const agentId = session.agentId;
    if (!agentId) throw new Error('memory tools need a durable agent');
    const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '');
    const source = sourceForSession(session.name || '');
    const trusted = isTrustedSource(source);
    switch (name) {
      case NOTE: {
        const confirms = str('confirms'); const retires = str('retires'); const lesson = str('lesson');
        if (!confirms && !retires && !lesson) throw new Error('give a lesson, or confirms / retires with a lesson id');
        if ((confirms || retires) && !trusted) throw new Error('on this surface you may propose a lesson, not change your existing ones');
        const evidence = [str('evidence') ? str('evidence').slice(0, 120) : '', `session:${session.id}`].filter(Boolean);
        const out: string[] = [];
        if (confirms) {
          const r = await this.memory.confirm(agentId, confirms, { evidence });
          out.push(`Confirmed [${shortLessonId(r.id)}] — now learned ${r.useCount}×.`);
        }
        if (retires) {
          if (!str('reason')) throw new Error('say why it is retired (reason)');
          const r = await this.memory.retire(agentId, retires, str('reason'));
          out.push(`Retired [${shortLessonId(r.id)}]: it stays on record and is no longer in your prompt.`);
        }
        if (lesson) {
          const t = this.now();
          const recent = (this.notes.get(session.id) ?? []).filter((x) => t - x < 60 * 60_000);
          if (recent.length >= NOTES_PER_HOUR) throw new Error(`you have noted ${recent.length} lessons in this session in the last hour — keep the few that matter; the rest can wait for the end of the work`);
          recent.push(t); this.notes.set(session.id, recent);
          const { audience } = await this.audience(session);
          const r = await this.memory.record(agentId, lesson, {
            source, sessionId: session.id, audience, cause: 'note', context: str('what_happened'), evidence, tags: str('tags'),
          });
          out.push(r.merged
            ? `Same as your lesson [${shortLessonId(r.lesson.id)}] — now learned ${r.lesson.useCount}×.`
            : `Noted as [${shortLessonId(r.lesson.id)}].${r.lesson.trusted ? '' : ' It came from an untrusted surface, so it waits for a person to review it before it is ever used.'}`);
          if (lesson.length > LESSON_CHARS) out.push(`(cut to ${LESSON_CHARS} characters)`);
        }
        return out.join(' ');
      }
      case RECALL: {
        const q = str('query');
        if (!q) throw new Error('query is required');
        const { actor, allowFrom } = await this.audience(session);
        const hits = await this.memory.recall(agentId, q, { actor, allowFrom, limit: typeof input.limit === 'number' ? input.limit : undefined });
        if (hits.length === 0) return 'Nothing in your lessons or knowledge/ notes matches that. Try other words, or search_history for past conversations.';
        return hits.map((h) => h.kind === 'lesson'
          ? `- [${h.id}]${h.status === 'retired' ? ' (retired)' : ''} ${h.text}${h.ref ? ` — ${h.ref}` : ''}`
          : `- ${h.ref}: ${h.text}`).join('\n');
      }
      case GUIDANCE: {
        if (!this.guidance) throw new Error('guidance is not available on this server');
        if (!trusted) throw new Error('your How I work section can only change from your own work, not from this surface');
        const ids = Array.isArray(input.lessonIds) ? input.lessonIds.map(String) : [];
        const r = await this.guidance.writeSelf(agentId, { text: str('text'), lessonIds: ids, why: str('why'), by: 'agent' });
        return `How I work updated (${r.text.length} characters${r.truncated ? `, cut to ${SELF_GUIDANCE_CHARS}` : ''}), from ${ids.length} lesson(s). It applies from your next turn; a person can see and edit it on your Memory tab.`;
      }
    }
    throw new Error(`unknown tool: ${name}`);
  }
}
