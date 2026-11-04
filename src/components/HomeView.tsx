/**
 * HomeView — the landing page: the owner's mission control (docs/home.md).
 *
 * One request (`GET /api/workspaces/:id/home`) draws the page; the first one
 * records the visit and fixes the "since you were last here" window, and
 * every refresh after it asks for the same window. It refreshes on the
 * workspace event stream (a file written, a task moving, an approval a
 * channel needs), on a light poll for org events the stream does not carry
 * yet, and when the tab regains focus. Inline decisions go through the
 * routes that already own them; the card leaves the list at once and the
 * page refreshes behind it.
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import { api, type AgentMessage, type HomeData, type HomeNeed, type HomeNeedAction } from '../lib/api';
import { actionDone, type HomeTarget } from '../lib/home';
import { reloadFeed } from '../lib/feed-store';
import { HomeBoard, HomeStatus } from './HomeBoard';
import { useMentionables } from './MentionBox';

const NewWorkspaceWizard = lazy(() => import('./NewWorkspaceWizard').then((m) => ({ default: m.NewWorkspaceWizard })));

/** Org events are not on the workspace stream yet: poll lightly while Home is on screen. */
const POLL_MS = 60_000;
/** Bursts of events (an agent writing ten files) collapse into one refresh. */
const DEBOUNCE_MS = 1_500;

/** Run one inline decision through the route that owns it. */
export function decide(wsId: string, n: HomeNeed, a: HomeNeedAction): Promise<unknown> {
  const r = n.ref;
  if (r.approvalId && (a === 'approve' || a === 'reject')) return api.decideOrgApproval(wsId, r.approvalId, a);
  if (r.actionId && (a === 'approve' || a === 'reject')) return api.giveActionKey(wsId, r.actionId, a === 'approve');
  if (r.planId && a === 'veto') return api.vetoOrgPlan(wsId, r.planId);
  if (r.planId && a === 'apply_now') return api.applyOrgPlanNow(wsId, r.planId);
  if (r.signalId && a === 'ack') return api.ackOrgSignal(wsId, r.signalId);
  if (r.eventId && r.agentId && (a === 'approve' || a === 'dismiss')) return api.actOnAgentEvent(r.agentId, r.eventId, a);
  return Promise.reject(new Error(`${a} is not available here; open it for details`));
}

export function HomeView() {
  const app = useApp();
  const wsId = app.workspaceId;
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [wizard, setWizard] = useState(false);
  // Task @mentions in snippets render as chips (docs/work-tracking.md "Mentions"); only in a company.
  const mentionables = useMentionables(data?.company ? wsId : null);
  const since = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const load = useCallback(async () => {
    if (!wsId) return;
    try {
      const d = await api.home(wsId, since.current ?? undefined);
      if (d.workspaceId !== wsId) return;
      since.current = d.since;
      setData(d);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [wsId]);

  // A new workspace is a new visit.
  useEffect(() => { since.current = null; setData(null); setError(null); void load(); }, [load]);

  const soon = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { void load(); }, DEBOUNCE_MS);
  }, [load]);
  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => app.onWorkspaceEvent((ev) => {
    if (ev.type === 'file.changed' || ev.type === 'file_changed' || ev.type === 'task_update' || ev.type === 'channel_approval') soon();
  }), [app, soon]);

  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, POLL_MS);
    const onFocus = () => soon();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(id); window.removeEventListener('focus', onFocus); };
  }, [load, soon]);

  const onAct = useCallback(async (n: HomeNeed, a: HomeNeedAction) => {
    if (!wsId) return;
    setBusy((b) => new Set(b).add(n.id));
    try {
      await decide(wsId, n, a);
      app.showToast(`${actionDone(a)}: ${n.title}`);
      setData((d) => (d ? { ...d, needs: d.needs.filter((x) => x.id !== n.id), headline: { ...d.headline, needsYou: Math.max(0, d.headline.needsYou - 1) } } : d));
      void app.refreshWsOrg(); void reloadFeed(wsId); // the Inbox badge and the bell
      soon();
    } catch (err) {
      app.showToast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy((b) => { const next = new Set(b); next.delete(n.id); return next; });
    }
  }, [wsId, app, soon]);

  const onOpen = useCallback((t: HomeTarget) => {
    switch (t.to) {
      case 'pane':
        app.setOrgFocus(t.focus ?? null);
        app.setOrgUnitId(null);
        app.setOrgPane(t.pane);
        app.setMobileDetail(true);
        return;
      case 'task': app.openOrgTask(t.taskId); return;
      case 'agent': app.openAgent(t.agentId); return;
      case 'file': app.openFile({ kind: 'workspace', id: wsId }, t.path); return;
      case 'chat': app.openSession(t.sessionId); return;
      case 'inbox': app.go('inbox'); return;
    }
  }, [app, wsId]);

  /** A message from the team: its direct chat opens, and its messages are read. */
  const onMessage = useCallback((m: AgentMessage) => {
    setData((d) => (d?.messages ? { ...d, messages: { unread: Math.max(0, d.messages.unread - d.messages.items.filter((x) => x.sessionId === m.sessionId && !x.read).length), items: d.messages.items.map((x) => (x.sessionId === m.sessionId ? { ...x, read: true } : x)) } } : d));
    if (wsId) void api.markMessagesRead(wsId, { sessionId: m.sessionId }).then(() => { void app.refreshWsOrg(); void reloadFeed(wsId); }).catch(() => undefined);
    app.openSession(m.sessionId);
  }, [app, wsId]);

  // The layout follows Home's own width (beside the sidebar), not the window's.
  const box = useRef<HTMLDivElement>(null);
  const [boxWidth, setBoxWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => setBoxWidth(Math.round(entries[0]?.contentRect.width ?? 0) || null));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const width = boxWidth ?? app.width;
  const narrow = app.width < 640 || width < 600;
  const wide = width >= 1040;
  const name = useMemo(() => {
    const full = app.me ? app.me.names[app.me.actorId] ?? '' : '';
    return full.split(/\s+/)[0] ?? '';
  }, [app.me]);
  const isOwner = !app.me || app.me.role === 'owner';
  const ws = app.workspaces.find((w) => w.id === wsId);

  return (
    <div ref={box} data-testid="home-view" style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', minWidth: 0 }}>
      {data ? (
        <HomeBoard
          data={data} narrow={narrow} wide={wide} name={name} busy={busy}
          onAct={(n, a) => { void onAct(n, a); }} onOpen={onOpen} onMessage={onMessage} onAllAgents={() => app.go('agents')} mentionables={mentionables}
          onStartCompany={app.companiesEnabled && isOwner && ws && !ws.shared ? () => setWizard(true) : undefined}
          onNewAgent={isOwner ? () => app.setNewAgentOpen(true) : undefined}
        />
      ) : (
        <HomeStatus error={error} narrow={narrow} onRetry={() => { void load(); }} />
      )}
      {wizard && ws && (
        <Suspense fallback={null}>
          <NewWorkspaceWizard existing={{ id: ws.id, name: ws.name }} onClose={() => { setWizard(false); void app.refreshWsOrg(); void load(); }} />
        </Suspense>
      )}
    </div>
  );
}
