/**
 * Connection context cards (docs/company-vision.md §12, docs/integrations.md
 * "Context cards and suggested loops"): a connection is a capability with a
 * manual. Each card is data — what the service is, what the agent can do
 * with it at each grant level, the data it exposes, the risks, how to use the
 * tools well, and suggested uses each paired with a ready-made loop.
 *
 * `usage` and the capability lines are injected into the system context of
 * every agent that holds a grant on the card's service (turn-loop); the
 * suggested loops are installed through POST /api/agents/:id/loops/install.
 */
import type { LoopDef } from '../../chats/loop-def';

/** Which capability a card documents. Connection services match
 *  connections.tools.ts `ConnectionService`; the rest are the other
 *  surfaces an agent may hold (channels, the browser, the companion, MCP). */
export type CardService =
  | 'calendar' | 'gmail' | 'drive'
  | 'telegram' | 'email' | 'push'
  | 'browser' | 'computer' | 'mcp';

export type CardGrantLevel = 'read' | 'write';

export interface SuggestedUse {
  /** Stable within the card; the install route addresses `cardId/useId`. */
  id: string;
  title: string;
  /** One or two sentences: why this is worth running. */
  why: string;
  /** The loop installed verbatim (name may be adjusted for uniqueness). */
  loop: LoopDef;
  /** The grant level the loop's tools need; install refuses below it. */
  grantLevel: CardGrantLevel;
  /** Kinds of work this use fits (sales, research, publishing, support,
   *  operations, finance, …). The operating profile ranks uses whose tags it
   *  mentions first (docs/company-vision.md §1b); untagged uses fit any. */
  fits?: string[];
}

export interface ContextCard {
  /** `<provider>-<service>` for connections (google-gmail), else the surface. */
  id: string;
  service: CardService;
  /** google | microsoft for connection cards; '' otherwise. */
  provider: 'google' | 'microsoft' | '';
  title: string;
  summary: string;
  capabilities: { read: string[]; write: string[] };
  dataExposed: string;
  /** External floor / PII notes, in plain words. */
  risks: string;
  /** How to use the tools well: 5–10 short lines, injected into the prompt. */
  usage: string[];
  suggestedUses: SuggestedUse[];
}
