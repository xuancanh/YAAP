/** Archive, restore and delete the company (docs/owners-seat.md "Archive or
 *  delete the company"), under Settings → Workspace → Organization:
 *
 *  - the Danger zone of a live company: Archive (reversible — everything
 *    stops, the panes hide, nothing is deleted), with "Export COMPANY.json
 *    first" in the dialog;
 *  - each archived company: a banner, the read-only view (members, goals,
 *    projects, decisions, row counts), Restore, and Delete permanently — the
 *    dialog says what is removed and what is kept, offers the choices
 *    (agents kept or deleted, /org/ files moved under /archive/ or deleted,
 *    unit channels archived, kept or deleted) and asks for the name.
 *  Owner only; members and viewers see the banner and the view. */
/* eslint-disable react-refresh/only-export-components */
import { useEffect, useState } from 'react';
import { useApp } from '../store';
import { api, type ArchivedOrg, type ArchivedOrgDetail, type Blueprint, type DeleteOrgBody, type Workspace } from '../lib/api';
import { blueprintFileName } from '../lib/org2';
import { card, input, btn, faint, label, pill } from './org-ui';

const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, padding: 16 };
const dialog: React.CSSProperties = { ...card, width: 'min(560px, 100%)', maxHeight: '90vh', overflow: 'auto', display: 'grid', gap: 12 };
const dangerBox: React.CSSProperties = { border: '1px solid var(--red)', borderRadius: 10, padding: '10px 12px', display: 'grid', gap: 8 };

/** Download COMPANY.json of the live company (no orgId) or of an archived one. */
async function exportBlueprint(wsId: string, fallbackName: string, orgId?: string): Promise<void> {
  const bp: Blueprint = orgId ? await api.archivedOrgBlueprint(wsId, orgId) : await api.orgBlueprint(wsId);
  const blob = new Blob([JSON.stringify(bp, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = blueprintFileName(bp.name || fallbackName); a.click(); URL.revokeObjectURL(a.href);
}

/** Human words for an org table in the "what is removed" list. */
export function tableWords(table: string): string {
  return table.replace(/^org_/, '').replace(/_/g, ' ');
}

/** The delete request the dialog sends, from its choices. Exported for tests. */
export function deleteBody(orgId: string, confirmName: string, choices: { agents: 'keep' | 'delete'; files: 'keep' | 'delete'; channels: 'archive' | 'keep' | 'delete' }): DeleteOrgBody {
  return { orgId, confirmName, ...choices };
}

function useRefreshAll() {
  const app = useApp();
  return () => Promise.all([app.refreshWsOrg(), app.refreshWorkspaces(), app.refreshAgents()]).then(() => undefined, () => undefined);
}

/** The archive confirmation: what stops, what stays, export first. */
export function ArchiveDialog({ ws, name, onClose }: { ws: Workspace; name: string; onClose: (archived: boolean) => void }) {
  const app = useApp();
  const refresh = useRefreshAll();
  const [busy, setBusy] = useState<string | null>(null);
  const toast = (e: unknown, fallback: string) => app.showToast(e instanceof Error ? e.message.slice(0, 200) : fallback);
  const archive = async () => {
    setBusy('archive');
    try { await api.archiveOrg(ws.id); await refresh(); app.showToast(`${name} is archived — nothing was deleted`); onClose(true); } catch (e) { toast(e, 'archive failed'); } finally { setBusy(null); }
  };
  const doExport = async () => {
    setBusy('export');
    try { await exportBlueprint(ws.id, name); } catch (e) { toast(e, 'export failed'); } finally { setBusy(null); }
  };
  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label={`Archive ${name}`} onClick={() => onClose(false)}>
      <div style={dialog} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Archive {name}?</div>
        <div style={{ fontSize: 12.5, lineHeight: 1.55 }}>
          Archiving stops the company the way the pause button does, and puts it away:
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            <li>every wake, run, ritual, meeting and pending decision timer stops;</li>
            <li>the Company panes and the company parts of Inbox and Home are hidden — the workspace goes back to the plain Home;</li>
            <li>your agents stay in the workspace as plain agents: their seats are suspended, not deleted;</li>
            <li>unit channels become read-only; #company stays.</li>
          </ul>
        </div>
        <div style={{ fontSize: 12.5 }}><b>Nothing is deleted.</b> Every task, goal, decision and file stays, readable here as an archived company, and <b>Restore</b> brings it back as it was. You can start a new company in this workspace meanwhile.</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" style={btn()} disabled={busy !== null} onClick={() => void doExport()}>{busy === 'export' ? 'Exporting…' : 'Export COMPANY.json first'}</button>
          <span style={{ flex: 1 }} />
          <button type="button" style={btn()} onClick={() => onClose(false)}>Cancel</button>
          <button type="button" style={btn(false, true)} disabled={busy !== null} onClick={() => void archive()}>{busy === 'archive' ? 'Archiving…' : 'Archive company'}</button>
        </div>
      </div>
    </div>
  );
}

/** Delete permanently: what goes, what stays, the choices, the name. */
export function DeleteOrgDialog({ ws, org, detail, onClose }: { ws: Workspace; org: ArchivedOrg; detail: ArchivedOrgDetail | null; onClose: (deleted: boolean) => void }) {
  const app = useApp();
  const refresh = useRefreshAll();
  const [agents, setAgents] = useState<'keep' | 'delete'>('keep');
  const [files, setFiles] = useState<'keep' | 'delete'>('keep');
  const [channels, setChannels] = useState<'archive' | 'keep' | 'delete'>('archive');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const matches = typed.trim() === org.name.trim();
  const toast = (e: unknown, fallback: string) => app.showToast(e instanceof Error ? e.message.slice(0, 200) : fallback);
  const live = detail?.liveCompany ?? null;
  const counts = Object.entries(detail?.counts ?? {}).sort((a, b) => b[1] - a[1]);
  const day = (org.archivedAt ?? new Date().toISOString()).slice(0, 10);
  const remove = async () => {
    setBusy('delete');
    try {
      const r = await api.deleteOrg(ws.id, deleteBody(org.id, typed.trim(), { agents, files, channels }));
      await refresh();
      const bits = [
        r.agents.deleted.length ? `${r.agents.deleted.length} agent(s) deleted` : `${r.agents.kept.length} agent(s) kept`,
        r.files.to ? `files moved to ${r.files.to}` : r.files.deleted ? `${r.files.deleted} file(s) deleted` : '',
      ].filter(Boolean);
      app.showToast(`${org.name} is deleted${bits.length ? ` — ${bits.join(', ')}` : ''}`);
      onClose(true);
    } catch (e) { toast(e, 'delete failed'); } finally { setBusy(null); }
  };
  const doExport = async () => {
    setBusy('export');
    try { await exportBlueprint(ws.id, org.name, org.id); } catch (e) { toast(e, 'export failed'); } finally { setBusy(null); }
  };
  const choice = (name: string, value: string, current: string, set: (v: never) => void, text: string, hint: string) => (
    <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, cursor: 'pointer' }}>
      <input type="radio" name={name} value={value} checked={current === value} onChange={() => set(value as never)} style={{ marginTop: 3 }} />
      <span><b>{text}</b> <span style={faint}>{hint}</span></span>
    </label>
  );
  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label={`Delete ${org.name} permanently`} onClick={() => onClose(false)}>
      <div style={dialog} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--red)' }}>Delete {org.name} permanently?</div>
        <div style={{ fontSize: 12.5, lineHeight: 1.55 }}>
          This cannot be undone. <b>Removed:</b> the company and everything recorded in it — members and seats, units, goals and key results, projects, tasks and their runs, rituals and meetings, decisions and approvals, budgets and plans, incidents, experiments, evals, metric sources (with their stored secrets), plugin bindings scoped to its units and projects, follows of its tasks, and its own audit log. A final entry goes to the workspace's audit log.
          <br /><b>Kept:</b> your personal chats, the agents' own chats and memory, other workspaces, and whatever you choose below.
        </div>
        {counts.length > 0 && (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }} aria-label="What is removed">
            {counts.slice(0, 14).map(([t, n]) => <span key={t} style={pill()}>{n} {tableWords(t)}</span>)}
          </div>
        )}
        <div style={{ display: 'grid', gap: 6 }}>
          <div style={label}>Agents that were members</div>
          {choice('agents', 'keep', agents, setAgents, 'Keep them', 'as plain agents in this workspace (default)')}
          {choice('agents', 'delete', agents, setAgents, 'Delete them', `${org.members} agent(s), with their chats and memory`)}
        </div>
        <div style={{ display: 'grid', gap: 6 }}>
          <div style={label}>Files under /org/</div>
          {live ? <div style={faint}>/org/ belongs to {live.name} now — it is left untouched.</div> : <>
            {choice('files', 'keep', files, setFiles, 'Keep them', `moved to /archive/org-…-${day}/ (default)`)}
            {choice('files', 'delete', files, setFiles, 'Delete them', 'every file under /org/')}
          </>}
        </div>
        <div style={{ display: 'grid', gap: 6 }}>
          <div style={label}>Unit channels</div>
          {choice('channels', 'archive', channels, setChannels, 'Archive them', 'read-only, messages kept (default)')}
          {choice('channels', 'keep', channels, setChannels, 'Keep them open', 'as ordinary channels')}
          {choice('channels', 'delete', channels, setChannels, 'Delete them', 'with their messages; #company stays')}
        </div>
        <label style={{ display: 'grid', gap: 4, fontSize: 12.5 }}>
          <span>Type <b>{org.name}</b> to confirm</span>
          <input aria-label="Company name" value={typed} onChange={(e) => setTyped(e.target.value)} style={input} placeholder={org.name} autoComplete="off" />
        </label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" style={btn()} disabled={busy !== null} onClick={() => void doExport()}>{busy === 'export' ? 'Exporting…' : 'Export COMPANY.json first'}</button>
          <span style={{ flex: 1 }} />
          <button type="button" style={btn()} onClick={() => onClose(false)}>Cancel</button>
          <button type="button" style={{ ...btn(false, true), opacity: matches ? 1 : 0.5 }} disabled={!matches || busy !== null} onClick={() => void remove()}>{busy === 'delete' ? 'Deleting…' : 'Delete permanently'}</button>
        </div>
      </div>
    </div>
  );
}

/** The read-only "Archived company" view. */
export function ArchivedOrgView({ detail }: { detail: ArchivedOrgDetail }) {
  const nameOf = (id: string | null) => detail.members.find((m) => m.agentId === id)?.name ?? (id ? id.slice(0, 8) : '—');
  const row: React.CSSProperties = { fontSize: 12.5, padding: '3px 0', borderBottom: '1px solid var(--border-soft)' };
  return (
    <div style={{ display: 'grid', gap: 10, marginTop: 8 }} aria-label="Archived company (read-only)">
      {detail.org.mission && <div style={{ fontSize: 12.5 }}>{detail.org.mission}</div>}
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        <div>
          <div style={label}>Members · {detail.members.length}</div>
          {detail.members.map((m) => (
            <div key={m.agentId} style={row}>{m.emoji ? `${m.emoji} ` : ''}{m.name ?? m.agentId.slice(0, 8)}{m.title ? <span style={faint}> · {m.title}</span> : null}{m.reportsToAgentId ? <span style={faint}> → {nameOf(m.reportsToAgentId)}</span> : null}{!m.exists ? <span style={faint}> (agent deleted)</span> : null}</div>
          ))}
        </div>
        <div>
          <div style={label}>Goals · {detail.goals.length}</div>
          {detail.goals.slice(0, 12).map((g) => <div key={g.id} style={row}>{g.title} <span style={faint}>{g.status}</span></div>)}
          <div style={{ ...label, marginTop: 8 }}>Projects · {detail.projects.length}</div>
          {detail.projects.slice(0, 12).map((p) => <div key={p.id} style={row}>{p.title} <span style={faint}>{p.status}</span></div>)}
        </div>
      </div>
      {detail.decisions.length > 0 && (
        <div>
          <div style={label}>Latest decisions</div>
          {detail.decisions.slice(0, 8).map((d) => <div key={d.id} style={row}>{d.title}{d.decision ? <span style={faint}> — {d.decision.slice(0, 120)}</span> : null}</div>)}
        </div>
      )}
      <div style={faint}>
        {Object.entries(detail.counts).map(([t, n]) => `${n} ${tableWords(t)}`).join(' · ') || 'No records.'}
        {detail.orgFiles > 0 && !detail.liveCompany ? ` · ${detail.orgFiles} file(s) under /org/` : ''}
      </div>
    </div>
  );
}

/** One archived company: banner, view, Restore, Delete permanently. */
export function ArchivedOrgCard({ ws, org, liveCompany }: { ws: Workspace; org: ArchivedOrg; liveCompany: boolean }) {
  const app = useApp();
  const refresh = useRefreshAll();
  const isOwner = !app.me || app.me.role === 'owner';
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<ArchivedOrgDetail | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open && !deleting) return;
    let gone = false;
    void api.archivedOrg(ws.id, org.id).then((d) => { if (!gone) setDetail(d); }).catch(() => undefined);
    return () => { gone = true; };
  }, [open, deleting, ws.id, org.id]);
  const restore = async () => {
    setBusy(true);
    try {
      const r = await api.restoreOrg(ws.id, org.id);
      await refresh();
      app.showToast(`${org.name} is restored (${r.restored.mode}${r.restored.status === 'paused' ? ', still paused' : ''})`);
    } catch (e) { app.showToast(e instanceof Error ? e.message.slice(0, 200) : 'restore failed'); } finally { setBusy(false); }
  };
  const when = org.archivedAt ? new Date(org.archivedAt).toLocaleDateString() : '';
  return (
    <div style={{ ...card, marginTop: 12, background: 'var(--panel-2)' }}>
      <div role="status" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={pill('var(--amber)', '#000')}>Archived company</span>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>{org.name}</div>
          <div style={faint}>Read-only{when ? ` · archived ${when}` : ''}{org.archivedBy && org.archivedBy !== 'user' ? ` by ${org.archivedBy}` : ''} · {org.members} member(s) · restores {org.restoreMode}{org.restoreStatus === 'paused' ? ', paused' : ''}{org.deleting ? ' · a delete was started — finish it' : ''}</div>
        </div>
        <button type="button" style={btn()} onClick={() => setOpen((v) => !v)}>{open ? 'Hide' : 'View'}</button>
        {isOwner && !org.deleting && (
          <button type="button" style={btn(true)} disabled={busy || liveCompany} title={liveCompany ? 'Archive the current company first: a workspace runs one company at a time' : 'Bring the company back as it was'} onClick={() => void restore()}>{busy ? 'Restoring…' : 'Restore'}</button>
        )}
        {isOwner && <button type="button" style={btn(false, true)} onClick={() => setDeleting(true)}>Delete permanently…</button>}
      </div>
      {open && detail && <ArchivedOrgView detail={detail} />}
      {open && !detail && <div style={{ ...faint, marginTop: 8 }}>Loading…</div>}
      {deleting && <DeleteOrgDialog ws={ws} org={org} detail={detail} onClose={() => setDeleting(false)} />}
    </div>
  );
}

/** The Danger zone (live company) and the archived companies, for Settings → Workspace → Organization. */
export function OrgDangerZone({ ws }: { ws: Workspace }) {
  const app = useApp();
  const st = app.wsOrg;
  const isOwner = !app.me || app.me.role === 'owner';
  const [archiving, setArchiving] = useState(false);
  const archived = st?.archived ?? [];
  const live = st?.orgId && st.org ? st.org : null;
  if (!live && archived.length === 0) return null;
  return (
    <div style={{ marginTop: 14 }}>
      {archived.map((o) => <ArchivedOrgCard key={o.id} ws={ws} org={o} liveCompany={Boolean(live)} />)}
      {live && isOwner && (
        <div style={{ ...dangerBox, marginTop: 12 }} aria-label="Danger zone">
          <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--red)' }}>Danger zone</div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 200, fontSize: 12 }}>
              <b>Archive this company.</b> <span style={faint}>Stops everything and hides it; nothing is deleted and you can restore it. Deleting permanently is offered once it is archived.</span>
            </div>
            <button type="button" style={btn(false, true)} onClick={() => setArchiving(true)}>Archive company…</button>
          </div>
        </div>
      )}
      {archiving && live && <ArchiveDialog ws={ws} name={live.name} onClose={() => setArchiving(false)} />}
    </div>
  );
}
