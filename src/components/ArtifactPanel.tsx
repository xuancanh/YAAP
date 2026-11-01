/** Artifact side panel: opaque-origin, network-denied iframe (FR-13.1), plus
 *  two live tabs with the same mechanics — the Browser tab (the agent's
 *  browsing as screenshots, docs/browser-tool.md §4) and the Computer tab
 *  (actions on the user's paired machine, docs/computer-control.md). */
import { useEffect, useState } from 'react';
import { I, P } from '../lib/icons';
import { api, type BrowserStep } from '../lib/api';
import { useApp, type ComputerFeed, type ComputerStep } from '../store';
import { AppHost } from './AppHost';
import { sealHtml } from '../lib/sandbox';

type Tab = 'preview' | 'source' | 'browser' | 'computer';

export function ArtifactPanel() {
  const app = useApp();
  const art = app.artifact;
  const browser = app.browserOpen && app.browserSteps.length > 0 ? app.browserSteps : null;
  const computer = app.computerOpen && app.computer && app.computer.sessionId === app.currentId && app.computer.steps.length > 0 ? app.computer : null;
  const [tab, setTab] = useState<Tab>(art ? 'preview' : browser ? 'browser' : 'computer');
  // a new browser or computer step while something else is shown pulls its tab forward
  const latestBrowser = browser?.[browser.length - 1]?.screenshotPath;
  const latestComputer = computer?.steps[computer.steps.length - 1]?.callId;
  useEffect(() => { if (latestBrowser) setTab('browser'); }, [latestBrowser]);
  useEffect(() => { if (latestComputer) setTab('computer'); }, [latestComputer]);
  useEffect(() => {
    const fallback: Tab = art ? 'preview' : browser ? 'browser' : 'computer';
    if ((tab === 'browser' && !browser) || (tab === 'computer' && !computer) || ((tab === 'preview' || tab === 'source') && !art)) setTab(fallback);
  }, [browser, computer, art, tab]);
  if (!art && !browser && !computer) return null;

  const push = app.width >= 1300;
  const base: React.CSSProperties = {
    flexDirection: 'column', background: 'var(--panel)', borderLeft: '1px solid var(--border)',
    display: 'flex', animation: 'slideIn .18s ease', zIndex: 60,
  };
  const style: React.CSSProperties = push
    ? { position: 'relative', width: 440, flex: 'none', ...base }
    : { position: 'absolute', top: 0, right: 0, height: '100%', width: app.stacked ? '100%' : 440, boxShadow: 'var(--shadow)', ...base };
  const tabStyle = (t: Tab): React.CSSProperties => ({
    color: tab === t ? 'var(--accent-hi)' : 'var(--text-faint)', fontWeight: tab === t ? 600 : 400,
    borderBottom: tab === t ? '2px solid var(--accent)' : 'none', paddingBottom: 6, cursor: 'pointer',
  });
  const showingBrowser = tab === 'browser' && browser;
  const showingComputer = tab === 'computer' && computer;
  const title = showingBrowser ? (browser[browser.length - 1].title || 'Browser') : showingComputer ? 'Computer' : art?.title ?? '';
  const subtitle = showingBrowser ? 'Disposable browser · no logins · ends with the turn'
    : showingComputer ? 'Your paired computer · every action approved by you'
      : 'Opaque-origin iframe · no network';
  const icon = showingBrowser ? P.globe : showingComputer ? P.window : P.panel;

  return (
    <aside style={style}>
      <div style={{ flex: 'none', padding: '12px 15px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <I d={icon} size={16} stroke={showingComputer ? 'var(--red)' : 'var(--accent-hi)'} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
          <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{subtitle}</div>
        </div>
        <button onClick={app.closeArtifact} style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 4, display: 'flex' }}>
          <I d={P.x} size={17} />
        </button>
      </div>
      <div style={{ flex: 'none', display: 'flex', gap: 14, padding: '8px 15px', borderBottom: '1px solid var(--border-soft)', fontSize: 11.5 }}>
        {art && <span onClick={() => setTab('preview')} style={tabStyle('preview')}>Preview</span>}
        {art && <span onClick={() => setTab('source')} style={tabStyle('source')}>Source</span>}
        {browser && <span onClick={() => setTab('browser')} style={tabStyle('browser')}>Browser{app.streaming ? ' · live' : ''}</span>}
        {computer && <span onClick={() => setTab('computer')} style={tabStyle('computer')}>Computer{app.streaming ? ' · live' : ''}</span>}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, color: showingBrowser ? 'var(--text-faint)' : 'var(--red)' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: showingBrowser ? 'var(--green)' : 'var(--red)' }} />
          {showingBrowser ? `${browser.length} step${browser.length === 1 ? '' : 's'}` : showingComputer ? 'acts on your machine' : 'network blocked'}
        </span>
      </div>
      {showingBrowser ? (
        <BrowserView steps={browser} />
      ) : showingComputer ? (
        <ComputerView feed={computer} />
      ) : tab === 'preview' && art ? (
        art.appCtx
          ? <AppHost agentId={art.appCtx.agentId} miniApp={art.appCtx.miniApp} />
          : <iframe title={art.title} sandbox="allow-scripts" srcDoc={sealHtml(art.src)} style={{ flex: 1, width: '100%', border: 'none', background: '#fff' }} />
      ) : (
        <pre style={{ flex: 1, margin: 0, padding: '14px 16px', overflow: 'auto', background: 'var(--code)', fontFamily: 'var(--mono)', fontSize: 11.5, lineHeight: 1.6, color: 'var(--text-dim)' }}>{art?.src}</pre>
      )}
    </aside>
  );
}

/** Latest screenshot large, every step as a thumbnail strip underneath.
 *  Images come from the chat's file store through the preview endpoint
 *  (base64), the same path the file browser uses for image previews. */
function BrowserView({ steps }: { steps: BrowserStep[] }) {
  const app = useApp();
  const [selected, setSelected] = useState<number | null>(null);
  const [images, setImages] = useState<Record<string, string>>({});
  const session = app.current;
  const idx = selected !== null && selected < steps.length ? selected : steps.length - 1;
  const step = steps[idx];
  // follow the newest step unless the user picked an older one
  useEffect(() => { setSelected(null); }, [steps.length]);

  useEffect(() => {
    if (!session) return;
    const want = [step, ...steps.slice(-6)].filter((s) => s && !images[s.screenshotPath]);
    if (want.length === 0) return;
    let cancelled = false;
    void Promise.all(want.map(async (s) => {
      try {
        const p = session.agentId
          ? await api.agentPreview(session.agentId, s.screenshotPath, session.workspaceId)
          : await api.wsPreview(session.workspaceId, s.screenshotPath);
        return [s.screenshotPath, p.base64 ? `data:${p.contentType};base64,${p.base64}` : ''] as const;
      } catch {
        return [s.screenshotPath, ''] as const;
      }
    })).then((pairs) => {
      if (cancelled) return;
      setImages((m) => { const next = { ...m }; for (const [k, v] of pairs) next[k] = v; return next; });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step?.screenshotPath, steps.length, session?.id]);

  if (!step) return null;
  const src = images[step.screenshotPath];
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 'none', padding: '8px 15px', borderBottom: '1px solid var(--border-soft)', fontSize: 11.5, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Step {step.step}{step.title ? ` · ${step.title}` : ''}</div>
        <a href={step.url} target="_blank" rel="noopener noreferrer" title={step.url}
          style={{ color: 'var(--text-faint)', fontFamily: 'var(--mono)', fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: 'none' }}>
          {step.url}
        </a>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: 'var(--code)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center' }}>
        {src === undefined
          ? <div style={{ padding: 24, fontSize: 12, color: 'var(--text-faint)' }}>Loading screenshot…</div>
          : src === ''
            ? <div style={{ padding: 24, fontSize: 12, color: 'var(--text-faint)' }}>Screenshot not available ({step.screenshotPath}).</div>
            : <img src={src} alt={`Browser step ${step.step}: ${step.title || step.url}`} style={{ width: '100%', display: 'block' }} />}
      </div>
      {steps.length > 1 && (
        <div style={{ flex: 'none', display: 'flex', gap: 6, padding: '8px 12px', overflowX: 'auto', borderTop: '1px solid var(--border-soft)' }}>
          {steps.map((s, i) => {
            const thumb = images[s.screenshotPath];
            const active = i === idx;
            return (
              <button key={s.screenshotPath} onClick={() => setSelected(i)} title={`Step ${s.step} · ${s.title || s.url}`}
                style={{ flex: 'none', width: 72, height: 50, padding: 0, overflow: 'hidden', borderRadius: 6, cursor: 'pointer', background: 'var(--code)', border: `2px solid ${active ? 'var(--accent)' : 'var(--border)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {thumb
                  ? <img src={thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top' }} />
                  : <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{s.step}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The Computer tab: the latest screenshot (a workspace file under
 *  computer/<session>/, read through the JSON preview endpoint so the image
 *  never loads from a URL the page could be tricked into) and the step strip
 *  of every action the companion performed in this conversation. */
function ComputerView({ feed }: { feed: ComputerFeed }) {
  const steps = feed.steps;
  const latestShot = [...steps].reverse().find((s) => s.screenshotPath);
  const [img, setImg] = useState<{ path: string; src: string } | null>(null);
  useEffect(() => {
    if (!latestShot?.screenshotPath) return;
    const path = latestShot.screenshotPath;
    let alive = true;
    api.wsPreview(feed.workspaceId, path)
      .then((p) => { if (alive) setImg({ path, src: p.base64 ? `data:${p.contentType};base64,${p.base64}` : '' }); })
      .catch(() => { if (alive) setImg({ path, src: '' }); });
    return () => { alive = false; };
  }, [feed.workspaceId, latestShot?.screenshotPath]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ flex: 1, minHeight: 0, background: 'var(--code)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {latestShot && img && img.path === latestShot.screenshotPath && img.src ? (
          <img src={img.src} alt={`Screenshot ${latestShot.screenshotPath}`} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
        ) : (
          <div style={{ fontSize: 12, color: 'var(--text-faint)', padding: 20, textAlign: 'center', lineHeight: 1.6 }}>
            {!latestShot ? 'No screenshot yet — the strip below lists what ran.' : img && img.src === '' ? `Screenshot not available (${latestShot.screenshotPath}).` : 'Loading screenshot…'}
          </div>
        )}
      </div>
      {latestShot && (
        <div style={{ flex: 'none', padding: '6px 15px', fontSize: 11, color: 'var(--text-faint)', borderTop: '1px solid var(--border-soft)', fontFamily: 'var(--mono)' }}>
          {latestShot.screenshotPath}{latestShot.width && latestShot.height ? ` · ${latestShot.width}×${latestShot.height}` : ''}
        </div>
      )}
      <div style={{ flex: 'none', maxHeight: 180, overflowY: 'auto', borderTop: '1px solid var(--border)' }}>
        {[...steps].reverse().map((s, i) => <ComputerStepRow key={`${s.callId}-${i}`} step={s} latest={i === 0} />)}
      </div>
    </div>
  );
}

function ComputerStepRow({ step, latest }: { step: ComputerStep; latest: boolean }) {
  const color = step.status === 'ok' ? 'var(--green)' : 'var(--red)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 15px', borderBottom: '1px solid var(--border-soft)', background: latest ? 'var(--panel-2)' : 'none', fontSize: 11.5 }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flex: 'none' }} />
      <span style={{ fontFamily: 'var(--mono)', fontWeight: 600, flex: 'none' }}>{step.tool.replace(/^computer_/, '')}</span>
      <span style={{ color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{step.summary}</span>
      <span style={{ color: 'var(--text-faint)', flex: 'none' }}>{new Date(step.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
    </div>
  );
}
