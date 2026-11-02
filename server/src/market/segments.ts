/**
 * The market's two layers (docs/agent-catalog.md "Segments and functions"):
 * personal packs grouped by category, business packs by job function. Pure
 * data and functions so the service, tests and the SPA mirror
 * (src/lib/market.ts) agree. The function ids are the ones packs name in
 * their frontmatter (scripts/build-authored-packs.mjs validates them).
 */
import type { MarketItem, MarketSegment } from './market.catalog';
import { ROLES } from '../org/roles/catalog';

export interface BizFunction { id: string; label: string }

/** Rail order: leadership first, then the functions as the business catalog lists them. */
export const BIZ_FUNCTIONS: readonly BizFunction[] = [
  { id: 'leadership', label: 'Leadership' },
  { id: 'sales', label: 'Sales' },
  { id: 'marketing', label: 'Marketing' },
  { id: 'customer', label: 'Customer Success & Support' },
  { id: 'product', label: 'Product' },
  { id: 'engineering', label: 'Engineering' },
  { id: 'design', label: 'Design' },
  { id: 'data', label: 'Data & Analytics' },
  { id: 'finance', label: 'Finance' },
  { id: 'people', label: 'People & HR' },
  { id: 'legal', label: 'Legal' },
  { id: 'operations', label: 'Operations' },
  { id: 'it-security', label: 'IT & Security' },
  { id: 'revops', label: 'Revenue Operations' },
];

/** Personal category order: professional practices first, then personal life. */
export const PERSONAL_CATS: readonly string[] = [
  'Workplace', 'Product & Engineering', 'Education', 'Legal & Finance', 'Writing & Media',
  'Care & Community', 'Property & Field', 'Small Business',
  'Family & Care', 'Home & Money', 'Health & Growth', 'Events & Travel', 'Hobbies & Leisure',
];

/** An item's segment; anything that does not say is personal. */
export function segmentOf(item: Pick<MarketItem, 'segment'>): MarketSegment {
  return item.segment === 'business' ? 'business' : 'personal';
}

/** What "Hire into the company" sends as the hire's `templateOrPack`
 *  (OrgApprovalsService.prepareHire): the catalog role whose Role.packId is
 *  this pack (`role:<id>`: the role's charter, scopes and tier plus the
 *  pack's playbooks), else the pack itself for a business pack with no role
 *  (the Auditor, the profession packs). Null for personal packs and for the
 *  chief of staff, whose seat is set when the company starts. */
export function orgHireRef(item: Pick<MarketItem, 'id' | 'segment'>): string | null {
  if (segmentOf(item) !== 'business' || item.id === 'pack-chief-of-staff') return null;
  const role = ROLES.find((r) => r.packId === item.id);
  return role ? `role:${role.id}` : item.id;
}

export interface SegmentSummary {
  personal: { total: number; cats: Array<{ cat: string; count: number }> };
  business: { total: number; functions: Array<{ id: string; label: string; count: number; headId: string | null }> };
}

/** Counts per category and per function, in rail order; empty groups are left out. */
export function segmentSummary(items: ReadonlyArray<Pick<MarketItem, 'id' | 'cat' | 'segment' | 'function' | 'level'>>): SegmentSummary {
  const personal = items.filter((m) => segmentOf(m) === 'personal');
  const business = items.filter((m) => segmentOf(m) === 'business');
  const found = Array.from(new Set(personal.map((m) => m.cat)));
  const cats = [...PERSONAL_CATS.filter((c) => found.includes(c)), ...found.filter((c) => !PERSONAL_CATS.includes(c))]
    .map((cat) => ({ cat, count: personal.filter((m) => m.cat === cat).length }));
  const known = new Set(BIZ_FUNCTIONS.map((f) => f.id));
  const extra = Array.from(new Set(business.map((m) => m.function ?? 'other').filter((f) => !known.has(f))));
  const functions = [...BIZ_FUNCTIONS, ...extra.map((id) => ({ id, label: id }))]
    .map((f) => {
      const members = business.filter((m) => (m.function ?? 'other') === f.id);
      return { id: f.id, label: f.label, count: members.length, headId: members.find((m) => m.level === 'head')?.id ?? null };
    })
    .filter((f) => f.count > 0);
  return { personal: { total: personal.length, cats }, business: { total: business.length, functions } };
}
