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
}
