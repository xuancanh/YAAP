/** The Market's two layers (docs/agent-catalog.md "Segments and functions"):
 *  Personal (categories) and Business (job functions, each a head and its
 *  team). Pure helpers plus the navigation hook; mirrors
 *  server/src/market/segments.ts for the function list and category order.
 *  Kept free of components so the rail and web-tests can use it without
 *  pulling the lazy MarketView chunk. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MarketItem, OrgMember } from './api';

export type MarketSegment = 'personal' | 'business';
export const SEGMENT_LABEL: Record<MarketSegment, string> = { personal: 'Personal', business: 'Business' };

export interface BizFunctionMeta { id: string; label: string; icon: string; color: string }

/** Rail order, labels, and the icon and colour a function's cards carry. */
export const BIZ_FUNCTIONS: readonly BizFunctionMeta[] = [
  { id: 'leadership', label: 'Leadership', icon: '🧭', color: '#5c6bc0' },
  { id: 'sales', label: 'Sales', icon: '🤝', color: '#2f7fd0' },
  { id: 'marketing', label: 'Marketing', icon: '📣', color: '#d81b60' },
  { id: 'customer', label: 'Customer Success & Support', icon: '🎧', color: '#0f9d8a' },
  { id: 'product', label: 'Product', icon: '🧩', color: '#00838f' },
  { id: 'engineering', label: 'Engineering', icon: '🛠️', color: '#1e6fd9' },
  { id: 'design', label: 'Design', icon: '🎨', color: '#ad1457' },
  { id: 'data', label: 'Data & Analytics', icon: '📊', color: '#3949ab' },
  { id: 'finance', label: 'Finance', icon: '🏦', color: '#2e7d32' },
  { id: 'people', label: 'People & HR', icon: '🧑‍🤝‍🧑', color: '#ef6c00' },
  { id: 'legal', label: 'Legal', icon: '⚖️', color: '#5e35b1' },
  { id: 'operations', label: 'Operations', icon: '⚙️', color: '#546e7a' },
  { id: 'it-security', label: 'IT & Security', icon: '🛡️', color: '#c62828' },
  { id: 'revops', label: 'Revenue Operations', icon: '📈', color: '#6d4c41' },
];

/** Personal category order: professional practices first, then personal life;
 *  a category the catalog adds beyond this list appends at the end. */
export const PERSONAL_CATS: readonly string[] = [
  'Workplace', 'Product & Engineering', 'Education', 'Legal & Finance', 'Writing & Media',
  'Care & Community', 'Property & Field', 'Small Business',
  'Family & Care', 'Home & Money', 'Health & Growth', 'Events & Travel', 'Hobbies & Leisure',
];

/** An item's segment; registry items and older servers that do not say are personal. */
export function segmentOf(m: Pick<MarketItem, 'segment'>): MarketSegment {
  return m.segment === 'business' ? 'business' : 'personal';
}

export function bySegment(items: MarketItem[], segment: MarketSegment): MarketItem[] {
  return items.filter((m) => segmentOf(m) === segment);
}

/** The personal categories in canonical order, 'All' first. */
export function marketCats(items: Array<Pick<MarketItem, 'cat' | 'segment'>>): string[] {
  const found = Array.from(new Set(items.filter((m) => segmentOf(m) === 'personal').map((m) => m.cat)));
  return ['All', ...PERSONAL_CATS.filter((c) => found.includes(c)), ...found.filter((c) => !PERSONAL_CATS.includes(c))];
}

export function functionMeta(id: string | undefined): BizFunctionMeta {
  return BIZ_FUNCTIONS.find((f) => f.id === id) ?? { id: id ?? 'other', label: id ? id.replace(/-/g, ' ') : 'Other', icon: '🏢', color: '#607d8b' };
}

/** The business functions present in the catalog, in rail order, with counts. */
export function bizFunctions(items: MarketItem[]): Array<BizFunctionMeta & { count: number; head: MarketItem | null }> {
  const biz = bySegment(items, 'business');
  const known = new Set(BIZ_FUNCTIONS.map((f) => f.id));
  const extra = Array.from(new Set(biz.map((m) => m.function ?? 'other').filter((f) => !known.has(f)))).map(functionMeta);
  return [...BIZ_FUNCTIONS, ...extra]
    .map((f) => {
      const members = biz.filter((m) => (m.function ?? 'other') === f.id);
      return { ...f, count: members.length, head: members.find((m) => m.level === 'head') ?? null };
    })
    .filter((f) => f.count > 0);
}

/** A function page: the head first, then the specialists who report to it,
 *  then the rest of the function (leadership, generalist packs). */
export function functionPage(items: MarketItem[], fn: string): { head: MarketItem | null; team: MarketItem[]; others: MarketItem[] } {
  const members = bySegment(items, 'business').filter((m) => (m.function ?? 'other') === fn);
  const head = members.find((m) => m.level === 'head') ?? null;
  const team = head ? members.filter((m) => m.reportsTo === head.id) : [];
  const others = members.filter((m) => m !== head && !team.includes(m));
  return { head, team, others };
}

/** Search across both segments: name, role, tagline, category and function. */
export function searchMarket(items: MarketItem[], q: string): MarketItem[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((m) => [m.name, m.role, m.tagline, segmentOf(m) === 'business' ? functionMeta(m.function).label : m.cat]
    .some((s) => (s ?? '').toLowerCase().includes(needle)));
}

/** Who a business pack reports to, by name ("Head of Finance"), or null. */
export function reportsToName(item: MarketItem, items: MarketItem[]): string | null {
  if (item.level === 'leadership') return item.id === 'pack-chief-of-staff' ? 'the CEO' : 'the CEO and the board';
  if (!item.reportsTo) return null;
  return items.find((m) => m.id === item.reportsTo)?.name ?? null;
}

/** One line on when it works: the pack's cadence, else its loops by name. */
export function cadenceLine(item: Pick<MarketItem, 'cadence' | 'loops'>): string | null {
  if (item.cadence) return item.cadence;
  if (item.loops.length) return item.loops.map((l) => l.name).join(' · ');
  return null;
}

/** The member a company hire of `item` reports to by default: a specialist
 *  goes under its function's head when the company has one (matched by the
 *  seat title the head was hired with), everything else under the chief. */
export function defaultReportsTo(item: MarketItem, items: MarketItem[], members: OrgMember[], chiefId: string | null): string | null {
  const active = members.filter((m) => m.status === 'active');
  if (item.level === 'specialist') {
    const head = items.find((m) => m.function === item.function && m.level === 'head');
    const titles = head ? [head.name, head.role].map((s) => s.toLowerCase()) : [];
    const seat = active.find((m) => titles.includes(m.title.toLowerCase()));
    if (seat) return seat.agentId;
  }
  return chiefId && active.some((m) => m.agentId === chiefId) ? chiefId : (chiefId ?? active[0]?.agentId ?? null);
}

// ---- navigation: segment, personal category, business function ----

export interface MarketNav {
  segment: MarketSegment;
  /** Personal category ('All' = every category). */
  cat: string;
  /** Business function id ('' = the function overview). */
  fn: string;
}

/** `?section=market&segment=business&fn=finance` (and `&cat=Education`). */
export function navFromUrl(search: string): Partial<MarketNav> | null {
  const p = new URLSearchParams(search);
  if (p.get('section') !== 'market') return null;
  const out: Partial<MarketNav> = {};
  const seg = p.get('segment');
  const fn = p.get('fn');
  const cat = p.get('cat');
  if (seg === 'personal' || seg === 'business') out.segment = seg;
  if (fn) { out.fn = fn; out.segment ??= 'business'; }
  if (cat) { out.cat = cat; out.segment ??= 'personal'; }
  return Object.keys(out).length ? out : null;
}

export function navQuery(nav: MarketNav): string {
  const p = new URLSearchParams({ section: 'market', segment: nav.segment });
  if (nav.segment === 'business' && nav.fn) p.set('fn', nav.fn);
  if (nav.segment === 'personal' && nav.cat !== 'All') p.set('cat', nav.cat);
  return `?${p.toString()}`;
}

export const SEGMENT_KEY = 'yaam-market-segment';

/** The viewer's last choice; null when none is stored or storage is blocked. */
export function loadSegment(): MarketSegment | null {
  try {
    const v = localStorage.getItem(SEGMENT_KEY);
    return v === 'personal' || v === 'business' ? v : null;
  } catch { return null; }
}

export function saveSegment(s: MarketSegment): void {
  try { localStorage.setItem(SEGMENT_KEY, s); } catch { /* storage blocked: the choice lasts this visit */ }
}

/** Deep link, then the viewer's last choice, then Business when the
 *  workspace runs a company and Personal otherwise. */
export function defaultSegment(fromUrl: MarketSegment | undefined, stored: MarketSegment | null, orgOn: boolean): MarketSegment {
  return fromUrl ?? stored ?? (orgOn ? 'business' : 'personal');
}

/** The Market's navigation state, shared by the rail and the view. Until a
 *  deep link or the viewer's own choice decides, the segment follows whether
 *  the workspace runs a company (which loads after the first render). */
export function useMarketNav(orgOn: boolean): { nav: MarketNav; setNav: (patch: Partial<MarketNav>) => void } {
  const [init] = useState(() => {
    const url = typeof window === 'undefined' ? null : navFromUrl(window.location.search);
    const stored = loadSegment();
    return { url, stored, decided: !!(url?.segment || stored) };
  });
  const decided = useRef(init.decided);
  const [nav, setState] = useState<MarketNav>(() => ({
    segment: defaultSegment(init.url?.segment, init.stored, orgOn), cat: init.url?.cat ?? 'All', fn: init.url?.fn ?? '',
  }));
  useEffect(() => {
    if (decided.current) return;
    setState((n) => ({ ...n, segment: orgOn ? 'business' : 'personal' }));
  }, [orgOn]);
  const setNav = useCallback((patch: Partial<MarketNav>) => {
    if (patch.segment) { decided.current = true; saveSegment(patch.segment); }
    setState((n) => ({ ...n, ...patch }));
  }, []);
  return { nav, setNav };
}
