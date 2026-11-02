/** Rich artifact display (docs/filesystem.md "Rich display"): one body per
 *  kind, the in-place editor with its version check, and the History drawer.
 *  Everything here is props-only so it renders the same in the main pane and
 *  in an agent's Artifacts tab. */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Markdown } from '../lib/md';
import { sealHtml } from '../lib/sandbox';
import type { FilePreview, FileRevision } from '../lib/api';
import { btn, primaryBtn } from './artifactStyles';
import { compareCells, isConflict, parseConflict, parseDelimited, relTime, type ConflictInfo, type FileSource, type ViewKind } from '../lib/artifacts';

const mono: CSSProperties = { fontFamily: 'var(--mono)' };

// ------------------------------------------------------------------- CSV

const CSV_ROW_CAP = 500;

/** CSV/TSV as a table: first row is the header, click a header to sort
 *  (asc → desc → original), rows capped so a huge export stays responsive. */
export function CsvTable({ text, sep = ',', maxRows = CSV_ROW_CAP }: { text: string; sep?: string; maxRows?: number }) {
  const rows = useMemo(() => parseDelimited(text, sep), [text, sep]);
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const header = rows[0] ?? [];
  const body = useMemo(() => {
    const data = rows.slice(1);
    if (!sort) return data;
    return [...data].sort((a, b) => sort.dir * compareCells(a[sort.col] ?? '', b[sort.col] ?? ''));
  }, [rows, sort]);
  if (rows.length === 0) return <div style={{ padding: 22, fontSize: 13, color: 'var(--text-faint)' }}>Empty table.</div>;
  const cols = Math.max(header.length, ...body.slice(0, maxRows).map((r) => r.length));
  const shown = body.slice(0, maxRows);
  const click = (col: number) => setSort((s) => (!s || s.col !== col ? { col, dir: 1 } : s.dir === 1 ? { col, dir: -1 } : null));
  const cell: CSSProperties = { padding: '6px 11px', borderBottom: '1px solid var(--border-soft)', borderRight: '1px solid var(--border-soft)', whiteSpace: 'nowrap', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'left' };
  return (
    <div style={{ padding: '14px 16px' }}>
      <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--panel)' }}>
        <table data-testid="csv-table" style={{ borderCollapse: 'collapse', fontSize: 12.5, width: '100%' }}>
          <thead>
            <tr>
              {Array.from({ length: cols }, (_, i) => (
                <th key={i} aria-sort={sort?.col === i ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
                  style={{ ...cell, position: 'sticky', top: 0, background: 'var(--panel-2)', fontWeight: 600, padding: 0 }}>
                  <button type="button" onClick={() => click(i)} style={{ all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5, padding: '7px 11px', width: '100%', boxSizing: 'border-box' }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{header[i] ?? ''}</span>
                    <span aria-hidden style={{ color: sort?.col === i ? 'var(--accent)' : 'var(--text-faint)', fontSize: 10 }}>{sort?.col === i ? (sort.dir === 1 ? '▲' : '▼') : '↕'}</span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, ri) => (
              <tr key={ri}>
                {Array.from({ length: cols }, (_, ci) => <td key={ci} title={r[ci] ?? ''} style={{ ...cell, color: 'var(--text-dim)' }}>{r[ci] ?? ''}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 8 }}>
        {body.length > maxRows ? `Showing the first ${maxRows} of ${body.length} rows` : `${body.length} row${body.length === 1 ? '' : 's'}`} · {cols} column{cols === 1 ? '' : 's'}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ JSON

function JsonValue({ name, value, depth, openDepth }: { name?: string; value: unknown; depth: number; openDepth: number }) {
  const [open, setOpen] = useState(depth < openDepth);
  const isArr = Array.isArray(value);
  const isObj = value !== null && typeof value === 'object';
  const keyEl = name !== undefined && <span style={{ color: 'var(--accent-hi)' }}>{JSON.stringify(name)}<span style={{ color: 'var(--text-faint)' }}>: </span></span>;
  if (!isObj) {
    const color = typeof value === 'string' ? 'var(--green)' : typeof value === 'number' ? 'var(--blue)' : typeof value === 'boolean' ? 'var(--amber)' : 'var(--text-faint)';
    return <div style={{ paddingLeft: 16, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{keyEl}<span style={{ color }}>{JSON.stringify(value)}</span></div>;
  }
  const entries = isArr ? (value as unknown[]).map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
  const summary = isArr ? `${entries.length} item${entries.length === 1 ? '' : 's'}` : `${entries.length} key${entries.length === 1 ? '' : 's'}`;
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} style={{ all: 'unset', cursor: 'pointer', display: 'block' }}>
        <span aria-hidden style={{ display: 'inline-block', width: 16, color: 'var(--text-faint)', transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform .1s' }}>▾</span>
        {keyEl}
        <span style={{ color: 'var(--text-dim)' }}>{isArr ? '[' : '{'}</span>
        {!open && <span style={{ color: 'var(--text-faint)' }}>… {summary} {isArr ? ']' : '}'}</span>}
      </button>
      {open && (
        <>
          <div style={{ paddingLeft: 14, borderLeft: '1px solid var(--border-soft)', marginLeft: 7 }}>
            {entries.map(([k, v]) => <JsonValue key={k} name={isArr ? undefined : k} value={v} depth={depth + 1} openDepth={openDepth} />)}
          </div>
          <div style={{ paddingLeft: 16, color: 'var(--text-dim)' }}>{isArr ? ']' : '}'}</div>
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
        <div style={{ padding: '10px 16px 0', fontSize: 11.5, color: 'var(--amber)' }}>Not valid JSON ({parsed.error}) — showing the source.</div>
        <CodeView text={text} />
      </div>
    );
  }
  return <div data-testid="json-tree" style={{ ...mono, fontSize: 12.5, lineHeight: 1.7, padding: '14px 16px' }}><JsonValue value={parsed.value} depth={0} openDepth={openDepth} /></div>;
}

// ------------------------------------------------------------------ code

export function CodeView({ text, wrap = false }: { text: string; wrap?: boolean }) {
  const lines = useMemo(() => text.replace(/\n$/, '').split('\n'), [text]);
  const gutter = String(lines.length).length;
  return (
    <div style={{ ...mono, fontSize: 12.5, lineHeight: 1.7, padding: '12px 0', overflowX: wrap ? 'hidden' : 'auto' }}>
      {lines.map((l, i) => (
        <div key={i} style={{ display: 'flex', minWidth: wrap ? 0 : 'max-content' }}>
          <span aria-hidden style={{ flex: 'none', width: `${gutter + 2}ch`, textAlign: 'right', paddingRight: 12, color: 'var(--text-faint)', userSelect: 'none', opacity: 0.7 }}>{i + 1}</span>
          <span style={{ flex: 1, paddingRight: 16, color: 'var(--text-dim)', whiteSpace: wrap ? 'pre-wrap' : 'pre', wordBreak: wrap ? 'break-word' : undefined }}>{l || ' '}</span>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ body

/** The read-only body of a file, by kind. `raw` shows text kinds as source. */
export function ArtifactBody({ kind, preview, name, transcript, raw }: { kind: ViewKind; preview: FilePreview; name: string; transcript?: string | null; raw?: boolean }) {
  const text = preview.text ?? '';
  const truncated = preview.truncated ? <div style={{ padding: '0 16px 14px', fontSize: 11.5, color: 'var(--text-faint)' }}>…truncated — the file is larger than the preview.</div> : null;
  if (raw && preview.text !== undefined) return <><CodeView text={text} wrap={kind === 'markdown' || kind === 'text'} />{truncated}</>;
  switch (kind) {
    case 'markdown':
      return <><div style={{ padding: '18px 22px', maxWidth: 820, fontSize: 14, lineHeight: 1.6 }}><Markdown text={text} /></div>{truncated}</>;
    case 'csv':
    case 'tsv':
      return <><CsvTable text={text} sep={kind === 'tsv' ? '\t' : ','} />{truncated}</>;
    case 'json':
      return preview.truncated ? <><CodeView text={text} />{truncated}</> : <JsonTree text={text} />;
    case 'code':
      return <><CodeView text={text} />{truncated}</>;
    case 'text':
      return <><CodeView text={text} wrap />{truncated}</>;
    case 'image':
      return preview.base64 ? <div style={{ padding: 22 }}><img src={`data:${preview.contentType};base64,${preview.base64}`} alt={name} style={{ maxWidth: '100%', borderRadius: 8 }} /></div> : <Binary size={preview.size} />;
    case 'audio':
      return (
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
      );
    case 'pdf':
      // A data: URL is already opaque-origin, but the sandbox attribute is
      // the invariant we state everywhere — no frame without it.
      return preview.base64 ? <iframe title={name} sandbox="allow-scripts" src={`data:application/pdf;base64,${preview.base64}`} style={{ width: '100%', height: '100%', minHeight: 420, border: 'none' }} /> : <Binary size={preview.size} />;
    case 'html':
      // Sandboxed, no network (FR-13.1): opaque origin from srcDoc +
      // allow-scripts, and sealHtml's CSP is what actually denies fetch.
      return preview.text ? <iframe title={name} sandbox="allow-scripts" srcDoc={sealHtml(preview.text)} style={{ width: '100%', height: '100%', minHeight: 420, border: 'none', background: '#fff' }} /> : <Binary size={preview.size} />;
    default:
      return <Binary size={preview.size} />;
  }
}

const Binary = ({ size }: { size: number }) => <div style={{ padding: 22, fontSize: 13, color: 'var(--text-faint)' }}>Binary file · {size} bytes</div>;

// ---------------------------------------------------------------- editor

/** In-place editor for text kinds. Save sends the version it started from;
 *  a 409 shows the conflict banner — Reload takes theirs, Overwrite keeps
 *  mine and writes without the check. */
export function FileEditor({ text, version, onSave, onReload, onCancel, remoteNote }: {
  text: string;
  version?: number;
  onSave: (text: string, expectedVersion: number | undefined) => Promise<void>;
  onReload: () => Promise<{ text: string; version?: number }>;
  onCancel: () => void;
  /** "Ada just edited this" while the editor is open (live event). */
  remoteNote?: string | null;
}) {
  const [draft, setDraft] = useState(text);
  const [base, setBase] = useState<number | undefined>(version);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (expected: number | undefined) => {
    setBusy(true); setError(null);
    try {
      await onSave(draft, expected);
      setConflict(null);
    } catch (e) {
      if (isConflict(e)) setConflict(parseConflict(e));
      else setError(e instanceof Error ? e.message.slice(0, 160) : 'Could not save');
    } finally { setBusy(false); }
  };
  const reload = async () => {
    setBusy(true);
    try {
      const latest = await onReload();
      setDraft(latest.text); setBase(latest.version); setConflict(null);
    } catch (e) { setError(e instanceof Error ? e.message.slice(0, 160) : 'Could not reload'); } finally { setBusy(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {conflict && (
        <div role="alert" data-testid="conflict-banner" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 14px', background: 'color-mix(in oklab,var(--amber) 12%,var(--panel))', borderBottom: '1px solid var(--amber)', fontSize: 12.5 }}>
          <span style={{ flex: '1 1 220px', color: 'var(--text)' }}>
            <b>{conflict.by ?? 'Someone'}</b> saved this file{conflict.version !== undefined ? ` (version ${conflict.version})` : ''} while you were editing. Reload to take their version, or overwrite it with yours.
          </span>
          <button type="button" disabled={busy} onClick={() => void reload()} style={btn}>Reload</button>
          <button type="button" disabled={busy} onClick={() => void save(undefined)} style={{ ...btn, borderColor: 'var(--amber)', color: 'var(--amber)' }}>Overwrite</button>
        </div>
      )}
      {!conflict && remoteNote && (
        <div style={{ flex: 'none', padding: '7px 14px', background: 'var(--panel-2)', borderBottom: '1px solid var(--border-soft)', fontSize: 12, color: 'var(--text-dim)' }}>{remoteNote} — saving will ask before overwriting.</div>
      )}
      {error && <div role="status" style={{ flex: 'none', padding: '7px 14px', fontSize: 12, color: 'var(--red)', borderBottom: '1px solid var(--border-soft)' }}>{error}</div>}
      <textarea aria-label="File contents" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); if (!busy) void save(base); } }}
        style={{ flex: 1, minHeight: 240, width: '100%', boxSizing: 'border-box', resize: 'none', border: 'none', outline: 'none', background: 'var(--code)', color: 'var(--text)', ...mono, fontSize: 12.5, lineHeight: 1.7, padding: '14px 16px' }} />
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', borderTop: '1px solid var(--border)', background: 'var(--panel)' }}>
        <span style={{ fontSize: 11, color: 'var(--text-faint)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {base !== undefined ? `Editing version ${base}` : 'Editing'}{draft !== text ? ' · unsaved changes' : ''}
        </span>
        <button type="button" disabled={busy} onClick={onCancel} style={btn}>Cancel</button>
        <button type="button" disabled={busy} onClick={() => void save(base)} style={primaryBtn}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

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
    <aside aria-label="History" style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: stacked ? '100%' : 360, maxWidth: '100%', background: 'var(--elev)', borderLeft: '1px solid var(--border)', boxShadow: 'var(--shadow)', zIndex: 20, display: 'flex', flexDirection: 'column', animation: 'msgIn .12s' }}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '11px 14px', borderBottom: '1px solid var(--border)' }}>
        <span style={{ fontWeight: 600, fontSize: 13.5, flex: 1 }}>{viewing ? `Version ${viewing.version}` : 'History'}</span>
        {viewing && <button type="button" onClick={() => setViewing(null)} style={btn}>Back</button>}
        <button type="button" aria-label="Close history" onClick={onClose} style={{ ...btn, padding: '6px 9px' }}>✕</button>
      </div>
      {viewing ? (
        <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ flex: 1, overflow: 'auto', background: 'var(--code)' }}>
            {viewing.preview === null ? <div style={{ padding: 16, fontSize: 12.5, color: 'var(--text-faint)' }}>Loading…</div>
              : viewing.preview.text !== undefined ? <CodeView text={viewing.preview.text} wrap />
                : <div style={{ padding: 16, fontSize: 12.5, color: 'var(--text-faint)' }}>Binary revision · {viewing.preview.size} bytes</div>}
          </div>
          {source.restore && <div style={{ flex: 'none', padding: 12, borderTop: '1px solid var(--border)' }}><button type="button" disabled={busy} onClick={() => void restore(viewing.version)} style={primaryBtn}>Restore this version</button></div>}
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
          {currentVersion !== undefined && (
            <div style={{ padding: '8px 10px', fontSize: 12, color: 'var(--text-dim)' }}>Current: <b style={{ color: 'var(--text)' }}>version {currentVersion}</b></div>
          )}
          {revs === null && <div style={{ padding: 12, fontSize: 12.5, color: 'var(--text-faint)' }}>Loading…</div>}
          {revs?.length === 0 && !err && <div style={{ padding: 12, fontSize: 12.5, color: 'var(--text-faint)' }}>No earlier versions yet. Every overwrite keeps the previous text here (the last 20).</div>}
          {err && <div style={{ padding: 12, fontSize: 12, color: 'var(--red)' }}>{err}</div>}
          {revs?.map((r) => (
            <div key={r.version} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 9, border: '1px solid var(--border-soft)', background: 'var(--panel)', marginBottom: 6 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600 }}>Version {r.version}</div>
                <div style={{ fontSize: 11, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {[r.updatedBy?.name, relTime(r.updatedAt), `${(r.size / 1024).toFixed(1)}K`].filter(Boolean).join(' · ')}
                </div>
              </div>
              {source.revision && <button type="button" onClick={() => view(r.version)} style={btn}>View</button>}
              {source.restore && <button type="button" disabled={busy} onClick={() => void restore(r.version)} style={btn}>Restore</button>}
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
