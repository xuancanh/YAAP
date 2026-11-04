/** The parts every company page is built from (src/styles/company.css):
 *  the page header (title, one line of purpose, the primary action), cards,
 *  metric figures, health pills, needs-attention rows, bars, owners,
 *  skeletons, empty states, an action menu, a segmented control and a
 *  copy-link button. Direction, Operations, People, Money and Oversight
 *  use these so the five sections read as one product. */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import '../styles/company.css';
import { I, P } from '../lib/icons';
import { grad } from '../store';
import type { Agent } from '../lib/api';
import type { Tone } from '../lib/direction';

export function PageHeader({ title, purpose, actions, testid }: { title: ReactNode; purpose?: ReactNode; actions?: ReactNode; testid?: string }) {
  return (
    <header className="co-head" data-testid={testid ?? 'page-header'}>
      <div className="co-head-text">
        <h2 className="co-title">{title}</h2>
        {purpose && <InfoButton>{purpose}</InfoButton>}
      </div>
      {actions && <div className="co-actions">{actions}</div>}
    </header>
  );
}

/** The (i) next to a page title: what the page is for, in a popover. Click
 *  toggles it (the phone's only way in); hover and focus open it with a fine
 *  pointer; Escape or a click outside closes it. */
export function InfoButton({ children, label = 'About this page' }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();
  const hover = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setPinned(false); } };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); setPinned(false); ref.current?.querySelector('button')?.focus(); } };
    document.addEventListener('mousedown', off);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <span className="co-infowrap" ref={ref} onMouseEnter={() => { if (hover) setOpen(true); }} onMouseLeave={() => { if (hover && !pinned) setOpen(false); }}>
      <button type="button" className="co-info" aria-label={label} aria-expanded={open} aria-controls={open ? id : undefined} data-testid="page-info"
        onClick={() => { if (open && pinned) { setOpen(false); setPinned(false); } else { setOpen(true); setPinned(true); } }}
        onFocus={() => { if (hover) setOpen(true); }} onBlur={(e) => { if (!pinned && !ref.current?.contains(e.relatedTarget as Node)) setOpen(false); }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><circle cx="12" cy="12" r="9.5" /><path d="M12 11v6M12 7.5v.01" strokeLinecap="round" /></svg>
      </button>
      {open && <span className="co-pop" role="note" id={id} data-testid="page-info-pop">{children}</span>}
    </span>
  );
}

/** A card: its title opens the page it summarises when `onOpen` is given. */
export function Card({ id, title, aside, action, onOpen, span, flush, children }: { id?: string; title?: ReactNode; aside?: ReactNode; action?: ReactNode; onOpen?: () => void; span?: boolean; flush?: boolean; children: ReactNode }) {
  const hid = useId();
  return (
    <section className={`co-card${span ? ' span' : ''}`} data-testid={id ? `dash-card-${id}` : undefined} aria-labelledby={title ? hid : undefined}>
      {(title || action) && (
        <div className="co-card-head">
          {title && <h3 id={hid} className="co-card-title">{onOpen ? <button onClick={onOpen}>{title}</button> : title}</h3>}
          {aside && <span className="co-card-aside">{aside}</span>}
          <span style={{ flex: 1 }} />
          {action}
        </div>
      )}
      <div className={`co-card-body${flush ? ' flush' : ''}`}>{children}</div>
    </section>
  );
}

export function Metric({ n, label, tone, onClick, title, testid }: { n: ReactNode; label: string; tone?: Tone; onClick?: () => void; title?: string; testid?: string }) {
  const body = <><span className={`co-metric-n${tone ? ` ${tone}` : ''}`}>{n}</span><span className="co-metric-l">{label}</span></>;
  return onClick
    ? <button className="co-metric" onClick={onClick} title={title} data-testid={testid}>{body}</button>
    : <span className="co-metric" title={title} data-testid={testid}>{body}</span>;
}

export function Pill({ tone, children, title, plain, testid }: { tone?: Tone | 'accent'; children: ReactNode; title?: string; plain?: boolean; testid?: string }) {
  return <span className={`co-pill${tone ? ` ${tone}` : ''}${plain ? ' plain' : ''}`} title={title} data-testid={testid}>{children}</span>;
}

export function Bar({ value, tone, label, marker, width }: { value: number | null; tone?: Tone; label: string; marker?: number | null; width?: number }) {
  const pct = value === null ? 0 : Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <span className={`co-bar${tone ? ` ${tone}` : ''}`} role="progressbar" aria-label={label} aria-valuenow={value === null ? undefined : pct} aria-valuemin={0} aria-valuemax={100} style={width ? { flex: 'none', width } : undefined}>
      <span style={{ width: `${pct}%` }} />
      {marker !== null && marker !== undefined && <i style={{ left: `calc(${Math.max(0, Math.min(100, marker * 100))}% - 1px)` }} title="Expected by now" />}
    </span>
  );
}

export function Avatar({ a, size = 20 }: { a?: Agent; size?: number }) {
  return <span aria-hidden style={{ width: size, height: size, borderRadius: Math.round(size / 3), background: a ? grad(a.colors) : 'var(--panel-2)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.55, flex: 'none', border: a ? 'none' : '1px dashed var(--border)' }}>{a?.emoji ?? ''}</span>;
}

/** Who owns it: an avatar and a name, or a warning that nobody does. */
export function Owner({ agent, name, role, none = 'No owner', compact }: { agent?: Agent; name?: string | null; role?: string; none?: string; compact?: boolean }) {
  const who = agent?.name ?? name ?? null;
  if (!who) return <span className="co-owner none"><Avatar size={18} />{none}</span>;
  return <span className="co-owner" title={role ? `${who} · ${role}` : who}><Avatar a={agent} size={18} />{!compact && <b>{who}</b>}{!compact && role && <span>{role}</span>}</span>;
}

export interface AttentionRow { id: string; tone: Tone; title: string; why?: string; go?: string; onOpen?: () => void }

/** What to look at next: one row per item, the reason under it, a link to where it is fixed. */
export function AttentionList({ items, clear = 'Nothing needs you here.', limit, testid = 'attention' }: { items: AttentionRow[]; clear?: string; limit?: number; testid?: string }) {
  const [all, setAll] = useState(false);
  if (items.length === 0) return <div className="co-allclear" data-testid={`${testid}-clear`}><I d={P.check} size={16} />{clear}</div>;
  const shown = limit && !all ? items.slice(0, limit) : items;
  return (
    <div className="co-attn" data-testid={testid}>
      {shown.map((it) => (
        <button key={it.id} className="co-attn-row" title={it.why} data-testid="attention-row" data-tone={it.tone} onClick={it.onOpen} disabled={!it.onOpen}>
          <span className={`co-attn-mark ${it.tone}`} aria-hidden><I d={it.tone === 'info' ? P.clock : P.warn} size={13} /></span>
          <span className="co-attn-text">
            <span className="co-attn-title">{it.title}</span>
            {it.why && <span className="co-attn-why">{it.why}</span>}
          </span>
          {it.go && <span className="co-attn-go">{it.go}</span>}
        </button>
      ))}
      {limit && items.length > limit && <button className="co-link" style={{ margin: '4px 10px' }} onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${items.length}`}</button>}
    </div>
  );
}

export function Skeleton({ w = '100%', h = 12, r, style }: { w?: number | string; h?: number; r?: number; style?: React.CSSProperties }) {
  return <span className="co-skel" aria-hidden style={{ width: w, height: h, borderRadius: r, ...style }} />;
}

/** Placeholder rows while a list loads. */
export function SkeletonRows({ rows = 3, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-label={label} data-testid="skeleton" style={{ display: 'grid', gap: 12, padding: '8px 10px' }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Skeleton w={20} h={20} r={7} />
          <div style={{ flex: 1, display: 'grid', gap: 6 }}><Skeleton w={`${70 - i * 9}%`} h={11} /><Skeleton w={`${40 + i * 7}%`} h={9} /></div>
        </div>
      ))}
    </div>
  );
}

/** A whole page loading: the header's shape, then cards. */
export function PageSkeleton({ cards = 3 }: { cards?: number }) {
  return (
    <div role="status" aria-label="Loading" data-testid="page-skeleton" className="co-page">
      <div style={{ display: 'grid', gap: 8, marginBottom: 18 }}><Skeleton w={180} h={18} /><Skeleton w="min(520px, 80%)" h={11} /></div>
      <div className="co-grid">{Array.from({ length: cards }, (_, i) => <div key={i} className="co-card" style={{ padding: 16, display: 'grid', gap: 10 }}><Skeleton w="40%" h={12} /><Skeleton h={10} /><Skeleton w="85%" h={10} /><Skeleton w="60%" h={10} /></div>)}</div>
    </div>
  );
}

export function Empty({ title, children, action, icon = P.compass, compact, testid }: { title: string; children?: ReactNode; action?: ReactNode; icon?: string[]; compact?: boolean; testid?: string }) {
  return (
    <div className={`co-empty${compact ? ' compact' : ''}`} data-testid={testid ?? 'empty'}>
      {!compact && <span className="co-empty-mark" aria-hidden><I d={icon} size={18} /></span>}
      <p className="co-empty-title">{title}</p>
      {children && <p className="co-empty-text">{children}</p>}
      {action}
    </div>
  );
}

export interface MenuItem { id: string; label: ReactNode; onSelect: () => void; checked?: boolean; disabled?: boolean }

/** A button that opens a small menu of actions; Escape and an outside click close it. */
export function Menu({ label, trigger, items, sections, align = 'right', triggerClass = 'co-btn small', testid }: { label: string; trigger: ReactNode; items?: MenuItem[]; sections?: Array<{ label?: string; items: MenuItem[] }>; align?: 'left' | 'right'; triggerClass?: string; testid?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', off);
    requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus());
    return () => document.removeEventListener('mousedown', off);
  }, [open]);
  const groups = sections ?? [{ items: items ?? [] }];
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); ref.current?.querySelector<HTMLButtonElement>('button')?.focus(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const list = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
  };
  return (
    <div className="co-menuwrap" ref={ref} onKeyDown={onKey}>
      <button type="button" className={triggerClass} aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label} onClick={(e) => { e.stopPropagation(); setOpen(!open); }} data-testid={testid}>{trigger}</button>
      {open && (
        <div className={`co-menu${align === 'left' ? ' left' : ''}`} role="menu" aria-label={label} ref={menuRef} onClick={(e) => e.stopPropagation()}>
          {groups.map((g, gi) => (
            <div key={gi}>
              {gi > 0 && <hr />}
              {g.label && <div className="co-menu-label">{g.label}</div>}
              {g.items.map((it) => (
                <button key={it.id} role={it.checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={it.checked} disabled={it.disabled} onClick={() => { setOpen(false); it.onSelect(); }}>{it.label}</button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ id: T; label: string }>; onChange: (v: T) => void }) {
  return (
    <div className="co-seg" role="tablist" aria-label={label}>
      {options.map((o) => <button key={o.id} role="tab" aria-selected={o.id === value} onClick={() => onChange(o.id)}>{o.label}</button>)}
    </div>
  );
}

/** Copy a reference (`#goal:…`, a link) to the clipboard instead of printing ids inline. */
export function CopyRef({ text, label = 'Copy reference' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1400); } catch { window.prompt('Copy this reference', text); }
  };
  return <button type="button" className="co-iconbtn" aria-label={`${label}: ${text}`} title={done ? 'Copied' : `${label} (${text})`} onClick={(e) => { e.stopPropagation(); void copy(); }}>{done ? <I d={P.check} size={13} /> : <span aria-hidden style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 600 }}>#</span>}</button>;
}

export function SearchBox({ value, onChange, label, placeholder }: { value: string; onChange: (v: string) => void; label: string; placeholder?: string }) {
  return (
    <label className="co-search">
      <span className="co-sr">{label}</span>
      <I d={P.search} size={13} />
      <input className="co-input" type="search" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder ?? label} />
    </label>
  );
}
