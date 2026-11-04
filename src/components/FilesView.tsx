/** Artifacts main pane (docs/filesystem.md): the selected workspace/agent
 *  file as a page — breadcrumbs and a compact actions menu above, the owner,
 *  last editor and version over a reading column — with in-place editing
 *  (autosave, the version check, the conflict flow), history, task boxes
 *  that write back, and live refresh when someone else saves. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { I, P } from '../lib/icons';
import { useApp } from '../store';
import type { Agent, FileEntry, FilePreview } from '../lib/api';
import {
  authorName, childrenOf, isConflict, isTextKind, normPath, ownerOf, relTime, viewKind, workspaceSource, agentSource,
  createFile, createFolder, newPageText, takeFreshFile, type FileSource, type ViewKind,
} from '../lib/artifacts';
import { generatedNote, toggleTaskLine } from '../lib/markdownText';
import { companyRef, routeHref } from '../lib/routes';
import type { SaveStatus } from '../lib/useDocSave';
import { ArtifactBody, HistoryDrawer, fmtSize } from './ArtifactViewer';
import { FileEditor, type EditorControl } from './FileEditor';
import { FileIcon } from './FileIcon';
import { AgentAvatar } from './ArtifactTree';

const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** Why this file opens read-only, if it does (docs/filesystem.md "Permissions"). */
export function readOnlyReason(path: string, kind: ViewKind | null, preview: FilePreview | null, role: string | undefined): string | null {
  const parts = path.split('/');
  if (parts.includes('.checkpoints')) return 'An agent checkpoint — a read-only snapshot of its home. Restore from History instead.';
  if (parts.includes('.revisions')) return 'A kept revision — read-only.';
  if (role === 'viewer') return 'You can view this workspace but not edit its files.';
  if (!kind || !isTextKind(kind) || !preview || preview.text === undefined) return null;
  if (preview.truncated) return `Too large to edit here (${fmtSize(preview.size)}) — saving the preview would cut the file.`;
  return null;
}

const STATUS_TEXT: Record<SaveStatus, string> = { saved: 'Saved', unsaved: 'Unsaved changes', saving: 'Saving…', conflict: 'Not saved — newer version', error: 'Not saved' };

export interface ArtifactPaneProps {
  source: FileSource;
  entries: FileEntry[];
  path: string | null;
  onOpen: (path: string | null) => void;
  /** Re-list the tree after a write/move/delete. */
  onChanged: () => void | Promise<void>;
  /** Also re-list on `file.changed` events (when nobody else does). */
  refreshOnEvents?: boolean;
  /** Breadcrumb root: paths under it show relative (an agent's home). */
  root?: string;
  rootLabel: string;
  /** The owner when the whole source is one agent's home. */
  ownerAgent?: Agent | null;
  onBack?: () => void;
  onAttach?: (path: string) => void;
  /** The shareable address of a file (Copy link). */
  linkFor?: (path: string) => string;
  empty: ReactNode;
  extraActions?: (path: string, preview: FilePreview | null) => ReactNode;
  /** Inside a card (agent tab) rather than the main pane. */
  embedded?: boolean;
  /** Autosave delay (tests). */
  saveDelay?: number;
}

export function ArtifactPane({ source, entries, path, onOpen, onChanged, refreshOnEvents, root = '', rootLabel, ownerAgent, onBack, onAttach, linkFor, empty, extraActions, embedded, saveDelay }: ArtifactPaneProps) {
  const app = useApp();
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [failed, setFailed] = useState(false);
  /** Voice notes (docs/voice.md): the transcript sidecar, when one exists. */
  const [transcript, setTranscript] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [override, setOverride] = useState(false);
  const [raw, setRaw] = useState(false);
  const [history, setHistory] = useState(false);
  const [menu, setMenu] = useState(false);
  const [folder, setFolder] = useState<string | null>(null);
  const [remoteNote, setRemoteNote] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>('saved');
  const [tick, setTick] = useState(0);
  const editAfterLoad = useRef<string | null>(null);
  const savedVersion = useRef<number | undefined>(undefined);
  const ctl = useRef<EditorControl | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const live = useRef({ path, editing, me: app.me?.actorId, onChanged, refreshOnEvents });
  live.current = { path, editing, me: app.me?.actorId, onChanged, refreshOnEvents };

  useEffect(() => { setEditing(false); setOverride(false); setRaw(false); setHistory(false); setMenu(false); setFolder(null); setRemoteNote(null); setStatus('saved'); }, [path, source.key]);

  useEffect(() => {
    let off = false;
    setFailed(false);
    if (!path) { setPreview(null); setTranscript(null); return; }
    void source.preview(path).then((p) => {
      if (off) return;
      setPreview(p);
      if (editAfterLoad.current === path || takeFreshFile(source.key, path)) { editAfterLoad.current = null; setEditing(true); }
      if (p.kind === 'audio') {
        void source.preview(`${path}.transcript.txt`)
          .then((t) => { if (!off) setTranscript((t.text ?? '').replace(/^# duration: \d+s\n/, '').trim() || null); })
          .catch(() => { if (!off) setTranscript(null); });
      } else setTranscript(null);
    }).catch(() => { if (!off) { setPreview(null); setFailed(true); } });
    return () => { off = true; };
  }, [source, path, tick]);
  // Clear the old body only when the file itself changes, not on a refresh.
  useEffect(() => { setPreview(null); setTranscript(null); }, [path, source.key]);

  // Close the menu on an outside click or Escape.
  useEffect(() => {
    if (!menu) return;
    const down = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [menu]);

  // Live: "Ada edited plan.md" (docs/filesystem.md "Activity").
  useEffect(() => {
    if (!source.workspaceId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const offFn = app.onWorkspaceEvent((ev) => {
      if (ev.type !== 'file.changed' && ev.type !== 'file_changed') return;
      const local = source.fromWorkspacePath(ev.path);
      if (local === null) return;
      const cur = live.current;
      if (cur.refreshOnEvents) { clearTimeout(timer); timer = setTimeout(() => void cur.onChanged(), 400); }
      if (local !== cur.path) return;
      const by = ev.by;
      const mine = (typeof by === 'object' && by !== null && by.kind === 'user' && by.id === cur.me)
        || (ev.version !== undefined && ev.version === savedVersion.current);
      if (mine) return;
      const who = authorName(by);
      if (cur.editing && ctl.current) {
        void ctl.current.remoteChanged().then((r) => {
          if (r === 'kept') setRemoteNote(`${who} just edited this`);
          else app.showToast(`${who} edited ${local.split('/').pop()} — showing their version`);
        });
        return;
      }
      setTick((t) => t + 1);
      app.showToast(`${who} edited ${local.split('/').pop()}`);
    });
    return () => { offFn(); clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, app.onWorkspaceEvent]);

  const entry = useMemo(() => (path ? entries.find((e) => normPath(e.path) === path) : undefined), [entries, path]);
  const toast = app.showToast;
  const newFile = useCallback(async (dir: string) => {
    const p = await createFile(source, dir, toast, newPageText);
    if (!p) return;
    await onChanged();
    editAfterLoad.current = p;
    onOpen(p);
  }, [source, toast, onChanged, onOpen]);
  const newFolder = useCallback(async (dir: string) => {
    const p = await createFolder(source, dir, toast);
    if (!p) return;
    await onChanged();
    setFolder(p);
  }, [source, toast, onChanged]);

  // --------------------------------------------------- crumbs / folder view
  const base = normPath(root);
  const shownPath = folder ?? path ?? '';
  const rel = base && shownPath.startsWith(`${base}/`) ? shownPath.slice(base.length + 1) : shownPath === base ? '' : shownPath;
  const segs = rel ? rel.split('/') : [];
  const crumbs = (
    <nav aria-label="Breadcrumbs" className="art-crumbs">
      <button type="button" onClick={() => setFolder(base)}>{rootLabel}</button>
      {segs.map((s, i) => {
        const last = i === segs.length - 1 && folder === null;
        const target = [base, ...segs.slice(0, i + 1)].filter(Boolean).join('/');
        return (
          <span key={target} style={{ display: 'contents' }}>
            <span className="sep" aria-hidden>/</span>
            {last ? <span className="here" aria-current="page">{s}</span> : <button type="button" onClick={() => setFolder(target)}>{s}</button>}
          </span>
        );
      })}
    </nav>
  );
  const backBtn = onBack && (
    <button type="button" aria-label="Back" onClick={onBack} className="art-btn icon"><I d={P.chevL} size={18} /></button>
  );

  if (!path && folder === null) return <>{empty}</>;

  if (folder !== null) {
    const kids = childrenOf(entries, folder).filter((k) => !base || k.path.startsWith(`${base}/`) || k.path === base);
    return (
      <div className="art-page">
        <header className={`art-bar${embedded ? ' embedded' : ''}`}>
          <button type="button" aria-label="Back to file" onClick={() => (path ? setFolder(null) : onOpen(null))} className="art-btn icon"><I d={P.chevL} size={18} /></button>
          {crumbs}
          <button type="button" onClick={() => void newFile(folder)} className="art-btn" title="New page here"><I d={P.plus} size={14} />{!app.stacked && 'New page'}</button>
          <button type="button" onClick={() => void newFolder(folder)} className="art-btn" title="New folder here"><I d={P.folder} size={14} />{!app.stacked && 'Folder'}</button>
        </header>
        <div className="art-scroll">
          <div className="doc-page doc-wide"><div className="doc-cols"><div className="doc-main">
            <h1 className="doc-title" style={{ fontSize: 26 }}>{folder === base ? rootLabel : folder.split('/').pop()}</h1>
            <div role="list" className="ftree">
              {kids.map((k) => (
                <div key={k.path} role="listitem" tabIndex={0} className="ftree-row" style={{ height: 40, margin: '0 0 2px', paddingLeft: 10 }}
                  onClick={() => (k.isFolder ? setFolder(k.path) : (setFolder(null), onOpen(k.path)))}
                  onKeyDown={(e) => { if (e.key === 'Enter') { if (k.isFolder) setFolder(k.path); else { setFolder(null); onOpen(k.path); } } }}>
                  <span className="ico"><FileIcon name={k.name} folder={k.isFolder} /></span>
                  <span className="name" style={{ fontSize: 14, color: 'var(--text)' }}>{k.name}</span>
                  {!k.isFolder && k.entry && <span style={{ fontSize: 12, color: 'var(--text-faint)', flex: 'none' }}>{[k.entry.updatedBy?.name, relTime(k.entry.lastModified)].filter(Boolean).join(', ')}</span>}
                </div>
              ))}
              {kids.length === 0 && <div className="art-notice"><span>This folder is empty. Add a page to start it.</span></div>}
            </div>
          </div></div></div>
        </div>
      </div>
    );
  }

  const p = path!;
  const name = p.split('/').pop()!;
  const kind = preview ? viewKind(name, preview) : null;
  const locked = readOnlyReason(p, kind, preview, app.me?.role);
  const generated = kind === 'markdown' && preview?.text ? generatedNote(preview.text) : null;
  const textEditable = !!kind && isTextKind(kind) && preview?.text !== undefined && !locked;
  const canEdit = textEditable && (!generated || override);
  const canRaw = kind === 'markdown' || kind === 'csv' || kind === 'tsv' || kind === 'json' || kind === 'html';
  const owner = ownerAgent ?? ownerOf(p, app.agents, entry);
  const version = preview?.version ?? entry?.version;
  const editor = preview?.updatedBy ?? entry?.updatedBy ?? null;
  const when = relTime(preview?.updatedAt ?? entry?.lastModified);

  const afterSave = (v: number | undefined, text: string) => {
    savedVersion.current = v;
    setPreview((cur) => (cur ? { ...cur, text, version: v ?? cur.version, size: new TextEncoder().encode(text).length } : cur));
    setRemoteNote(null);
    void onChanged();
  };
  const done = async () => {
    const ok = await (ctl.current?.flush() ?? Promise.resolve(true));
    if (!ok) return;
    setEditing(false); setRemoteNote(null);
    setTick((t) => t + 1);
  };
  const toggleTask = async (line: number, checked: boolean) => {
    if (!preview?.text || (!canEdit && !(generated && textEditable))) return;
    const next = toggleTaskLine(preview.text, line, checked);
    if (next === null) return;
    const prev = preview;
    setPreview({ ...preview, text: next });
    try {
      const r = await source.write(p, next, preview.version);
      afterSave(r?.version, next);
    } catch (e) {
      setPreview(prev);
      if (isConflict(e)) { app.showToast('Someone saved this file meanwhile — showing their version; tick again.'); setTick((t) => t + 1); } else app.showToast(e instanceof Error ? e.message.slice(0, 120) : 'Could not save');
    }
  };
  const rename = async () => {
    if (!source.move) return;
    const to = normPath(window.prompt('Move or rename to', p) ?? '');
    if (!to || to === p) return;
    try { await source.move(p, to); await onChanged(); onOpen(to); app.showToast(`Moved to ${to}`); } catch (e) { app.showToast(e instanceof Error ? e.message.slice(0, 120) : 'Move failed'); }
  };
  const remove = async () => {
    if (!source.remove) return;
    if (!window.confirm(`Delete ${name}? Its history is kept, and you can restore it.`)) return;
    try { await source.remove(p); await onChanged(); onOpen(null); app.showToast(`Deleted ${name}`); } catch (e) { app.showToast(e instanceof Error ? e.message.slice(0, 120) : 'Delete failed'); }
  };
  const copyLink = () => {
    const href = linkFor ? `${window.location.origin}${linkFor(p)}` : window.location.href.split('#')[0];
    void navigator.clipboard?.writeText(href).then(() => app.showToast('Link copied'), () => app.showToast(href));
  };
  const download = () => {
    if (!preview) return;
    const blob = preview.base64
      ? new Blob([Uint8Array.from(atob(preview.base64), (c) => c.charCodeAt(0))], { type: preview.contentType })
      : new Blob([preview.text ?? ''], { type: preview.contentType || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const item = (label: string, fn: () => void, icon?: string[], danger = false, hint?: string) => (
    <button type="button" role="menuitem" className={danger ? 'danger' : undefined} onClick={() => { setMenu(false); fn(); }}>
      {icon ? <I d={icon} size={14} /> : <span style={{ width: 14 }} />}{label}{hint && <span className="hint">{hint}</span>}
    </button>
  );

  const meta = (
    <div className="doc-meta" data-testid="artifact-meta">
      {owner
        ? <span className="who"><AgentAvatar agent={owner} size={18} />{owner.name}</span>
        : <span className="chip">Shared</span>}
      {(editor || when) && <span>{editor ? `Edited by ${editor.name}` : 'Updated'}{when ? `, ${when}` : ''}</span>}
      {version !== undefined && <span className="chip ver" title="Every save makes a new version; History keeps the last 20">v{version}</span>}
      {locked && <span className="chip warn" title={locked}>Read-only</span>}
      {!locked && generated && <span className="chip warn" title={generated}>Generated</span>}
    </div>
  );
  const notice = locked && kind && isTextKind(kind) ? <div className="art-notice" role="note"><span>{locked}</span></div>
    : generated && !override ? (
      <div className="art-notice warn" role="note">
        <span>{generated}</span>
        {textEditable && <button type="button" className="art-btn solid" onClick={() => { setOverride(true); setEditing(true); }}>Edit anyway</button>}
      </div>
    ) : null;

  return (
    <div className="art-page">
      <header className={`art-bar${embedded ? ' embedded' : ''}`}>
        {backBtn}
        {crumbs}
        {editing && <span className="art-status" data-state={status} role="status" aria-live="polite" data-testid="save-status">{STATUS_TEXT[status]}</span>}
        {editing
          ? <button type="button" className="art-btn primary" onClick={() => void done()} disabled={status === 'conflict'}>Done</button>
          : canEdit && <button type="button" className="art-btn solid" onClick={() => setEditing(true)} title="Edit"><I d={P.edit} size={13} />Edit</button>}
        {!editing && source.revisions && <button type="button" className="art-btn icon" aria-label="History" title="History" onClick={() => setHistory(!history)}><I d={P.clock} size={15} /></button>}
        {!editing && extraActions?.(p, preview)}
        <div ref={menuRef} style={{ position: 'relative', flex: 'none' }}>
          <button type="button" aria-label="More actions" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)} className="art-btn icon"><I d={P.dots} size={16} fill="currentColor" /></button>
          {menu && (
            <div role="menu" className="art-menu">
              {canEdit && !editing && item('Edit', () => setEditing(true), P.edit)}
              {source.revisions && item('History', () => setHistory(true), P.clock)}
              {canRaw && !editing && item(raw ? 'Show formatted' : 'Show source', () => setRaw(!raw), P.sysLines)}
              {item('Copy link', copyLink, P.attach)}
              {onAttach && item('Attach to chat', () => onAttach(p), P.chat)}
              {preview && item('Download', download, P.download)}
              {kind === 'html' && preview?.text && item('Open preview', () => app.openArtifact(name, preview.text!), P.panel)}
              <hr />
              {item('New page here', () => void newFile(dirOf(p) || base), P.plus)}
              {item('New folder here', () => void newFolder(dirOf(p) || base), P.folder)}
              {item('Show folder', () => setFolder(dirOf(p) || base), P.files)}
              {source.move && !locked && item('Rename or move…', () => void rename(), P.edit)}
              {source.remove && !locked && item('Delete', () => void remove(), P.x, true)}
            </div>
          )}
        </div>
      </header>
      <div className="art-scroll" style={kind === 'html' || kind === 'pdf' ? { overflow: editing ? 'auto' : 'hidden', display: 'flex', flexDirection: 'column' } : undefined}>
        {failed && <div className="doc-page"><div className="doc-cols"><div className="doc-main"><div className="art-notice warn"><span>Could not load this file — it may have been moved or deleted.</span></div></div></div></div>}
        {!failed && preview === null && <div className="doc-page" aria-busy="true"><div className="doc-cols"><div className="doc-main" style={{ color: 'var(--text-faint)', fontSize: 13 }}>Loading…</div></div></div>}
        {preview && kind && (editing && canEdit
          ? <FileEditor key={p} kind={kind} name={name} text={preview.text ?? ''} version={preview.version ?? version}
              save={(text, expected) => source.write(p, text, expected)} load={() => source.preview(p)}
              onSaved={afterSave} onStatus={setStatus} ctl={ctl} meta={meta} remoteNote={remoteNote}
              title={kind === 'markdown' ? name.replace(/\.(md|markdown|mdx)$/i, '') : name} delay={saveDelay} />
          : <ArtifactBody kind={kind} preview={preview} name={name} transcript={transcript} raw={raw} meta={meta} top={notice}
              onToggleTask={canEdit || (generated && textEditable) ? (line, checked) => void toggleTask(line, checked) : undefined} />)}
      </div>
      {history && (
        <HistoryDrawer source={source} path={p} currentVersion={version} stacked={app.stacked}
          onRestored={(v) => { setHistory(false); setTick((t) => t + 1); void onChanged(); app.showToast(`Restored version ${v}`); }}
          onClose={() => setHistory(false)} />
      )}
    </div>
  );
}

/** The main pane for `app.fileTarget` / `app.currentFile`. */
export function FilesView() {
  const app = useApp();
  const target = app.fileTarget;
  const agent = target?.kind === 'agent' ? app.agents.find((a) => a.id === target.id) ?? null : null;
  const source = useMemo(() => (!target ? null : target.kind === 'workspace' ? workspaceSource(target.id) : agentSource(target.id, app.workspaceId || undefined, agent?.homeDir)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [target?.kind, target?.id, app.workspaceId, agent?.homeDir]);
  const onOpen = useCallback((p: string | null) => { if (target) app.openFile(target, p); }, [app, target]);

  const empty = (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, color: 'var(--text-faint)', padding: 40, background: 'var(--bg)' }}>
      <div style={{ width: 56, height: 56, borderRadius: 15, background: 'var(--panel-2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <I d={P.folder} size={26} sw={1.6} />
      </div>
      <div style={{ textAlign: 'center', maxWidth: 380 }}>
        <div style={{ fontSize: 16, fontWeight: 650, color: 'var(--text)' }}>{agent ? `${agent.name}'s artifacts` : 'Artifacts'}</div>
        <div style={{ fontSize: 13.5, marginTop: 6, lineHeight: 1.55 }}>
          {agent
            ? 'The agent\'s home — LESSONS.md, JOURNAL.md, knowledge/ and whatever it builds. Select a file to read it.'
            : 'One tree for the workspace: shared folders people and agents build together, and each agent\'s home. Select a file to read, edit, or see its history.'}
        </div>
      </div>
      {source && (
        <button type="button" className="art-btn solid" onClick={() => void createFile(source, '', app.showToast, newPageText).then(async (p) => { if (p) { await app.refreshFiles(); onOpen(p); } })}>
          <I d={P.plus} size={13} />New page
        </button>
      )}
    </div>
  );
  if (!source || !target) return empty;
  return (
    <ArtifactPane
      source={source}
      entries={app.fileList}
      path={app.currentFile}
      onOpen={onOpen}
      onChanged={app.refreshFiles}
      rootLabel={agent ? agent.name : 'Artifacts'}
      ownerAgent={agent}
      onBack={app.stacked ? () => { app.setCurrentFile(null); app.setMobileChatOpen(false); } : undefined}
      onAttach={target.kind === 'workspace' ? (p) => { app.addAttachment(p); app.setHomeView('chat'); app.setMobileChatOpen(true); app.showToast(`Attached ${p.split('/').pop()} to composer`); } : undefined}
      linkFor={target.kind === 'workspace' ? (p) => routeHref({ company: companyRef(target.id), place: { kind: 'artifacts', path: p } }) : undefined}
      empty={empty}
    />
  );
}
