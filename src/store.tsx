/**
 * App store — one context provider holding navigation, data caches, and the
 * live turn stream. Mirrors the interaction spec in design/YAAM Chat.dc.html.
 */
/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  api, sendTurn,
  type Agent, type AgentApp, type AgentStats, type AgentType, type ChatMessage, type ChatSession, type ChatTurn,
  type MarketItem, type McpServer, type Skill, type Workspace, type FileEntry, type ApprovalDecision,
} from './lib/api';

export type Section = 'home' | 'market' | 'settings';
/** What the main pane shows while in the Home section: a conversation, an
 *  agent's home page (or the directory when no agent is selected), or a file
 *  preview — all reachable from the one combined rail, YAAM-style. */
export type HomeView = 'chat' | 'agent' | 'file';

export interface LiveTool {
  kind: 'tool';
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: 'running' | 'pending' | 'done' | 'denied' | 'error';
  result?: string;
}
export type LiveItem =
  | { kind: 'thinking'; text: string; streaming: boolean }
  | { kind: 'answer'; text: string; streaming: boolean }
  | LiveTool;

export interface FileTarget { kind: 'workspace' | 'agent'; id: string }

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
  workspaces: Workspace[]; workspaceId: string; pickWorkspace: (id: string) => void;
  refreshWorkspaces: () => Promise<void>;
  agents: Agent[]; agentStats: Record<string, AgentStats>; refreshAgents: () => Promise<void>;
  unread: Record<string, number>;
  sessions: ChatSession[]; refreshSessions: () => Promise<void>;
  archived: ChatSession[]; archiveChat: (id: string) => Promise<void>; restoreChat: (id: string) => Promise<void>;
  agentTypes: AgentType[]; refreshAgentTypes: () => Promise<void>;
  skills: Skill[]; refreshSkills: () => Promise<void>;
  mcp: McpServer[]; setMcp: (v: McpServer[]) => void; refreshMcp: () => Promise<void>;
  market: MarketItem[]; refreshMarket: () => Promise<void>;
  settings: Record<string, string>; saveSettings: (patch: Record<string, string>) => Promise<void>;

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
  queue: Array<{ id: number; text: string }>; removeQueued: (id: number) => void;
  drafts: Record<string, string>; setDraft: (v: string) => void;
  attachments: Array<{ id: number; path: string; kind: string }>;
  addAttachment: (path: string, kind?: string) => void;
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
  openAgent: (id: string) => void;
  newAgentOpen: boolean; setNewAgentOpen: (v: boolean) => void;
  embedApp: (agentId: string, miniApp: AgentApp) => Promise<void>;

  // artifact panel
  artifact: { title: string; src: string } | null;
  openArtifact: (title: string, src: string) => void;
  closeArtifact: () => void;

  // hire modal
  hireId: string | null; setHireId: (id: string | null) => void;
  confirmHire: () => Promise<void>;
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

export function AppProvider({ children }: { children: ReactNode }) {
  const [width, setWidth] = useState(window.innerWidth);
  const [theme, setTheme] = useState(localStorage.getItem('yaam-theme') || 'dark');
  // legacy deep links (?section=chats|agents|files) land in Home with the
  // matching main view — used by headless screenshot verification too.
  const [section, setSection] = useState<Section>(() => {
    const q = new URLSearchParams(window.location.search).get('section');
    return q === 'market' || q === 'settings' ? q : 'home';
  });
  const [homeView, setHomeView] = useState<HomeView>(() => {
    const q = new URLSearchParams(window.location.search).get('section');
    return q === 'agents' ? 'agent' : q === 'files' ? 'file' : 'chat';
  });
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentStats, setAgentStats] = useState<Record<string, AgentStats>>({});
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [archived, setArchived] = useState<ChatSession[]>([]);
  const [agentTypes, setAgentTypes] = useState<AgentType[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [mcp, setMcp] = useState<McpServer[]>([]);
  const [market, setMarket] = useState<MarketItem[]>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});

  const [currentId, setCurrentId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<{ messages: ChatMessage[]; turns: ChatTurn[] }>({ messages: [], turns: [] });
  const [streaming, setStreaming] = useState(false);
  const [live, setLive] = useState<LiveItem[]>([]);
  const [queue, setQueue] = useState<Array<{ id: number; text: string }>>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [attachments, setAttachments] = useState<Array<{ id: number; path: string; kind: string }>>([]);

  const [fileTarget, setFileTarget] = useState<FileTarget | null>(null);
  const [fileList, setFileList] = useState<FileEntry[]>([]);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(() => new URLSearchParams(window.location.search).get('agent'));
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [artifact, setArtifact] = useState<{ title: string; src: string } | null>(null);
  const [hireId, setHireId] = useState<string | null>(null);

  const currentIdRef = useRef<string | null>(null);
  currentIdRef.current = currentId;
  const queueRef = useRef(queue);
  queueRef.current = queue;

  const stacked = width < 820;
  const mediumDock = !stacked && width < 1120;

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
    const ws = await api.workspaces();
    setWorkspaces(ws);
    setWorkspaceId((cur) => cur && ws.some((w) => w.id === cur) ? cur : (ws[0]?.id ?? ''));
  }, []);

  const refreshAgents = useCallback(async () => {
    const list = await api.agents();
    setAgents(list);
    const stats: Record<string, AgentStats> = {};
    await Promise.all(list.map(async (a) => {
      stats[a.id] = await api.agentStats(a.id).catch(() => ({ chats: 0, up: 0, down: 0, rating: null, tokensIn: 0, tokensOut: 0 }));
    }));
    setAgentStats(stats);
    setUnread(await api.unreadAgentEvents().catch(() => ({})));
  }, []);

  const refreshSessions = useCallback(async () => {
    if (!workspaceId) return;
    setSessions(await api.chats(workspaceId));
    setArchived(await fetch(`/api/chats?workspaceId=${encodeURIComponent(workspaceId)}&archived=true`).then((r) => r.json() as Promise<ChatSession[]>).catch(() => []));
  }, [workspaceId]);

  const refreshAgentTypes = useCallback(async () => setAgentTypes(await api.agentTypes()), []);
  const refreshSkills = useCallback(async () => setSkills(await api.skills(workspaceId || undefined)), [workspaceId]);
  const refreshMcp = useCallback(async () => setMcp(await api.mcp()), []);
  const refreshMarket = useCallback(async () => setMarket(await api.market()), []);

  useEffect(() => { void refreshWorkspaces().catch(() => showToast('API offline')); }, [refreshWorkspaces, showToast]);
  useEffect(() => { void refreshAgents().catch(() => {}); void refreshAgentTypes().catch(() => {}); void refreshMcp().catch(() => {}); void refreshMarket().catch(() => {}); api.settings().then(setSettings).catch(() => {}); }, [refreshAgents, refreshAgentTypes, refreshMcp, refreshMarket]);
  useEffect(() => { void refreshSessions().catch(() => {}); void refreshSkills().catch(() => {}); }, [refreshSessions, refreshSkills]);

  // pick a session when the workspace changes / sessions load
  useEffect(() => {
    if (!currentIdRef.current || !sessions.some((s) => s.id === currentIdRef.current)) {
      setCurrentId(sessions[0]?.id ?? null);
    }
  }, [sessions]);

  const current = useMemo(() => sessions.find((s) => s.id === currentId) ?? null, [sessions, currentId]);

  const refreshTranscript = useCallback(async () => {
    const id = currentIdRef.current;
    if (!id) { setTranscript({ messages: [], turns: [] }); return; }
    const t = await api.transcript(id).catch(() => ({ messages: [], turns: [] }));
    if (currentIdRef.current === id) setTranscript(t);
  }, []);

  useEffect(() => {
    setLive([]);
    void refreshTranscript();
    // hydrate the draft from the server copy once per session switch (FR-2.1)
    if (current && drafts[current.id] === undefined && current.draft) {
      setDrafts((d) => ({ ...d, [current.id]: current.draft }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  const patchSession = useCallback(async (id: string, patch: Record<string, unknown>) => {
    const updated = await api.updateChat(id, patch);
    setSessions((list) => list.map((s) => (s.id === id ? updated : s)));
  }, []);

  const openSession = useCallback((id: string) => {
    setCurrentId(id);
    setSection('home');
    setHomeView('chat');
    setMobileChatOpen(true);
    setArtifact(null);
  }, []);

  const openAgent = useCallback((id: string) => {
    setSection('home');
    setHomeView('agent');
    setSelectedAgent(id);
    setMobileChatOpen(true); // stacked: the agent page is the detail pane
    setArtifact(null);
    // opening the home page acknowledges the agent's proactive activity
    void api.markAgentEventsRead(id)
      .then(() => setUnread((u) => ({ ...u, [id]: 0 })))
      .catch(() => {});
  }, []);

  const openFile = useCallback((target: FileTarget, path: string | null) => {
    setSection('home');
    setHomeView('file');
    setFileTarget(target);
    setCurrentFile(path);
    if (path) setMobileChatOpen(true);
    setArtifact(null);
  }, []);

  const newChat = useCallback(async (agentId?: string | null) => {
    const created = await api.createChat({
      workspaceId,
      agentId: agentId ?? undefined,
      agentTypeId: settings.defaultAgentTypeId || undefined,
      tokenCeiling: settings.defaultTokenCeiling ? parseInt(settings.defaultTokenCeiling, 10) : undefined,
    });
    if (settings.defaultPermissionMode === 'auto') {
      await api.updateChat(created.id, { permissionMode: 'auto' }).catch(() => {});
    }
    await refreshSessions();
    openSession(created.id);
    return created.id;
  }, [workspaceId, settings, refreshSessions, openSession]);

  const pickWorkspace = useCallback((id: string) => {
    setWorkspaceId(id);
    setCurrentId(null);
    setMobileChatOpen(false);
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
  const addAttachment = useCallback((path: string, kind = 'text') => {
    setAttachments((a) => [...a, { id: Date.now() + Math.random(), path, kind }]);
  }, []);
  const removeAttachment = useCallback((id: number) => setAttachments((a) => a.filter((x) => x.id !== id)), []);
  const clearAttachments = useCallback(() => setAttachments([]), []);

  // ---- the live turn stream ----
  const runTurn = useCallback(async (id: string, text: string, atts: Array<{ path: string; kind: string }>) => {
    setStreaming(true);
    setLive([]);
    const patch = (fn: (items: LiveItem[]) => LiveItem[]) => setLive(fn);
    try {
      await sendTurn(id, text, atts, (ev) => {
        if (ev.type === 'thinking') {
          patch((items) => {
            const last = items[items.length - 1];
            if (last?.kind === 'thinking') return [...items.slice(0, -1), { ...last, text: last.text + ev.text }];
            return [...items, { kind: 'thinking', text: ev.text, streaming: true }];
          });
        } else if (ev.type === 'answer') {
          patch((items) => {
            const last = items[items.length - 1];
            if (last?.kind === 'answer') return [...items.slice(0, -1), { ...last, text: last.text + ev.text }];
            return [...items.map((i) => (i.kind === 'thinking' ? { ...i, streaming: false } : i)), { kind: 'answer', text: ev.text, streaming: true }];
          });
        } else if (ev.type === 'tool_call') {
          patch((items) => [...items.map((i) => ({ ...i, streaming: false } as LiveItem)), { kind: 'tool', id: ev.id, name: ev.name, input: ev.input, status: 'running' }]);
        } else if (ev.type === 'approval_required') {
          patch((items) => {
            const found = items.some((i) => i.kind === 'tool' && i.id === ev.callId);
            if (found) return items.map((i) => (i.kind === 'tool' && i.id === ev.callId ? { ...i, status: 'pending' as const } : i));
            return [...items, { kind: 'tool', id: ev.callId, name: ev.tool, input: ev.input, status: 'pending' }];
          });
        } else if (ev.type === 'tool_result') {
          patch((items) => items.map((i) => (
            i.kind === 'tool' && i.id === ev.id
              ? { ...i, status: ev.isError ? (ev.output.includes('Denied') ? 'denied' : 'error') : 'done', result: ev.output }
              : i
          )));
        } else if (ev.type === 'error') {
          showToast(ev.message);
        }
      });
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'turn failed');
    }
    setStreaming(false);
    setLive([]);
    await refreshTranscript();
    await refreshSessions();
    const next = queueRef.current[0];
    if (next) {
      setQueue((q) => q.slice(1));
      setTimeout(() => { void runTurnRef.current?.(id, next.text, []); }, 300);
    }
  }, [refreshTranscript, refreshSessions, showToast]);
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
        if (streaming) { setQueue((q) => [...q, { id: Date.now(), text: prompt }]); return; }
        await runTurn(id, prompt, []);
        return;
      }
    }

    if (s.tokenCeiling > 0 && s.tokensIn + s.tokensOut >= s.tokenCeiling && !streaming) {
      showToast('Token ceiling reached — send refused. Run /compact.');
      return;
    }
    if (streaming) {
      setQueue((q) => [...q, { id: Date.now(), text: trimmed }]);
      setDraft('');
      return;
    }
    const atts = attachments.map((a) => ({ path: a.path, kind: a.kind }));
    setDraft('');
    clearAttachments();
    await runTurn(id, trimmed, atts);
  }, [sessions, skills, streaming, attachments, runTurn, refreshTranscript, refreshSessions, setDraft, clearAttachments, showToast]);

  const stopTurn = useCallback(() => {
    const id = currentIdRef.current;
    if (id) void api.stop(id);
    showToast('Turn stopped — partial output kept');
  }, [showToast]);

  const approve = useCallback((callId: string, decision: ApprovalDecision) => {
    const id = currentIdRef.current;
    if (id) void api.approve(id, callId, decision);
  }, []);

  const removeQueued = useCallback((id: number) => setQueue((q) => q.filter((x) => x.id !== id)), []);

  const archiveChat = useCallback(async (id: string) => {
    await fetch(`/api/chats/${id}/archive`, { method: 'POST' });
    await refreshSessions();
    showToast('Chat archived — restore it from the Archived group');
  }, [refreshSessions, showToast]);

  const restoreChat = useCallback(async (id: string) => {
    await fetch(`/api/chats/${id}/restore`, { method: 'POST' });
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
  }, []);

  const saveSettings = useCallback(async (patch: Record<string, string>) => {
    setSettings(await api.putSettings(patch));
  }, []);

  const openArtifact = useCallback((title: string, src: string) => setArtifact({ title, src }), []);
  const closeArtifact = useCallback(() => setArtifact(null), []);

  /** Open a mini app beside the agent's most recent conversation (creating
   *  one when the agent has none) — the YAAM "embed in chat" flow. */
  const embedApp = useCallback(async (agentId: string, miniApp: AgentApp) => {
    const latest = sessions.filter((s) => s.agentId === agentId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
    const id = latest?.id ?? await newChat(agentId);
    openSession(id);
    setArtifact({ title: miniApp.name, src: miniApp.html });
  }, [sessions, newChat, openSession]);

  const confirmHire = useCallback(async () => {
    if (!hireId) return;
    const item = market.find((m) => m.id === hireId);
    try {
      const res = await api.hire(hireId);
      setHireId(null);
      await refreshMarket();
      await refreshAgents();
      openAgent(res.agent.id);
      showToast(`Hired ${item?.name ?? 'agent'} — ${item?.loops.length ? `${item.loops.length} loop(s) enabled` : 'ready to chat'}`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'hire failed');
    }
  }, [hireId, market, refreshMarket, refreshAgents, openAgent, showToast]);

  const store: Store = {
    width, stacked, mediumDock, theme, toggleTheme, section, go, homeView, setHomeView,
    mobileChatOpen, setMobileChatOpen, mobileDetail, setMobileDetail, toast, showToast,
    workspaces, workspaceId, pickWorkspace, refreshWorkspaces,
    agents, agentStats, refreshAgents, unread, sessions, refreshSessions, archived, archiveChat, restoreChat,
    agentTypes, refreshAgentTypes, skills, refreshSkills, mcp, setMcp, refreshMcp,
    market, refreshMarket, settings, saveSettings,
    currentId, openSession, current, transcript, refreshTranscript, patchSession, newChat,
    streaming, live, send, stopTurn, approve, queue, removeQueued,
    drafts, setDraft, attachments, addAttachment, removeAttachment, clearAttachments,
    retry, editResend, fork, promote, rate,
    fileTarget, setFileTarget, fileList, refreshFiles, currentFile, setCurrentFile, openFile,
    selectedAgent, setSelectedAgent, openAgent, newAgentOpen, setNewAgentOpen, embedApp,
    artifact, openArtifact, closeArtifact,
    hireId, setHireId, confirmHire,
  };

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}
