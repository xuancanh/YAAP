/** The company's sections (docs/company-vision.md "On screen"): in
 *  organization mode the company is five main-menu items — Direction,
 *  Operations, People, Money, Oversight — each landing on its own dashboard
 *  with its pages in the section's rail. What waits on the CEO lives in the
 *  Inbox only; company settings live in Settings › Company only. Pure — the
 *  store, the rails, the main menu and the tests use these. */
import type { InboxFilter } from './inbox';
import type { OrgPane } from '../store';

export type CompanySection = 'direction' | 'operations' | 'people' | 'money' | 'oversight';
export const COMPANY_SECTION_IDS: CompanySection[] = ['direction', 'operations', 'people', 'money', 'oversight'];

export interface CompanyPage { pane: OrgPane; label: string }
export interface CompanySectionDef {
  id: CompanySection; label: string;
  /** One line under the section's name on its dashboard. */
  blurb: string;
  pages: CompanyPage[];
}

/** Every company page, in exactly one section. The dashboard (orgPane null)
 *  comes first in each rail. */
export const COMPANY_SECTIONS: CompanySectionDef[] = [
  {
    id: 'direction', label: 'Direction', blurb: 'Where the company is going: the vision, what is aligned with you, goals and key results, the roadmap and what was decided.',
    pages: [{ pane: 'vision', label: 'Vision' }, { pane: 'alignment', label: 'Alignment' }, { pane: 'goals', label: 'Goals' }, { pane: 'roadmap', label: 'Roadmap' }, { pane: 'decisions', label: 'Decisions' }],
  },
  {
    id: 'operations', label: 'Operations', blurb: 'How the work runs day to day: the board, the pulse and the brief, the meeting rhythm and incidents.',
    pages: [{ pane: 'board', label: 'Board' }, { pane: 'pulse', label: 'Pulse' }, { pane: 'brief', label: 'Brief' }, { pane: 'meetings', label: 'Meetings' }, { pane: 'incidents', label: 'Incidents' }],
  },
  {
    id: 'people', label: 'People', blurb: 'Who does the work: the org chart, the teams with their channels, boards and goals, and how loaded everyone is.',
    pages: [{ pane: 'chart', label: 'Org chart' }, { pane: 'teams', label: 'Teams' }],
  },
  {
    id: 'money', label: 'Money', blurb: 'What the company spends and on what: envelopes, the month-end forecast and capital by goal.',
    pages: [{ pane: 'spend', label: 'Spend' }, { pane: 'capital', label: 'Capital' }],
  },
  {
    id: 'oversight', label: 'Oversight', blurb: 'Whether the company can be trusted: the audit trail, the auditor’s findings, trust levels, the quality of its work and its policies, and the day-by-day replay.',
    pages: [{ pane: 'audit', label: 'Audit' }, { pane: 'quality', label: 'Quality' }, { pane: 'replay', label: 'Replay' }],
  },
];

/** Panes that wait on the CEO: they open in the Inbox, never in a section. */
const INBOX_PANES: Partial<Record<OrgPane, InboxFilter>> = { approvals: 'approvals', mytasks: 'mytasks', plans: 'plans' };

export const isCompanySection = (s: string | null | undefined): s is CompanySection => (COMPANY_SECTION_IDS as string[]).includes(s ?? '');

/** Every organization page id (the store re-exports it; the router reads it). */
export const ORG_PANES: OrgPane[] = ['board', 'goals', 'chart', 'approvals', 'spend', 'brief', 'audit', 'vision', 'pulse', 'meetings', 'decisions', 'plans', 'replay', 'capital', 'mytasks', 'incidents', 'roadmap', 'teams', 'quality', 'alignment'];
export const isOrgPane = (v: string | null | undefined): v is OrgPane => Boolean(v) && (ORG_PANES as string[]).includes(v as string);
/** Panes folded into Artifacts (playbooks, experiments, evals, outcomes and
 *  metrics are mirrored as files under /org/; docs/filesystem.md): a link to
 *  one of them opens the Artifacts section instead. */
export const ORG_PANES_IN_ARTIFACTS = ['ask', 'playbooks', 'metrics', 'experiments', 'outcomes', 'evals'];

export function sectionDef(id: CompanySection): CompanySectionDef {
  return COMPANY_SECTIONS.find((s) => s.id === id) ?? COMPANY_SECTIONS[0];
}

/** The section a company page belongs to (undefined for the Inbox panes). */
export function sectionOfPane(pane: OrgPane): CompanySection | undefined {
  return COMPANY_SECTIONS.find((s) => s.pages.some((p) => p.pane === pane))?.id;
}

/** The old Company section (`?section=workspace`, `?section=company`, go('workspace')) opens Operations. */
export const LEGACY_COMPANY_SECTION: CompanySection = 'operations';

/** Where a pane lives now: the Inbox for what waits on you (approvals, my
 *  tasks, pending changes), otherwise its company section. Every old pane
 *  id — links in #company, the brief, Home, setOrgPane callers — lands here. */
export function paneHome(pane: OrgPane): { section: 'inbox'; filter: InboxFilter } | { section: CompanySection; pane: OrgPane } {
  const filter = INBOX_PANES[pane];
  if (filter) return { section: 'inbox', filter };
  return { section: sectionOfPane(pane) ?? LEGACY_COMPANY_SECTION, pane };
}
