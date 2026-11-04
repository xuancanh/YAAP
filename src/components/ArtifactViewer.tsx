/** Rich artifact display (docs/filesystem.md "Rich display"): one page per
 *  kind — Markdown as a document, CSV as a table, JSON as a tree, code
 *  highlighted, images framed — and the History drawer. Editing lives in
 *  ./FileEditor. Everything here is props-only so it renders the same in the
 *  main pane, in an agent's Artifacts tab and in the side panel. */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { sealHtml } from '../lib/sandbox';
import type { FilePreview, FileRevision } from '../lib/api';
import { btn, primaryBtn } from './artifactStyles';
import { extOf, relTime, type FileSource, type ViewKind } from '../lib/artifacts';
import { highlightLines } from '../lib/highlight';
import { CsvTable } from './CsvGrid';
import { DocView } from './DocView';

export { CsvTable } from './CsvGrid';

// ------------------------------------------------------------------ JSON

function JsonValue({ name, value, depth, openDepth }: { name?: string; value: unknown; depth: number; openDepth: number }) {
  const [open, setOpen] = useState(depth < openDepth);
  const isArr = Array.isArray(value);
  const isObj = value !== null && typeof value === 'object';
  const keyEl = name !== undefined && <span className="tok-prop">{JSON.stringify(name)}<span className="tok-punct">: </span></span>;
  if (!isObj) {
    const cls = typeof value === 'string' ? 'tok-str' : typeof value === 'number' ? 'tok-num' : 'tok-kw';
    return <div style={{ paddingLeft: 16, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{keyEl}<span className={cls}>{JSON.stringify(value)}</span></div>;
  }
  const entries = isArr ? (value as unknown[]).map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
  const summary = isArr ? `${entries.length} item${entries.length === 1 ? '' : 's'}` : `${entries.length} key${entries.length === 1 ? '' : 's'}`;
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} style={{ all: 'unset', cursor: 'pointer', display: 'block' }}>
        <span aria-hidden style={{ display: 'inline-block', width: 16, color: 'var(--text-faint)', transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform .1s' }}>▾</span>
        {keyEl}
        <span className="tok-punct">{isArr ? '[' : '{'}</span>
        {!open && <span style={{ color: 'var(--text-faint)' }}> {summary} {isArr ? ']' : '}'}</span>}
      </button>
      {open && (
        <>
          <div style={{ paddingLeft: 14, borderLeft: '1px solid var(--border-soft)', marginLeft: 7 }}>
            {entries.map(([k, v]) => <JsonValue key={k} name={isArr ? undefined : k} value={v} depth={depth + 1} openDepth={openDepth} />)}
          </div>
          <div style={{ paddingLeft: 16 }} className="tok-punct">{isArr ? ']' : '}'}</div>
        </>
      )}
    </div>
  );
}

/** JSON as a collapsible tree; falls back to line-numbered source when it
 *  does not parse. */
export function JsonTree({ text, openDepth = 2 }: { text: string; openDepth?: number }) {
  const parsed = useMemo(() => { try { return { ok: true as const, value: JSON.parse(text) as unknown }; } catch (e) { return { ok: false as const, error: (e as Error).message }; } }, [text]);
  if (!parsed.ok) {
    return (
      <div>
        <div className="art-notice warn" role="status"><span>Not valid JSON ({parsed.error}) — showing the source.</span></div>
        <CodeView text={text} lang="json" />
      </div>
    );
  }
  return <div data-testid="json-tree" className="json-tree"><JsonValue value={parsed.value} depth={0} openDepth={openDepth} /></div>;
}

function JsonView({ text }: { text: string }) {
  const [mode, setMode] = useState<'tree' | 'source'>('tree');
  return (
    <div>
      <div className="seg" role="group" aria-label="JSON view" style={{ marginBottom: 12 }}>
        <button type="button" aria-pressed={mode === 'tree'} onClick={() => setMode('tree')}>Tree</button>
        <button type="button" aria-pressed={mode === 'source'} onClick={() => setMode('source')}>Source</button>
      </div>
      {mode === 'tree' ? <JsonTree text={text} /> : <CodeView text={text} lang="json" />}
    </div>
  );
}

// ------------------------------------------------------------------ code

/** Line-numbered, lightly highlighted source. */
export function CodeView({ text, wrap = false, lang }: { text: string; wrap?: boolean; lang?: string }) {
  const lines = useMemo(() => highlightLines(text.replace(/\n$/, ''), lang), [text, lang]);
  const gutter = String(lines.length).length;
  return (
    <div className={`code-view${wrap ? ' wrap' : ''}`}>
      {lines.map((l, i) => (
        <div key={i} className="ln">
          <span aria-hidden className="n" style={{ width: `${gutter + 3}ch` }}>{i + 1}</span>
          <span className="t">{l.length ? l : ' '}</span>
        </div>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------- image

function ImageView({ src, name, size }: { src: string; name: string; size: number }) {
  const [actual, setActual] = useState(false);
  const [dims, setDims] = useState<string | null>(null);
  return (
    <figure className={`doc-figure${actual ? ' actual' : ''}`} style={{ margin: 0 }}>
      <div className="frame">
        <img src={src} alt={name} onClick={() => setActual(!actual)} title={actual ? 'Fit to the page' : 'Show at actual size'}
          onLoad={(e) => setDims(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)} />
      </div>
      <figcaption>{[dims, fmtSize(size), actual ? 'actual size — click to fit' : 'click for actual size'].filter(Boolean).join(' · ')}</figcaption>
    </figure>
  );
}

export const fmtSize = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

// ------------------------------------------------------------------ body

export interface ArtifactBodyProps {
  kind: ViewKind;
  preview: FilePreview;
  name: string;
  transcript?: string | null;
  /** Text kinds as source. */
  raw?: boolean;
  /** The page's meta line (above the title). */
  meta?: ReactNode;
  /** Notices above everything. */
  top?: ReactNode;
  /** Toggle a Markdown task (source line, 0-based). */
  onToggleTask?: (line: number, checked: boolean) => void;
  /** The side panel: a narrower page, no outline. */
  compact?: boolean;
}

/** The read-only body of a file, by kind, as a page: meta, title, content. */
export function ArtifactBody({ kind, preview, name, transcript, raw, meta, top, onToggleTask, compact }: ArtifactBodyProps) {
  const text = preview.text ?? '';
  const truncated = preview.truncated ? <div className="grid-foot">Truncated — the file is larger than the preview.</div> : null;
  if (kind === 'markdown' && !raw) {
    const note = preview.truncated ? <div className="art-notice"><span>Showing the start of a long file — it is larger than the preview.</span></div> : null;
    return <DocView text={text} fallbackTitle={name.replace(/\.(md|markdown|mdx)$/i, '')} meta={meta} top={<>{top}{note}</>} onToggleTask={preview.truncated ? undefined : onToggleTask} toc compact={compact} />;
  }
  // A data: URL is already opaque-origin, but the sandbox attribute is the
  // invariant we state everywhere — no frame without it.
  if (kind === 'pdf' && !raw && preview.base64) return <iframe title={name} sandbox="allow-scripts" src={`data:application/pdf;base64,${preview.base64}`} style={{ width: '100%', height: '100%', minHeight: 420, border: 'none', display: 'block' }} />;
  // Sandboxed, no network (FR-13.1): opaque origin from srcDoc +
  // allow-scripts, and sealHtml's CSP is what actually denies fetch.
  if (kind === 'html' && !raw && preview.text) return <iframe title={name} sandbox="allow-scripts" srcDoc={sealHtml(preview.text)} style={{ width: '100%', height: '100%', minHeight: 420, border: 'none', background: '#fff', display: 'block' }} />;
  let content: ReactNode;
  if (raw && preview.text !== undefined) content = <CodeView text={text} wrap={kind === 'markdown' || kind === 'text'} lang={kind === 'markdown' ? 'md' : extOf(name)} />;
  else switch (kind) {
    case 'csv':
    case 'tsv': content = <CsvTable text={text} sep={kind === 'tsv' ? '\t' : ','} />; break;
    case 'json': content = preview.truncated ? <CodeView text={text} lang="json" /> : <JsonView text={text} />; break;
    case 'code': content = <CodeView text={text} lang={extOf(name)} />; break;
    case 'text': content = <CodeView text={text} wrap />; break;
    case 'image': content = preview.base64 ? <ImageView src={`data:${preview.contentType};base64,${preview.base64}`} name={name} size={preview.size} /> : <Binary size={preview.size} />; break;
    case 'audio': content = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {preview.base64
          ? <audio controls preload="metadata" src={`data:${preview.contentType};base64,${preview.base64}`} style={{ width: '100%', maxWidth: 560 }} />
          : <div style={{ fontSize: 13, color: 'var(--text-faint)' }}>Audio file, {fmtSize(preview.size)} — too large to play inline.</div>}
        <div>
          <h2 style={{ fontSize: 14, fontWeight: 650, margin: '0 0 8px' }}>Transcript</h2>
          {transcript
            ? <div style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--text)', whiteSpace: 'pre-wrap', maxWidth: 720 }}>{transcript}</div>
            : <div style={{ fontSize: 13, color: 'var(--text-faint)' }}>No transcript — transcription was off or unavailable when this file was uploaded (docs/voice.md).</div>}
        </div>
      </div>
    ); break;
    default: content = <Binary size={preview.size} />;
  }
  return <Page title={name} meta={meta} top={top} compact={compact} wide={kind !== 'audio'}>{content}{truncated}</Page>;
}

function Page({ title, meta, top, compact, wide, children }: { title: string; meta?: ReactNode; top?: ReactNode; compact?: boolean; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`doc-page${wide ? ' doc-wide' : ''}${compact ? ' doc-compact' : ''}`}>
      <div className="doc-cols"><div className="doc-main">
        {top}
        {meta}
        <h1 className="doc-title" style={{ fontSize: compact ? 20 : 24, marginBottom: 18 }}>{title}</h1>
        {children}
      </div></div>
    </div>
  );
}

const Binary = ({ size }: { size: number }) => <div className="art-notice"><span>A binary file, {fmtSize(size)}. It has no preview here — download it to open it.</span></div>;

// --------------------------------------------------------------- history

/** Revisions of one file, newest first: view one, restore one. */
export function HistoryDrawer({ source, path, currentVersion, stacked, onRestored, onClose }: {
  source: FileSource; path: string; currentVersion?: number; stacked?: boolean;
  onRestored: (version: number) => void; onClose: () => void;
}) {
  const [revs, setRevs] = useState<FileRevision[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ version: number; preview: FilePreview | null } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setRevs(null); setViewing(null); setErr(null);
    if (!source.revisions) { setRevs([]); return; }
    source.revisions(path).then((r) => setRevs([...r].sort((a, b) => b.version - a.version))).catch((e: unknown) => { setRevs([]); setErr(e instanceof Error ? e.message.slice(0, 120) : 'Could not load history'); });
  }, [source, path]);
  const view = (v: number) => {
    if (!source.revision) return;
    setViewing({ version: v, preview: null });
    source.revision(path, v).then((p) => setViewing({ version: v, preview: p })).catch(() => setViewing(null));
  };
  const restore = async (v: number) => {
    if (!source.restore || !window.confirm(`Restore version ${v}? The current text is kept as a new revision.`)) return;
    setBusy(true);
    try { await source.restore(path, v); onRestored(v); } catch (e) { setErr(e instanceof Error ? e.message.slice(0, 120) : 'Restore failed'); } finally { setBusy(false); }
  };
  return (
    <aside aria-label="History" style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: stacked ? '100%' : 380, maxWidth: '100%', background: 'var(--elev)', borderLeft: '1px solid var(--border)', boxShadow: 'var(--shadow)', zIndex: 20, display: 'flex', flexDirection: 'column', animation: 'slideIn .14s ease' }}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px 0 16px', height: 46, borderBottom: '1px solid var(--border)' }}>
        <span style={{ fontWeight: 650, fontSize: 14, flex: 1 }}>{viewing ? `Version ${viewing.version}` : 'History'}</span>
        {viewing && <button type="button" onClick={() => setViewing(null)} style={btn}>Back</button>}
        <button type="button" aria-label="Close history" onClick={onClose} className="art-btn icon">✕</button>
      </div>
      {viewing ? (
        <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
            {viewing.preview === null ? <div style={{ padding: 16, fontSize: 12.5, color: 'var(--text-faint)' }}>Loading…</div>
              : viewing.preview.text !== undefined ? <CodeView text={viewing.preview.text} wrap lang={extOf(path)} />
                : <div style={{ padding: 16, fontSize: 12.5, color: 'var(--text-faint)' }}>Binary revision, {fmtSize(viewing.preview.size)}</div>}
          </div>
          {source.restore && <div style={{ flex: 'none', padding: 12, borderTop: '1px solid var(--border)' }}><button type="button" disabled={busy} onClick={() => void restore(viewing.version)} style={primaryBtn}>Restore this version</button></div>}
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
          {currentVersion !== undefined && (
            <div style={{ padding: '8px 10px', fontSize: 12.5, color: 'var(--text-dim)' }}>Current: <b style={{ color: 'var(--text)' }}>version {currentVersion}</b></div>
          )}
          {revs === null && <div style={{ padding: 12, fontSize: 12.5, color: 'var(--text-faint)' }}>Loading…</div>}
          {revs?.length === 0 && !err && <div style={{ padding: 12, fontSize: 12.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>No earlier versions yet. Every overwrite keeps the previous text here (the last 20).</div>}
          {err && <div style={{ padding: 12, fontSize: 12, color: 'var(--red)' }}>{err}</div>}
          {revs?.map((r) => (
            <div key={r.version} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px', borderRadius: 8 }} role="group" aria-label={`Version ${r.version}`}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Version {r.version}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {[r.updatedBy?.name, relTime(r.updatedAt), fmtSize(r.size)].filter(Boolean).join(', ')}
                </div>
              </div>
              {source.revision && <button type="button" onClick={() => view(r.version)} className="art-btn solid">View</button>}
              {source.restore && <button type="button" disabled={busy} onClick={() => void restore(r.version)} className="art-btn">Restore</button>}
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
