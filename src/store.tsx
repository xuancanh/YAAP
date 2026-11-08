/**
 * App store — one context provider holding navigation, data caches, and the
 * live turn stream. Mirrors the interaction spec in design/YAAM Chat.dc.html.
 */
/* eslint-disable react-refresh/only-export-components */
import { FILE_EVENT, type FileEventDetail } from './lib/file-links';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  api, sendTurn, authHeaders, setActiveSharedWorkspace, subscribeWorkspaceEvents, watchSession,
  type Agent, type AgentApp, type AgentStats, type AgentType, type ChatMessage, type ChatRailGroup, type ChatSession, type ChatTurn,
  type MarketItem, type McpServer, type Skill, type Workspace, type FileEntry, type ApprovalDecision, type ToolReview,
  type BrowserStep, type WorkspaceOrg, type SharedWorkspace, type WorkspaceMe, type Channel, type WorkspaceEvent,
  type OrgIntentNode, type OrgCadence, type OrgHealth,
} from './lib/api';
import { isChannelSession } from './lib/channels';
import { dropFailedRound, isConnectionLost, reconnectDelay } from './lib/stream-recovery';
import type { InboxFilter } from './lib/inbox';
import { isCompanySection, paneHome, LEGACY_COMPANY_SECTION, type CompanySection } from './lib/company-nav';
import { resolveAgentTab } from './lib/agent-tabs';
import {
  agentTabSlug, companySlug, navOf, placeOf, readLocation, rememberCompanies, resolveCompany, routeHref, MEETING_EVENT,
  type FoundryPlace, type MeetingEventDetail, type Place, type Route,
} from './lib/routes';

/** A workspace in the picker: one of ours, or one shared with us (then
 *  `shared` names the owner and our role; docs/shared-agents.md). */
export type WorkspaceEntry = Workspace & { shared?: SharedWorkspace };
import type { PriceTable } from './lib/pricing';

/** 'overview' is Home, the owner's mission control (docs/home.md); 'agents'
 *  the full agent directory it links to; `inbox` everything waiting on the
 *  CEO (src/lib/inbox.ts). In organization mode the company is five sections
 *  of its own — direction, operations, people, money, oversight
 *  (src/lib/company-nav.ts). `workspace` is the old Company section: an
 *  alias kept for links, it opens Operations. */
export type Section = 'home' | 'overview' | 'agents' | 'inbox' | CompanySection | 'workspace' | 'artifacts' | 'apps' | 'market' | 'settings';
/** The organization pages (docs/group-chat.md §5: the workspace is the
 *  company). Each lives in exactly one company section, or in the Inbox. */
export type OrgPane = 'board' | 'goals' | 'chart' | 'approvals' | 'spend' | 'brief' | 'audit' | 'vision' | 'pulse' | 'meetings' | 'decisions' | 'plans' | 'replay' | 'capital' | 'mytasks'
  | 'incidents' | 'roadmap' | 'teams' | 'quality' | 'alignment';
export { ORG_PANES, ORG_PANES_IN_ARTIFACTS } from './lib/company-nav';
/** The section a section id opens: the legacy Company id opens Operations. */
export const resolveSection = (s: Section): Exclude<Section, 'workspace'> => (s === 'workspace' ? LEGACY_COMPANY_SECTION : s);
/** Something a pane should open or scroll to once loaded (a signal row's
 *  deep link, docs/company-vision.md §5): a task on the board, a goal on the
 *  vision page, a meeting thread, a plan, a replay day (the id is the
 *  YYYY-MM-DD); mission control opened on a filter (`mission`, the id a
 *  MissionOnly such as `error`, from the top bar's failing count). Consumed
 *  by the pane. */
export interface OrgFocus { kind: 'task' | 'goal' | 'meeting' | 'decision' | 'plan' | 'replay' | 'incident' | 'action' | 'project' | 'mission' | 'alignment'; id: string }
/** What the main pane shows while in the Home section: a conversation, a
 *  group-chat channel, an agent's home page (or the directory when no agent
 *  is selected), or a file preview — all reachable from the one combined
 *  rail, YAAM-style. */
export type HomeView = 'chat' | 'channel' | 'agent' | 'file';

export interface LiveTool {
  kind: 'tool';
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: 'running' | 'pending' | 'done' | 'denied' | 'error';
  result?: string;
  /** Set when the independent reviewer looked at this call. */
  review?: ToolReview;
  /** The approval belongs to another member (the owner of the connection in
   *  use): this client can only wait for them (docs/shared-agents.md §3). */
  routedTo?: { memberAccountId: string; name: string };
  /** The action contract (docs/actions-and-trust.md): the call's class, its
   *  action_log row and whether it waits for the owner's key. */
  actionClass?: string; actionId?: string; held?: 'held' | 'staged';
  /** Progress lines a long-running tool streamed (code_agent), newest last. */
  progress?: string[];
}
export type LiveItem =
  /** The message just sent, shown until the server has persisted it (the
   *  `turn` event) and the transcript reload carries it. */
  | { kind: 'user'; text: string }
  | { kind: 'thinking'; text: string; streaming: boolean }
  | { kind: 'answer'; text: string; streaming: boolean }
  | LiveTool;

export interface FileTarget { kind: 'workspace' | 'agent'; id: string }

/** One settled action on the paired computer (the `computer` TurnEvent),
 *  kept per session for the artifact panel's Computer tab. */
export interface ComputerStep {
  callId: string; tool: string; summary: string; status: 'ok' | 'error';
  screenshotPath?: string; width?: number; height?: number; at: string;
}
export interface ComputerFeed { sessionId: string; workspaceId: string; steps: ComputerStep[] }

/** What the artifact panel shows: generated HTML, an embedded mini app, or
 *  the live view of the paired computer. */
export interface ArtifactState { title: string; src: string; appCtx?: { agentId: string; miniApp: AgentApp } }

/** A message staged while a turn streams: drained afterwards for the session
 *  it was written in, with its attachments (FR: nothing is silently dropped). */
const EMPTY_LIVE: LiveItem[] = [];
/** A message waiting for its session's next turn. `waitServer`: the session
 *  is busy with a turn this tab did not start (a heartbeat, a task run —
 *  docs/work-log.md "Intervening"); it is sent when that turn ends. */
export interface QueuedMessage { id: number; sessionId: string; text: string; attachments: SentAttachment[]; waitServer?: boolean }
/** The attachment descriptor persisted on a turn (the server reads files by path). */
export interface SentAttachment { path: string; kind: string; transcript?: string | null; durationSeconds?: number | null }
/** A composer attachment chip. kind 'audio' = voice note (docs/voice.md): the
 *  transcript/duration are display-only — the server re-reads the sidecar. */
export interface ComposerAttachment { id: number; path: string; kind: string; transcript?: string | null; durationSeconds?: number | null }
const toSent = (a: ComposerAttachment): SentAttachment => ({
  path: a.path, kind: a.kind,
  ...(a.kind === 'audio' ? { transcript: a.transcript ?? null, durationSeconds: a.durationSeconds ?? null } : {}),
});

interface Store {
  // layout
  width: number; stacked: boolean; mediumDock: boolean;
  theme: string; toggleTheme: () => void;
  section: Section; go: (s: Section) => void;
  homeView: HomeView; setHomeView: (v: HomeView) => void;
  mobileChatOpen: boolean; setMobileChatOpen: (v: boolean) => void;
  mobileDetail: boolean; setMobileDetail: (v: boolean) => void;
  toast: string | null; showToast: (msg: string) => void;

  // data
  workspaces: WorkspaceEntry[]; workspaceId: string; pickWorkspace: (id: string) => void;
  refreshWorkspaces: () => Promise<void>;
  /** Who we are in the workspace on screen (role, actor id, display names);
   *  null while loading. `nameOf` turns an actor id into a name. */
  me: WorkspaceMe | null; refreshMe: () => Promise<void>; nameOf: (actorId: string | undefined | null) => string;
  agents: Agent[]; agentStats: Record<string, AgentStats>; refreshAgents: () => Promise<void>;
  unread: Record<string, number>;
  /** The chats loaded so far (docs/chat-archiving.md "The rail"): each
   *  agent's first page and the pages "Show more" fetched, and the open
   *  chat even when it is on no loaded page. Conversations only — the
   *  agents' work sessions are in `chatRail[].work.items`. */
  sessions: ChatSession[]; refreshSessions: () => Promise<void>;
  /** The rail's groups (per agent: count, loaded chats, next cursor, chats
   *  waiting on an approval, and the same for its work sessions). */
  chatRail: ChatRailGroup[];
  /** Load the next page of a rail group (key: agent id, '' = agent-less). */
  loadMoreChats: (groupKey: string) => Promise<void>;
  /** Load the next page of a rail group's work sessions. */
  loadMoreWork: (groupKey: string) => Promise<void>;
  archived: ChatSession[]; archivedTotal: number; archivedHasMore: boolean; loadMoreArchived: () => Promise<void>;
  archiveChat: (id: string) => Promise<void>; restoreChat: (id: string) => Promise<void>;
  agentTypes: AgentType[]; refreshAgentTypes: () => Promise<void>;
  skills: Skill[]; refreshSkills: () => Promise<void>;
  mcp: McpServer[]; setMcp: (v: McpServer[]) => void; refreshMcp: () => Promise<void>;
  market: MarketItem[]; refreshMarket: () => Promise<void>;
  settings: Record<string, string>; saveSettings: (patch: Record<string, string>) => Promise<void>;
  /** Merged model price table (USD per million tokens) for live meters. */
  pricing: PriceTable;

  // chat
  /** Open a session by id in the chat view, a chat or an agent's work
   *  session alike (docs/work-log.md); the Work log is openWorkLog. */
  currentId: string | null; openSession: (id: string) => void;
  /** The agent's Work log, optionally focused on a run or a work session. */
  openWorkLog: (agentId: string, focus?: { sessionId?: string; turnId?: string }) => void;
  workLogFocus: WorkLogFocus | null; clearWorkLogFocus: () => void;
  current: ChatSession | null;
  transcript: { messages: ChatMessage[]; turns: ChatTurn[] };
  refreshTranscript: () => Promise<void>;
  patchSession: (id: string, patch: Record<string, unknown>) => Promise<void>;
  newChat: (agentId?: string | null) => Promise<string>;
  streaming: boolean; live: LiveItem[];
  send: (text: string) => Promise<void>;
  stopTurn: () => void;
  approve: (callId: string, decision: ApprovalDecision) => void;
  queue: QueuedMessage[]; removeQueued: (id: number) => void;
  /** Every queued message, any session (the Work log shows its sessions'). */
  queueAll: QueuedMessage[];
  /** Message any session, from outside its chat view (the Work log): starts
   *  a turn (origin user), or queues for the next one when a turn runs there
   *  — this tab's (`streaming`) or the server's (`serverBusy`). */
  sendToSession: (sessionId: string, text: string, opts?: { serverBusy?: boolean }) => Promise<'started' | 'queued'>;
  /** Open a session in the chat view whatever its kind (the Work log's
   *  Continue in chat — the same as openSession now). */
  openInChat: (sessionId: string) => void;
  /** Whether this tab is running a turn in the session. */
  streamingIds: ReadonlySet<string>;
  drafts: Record<string, string>; setDraft: (v: string) => void;
  attachments: ComposerAttachment[];
  addAttachment: (path: string, kind?: string, extra?: Partial<Pick<ComposerAttachment, 'transcript' | 'durationSeconds'>>) => void;
  removeAttachment: (id: number) => void; clearAttachments: () => void;
  retry: () => Promise<void>; editResend: (turnId: string) => Promise<void>;
  fork: (turnId?: string) => Promise<void>; promote: (turnId: string) => Promise<void>;
  rate: (turnId: string, rating: 'up' | 'down') => Promise<void>;

  // files
  fileTarget: FileTarget | null; setFileTarget: (t: FileTarget) => void;
  fileList: FileEntry[]; refreshFiles: () => Promise<void>;
  currentFile: string | null; setCurrentFile: (p: string | null) => void;
  openFile: (target: FileTarget, path: string | null) => void;

  // agents section
  selectedAgent: string | null; setSelectedAgent: (id: string | null) => void;
  openAgent: (id: string, tab?: string) => void;
  /** One-shot tab request consumed by AgentHome (deep-link from chat). */
  agentTabRequest: string | null; setAgentTabRequest: (v: string | null) => void;
  newAgentOpen: boolean; setNewAgentOpen: (v: boolean) => void;
  embedApp: (agentId: string, miniApp: AgentApp) => Promise<void>;

  // artifact panel
  artifact: ArtifactState | null;
  openArtifact: (title: string, src: string) => void;
  closeArtifact: () => void;
  /** A workspace file shown in the side panel (a path clicked in chat, src/lib/file-links.ts). */
  sideFile: { workspaceId: string; path: string } | null;
  openSideFile: (path: string) => void;
  /** Browser tool steps for the current chat (persisted turns + the live
   *  turn), and whether the panel's Browser tab is showing them. */
  browserSteps: BrowserStep[];
  browserOpen: boolean;
  openBrowserPanel: () => void;
  /** The paired computer's feed for the current session, and whether the
   *  panel's Computer tab is showing it (docs/computer-control.md). */
  computer: ComputerFeed | null;
  computerOpen: boolean;
  openComputerPanel: () => void;
  /** chat.compose bridge op: open the agent's latest chat, prefill the box. */
  composeInChat: (agentId: string, text: string) => Promise<void>;

  // hire modal
  hireId: string | null; setHireId: (id: string | null) => void;
  confirmHire: () => Promise<void>;

  // organization mode of the current workspace (execution plan items 14 and 16)
  companiesEnabled: boolean;
  /** GET /api/workspaces/:id/org for the current workspace; null while loading or when companies are disabled. */
  wsOrg: WorkspaceOrg | null; refreshWsOrg: () => Promise<void>;
  /** The workspace's company state has not arrived yet (a cold load or a switch): show loading, not "organization mode is off". */
  wsOrgLoading: boolean;
  /** Which company page shows; null = the current section's dashboard. setOrgPane opens a page in its own section (or the Inbox). */
  orgPane: OrgPane | null; setOrgPane: (v: OrgPane | null) => void;
  /** The Settings pane, and a way to open one from anywhere (e.g. Oversight → Settings › Company). */
  settingsPane: string; setSettingsPane: (p: string) => void; openSettings: (pane: string) => void;
  /** The unit the Board / Goals panes are scoped to (docs/group-chat.md §7); null = the company. */
  orgUnitId: string | null; setOrgUnitId: (v: string | null) => void;
  /** The CEO's seat (docs/company-vision.md §8): the company intent tree and
   *  the ritual cadences, refreshed with wsOrg so the rail can badge units
   *  with at-risk goals and today's ritual without its own fetches. */
  orgIntent: OrgIntentNode[]; orgCadences: OrgCadence[];
  /** Plans awaiting the CEO's veto (docs/company-vision.md §8, item 23) — the rail count and the Pulse banner. */
  orgPendingPlans: number;
  /** Items 27–30 (SPA item 32): `GET …/org/health` (degraded providers and
   *  connections, frozen classes, open incidents), actions held or staged for
   *  the owner's key, and running experiments — fetched with wsOrg for the
   *  rail badges, the Pulse health strip and the chat header. */
  orgHealth: OrgHealth | null; orgHeldActions: number;
  /** My open org tasks and reviews (Inbox). */
  orgMyTasks: number;
  /** Things I follow whose latest change needs me (docs/follows.md): they count in the Inbox badge. */
  followAttention: number;
  /** Unread messages agents sent me with message_owner (docs/agent-messages.md): they count in the Inbox badge. */
  unreadMessages: number;
  /** Open one org task: Operations › Board with its drawer, at
   *  `/<company>/tasks/<key>` so back, forward and reload work. The board
   *  fetches the task when it is not on the loaded board. */
  openOrgTask: (taskId: string) => void;
  /** The task whose drawer the address names (`/<company>/tasks/<key>`); the
   *  board sets it when a drawer opens or closes (a history entry unless
   *  `replace`), and closes its drawer when Back clears it. */
  routeTask: string | null; setRouteTask: (key: string | null, opts?: { replace?: boolean }) => void;
  /** The same for a project page on the Roadmap (`/<company>/projects/<key>`). */
  routeProject: string | null; setRouteProject: (key: string | null, opts?: { replace?: boolean }) => void;
  /** The agent page's tab in the address (`/<company>/agents/<id>/<tab>`); AgentHome reports it. */
  setAgentTab: (slug: string | null) => void;
  /** The full-screen meeting room on screen (`/<company>/meetings/<id>`),
   *  over whatever was open; src/lib/meetings.ts opens and closes it. */
  meetingId: string | null;
  inboxFilter: InboxFilter; setInboxFilter: (f: InboxFilter) => void;
  /** The Inbox row open in the reading pane (`/<company>/inbox/<filter>/<item>`);
   *  a history entry unless `replace` (moving with j/k replaces). Changing the
   *  filter closes it. */
  inboxItem: string | null; setInboxItem: (id: string | null, opts?: { replace?: boolean }) => void;
  orgFocus: OrgFocus | null; setOrgFocus: (v: OrgFocus | null) => void;

  // group chat (docs/group-chat.md, execution plan item 15)
  channels: Channel[]; refreshChannels: () => Promise<void>;
  /** The open channel's slug while homeView is 'channel'. */
  currentChannel: string | null;
  /** A message a deep link asked to scroll to; consumed by the view. */
  channelFocus: string | null; setChannelFocus: (id: string | null) => void;
  /** `replace`: a canonical rewrite (an old slug of a renamed channel), not a history entry. */
  openChannel: (slug: string, messageId?: string | null, opts?: { replace?: boolean }) => void;
  /** Live workspace events (SSE): channel messages, typing, streams, tasks. */
  onWorkspaceEvent: (listener: (ev: WorkspaceEvent) => void) => () => void;
}

const Ctx = createContext<Store | null>(null);
export const useApp = (): Store => {
  const s = useContext(Ctx);
  if (!s) throw new Error('useApp outside provider');
  return s;
};

export const grad = (colorsJson: string): string => {
  try {
    const [a, b] = JSON.parse(colorsJson) as [string, string];
    return `linear-gradient(140deg,${a},${b})`;
  } catch {
    return 'linear-gradient(135deg,var(--accent),var(--blue))';
  }
};

export const gradPair = (pair: [string, string]): string => `linear-gradient(140deg,${pair[0]},${pair[1]})`;

/** A session usable as the open chat of workspace `ws`: its own, not
 *  archived — a conversation or an agent's work session (docs/work-log.md),
 *  never a legacy channel session still classed as a chat. */
function openableIn(s: ChatSession | null | undefined, ws: string | null | undefined): boolean {
  return !!s && s.workspaceId === ws && !s.archivedAt && (s.kind === 'work' || !isChannelSession(s));
}
/** An agent tab name (any it has had) as its address segment; the default tab has none. */
function resolvedTabSlug(name: string): string | null {
  const t = resolveAgentTab(name)?.tab;
  return t && t !== 'Overview' ? agentTabSlug(t) : null;
}

/** The company opened last in this browser: `/` lands there. */
const LAST_COMPANY_KEY = 'yaam-last-company';
function readLastCompany(): string | null {
  try { return localStorage.getItem(LAST_COMPANY_KEY); } catch { return null; }
}

/** `#/chat/<id>` and its alias `#/chat/<id>/chat` open the session in the
 *  chat view, whatever its kind; `#/chat/<id>/log` opens a work session's
 *  timeline in the agent's Work log (its id joins `asLog`). */
export function parseChatLink(hash: string, asLog?: Set<string>): string | null {
  const m = /^#\/chat\/([\w-]+)(\/chat|\/log)?$/.exec(hash);
  if (!m) return null;
  if (m[2] === '/log') asLog?.add(m[1]);
  return m[1];
}

/** What the Work log should open (docs/work-log.md): a run, or a work
 *  session's newest run. `at` makes a repeat request a new one. */
export interface WorkLogFocus { agentId: string; sessionId?: string; turnId?: string; at: number }

export function AppProvider({ children }: { children: ReactNode }) {
  const [width, setWidth] = useState(window.innerWidth);
  const [theme, setTheme] = useState(localStorage.getItem('yaam-theme') || 'dark');
  // The address names the company and the place (src/lib/routes.ts,
  // docs/routes.md); every older link form (?section=, ?org=, #/ws/…,
  // #/chat/…) reads as a route too. The first render shows the place; the
  // company resolves once the workspace list loads, and the address is
  // rewritten to its canonical path then.
  const [boot] = useState(() => {
    const route = readLocation(window.location);
    const nav = navOf(route?.place ?? { kind: 'home' });
    return { route, nav };
  });
  const [section, setSection] = useState<Section>(boot.nav.section ?? 'overview'); // Home is the landing page
  const [homeView, setHomeView] = useState<HomeView>(boot.nav.homeView ?? 'chat');
  const [mobileChatOpen, setMobileChatOpen] = useState(boot.nav.mobileChatOpen ?? false);
  const [mobileDetail, setMobileDetail] = useState(boot.nav.mobileDetail ?? false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  const [workspaceId, setWorkspaceId] = useState('');
  const [me, setMe] = useState<WorkspaceMe | null>(null);
  /** Ids of workspaces shared with us, for the request header. */
  const sharedIds = useRef<Set<string>>(new Set());
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentStats, setAgentStats] = useState<Record<string, AgentStats>>({});
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [chatRail, setChatRail] = useState<ChatRailGroup[]>([]);
  /** Chats outside the loaded pages that are open (or deep-linked). */
  const [extraSessions, setExtraSessions] = useState<ChatSession[]>([]);
  const extraRef = useRef<ChatSession[]>([]);
  extraRef.current = extraSessions;
  /** How many chats / work sessions each rail group shows, kept across refreshes. */
  const railLimits = useRef<Record<string, number>>({});
  const workLimits = useRef<Record<string, number>>({});
  /** Ids looked up by id (an open chat on no loaded page): pending or done. */
  const probed = useRef(new Map<string, 'pending' | 'missing' | 'found'>());
  const [probeTick, setProbeTick] = useState(0);
  /** The workspace whose rail has loaded (a linked chat is looked up only then). */
  const railFor = useRef<string | null>(null);
  /** Every openable session loaded: the rail's chats and work sessions and
   *  the open ones beyond the loaded pages. */
  const allSessions = useMemo(() => {
    const seen = new Set<string>();
    const out: ChatSession[] = [];
    for (const g of chatRail) for (const s of g.items) if (!seen.has(s.id) && s.kind !== 'work' && !isChannelSession(s)) { seen.add(s.id); out.push(s); }
    for (const g of chatRail) for (const s of g.work?.items ?? []) if (!seen.has(s.id)) { seen.add(s.id); out.push(s); }
    for (const s of extraSessions) if (!seen.has(s.id)) { seen.add(s.id); out.push(s); }
    return out;
  }, [chatRail, extraSessions]);
  /** The conversations among them (`sessions` in the context). */
  const sessions = useMemo(() => allSessions.filter((s) => s.kind !== 'work'), [allSessions]);
  const sessionsRef = useRef<ChatSession[]>([]);
  sessionsRef.current = allSessions;
  const [archived, setArchived] = useState<ChatSession[]>([]);
  const [archivedTotal, setArchivedTotal] = useState(0);
  const [archivedCursor, setArchivedCursor] = useState<string | null>(null);
  const [agentTypes, setAgentTypes] = useState<AgentType[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [mcp, setMcp] = useState<McpServer[]>([]);
  const [market, setMarket] = useState<MarketItem[]>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [pricing, setPricing] = useState<PriceTable>({});

  const [currentId, setCurrentId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<{ messages: ChatMessage[]; turns: ChatTurn[] }>({ messages: [], turns: [] });
  // Turns run per chat: a reply keeps streaming while you look at another
  // chat, and its live rows are there when you come back.
  const [streamingIds, setStreamingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [liveBy, setLiveBy] = useState<Record<string, LiveItem[]>>({});
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);

  const [fileTarget, setFileTarget] = useState<FileTarget | null>(boot.nav.fileTarget && boot.nav.fileTarget !== 'workspace' ? boot.nav.fileTarget : null);
  const [fileList, setFileList] = useState<FileEntry[]>([]);
  const [currentFile, setCurrentFile] = useState<string | null>(boot.nav.currentFile ?? null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(boot.nav.selectedAgent ?? null);
  const [agentTabRequest, setAgentTabRequest] = useState<string | null>(boot.nav.agentTabRequest ?? null);
  const [agentTab, setAgentTabRaw] = useState<string | null>(boot.nav.agentTab ?? null);
  const [workLogFocus, setWorkLogFocus] = useState<WorkLogFocus | null>(null);
  const openWorkLogRef = useRef<(agentId: string, focus?: { sessionId?: string; turnId?: string }) => void>(() => undefined);
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [artifact, setArtifact] = useState<{ title: string; src: string; appCtx?: { agentId: string; miniApp: AgentApp } } | null>(null);
  const [liveBrowserSteps, setLiveBrowserSteps] = useState<BrowserStep[]>([]);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [computer, setComputer] = useState<ComputerFeed | null>(null);
  const [computerOpen, setComputerOpen] = useState(false);
  const [hireId, setHireId] = useState<string | null>(null);
  const [companiesEnabled, setCompaniesEnabled] = useState(false);
  const [orgsKnown, setOrgsKnown] = useState(false);
  const [wsOrg, setWsOrg] = useState<WorkspaceOrg | null>(null);
  const [wsOrgFor, setWsOrgFor] = useState<string | null>(null);
  const wsOrgLoading = !orgsKnown || (companiesEnabled && !!workspaceId && wsOrgFor !== workspaceId);
  const [orgPane, setOrgPaneRaw] = useState<OrgPane | null>(boot.nav.orgPane ?? null);
  const [inboxFilter, setInboxFilterRaw] = useState<InboxFilter>(boot.nav.inboxFilter ?? 'all');
  const [inboxItem, setInboxItemRaw] = useState<string | null>(boot.nav.inboxItem ?? null);
  const setInboxFilter = useCallback((f: InboxFilter) => { setInboxFilterRaw(f); setInboxItemRaw(null); }, []);
  const [routeTask, setRouteTaskRaw] = useState<string | null>(boot.nav.routeTask ?? null);
  const [routeProject, setRouteProjectRaw] = useState<string | null>(boot.nav.routeProject ?? null);
  const [meetingId, setMeetingId] = useState<string | null>(boot.nav.meetingId ?? null);
  const [foundry, setFoundry] = useState<FoundryPlace>(boot.nav.foundry ?? {});

  // ---- the address (src/lib/routes.ts) ----
  // A navigation (opening a chat, a channel, a pane, another company…) is a
  // history entry; anything else that changes the address — a filter, a
  // canonical rewrite, the first chat picked for you — replaces it. Each
  // navigation action marks itself with markPush before its state changes;
  // the effect that writes the address consumes the mark. `navSeq` makes it
  // run even when the place did not change (so a mark never outlives it).
  const navMode = useRef<'push' | null>(null);
  const [navSeq, setNavSeq] = useState(0);
  const markPush = useCallback(() => {
    navMode.current = 'push';
    setNavSeq((n) => n + 1);
    setMeetingId(null); // going anywhere leaves the full-screen room
  }, []);

  /** Open a pane where it lives now (src/lib/company-nav.ts): approvals, my
   *  tasks and pending changes in the Inbox, every other page in its company
   *  section (null = the current section's dashboard). */
  const setOrgPane = useCallback((v: OrgPane | null) => {
    markPush();
    setRouteTaskRaw(null);
    setRouteProjectRaw(null);
    if (v === null) { setOrgPaneRaw(null); return; }
    const home = paneHome(v);
    if (home.section === 'inbox') { setSection('inbox'); setInboxFilterRaw(home.filter); setInboxItemRaw(null); return; }
    setSection(home.section);
    setOrgPaneRaw(home.pane);
  }, [markPush]);
  /** The Settings pane shown (`/<company>/settings/<pane>`); openSettings goes there. */
  const [settingsPane, setSettingsPaneRaw] = useState(boot.nav.settingsPane ?? 'providers');
  const [orgMyTasks, setOrgMyTasks] = useState(0);
  const [followAttention, setFollowAttention] = useState(0);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [orgUnitId, setOrgUnitId] = useState<string | null>(null);
  const [orgIntent, setOrgIntent] = useState<OrgIntentNode[]>([]);
  const [orgCadences, setOrgCadences] = useState<OrgCadence[]>([]);
  const [orgPendingPlans, setOrgPendingPlans] = useState(0);
  const [orgHealth, setOrgHealth] = useState<OrgHealth | null>(null);
  const [orgHeldActions, setOrgHeldActions] = useState(0);
  const [orgFocus, setOrgFocus] = useState<OrgFocus | null>(boot.nav.orgFocus ?? null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [currentChannel, setCurrentChannel] = useState<string | null>(boot.nav.currentChannel ?? null);
  const [channelFocus, setChannelFocus] = useState<string | null>(boot.nav.channelFocus ?? null);
  const wsListeners = useRef(new Set<(ev: WorkspaceEvent) => void>());

  const currentIdRef = useRef<string | null>(null);
  currentIdRef.current = currentId;
  const queueRef = useRef(queue);
  queueRef.current = queue;
  /** Sessions this tab is running a turn in, updated synchronously (state lags). */
  const activeRuns = useRef(new Set<string>());
  /** Work sessions linked as `…/chats/<id>/log`: they open in the Work log. */
  const asLog = useRef(new Set<string>(boot.route?.place.kind === 'session' && boot.route.place.log ? [boot.route.place.id] : []));
  // per-session fetch abort; the rAF-buffered stream text lives in each runTurn
  const abortBy = useRef(new Map<string, AbortController>());
  const streaming = currentId ? streamingIds.has(currentId) : false;
  const live = useMemo(() => (currentId ? liveBy[currentId] ?? EMPTY_LIVE : EMPTY_LIVE), [liveBy, currentId]);
  const sessionQueue = useMemo(() => queue.filter((q) => q.sessionId === currentId), [queue, currentId]);
  const setLiveFor = useCallback((id: string, fn: (items: LiveItem[]) => LiveItem[]) => {
    setLiveBy((m) => ({ ...m, [id]: fn(m[id] ?? EMPTY_LIVE) }));
  }, []);
  const clearLiveFor = useCallback((id: string) => {
    setLiveBy((m) => { if (!(id in m)) return m; const next = { ...m }; delete next[id]; return next; });
  }, []);

  const stacked = width < 820;
  const mediumDock = !stacked && width < 1120;

  // A session in the address (`/<company>/chats/<id>`, `#/chat/<id>`): the
  // session list may not have loaded yet, so the id waits in a ref and the
  // session-pick effect below honours it once the list contains it (or a
  // lookup finds it). A work session opens in the chat view like a chat;
  // `…/chats/<id>/log` opens its timeline in the Work log instead
  // (docs/work-log.md). While it waits the address is left alone.
  const deepLink = useRef<string | null>(boot.route?.place.kind === 'session' ? boot.route.place.id : null);
  /** The route waiting for the workspace list (the first load). */
  const pendingRoute = useRef<Route | null>(boot.route);
  const [routeReady, setRouteReady] = useState(false);
  const routeReadyRef = useRef(routeReady);
  routeReadyRef.current = routeReady;

  // proactive-work badges: poll unread activity counts (phase 2)
  useEffect(() => {
    const t = setInterval(() => { api.unreadAgentEvents().then(setUnread).catch(() => {}); }, 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2400);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((t) => {
      const next = t === 'dark' ? 'light' : 'dark';
      localStorage.setItem('yaam-theme', next);
      return next;
    });
  }, []);

  // ---- data loading ----
  const refreshWorkspaces = useCallback(async () => {
    const own = await api.workspaces();
    // Workspaces shared with us (docs/shared-agents.md): listed after our
    // own, under the owner's name. Their rows live in the owner's account.
    const shared = await api.sharedWorkspaces().catch((): SharedWorkspace[] => []);
    sharedIds.current = new Set(shared.map((w) => w.id));
    const all: WorkspaceEntry[] = [
      ...own,
      ...shared.filter((w) => !own.some((o) => o.id === w.id)).map((w) => ({
        id: w.id, name: w.name, color: w.color, memory: '', profile: '', profilePending: '[]', quietHours: '', spendBudgetTokens: 0, spendMonth: '', spendTokens: 0, orgMode: 'off' as const, chiefOfStaffAgentId: null, orgMonthlyUsd: 0, orgAgentCap: 12, createdAt: '', shared: w,
      })),
    ];
    rememberCompanies(all);
    setWorkspaces(all);
    // The first load opens the company the address names (an invitation
    // link included); else the one open, the last one used, or the first.
    const wanted = pendingRoute.current ? resolveCompany(pendingRoute.current.company, all)?.id : undefined;
    const last = readLastCompany();
    setWorkspaceId((cur) => {
      const has = (id: string | null | undefined): id is string => Boolean(id) && all.some((w) => w.id === id);
      const next = has(wanted) ? wanted : has(cur) ? cur : has(last) ? last : (all[0]?.id ?? '');
      setActiveSharedWorkspace(sharedIds.current.has(next) ? next : null);
      return next;
    });
  }, []);

  const refreshMe = useCallback(async () => {
    if (!workspaceId) { setMe(null); return; }
    setMe(await api.workspaceMe(workspaceId).catch(() => null));
  }, [workspaceId]);
  const nameOf = useCallback((actor: string | undefined | null): string => {
    if (!me) return actor ? actor.slice(0, 8) : 'Owner';
    const id = actor || me.ownerAccountId;
    return me.names[id] ?? (id === me.ownerAccountId ? 'Owner' : id.slice(0, 8));
  }, [me]);

  // Agents belong to one workspace (docs/shared-agents.md "Workspace
  // ownership"): the list is the selected workspace's and reloads on switch.
  const refreshAgents = useCallback(async () => {
    if (!workspaceId) { setAgents([]); setAgentStats({}); return; }
    const list = await api.agents(workspaceId);
    setAgents(list);
    const stats: Record<string, AgentStats> = {};
    await Promise.all(list.map(async (a) => {
      stats[a.id] = await api.agentStats(a.id).catch(() => ({ chats: 0, up: 0, down: 0, rating: null, tokensIn: 0, tokensOut: 0 }));
    }));
    setAgentStats(stats);
    setUnread(await api.unreadAgentEvents().catch(() => ({})));
  }, [workspaceId]);

  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;

  const refreshSessions = useCallback(async () => {
    if (!workspaceId) return;
    // The rail is paged (docs/chat-archiving.md "The rail"): each agent's
    // first page, or as many as "Show more" loaded — chats and work
    // sessions alike, each paged on its own (docs/work-log.md).
    const rail = await api.chatRail(workspaceId, { limits: railLimits.current, workLimits: workLimits.current });
    // Open sessions beyond the loaded pages are re-read so they stay current.
    const inRail = new Set(rail.groups.flatMap((g) => [...g.items, ...(g.work?.items ?? [])].map((s) => s.id)));
    const extras = (await Promise.all(extraRef.current.filter((s) => !inRail.has(s.id)).map((s) => api.chat(s.id).catch(() => null)))).filter((s): s is ChatSession => openableIn(s, workspaceId));
    for (const s of extraRef.current) if (!extras.some((x) => x.id === s.id) && !inRail.has(s.id)) probed.current.set(s.id, 'missing');
    railFor.current = workspaceId;
    setChatRail(rail.groups);
    setExtraSessions(extras);
    setArchivedTotal(rail.archivedTotal);
    const arch = await api.chatPage(workspaceId, { archived: true, limit: 20 }).catch(() => ({ items: [] as ChatSession[], nextCursor: null }));
    setArchived(arch.items);
    setArchivedCursor(arch.nextCursor);
  }, [workspaceId]);

  const loadMoreChats = useCallback(async (groupKey: string) => {
    if (!workspaceId) return;
    const g = chatRail.find((x) => (x.agentId ?? '') === groupKey);
    if (!g?.nextCursor) return;
    const page = await api.chatPage(workspaceId, { agentId: g.agentId, limit: 20, cursor: g.nextCursor });
    setChatRail((rail) => rail.map((x) => {
      if ((x.agentId ?? '') !== groupKey) return x;
      const seen = new Set(x.items.map((s) => s.id));
      const items = [...x.items, ...page.items.filter((s) => !seen.has(s.id))];
      railLimits.current = { ...railLimits.current, [groupKey]: items.length };
      return { ...x, items, nextCursor: page.nextCursor };
    }));
  }, [workspaceId, chatRail]);

  // The rail's work rows follow the agents' runs (a heartbeat starting, a
  // run finishing, a new task run): re-read it each minute, like the badges.
  useEffect(() => {
    const t = setInterval(() => { void refreshSessions().catch(() => {}); }, 60_000);
    return () => clearInterval(t);
  }, [refreshSessions]);

  const loadMoreWork = useCallback(async (groupKey: string) => {
    if (!workspaceId) return;
    const g = chatRail.find((x) => (x.agentId ?? '') === groupKey);
    if (!g?.work?.nextCursor) return;
    const page = await api.chatPage(workspaceId, { agentId: g.agentId, kind: 'work', limit: 20, cursor: g.work.nextCursor });
    setChatRail((rail) => rail.map((x) => {
      if ((x.agentId ?? '') !== groupKey) return x;
      const have = x.work.items ?? [];
      const seen = new Set(have.map((s) => s.id));
      const items = [...have, ...page.items.filter((s) => !seen.has(s.id))];
      workLimits.current = { ...workLimits.current, [groupKey]: items.length };
      return { ...x, work: { ...x.work, items, nextCursor: page.nextCursor } };
    }));
  }, [workspaceId, chatRail]);

  const loadMoreArchived = useCallback(async () => {
    if (!workspaceId || !archivedCursor) return;
    const page = await api.chatPage(workspaceId, { archived: true, limit: 20, cursor: archivedCursor });
    setArchived((list) => [...list, ...page.items.filter((s) => !list.some((x) => x.id === s.id))]);
    setArchivedCursor(page.nextCursor);
  }, [workspaceId, archivedCursor]);

  const refreshAgentTypes = useCallback(async () => setAgentTypes(await api.agentTypes()), []);
  const refreshSkills = useCallback(async () => setSkills(await api.skills(workspaceId || undefined)), [workspaceId]);
  const refreshMcp = useCallback(async () => setMcp(await api.mcp()), []);
  const refreshMarket = useCallback(async () => setMarket(await api.market(workspaceId || undefined)), [workspaceId]);
  const refreshWsOrg = useCallback(async () => {
    if (!workspaceId || !companiesEnabled) { setWsOrg(null); setOrgIntent([]); setOrgCadences([]); setOrgPendingPlans(0); setOrgHealth(null); setOrgHeldActions(0); setOrgMyTasks(0); setFollowAttention(0); setUnreadMessages(0); return; }
    const st = await api.workspaceOrg(workspaceId).catch((): WorkspaceOrg | null => null);
    setWsOrg(st);
    setWsOrgFor(workspaceId);
    // The intent tree and the cadences ride along for the rail (at-risk
    // counts, today's ritual); the workspace event bus carries no org events
    // yet, so the panes poll lightly while on screen and call this on writes.
    if (st && st.mode !== 'off' && st.orgId) {
      const [intent, cadences, plans, health, held, staged, mine, follows] = await Promise.all([
        api.orgIntent(workspaceId).catch((): OrgIntentNode[] => []), api.orgCadences(workspaceId).catch((): OrgCadence[] => []), api.orgPlans(workspaceId, 'pending').catch((): unknown[] => []),
        api.orgHealth(workspaceId).catch((): OrgHealth | null => null),
        api.workspaceActions(workspaceId, { status: 'held', limit: 200 }).catch((): unknown[] => []), api.workspaceActions(workspaceId, { status: 'staged', limit: 200 }).catch((): unknown[] => []),
        api.orgMyTasks(workspaceId).catch(() => null),
        api.followsMine(workspaceId).catch(() => []),
      ]);
      setUnreadMessages((await api.inboxMessages(workspaceId).catch(() => ({ unread: 0 }))).unread);
      // Followed changes count in the badge only when they need me.
      setFollowAttention(follows.filter((f) => f.attentionAt && !f.mutedAt).length);
      setOrgIntent(intent); setOrgCadences(cadences); setOrgPendingPlans(plans.length);
      setOrgHealth(health); setOrgHeldActions(held.length + staged.length);
      setOrgMyTasks(mine ? [...mine.assigned, ...mine.reviewing].filter((t) => t.status !== 'done' && t.status !== 'cancelled').length : 0);
    } else { setOrgIntent([]); setOrgCadences([]); setOrgPendingPlans(0); setOrgHealth(null); setOrgHeldActions(0); setOrgMyTasks(0); setFollowAttention(0); setUnreadMessages(0); }
  }, [workspaceId, companiesEnabled]);
  useEffect(() => {
    api.orgsStatus().then((s) => setCompaniesEnabled(s.enabled)).catch(() => setCompaniesEnabled(false)).finally(() => setOrgsKnown(true));
  }, []);
  useEffect(() => { void refreshWsOrg(); }, [refreshWsOrg]);
  // The organization panes exist only while the mode is on; fall back to the files.
  useEffect(() => {
    if (wsOrg && wsOrg.mode === 'off' && orgPane) setOrgPaneRaw(null);
  }, [wsOrg, orgPane]);
  // A unit filter outlives its unit only until the next refresh.
  useEffect(() => {
    if (!orgUnitId || !wsOrg) return;
    const has = (nodes: { id: string; children: { id: string; children: unknown[] }[] }[]): boolean => nodes.some((n) => n.id === orgUnitId || has(n.children as never));
    if (!has(wsOrg.units ?? [])) setOrgUnitId(null);
  }, [wsOrg, orgUnitId]);
  useEffect(() => { setOrgUnitId(null); }, [workspaceId]);

  // ---- group chat (docs/group-chat.md) ----
  const refreshChannels = useCallback(async () => {
    if (!workspaceId) { setChannels([]); return; }
    // a failed read (the server restarting) keeps the rail rather than emptying it
    const list = await api.channels(workspaceId).catch((): Channel[] | null => null);
    if (list) setChannels(list);
  }, [workspaceId]);
  useEffect(() => { void refreshChannels(); }, [refreshChannels]);

  const openChannel = useCallback((slug: string, messageId?: string | null, opts?: { replace?: boolean }) => {
    if (!opts?.replace) markPush();
    setCurrentChannel(slug);
    setChannelFocus(messageId ?? null);
    setSection('home');
    setHomeView('channel');
    setMobileChatOpen(true);
    setArtifact(null);
    setBrowserOpen(false);
  }, [markPush]);

  const onWorkspaceEvent = useCallback((listener: (ev: WorkspaceEvent) => void) => {
    wsListeners.current.add(listener);
    return () => { wsListeners.current.delete(listener); };
  }, []);

  /** After the event stream reconnects (a server restart): re-read what may
   *  have changed while it was down. Assigned below, once the readers exist. */
  const resyncRef = useRef<() => void>(() => {});

  // One SSE connection per workspace on screen, reconnecting with backoff;
  // unread badges follow every channel message without polling.
  useEffect(() => {
    if (!workspaceId) return;
    const ctrl = new AbortController();
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    // A server restart drops the stream: reconnect quickly and quietly
    // (docs/architecture.md "Restarts and recovery"), then re-read what may
    // have changed while it was down — no error, no stale "is working…".
    let attempt = 0;
    let dropped = false;
    const run = async () => {
      while (!ctrl.signal.aborted) {
        try {
          await subscribeWorkspaceEvents(workspaceId, (ev) => {
            attempt = 0;
            if (dropped) { dropped = false; resyncRef.current(); }
            for (const l of wsListeners.current) { try { l(ev); } catch { /* a listener must not break the stream */ } }
            if (ev.type === 'channel_message' || ev.type === 'channel_update') {
              clearTimeout(refreshTimer);
              refreshTimer = setTimeout(() => { void api.channels(workspaceId).then(setChannels).catch(() => {}); }, 400);
            }
          }, ctrl.signal);
        } catch { /* reconnect below */ }
        if (ctrl.signal.aborted) break;
        dropped = true;
        await new Promise((r) => setTimeout(r, reconnectDelay(attempt++)));
      }
    };
    void run();
    return () => { ctrl.abort(); clearTimeout(refreshTimer); };
  }, [workspaceId]);

  useEffect(() => { void refreshWorkspaces().catch(() => showToast('API offline')); }, [refreshWorkspaces, showToast]);
  useEffect(() => { void refreshAgents().catch(() => {}); void refreshAgentTypes().catch(() => {}); void refreshMcp().catch(() => {}); void refreshMarket().catch(() => {}); api.settings().then(setSettings).catch(() => {}); }, [refreshAgents, refreshAgentTypes, refreshMcp, refreshMarket]);
  useEffect(() => { void refreshSessions().catch(() => {}); void refreshSkills().catch(() => {}); void refreshMe(); }, [refreshSessions, refreshSkills, refreshMe]);

  /** Look a chat up by id when it is on no loaded page (the rail is paged):
   *  an openable one joins `sessions`; the pick effect re-runs either way. */
  const probe = useCallback((id: string) => {
    if (probed.current.has(id)) return;
    probed.current.set(id, 'pending');
    void api.chat(id).then((s) => {
      // #/chat/<id>/log: a work session's timeline, in the agent's Work log
      // (docs/work-log.md), not the open chat.
      if (s.kind === 'work' && s.agentId && deepLink.current === id && asLog.current.has(id)) {
        deepLink.current = null;
        asLog.current.delete(id);
        openWorkLogRef.current(s.agentId, { sessionId: s.id });
        navMode.current = null; // following a link replaces it
      }
      if (openableIn(s, workspaceIdRef.current)) { probed.current.set(id, 'found'); setExtraSessions((x) => (x.some((y) => y.id === s.id) ? x : [...x, s])); } else probed.current.set(id, 'missing');
    }).catch(() => { probed.current.set(id, 'missing'); }).finally(() => setProbeTick((n) => n + 1));
  }, []);

  // pick a session when the workspace changes / sessions load
  useEffect(() => {
    const wanted = deepLink.current;
    const linked = wanted ? allSessions.find((s) => s.id === wanted) : undefined;
    if (wanted && linked) {
      deepLink.current = null;
      if (asLog.current.delete(wanted) && linked.kind === 'work' && linked.agentId) { openWorkLogRef.current(linked.agentId, { sessionId: wanted }); navMode.current = null; return; }
      setCurrentId(wanted);
      setSection('home');
      setHomeView('chat');
      setMobileChatOpen(true);
      setNavSeq((n) => n + 1); // the address follows even when nothing else changed
      return;
    }
    // Once this workspace's rail has loaded, a link to a chat on no loaded
    // page is looked up; one that is not here (or not ours) is let go.
    if (wanted && railFor.current === workspaceIdRef.current && !probed.current.has(wanted)) probe(wanted);
    if (wanted && probed.current.get(wanted) === 'missing') {
      deepLink.current = null;
      asLog.current.delete(wanted);
      showToast('That chat is not in this company');
      setNavSeq((n) => n + 1);
    }
    const cur = currentIdRef.current;
    // the first chat of the workspace on screen (the list may still be the last workspace's)
    const firstHere = sessions.find((s) => s.workspaceId === workspaceIdRef.current)?.id ?? null;
    if (!cur) { if (firstHere) setCurrentId(firstHere); return; }
    if (allSessions.some((s) => s.id === cur)) return;
    // the open session is on no loaded page: look it up before giving up on it
    const state = probed.current.get(cur);
    if (state === undefined || state === 'found') { probed.current.delete(cur); probe(cur); return; }
    if (state === 'missing') { probed.current.delete(cur); setCurrentId(firstHere); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allSessions, probeTick, currentId]);

  const current = useMemo(() => allSessions.find((s) => s.id === currentId) ?? null, [allSessions, currentId]);

  const refreshTranscript = useCallback(async () => {
    const id = currentIdRef.current;
    if (!id) { setTranscript({ messages: [], turns: [] }); return; }
    // A failed read (the server restarting) keeps what is on screen rather
    // than blanking the chat; reads retry through a restart first.
    const t = await api.transcript(id).catch(() => null);
    if (t && currentIdRef.current === id) setTranscript(t);
  }, []);

  resyncRef.current = () => {
    void refreshSessions().catch(() => {});
    void refreshChannels().catch(() => {});
    void refreshAgents().catch(() => {});
    void refreshTranscript();
  };

  useEffect(() => {
    // switching chats never stops a reply: the old turn keeps streaming into
    // its own live rows (liveBy), and this chat's transcript loads.
    void refreshTranscript();
    // hydrate the draft from the server copy once per session switch (FR-2.1)
    if (current && drafts[current.id] === undefined && current.draft) {
      setDrafts((d) => ({ ...d, [current.id]: current.draft }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  const patchSession = useCallback(async (id: string, patch: Record<string, unknown>) => {
    const updated = await api.updateChat(id, patch);
    setChatRail((rail) => rail.map((g) => ({
      ...g, items: g.items.map((s) => (s.id === id ? updated : s)),
      work: g.work.items ? { ...g.work, items: g.work.items.map((s) => (s.id === id ? updated : s)) } : g.work,
    })));
    setExtraSessions((list) => list.map((s) => (s.id === id ? updated : s)));
  }, []);

  /** The chat view on a chat (the old openSession). */
  const showChat = useCallback((id: string) => {
    markPush();
    setCurrentId(id);
    setSection('home');
    setHomeView('chat');
    setMobileChatOpen(true);
    setArtifact(null);
    setBrowserOpen(false);
  }, [markPush]);

  const openAgent = useCallback((id: string, tab?: string) => {
    markPush();
    setSection('home');
    setHomeView('agent');
    setSelectedAgent(id);
    if (tab) setAgentTabRequest(tab);
    // the tab in the address until the page reports the one it shows
    setAgentTabRaw(tab ? resolvedTabSlug(tab) : null);
    setMobileChatOpen(true); // stacked: the agent page is the detail pane
    setArtifact(null);
    setBrowserOpen(false);
    // opening the home page acknowledges the agent's proactive activity
    void api.markAgentEventsRead(id)
      .then(() => setUnread((u) => ({ ...u, [id]: 0 })))
      .catch(() => {});
  }, [markPush]);

  const openWorkLog = useCallback((agentId: string, focus: { sessionId?: string; turnId?: string } = {}) => {
    setWorkLogFocus({ agentId, ...focus, at: Date.now() });
    openAgent(agentId, 'Work log');
  }, [openAgent]);
  openWorkLogRef.current = openWorkLog;
  const clearWorkLogFocus = useCallback(() => setWorkLogFocus(null), []);

  /** Every "open this session" link (the rail, inbox, mission control, the
   *  agent dashboard, usage, search, the Work log's Continue in chat): the
   *  chat view, for a chat and an agent's work session alike
   *  (docs/work-log.md). A session on no loaded page is looked up first. */
  const openSession = useCallback((id: string) => {
    if (sessionsRef.current.some((s) => s.id === id)) { showChat(id); return; }
    probed.current.delete(id);
    void api.chat(id).then((s) => {
      if (openableIn(s, workspaceIdRef.current)) { probed.current.set(id, 'found'); setExtraSessions((x) => (x.some((y) => y.id === s.id) ? x.map((y) => (y.id === s.id ? s : y)) : [...x, s])); }
      showChat(id);
    }).catch(() => showChat(id));
  }, [showChat]);
  const openInChat = openSession;

  const openFile = useCallback((target: FileTarget, path: string | null) => {
    markPush();
    if (target.kind === 'workspace') setSection('artifacts');
    else { setSection('home'); setHomeView('file'); }
    setFileTarget(target);
    setCurrentFile(path);
    if (path) setMobileChatOpen(true);
    setArtifact(null);
    setBrowserOpen(false);
  }, [markPush]);

  const newChat = useCallback(async (agentId?: string | null) => {
    const pinned = agentId ? agents.find((x) => x.id === agentId) : undefined;
    const created = await api.createChat({
      workspaceId,
      agentId: agentId ?? undefined,
      // the agent's own model setting wins over the app default
      agentTypeId: pinned?.agentTypeId || settings.defaultAgentTypeId || undefined,
      model: pinned?.agentTypeId ? pinned.model || undefined : undefined,
      tokenCeiling: settings.defaultTokenCeiling ? parseInt(settings.defaultTokenCeiling, 10) : undefined,
    });
    if (settings.defaultPermissionMode === 'auto') {
      await api.updateChat(created.id, { permissionMode: 'auto' }).catch(() => {});
    }
    await refreshSessions();
    showChat(created.id);
    return created.id;
  }, [workspaceId, settings, agents, refreshSessions, showChat]);

  /** Show another company (the header must change before its first request).
   *  What belonged to the old one — its open chat, channel, agent, task — goes. */
  const switchWorkspace = useCallback((id: string) => {
    setActiveSharedWorkspace(sharedIds.current.has(id) ? id : null);
    workspaceIdRef.current = id;
    setWorkspaceId(id);
    setCurrentId(null);
    setCurrentChannel(null);
    setSelectedAgent(null);
    setRouteTaskRaw(null);
    setRouteProjectRaw(null);
    setOrgFocus(null);
    setFileTarget({ kind: 'workspace', id });
    setCurrentFile(null);
  }, []);

  /** Open one org task: its drawer on Operations › Board, the task in the
   *  address (`/<company>/tasks/<key>`). The board fetches a task it does not
   *  have and turns a prefix into the task's key. */
  const openOrgTask = useCallback((taskId: string) => {
    if (!workspaceId || !taskId) return;
    markPush();
    setOrgUnitId(null);
    setOrgFocus({ kind: 'task', id: taskId });
    setSection('operations');
    setOrgPaneRaw('board');
    setRouteTaskRaw(taskId);
    setRouteProjectRaw(null);
    setMobileDetail(true);
  }, [workspaceId, markPush]);
  const setRouteTask = useCallback((key: string | null, opts: { replace?: boolean } = {}) => {
    if (!opts.replace) markPush();
    setRouteTaskRaw(key);
  }, [markPush]);
  const setRouteProject = useCallback((key: string | null, opts: { replace?: boolean } = {}) => {
    if (!opts.replace) markPush();
    setRouteProjectRaw(key);
  }, [markPush]);
  const setAgentTab = useCallback((slug: string | null) => setAgentTabRaw(slug), []);

  const pickWorkspace = useCallback((id: string) => {
    markPush();
    switchWorkspace(id);
    setMobileChatOpen(false);
    // The agents list follows workspaceId (refreshAgents depends on it and
    // the mount effect re-runs); fetching here would race with the old id.
  }, [markPush, switchWorkspace]);

  // ---- the address: read it, follow Back and Forward, write it back ----
  /** Show a route: its company (switching if it names another one we have),
   *  then its place. Not a history entry — the address is already there. */
  const applyRoute = useCallback((route: Route) => {
    const list = workspacesRef.current;
    const target = route.company ? resolveCompany(route.company, list) : null;
    const foreign = Boolean(route.company && !target && list.length > 0);
    if (foreign) showToast('That link is for a company you are not in');
    const wsId = target?.id ?? workspaceIdRef.current;
    if (target && target.id !== workspaceIdRef.current) switchWorkspace(target.id);
    applyPlace(foreign ? { kind: 'home' } : route.place, wsId);
    navMode.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [switchWorkspace, showToast]);
  const applyPlace = (place: Place, wsId: string) => {
    const n = navOf(place);
    if (place.kind === 'session') {
      // the pick effect opens it once loaded (or looked up)
      deepLink.current = place.id;
      if (place.log) asLog.current.add(place.id);
      setProbeTick((t) => t + 1);
    }
    if (n.meetingId !== undefined) setMeetingId(n.meetingId);
    if (place.kind === 'meeting') return;
    setArtifact(null);
    setBrowserOpen(false);
    if (n.section) setSection(n.section);
    if (n.homeView) setHomeView(n.homeView);
    if (n.currentChannel !== undefined) setCurrentChannel(n.currentChannel);
    if (n.channelFocus !== undefined) setChannelFocus(n.channelFocus);
    if (n.selectedAgent !== undefined) setSelectedAgent(n.selectedAgent);
    if (n.agentTab !== undefined) setAgentTabRaw(n.agentTab);
    if (n.agentTabRequest) setAgentTabRequest(n.agentTabRequest);
    if (n.fileTarget) setFileTarget(n.fileTarget === 'workspace' ? (wsId ? { kind: 'workspace', id: wsId } : null) : n.fileTarget);
    if (n.currentFile !== undefined) setCurrentFile(n.currentFile);
    if (n.orgPane !== undefined) setOrgPaneRaw(n.orgPane);
    if (n.inboxFilter) setInboxFilter(n.inboxFilter);
    if (n.inboxItem !== undefined) setInboxItemRaw(n.inboxItem);
    if (n.settingsPane) setSettingsPaneRaw(n.settingsPane);
    if (n.routeTask !== undefined) setRouteTaskRaw(n.routeTask);
    if (n.routeProject !== undefined) setRouteProjectRaw(n.routeProject);
    if (n.orgFocus) setOrgFocus(n.orgFocus);
    if (n.orgUnitId === null) setOrgUnitId(null);
    if (n.foundry) setFoundry(n.foundry);
    if (n.mobileChatOpen !== undefined) setMobileChatOpen(n.mobileChatOpen);
    if (n.mobileDetail !== undefined) setMobileDetail(n.mobileDetail);
  };

  // The first load: once the workspace list is in and the company chosen,
  // show the route's place there (what needs the company: a channel, a
  // chat, a task), then start writing the address.
  useEffect(() => {
    if (routeReady || !workspaceId || workspaces.length === 0) return;
    const r = pendingRoute.current;
    pendingRoute.current = null;
    if (r) {
      if (r.company && !resolveCompany(r.company, workspaces)) {
        showToast('That link is for a company you are not in');
        applyPlace({ kind: 'home' }, workspaceId);
      } else applyPlace(r.place, workspaceId);
    }
    navMode.current = null;
    setRouteReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces, workspaceId, routeReady]);

  // Back and forward (and in-app links, src/lib/routes.ts `navigate`), and
  // older hash links set while the app is open.
  useEffect(() => {
    const on = () => {
      const r = readLocation(window.location);
      if (!r) return;
      if (!routeReadyRef.current) { pendingRoute.current = r; return; }
      applyRoute(r);
    };
    window.addEventListener('popstate', on);
    window.addEventListener('hashchange', on);
    return () => { window.removeEventListener('popstate', on); window.removeEventListener('hashchange', on); };
  }, [applyRoute]);

  // The full-screen meeting room opens and closes through an event
  // (src/lib/meetings.ts): opening is a history entry, closing returns the
  // address to what is underneath.
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<MeetingEventDetail>).detail;
      if (!d) return;
      if (!d.meetingId) { setMeetingId(null); return; }
      markPush();
      if (d.workspaceId && d.workspaceId !== workspaceIdRef.current && workspacesRef.current.some((w) => w.id === d.workspaceId)) switchWorkspace(d.workspaceId);
      setMeetingId(d.meetingId);
    };
    window.addEventListener(MEETING_EVENT, on);
    return () => window.removeEventListener(MEETING_EVENT, on);
  }, [markPush, switchWorkspace]);

  // `/` opens the company used last.
  useEffect(() => {
    if (!workspaceId) return;
    try { localStorage.setItem(LAST_COMPANY_KEY, workspaceId); } catch { /* storage blocked: `/` opens the first company */ }
  }, [workspaceId]);

  // ---- draft persistence (FR-2.1) ----
  const draftTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const setDraft = useCallback((v: string) => {
    const id = currentIdRef.current;
    if (!id) return;
    setDrafts((d) => ({ ...d, [id]: v }));
    clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => { void api.updateChat(id, { draft: v }).catch(() => {}); }, 600);
  }, []);

  // ---- attachments ----
  const addAttachment = useCallback((path: string, kind = 'text', extra?: Partial<Pick<ComposerAttachment, 'transcript' | 'durationSeconds'>>) => {
    setAttachments((a) => [...a, { id: Date.now() + Math.random(), path, kind, ...extra }]);
  }, []);
  const removeAttachment = useCallback((id: number) => setAttachments((a) => a.filter((x) => x.id !== id)), []);
  const clearAttachments = useCallback(() => setAttachments([]), []);

  // ---- the live turn stream ----
  const runTurn = useCallback(async (id: string, text: string, atts: Array<{ path: string; kind: string }>) => {
    activeRuns.current.add(id);
    setStreamingIds((s) => new Set(s).add(id));
    setLiveFor(id, () => [{ kind: 'user', text }]);
    if (currentIdRef.current === id) setLiveBrowserSteps([]);
    const ctrl = new AbortController();
    abortBy.current.set(id, ctrl);
    // Live rows belong to the session the turn runs in. Switching chats does
    // not stop the turn (that used to abort the fetch, and the server ended
    // the turn on disconnect): the rows keep filling for this session.
    const current = () => currentIdRef.current === id;
    const patch = (fn: (items: LiveItem[]) => LiveItem[]) => setLiveFor(id, fn);
    // token text is buffered and flushed to state once per animation frame
    const streamBuf: { current: { kind: 'thinking' | 'answer'; text: string } | null } = { current: null };
    const streamRaf = { current: 0 };
    const applyBuf = () => {
      const buf = streamBuf.current;
      streamBuf.current = null;
      if (!buf) return;
      setLiveFor(id, (items) => {
        const last = items[items.length - 1];
        if (buf.kind === 'thinking') {
          if (last?.kind === 'thinking') return [...items.slice(0, -1), { ...last, text: last.text + buf.text }];
          return [...items, { kind: 'thinking', text: buf.text, streaming: true }];
        }
        if (last?.kind === 'answer') return [...items.slice(0, -1), { ...last, text: last.text + buf.text }];
        return [...items.map((i) => (i.kind === 'thinking' ? { ...i, streaming: false } : i)), { kind: 'answer', text: buf.text, streaming: true }];
      });
    };
    const scheduleFlush = () => {
      if (streamRaf.current) return;
      streamRaf.current = requestAnimationFrame(() => { streamRaf.current = 0; applyBuf(); });
    };
    let started = false;
    let interrupted = false;
    let resend = false;
    try {
      await sendTurn(id, text, atts, (ev) => {
        if (ev.type === 'turn') {
          // the server persisted the message: load it into the transcript,
          // then drop the optimistic row so it never shows twice
          const drop = () => patch((items) => items.filter((i) => i.kind !== 'user'));
          if (current()) void refreshTranscript().then(drop, drop); else drop();
        } else if (ev.type === 'thinking' || ev.type === 'answer') {
          if (streamBuf.current && streamBuf.current.kind !== ev.type) applyBuf();
          if (streamBuf.current) streamBuf.current.text += ev.text;
          else streamBuf.current = { kind: ev.type, text: ev.text };
          scheduleFlush();
        } else if (ev.type === 'tool_call') {
          applyBuf(); // flush pending token text first so row order is kept
          patch((items) => [...items.map((i) => ({ ...i, streaming: false } as LiveItem)), { kind: 'tool', id: ev.id, name: ev.name, input: ev.input, status: 'running' }]);
        } else if (ev.type === 'approval_required') {
          applyBuf();
          patch((items) => {
            const found = items.some((i) => i.kind === 'tool' && i.id === ev.callId);
            if (found) return items.map((i) => (i.kind === 'tool' && i.id === ev.callId ? { ...i, status: 'pending' as const, review: ev.review ?? i.review, routedTo: ev.routedTo } : i));
            return [...items, { kind: 'tool', id: ev.callId, name: ev.tool, input: ev.input, status: 'pending', review: ev.review, routedTo: ev.routedTo }];
          });
        } else if (ev.type === 'tool_result') {
          applyBuf();
          patch((items) => items.map((i) => (
            i.kind === 'tool' && i.id === ev.id
              ? { ...i, status: ev.isError ? (ev.output.includes('Denied') ? 'denied' : 'error') : 'done', result: ev.output, review: ev.review ?? i.review, actionClass: ev.actionClass, actionId: ev.actionId, held: ev.held }
              : i
          )));
        } else if (ev.type === 'tool_progress') {
          patch((items) => items.map((i) => (
            i.kind === 'tool' && i.id === ev.id ? { ...i, progress: [...(i.progress ?? []).slice(-49), ev.text] } : i
          )));
        } else if (ev.type === 'browser') {
          // a page rendered: the Browser tab shows it as the model sees it
          if (current()) {
            setLiveBrowserSteps((s) => [...s, { url: ev.url, title: ev.title, screenshotPath: ev.screenshotPath, step: ev.step }]);
            setBrowserOpen(true);
          }
        } else if (ev.type === 'computer') {
          // the paired computer acted: append to this session's feed and show
          // the Computer tab, same mechanics as the browser
          const step: ComputerStep = { callId: ev.callId, tool: ev.tool, summary: ev.summary, status: ev.status, screenshotPath: ev.screenshotPath, width: ev.width, height: ev.height, at: ev.at };
          setComputer((c) => (c && c.sessionId === id ? { ...c, steps: [...c.steps.slice(-59), step] } : { sessionId: id, workspaceId: ev.workspaceId, steps: [step] }));
          if (current()) setComputerOpen(true);
        } else if (ev.type === 'budget') {
          // the header badge derives from the workspace row — refresh it so
          // the stop shows without waiting for the next poll
          void refreshWorkspaces().catch(() => {});
          showToast(`Workspace budget reached (${Math.round(ev.spentTokens / 1000)}k of ${Math.round(ev.budgetTokens / 1000)}k tokens this month) — loops are paused`);
        } else if (ev.type === 'compacted') {
          // the server summarised older history before this turn; the transcript
          // shows the divider once it reloads
          if (current()) { showToast('Context auto-compacted — older turns distilled to a summary'); void refreshTranscript(); }
        } else if (ev.type === 'retry') {
          // the provider hiccuped mid-round and the server re-asks it: what
          // that round streamed is replaced by the new attempt
          streamBuf.current = null;
          patch(dropFailedRound);
        } else if (ev.type === 'interrupted') {
          interrupted = true;
        } else if (ev.type === 'error') {
          showToast(ev.message);
        }
        if (ev.type === 'turn') started = true;
      }, ctrl.signal);
    } catch (err) {
      if (err instanceof Error && /^409\b/.test(err.message)) {
        // A turn this tab did not start holds the session (a heartbeat, a
        // task run): the message waits for it to end (docs/work-log.md).
        setQueue((q) => [...q, { id: Date.now(), sessionId: id, text, attachments: atts.map((a) => ({ ...a } as SentAttachment)), waitServer: true }]);
        showToast('The agent is mid-run here — your message is queued for its next turn');
      } else if (isConnectionLost(err)) {
        // A restart (docs/architecture.md "Restarts and recovery"): not a
        // failure of the turn. Before the server took the message, send it
        // again once the server is back; after, the reply (or its
        // interruption and a Retry) shows when the transcript is re-read.
        if (!started) {
          resend = true;
          showToast('The server is restarting — your message goes out as soon as it is back');
        } else interrupted = true;
      } else if (!(err instanceof Error && err.name === 'AbortError')) showToast(err instanceof Error ? err.message : 'turn failed');
    }
    if (interrupted) showToast('The server restarted mid-reply — the reply shows here, or a Retry, once it is back');
    if (streamRaf.current) { cancelAnimationFrame(streamRaf.current); streamRaf.current = 0; }
    streamBuf.current = null;
    if (abortBy.current.get(id) === ctrl) abortBy.current.delete(id);
    // load the persisted rows before dropping the live ones, so nothing blinks
    // (a read retries while the server restarts, so this waits for it)
    if (current()) await refreshTranscript().catch(() => {});
    setStreamingIds((s) => { const n = new Set(s); n.delete(id); return n; });
    clearLiveFor(id);
    // the persisted tool records now carry the same steps
    if (current()) setLiveBrowserSteps([]);
    // Never leave the chat "working": a failed refresh must not skip the
    // cleanup below, or every later message would queue behind a dead run.
    activeRuns.current.delete(id);
    await refreshSessions().catch(() => {});
    if (resend) {
      // wait for the API (reads retry through a restart), then send it once
      const back = await api.status().then(() => true, () => false);
      if (back) { void runTurnRef.current(id, text, atts); return; }
      showToast('The server is still not back — your message was not sent; it is back in the composer');
      setDrafts((d) => ({ ...d, [id]: d[id] || text }));
    }
    setTimeout(() => flushQueueRef.current(id, false), 300);
  }, [refreshTranscript, refreshSessions, refreshWorkspaces, showToast, setLiveFor, clearLiveFor]);
  const runTurnRef = useRef<typeof runTurn>(runTurn);
  runTurnRef.current = runTurn;

  /** Send the session's next queued message, unless this tab is running a
   *  turn there. Messages waiting on a server turn go only when `server` says
   *  that turn is over. */
  const flushQueue = useCallback((id: string, server: boolean) => {
    if (activeRuns.current.has(id)) return;
    const next = queueRef.current.find((q) => q.sessionId === id && (server || !q.waitServer));
    if (!next) return;
    queueRef.current = queueRef.current.filter((x) => x.id !== next.id);
    setQueue((q) => q.filter((x) => x.id !== next.id));
    void runTurnRef.current?.(next.sessionId, next.text, next.attachments);
  }, []);
  const flushQueueRef = useRef(flushQueue);
  flushQueueRef.current = flushQueue;

  // Messages waiting on a turn this tab did not start: watch that session
  // and send when its turn ends (or when nothing runs there any more).
  const waitingOn = useMemo(() => [...new Set(queue.filter((q) => q.waitServer).map((q) => q.sessionId))].sort().join(','), [queue]);
  useEffect(() => {
    if (!waitingOn) return;
    const ctrl = new AbortController();
    for (const id of waitingOn.split(',')) {
      void (async () => {
        while (!ctrl.signal.aborted) {
          let busy = false;
          try {
            await watchSession(id, (ev) => { if (ev.type === 'idle') busy = ev.busy; }, ctrl.signal);
          } catch { busy = true; /* offline or gone: try again shortly */ }
          if (ctrl.signal.aborted) return;
          if (!busy) { flushQueueRef.current(id, true); return; }
          await new Promise((r) => setTimeout(r, 2_000));
        }
      })();
    }
    return () => ctrl.abort();
  }, [waitingOn]);

  const sendToSession = useCallback(async (id: string, text: string, opts: { serverBusy?: boolean } = {}): Promise<'started' | 'queued'> => {
    const trimmed = text.trim();
    if (!trimmed) return 'queued';
    if (activeRuns.current.has(id) || opts.serverBusy || queueRef.current.some((q) => q.sessionId === id)) {
      const item: QueuedMessage = { id: Date.now() + Math.random(), sessionId: id, text: trimmed, attachments: [], waitServer: !activeRuns.current.has(id) };
      queueRef.current = [...queueRef.current, item];
      setQueue((q) => [...q, item]);
      return 'queued';
    }
    void runTurnRef.current(id, trimmed, []);
    return 'started';
  }, []);

  const send = useCallback(async (text: string) => {
    const id = currentIdRef.current;
    const s = allSessions.find((x) => x.id === id);
    if (!id || !s) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    // slash built-ins (FR-2.4)
    if (trimmed.startsWith('/')) {
      const [cmd, ...rest] = trimmed.slice(1).split(' ');
      if (cmd === 'clear') {
        await api.clear(id); await refreshTranscript(); await refreshSessions();
        setDraft(''); showToast('Transcript & context cleared'); return;
      }
      if (cmd === 'compact') {
        setDraft('');
        const res = await api.compact(id).catch((e: Error) => ({ ok: false, reason: e.message }));
        showToast(res.ok ? 'Context compacted' : `Compact refused: ${res.reason ?? ''}`);
        await refreshSessions(); await refreshTranscript(); return;
      }
      if (cmd === 'export') {
        window.open(api.exportUrl(id), '_blank'); setDraft('');
        showToast('Conversation exported as markdown'); return;
      }
      const skill = skills.find((k) => k.name === cmd && k.enabled === 1);
      if (skill) {
        setDraft('');
        const prompt = `Use the ${skill.name} skill${rest.length ? ` for: ${rest.join(' ')}` : ''}.`;
        if (streaming) { setQueue((q) => [...q, { id: Date.now(), sessionId: id, text: prompt, attachments: [] }]); return; }
        await runTurn(id, prompt, []);
        return;
      }
    }

    // The ceiling counts tokens since the last compaction. With auto-compact
    // on, the server compacts a chat at its ceiling before the turn, so only
    // refuse locally when auto-compact is off.
    if (s.tokenCeiling > 0 && (s.contextTokens ?? 0) >= s.tokenCeiling && !streaming && settings.autoCompact === 'off') {
      showToast('Context ceiling reached — run /compact, turn auto-compact on, or raise the ceiling.');
      return;
    }
    if (streaming) {
      // queue with the composer attachments so continuation drops nothing
      setQueue((q) => [...q, { id: Date.now(), sessionId: id, text: trimmed, attachments: attachments.map(toSent) }]);
      setDraft('');
      clearAttachments();
      return;
    }
    const atts = attachments.map(toSent);
    setDraft('');
    clearAttachments();
    await runTurn(id, trimmed, atts);
  }, [allSessions, skills, streaming, settings, attachments, runTurn, refreshTranscript, refreshSessions, setDraft, clearAttachments, showToast]);

  const stopTurn = useCallback(() => {
    const id = currentIdRef.current;
    if (id) void api.stop(id);
    if (id) abortBy.current.get(id)?.abort(); // also stop reading the SSE body locally
    showToast('Turn stopped — partial output kept');
  }, [showToast]);

  const approve = useCallback((callId: string, decision: ApprovalDecision) => {
    const id = currentIdRef.current;
    if (id) void api.approve(id, callId, decision);
  }, []);

  const removeQueued = useCallback((id: number) => setQueue((q) => q.filter((x) => x.id !== id)), []);

  const archiveChat = useCallback(async (id: string) => {
    await fetch(`/api/chats/${id}/archive`, { method: 'POST', headers: authHeaders() });
    await refreshSessions();
    showToast('Chat archived — restore it from the Archived group');
  }, [refreshSessions, showToast]);

  const restoreChat = useCallback(async (id: string) => {
    await fetch(`/api/chats/${id}/restore`, { method: 'POST', headers: authHeaders() });
    await refreshSessions();
    showToast('Chat restored');
  }, [refreshSessions, showToast]);

  // ---- turn management ----
  const retry = useCallback(async () => {
    const id = currentIdRef.current;
    if (!id || streaming) return;
    const lastTurn = transcript.turns[transcript.turns.length - 1];
    if (!lastTurn) return;
    const { input } = await api.truncate(id, lastTurn.id);
    await refreshTranscript();
    await runTurn(id, input, []);
  }, [streaming, transcript, refreshTranscript, runTurn]);

  const editResend = useCallback(async (turnId: string) => {
    const id = currentIdRef.current;
    if (!id || streaming) return;
    const { input } = await api.truncate(id, turnId);
    await refreshTranscript();
    setDraft(input);
    showToast('Edit & resend — prior turn removed, text restored');
  }, [streaming, refreshTranscript, setDraft, showToast]);

  const fork = useCallback(async (turnId?: string) => {
    const id = currentIdRef.current;
    if (!id) return;
    const forked = await api.fork(id, turnId);
    await refreshSessions();
    showChat(forked.id);
    showToast('Forked into a new session — original intact');
  }, [refreshSessions, showChat, showToast]);

  const promote = useCallback(async (turnId: string) => {
    const id = currentIdRef.current;
    if (!id) return;
    const res = await api.promote(id, turnId);
    await refreshTranscript();
    showToast(`Promoted to board task ${res.task}`);
  }, [refreshTranscript, showToast]);

  const rate = useCallback(async (turnId: string, rating: 'up' | 'down') => {
    const id = currentIdRef.current;
    if (!id) return;
    await api.rate(id, turnId, rating);
    await refreshTranscript();
    const a = agents.find((x) => x.id === current?.agentId);
    showToast(rating === 'up' ? `Rated 👍${a ? ` — recorded for ${a.name}` : ''}` : 'Rated 👎 — surfaced on the next reply');
  }, [agents, current, refreshTranscript, showToast]);

  // ---- files ----
  const refreshFiles = useCallback(async () => {
    if (!fileTarget) { setFileList([]); return; }
    const list = fileTarget.kind === 'workspace'
      ? await api.wsFiles(fileTarget.id).catch(() => [])
      : await api.agentFiles(fileTarget.id).catch(() => []);
    setFileList(list);
  }, [fileTarget]);
  useEffect(() => { void refreshFiles(); }, [refreshFiles]);
  useEffect(() => {
    if (!fileTarget && workspaceId) setFileTarget({ kind: 'workspace', id: workspaceId });
  }, [workspaceId, fileTarget]);

  /** Go to a section. A company section opens on its dashboard. */
  const setInboxItem = useCallback((id: string | null, opts: { replace?: boolean } = {}) => {
    if (!opts.replace) markPush();
    setInboxItemRaw(id);
  }, [markPush]);

  const go = useCallback((s: Section) => {
    markPush();
    const to = resolveSection(s);
    setSection(to);
    if (isCompanySection(to)) setOrgPaneRaw(null);
    setRouteTaskRaw(null);
    setRouteProjectRaw(null);
    setMobileChatOpen(false);
    setMobileDetail(false);
    setArtifact(null);
    setBrowserOpen(false);
  }, [markPush]);

  const openSettings = useCallback((pane: string) => { go('settings'); setSettingsPaneRaw(pane); setMobileDetail(true); }, [go]);

  // The setters views call to move within a section are navigations too.
  const setSettingsPane = useCallback((p: string) => { markPush(); setSettingsPaneRaw(p); }, [markPush]);
  const setHomeViewNav = useCallback((v: HomeView) => { markPush(); setHomeView(v); }, [markPush]);
  const setSelectedAgentNav = useCallback((id: string | null) => { markPush(); setSelectedAgent(id); setAgentTabRaw(null); }, [markPush]);
  const setCurrentFileNav = useCallback((p: string | null) => { markPush(); setCurrentFile(p); }, [markPush]);

  // The address the store's state names; written back after every change
  // once the first route has been shown — pushed for a navigation, replaced
  // otherwise (and left alone while a linked chat is still being found).
  const company = useMemo(() => {
    const w = workspaces.find((x) => x.id === workspaceId);
    return w ? companySlug(w) : null;
  }, [workspaces, workspaceId]);
  const href = useMemo(() => (company ? routeHref({
    company,
    place: placeOf({
      section, homeView, currentId, currentChannel, selectedAgent, agentTab, fileTarget, currentFile, orgPane, inboxFilter, inboxItem, settingsPane,
      routeTask, routeProject, meetingId, foundry, stacked, mobileChatOpen, mobileDetail,
    }),
  }) : null), [company, section, homeView, currentId, currentChannel, selectedAgent, agentTab, fileTarget, currentFile, orgPane, inboxFilter, inboxItem, settingsPane, routeTask, routeProject, meetingId, foundry, stacked, mobileChatOpen, mobileDetail]);
  useEffect(() => {
    const mode = navMode.current;
    navMode.current = null;
    if (!routeReady || !href || deepLink.current) return;
    if (href === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
    if (mode === 'push') window.history.pushState(null, '', href);
    else window.history.replaceState(null, '', href);
  }, [href, routeReady, navSeq]);

  const saveSettings = useCallback(async (patch: Record<string, string>) => {
    setSettings(await api.putSettings(patch));
    // overrides change what every meter shows
    if ('pricingOverrides' in patch) api.pricing().then((p) => setPricing(p.prices)).catch(() => {});
  }, []);
  useEffect(() => { api.pricing().then((p) => setPricing(p.prices)).catch(() => {}); }, []);

  const [sideFile, setSideFile] = useState<{ workspaceId: string; path: string } | null>(null);
  const openArtifact = useCallback((title: string, src: string) => { setSideFile(null); setArtifact({ title, src }); }, []);
  const closeArtifact = useCallback(() => { setArtifact(null); setSideFile(null); setBrowserOpen(false); setComputerOpen(false); }, []);
  const openSideFile = useCallback((path: string) => { setArtifact(null); setSideFile({ workspaceId: workspaceIdRef.current, path }); }, []);
  // Another company's file never stays open after a switch.
  useEffect(() => { setSideFile((f) => (f && f.workspaceId !== workspaceId ? null : f)); }, [workspaceId]);
  // A file path clicked anywhere Markdown renders (chat, channels, tasks, minutes).
  useEffect(() => {
    const on = (e: Event) => { const d = (e as CustomEvent<FileEventDetail>).detail; if (d?.path) openSideFile(d.path); };
    window.addEventListener(FILE_EVENT, on);
    return () => window.removeEventListener(FILE_EVENT, on);
  }, [openSideFile]);
  const openBrowserPanel = useCallback(() => setBrowserOpen(true), []);

  // Browser steps: the transcript's tool records (every turn so far) plus the
  // steps streamed during the live turn. The panel survives the turn because
  // the records do (docs/browser-tool.md §4).
  const browserSteps = useMemo<BrowserStep[]>(() => {
    const persisted: BrowserStep[] = [];
    for (const t of transcript.turns) {
      let records: Array<{ browser?: BrowserStep }>;
      try { records = JSON.parse(t.toolCalls || '[]') as Array<{ browser?: BrowserStep }>; } catch { records = []; }
      for (const r of records) if (r.browser?.screenshotPath) persisted.push(r.browser);
    }
    const seen = new Set(persisted.map((s) => s.screenshotPath));
    return [...persisted, ...liveBrowserSteps.filter((s) => !seen.has(s.screenshotPath))];
  }, [transcript.turns, liveBrowserSteps]);
  const openComputerPanel = useCallback(() => setComputerOpen(true), []);

  /** Open a mini app beside the agent's most recent conversation (creating
   *  one when the agent has none) — the YAAM "embed in chat" flow. */
  const embedApp = useCallback(async (agentId: string, miniApp: AgentApp) => {
    const latest = sessions.filter((s) => s.agentId === agentId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
    const id = latest?.id ?? await newChat(agentId);
    showChat(id);
    setArtifact({ title: miniApp.name, src: miniApp.html, appCtx: { agentId, miniApp } });
  }, [sessions, newChat, showChat]);

  /** chat.compose: land the user in the agent's chat with the text staged —
   *  they read it and press send themselves (free-tier bridge capability). */
  const composeInChat = useCallback(async (agentId: string, text: string) => {
    const latest = sessions.filter((s) => s.agentId === agentId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
    const id = latest?.id ?? await newChat(agentId);
    // don't re-open the current session: that would close the embedded app
    if (currentIdRef.current !== id) showChat(id);
    setDrafts((d) => ({ ...d, [id]: text }));
  }, [sessions, newChat, showChat]);

  const confirmHire = useCallback(async () => {
    if (!hireId) return;
    const item = market.find((m) => m.id === hireId);
    try {
      const res = await api.hire(hireId, workspaceId || undefined);
      setHireId(null);
      await refreshMarket();
      await refreshAgents();
      openAgent(res.agent.id);
      showToast(`Hired ${item?.name ?? 'agent'} — ${item?.loops.length ? `${item.loops.length} loop(s) enabled` : 'ready to chat'}`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'hire failed');
    }
  }, [hireId, market, refreshMarket, refreshAgents, openAgent, showToast, workspaceId]);

  const store: Store = useMemo(() => ({
    width, stacked, mediumDock, theme, toggleTheme, section, go, homeView, setHomeView: setHomeViewNav,
    mobileChatOpen, setMobileChatOpen, mobileDetail, setMobileDetail, toast, showToast,
    workspaces, workspaceId, pickWorkspace, refreshWorkspaces, me, refreshMe, nameOf,
    agents, agentStats, refreshAgents, unread, sessions, refreshSessions, chatRail, loadMoreChats, loadMoreWork, archived, archivedTotal, archivedHasMore: archivedCursor !== null, loadMoreArchived, archiveChat, restoreChat,
    agentTypes, refreshAgentTypes, skills, refreshSkills, mcp, setMcp, refreshMcp,
    market, refreshMarket, settings, saveSettings, pricing,
    currentId, openSession, openWorkLog, workLogFocus, clearWorkLogFocus, current, transcript, refreshTranscript, patchSession, newChat,
    streaming, live, send, stopTurn, approve, queue: sessionQueue, removeQueued, queueAll: queue, sendToSession, openInChat, streamingIds,
    drafts, setDraft, attachments, addAttachment, removeAttachment, clearAttachments,
    retry, editResend, fork, promote, rate,
    fileTarget, setFileTarget, fileList, refreshFiles, currentFile, setCurrentFile: setCurrentFileNav, openFile,
    selectedAgent, setSelectedAgent: setSelectedAgentNav, openAgent, agentTabRequest, setAgentTabRequest, newAgentOpen, setNewAgentOpen, embedApp, composeInChat,
    artifact, openArtifact, closeArtifact, sideFile, openSideFile,
    browserSteps, browserOpen, openBrowserPanel,
    computer, computerOpen, openComputerPanel,
    hireId, setHireId, confirmHire,
    companiesEnabled, wsOrg, refreshWsOrg, wsOrgLoading, orgPane, setOrgPane, settingsPane, setSettingsPane, openSettings, orgUnitId, setOrgUnitId, orgIntent, orgCadences, orgPendingPlans, orgHealth, orgHeldActions, orgMyTasks, followAttention, unreadMessages, openOrgTask, inboxFilter, setInboxFilter, inboxItem, setInboxItem, orgFocus, setOrgFocus,
    routeTask, setRouteTask, routeProject, setRouteProject, setAgentTab, meetingId,
    channels, refreshChannels, currentChannel, channelFocus, setChannelFocus, openChannel, onWorkspaceEvent,
  }), [
    setHomeViewNav, setCurrentFileNav, setSelectedAgentNav, setSettingsPane,
    routeTask, setRouteTask, routeProject, setRouteProject, setAgentTab, meetingId,
    width, stacked, mediumDock, theme, toggleTheme, section, go, homeView,
    mobileChatOpen, mobileDetail, toast, showToast,
    workspaces, workspaceId, pickWorkspace, refreshWorkspaces, me, refreshMe, nameOf,
    agents, agentStats, refreshAgents, unread, sessions, refreshSessions, chatRail, loadMoreChats, loadMoreWork, archived, archivedTotal, archivedCursor, loadMoreArchived, archiveChat, restoreChat,
    agentTypes, refreshAgentTypes, skills, refreshSkills, mcp, refreshMcp,
    market, refreshMarket, settings, saveSettings, pricing,
    currentId, openSession, openWorkLog, workLogFocus, clearWorkLogFocus, current, transcript, refreshTranscript, patchSession, newChat,
    streaming, live, send, stopTurn, approve, sessionQueue, removeQueued, queue, sendToSession, openInChat, streamingIds,
    drafts, setDraft, attachments, addAttachment, removeAttachment, clearAttachments,
    retry, editResend, fork, promote, rate,
    fileTarget, fileList, refreshFiles, currentFile, openFile,
    selectedAgent, openAgent, agentTabRequest, newAgentOpen, embedApp, composeInChat,
    artifact, openArtifact, closeArtifact, sideFile, openSideFile,
    browserSteps, browserOpen, openBrowserPanel,
    computer, computerOpen, openComputerPanel,
    hireId, confirmHire,
    companiesEnabled, wsOrg, refreshWsOrg, wsOrgLoading, orgPane, settingsPane, openSettings, orgUnitId, orgIntent, orgCadences, orgPendingPlans, orgHealth, orgHeldActions, orgMyTasks, followAttention, unreadMessages, openOrgTask, inboxFilter, setInboxFilter, inboxItem, setInboxItem, orgFocus,
    channels, refreshChannels, currentChannel, channelFocus, openChannel, onWorkspaceEvent,
  ]);

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}
