/**
 * Saving an open file (docs/filesystem.md "Editing"): debounced autosave plus
 * explicit save, every write version-checked. The editor reports changes as
 * a getter, so the Markdown is serialised only when a save actually runs —
 * and a save whose text equals the last saved text writes nothing.
 *
 * A 409 (someone saved meanwhile) never overwrites: autosave stops, their
 * version is fetched, and the caller shows both — keep mine (write over
 * their version, explicitly) or take theirs (load it into the editor).
 * A remote change while the draft is clean refreshes the editor in place.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { isConflict } from './artifacts';
import type { FileAuthor } from './api';

export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'conflict' | 'error';
export interface Remote { text: string; version?: number; by?: string }
export interface DocConflict { theirs: Remote; mine: string }

export interface DocSaveOptions {
  initialText: string;
  initialVersion?: number;
  save: (text: string, expectedVersion: number | undefined) => Promise<{ version?: number }>;
  load: () => Promise<{ text?: string; version?: number; updatedBy?: FileAuthor | null }>;
  /** After each successful write (the version it produced). */
  onSaved?: (version: number | undefined, text: string) => void;
  delay?: number;
}

export function useDocSave({ initialText, initialVersion, save, load, onSaved, delay = 1200 }: DocSaveOptions) {
  const [status, setStatus] = useState<SaveStatus>('saved');
  const [conflict, setConflict] = useState<DocConflict | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** What the editor should (re)load; `rev` bumps when it is replaced. */
  const [content, setContent] = useState({ text: initialText, rev: 0 });
  const base = useRef<{ text: string; version?: number }>({ text: initialText, version: initialVersion });
  const getter = useRef<() => string>(() => base.current.text);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inflight = useRef<Promise<boolean> | null>(null);
  const conflictRef = useRef<DocConflict | null>(null);
  conflictRef.current = conflict;
  const live = useRef({ save, load, onSaved, delay });
  live.current = { save, load, onSaved, delay };

  const fetchTheirs = async (): Promise<Remote> => {
    const p = await live.current.load();
    return { text: p.text ?? '', version: p.version, by: p.updatedBy?.name };
  };

  const run = useCallback(async (): Promise<boolean> => {
    clearTimeout(timer.current);
    if (conflictRef.current) return false;
    if (inflight.current) await inflight.current;
    const text = getter.current();
    if (text === base.current.text) { setStatus('saved'); return true; }
    const job = (async () => {
      setStatus('saving'); setError(null);
      try {
        const r = await live.current.save(text, base.current.version);
        base.current = { text, version: r?.version ?? base.current.version };
        // an editor that mounts again (same rev) starts from what was saved
        setContent((x) => ({ text, rev: x.rev }));
        live.current.onSaved?.(r?.version, text);
        if (getter.current() !== text) { setStatus('unsaved'); timer.current = setTimeout(() => void run(), live.current.delay); } else setStatus('saved');
        return true;
      } catch (e) {
        if (isConflict(e)) {
          let theirs: Remote;
          try { theirs = await fetchTheirs(); } catch { theirs = { text: '', version: undefined }; }
          setConflict({ theirs, mine: text }); setStatus('conflict');
        } else { setError(e instanceof Error ? e.message.slice(0, 160) : 'Could not save'); setStatus('error'); }
        return false;
      }
    })();
    inflight.current = job;
    try { return await job; } finally { if (inflight.current === job) inflight.current = null; }
  }, []);

  /** The editor changed; `get` returns its current text. */
  const change = useCallback((get: () => string) => {
    getter.current = get;
    if (conflictRef.current) return;
    setStatus('unsaved');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(), live.current.delay);
  }, [run]);

  /** Write mine over their version — the explicit, informed overwrite. */
  const keepMine = useCallback(async () => {
    const c = conflictRef.current;
    if (!c) return;
    base.current = { text: c.theirs.text, version: c.theirs.version };
    conflictRef.current = null;
    setConflict(null);
    await run();
  }, [run]);

  /** Replace my draft with their version. */
  const takeTheirs = useCallback(() => {
    const c = conflictRef.current;
    if (!c) return;
    base.current = { text: c.theirs.text, version: c.theirs.version };
    getter.current = () => base.current.text;
    conflictRef.current = null;
    setConflict(null);
    setContent((x) => ({ text: c.theirs.text, rev: x.rev + 1 }));
    setStatus('saved');
  }, []);

  /** Someone else saved: refresh in place when my draft is clean, else keep
   *  my draft (the next save will meet the conflict). Returns which. */
  const remoteChanged = useCallback(async (): Promise<'refreshed' | 'kept'> => {
    if (inflight.current || conflictRef.current || getter.current() !== base.current.text) return 'kept';
    const theirs = await fetchTheirs();
    if (getter.current() !== base.current.text) return 'kept';
    if (theirs.version !== undefined && theirs.version === base.current.version) return 'refreshed';
    base.current = { text: theirs.text, version: theirs.version };
    getter.current = () => base.current.text;
    setContent((x) => ({ text: theirs.text, rev: x.rev + 1 }));
    return 'refreshed';
  }, []);

  const dirty = useCallback(() => getter.current() !== base.current.text, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  return { status, conflict, error, content, change, flush: run, keepMine, takeTheirs, remoteChanged, dirty, version: () => base.current.version };
}
