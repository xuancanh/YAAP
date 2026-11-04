/** Declarative UI from plugins (docs/plugins.md §3.8): the extension points
 *  the app renders with its own components — cards on a company section
 *  dashboard, panels on a task (project, agent), plugin pages listed on a
 *  section dashboard, and actions. Nothing a plugin ships runs here: the
 *  server returns a rendered view (stats, table, list, checklist, text) of
 *  what a read operation returned, and a button asks the server, whose
 *  policy stage decides — a non-read action needs the owner's explicit
 *  confirmation, and a two-key one never runs from a button. */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useApp } from '../store';
import { api, type PluginUiInvoke, type PluginUiItem, type PluginUiView } from '../lib/api';
import { errorText } from '../lib/foundry';

const TONE: Record<string, string> = { good: 'var(--green)', warn: 'var(--amber)', bad: 'var(--red, #e5484d)', neutral: 'var(--text)' };
const CLASS_WORD: Record<string, string> = { read: 'read', internal_write: 'internal write', external_reversible: 'external, reversible', external_irreversible: 'external, irreversible', money: 'money' };
const faint: React.CSSProperties = { fontSize: 12, color: 'var(--text-faint)' };
const cell: React.CSSProperties = { padding: '5px 8px 5px 0', borderTop: '1px solid var(--border-soft)', fontSize: 12.5, textAlign: 'left', verticalAlign: 'top', overflowWrap: 'anywhere' };
const btn: React.CSSProperties = { font: 'inherit', fontSize: 12, fontWeight: 600, padding: '4px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--panel)', color: 'var(--text)', cursor: 'pointer' };
const input: React.CSSProperties = { font: 'inherit', fontSize: 12.5, padding: '5px 8px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--panel-2)', color: 'var(--text)', minWidth: 0, width: '100%', boxSizing: 'border-box' };

/** One rendered view: the app's own components over the server's selection. */
export function PluginView({ view, empty }: { view: PluginUiView; empty?: string }) {
  if (view.kind === 'stats') {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: 10 }}>
        {view.items.map((s) => (
          <div key={s.label} data-testid="plugin-stat" style={{ minWidth: 0 }}>
            <div style={{ fontSize: 19, fontWeight: 650, letterSpacing: '-.3px', fontVariantNumeric: 'tabular-nums', color: TONE[s.tone] ?? 'var(--text)' }}>{s.value || '—'}{s.unit && <span style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--text-dim)', marginLeft: 4 }}>{s.unit}</span>}</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{s.label}</div>
          </div>
        ))}
      </div>
    );
  }
  if (view.kind === 'table') {
    if (view.rows.length === 0) return <div style={faint}>{empty ?? 'Nothing yet.'}</div>;
    return (
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead><tr>{view.columns.map((c) => <th key={c} style={{ ...cell, borderTop: 'none', fontSize: 11, fontWeight: 600, color: 'var(--text-dim)' }}>{c}</th>)}</tr></thead>
          <tbody>{view.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} style={cell}>{v}</td>)}</tr>)}</tbody>
        </table>
        {view.more > 0 && <div style={faint}>and {view.more} more</div>}
      </div>
    );
  }
  if (view.kind === 'list') {
    if (view.items.length === 0) return <div style={faint}>{empty ?? 'Nothing yet.'}</div>;
    return (
      <div>
        {view.items.map((it, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '6px 0', borderTop: '1px solid var(--border-soft)', minWidth: 0 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {it.link ? <a href={it.link} target="_blank" rel="noreferrer noopener" style={{ color: 'var(--accent-hi)' }}>{it.title}</a> : it.title}
              </div>
              {it.subtitle && <div style={{ ...faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.subtitle}</div>}
            </div>
            {it.badge && <span style={{ fontSize: 11, padding: '1px 7px', borderRadius: 10, border: '1px solid var(--border-soft)', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{it.badge}</span>}
          </div>
        ))}
        {view.more > 0 && <div style={faint}>and {view.more} more</div>}
      </div>
    );
  }
  if (view.kind === 'checklist') {
    return <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6 }}>{view.items.map((x) => <li key={x}>{x}</li>)}</ul>;
  }
  return <div style={{ fontSize: 12.5 }}>{view.value}</div>;
}

/** A view's data: undefined while loading, a string when it failed. */
function useView(item: PluginUiItem, context?: Record<string, string>, section = 0): PluginUiView | string | undefined {
  const app = useApp();
  const ws = app.workspaceId ?? '';
  const key = JSON.stringify(context ?? {});
  const [state, setState] = useState<{ k: string; v: PluginUiView | string } | null>(null);
  const k = `${item.id}|${section}|${key}`;
  useEffect(() => {
    if (!ws || !item.ready) return;
    let live = true;
    api.pluginUiData(ws, item.id, { section, ...(context ? { context } : {}) })
      .then((r) => { if (live) setState({ k, v: r.view }); })
      .catch((e) => { if (live) setState({ k, v: errorText(e) }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, k, item.ready]);
  return state && state.k === k ? state.v : undefined;
}

function Body({ item, context, section }: { item: PluginUiItem; context?: Record<string, string>; section?: number }) {
  const v = useView(item, context, section);
  if (!item.ready) return <div style={faint}>Waiting on a {item.waitingOn.join(', ')} provider.</div>;
  if (v === undefined) return <div style={faint}>Loading…</div>;
  if (typeof v === 'string') return <div role="alert" style={faint}>Could not load: {v}</div>;
  return <PluginView view={v} empty={item.spec.empty} />;
}

/** A button that invokes a plugin action through the server's policy stage. */
export function PluginAction({ action, context }: { action: PluginUiItem; context?: Record<string, string> }) {
  const app = useApp();
  const ws = app.workspaceId ?? '';
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Extract<PluginUiInvoke, { status: 'confirm' }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const run = useCallback(async (confirm: boolean) => {
    setBusy(true); setMsg('');
    try {
      const r = await api.pluginUiInvoke(ws, action.id, { fields, ...(context ? { context } : {}), confirm });
      if (r.status === 'confirm') { setPending(r); return; }
      setPending(null); setOpen(false); setFields({});
      setMsg('Done.');
      app.showToast?.(`${action.spec.title ?? 'Action'}: done`);
    } catch (e) { setPending(null); setMsg(errorText(e)); } finally { setBusy(false); }
  }, [ws, action, fields, context, app]);
  const specFields = action.spec.fields ?? [];
  return (
    <div data-testid={`plugin-action-${action.key}`} style={{ marginTop: 8 }}>
      {!open && <button style={btn} disabled={!action.ready} onClick={() => (specFields.length ? setOpen(true) : void run(false))}>{action.spec.title}</button>}
      {open && !pending && (
        <form onSubmit={(e) => { e.preventDefault(); void run(false); }} style={{ display: 'grid', gap: 6, marginTop: 4 }}>
          {specFields.map((f) => (
            <label key={f.key} style={{ display: 'grid', gap: 2, fontSize: 11.5, color: 'var(--text-dim)' }}>
              {f.label}{f.required ? ' *' : ''}
              {f.type === 'textarea' ? <textarea aria-label={f.label} rows={3} value={fields[f.key] ?? ''} onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })} style={input} />
                : f.type === 'select' ? <select aria-label={f.label} value={fields[f.key] ?? ''} onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })} style={input}><option value="" />{(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}</select>
                  : <input aria-label={f.label} type={f.type === 'number' ? 'number' : 'text'} value={fields[f.key] ?? ''} onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })} style={input} />}
            </label>
          ))}
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="submit" style={{ ...btn, background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)' }} disabled={busy}>{action.spec.title}</button>
            <button type="button" style={btn} onClick={() => { setOpen(false); setMsg(''); }}>Cancel</button>
          </div>
        </form>
      )}
      {pending && (
        <div role="alertdialog" aria-label="Confirm plugin action" data-testid="plugin-action-confirm" style={{ marginTop: 6, padding: '9px 11px', borderRadius: 9, border: '1px solid var(--amber)', background: 'var(--panel-2)', fontSize: 12.5 }}>
          <div style={{ fontWeight: 600 }}>{pending.prompt}</div>
          <div style={faint}>Classed {CLASS_WORD[pending.class] ?? pending.class}{pending.requirement !== 'trust' ? `; ${pending.requirement.replace('_', ' ')} — your confirmation is the key` : ''}.{pending.reasons.length ? ` ${pending.reasons.join('; ')}.` : ''}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button style={{ ...btn, background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)' }} disabled={busy} onClick={() => void run(true)}>Confirm</button>
            <button style={btn} onClick={() => setPending(null)}>Cancel</button>
          </div>
        </div>
      )}
      {msg && <div role="status" style={{ ...faint, marginTop: 4 }}>{msg}</div>}
    </div>
  );
}

/** The UI contributions for a placement, with the actions they name. */
export function usePluginUi(placement: string): { items: PluginUiItem[]; actions: PluginUiItem[] } | null {
  const app = useApp();
  const ws = app.workspaceId ?? '';
  const [data, setData] = useState<{ ws: string; v: { items: PluginUiItem[]; actions: PluginUiItem[] } } | null>(null);
  useEffect(() => {
    if (!ws) return;
    let live = true;
    // A server (or a test double) without plugin UI answers nothing: render nothing.
    Promise.resolve().then(() => api.pluginUi(ws, placement))
      .then((v) => { if (live) setData({ ws, v: { items: Array.isArray(v?.items) ? v.items : [], actions: Array.isArray(v?.actions) ? v.actions : [] } }); })
      .catch(() => { if (live) setData({ ws, v: { items: [], actions: [] } }); });
    return () => { live = false; };
  }, [ws, placement]);
  return data && data.ws === ws ? data.v : null;
}

function actionsOf(item: PluginUiItem, actions: PluginUiItem[]): PluginUiItem[] {
  return (item.spec.actions ?? []).map((k) => actions.find((a) => a.pluginId === item.pluginId && a.key === k)).filter((a): a is PluginUiItem => Boolean(a));
}

function Frame({ testid, title, by, children, aside }: { testid: string; title: string; by: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section data-testid={testid} style={{ minWidth: 0, background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 13, padding: '12px 16px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 650, letterSpacing: '.05em', fontVariantCaps: 'all-small-caps' }}>{title}</h3>
        <span title="Added by a plugin" style={{ ...faint, fontSize: 11 }}>{by}</span>
        <span style={{ flex: 1 }} />
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Cards and pages plugins add to a company section dashboard. Renders nothing when there are none. */
export function PluginCards({ placement }: { placement: string }) {
  const ui = usePluginUi(placement);
  const [page, setPage] = useState<string | null>(null);
  if (!ui) return null;
  const cards = ui.items.filter((i) => i.kind === 'card');
  const pages = ui.items.filter((i) => i.kind === 'page');
  if (!cards.length && !pages.length) return null;
  const open = pages.find((p) => p.id === page) ?? null;
  return (
    <div data-testid={`plugin-cards-${placement}`} style={{ marginTop: 14 }}>
      <div style={{ ...faint, margin: '0 0 8px', fontWeight: 600, letterSpacing: '.03em' }}>From plugins</div>
      {pages.length > 0 && (
        <div role="group" aria-label="Plugin pages" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          {pages.map((p) => (
            <button key={p.id} data-testid={`plugin-page-link-${p.key}`} aria-pressed={page === p.id} title={p.spec.summary} onClick={() => setPage(page === p.id ? null : p.id)} style={{ ...btn, fontWeight: 600, borderColor: page === p.id ? 'var(--accent)' : 'var(--border)' }}>{p.spec.title}</button>
          ))}
        </div>
      )}
      {open && (
        <Frame testid={`plugin-page-${open.key}`} title={open.spec.title ?? open.key} by={open.pluginId} aside={<button style={btn} onClick={() => setPage(null)}>Close</button>}>
          {open.spec.summary && <p style={{ ...faint, margin: '0 0 8px' }}>{open.spec.summary}</p>}
          {(open.spec.sections ?? []).map((s, i) => (
            <div key={i} style={{ marginTop: i ? 12 : 0 }}>
              {s.title && <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>{s.title}</div>}
              <Body item={open} section={i} />
            </div>
          ))}
          {actionsOf(open, ui.actions).map((a) => <PluginAction key={a.id} action={a} />)}
        </Frame>
      )}
      <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))', alignItems: 'start', marginTop: open ? 14 : 0 }}>
        {cards.map((c) => (
          <Frame key={c.id} testid={`plugin-card-${c.key}`} title={c.spec.title ?? c.key} by={c.pluginId}>
            <Body item={c} />
            {c.ready && actionsOf(c, ui.actions).map((a) => <PluginAction key={a.id} action={a} />)}
          </Frame>
        ))}
      </div>
    </div>
  );
}

/** Panels plugins add to a task, project or agent page, given its context (taskKey, taskTitle, …). */
export function PluginPanels({ placement, context }: { placement: 'task' | 'project' | 'agent'; context: Record<string, string> }) {
  const ui = usePluginUi(placement);
  if (!ui) return null;
  const panels = ui.items.filter((i) => i.kind === 'panel' && i.ready);
  if (!panels.length) return null;
  return (
    <div data-testid={`plugin-panels-${placement}`} style={{ display: 'grid', gap: 10 }}>
      {panels.map((p) => (
        <Frame key={p.id} testid={`plugin-panel-${p.key}`} title={p.spec.title ?? p.key} by={p.pluginId}>
          <Body item={p} context={context} />
          {actionsOf(p, ui.actions).map((a) => <PluginAction key={a.id} action={a} context={context} />)}
        </Frame>
      ))}
    </div>
  );
}
