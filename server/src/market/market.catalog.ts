/**
 * Agent-market types (FR-11.7). The catalog itself is the generated
 * profession packs (profession-packs.generated.ts); a remote registry can
 * replace it behind the same API. Each entry declares the capabilities,
 * loops, and bundled skills the hire modal shows for review before install
 * (loops enable immediately on hire).
 */
export interface MarketCapability {
  name: string;
  desc: string;
  icon: string;
}

export interface MarketLoop {
  name: string;
  cron: string;
  prompt?: string;
}

/** A skill bundled with a profession pack; installed agent-private on hire. */
export interface MarketSkill {
  name: string;
  description: string;
  instructions: string;
}

/** The market's top layer (docs/agent-catalog.md "Segments and functions"). */
export type MarketSegment = 'personal' | 'business';
/** Where a business pack sits in its function: the head (a unit lead under
 *  the chief of staff), a specialist on its team, or company leadership (the
 *  chief of staff, the auditor). */
export type MarketLevel = 'head' | 'specialist' | 'leadership';

export interface MarketItem {
  id: string;
  name: string;
  emoji: string;
  role: string;
  colors: [string, string];
  author: string;
  verified: boolean;
  stars: string;
  installs: string;
  cat: string;
  price: 'free' | 'metered';
  tagline: string;
  caps: string[];
  capsFull: MarketCapability[];
  loops: MarketLoop[];
  charter: string;
  /** Present on profession packs: skills installed (agent-private) on hire. */
  skills?: MarketSkill[];
  // The two-layer market. Optional so registry and community items (and
  // older clients) stay valid: an item without a segment is personal.
  segment?: MarketSegment;
  /** Business only: the job function id (BIZ_FUNCTIONS in segments.ts). */
  function?: string;
  level?: MarketLevel;
  /** Business heads and specialists: the pack id of the manager they report to. */
  reportsTo?: string;
  /** What the role owns, from the pack (docs/agent-catalog.md tables). */
  kpis?: string[];
  /** The default cadence in one line; the company tunes it. */
  cadence?: string;
}
