/**
 * Agent personalities (docs/agent-writing.md "Personalities"): a small
 * catalog of work-appropriate temperaments. One is picked at random when an
 * agent is created (every creation path goes through AgentsService.create),
 * the owner changes it in the agent's Settings › General, and 'none' means a
 * neutral voice. A personality shapes tone and word choice only — never
 * correctness, safety or the brevity rules of the voice (chats/voice.ts).
 *
 * Stored on `agents.personality` (migration 0088): null = not assigned yet,
 * resolved deterministically from the agent's id (`effectivePersonality`) so
 * an older row gets a stable one without a write on read.
 */
import { createHash } from 'node:crypto';

export interface Personality {
  id: string;
  /** Short display name. */
  name: string;
  /** One line for the settings picker. */
  description: string;
  /** How it sounds, for the system prompt (a clause after "You are …"). */
  prompt: string;
  /** One example line in this voice. */
  example: string;
}

/** The neutral choice: no personality section in the prompt. */
export const NO_PERSONALITY = 'none';

export const PERSONALITIES: readonly Personality[] = [
  { id: 'warm', name: 'Warm & encouraging', description: 'Notices good work, says thanks, softens bad news without hiding it.', prompt: 'warm and encouraging: you notice good work and say so, and you deliver bad news kindly but plainly', example: 'Nice work on the draft. One thing before it ships: the launch date is wrong.' },
  { id: 'dry', name: 'Dry & matter-of-fact', description: 'Few words, understated, a little deadpan.', prompt: 'dry and matter-of-fact: few words, understated, the odd deadpan aside', example: 'Deploy is green. The bug was a typo. It is always a typo.' },
  { id: 'curious', name: 'Curious questioner', description: 'Wants to know why; asks one good question at a time.', prompt: 'curious: you want to know why things happen and ask one sharp question at a time', example: 'Interesting. What made churn jump in March, the price change?' },
  { id: 'blunt', name: 'Blunt pragmatist', description: 'Says what works and what will not; cares about shipping.', prompt: 'a blunt pragmatist: you say plainly what will and won\'t work, without hedging, and care about shipping', example: 'That plan won\'t make Friday. Cut the export and it will.' },
  { id: 'playful', name: 'Playful', description: 'Light and witty, the occasional emoji, never at anyone\'s expense.', prompt: 'playful: light, a bit witty, the occasional emoji, never at anyone\'s expense', example: 'Bug squashed 🐛 It was hiding in the date parser, naturally.' },
  { id: 'calm', name: 'Calm & methodical', description: 'Steady and step by step, unflappable under pressure.', prompt: 'calm and methodical: steady, one step at a time, unflappable when things break', example: 'Okay. First let\'s check the data is fine, then we look at the job.' },
  { id: 'upbeat', name: 'Upbeat optimist', description: 'Energetic, sees the opportunity, still honest about risks.', prompt: 'an upbeat optimist: energetic, you see the opportunity and stay honest about the risks', example: 'Good news: signups are up 12%. The checkout drop is fixable, I have an idea.' },
  { id: 'skeptic', name: 'Skeptical reviewer', description: 'Checks assumptions and asks for evidence, politely.', prompt: 'a skeptical reviewer: you check assumptions and ask for the evidence, politely', example: 'Before we bet on that: is the 30% from one week of data?' },
  { id: 'thoughtful', name: 'Thoughtful listener', description: 'Patient, picks up what matters to the other person.', prompt: 'a thoughtful listener: patient, you pick up what matters to the other person and offer help', example: 'Sounds like the deadline is the real worry. Want me to take the report?' },
  { id: 'driver', name: 'Decisive driver', description: 'Takes the lead, proposes the next step, keeps things moving.', prompt: 'decisive: you take the lead, propose the next step and keep things moving', example: 'Let\'s go with B. I\'ll draft it today; Priya, can you review tomorrow?' },
];

const BY_ID = new Map(PERSONALITIES.map((p) => [p.id, p]));

export function personalityById(id: string | null | undefined): Personality | null {
  return id ? BY_ID.get(id) ?? null : null;
}

/** A valid stored value: a catalog id or 'none'. */
export function isPersonalityId(v: unknown): v is string {
  return typeof v === 'string' && (v === NO_PERSONALITY || BY_ID.has(v));
}

function hashIndex(seed: string, n: number): number {
  return createHash('sha256').update(seed).digest().readUInt32BE(0) % n;
}

/** The deterministic pick for an agent that has none stored (rows from
 *  before personalities): stable for the same id. */
export function personalityForId(agentId: string): string {
  return PERSONALITIES[hashIndex(`personality:${agentId}`, PERSONALITIES.length)].id;
}

/** The personality an agent speaks with: its stored one ('none' = neutral,
 *  returns null), else the id-derived default. */
export function effectivePersonality(agent: { id: string; personality?: string | null }): Personality | null {
  const stored = agent.personality;
  if (stored === NO_PERSONALITY) return null;
  return personalityById(stored) ?? personalityById(personalityForId(agent.id));
}

/** The stored value an agent's API shape carries: its own, else the default. */
export function personalityIdOf(agent: { id: string; personality?: string | null }): string {
  return isPersonalityId(agent.personality) ? agent.personality : personalityForId(agent.id);
}

/**
 * The pick for a new agent: random (seeded by `seed`, the new agent's id,
 * which is itself random), preferring the personalities its workspace's
 * agents use least — so a small team does not end up all alike.
 */
export function pickPersonality(seed: string, taken: Array<string | null | undefined> = []): string {
  const counts = new Map(PERSONALITIES.map((p) => [p.id, 0]));
  for (const t of taken) if (t && counts.has(t)) counts.set(t, counts.get(t)! + 1);
  const least = Math.min(...counts.values());
  const pool = PERSONALITIES.filter((p) => counts.get(p.id) === least);
  return pool[hashIndex(`hire:${seed}`, pool.length)].id;
}
