/**
 * Curated agent-market catalog (FR-11.7). Static for now — a remote registry
 * can replace this array behind the same API. Each entry declares the
 * capabilities and scheduled loops it will run, which the hire modal shows
 * for review before install (loops enable immediately on hire).
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

export const MARKET_CATALOG: MarketItem[] = [
  {
    id: 'sentinel', name: 'Sentinel', emoji: '🛡️', role: 'Security Auditor', colors: ['#f0625a', '#cf3838'],
    author: 'yaam-labs', verified: true, stars: '4.9', installs: '12k installs', cat: 'Security', price: 'free',
    tagline: 'Scans dependencies and diffs for CVEs, secrets, and risky patterns.',
    caps: ['fs_read', 'http', 'web_search'],
    capsFull: [
      { name: 'fs_read', desc: 'Read source and lockfiles', icon: 'file' },
      { name: 'http_request', desc: 'Query the CVE advisory database', icon: 'globe' },
      { name: 'web_search', desc: 'Research advisories and patches', icon: 'globe' },
    ],
    loops: [{ name: 'Daily dependency CVE scan', cron: '0 4 * * *' }, { name: 'Secret-leak watch', cron: '0 */6 * * *' }],
    charter: 'You are Sentinel, a security auditor. Scan workspace files for vulnerable dependencies, leaked secrets, and risky patterns. Record every finding in LESSONS.md with severity and remediation. Never modify files without approval.',
  },
  {
    id: 'cartographer', name: 'Cartographer', emoji: '🗺️', role: 'Codebase Mapper', colors: ['#3ad6b0', '#159e86'],
    author: 'openmap', verified: true, stars: '4.7', installs: '8.4k installs', cat: 'Productivity', price: 'free',
    tagline: 'Builds a live map of modules, owners, and dependency edges.',
    caps: ['fs_read', 'fs_search', 'fs_write'],
    capsFull: [
      { name: 'fs_read', desc: 'Walk the source tree', icon: 'file' },
      { name: 'fs_search', desc: 'Resolve imports and symbols', icon: 'compass' },
      { name: 'fs_write', desc: 'Maintain the architecture map', icon: 'edit' },
    ],
    loops: [{ name: 'Weekly architecture snapshot', cron: '0 8 * * 1' }],
    charter: 'You are Cartographer. Maintain a living map of the workspace: modules, ownership, and dependency edges, kept in knowledge/architecture.md. Update it as files change; keep it navigable and current.',
  },
  {
    id: 'metronome', name: 'Metronome', emoji: '⏱️', role: 'CI & Perf Watchdog', colors: ['#f0a93a', '#d9762a'],
    author: 'yaam-labs', verified: true, stars: '4.8', installs: '6.1k installs', cat: 'DevOps', price: 'metered',
    tagline: 'Watches CI timing and perf budgets, opens tasks on regressions.',
    caps: ['http', 'schedule'],
    capsFull: [
      { name: 'http_request', desc: 'Poll the CI status API', icon: 'globe' },
      { name: 'schedule', desc: 'Run timed benchmark loops', icon: 'clock' },
    ],
    loops: [{ name: 'Hourly CI health poll', cron: '0 * * * *' }, { name: 'Nightly perf benchmark', cron: '0 1 * * *' }],
    charter: 'You are Metronome, a CI and performance watchdog. Poll build status, track timing trends in JOURNAL.md, and raise a clear report when a budget regresses.',
  },
  {
    id: 'polyglot', name: 'Polyglot', emoji: '🌐', role: 'i18n & Translation', colors: ['#5ca8f2', '#3a6ee0'],
    author: 'linguabot', verified: false, stars: '4.4', installs: '2.3k installs', cat: 'Productivity', price: 'free',
    tagline: 'Extracts strings and keeps translation catalogs current across locales.',
    caps: ['fs_read', 'fs_write', 'http'],
    capsFull: [
      { name: 'fs_read', desc: 'Find translatable strings', icon: 'file' },
      { name: 'fs_write', desc: 'Write catalog files', icon: 'edit' },
      { name: 'http_request', desc: 'Call the translation service', icon: 'globe' },
    ],
    loops: [{ name: 'Catalog sync check', cron: '0 7 * * *' }],
    charter: 'You are Polyglot. Keep translation catalogs complete and consistent across locales. Extract new strings, flag missing keys, and never machine-translate legal or safety text without marking it for review.',
  },
  {
    id: 'ledger', name: 'Ledger', emoji: '📒', role: 'License & Compliance', colors: ['#94a3b8', '#5a6675'],
    author: 'compliance.io', verified: true, stars: '4.6', installs: '3.9k installs', cat: 'Security', price: 'metered',
    tagline: 'Tracks dependency licenses and flags incompatible additions.',
    caps: ['fs_read', 'http'],
    capsFull: [
      { name: 'fs_read', desc: 'Inspect manifests', icon: 'file' },
      { name: 'http_request', desc: 'Resolve license metadata', icon: 'globe' },
    ],
    loops: [{ name: 'License audit', cron: '0 6 * * 1' }],
    charter: 'You are Ledger, a license-compliance auditor. Track every dependency license in knowledge/licenses.md, flag copyleft or incompatible additions, and cite the license source.',
  },
  {
    id: 'muse', name: 'Muse', emoji: '🎨', role: 'UI Prototyper', colors: ['#a77bf0', '#7a4fe0'],
    author: 'studio-nine', verified: false, stars: '4.5', installs: '5.2k installs', cat: 'Design', price: 'free',
    tagline: 'Drafts sandboxed HTML/SVG artifacts from a written spec.',
    caps: ['fs_write', 'slides_create'],
    capsFull: [
      { name: 'fs_write', desc: 'Compose HTML/SVG files', icon: 'edit' },
      { name: 'slides_create', desc: 'Render sandboxed decks', icon: 'window' },
    ],
    loops: [],
    charter: 'You are Muse, a UI prototyper. Turn written specs into clean, self-contained HTML/SVG prototypes saved to workspace files. No external resources — everything must render inside the sandboxed preview.',
  },
];
