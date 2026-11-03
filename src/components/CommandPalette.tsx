/** The command palette (docs/home.md "Top bar"): ⌘K / Ctrl+K anywhere, or
 *  the bar's search. One box finds a place, an agent, a channel, a chat, a
 *  task by its key, a file or a message, and runs an action. The local items
 *  match as you type (src/lib/topbar.ts `rankPalette`); `remote` adds the
 *  server's search results after a short pause. Presentational: the caller
 *  builds the items and runs the pick. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { I, P } from '../lib/icons';
import { rankPalette, type PaletteItem } from '../lib/topbar';

export interface CommandPaletteProps<T extends PaletteItem> {
  items: T[];
  onRun: (item: T) => void;
  onClose: () => void;
  /** Items that depend on the query (a task key, the server's search). */
  extra?: (q: string) => T[];
  remote?: (q: string) => Promise<T[]>;
  /** Milliseconds to wait before asking `remote` (tests pass 0). */
  remoteDelay?: number;
  phone?: boolean;
}

export function CommandPalette<T extends PaletteItem>({ items, onRun, onClose, extra, remote, remoteDelay = 220, phone = false }: CommandPaletteProps<T>) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [found, setFound] = useState<{ q: string; items: T[] }>({ q: '', items: [] });
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { input.current?.focus(); }, []);

  useEffect(() => {
    const query = q.trim();
    if (!remote || query.length < 2) return;
    let live = true;
    const t = setTimeout(() => { void remote(query).then((r) => { if (live) setFound({ q: query, items: r }); }).catch(() => undefined); }, remoteDelay);
    return () => { live = false; clearTimeout(t); };
  }, [q, remote, remoteDelay]);

  const shown = useMemo(() => {
    const query = q.trim();
    const pool = [...(extra ? extra(query) : []), ...items, ...(found.q === query && query.length >= 2 ? found.items : [])];
    return rankPalette(pool, query);
  }, [items, extra, found, q]);
  const pick = Math.min(active, Math.max(0, shown.length - 1));

  useEffect(() => {
    list.current?.querySelector(`[data-idx="${pick}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [pick]);

  const run = (it: T | undefined) => { if (!it) return; onClose(); onRun(it); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(shown.length - 1, Math.min(i, shown.length - 1) + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, Math.min(i, shown.length - 1) - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(shown[pick]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  let lastGroup = '';
  return (
    <div className="tb-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', zIndex: 140, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: phone ? '10px 10px 0' : '12vh 16px 0' }}>
      <div role="dialog" aria-modal="true" aria-label="Search and commands" onKeyDown={onKey}
        style={{ width: '100%', maxWidth: 620, background: 'var(--elev)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow)', overflow: 'hidden', animation: 'pop .12s ease-out' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px', borderBottom: '1px solid var(--border-soft)' }}>
          <I d={P.search} size={16} stroke="var(--text-faint)" />
          <input ref={input} value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }} aria-label="Search" role="combobox" aria-expanded="true" aria-controls="tb-palette-list"
            aria-activedescendant={shown[pick] ? `tb-pal-${pick}` : undefined}
            placeholder="Find an agent, a chat, a task key, a file — or type a command"
            style={{ flex: 1, minWidth: 0, height: 50, border: 'none', outline: 'none', background: 'none', color: 'var(--text)', fontSize: 15 }} />
          <kbd className="tb-kbd">Esc</kbd>
        </div>
        <div ref={list} id="tb-palette-list" role="listbox" aria-label="Results" style={{ maxHeight: phone ? '62vh' : 420, overflowY: 'auto', padding: '6px 6px 8px' }}>
          {shown.length === 0 && (
            <div style={{ padding: '22px 14px', fontSize: 13, color: 'var(--text-dim)' }}>
              Nothing matches “{q.trim()}”. Try an agent’s name, a channel, or a task key like ENG-12.
            </div>
          )}
          {shown.map((it, i) => {
            const head = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <div key={`${it.group}:${it.id}`}>
                {head && <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-dim)', padding: i === 0 ? '6px 10px 4px' : '12px 10px 4px' }}>{head}</div>}
                <div id={`tb-pal-${i}`} data-idx={i} role="option" aria-selected={i === pick} onMouseMove={() => { if (i !== pick) setActive(i); }} onClick={() => run(it)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, cursor: 'pointer', background: i === pick ? 'var(--hover)' : 'none', boxShadow: i === pick ? 'inset 2px 0 0 var(--accent)' : 'none' }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
                  {it.hint && <span style={{ flex: 'none', maxWidth: '45%', fontSize: 12, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.hint}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
