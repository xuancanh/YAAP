/**
 * Editing a file in place (docs/filesystem.md "Editing"): the right editor
 * for the kind — the WYSIWYG Markdown editor, CodeMirror for code, text and
 * JSON, the grid for CSV/TSV — with autosave, the version-checked write and
 * the non-destructive conflict flow (keep mine / take theirs, with a diff).
 * The heavy editors are separate chunks, fetched on first use.
 */
import { lazy, Suspense, useEffect, useMemo, useState, type MutableRefObject, type ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import { useDocSave, type DocConflict, type SaveStatus } from '../lib/useDocSave';
import { lineDiff, withContext } from '../lib/lineDiff';
import { splitNotes } from '../lib/markdownText';
import type { FileAuthor } from '../lib/api';
import type { ViewKind } from '../lib/artifacts';
import { CsvGrid } from './CsvGrid';
import { DocView } from './DocView';

const MarkdownEditor = lazy(() => import('./editor/MarkdownEditor'));
const CodeEditor = lazy(() => import('./editor/CodeEditor'));

export interface EditorControl {
  flush: () => Promise<boolean>;
  dirty: () => boolean;
  remoteChanged: () => Promise<'refreshed' | 'kept'>;
}

export function ConflictPanel({ conflict, busy, onKeepMine, onTakeTheirs }: { conflict: DocConflict; busy?: boolean; onKeepMine: () => void; onTakeTheirs: () => void }) {
  const [open, setOpen] = useState(true);
  const diff = useMemo(() => withContext(lineDiff(conflict.theirs.text, conflict.mine)), [conflict]);
  const who = conflict.theirs.by ?? 'Someone';
  return (
    <div className="conflict" role="alert" data-testid="conflict-banner">
      <div className="conflict-head">
        <span><b>{who}</b> saved a newer version{conflict.theirs.version !== undefined ? ` (version ${conflict.theirs.version})` : ''} while you were editing. Your changes are not saved yet — keep yours, or take theirs.</span>
        <button type="button" className="art-btn" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide changes' : 'Show changes'}</button>
        <button type="button" className="art-btn solid" disabled={busy} onClick={onTakeTheirs}>Take theirs</button>
        <button type="button" className="art-btn primary" disabled={busy} onClick={onKeepMine}>Keep mine</button>
      </div>
      {open && (
        <>
          <div className="conflict-diff" data-testid="conflict-diff">
            {diff.map((l, i) => ('count' in l
              ? <div key={i} className="skip">{l.count} unchanged line{l.count === 1 ? '' : 's'}</div>
              : <div key={i} className={l.kind}>{l.text || ' '}</div>))}
          </div>
          <div className="conflict-legend"><span><span style={{ color: 'var(--red)' }}>−</span> only in theirs</span><span><span style={{ color: 'var(--green)' }}>+</span> only in yours</span></div>
        </>
      )}
    </div>
  );
}

const fallback = <div style={{ padding: '24px 0', fontSize: 13, color: 'var(--text-faint)' }}>Loading the editor…</div>;

export interface FileEditorProps {
  kind: ViewKind;
  name: string;
  text: string;
  version?: number;
  save: (text: string, expectedVersion: number | undefined) => Promise<{ version?: number }>;
  load: () => Promise<{ text?: string; version?: number; updatedBy?: FileAuthor | null }>;
  onSaved?: (version: number | undefined, text: string) => void;
  onStatus?: (s: SaveStatus) => void;
  ctl?: MutableRefObject<EditorControl | null>;
  /** The page's meta line. */
  meta?: ReactNode;
  /** "Ada just edited this" while my draft has changes. */
  remoteNote?: string | null;
  title?: string;
  delay?: number;
  /** Tests reach the TipTap editor through this. */
  onMarkdownReady?: (editor: Editor, toMarkdown: () => string) => void;
}

export function FileEditor({ kind, name, text, version, save, load, onSaved, onStatus, ctl, meta, remoteNote, title, delay, onMarkdownReady }: FileEditorProps) {
  const doc = useDocSave({ initialText: text, initialVersion: version, save, load, onSaved, delay });
  const [busy, setBusy] = useState(false);
  const [showHead, setShowHead] = useState(false);
  useEffect(() => { onStatus?.(doc.status); }, [doc.status, onStatus]);
  useEffect(() => {
    if (ctl) ctl.current = { flush: doc.flush, dirty: doc.dirty, remoteChanged: doc.remoteChanged };
    return () => { if (ctl) ctl.current = null; };
  }, [ctl, doc.flush, doc.dirty, doc.remoteChanged]);
  // leaving the page saves what is pending
  useEffect(() => () => { void doc.flush(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const current = doc.content.text;
  const notes = kind === 'markdown' ? splitNotes(current) : null;
  const editable = notes ? notes.tail : current;
  const change = doc.change;
  const onChange = useMemo(() => (notes ? (get: () => string) => change(() => notes.head + get()) : change), [notes?.head, change]); // eslint-disable-line react-hooks/exhaustive-deps
  const flush = () => void doc.flush();

  const top = (
    <>
      {doc.conflict && (
        <ConflictPanel conflict={doc.conflict} busy={busy}
          onKeepMine={() => { setBusy(true); void doc.keepMine().finally(() => setBusy(false)); }}
          onTakeTheirs={doc.takeTheirs} />
      )}
      {doc.status === 'error' && doc.error && (
        <div className="art-notice warn" role="status"><span>Not saved: {doc.error}</span><button type="button" className="art-btn solid" onClick={flush}>Try again</button></div>
      )}
      {!doc.conflict && remoteNote && <div className="art-notice" role="status"><span>{remoteNote} — your changes are kept; saving will ask before overwriting theirs.</span></div>}
    </>
  );

  if (kind === 'markdown') {
    const headTitled = /^\s*# /.test(notes ? notes.head : editable);
    return (
      <div className="doc-page">
        <div className="doc-cols"><div className="doc-main">
          {top}
          {meta}
          {notes ? (
            <>
              <div className="art-notice">
                <span>The part above the Notes line is generated by the server and rewritten when the company changes; you are editing the notes below it.</span>
                <button type="button" className="art-btn" aria-expanded={showHead} onClick={() => setShowHead(!showHead)}>{showHead ? 'Hide generated part' : 'Show generated part'}</button>
              </div>
              {showHead && <div style={{ opacity: 0.72, marginBottom: 8 }}><DocView text={notes.head} compact /></div>}
              {!showHead && headTitled && <h1 className="doc-title">{/^\s*# (.*)$/m.exec(notes.head)?.[1]}</h1>}
              <div className="doc-notes-rule" role="separator">Notes — kept when the server regenerates this file</div>
            </>
          ) : !headTitled && title && <h1 className="doc-title">{title}</h1>}
          <Suspense fallback={fallback}>
            <MarkdownEditor key={doc.content.rev} text={editable} onChange={onChange} onSave={flush} onReady={onMarkdownReady} />
          </Suspense>
        </div></div>
      </div>
    );
  }

  return (
    <div className="doc-page doc-wide">
      <div className="doc-cols"><div className="doc-main">
        {top}
        {meta}
        {title && <h1 className="doc-title" style={{ fontSize: 24, marginBottom: 18 }}>{title}</h1>}
        {kind === 'csv' || kind === 'tsv'
          ? <CsvGrid key={doc.content.rev} text={current} sep={kind === 'tsv' ? '\t' : ','} onChange={change} />
          : (
            <Suspense fallback={fallback}>
              <CodeEditor key={doc.content.rev} text={current} name={name} onChange={change} onSave={flush} wrap={kind === 'text'} />
            </Suspense>
          )}
      </div></div>
    </div>
  );
}
