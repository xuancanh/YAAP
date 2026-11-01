/** Market registry UI (execution-plan item 12, docs/registry.md): the
 *  "Publish" button + form with the scan shown before confirming, and the
 *  install review modal — the same gate the hire modal runs, extended with
 *  the scan report, the real skill bodies and the inert-install notes. Used
 *  by MarketView (Community), AgentsView (agent home, skills rows, app
 *  cards) and SettingsView (Skills pane). */
import { useEffect, useState } from 'react';
import { useApp } from '../store';
import { api, type RegistryItem, type RegistryPublishInput, type RegistryPublishResult, type RegistryReview } from '../lib/api';
import { I, P } from '../lib/icons';
import { KIND_GLYPH, KIND_LABEL, loadPublisherName, savePublisherName } from '../lib/registry';
import { ScanReportView } from './SkillBits';

const mono: React.CSSProperties = { fontFamily: 'var(--mono)' };
const label: React.CSSProperties = { fontSize: 11, fontWeight: 600, letterSpacing: '.5px', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 8 };
const input: React.CSSProperties = { width: '100%', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', color: 'var(--text)', fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const chip = (text: string, color = 'var(--text-dim)') => (
  <span key={text} style={{ fontSize: 10.5, color, background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 6, padding: '2px 8px', ...mono }}>{text}</span>
);

export type PublishTarget =
  | { kind: 'agent'; agentId: string }
  | { kind: 'skill'; skillId: string }
  | { kind: 'app'; agentId: string; appId: string };

/** The "Publish" affordance: a small button that opens the form. */
export function PublishButton({ target, defaultName, defaultDescription, compact, onDone }: { target: PublishTarget; defaultName: string; defaultDescription?: string; compact?: boolean; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={(e) => { e.stopPropagation(); setOpen(true); }} title={`Publish this ${KIND_LABEL[target.kind].toLowerCase()} to the Community market`}
        style={compact
          ? { background: 'none', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 7, padding: '4px 12px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', flex: 'none' }
          : { background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 9, padding: '8px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 7 }}>
        {!compact && <I d={P.market} size={14} />}Publish
      </button>
      {open && <PublishModal target={target} defaultName={defaultName} defaultDescription={defaultDescription} onClose={() => { setOpen(false); onDone?.(); }} />}
    </>
  );
}

/** Name, description, publisher name → Scan (dry run, nothing written) →
 *  the scan result and the capability summary → Publish. */
export function PublishModal({ target, defaultName, defaultDescription, onClose }: { target: PublishTarget; defaultName: string; defaultDescription?: string; onClose: () => void }) {
  const app = useApp();
  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState(defaultDescription ?? '');
  const [publisher, setPublisher] = useState(() => loadPublisherName(typeof localStorage === 'undefined' ? null : localStorage));
  const [preview, setPreview] = useState<Extract<RegistryPublishResult, { dryRun: true }> | null>(null);
  const [busy, setBusy] = useState<'scan' | 'publish' | null>(null);
  const [error, setError] = useState('');
  const base: RegistryPublishInput = { ...target, name: name.trim() || undefined, description: description.trim() || undefined, publisherName: publisher.trim() || undefined };

  const scan = async () => {
    setBusy('scan'); setError('');
    try { setPreview(await api.registryPublish({ ...base, dryRun: true }) as Extract<RegistryPublishResult, { dryRun: true }>); }
    catch (err) { setError(err instanceof Error ? err.message.slice(0, 300) : 'scan failed'); }
    finally { setBusy(null); }
  };
  const publish = async () => {
    setBusy('publish'); setError('');
    try {
      const res = await api.registryPublish(base);
      if (res.dryRun) return;
      savePublisherName(typeof localStorage === 'undefined' ? null : localStorage, publisher.trim());
      const pushed = res.pushed.attempted ? (res.pushed.ok ? ' · pushed to the remote registry' : ` · remote push failed: ${res.pushed.error ?? ''}`) : '';
      app.showToast(`Published ${res.item.name} v${res.item.version}${pushed}`.slice(0, 160));
      onClose();
    } catch (err) { setError(err instanceof Error ? err.message.slice(0, 300) : 'publish failed'); }
    finally { setBusy(null); }
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', backdropFilter: 'blur(2px)', zIndex: 110, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 520, maxWidth: '100%', maxHeight: '88vh', overflowY: 'auto', background: 'var(--elev)', border: '1px solid var(--border)', borderRadius: 16, boxShadow: 'var(--shadow)', animation: 'pop .16s' }}>
        <div style={{ padding: '18px 22px 14px', borderBottom: '1px solid var(--border-soft)' }}>
          <div style={{ fontSize: 15.5, fontWeight: 700 }}>{KIND_GLYPH[target.kind]} Publish {KIND_LABEL[target.kind].toLowerCase()} to the Community market</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 3, lineHeight: 1.5 }}>
            {target.kind === 'agent' && 'Publishes the agent\'s design — identity, charter, loops (disabled), dashboard, mini apps and private skills. Lessons, tasks and your profile never leave.'}
            {target.kind === 'skill' && 'Publishes the skill as an agentskills.io SKILL.md. Installers get it as a draft they must approve.'}
            {target.kind === 'app' && 'Publishes the app\'s HTML and its capability manifest. Installers get elevated capabilities parked until they review them.'}
          </div>
        </div>
        <div style={{ padding: '14px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {target.kind !== 'skill' && (
            <div><div style={label}>Name</div><input value={name} onChange={(e) => { setName(e.target.value); setPreview(null); }} maxLength={60} style={input} /></div>
          )}
          <div><div style={label}>Description</div><input value={description} onChange={(e) => { setDescription(e.target.value); setPreview(null); }} maxLength={300} placeholder="One line: what it does and for whom" style={input} /></div>
          <div><div style={label}>Publisher name</div><input value={publisher} onChange={(e) => { setPublisher(e.target.value); setPreview(null); }} maxLength={60} placeholder="Shown on the card — a handle, not an email" style={input} /></div>
          {preview && (
            <div>
              <div style={label}>Scan result</div>
              <ScanReportView report={preview.scanReport} title={`${KIND_LABEL[preview.kind]} "${preview.name}"`} />
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'var(--text-dim)' }}>
                {preview.capabilities.tools.length > 0 && <div>Tools mentioned: <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>{preview.capabilities.tools.map((t) => chip(t))}</span></div>}
                {preview.capabilities.connections.length > 0 && <div>Connections implied: {preview.capabilities.connections.join(', ')}</div>}
                {preview.capabilities.loops.length > 0 && <div>Loops: {preview.capabilities.loops.map((l) => `${l.name}${l.cron ? ` (${l.cron})` : l.trigger ? ` (${l.trigger})` : ''}`).join(', ')} — publish disabled</div>}
                {preview.capabilities.skills.length > 0 && target.kind === 'agent' && <div>Skills bundled: {preview.capabilities.skills.map((s) => `/${s.name}`).join(', ')}</div>}
                {preview.capabilities.apps.length > 0 && target.kind === 'agent' && <div>Mini apps: {preview.capabilities.apps.map((a) => `${a.name}${a.capabilities.length ? ` [${a.capabilities.join(', ')}]` : ''}`).join(', ')}</div>}
                {preview.capabilities.appCapabilities && <div>Capabilities: free {preview.capabilities.appCapabilities.free.join(', ') || '—'} · elevated {preview.capabilities.appCapabilities.elevated.join(', ') || '—'}</div>}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 8 }}>This is what installers will review. Flags are shown to them verbatim; a blocking flag would have refused this scan.</div>
            </div>
          )}
          {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
        </div>
        <div style={{ padding: '14px 22px', borderTop: '1px solid var(--border-soft)', display: 'flex', gap: 10, alignItems: 'center' }}>
          <span style={{ fontSize: 11.5, color: 'var(--text-faint)', flex: 1 }}>Re-publishing the same name bumps the version and keeps its installs.</span>
          <button onClick={onClose} style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 9, padding: '8px 15px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
          {!preview ? (
            <button disabled={busy !== null} onClick={() => void scan()} style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 9, padding: '8px 16px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>{busy === 'scan' ? 'Scanning…' : 'Scan'}</button>
          ) : (
            <button disabled={busy !== null} onClick={() => void publish()} style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 9, padding: '8px 16px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>{busy === 'publish' ? 'Publishing…' : 'Publish'}</button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The mandatory capability review before an install. Opens by asking the
 * server for the review (`POST …/install` without confirm), shows every
 * part of it, then confirms. Nothing is created until "Approve & install".
 */
export function RegistryReviewModal({ item, onClose, onInstalled }: { item: RegistryItem; onClose: () => void; onInstalled?: () => void }) {
  const app = useApp();
  const [review, setReview] = useState<RegistryReview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [openSkill, setOpenSkill] = useState<string | null>(null);
  const [showCharter, setShowCharter] = useState(false);
  const [showHtml, setShowHtml] = useState(false);
  const [agentId, setAgentId] = useState(app.agents[0]?.id ?? '');
  const [scope, setScope] = useState<'workspace' | 'agent'>('workspace');
  const [name, setName] = useState(item.name);
  useEffect(() => {
    setReview(null); setError('');
    api.registryInstall(item.id, false).then((r) => {
      if ('requiresConfirm' in r) setReview(r.review); else setError('unexpected: the server installed without confirmation');
    }).catch((err) => setError(err instanceof Error ? err.message.slice(0, 300) : 'could not load the review'));
  }, [item.id]);

  const install = async () => {
    if (!review || busy) return;
    setBusy(true); setError('');
    try {
      const options = review.kind === 'app'
        ? { agentId }
        : review.kind === 'skill'
          ? { workspaceId: app.workspaceId || undefined, ...(scope === 'agent' && agentId ? { agentId } : {}) }
          : { workspaceId: app.workspaceId || undefined, name: name.trim() || undefined };
      const res = await api.registryInstall(item.id, true, options);
      if ('requiresConfirm' in res) throw new Error('the server asked for confirmation again');
      await Promise.all([app.refreshAgents().catch(() => {}), app.refreshSkills().catch(() => {})]);
      app.showToast(`Installed ${item.name}${res.notes.length ? ` — ${res.notes.join('; ')}` : ''}`.slice(0, 200));
      onInstalled?.();
      onClose();
      if (res.agentId && review.kind === 'agent') app.openAgent(res.agentId);
    } catch (err) { setError(err instanceof Error ? err.message.slice(0, 300) : 'install failed'); }
    finally { setBusy(false); }
  };

  const section = (title: string, body: React.ReactNode) => <div style={{ marginTop: 16 }}><div style={label}>{title}</div>{body}</div>;
  const canInstall = !!review && review.scanReport.ok && !(review.kind === 'app' && !agentId) && !(review.kind === 'skill' && scope === 'agent' && !agentId);

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', backdropFilter: 'blur(2px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 560, maxWidth: '100%', maxHeight: '88vh', overflowY: 'auto', background: 'var(--elev)', border: '1px solid var(--border)', borderRadius: 18, boxShadow: 'var(--shadow)', animation: 'pop .16s' }}>
        <div style={{ padding: '22px 24px 18px', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 48, height: 48, borderRadius: 13, background: 'var(--panel-2)', border: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', fontSize: 23 }}>{KIND_GLYPH[item.kind]}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 700 }}>Review before installing {item.name}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 2 }}>
              {KIND_LABEL[item.kind]} · v{item.version} · {item.publisherName || 'anonymous publisher'} · {item.source === 'remote' ? `from ${item.remoteUrl.replace(/^https?:\/\//, '')}` : 'this instance'}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 4, display: 'flex' }}><I d={P.x} size={18} /></button>
        </div>
        <div style={{ padding: '18px 24px' }}>
          {!review && !error && <div style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>Loading the review…</div>}
          {review && <>
            <div style={label}>What installing creates</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {review.installs.map((line, i) => (
                <div key={i} style={{ display: 'flex', gap: 9, fontSize: 12.5, color: 'var(--text-dim)' }}><span style={{ color: 'var(--green)' }}>•</span><span>{line}</span></div>
              ))}
            </div>

            {(review.tools.length > 0 || review.connections.length > 0) && section('Capabilities the text expects', (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {review.tools.length > 0 && <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>{review.tools.map((t) => chip(t))}</div>}
                {review.connections.length > 0 && <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Connections implied: {review.connections.join(', ')} — nothing is granted by installing; you grant per agent on its Skills &amp; tools tab.</div>}
              </div>
            ))}

            {review.loops.length > 0 && section('Scheduled loops', (
              <div style={{ padding: '11px 13px', border: '1px solid var(--border-soft)', borderRadius: 11, background: 'var(--panel-2)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, color: 'var(--green)', marginBottom: 6 }}>
                  <I d={P.check} size={14} sw={2.4} />Install disabled — enable each on the Schedule tab after reading its prompt
                </div>
                {review.loops.map((l) => (
                  <div key={l.name} style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12, color: 'var(--text-dim)', padding: '2px 0' }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--text-faint)', flex: 'none' }} />
                    <span style={{ flex: 1 }}>{l.name}</span>
                    <span style={{ ...mono, color: 'var(--text-faint)' }}>{l.cron ?? l.trigger ?? ''}</span>
                  </div>
                ))}
              </div>
            ))}

            {review.charter !== undefined && section('Charter', (
              <div>
                <button onClick={() => setShowCharter(!showCharter)} style={{ background: 'none', border: 'none', color: 'var(--accent-hi)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', padding: 0 }}>{showCharter ? 'Hide text' : `Read text (${review.charter.length} chars)`}</button>
                {showCharter && <pre style={{ margin: '7px 0 0', padding: '9px 11px', background: 'var(--code)', border: '1px solid var(--border-soft)', borderRadius: 8, ...mono, fontSize: 11, lineHeight: 1.55, color: 'var(--text-dim)', whiteSpace: 'pre-wrap', maxHeight: 240, overflowY: 'auto' }}>{review.charter || '(empty)'}</pre>}
              </div>
            ))}

            {review.skillBodies.length > 0 && section(`Skills · ${review.skillBodies.length} (install as drafts)`, (
              <div style={{ maxHeight: 230, overflowY: 'auto', border: '1px solid var(--border-soft)', borderRadius: 10, background: 'var(--panel-2)' }}>
                {review.skillBodies.map((s) => (
                  <div key={s.name} style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-soft)' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, ...mono, flex: 1, minWidth: 0 }}>/{s.name}</div>
                      <button onClick={() => setOpenSkill(openSkill === s.name ? null : s.name)} style={{ background: 'none', border: 'none', color: 'var(--accent-hi)', fontSize: 11, fontWeight: 600, cursor: 'pointer', padding: 0, flex: 'none' }}>{openSkill === s.name ? 'Hide text' : 'Read text'}</button>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 1 }}>{s.description}</div>
                    {openSkill === s.name && <pre style={{ margin: '7px 0 2px', padding: '9px 11px', background: 'var(--code)', border: '1px solid var(--border-soft)', borderRadius: 8, ...mono, fontSize: 11, lineHeight: 1.55, color: 'var(--text-dim)', whiteSpace: 'pre-wrap', maxHeight: 260, overflowY: 'auto' }}>{s.instructions}</pre>}
                  </div>
                ))}
              </div>
            ))}

            {review.appHtml !== undefined && section('Mini app', (
              <div>
                {review.capabilities.appCapabilities && (
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 6 }}>
                    {review.capabilities.appCapabilities.free.map((c) => chip(c, 'var(--green)'))}
                    {review.capabilities.appCapabilities.elevated.map((c) => chip(`${c} · parked`, 'var(--amber)'))}
                  </div>
                )}
                <button onClick={() => setShowHtml(!showHtml)} style={{ background: 'none', border: 'none', color: 'var(--accent-hi)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', padding: 0 }}>{showHtml ? 'Hide source' : `Read source (${review.appHtml.length} chars)`}</button>
                {showHtml && <pre style={{ margin: '7px 0 0', padding: '9px 11px', background: 'var(--code)', border: '1px solid var(--border-soft)', borderRadius: 8, ...mono, fontSize: 10.5, lineHeight: 1.5, color: 'var(--text-dim)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 260, overflowY: 'auto' }}>{review.appHtml}</pre>}
              </div>
            ))}

            {section(review.source === 'remote' ? 'Scan (run here, just now)' : 'Scan (run at publish)', <ScanReportView report={review.scanReport} title={`${KIND_LABEL[review.kind]} "${review.name}"`} />)}

            {review.kind === 'app' && section('Install on', (
              <select value={agentId} onChange={(e) => setAgentId(e.target.value)} style={input}>
                {app.agents.length === 0 && <option value="">Create an agent first</option>}
                {app.agents.map((a) => <option key={a.id} value={a.id}>{a.emoji} {a.name}</option>)}
              </select>
            ))}
            {review.kind === 'skill' && section('Scope', (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <select value={scope} onChange={(e) => setScope(e.target.value as 'workspace' | 'agent')} style={{ ...input, width: 'auto', flex: 1 }}>
                  <option value="workspace">Workspace-shared draft</option>
                  <option value="agent">Private to one agent</option>
                </select>
                {scope === 'agent' && (
                  <select value={agentId} onChange={(e) => setAgentId(e.target.value)} style={{ ...input, width: 'auto', flex: 1 }}>
                    {app.agents.map((a) => <option key={a.id} value={a.id}>{a.emoji} {a.name}</option>)}
                  </select>
                )}
              </div>
            ))}
            {review.kind === 'agent' && section('Agent name', <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} style={input} />)}
          </>}
          {error && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 12 }}>{error}</div>}
        </div>
        <div style={{ padding: '16px 24px', borderTop: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>Nothing runs until you enable it: loops off, skills drafts, capabilities parked.</span>
          <button onClick={onClose} style={{ marginLeft: 'auto', background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 9, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
          <button disabled={!canInstall || busy} onClick={() => void install()} style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 9, padding: '9px 18px', fontSize: 13, fontWeight: 700, cursor: canInstall && !busy ? 'pointer' : 'default', opacity: canInstall && !busy ? 1 : 0.5 }}>{busy ? 'Installing…' : 'Approve & install'}</button>
        </div>
      </div>
    </div>
  );
}
