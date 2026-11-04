/**
 * The agents' voice (docs/agent-writing.md): one section of every agent's
 * system prompt — personal and company agents, every provider — built by
 * TurnContextService. It makes agents sound like a capable colleague: short
 * by default, everyday words, the point first, no filler.
 *
 * The register depends on where the agent is speaking:
 *  - `chat` — a direct conversation with a person: conversational, a few
 *    sentences by default, longer when asked or when the content needs it;
 *  - `conversation` — a channel, a discussion sub-channel or a meeting: like
 *    Slack between teammates, usually one to three sentences;
 *  - `task` — the agent's own work (task wakes, loops, heartbeats, org runs):
 *    no length cap; deliverables are as long and structured as the work
 *    needs, still in plain words.
 *
 * The workspace tunes it in Settings › How agents write to you: the style
 * (`writingStyle`: plain | concise | detailed) moves the chat register's
 * default length, and `agentPersonalities` ('on' | 'off') turns the
 * per-agent personality line on or off. Neither changes the register rules.
 */
import { classifySession } from './session-kind';
import type { Personality } from '../agents/personalities';

export type Register = 'chat' | 'conversation' | 'task';
export const WRITING_STYLES = ['plain', 'concise', 'detailed'] as const;

/** Is this session a channel / discussion / meeting working session? Both
 *  the channel runtime and the meeting runtime run an agent's turns in its
 *  per-channel session `#<slug> · <agent>`, tagged `channel`. */
export function isChannelSession(s: { name?: string | null; tags?: string | null }): boolean {
  const name = s.name ?? '';
  return (s.tags ?? '').includes('"channel"') || (name.startsWith('#') && name.includes(' · '));
}

/** The register a session's turns speak in: a channel or meeting session is
 *  a conversation; another `work` session (org runs, loops, heartbeats, app
 *  asks) is task mode; anything else is a chat with a person. */
export function registerFor(s: { name?: string | null; tags?: string | null; kind?: string | null; taskKind?: string | null }): Register {
  if (isChannelSession(s)) return 'conversation';
  const kind = s.kind === 'work' || s.kind === 'chat' ? s.kind : classifySession(s);
  return kind === 'work' ? 'task' : 'chat';
}

/** Rules every register shares, with a concrete before/after. */
const CORE = [
  'How you talk: like a capable colleague, not a report.',
  '- Lead with the point. Everyday words, contractions are fine, say "I" and "you".',
  '- No throat-clearing or filler: no "Great question", "I will now…", "Let me…", no recap of what they just said, no sign-off like "Let me know if you need anything else".',
  '- No corporate words (leverage, align, circle back, actionable). Explain a code the first time: "the pricing task (ENG-12)".',
  '- No headings or bullets for what two sentences can say.',
  '- Blocked? Ask one clear question instead of listing options.',
  'Not "I have completed a thorough review and identified several key areas for improvement:" but "Read it. Two fixes: the price on page 2 is old, and the intro buries the offer."',
].join('\n');

function chatLength(style?: string | null): string {
  if (style === 'concise') return 'One to three sentences unless they ask for more.';
  if (style === 'detailed') return 'A few short paragraphs are fine: include your reasoning and the trade-offs.';
  return 'Usually a few sentences; longer only when they ask or the content needs it (code, a plan, a comparison).';
}

const REGISTER: Record<Register, (style?: string | null) => string> = {
  chat: (style) => `You're talking with a person directly. ${chatLength(style)}`,
  conversation: () => [
    'This is a group conversation (a channel or a meeting): write like Slack between teammates.',
    '- Usually one to three sentences. React to what was just said and use names.',
    '- Don\'t re-summarise the thread or restate the agenda; everyone can see it.',
    '- Agreeing in a few words is fine ("+1, ship it"). In a meeting with nothing new, pass.',
    '- A draft, table or analysis goes in a file or task; post one line pointing to it.',
    'Not "Thanks for the update, Sam. To summarise, the launch moves to Friday, and I agree because…" but "Friday works, Sam. I\'ll have the copy ready Thursday."',
  ].join('\n'),
  task: () => 'This is a work session, so no length limit: deliverables, briefs, reports and handoffs are as long and structured as the work needs (headings, lists and tables are fine there), and a handoff must stand on its own for someone who wasn\'t here. Still plain words, no padding, no restating the brief. Messages to people from here (comments, channel posts, message_owner) stay short: what changed and what you need.',
};

/** The personality line (null / 'none' / the setting off → nothing). */
export function personalityLine(p: Personality | null | undefined): string {
  if (!p) return '';
  return `Personality: you're ${p.prompt}. E.g. "${p.example}" It colours your tone and word choice only, never your accuracy, judgment, safety or length.`;
}

/** The voice section of the system prompt. */
export function voiceSection(opts: { register: Register; style?: string | null; personality?: Personality | null }): string {
  return [CORE, REGISTER[opts.register](opts.style), personalityLine(opts.personality)].filter(Boolean).join('\n');
}
