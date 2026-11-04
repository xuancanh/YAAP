/**
 * A department's name with inline rename (docs/group-chat.md §7 "Department
 * names"): the channel header, the org chart and the People cards show it;
 * the CEO and the board rename it in place. The unit id is the identity —
 * the board, goals and task keys stay — and the channel follows (its name
 * and `#slug`; the old slug keeps linking). Agents rename with
 * `org_rename_unit` (the chief, the department's own head).
 */
import { useEffect, useState } from 'react';
import { api, type HumanRole } from '../lib/api';
import { useApp } from '../store';

/** One role lookup per workspace, shared by every name on screen. */
const roles = new Map<string, Promise<HumanRole | null>>();

/** Whether the viewer may rename departments here: the CEO and the board. */
export function useMayRenameDepartments(wsId: string | null | undefined): boolean {
  const [may, setMay] = useState(false);
  useEffect(() => {
    if (!wsId) { setMay(false); return; }
    let live = true;
    let p = roles.get(wsId);
    if (!p) {
      p = Promise.resolve().then(() => api.orgHumans(wsId)).then((h) => h?.me?.role ?? null).catch(() => { roles.delete(wsId); return null; });
      roles.set(wsId, p);
    }
    void p.then((r) => { if (live) setMay(r === 'ceo' || r === 'board'); });
    return () => { live = false; };
  }, [wsId]);
  return may;
}

/** Test seam: forget cached roles. */
export function resetDepartmentRoles(): void { roles.clear(); }

const pen = { background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: '0 2px', fontSize: 'inherit', lineHeight: 1 } as const;

/**
 * The name, and — when `editable` — a small "rename" control that turns it
 * into an input (Enter saves, Escape cancels). `onRenamed` gets the new unit
 * (its `slug` may have moved with the name).
 */
export function DepartmentName({ wsId, unitId, name, editable, style, onRenamed }: {
  wsId: string; unitId: string; name: string; editable: boolean; style?: React.CSSProperties;
  onRenamed?: (u: { name: string; slug: string }) => void;
}) {
  const app = useApp();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!editing) setValue(name); }, [name, editing]);
  const save = async () => {
    const v = value.trim();
    if (!v || v === name) { setEditing(false); return; }
    setBusy(true);
    try {
      const u = await api.renameOrgUnit(wsId, unitId, v);
      setEditing(false);
      app.showToast(`Department renamed to ${u.name} (#${u.slug})`);
      await app.refreshWsOrg();
      void app.refreshChannels();
      onRenamed?.(u);
    } catch (err) { app.showToast(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  if (!editing) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, minWidth: 0 }}>
        <span style={style}>{name}</span>
        {editable && <button type="button" aria-label={`Rename the ${name} department`} title="Rename this department (its channel follows; task keys stay)" onClick={(e) => { e.stopPropagation(); setEditing(true); }} style={pen}>✎</button>}
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} onClick={(e) => e.stopPropagation()}>
      <input aria-label="Department name" autoFocus value={value} maxLength={60} disabled={busy} onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') setEditing(false); }}
        style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '1px 6px', color: 'var(--text)', fontSize: 12, outline: 'none', width: 160 }} />
      <button type="button" onClick={() => void save()} disabled={busy || !value.trim()} style={{ ...pen, color: 'var(--accent-hi)', fontWeight: 600, fontSize: 12 }}>Save</button>
      <button type="button" onClick={() => setEditing(false)} style={{ ...pen, fontSize: 12 }}>Cancel</button>
    </span>
  );
}
