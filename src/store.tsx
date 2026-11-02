/**
 * App store — one context provider holding navigation, data caches, and the
 * live turn stream. Mirrors the interaction spec in design/YAAM Chat.dc.html.
 */
/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  api, sendTurn, authHeaders, setActiveSharedWorkspace, subscribeWorkspaceEvents,
  type Agent, type AgentApp, type AgentStats, type AgentType, type ChatMessage, type ChatRailGroup, type ChatSession, type ChatTurn,
  type MarketItem, type McpServer, type Skill, type Workspace, type FileEntry, type ApprovalDecision, type ToolReview,
  type BrowserStep, type WorkspaceOrg, type SharedWorkspace, type WorkspaceMe, type Channel, type WorkspaceEvent,
  type OrgIntentNode, type OrgCadence, type OrgHealth,
} from './lib/api';
import { isChannelSession, parseChannelHash } from './lib/channels';
import { orgTaskHash, parseOrgHash } from './lib/links';
import { paneHome, type InboxFilter } from './lib/inbox';

/** A workspace in the picker: one of ours, or one shared with us (then
 *  `shared` names the owner and our role; docs/shared-agents.md). */
export type WorkspaceEntry = Workspace & { shared?: SharedWorkspace };
import type { PriceTable } from './lib/pricing';

/** `workspace` is the Company section (the id stays for URLs); `inbox` is
 *  everything waiting on the CEO (src/lib/inbox.ts). */
/** 'overview' is Home, the owner's mission control (docs/home.md); 'agents' the full agent directory it links to. */
export type Section = 'home' | 'overview' | 'agents' | 'inbox' | 'workspace' | 'artifacts' | 'apps' | 'market' | 'settings';
/** The organization panes under the Workspace section (docs/group-chat.md
 *  §5: the workspace is the company; there is no separate Company section). */
export type OrgPane = 'board' | 'goals' | 'chart' | 'approvals' | 'spend' | 'brief' | 'audit' | 'vision' | 'pulse' | 'meetings' | 'decisions' | 'plans' | 'replay' | 'capital' | 'mytasks'
  | 'incidents';
export const ORG_PANES: OrgPane[] = ['board', 'goals', 'chart', 'approvals', 'spend', 'brief', 'audit', 'vision', 'pulse', 'meetings', 'decisions', 'plans', 'replay', 'capital', 'mytasks', 'incidents'];
/** Panes folded into Artifacts (playbooks, experiments, evals, outcomes and
 *  metrics are mirrored as files under /org/; docs/filesystem.md): a link to
 *  one of them opens the Artifacts section instead. */
export const ORG_PANES_IN_ARTIFACTS = ['ask', 'playbooks', 'metrics', 'experiments', 'outcomes', 'evals'];
/** Something a pane should open or scroll to once loaded (a signal row's
 *  deep link, docs/company-vision.md §5): a task on the board, a goal on the
 *  vision page, a meeting thread, a plan, a replay day (the id is the
 *  YYYY-MM-DD). Consumed by the pane. */
export interface OrgFocus { kind: 'task' | 'goal' | 'meeting' | 'decision' | 'plan' | 'replay' | 'incident' | 'action'; id: string }
const isOrgPane = (v: string | null | undefined): v is OrgPane => Boolean(v) && (ORG_PANES as string[]).includes(v as string);
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
export interface QueuedMessage { id: number; sessionId: string; text: string; attachments: SentAttachment[] }
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
   *  agent's first page and the pages "Show more" fetched, its loop
   *  sessions, and the open chat even when it is on no loaded page. */
  sessions: ChatSession[]; refreshSessions: () => Promise<void>;
  /** The rail's groups (per agent: count, loaded chats, next cursor, the
   *  folded loop row, chats waiting on an approval). */
  chatRail: ChatRailGroup[];
  /** Load the next page of a rail group (key: agent id, '' = agent-less). */
  loadMoreChats: (groupKey: string) => Promise<void>;
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
  currentId: string | null; openSession: (id: string) => void;
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
  /** Which organization pane the Workspace section shows; null = the board. */
  orgPane: OrgPane | null; setOrgPane: (v: OrgPane | null) => void;
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
  /** Open one org task: the Company board with its drawer, through the task
   *  deep link (`#/ws/<id>/org/board?task=<id>`) so back, forward and reload
   *  work. Fetches the task when it is not on the loaded board. */
  openOrgTask: (taskId: string) => void;
  inboxFilter: InboxFilter; setInboxFilter: (f: InboxFilter) => void;
  orgFocus: OrgFocus | null; setOrgFocus: (v: OrgFocus | null) => void;

  // group chat (docs/group-chat.md, execution plan item 15)
  channels: Channel[]; refreshChannels: () => Promise<void>;
  /** The open channel's slug while homeView is 'channel'. */
  currentChannel: string | null;
  /** A message a deep link asked to scroll to; consumed by the view. */
  channelFocus: string | null; setChannelFocus: (id: string | null) => void;
  openChannel: (slug: string, messageId?: string | null) => void;
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

/** A chat usable as the open chat of workspace `ws`: its own, not archived,
 *  not a channel's hidden working session. */
function openableIn(s: ChatSession | null | undefined, ws: string | null | undefined): boolean {
  return !!s && s.workspaceId === ws && !s.archivedAt && !isChannelSession(s);
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [width, setWidth] = useState(window.innerWidth);
  const [theme, setTheme] = useState(localStorage.getItem('yaam-theme') || 'dark');
  // legacy deep links (?section=chats|agents|files) land in Home with the
  // matching main view — used by headless screenshot verification too.
  const [section, setSection] = useState<Section>(() => {
    const p = new URLSearchParams(window.location.search);
    const q = p.get('section');
    const org = p.get('org');
    if (org && ORG_PANES_IN_ARTIFACTS.includes(org)) return 'artifacts';
    if (isOrgPane(org) && paneHome(org).section === 'inbox') return 'inbox';
    if (q === 'market' || q === 'settings' || q === 'overview' || (q === 'agents' && !p.get('agent')) || q === 'inbox' || q === 'workspace' || q === 'artifacts' || q === 'apps') return q;
    if (q === 'company') return 'workspace'; // legacy: the company lives under the workspace now
    if (q === 'files') return 'artifacts';
    if (q === 'chats' || (q === 'agents' && p.get('agent'))) return 'home';
    return 'overview'; // Home is the landing page
  });
  const [homeView, setHomeView] = useState<HomeView>(() => {
    const q = new URLSearchParams(window.location.search).get('section');
    return q === 'agents' ? 'agent' : q === 'files' ? 'file' : 'chat';
  });
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
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
  /** How many chats each rail group shows, kept across refreshes. */
  const railLimits = useRef<Record<string, number>>({});
  /** Ids looked up by id (an open chat on no loaded page): pending or done. */
  const probed = useRef(new Map<string, 'pending' | 'missing' | 'found'>());
  const [probeTick, setProbeTick] = useState(0);
  const sessions = useMemo(() => {
    const seen = new Set<string>();
    const out: ChatSession[] = [];
    for (const g of chatRail) for (const s of [...g.items, ...g.loops.items]) if (!seen.has(s.id) && !isChannelSession(s)) { seen.add(s.id); out.push(s); }
    for (const s of extraSessions) if (!seen.has(s.id)) { seen.add(s.id); out.push(s); }
    return out;
  }, [chatRail, extraSessions]);
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

  const [fileTarget, setFileTarget] = useState<FileTarget | null>(null);
  const [fileList, setFileList] = useState<FileEntry[]>([]);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(() => new URLSearchParams(window.location.search).get('agent'));
  const [agentTabRequest, setAgentTabRequest] = useState<string | null>(null);
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [artifact, setArtifact] = useState<{ title: string; src: string; appCtx?: { agentId: string; miniApp: AgentApp } } | null>(null);
  const [liveBrowserSteps, setLiveBrowserSteps] = useState<BrowserStep[]>([]);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [computer, setComputer] = useState<ComputerFeed | null>(null);
  const [computerOpen, setComputerOpen] = useState(false);
  const [hireId, setHireId] = useState<string | null>(null);
  const [companiesEnabled, setCompaniesEnabled] = useState(false);
  const [wsOrg, setWsOrg] = useState<WorkspaceOrg | null>(null);
  const [orgPane, setOrgPaneRaw] = useState<OrgPane | null>(() => {
    const p = new URLSearchParams(window.location.search);
    const pane = p.get('org');
    if (isOrgPane(pane) && paneHome(pane).section === 'workspace') return pane;
    return p.get('section') === 'company' ? 'board' : null;
  });
  const [inboxFilter, setInboxFilter] = useState<InboxFilter>(() => {
    const pane = new URLSearchParams(window.location.search).get('org');
    const home = isOrgPane(pane) ? paneHome(pane) : null;
    return home?.section === 'inbox' ? home.filter : 'all';
  });
  /** Open a pane where it lives now: approvals and my tasks in the Inbox,
   *  everything else in the Company section (null = back to its default). */
  const setOrgPane = useCallback((v: OrgPane | null) => {
    if (v === null) { setOrgPaneRaw(null); return; }
    const home = paneHome(v);
    if (home.section === 'inbox') { setSection('inbox'); setInboxFilter(home.filter); return; }
    setSection('workspace');
    setOrgPaneRaw(home.pane);
  }, []);
  const [orgMyTasks, setOrgMyTasks] = useState(0);
  const [followAttention, setFollowAttention] = useState(0);
  const [orgUnitId, setOrgUnitId] = useState<string | null>(null);
  const [orgIntent, setOrgIntent] = useState<OrgIntentNode[]>([]);
  const [orgCadences, setOrgCadences] = useState<OrgCadence[]>([]);
  const [orgPendingPlans, setOrgPendingPlans] = useState(0);
  const [orgHealth, setOrgHealth] = useState<OrgHealth | null>(null);
  const [orgHeldActions, setOrgHeldActions] = useState(0);
  const [orgFocus, setOrgFocus] = useState<OrgFocus | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [currentChannel, setCurrentChannel] = useState<string | null>(null);
  const [channelFocus, setChannelFocus] = useState<string | null>(null);
  const wsListeners = useRef(new Set<(ev: WorkspaceEvent) => void>());

  const currentIdRef = useRef<string | null>(null);
  currentIdRef.current = currentId;
  const queueRef = useRef(queue);
  queueRef.current = queue;
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

  // Deep links from channel notifications: <app>/#/chat/<sessionId>. The
  // session list may not have loaded yet, so the id waits in a ref and the
  // session-pick effect below honours it once the list contains it.
  const deepLink = useRef<string | null>(/^#\/chat\/([\w-]+)$/.exec(window.location.hash)?.[1] ?? null);
  // Organization deep links (#company announcements, the brief):
  // #/ws/<workspaceId>/org/<pane> opens that pane of that workspace, and
  // #/ws/<workspaceId>/org/board?task=<taskId> one task's drawer on the board.
  const orgLink = useRef<{ workspaceId: string; pane: OrgPane | 'artifacts'; taskId: string | null } | null>(null);
  const parseOrgLink = (hash: string): { workspaceId: string; pane: OrgPane | 'artifacts'; taskId: string | null } | null => {
    const m = parseOrgHash(hash);
    if (!m) return null;
    if (m.taskId) return { workspaceId: m.workspaceId, pane: 'board', taskId: m.taskId };
    if (ORG_PANES_IN_ARTIFACTS.includes(m.pane)) return { workspaceId: m.workspaceId, pane: 'artifacts', taskId: null };
    return isOrgPane(m.pane) ? { workspaceId: m.workspaceId, pane: m.pane, taskId: null } : null;
  };
  if (orgLink.current === null && !deepLink.current) orgLink.current = parseOrgLink(window.location.hash);
  // …and from group-chat mentions: #/ws/<id>/channel/<slug>[/<messageId>]
  // (docs/group-chat.md §4). Honoured once the workspace list has loaded.
  const channelLink = useRef(parseChannelHash(window.location.hash));
  useEffect(() => {
    const onHash = () => {
      const id = /^#\/chat\/([\w-]+)$/.exec(window.location.hash)?.[1];
      if (id) { deepLink.current = id; setProbeTick((n) => n + 1); } // nudge the pick effect
      const org = parseOrgLink(window.location.hash);
      if (org) { orgLink.current = org; setWorkspaces((list) => [...list]); }
      const ch = parseChannelHash(window.location.hash);
      if (ch) { channelLink.current = ch; setWorkspaces((list) => [...list]); } // nudge the channel effect
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

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
    setWorkspaces(all);
    // An invitation link lands with ?workspace=<id>: open that one.
    const wanted = new URLSearchParams(window.location.search).get('workspace');
    setWorkspaceId((cur) => {
      const next = wanted && all.some((w) => w.id === wanted) ? wanted : cur && all.some((w) => w.id === cur) ? cur : (all[0]?.id ?? '');
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
    // first page, or as many as "Show more" loaded. Channel sessions
    // (`#slug · Agent`) are the agents' hidden working sessions behind a
    // channel, not direct messages: the server keeps them out.
    const rail = await api.chatRail(workspaceId, { limits: railLimits.current });
    // Open chats beyond the loaded pages are re-read so they stay current.
    const inRail = new Set(rail.groups.flatMap((g) => [...g.items, ...g.loops.items].map((s) => s.id)));
    const extras = (await Promise.all(extraRef.current.filter((s) => !inRail.has(s.id)).map((s) => api.chat(s.id).catch(() => null)))).filter((s): s is ChatSession => openableIn(s, workspaceId));
    for (const s of extraRef.current) if (!extras.some((x) => x.id === s.id) && !inRail.has(s.id)) probed.current.set(s.id, 'missing');
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
    const page = await api.chatPage(workspaceId, { agentId: g.agentId, loops: 'exclude', limit: 20, cursor: g.nextCursor });
    setChatRail((rail) => rail.map((x) => {
      if ((x.agentId ?? '') !== groupKey) return x;
      const seen = new Set(x.items.map((s) => s.id));
      const items = [...x.items, ...page.items.filter((s) => !seen.has(s.id))];
      railLimits.current = { ...railLimits.current, [groupKey]: items.length };
      return { ...x, items, nextCursor: page.nextCursor };
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
    if (!workspaceId || !companiesEnabled) { setWsOrg(null); setOrgIntent([]); setOrgCadences([]); setOrgPendingPlans(0); setOrgHealth(null); setOrgHeldActions(0); setOrgMyTasks(0); setFollowAttention(0); return; }
    const st = await api.workspaceOrg(workspaceId).catch((): WorkspaceOrg | null => null);
    setWsOrg(st);
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
      // Followed changes count in the badge only when they need me.
      setFollowAttention(follows.filter((f) => f.attentionAt && !f.mutedAt).length);
      setOrgIntent(intent); setOrgCadences(cadences); setOrgPendingPlans(plans.length);
      setOrgHealth(health); setOrgHeldActions(held.length + staged.length);
      setOrgMyTasks(mine ? [...mine.assigned, ...mine.reviewing].filter((t) => t.status !== 'done' && t.status !== 'cancelled').length : 0);
    } else { setOrgIntent([]); setOrgCadences([]); setOrgPendingPlans(0); setOrgHealth(null); setOrgHeldActions(0); setOrgMyTasks(0); setFollowAttention(0); }
  }, [workspaceId, companiesEnabled]);
  useEffect(() => {
    api.orgsStatus().then((s) => setCompaniesEnabled(s.enabled)).catch(() => setCompaniesEnabled(false));
  }, []);
  useEffect(() => { void refreshWsOrg(); }, [refreshWsOrg]);
  // The organization panes exist only while the mode is on; fall back to the files.
  useEffect(() => {
    if (wsOrg && wsOrg.mode === 'off' && orgPane) setOrgPane(null);
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
    setChannels(await api.channels(workspaceId).catch((): Channel[] => []));
  }, [workspaceId]);
  useEffect(() => { void refreshChannels(); }, [refreshChannels]);

  const openChannel = useCallback((slug: string, messageId?: string | null) => {
    setCurrentChannel(slug);
    setChannelFocus(messageId ?? null);
    setSection('home');
    setHomeView('channel');
    setMobileChatOpen(true);
    setArtifact(null);
    setBrowserOpen(false);
  }, []);

  const onWorkspaceEvent = useCallback((listener: (ev: WorkspaceEvent) => void) => {
    wsListeners.current.add(listener);
    return () => { wsListeners.current.delete(listener); };
  }, []);

  // One SSE connection per workspace on screen, reconnecting with backoff;
  // unread badges follow every channel message without polling.
  useEffect(() => {
    if (!workspaceId) return;
    const ctrl = new AbortController();
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let backoff = 1_000;
    const run = async () => {
      while (!ctrl.signal.aborted) {
        try {
          await subscribeWorkspaceEvents(workspaceId, (ev) => {
            backoff = 1_000;
            for (const l of wsListeners.current) { try { l(ev); } catch { /* a listener must not break the stream */ } }
            if (ev.type === 'channel_message' || ev.type === 'channel_update') {
              clearTimeout(refreshTimer);
              refreshTimer = setTimeout(() => { void api.channels(workspaceId).then(setChannels).catch(() => {}); }, 400);
            }
          }, ctrl.signal);
        } catch { /* reconnect below */ }
        if (ctrl.signal.aborted) break;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    };
    void run();
    return () => { ctrl.abort(); clearTimeout(refreshTimer); };
  }, [workspaceId]);

  // The channel deep link: switch workspace if needed, then open it.
  useEffect(() => {
    const link = channelLink.current;
    if (!link || workspaces.length === 0) return;
    if (!workspaces.some((w) => w.id === link.workspaceId)) { channelLink.current = null; return; }
    channelLink.current = null;
    if (link.workspaceId !== workspaceId) {
      setActiveSharedWorkspace(sharedIds.current.has(link.workspaceId) ? link.workspaceId : null);
      setWorkspaceId(link.workspaceId);
    }
    openChannel(link.slug, link.messageId);
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, [workspaces, workspaceId, openChannel]);

  useEffect(() => { void refreshWorkspaces().catch(() => showToast('API offline')); }, [refreshWorkspaces, showToast]);
  useEffect(() => { void refreshAgents().catch(() => {}); void refreshAgentTypes().catch(() => {}); void refreshMcp().catch(() => {}); void refreshMarket().catch(() => {}); api.settings().then(setSettings).catch(() => {}); }, [refreshAgents, refreshAgentTypes, refreshMcp, refreshMarket]);
  useEffect(() => { void refreshSessions().catch(() => {}); void refreshSkills().catch(() => {}); void refreshMe(); }, [refreshSessions, refreshSkills, refreshMe]);

  /** Look a chat up by id when it is on no loaded page (the rail is paged):
   *  an openable one joins `sessions`; the pick effect re-runs either way. */
  const probe = useCallback((id: string) => {
    if (probed.current.has(id)) return;
    probed.current.set(id, 'pending');
    void api.chat(id).then((s) => {
      if (openableIn(s, workspaceIdRef.current)) { probed.current.set(id, 'found'); setExtraSessions((x) => (x.some((y) => y.id === s.id) ? x : [...x, s])); } else probed.current.set(id, 'missing');
    }).catch(() => { probed.current.set(id, 'missing'); }).finally(() => setProbeTick((n) => n + 1));
  }, []);

  // pick a session when the workspace changes / sessions load
  useEffect(() => {
    const wanted = deepLink.current;
    if (wanted && sessions.some((s) => s.id === wanted)) {
      deepLink.current = null;
      setCurrentId(wanted);
      setSection('home');
      setHomeView('chat');
      setMobileChatOpen(true);
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      return;
    }
    if (wanted && sessions.length > 0 && !probed.current.has(wanted)) probe(wanted);
    const cur = currentIdRef.current;
    // the first chat of the workspace on screen (the list may still be the last workspace's)
    const firstHere = sessions.find((s) => s.workspaceId === workspaceIdRef.current)?.id ?? null;
    if (!cur) { if (firstHere) setCurrentId(firstHere); return; }
    if (sessions.some((s) => s.id === cur)) return;
    // the open chat is on no loaded page: look it up before giving up on it
    const state = probed.current.get(cur);
    if (state === undefined || state === 'found') { probed.current.delete(cur); probe(cur); return; }
    if (state === 'missing') { probed.current.delete(cur); setCurrentId(firstHere); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, probeTick, currentId]);

  const current = useMemo(() => sessions.find((s) => s.id === currentId) ?? null, [sessions, currentId]);

  const refreshTranscript = useCallback(async () => {
    const id = currentIdRef.current;
    if (!id) { setTranscript({ messages: [], turns: [] }); return; }
    const t = await api.transcript(id).catch(() => ({ messages: [], turns: [] }));
    if (currentIdRef.current === id) setTranscript(t);
  }, []);

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
    setChatRail((rail) => rail.map((g) => ({ ...g, items: g.items.map((s) => (s.id === id ? updated : s)), loops: { ...g.loops, items: g.loops.items.map((s) => (s.id === id ? updated : s)) } })));
    setExtraSessions((list) => list.map((s) => (s.id === id ? updated : s)));
  }, []);

  const openSession = useCallback((id: string) => {
    setCurrentId(id);
    setSection('home');
    setHomeView('chat');
    setMobileChatOpen(true);
    setArtifact(null);
    setBrowserOpen(false);
  }, []);

  const openAgent = useCallback((id: string, tab?: string) => {
    setSection('home');
    setHomeView('agent');
    setSelectedAgent(id);
    if (tab) setAgentTabRequest(tab);
    setMobileChatOpen(true); // stacked: the agent page is the detail pane
    setArtifact(null);
    setBrowserOpen(false);
    // opening the home page acknowledges the agent's proactive activity
    void api.markAgentEventsRead(id)
      .then(() => setUnread((u) => ({ ...u, [id]: 0 })))
      .catch(() => {});
  }, []);

  const openFile = useCallback((target: FileTarget, path: string | null) => {
    if (target.kind === 'workspace') setSection('artifacts');
    else { setSection('home'); setHomeView('file'); }
    setFileTarget(target);
    setCurrentFile(path);
    if (path) setMobileChatOpen(true);
    setArtifact(null);
    setBrowserOpen(false);
  }, []);

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
    openSession(created.id);
    return created.id;
  }, [workspaceId, settings, agents, refreshSessions, openSession]);

  useEffect(() => {
    const wanted = orgLink.current;
    if (!wanted || !workspaces.some((w) => w.id === wanted.workspaceId)) return;
    orgLink.current = null;
    if (wanted.workspaceId !== workspaceId) {
      setActiveSharedWorkspace(sharedIds.current.has(wanted.workspaceId) ? wanted.workspaceId : null);
      setWorkspaceId(wanted.workspaceId);
      setCurrentId(null);
    }
    if (wanted.taskId) {
      // The task link stays in the address bar while its drawer is open, so
      // reload reopens it; the board clears it when the drawer closes.
      setOrgUnitId(null);
      setOrgFocus({ kind: 'task', id: wanted.taskId });
      setOrgPane('board');
      setMobileDetail(true);
      return;
    }
    if (wanted.pane === 'artifacts') setSection('artifacts');
    else { setOrgPane(wanted.pane); setMobileDetail(true); }
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, [workspaces, workspaceId]);

  const openOrgTask = useCallback((taskId: string) => {
    if (!workspaceId || !taskId) return;
    const hash = orgTaskHash(workspaceId, taskId);
    if (window.location.hash === hash) {
      // Already the address: no hashchange will fire, so open it directly.
      setOrgUnitId(null); setOrgFocus({ kind: 'task', id: taskId }); setOrgPane('board'); setMobileDetail(true);
      return;
    }
    window.location.hash = hash; // a history entry; the hashchange handler opens it
  }, [workspaceId, setOrgPane]);

  const pickWorkspace = useCallback((id: string) => {
    // The header must change before the first request for the new workspace.
    setActiveSharedWorkspace(sharedIds.current.has(id) ? id : null);
    setWorkspaceId(id);
    setCurrentId(null);
    setCurrentChannel(null);
    setMobileChatOpen(false);
    // The agents list follows workspaceId (refreshAgents depends on it and
    // the mount effect re-runs); fetching here would race with the old id.
  }, []);

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
        } else if (ev.type === 'error') {
          showToast(ev.message);
        }
      }, ctrl.signal);
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) showToast(err instanceof Error ? err.message : 'turn failed');
    }
    if (streamRaf.current) { cancelAnimationFrame(streamRaf.current); streamRaf.current = 0; }
    streamBuf.current = null;
    if (abortBy.current.get(id) === ctrl) abortBy.current.delete(id);
    // load the persisted rows before dropping the live ones, so nothing blinks
    if (current()) await refreshTranscript();
    setStreamingIds((s) => { const n = new Set(s); n.delete(id); return n; });
    clearLiveFor(id);
    // the persisted tool records now carry the same steps
    if (current()) setLiveBrowserSteps([]);
    await refreshSessions();
    const next = queueRef.current.find((q) => q.sessionId === id);
    if (next) {
      setQueue((q) => q.filter((x) => x.id !== next.id));
      setTimeout(() => { void runTurnRef.current?.(next.sessionId, next.text, next.attachments); }, 300);
    }
  }, [refreshTranscript, refreshSessions, refreshWorkspaces, showToast, setLiveFor, clearLiveFor]);
  const runTurnRef = useRef<typeof runTurn>(runTurn);
  runTurnRef.current = runTurn;

  const send = useCallback(async (text: string) => {
    const id = currentIdRef.current;
    const s = sessions.find((x) => x.id === id);
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
  }, [sessions, skills, streaming, settings, attachments, runTurn, refreshTranscript, refreshSessions, setDraft, clearAttachments, showToast]);

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
    openSession(forked.id);
    showToast('Forked into a new session — original intact');
  }, [refreshSessions, openSession, showToast]);

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

  const go = useCallback((s: Section) => {
    setSection(s);
    setMobileChatOpen(false);
    setMobileDetail(false);
    setArtifact(null);
    setBrowserOpen(false);
  }, []);

  const saveSettings = useCallback(async (patch: Record<string, string>) => {
    setSettings(await api.putSettings(patch));
    // overrides change what every meter shows
    if ('pricingOverrides' in patch) api.pricing().then((p) => setPricing(p.prices)).catch(() => {});
  }, []);
  useEffect(() => { api.pricing().then((p) => setPricing(p.prices)).catch(() => {}); }, []);

  const openArtifact = useCallback((title: string, src: string) => setArtifact({ title, src }), []);
  const closeArtifact = useCallback(() => { setArtifact(null); setBrowserOpen(false); setComputerOpen(false); }, []);
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
    openSession(id);
    setArtifact({ title: miniApp.name, src: miniApp.html, appCtx: { agentId, miniApp } });
  }, [sessions, newChat, openSession]);

  /** chat.compose: land the user in the agent's chat with the text staged —
   *  they read it and press send themselves (free-tier bridge capability). */
  const composeInChat = useCallback(async (agentId: string, text: string) => {
    const latest = sessions.filter((s) => s.agentId === agentId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
    const id = latest?.id ?? await newChat(agentId);
    // don't re-open the current session: that would close the embedded app
    if (currentIdRef.current !== id) openSession(id);
    setDrafts((d) => ({ ...d, [id]: text }));
  }, [sessions, newChat, openSession]);

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
    width, stacked, mediumDock, theme, toggleTheme, section, go, homeView, setHomeView,
    mobileChatOpen, setMobileChatOpen, mobileDetail, setMobileDetail, toast, showToast,
    workspaces, workspaceId, pickWorkspace, refreshWorkspaces, me, refreshMe, nameOf,
    agents, agentStats, refreshAgents, unread, sessions, refreshSessions, chatRail, loadMoreChats, archived, archivedTotal, archivedHasMore: archivedCursor !== null, loadMoreArchived, archiveChat, restoreChat,
    agentTypes, refreshAgentTypes, skills, refreshSkills, mcp, setMcp, refreshMcp,
    market, refreshMarket, settings, saveSettings, pricing,
    currentId, openSession, current, transcript, refreshTranscript, patchSession, newChat,
    streaming, live, send, stopTurn, approve, queue: sessionQueue, removeQueued,
    drafts, setDraft, attachments, addAttachment, removeAttachment, clearAttachments,
    retry, editResend, fork, promote, rate,
    fileTarget, setFileTarget, fileList, refreshFiles, currentFile, setCurrentFile, openFile,
    selectedAgent, setSelectedAgent, openAgent, agentTabRequest, setAgentTabRequest, newAgentOpen, setNewAgentOpen, embedApp, composeInChat,
    artifact, openArtifact, closeArtifact,
    browserSteps, browserOpen, openBrowserPanel,
    computer, computerOpen, openComputerPanel,
    hireId, setHireId, confirmHire,
    companiesEnabled, wsOrg, refreshWsOrg, orgPane, setOrgPane, orgUnitId, setOrgUnitId, orgIntent, orgCadences, orgPendingPlans, orgHealth, orgHeldActions, orgMyTasks, followAttention, openOrgTask, inboxFilter, setInboxFilter, orgFocus, setOrgFocus,
    channels, refreshChannels, currentChannel, channelFocus, setChannelFocus, openChannel, onWorkspaceEvent,
  }), [
    width, stacked, mediumDock, theme, toggleTheme, section, go, homeView,
    mobileChatOpen, mobileDetail, toast, showToast,
    workspaces, workspaceId, pickWorkspace, refreshWorkspaces, me, refreshMe, nameOf,
    agents, agentStats, refreshAgents, unread, sessions, refreshSessions, chatRail, loadMoreChats, archived, archivedTotal, archivedCursor, loadMoreArchived, archiveChat, restoreChat,
    agentTypes, refreshAgentTypes, skills, refreshSkills, mcp, refreshMcp,
    market, refreshMarket, settings, saveSettings, pricing,
    currentId, openSession, current, transcript, refreshTranscript, patchSession, newChat,
    streaming, live, send, stopTurn, approve, sessionQueue, removeQueued,
    drafts, setDraft, attachments, addAttachment, removeAttachment, clearAttachments,
    retry, editResend, fork, promote, rate,
    fileTarget, fileList, refreshFiles, currentFile, openFile,
    selectedAgent, openAgent, agentTabRequest, newAgentOpen, embedApp, composeInChat,
    artifact, openArtifact, closeArtifact,
    browserSteps, browserOpen, openBrowserPanel,
    computer, computerOpen, openComputerPanel,
    hireId, confirmHire,
    companiesEnabled, wsOrg, refreshWsOrg, orgPane, orgUnitId, orgIntent, orgCadences, orgPendingPlans, orgHealth, orgHeldActions, orgMyTasks, followAttention, openOrgTask, inboxFilter, orgFocus,
    channels, refreshChannels, currentChannel, channelFocus, openChannel, onWorkspaceEvent,
  ]);

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}
