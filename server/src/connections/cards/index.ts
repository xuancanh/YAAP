/**
 * The card catalog (docs/integrations.md "Context cards and suggested loops").
 * Cards are data: one file per connector, this index validates them at
 * import time (every suggested cron parses, every service name exists) so a
 * broken card fails the build's tests, not an agent's turn.
 */
import { cronMatches } from '../../chats/cron.util';
import { validateLoopDef, type LoopDef } from '../../chats/loop-def';
import type { ContextCard, CardGrantLevel, CardService, SuggestedUse } from './types';
import { googleGmail } from './google-gmail';
import { googleCalendar } from './google-calendar';
import { googleDrive } from './google-drive';
import { microsoftMail } from './microsoft-mail';
import { microsoftCalendar } from './microsoft-calendar';
import { microsoftFiles } from './microsoft-files';
import { telegram } from './telegram';
import { email } from './email';
import { webPush } from './web-push';
import { browser } from './browser';
import { computer } from './computer';
import { mcpCard } from './mcp';

export type { ContextCard, CardGrantLevel, CardService, SuggestedUse } from './types';
export { mcpCard } from './mcp';

/** Services a card may document; connection services first. */
export const CARD_SERVICES: readonly CardService[] = ['calendar', 'gmail', 'drive', 'telegram', 'email', 'push', 'browser', 'computer', 'mcp'];

/** The static catalog, in display order. MCP cards are built per server. */
export const CARDS: readonly ContextCard[] = [
  googleGmail, googleCalendar, googleDrive,
  microsoftMail, microsoftCalendar, microsoftFiles,
  telegram, email, webPush, browser, computer,
];

/** Probe a cron: it must match at least one minute in the coming 8 days
 *  (every suggested loop is at most weekly), which rejects junk like
 *  "on merge" or "61 * * * *" without a parser. */
export function cronIsSatisfiable(cron: string, from = new Date(2026, 5, 1, 0, 0)): boolean {
  const start = from.getTime();
  for (let m = 0; m < 8 * 24 * 60; m++) {
    if (cronMatches(cron, new Date(start + m * 60_000))) return true;
  }
  return false;
}

/** Throws on the first invalid card; returns the problems found otherwise
 *  (an empty list = the catalog is sound). Tests call it; so does the module
 *  at import so a bad card is loud at boot. */
export function validateCards(cards: readonly ContextCard[] = CARDS): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const card of cards) {
    if (!card.id || ids.has(card.id)) problems.push(`card id missing or duplicated: ${card.id}`);
    ids.add(card.id);
    if (!CARD_SERVICES.includes(card.service)) problems.push(`${card.id}: unknown service ${card.service}`);
    if (card.usage.length < 3 || card.usage.length > 10) problems.push(`${card.id}: usage should be 3–10 lines`);
    const useIds = new Set<string>();
    for (const use of card.suggestedUses) {
      if (useIds.has(use.id)) problems.push(`${card.id}/${use.id}: duplicate use id`);
      useIds.add(use.id);
      try {
        const loop = validateLoopDef(use.loop, (msg) => { throw new Error(msg); });
        if (loop.cron && !cronIsSatisfiable(loop.cron)) problems.push(`${card.id}/${use.id}: cron "${loop.cron}" never matches`);
      } catch (err) {
        problems.push(`${card.id}/${use.id}: ${err instanceof Error ? err.message : err}`);
      }
      if (use.grantLevel !== 'read' && use.grantLevel !== 'write') problems.push(`${card.id}/${use.id}: grantLevel must be read or write`);
    }
  }
  return problems;
}

{
  const problems = validateCards();
  if (problems.length > 0) throw new Error(`connection cards are invalid: ${problems.join('; ')}`);
}

export function cardById(id: string): ContextCard | undefined {
  return CARDS.find((c) => c.id === id);
}

/** The card for a provider + service grant. */
export function cardFor(provider: string, service: string): ContextCard | undefined {
  return CARDS.find((c) => c.provider === provider && c.service === service);
}

/** Cards documenting a service (both providers for a connection service). */
export function cardsForService(service: string): ContextCard[] {
  return CARDS.filter((c) => c.service === service);
}

/**
 * Order suggested uses by how well they fit the workspace's operating
 * profile (docs/company-vision.md §1b): a use whose `fits` tags appear in
 * the profile text ranks first (more hits = higher), untagged uses keep
 * their place after the tagged hits, tagged misses go last. No profile =
 * the card's own order. Pure string matching, no model call.
 */
export function rankUses(uses: SuggestedUse[], profile: string | null | undefined): SuggestedUse[] {
  const text = (profile ?? '').toLowerCase();
  if (!text.trim()) return [...uses];
  const score = (u: SuggestedUse): number => {
    if (!u.fits || u.fits.length === 0) return 0;
    const hits = u.fits.filter((tag) => text.includes(tag.toLowerCase())).length;
    return hits > 0 ? hits : -1;
  };
  return uses
    .map((u, i) => ({ u, i, s: score(u) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.u);
}

/** A card with its uses ranked for a profile. */
export function cardForProfile(card: ContextCard, profile: string | null | undefined): ContextCard {
  return { ...card, suggestedUses: rankUses(card.suggestedUses, profile) };
}

/** The loop a suggested use installs, validated and named uniquely among
 *  `existing` ("Morning mail digest", "Morning mail digest 2", …). */
export function loopForUse(use: SuggestedUse, existing: Array<Pick<LoopDef, 'name'>>): LoopDef {
  const loop = validateLoopDef(use.loop, (msg) => { throw new Error(`suggested loop is invalid: ${msg}`); });
  const taken = new Set(existing.map((l) => l.name));
  let name = loop.name;
  for (let n = 2; taken.has(name); n++) name = `${loop.name} ${n}`.slice(0, 100);
  return { ...loop, name };
}

/** Compact prompt block for the cards an agent holds: title, the capability
 *  lines its grant level unlocks, and the usage lines. Bounded to roughly
 *  600 tokens in total; cards past the budget are named, not expanded. */
export const CARD_CONTEXT_CHAR_CAP = 2_400;

export function cardContextBlock(held: Array<{ card: ContextCard; level: CardGrantLevel }>): string | null {
  if (held.length === 0) return null;
  const sections: string[] = [];
  const skipped: string[] = [];
  let used = 0;
  const header = 'Your connections (how to use them well; capabilities listed are the ones your grant covers):';
  used += header.length;
  for (const { card, level } of held) {
    const caps = [...card.capabilities.read, ...(level === 'write' ? card.capabilities.write : [])]
      .map((c) => c.split(':')[0].trim()).filter(Boolean);
    const lines = [
      `## ${card.title} (${level})`,
      ...(caps.length > 0 ? [`Tools: ${caps.join(', ')}.`] : []),
      ...card.usage.map((u) => `- ${u}`),
    ];
    const text = lines.join('\n');
    if (used + text.length + 2 > CARD_CONTEXT_CHAR_CAP && sections.length > 0) { skipped.push(card.title); continue; }
    sections.push(text);
    used += text.length + 2;
  }
  if (skipped.length > 0) sections.push(`Also granted (manual at GET /api/connections/cards): ${skipped.join(', ')}.`);
  return [header, ...sections].join('\n\n');
}

/** Build the card for an MCP server row as McpService lists it. */
export function mcpCardFor(server: { id: string; name: string; tools: string | string[] }): ContextCard {
  let tools: string[] = [];
  if (Array.isArray(server.tools)) tools = server.tools.filter((t): t is string => typeof t === 'string');
  else {
    try {
      const parsed = JSON.parse(server.tools) as unknown;
      if (Array.isArray(parsed)) tools = parsed.map((t) => (typeof t === 'string' ? t : (t as { name?: string })?.name ?? '')).filter(Boolean);
    } catch { /* no tools known yet */ }
  }
  return mcpCard({ id: server.id, name: server.name, tools });
}
