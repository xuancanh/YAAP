/** Artifacts main pane (docs/filesystem.md): the rich viewer for the selected
 *  workspace/agent file, with collaboration — owner, version, last editor,
 *  in-place editing with the version check, history, and live refresh. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { I, P } from '../lib/icons';
import { useApp } from '../store';
import type { Agent, FileEntry, FilePreview } from '../lib/api';
import {
  authorName, childrenOf, glyphFor, isTextKind, normPath, ownerOf, relTime, viewKind, workspaceSource, agentSource,
  createFile, createFolder, type FileSource,
} from '../lib/artifacts';
import { ArtifactBody, FileEditor, HistoryDrawer } from './ArtifactViewer';
import { btn } from './artifactStyles';
import { AgentAvatar } from './ArtifactTree';

const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

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
  empty: ReactNode;
  extraActions?: (path: string, preview: FilePreview | null) => ReactNode;
  /** Inside a card (agent tab) rather than the main pane. */
  embedded?: boolean;
}

export function ArtifactPane({ source, entries, path, onOpen, onChanged, refreshOnEvents, root = '', rootLabel, ownerAgent, onBack, onAttach, empty, extraActions, embedded }: ArtifactPaneProps) {
  const app = useApp();
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [failed, setFailed] = useState(false);
  /** Voice notes (docs/voice.md): the transcript sidecar, when one exists. */
  const [transcript, setTranscript] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState(false);
  const [history, setHistory] = useState(false);
  const [menu, setMenu] = useState(false);
  const [folder, setFolder] = useState<string | null>(null);
  const [remoteNote, setRemoteNote] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const editAfterLoad = useRef<string | null>(null);
  const savedVersion = useRef<number | undefined>(undefined);
  const live = useRef({ path, editing, me: app.me?.actorId, onChanged, refreshOnEvents });
  live.current = { path, editing, me: app.me?.actorId, onChanged, refreshOnEvents };

  useEffect(() => { setEditing(false); setRaw(false); setHistory(false); setMenu(false); setFolder(null); setRemoteNote(null); }, [path, source.key]);

  useEffect(() => {
    let off = false;
    setFailed(false);
    if (!path) { setPreview(null); setTranscript(null); return; }
    void source.preview(path).then((p) => {
      if (off) return;
      setPreview(p);
      if (editAfterLoad.current === path) { editAfterLoad.current = null; setEditing(true); }
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
      if (cur.editing) setRemoteNote(`${who} just edited this`);
      else setTick((t) => t + 1);
      app.showToast(`${who} edited ${local.split('/').pop()}`);
    });
    return () => { offFn(); clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, app.onWorkspaceEvent]);

  const entry = useMemo(() => (path ? entries.find((e) => normPath(e.path) === path) : undefined), [entries, path]);
  const toast = app.showToast;
  const newFile = useCallback(async (dir: string) => {
    const p = await createFile(source, dir, toast);
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
    <nav aria-label="Breadcrumbs" style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--mono)', minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap' }}>
      <button type="button" onClick={() => setFolder(base)} style={{ all: 'unset', cursor: 'pointer', color: 'var(--text-dim)', flex: 'none' }}>{rootLabel}</button>
      {segs.map((s, i) => {
        const last = i === segs.length - 1 && folder === null;
        const target = [base, ...segs.slice(0, i + 1)].filter(Boolean).join('/');
        return (
          <span key={target} style={{ display: 'flex', alignItems: 'center', gap: 3, minWidth: 0, flex: last ? '0 1 auto' : 'none' }}>
            <span style={{ opacity: 0.6 }}>/</span>
            {last
              ? <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{s}</span>
              : <button type="button" onClick={() => setFolder(target)} style={{ all: 'unset', cursor: 'pointer', color: 'var(--text-dim)' }}>{s}</button>}
          </span>
        );
      })}
    </nav>
  );

  if (!path && folder === null) return <>{empty}</>;

  const pad = embedded ? '9px 13px' : '11px 16px';
  if (folder !== null) {
    const kids = childrenOf(entries, folder).filter((k) => !base || k.path.startsWith(`${base}/`) || k.path === base);
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
        <header style={{ flex: 'none', borderBottom: '1px solid var(--border)', padding: pad, display: 'flex', alignItems: 'center', gap: 10, background: embedded ? 'var(--panel-2)' : 'var(--panel)' }}>
          <button type="button" aria-label="Back to file" onClick={() => (path ? setFolder(null) : onOpen(null))} style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', padding: 4, display: 'flex' }}><I d={P.chevL} size={18} /></button>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 14, fontFamily: 'var(--mono)' }}>{(folder === base ? rootLabel : folder.split('/').pop()) + '/'}</div>
            {crumbs}
          </div>
          <button type="button" onClick={() => void newFile(folder)} style={btn} title="New file here"><I d={P.plus} size={13} />{!app.stacked && 'File'}</button>
          <button type="button" onClick={() => void newFolder(folder)} style={btn} title="New folder here"><I d={P.folder} size={13} />{!app.stacked && 'Folder'}</button>
        </header>
        <div style={{ flex: 1, overflow: 'auto', padding: 10 }}>
          {kids.map((k) => (
            <div key={k.path} onClick={() => (k.isFolder ? setFolder(k.path) : (setFolder(null), onOpen(k.path)))}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 9, cursor: 'pointer', border: '1px solid var(--border-soft)', marginBottom: 6, background: 'var(--panel)' }}>
              <span style={{ fontSize: 14 }}>{glyphFor(k.name, k.isFolder)}</span>
              <span style={{ flex: 1, fontSize: 12.5, fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k.name}{k.isFolder ? '/' : ''}</span>
              {!k.isFolder && k.entry && <span style={{ fontSize: 10.5, color: 'var(--text-faint)', flex: 'none' }}>{[k.entry.updatedBy?.name, relTime(k.entry.lastModified)].filter(Boolean).join(' · ')}</span>}
            </div>
          ))}
          {kids.length === 0 && <div style={{ padding: 12, fontSize: 12.5, color: 'var(--text-faint)' }}>This folder is empty.</div>}
        </div>
      </div>
    );
  }

  const p = path!;
  const name = p.split('/').pop()!;
  const kind = preview ? viewKind(name, preview) : null;
  const readOnly = p.split('/').includes('.checkpoints');
  const canEdit = !!kind && isTextKind(kind) && preview?.text !== undefined && !preview.truncated && !readOnly;
  const canRaw = kind === 'markdown' || kind === 'csv' || kind === 'tsv' || kind === 'json' || kind === 'html';
  const owner = ownerAgent ?? ownerOf(p, app.agents, entry);
  const version = preview?.version ?? entry?.version;
  const editor = preview?.updatedBy ?? entry?.updatedBy ?? null;
  const when = relTime(preview?.updatedAt ?? entry?.lastModified);
  const icon = (label: string) => (app.stacked ? null : label);

  const save = async (text: string, expected: number | undefined) => {
    const r = await source.write(p, text, expected);
    savedVersion.current = r?.version;
    setEditing(false); setRemoteNote(null);
    setTick((t) => t + 1);
    void onChanged();
    app.showToast(`Saved ${name}`);
  };
  const reloadLatest = async () => {
    const fresh = await source.preview(p);
    setPreview(fresh); setRemoteNote(null);
    return { text: fresh.text ?? '', version: fresh.version };
  };
  const rename = async () => {
    if (!source.move) return;
    setMenu(false);
    const to = normPath(window.prompt('Move or rename to', p) ?? '');
    if (!to || to === p) return;
    try { await source.move(p, to); await onChanged(); onOpen(to); app.showToast(`Moved to ${to}`); } catch (e) { app.showToast(e instanceof Error ? e.message.slice(0, 120) : 'Move failed'); }
  };
  const remove = async () => {
    if (!source.remove) return;
    setMenu(false);
    if (!window.confirm(`Delete ${name}? Its history goes with it.`)) return;
    try { await source.remove(p); await onChanged(); onOpen(null); app.showToast(`Deleted ${name}`); } catch (e) { app.showToast(e instanceof Error ? e.message.slice(0, 120) : 'Delete failed'); }
  };
  const menuItem = (label: string, fn: () => void, danger = false) => (
    <button type="button" role="menuitem" onClick={() => { setMenu(false); fn(); }} style={{ all: 'unset', display: 'block', boxSizing: 'border-box', width: '100%', padding: '8px 11px', borderRadius: 7, cursor: 'pointer', fontSize: 12.5, color: danger ? 'var(--red)' : 'var(--text)' }}>{label}</button>
  );

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%', position: 'relative' }}>
      <header style={{ flex: 'none', borderBottom: '1px solid var(--border)', padding: pad, display: 'flex', flexDirection: 'column', gap: 6, background: embedded ? 'var(--panel-2)' : 'var(--panel)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          {onBack && (
            <button type="button" aria-label="Back" onClick={onBack} style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', padding: 4, display: 'flex', flex: 'none' }}>
              <I d={P.chevL} size={20} />
            </button>
          )}
          <span style={{ fontSize: 14, flex: 'none' }}>{glyphFor(name)}</span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 14, fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
            {crumbs}
          </div>
          <div style={{ display: 'flex', gap: 6, flex: 'none', alignItems: 'center', position: 'relative' }}>
            {canRaw && !editing && <button type="button" onClick={() => setRaw(!raw)} style={btn} title={raw ? 'Show rendered' : 'Show source'}>{raw ? 'Rendered' : 'Source'}</button>}
            {canEdit && !editing && <button type="button" onClick={() => setEditing(true)} style={btn} title="Edit"><I d={P.edit} size={13} />{icon('Edit')}</button>}
            {source.revisions && <button type="button" onClick={() => setHistory(!history)} style={btn} title="History"><I d={P.clock} size={13} />{icon('History')}</button>}
            {kind === 'html' && !app.stacked && preview?.text && (
              <button type="button" onClick={() => app.openArtifact(name, preview.text!)} style={btn}><I d={P.panel} size={13} />Open preview</button>
            )}
            {onAttach && !app.stacked && (
              <button type="button" onClick={() => onAttach(p)} style={btn}><I d={P.attach} size={13} />Attach to chat</button>
            )}
            {extraActions?.(p, preview)}
            <button type="button" aria-label="More actions" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)} style={{ ...btn, padding: '6px 9px' }}>⋯</button>
            {menu && (
              <div role="menu" style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, minWidth: 190, background: 'var(--elev)', border: '1px solid var(--border)', borderRadius: 11, boxShadow: 'var(--shadow)', zIndex: 30, padding: 5 }}>
                {kind === 'html' && app.stacked && preview?.text && menuItem('Open preview', () => app.openArtifact(name, preview.text!))}
                {onAttach && app.stacked && menuItem('Attach to chat', () => onAttach(p))}
                {menuItem('New file here', () => void newFile(dirOf(p) || base))}
                {menuItem('New folder here', () => void newFolder(dirOf(p) || base))}
                {menuItem('Show folder', () => setFolder(dirOf(p) || base))}
                {source.move && !readOnly && menuItem('Rename / move…', () => void rename())}
                {source.remove && !readOnly && menuItem('Delete', () => void remove(), true)}
              </div>
            )}
          </div>
        </div>
        <div data-testid="artifact-meta" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-faint)' }}>
          {owner
            ? <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--text-dim)' }}><AgentAvatar agent={owner} size={16} />{owner.name}</span>
            : <span style={{ color: 'var(--text-dim)', background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 5, padding: '0 6px' }}>Shared</span>}
          {version !== undefined && <span style={{ fontFamily: 'var(--mono)' }}>v{version}</span>}
          {(editor || when) && <span>{editor ? `edited by ${editor.name}` : 'updated'}{when ? ` · ${when}` : ''}</span>}
          {readOnly && <span style={{ color: 'var(--amber)' }}>read-only snapshot</span>}
        </div>
      </header>
      <div style={{ flex: 1, overflow: editing ? 'hidden' : 'auto', background: 'var(--code)', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {failed && <div style={{ padding: 22, fontSize: 13, color: 'var(--text-faint)' }}>Could not load this file — it may have been moved or deleted.</div>}
        {!failed && preview === null && <div style={{ padding: 22, fontSize: 13, color: 'var(--text-faint)' }}>Loading…</div>}
        {preview && kind && (editing
          ? <FileEditor key={p} text={preview.text ?? ''} version={version} onSave={save} onReload={reloadLatest} onCancel={() => { setEditing(false); setRemoteNote(null); }} remoteNote={remoteNote} />
          : <div style={{ flex: 1, minHeight: 0 }}><ArtifactBody kind={kind} preview={preview} name={name} transcript={transcript} raw={raw} /></div>)}
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
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, color: 'var(--text-faint)', padding: 40 }}>
      <div style={{ width: 56, height: 56, borderRadius: 15, background: 'var(--panel-2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <I d={P.folder} size={26} sw={1.6} />
      </div>
      <div style={{ textAlign: 'center', maxWidth: 360 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>{agent ? `${agent.name}'s artifacts` : 'Artifacts'}</div>
        <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.55 }}>
          {agent
            ? 'The agent\'s home — LESSONS.md, JOURNAL.md, knowledge/ and whatever it builds. Select a file to view it.'
            : 'One tree for the workspace: shared folders people and agents build together, and each agent\'s home. Select a file to view, edit, or see its history.'}
        </div>
      </div>
      {source && (
        <button type="button" onClick={() => void createFile(source, '', app.showToast).then(async (p) => { if (p) { await app.refreshFiles(); onOpen(p); } })} style={btn}>
          <I d={P.plus} size={13} />New file
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
      empty={empty}
    />
  );
}
