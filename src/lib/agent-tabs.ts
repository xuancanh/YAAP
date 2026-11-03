/** The agent page's tabs (docs/mission-control.md "The tabs"): seven, two of
 *  them with sub-sections, and every older tab name still lands somewhere,
 *  so `?tab=Trust`, `openAgent(id, 'Skills & tools')` and the like keep
 *  working. Pure. */

export const AGENT_TABS = ['Overview', 'Work', 'Work log', 'Chats', 'Artifacts', 'Memory', 'Settings'] as const;
export type AgentTab = (typeof AGENT_TABS)[number];

export const WORK_SECTIONS = ['Tasks', 'Schedule'] as const;
export type WorkSection = (typeof WORK_SECTIONS)[number];
export const SETTINGS_SECTIONS = ['General', 'Skills & tools', 'Mini apps', 'Trust'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export interface AgentTabTarget { tab: AgentTab; section: string | null }

/** Older names, and the parts of a sub-section people ask for by name. */
const OLD: Record<string, AgentTabTarget> = {
  dashboard: { tab: 'Overview', section: null },
  // the agent's own runs (docs/work-log.md)
  worklog: { tab: 'Work log', section: null },
  'work-log': { tab: 'Work log', section: null },
  runs: { tab: 'Work log', section: null },
  'heartbeat runs': { tab: 'Work log', section: null },
  tasks: { tab: 'Work', section: 'Tasks' },
  schedule: { tab: 'Work', section: 'Schedule' },
  loops: { tab: 'Work', section: 'Schedule' },
  files: { tab: 'Artifacts', section: null },
  'mini apps': { tab: 'Settings', section: 'Mini apps' },
  apps: { tab: 'Settings', section: 'Mini apps' },
  'skills & tools': { tab: 'Settings', section: 'Skills & tools' },
  skills: { tab: 'Settings', section: 'Skills & tools' },
  tools: { tab: 'Settings', section: 'Skills & tools' },
  trust: { tab: 'Settings', section: 'Trust' },
  general: { tab: 'Settings', section: 'General' },
  identity: { tab: 'Settings', section: 'General' },
  model: { tab: 'Settings', section: 'General' },
  heartbeat: { tab: 'Settings', section: 'General' },
};

const sectionsOf = (tab: AgentTab): readonly string[] => (tab === 'Work' ? WORK_SECTIONS : tab === 'Settings' ? SETTINGS_SECTIONS : []);

/**
 * Where a tab name lands: a current tab ('Work'), a current tab and section
 * ('Settings:Trust'), or an old name ('Trust', 'Dashboard', 'Files').
 * Case-insensitive; null for a name it does not know.
 */
export function resolveAgentTab(raw: string | null | undefined): AgentTabTarget | null {
  const name = (raw ?? '').trim();
  if (!name) return null;
  const [head, sub] = name.split(':').map((x) => x.trim());
  const tab = AGENT_TABS.find((t) => t.toLowerCase() === head.toLowerCase());
  if (tab) {
    const section = sub ? sectionsOf(tab).find((x) => x.toLowerCase() === sub.toLowerCase()) ?? null : null;
    if (section || !sub) return { tab, section };
    // 'Settings:Model' and the like: the part of a section asked for by name
    const inner = OLD[sub.toLowerCase()];
    return inner && inner.tab === tab ? inner : { tab, section: null };
  }
  return OLD[name.toLowerCase()] ?? null;
}
