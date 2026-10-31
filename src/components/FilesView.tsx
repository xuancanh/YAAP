/** Files main pane: rich preview of the selected workspace/agent file. */
import { useEffect, useState } from 'react';
import { I, P } from '../lib/icons';
import { useApp } from '../store';
import { api, type FilePreview } from '../lib/api';
import { sealHtml } from '../lib/sandbox';

export function FilesView() {
  const app = useApp();
  const [preview, setPreview] = useState<FilePreview | null>(null);
  /** Voice notes (docs/voice.md): the transcript sidecar, when one exists. */
  const [transcript, setTranscript] = useState<string | null>(null);
  const target = app.fileTarget;
  const path = app.currentFile;
  const agent = target?.kind === 'agent' ? app.agents.find((a) => a.id === target.id) : null;

  useEffect(() => {
    setPreview(null);
    setTranscript(null);
    if (!target || !path) return;
    const previewOf = (p: string) => (target.kind === 'workspace' ? api.wsPreview(target.id, p) : api.agentPreview(target.id, p));
    void previewOf(path).then((p) => {
      setPreview(p);
      if (p.kind === 'audio') {
        void previewOf(`${path}.transcript.txt`)
          .then((t) => setTranscript((t.text ?? '').replace(/^# duration: \d+s\n/, '').trim() || null))
          .catch(() => setTranscript(null));
      }
    }).catch(() => setPreview(null));
  }, [target, path]);

  if (!path) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, color: 'var(--text-faint)', padding: 40 }}>
        <div style={{ width: 56, height: 56, borderRadius: 15, background: 'var(--panel-2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <I d={P.folder} size={26} sw={1.6} />
        </div>
        <div style={{ textAlign: 'center', maxWidth: 340 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>
            {agent ? `${agent.name}'s isolated filesystem` : 'Workspace files'}
          </div>
          <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.55 }}>
            {agent
              ? 'A transparent file brain — LESSONS.md, JOURNAL.md and knowledge/ that conversations load bounded tails of. Select a file to preview.'
              : 'Files the chat tools read and write, stored in S3-compatible object storage. Select a file to preview.'}
          </div>
        </div>
      </div>
    );
  }

  const name = path.split('/').pop()!;
  const ext = name.split('.').pop() ?? '';
  const glyph = preview?.kind === 'image' ? '🖼️' : preview?.kind === 'html' ? '🧩' : preview?.kind === 'audio' ? '🎙️' : '📄';

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <header style={{ flex: 'none', borderBottom: '1px solid var(--border)', padding: '11px 16px', display: 'flex', alignItems: 'center', gap: 11, background: 'var(--panel)' }}>
        {app.stacked && (
          <button onClick={() => { app.setCurrentFile(null); app.setMobileChatOpen(false); }} style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', padding: 4, display: 'flex' }}>
            <I d={P.chevL} size={20} />
          </button>
        )}
        <span style={{ fontSize: 14 }}>{glyph}</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14, fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
          <div style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {(agent ? `${agent.name}` : 'workspace')}/{path}
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <span style={{ fontSize: 11, color: 'var(--text-dim)', background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 7, padding: '4px 9px' }}>{ext}</span>
          {preview?.kind === 'html' && (
            <button onClick={() => preview.text && app.openArtifact(name, preview.text)} style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
              <I d={P.panel} size={13} />Open preview
            </button>
          )}
          {target?.kind === 'workspace' && (
            <button onClick={() => { app.addAttachment(path); app.setHomeView('chat'); app.setMobileChatOpen(true); app.showToast(`Attached ${name} to composer`); }}
              style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
              <I d={P.attach} size={13} />Attach to chat
            </button>
          )}
        </div>
      </header>
      <div style={{ flex: 1, overflow: 'auto', background: 'var(--code)' }}>
        {preview === null && <div style={{ padding: 22, fontSize: 13, color: 'var(--text-faint)' }}>Loading…</div>}
        {preview?.kind === 'image' && preview.base64 && (
          <div style={{ padding: 22 }}><img src={`data:${preview.contentType};base64,${preview.base64}`} alt={name} style={{ maxWidth: '100%', borderRadius: 8 }} /></div>
        )}
        {preview?.kind === 'audio' && (
          <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {preview.base64
              ? <audio controls preload="metadata" src={`data:${preview.contentType};base64,${preview.base64}`} style={{ width: '100%', maxWidth: 520 }} />
              : <div style={{ fontSize: 13, color: 'var(--text-faint)' }}>Audio file · {preview.size} bytes (too large to preview inline)</div>}
            <div>
              <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.5px', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 6 }}>Transcript</div>
              {transcript
                ? <div style={{ fontSize: 13.5, lineHeight: 1.65, color: 'var(--text)', whiteSpace: 'pre-wrap', maxWidth: 720 }}>{transcript}</div>
                : <div style={{ fontSize: 12.5, color: 'var(--text-faint)', fontStyle: 'italic' }}>No transcript — transcription was off or unavailable when this file was uploaded (docs/voice.md).</div>}
            </div>
          </div>
        )}
        {preview?.kind === 'pdf' && preview.base64 && (
          // A data: URL is already opaque-origin, but the sandbox attribute is
          // the invariant we state everywhere — no frame without it.
          <iframe title={name} sandbox="allow-scripts" src={`data:application/pdf;base64,${preview.base64}`} style={{ width: '100%', height: '100%', border: 'none' }} />
        )}
        {preview?.kind === 'html' && preview.text && (
          // Sandboxed, no network (FR-13.1): opaque origin from srcDoc +
          // allow-scripts, and sealHtml's CSP is what actually denies fetch.
          <iframe title={name} sandbox="allow-scripts" srcDoc={sealHtml(preview.text)} style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }} />
        )}
        {(preview?.kind === 'markdown' || preview?.kind === 'text') && (
          <pre style={{ margin: 0, padding: '20px 22px', fontFamily: 'var(--mono)', fontSize: 12.5, lineHeight: 1.7, color: 'var(--text-dim)', whiteSpace: 'pre-wrap' }}>{preview.text}{preview.truncated ? '\n…(truncated)' : ''}</pre>
        )}
        {preview?.kind === 'binary' && (
          <div style={{ padding: 22, fontSize: 13, color: 'var(--text-faint)' }}>Binary file · {preview.size} bytes</div>
        )}
      </div>
    </div>
  );
}
