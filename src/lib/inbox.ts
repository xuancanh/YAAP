/** The Inbox and the Company menu (docs/company-vision.md §8 "The CEO's
 *  seat"): everything waiting on the CEO in one list, and the company panes
 *  grouped in the Company rail. Pure — the views and the store use these. */
import type { OrgApproval, OrgHealth, OrgPlan, OrgTask } from './api';
import type { OrgPane } from '../store';

// ---- Inbox ----

export type InboxFilter = 'all' | 'approvals' | 'keys' | 'escalations' | 'plans' | 'mytasks' | 'incidents';
export const INBOX_FILTERS: Array<{ id: InboxFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'keys', label: 'Keys' },
  { id: 'escalations', label: 'Escalations' },
  { id: 'plans', label: 'Plans' },
  { id: 'mytasks', label: 'My tasks' },
  { id: 'incidents', label: 'Incidents' },
];

export interface InboxItem { key: string; kind: Exclude<InboxFilter, 'all'>; title: string; detail: string; at: string; refId: string }

export interface InboxSource {
  approvals: OrgApproval[];
  plans: OrgPlan[];
  tasks: { assigned: OrgTask[]; reviewing: OrgTask[] } | null;
  incidents: OrgHealth['openIncidents'];
  /** Held or staged actions waiting for the owner's key (one row for all). */
  heldActions: number;
}

const OPEN_TASK = new Set(['backlog', 'waiting', 'todo', 'claimed', 'in_progress', 'in_review', 'blocked']);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function payloadOf(a: OrgApproval): Record<string, unknown> {
  try { const v = JSON.parse(a.payload) as unknown; return v && typeof v === 'object' ? v as Record<string, unknown> : {}; } catch { return {}; }
}

/** One list, newest first: pending cards (escalations apart; two-key cards
 *  ride on the keys row), the keys row, plans awaiting veto, my open tasks
 *  and reviews, incidents nobody has contained yet. */
export function buildInbox(src: InboxSource): InboxItem[] {
  const out: InboxItem[] = [];
  for (const a of src.approvals) {
    if (a.status !== 'pending' || a.kind === 'two_key') continue;
    const p = payloadOf(a);
    const name = str(p.title) || str(p.name) || str(p.summary) || a.recommendation;
    if (a.kind === 'escalation') out.push({ key: `a:${a.id}`, kind: 'escalations', title: `Escalation: ${str(p.title) || 'a task'}`, detail: str(p.reason), at: a.createdAt, refId: a.id });
    else out.push({ key: `a:${a.id}`, kind: 'approvals', title: `${a.kind.replace(/_/g, ' ')}${name ? `: ${name}` : ''}`, detail: a.recommendation && a.recommendation !== name ? a.recommendation : '', at: a.createdAt, refId: a.id });
  }
  if (src.heldActions > 0) out.push({ key: 'keys', kind: 'keys', title: `${src.heldActions} action${src.heldActions === 1 ? '' : 's'} waiting for your key`, detail: 'Held or staged outward actions — the exact call runs only with your key.', at: '', refId: '' });
  for (const p of src.plans) if (p.status === 'pending') out.push({ key: `p:${p.id}`, kind: 'plans', title: `Plan: ${p.summary || p.trigger}`, detail: p.applyAt ? `applies at ${p.applyAt.slice(0, 16).replace('T', ' ')} unless vetoed` : '', at: p.createdAt, refId: p.id });
  for (const t of src.tasks?.assigned ?? []) if (OPEN_TASK.has(t.status)) out.push({ key: `t:${t.id}`, kind: 'mytasks', title: t.title, detail: `assigned to you · ${t.status.replace('_', ' ')}`, at: t.updatedAt ?? t.createdAt, refId: t.id });
  for (const t of src.tasks?.reviewing ?? []) if (OPEN_TASK.has(t.status)) out.push({ key: `r:${t.id}`, kind: 'mytasks', title: `Review: ${t.title}`, detail: 'waiting for your review', at: t.updatedAt ?? t.createdAt, refId: t.id });
  for (const i of src.incidents) if (i.status === 'open') out.push({ key: `i:${i.id}`, kind: 'incidents', title: i.title, detail: `${i.severity} · ${i.kind.replace(/_/g, ' ')}`, at: i.openedAt, refId: i.id });
  // The keys row (no time) leads; the rest newest first.
  return out.sort((a, b) => (a.at === b.at ? 0 : !a.at ? -1 : !b.at ? 1 : a.at < b.at ? 1 : -1));
}

export function filterInbox(items: InboxItem[], f: InboxFilter): InboxItem[] {
  return f === 'all' ? items : items.filter((i) => i.kind === f);
}

/** The Inbox nav badge: everything waiting on the CEO. */
export function inboxBadge(c: { pendingApprovals: number; heldActions: number; pendingPlans: number; openIncidents: number; myTasks: number }): number {
  return c.pendingApprovals + c.heldActions + c.pendingPlans + c.openIncidents + c.myTasks;
}

// ---- the Company menu ----

export type CompanyGroupId = 'teams' | 'direction' | 'operations' | 'people' | 'oversight';
export interface CompanyEntry { pane: OrgPane; label: string; /** Panes merged into this entry as tabs. */ tabs?: OrgPane[] }
/** The rail's groups below Teams (the unit groups). Approvals and My tasks
 *  live in the Inbox; Brief is a tab of Pulse, Capital of Spend, Replay of Audit. */
export const COMPANY_GROUPS: Array<{ id: CompanyGroupId; label: string; entries: CompanyEntry[] }> = [
  { id: 'teams', label: 'Teams', entries: [] },
  { id: 'direction', label: 'Direction', entries: [{ pane: 'vision', label: 'Vision' }, { pane: 'goals', label: 'Goals' }, { pane: 'plans', label: 'Plans' }, { pane: 'decisions', label: 'Decisions' }] },
  { id: 'operations', label: 'Operations', entries: [{ pane: 'pulse', label: 'Pulse', tabs: ['pulse', 'brief'] }, { pane: 'meetings', label: 'Meetings' }, { pane: 'incidents', label: 'Incidents' }] },
  { id: 'people', label: 'People & money', entries: [{ pane: 'chart', label: 'Org chart' }, { pane: 'spend', label: 'Spend', tabs: ['spend', 'capital'] }] },
  { id: 'oversight', label: 'Oversight', entries: [{ pane: 'audit', label: 'Audit', tabs: ['audit', 'replay'] }] },
];

/** The pane pairs shown as tabs of one entry, by pane. */
export function tabsOf(pane: OrgPane): OrgPane[] | null {
  for (const g of COMPANY_GROUPS) for (const e of g.entries) if (e.tabs?.includes(pane)) return e.tabs;
  return null;
}

/** Where a pane lives now: the Inbox for approvals and my tasks, the Company
 *  section for the rest (merged panes open on their tab). */
export function paneHome(pane: OrgPane): { section: 'inbox'; filter: InboxFilter } | { section: 'workspace'; pane: OrgPane } {
  if (pane === 'approvals') return { section: 'inbox', filter: 'approvals' };
  if (pane === 'mytasks') return { section: 'inbox', filter: 'mytasks' };
  return { section: 'workspace', pane };
}
