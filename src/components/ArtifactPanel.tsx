/** Artifact side panel: opaque-origin, network-denied iframe (FR-13.1). */
import { useState } from 'react';
import { I, P } from '../lib/icons';
import { useApp } from '../store';
import { AppHost } from './AppHost';
import { sealHtml } from '../lib/sandbox';

export function ArtifactPanel() {
  const app = useApp();
  const [tab, setTab] = useState<'preview' | 'source'>('preview');
  const art = app.artifact;
  if (!art) return null;
  const push = app.width >= 1300;
  const base: React.CSSProperties = {
    flexDirection: 'column', background: 'var(--panel)', borderLeft: '1px solid var(--border)',
    display: 'flex', animation: 'slideIn .18s ease', zIndex: 60,
  };
  const style: React.CSSProperties = push
    ? { position: 'relative', width: 440, flex: 'none', ...base }
    : { position: 'absolute', top: 0, right: 0, height: '100%', width: app.stacked ? '100%' : 440, boxShadow: 'var(--shadow)', ...base };

  return (
    <aside style={style}>
      <div style={{ flex: 'none', padding: '12px 15px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <I d={P.panel} size={16} stroke="var(--accent-hi)" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{art.title}</div>
          <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>Opaque-origin iframe · no network</div>
        </div>
        <button onClick={app.closeArtifact} style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 4, display: 'flex' }}>
          <I d={P.x} size={17} />
        </button>
      </div>
      <div style={{ flex: 'none', display: 'flex', gap: 14, padding: '8px 15px', borderBottom: '1px solid var(--border-soft)', fontSize: 11.5 }}>
        <span onClick={() => setTab('preview')} style={{ color: tab === 'preview' ? 'var(--accent-hi)' : 'var(--text-faint)', fontWeight: tab === 'preview' ? 600 : 400, borderBottom: tab === 'preview' ? '2px solid var(--accent)' : 'none', paddingBottom: 6, cursor: 'pointer' }}>Preview</span>
        <span onClick={() => setTab('source')} style={{ color: tab === 'source' ? 'var(--accent-hi)' : 'var(--text-faint)', fontWeight: tab === 'source' ? 600 : 400, borderBottom: tab === 'source' ? '2px solid var(--accent)' : 'none', paddingBottom: 6, cursor: 'pointer' }}>Source</span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, color: 'var(--red)' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--red)' }} />network blocked
        </span>
      </div>
      {tab === 'preview' ? (
        art.appCtx
          ? <AppHost agentId={art.appCtx.agentId} miniApp={art.appCtx.miniApp} />
          : <iframe title={art.title} sandbox="allow-scripts" srcDoc={sealHtml(art.src)} style={{ flex: 1, width: '100%', border: 'none', background: '#fff' }} />
      ) : (
        <pre style={{ flex: 1, margin: 0, padding: '14px 16px', overflow: 'auto', background: 'var(--code)', fontFamily: 'var(--mono)', fontSize: 11.5, lineHeight: 1.6, color: 'var(--text-dim)' }}>{art.src}</pre>
      )}
    </aside>
  );
}
