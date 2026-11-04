/** Blueprints in the app (docs/blueprints.md; docs/company-vision.md §9;
 *  execution plan item 24): under Settings › Company the
 *  CEO exports the company as COMPANY.json, imports one (paste or file →
 *  the dry-run plan → confirm) and publishes it to the registry (dry run
 *  first); the Market's Companies tab installs a published one into a
 *  workspace through the same review → plan → confirm flow. */
/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../store';
import { api, type Blueprint, type BlueprintImportPlan, type CompanyRegistryItem, type ImportMode, type RegistryPublishResult, type Workspace } from '../lib/api';
import { blueprintFileName, blueprintPlanSummary, hiresByRole } from '../lib/org2';
import { flagCount, loadPublisherName, savePublisherName } from '../lib/registry';
import { humanCron, MEETING_KIND_TITLES } from '../lib/org';
import { card, input, btn, pill, faint, label, linkBtn } from './org-ui';

const mono: React.CSSProperties = { fontFamily: 'var(--mono)' };

/** The import plan as a review: the chief, hires by role with scopes after
 *  the meet and what was dropped, units, budget, tunables, playbooks,
 *  cadences, recommended cards and connections, notes. */
export function ImportPlanView({ plan }: { plan: BlueprintImportPlan }) {
  const groups = hiresByRole(plan.hires);
  const row: React.CSSProperties = { fontSize: 12.5, padding: '4px 0', borderBottom: '1px solid var(--border-soft)' };
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ fontSize: 13, lineHeight: 1.5 }}>{blueprintPlanSummary(plan)}</div>
      {!plan.ok && <div style={{ color: 'var(--red)', fontSize: 12.5 }}>This blueprint cannot be imported as is — see the notes.</div>}
      <div>
        <div style={label}>Chief of staff</div>
        <div style={row}><b>{plan.chief.title}</b>{plan.chief.roleId ? <span style={{ ...faint, marginLeft: 6 }}>role:{plan.chief.roleId}</span> : null} · {plan.chief.modelTier} → <span style={mono}>{plan.chief.model}</span>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 3 }}>{plan.chief.scopes.map((s) => <span key={s} style={{ ...pill(), ...mono }}>{s}</span>)}{plan.chief.dropped.map((s) => <s key={s} style={{ ...faint, ...mono }} title="Requested but not held by the workspace">{s}</s>)}</div>
        </div>
      </div>
      <div>
        <div style={label}>Hires · {plan.hires.length}</div>
        {groups.map((g) => (
          <div key={g.role} style={row}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}><b>{g.rows[0].title}</b>{g.rows.length > 1 && <span style={pill()}>×{g.rows.length}</span>}{g.rows[0].roleId ? <span style={faint}>role:{g.rows[0].roleId}</span> : <span style={faint}>template</span>}</div>
            {g.rows.map((h, i) => (
              <div key={i} style={{ ...faint, marginTop: 2, paddingLeft: 8 }}>
                reports to {h.reportsTo} · {h.modelTier} → <span style={mono}>{h.model}</span> · ${h.monthlyUsd.toFixed(2)}/month
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 2 }}>{h.scopes.map((s) => <span key={s} style={{ ...pill(), ...mono }}>{s}</span>)}{h.dropped.map((s) => <s key={s} style={{ ...mono }} title="Dropped: outside what the chief holds">{s}</s>)}</div>
              </div>
            ))}
          </div>
        ))}
        {plan.hires.length === 0 && <div style={faint}>No hire beyond the chief.</div>}
      </div>
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        <div><div style={label}>Units · {plan.units.length}</div>{plan.units.map((u) => <div key={u.title} style={{ fontSize: 12.5 }}>{u.title}{u.parent ? <span style={faint}> under {u.parent}</span> : <span style={faint}> (company)</span>}</div>)}</div>
        <div><div style={label}>Budget</div><div style={{ fontSize: 12.5 }}>${plan.budget.monthlyUsd.toFixed(2)}/month{plan.budget.allocated > 0 ? <>, ${plan.budget.allocated.toFixed(2)} allocated:</> : null}</div>{Object.entries(plan.budget.allocations).map(([k, v]) => <div key={k} style={faint}>{k}: ${v.toFixed(2)}</div>)}</div>
        <div><div style={label}>Tunables · {plan.tunables.length}</div>{plan.tunables.map((t) => <div key={t.key} style={{ fontSize: 12, ...mono }}>{t.key} = {t.applied}{t.applied !== t.value ? <span style={{ color: 'var(--amber)' }}> (asked {t.value}{t.note ? `: ${t.note}` : ''})</span> : null}</div>)}</div>
        <div><div style={label}>Playbooks · {plan.playbooks.length}</div>{plan.playbooks.map((p) => <div key={p.name} style={{ fontSize: 12, ...mono }}>/{p.name} <span style={faint}>draft</span></div>)}</div>
      </div>
      {(plan.projects?.length ?? 0) > 0 && (
        <div data-testid="blueprint-plan-projects">
          <div style={label}>Projects · {plan.projects!.length} <span style={faint}>(created in Next once the hires exist)</span></div>
          {plan.projects!.map((p) => (
            <div key={p.title} style={{ fontSize: 12.5, marginTop: 4 }}>
              <b>{p.title}</b> <span style={faint}>led by {p.lead}{p.cadence ? ` · standup ${p.cadence}` : ''}</span>
              <div style={faint}>Team: {p.team.length ? p.team.map((m) => `${m.title}${m.role ? ` (${m.role})` : ''} ${m.allocation}%`).join(', ') : 'none'}</div>
            </div>
          ))}
        </div>
      )}
      <div style={faint}>
        {plan.vision ? <>Vision “{plan.vision.title}” over {plan.vision.horizonDays} days · </> : 'No vision · '}
        profile: {[plan.profile.values && 'values', plan.profile.culture && 'culture', plan.profile.rules && 'rules'].filter(Boolean).join(', ') || 'none'} · {plan.cadences.count} cadence(s) {plan.cadences.applied ? 'applied' : 'listed'}{plan.cadences.note ? ` (${plan.cadences.note})` : ''}
      </div>
      {(plan.cadences.list?.length ?? 0) > 0 && (
        <div>
          <div style={label}>Cadences · {plan.cadences.list!.length} — listed for the chief to set; the import writes none</div>
          {plan.cadences.list!.map((c, i) => <div key={i} style={{ fontSize: 12.5 }}>{MEETING_KIND_TITLES[c.kind] ?? c.kind.replace(/_/g, ' ')} <span style={faint}>· {c.unitTitle === 'root' ? 'company' : c.unitTitle} · {humanCron(c.cron)}</span></div>)}
        </div>
      )}
      {(plan.recommendedCards.length > 0 || plan.recommendedConnections.length > 0) && <div style={faint}>Recommended after import: {[...plan.recommendedConnections.map((c) => `connect ${c}`), ...plan.recommendedCards.map((c) => `card ${c}`)].join(', ')}.</div>}
      {plan.notes.length > 0 && <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--text-dim)' }}>{plan.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
    </div>
  );
}

/** Settings › Company → Blueprint: export, import, publish. */
export function BlueprintCard({ ws }: { ws: Workspace }) {
  const app = useApp();
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState('');
  const [mode, setMode] = useState<ImportMode>('supervised');
  const [usd, setUsd] = useState('');
  const [plan, setPlan] = useState<BlueprintImportPlan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [publish, setPublish] = useState<{ name: string; description: string; publisher: string; preview: RegistryPublishResult | null } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = (e: unknown, fallback: string) => app.showToast(e instanceof Error ? e.message.slice(0, 200) : fallback);
  const parsed = (): Record<string, unknown> | null => { try { const v = JSON.parse(raw) as unknown; return v && typeof v === 'object' ? v as Record<string, unknown> : null; } catch { return null; } };
  const exportIt = async () => {
    setBusy('export');
    try {
      const bp: Blueprint = await api.orgBlueprint(ws.id);
      const blob = new Blob([JSON.stringify(bp, null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = blueprintFileName(bp.name || ws.name); a.click(); URL.revokeObjectURL(a.href);
      app.showToast(`Exported ${bp.roles.length} role(s), ${bp.playbooks.length} playbook(s) — no memory, no credentials, no names`);
    } catch (e) { toast(e, 'export failed'); } finally { setBusy(null); }
  };
  const onFile = (f: File | undefined) => { if (!f) return; void f.text().then((t) => { setRaw(t); setPlan(null); }); };
  const planIt = async () => {
    const bp = parsed();
    if (!bp) { app.showToast('Paste or pick a COMPANY.json first'); return; }
    setBusy('plan');
    try { setPlan(await api.orgBlueprintPlan(ws.id, bp, { mode, monthlyUsd: usd.trim() ? Number(usd) || 0 : undefined })); } catch (e) { toast(e, 'the plan failed'); } finally { setBusy(null); }
  };
  const importIt = async () => {
    const bp = parsed();
    if (!bp || !plan) return;
    if (!confirm(`Import "${plan.name}" in ${mode} mode? ${blueprintPlanSummary(plan)}`)) return;
    setBusy('import');
    try {
      const r = await api.orgBlueprintImport(ws.id, bp, mode, usd.trim() ? Number(usd) || 0 : undefined);
      app.showToast(r.approvalId ? `Imported — ${r.hired.length} hire(s) wait on one approval card` : `Imported — ${r.hired.length} hire(s) made`);
      setPlan(null); setRaw('');
      await Promise.all([app.refreshWsOrg(), app.refreshAgents(), app.refreshWorkspaces()]);
      if (r.approvalId) app.setOrgPane('approvals'); // the card waits in the Inbox
    } catch (e) { toast(e, 'import failed'); } finally { setBusy(null); }
  };
  const startPublish = () => setPublish({ name: ws.name, description: '', publisher: loadPublisherName(typeof localStorage === 'undefined' ? null : localStorage), preview: null });
  const publishIt = async (dryRun: boolean) => {
    if (!publish) return;
    setBusy('publish');
    try {
      savePublisherName(typeof localStorage === 'undefined' ? null : localStorage, publish.publisher);
      const r = await api.publishCompany({ workspaceId: ws.id, name: publish.name.trim() || undefined, description: publish.description.trim() || undefined, publisherName: publish.publisher.trim() || undefined, dryRun });
      if (dryRun) setPublish({ ...publish, preview: r });
      else { app.showToast(`Published "${publish.name}" to the registry${'pushed' in r && r.pushed.attempted ? (r.pushed.ok ? ' and pushed upstream' : ` (upstream push failed: ${r.pushed.error ?? ''})`) : ''}`); setPublish(null); }
    } catch (e) { toast(e, 'publish failed'); } finally { setBusy(null); }
  };
  const preview = publish?.preview;
  const flags = preview && 'scanReport' in preview ? flagCount(preview.scanReport) : 0;
  return (
    <div style={{ marginTop: 14, borderTop: '1px solid var(--border-soft)', paddingTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Blueprint</div>
          <div style={faint}>The company as COMPANY.json: roles with charters, scopes and tiers, departments, cadences, tunables, routing, playbooks, budget. Never memory, credentials, names or history.</div>
        </div>
        <button style={btn()} disabled={busy === 'export'} onClick={() => void exportIt()}>{busy === 'export' ? 'Exporting…' : 'Export blueprint'}</button>
        <button style={btn()} onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide import' : 'Import blueprint'}</button>
        <button style={btn()} onClick={startPublish}>Publish to registry</button>
      </div>
      {open && (
        <div style={{ ...card, marginTop: 10, display: 'grid', gap: 8 }}>
          <div style={faint}>Importing into a workspace that already has a company adds roles under its chief; into an empty one it creates the company. The plan below applies nothing.</div>
          <textarea aria-label="COMPANY.json" value={raw} onChange={(e) => { setRaw(e.target.value); setPlan(null); }} rows={6} placeholder='Paste a COMPANY.json ({"format":"yaam.company/1", …})' style={{ ...input, ...mono, fontSize: 11.5, resize: 'vertical' }} />
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <input ref={fileRef} type="file" accept="application/json,.json" aria-label="Blueprint file" onChange={(e) => onFile(e.target.files?.[0])} style={{ display: 'none' }} />
            <button style={btn()} onClick={() => fileRef.current?.click()}>Pick a file…</button>
            <select aria-label="Mode" value={mode} onChange={(e) => { setMode(e.target.value as ImportMode); setPlan(null); }} style={{ ...input, width: 'auto' }}><option value="supervised">supervised (hires as one card)</option><option value="autonomous">autonomous (hires at once)</option></select>
            <input aria-label="Monthly USD" value={usd} onChange={(e) => { setUsd(e.target.value.replace(/[^\d.]/g, '')); setPlan(null); }} placeholder="envelope $/month (blueprint's by default)" style={{ ...input, ...mono, width: 220 }} />
            <span style={{ flex: 1 }} />
            <button style={btn(true)} disabled={!raw.trim() || busy === 'plan'} onClick={() => void planIt()}>{busy === 'plan' ? 'Planning…' : 'Show the plan'}</button>
          </div>
          {plan && (
            <div style={{ ...card, background: 'var(--panel-2)' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}><span style={pill('var(--blue)', '#fff')}>dry run — nothing applied</span><b>{plan.name}</b><span style={pill()}>{plan.mode}</span></div>
              <ImportPlanView plan={plan} />
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 10 }}>
                <button style={btn()} onClick={() => setPlan(null)}>Cancel</button>
                <button style={btn(true)} disabled={!plan.ok || busy === 'import'} onClick={() => void importIt()}>{busy === 'import' ? 'Importing…' : plan.approval === 'blueprint' ? 'Import and create the approval card' : 'Import now'}</button>
              </div>
            </div>
          )}
        </div>
      )}
      {publish && (
        <div style={{ ...card, marginTop: 10, display: 'grid', gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Publish this company to the registry</div>
          <div style={faint}>The export is scanned and review-gated like any registry item; installers see the roles, scopes, playbook bodies and the scan before the plan. Outcomes (first key result achieved, thirty days in envelope) are counted anonymously when <code>shareBlueprintOutcomes</code> is on.</div>
          <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
            <input aria-label="Name" value={publish.name} onChange={(e) => setPublish({ ...publish, name: e.target.value, preview: null })} placeholder="Name" style={input} />
            <input aria-label="Publisher" value={publish.publisher} onChange={(e) => setPublish({ ...publish, publisher: e.target.value })} placeholder="Publisher name" style={input} />
          </div>
          <input aria-label="Description" value={publish.description} onChange={(e) => setPublish({ ...publish, description: e.target.value, preview: null })} placeholder="What this company does and for whom" style={input} />
          {preview && 'dryRun' in preview && preview.dryRun && (
            <div style={{ ...faint, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={pill(flags ? 'var(--amber)' : 'var(--green)', '#fff')}>{flags ? `${flags} scan flag(s)` : 'scan clean'}</span>
              <span>slug <span style={mono}>{preview.slug}</span> · {preview.capabilities.tools.length} tool scope(s) · {preview.capabilities.skills.length} playbook(s)</span>
              {!preview.scanReport.ok && <span style={{ color: 'var(--red)' }}>blocked: {preview.scanReport.flags.filter((f) => f.severity === 'block').map((f) => f.detail).join('; ')}</span>}
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button style={btn()} onClick={() => setPublish(null)}>Cancel</button>
            <button style={btn()} disabled={busy === 'publish'} onClick={() => void publishIt(true)}>Preview (dry run)</button>
            <button style={btn(true)} disabled={busy === 'publish' || !preview || !('scanReport' in preview) || !preview.scanReport.ok} onClick={() => void publishIt(false)} title={preview ? '' : 'Run the preview first'}>Publish</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Market → Companies: a published blueprint's install flow — review and plan, then confirm. */
export function CompanyInstallModal({ item, onClose, onInstalled }: { item: CompanyRegistryItem; onClose: () => void; onInstalled?: () => void }) {
  const app = useApp();
  const [wsId, setWsId] = useState(app.workspaceId ?? app.workspaces[0]?.id ?? '');
  const [mode, setMode] = useState<ImportMode>('supervised');
  const [usd, setUsd] = useState('');
  const [step, setStep] = useState<Extract<import('../lib/api').CompanyInstallResult, { requiresConfirm: true }> | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [openSkill, setOpenSkill] = useState<string | null>(null);
  const review = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api.installCompany(item.id, { workspaceId: wsId, mode, monthlyUsd: usd.trim() ? Number(usd) || 0 : undefined });
      if ('requiresConfirm' in r) setStep(r); else { app.showToast('Installed'); onInstalled?.(); onClose(); }
    } catch (e) { setErr(e instanceof Error ? e.message.slice(0, 200) : 'failed'); } finally { setBusy(false); }
  };
  useEffect(() => { setStep(null); }, [wsId, mode, usd]);
  const confirmIt = async () => {
    if (!step) return;
    setBusy(true); setErr('');
    try {
      const r = await api.installCompany(item.id, { workspaceId: wsId, mode, monthlyUsd: usd.trim() ? Number(usd) || 0 : undefined, confirm: true });
      if ('ok' in r) {
        app.showToast(r.approvalId ? `Installed — ${r.hired.length} hire(s) wait on one approval card in that workspace` : `Installed — ${r.hired.length} hire(s) made`);
        await Promise.all([app.refreshWsOrg(), app.refreshAgents(), app.refreshWorkspaces()]);
        onInstalled?.(); onClose();
      }
    } catch (e) { setErr(e instanceof Error ? e.message.slice(0, 200) : 'failed'); } finally { setBusy(false); }
  };
  const flags = step ? flagCount(step.review.scanReport) : flagCount(item.scanReport);
  return (
    <div onClick={onClose} role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', backdropFilter: 'blur(2px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 640, maxWidth: '100%', maxHeight: '88vh', overflowY: 'auto', background: 'var(--elev)', border: '1px solid var(--border)', borderRadius: 18, boxShadow: 'var(--shadow)', padding: 20, display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 26 }}>🏢</span>
          <div style={{ flex: 1 }}><div style={{ fontSize: 16, fontWeight: 700 }}>Install {item.name}</div><div style={faint}>{item.publisherName || 'anonymous'} · v{item.version} · {item.installs} install(s) · {item.outcomes.first_key_result} reached a first key result · {item.outcomes.thirty_days_in_envelope} ran thirty days in envelope</div></div>
          <button style={btn()} onClick={onClose} aria-label="Close">×</button>
        </div>
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <select aria-label="Workspace" value={wsId} onChange={(e) => setWsId(e.target.value)} style={input}>{app.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
          <select aria-label="Mode" value={mode} onChange={(e) => setMode(e.target.value as ImportMode)} style={input}><option value="supervised">supervised (hires as one card)</option><option value="autonomous">autonomous (hires at once)</option></select>
          <input aria-label="Monthly USD" value={usd} onChange={(e) => setUsd(e.target.value.replace(/[^\d.]/g, ''))} placeholder="envelope $/month (optional)" style={{ ...input, ...mono }} />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={pill(flags ? 'var(--amber)' : 'var(--green)', '#fff')}>{flags ? `${flags} scan flag(s)` : 'scan clean'}</span>
          <span style={faint}>{item.description || 'No description.'}</span>
        </div>
        {err && <div style={{ color: 'var(--red)', fontSize: 12.5 }}>{err}</div>}
        {step && (
          <>
            {step.review.skillBodies.length > 0 && (
              <div>
                <div style={label}>Playbooks · {step.review.skillBodies.length} — read them; they become standing instructions (as drafts)</div>
                {step.review.skillBodies.map((s) => (
                  <div key={s.name} style={{ padding: '6px 0', borderBottom: '1px solid var(--border-soft)' }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}><span style={{ ...mono, fontSize: 12.5, fontWeight: 600, flex: 1 }}>/{s.name}</span><button style={linkBtn} onClick={() => setOpenSkill(openSkill === s.name ? null : s.name)}>{openSkill === s.name ? 'Hide text' : 'Read text'}</button></div>
                    <div style={faint}>{s.description}</div>
                    {openSkill === s.name && <pre style={{ ...mono, fontSize: 11, whiteSpace: 'pre-wrap', background: 'var(--panel-2)', padding: 8, borderRadius: 8, maxHeight: 220, overflow: 'auto', marginTop: 6 }}>{s.instructions}</pre>}
                  </div>
                ))}
              </div>
            )}
            <div style={{ ...card, background: 'var(--panel-2)' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}><span style={pill('var(--blue)', '#fff')}>plan — nothing applied yet</span></div>
              <ImportPlanView plan={step.plan} />
            </div>
          </>
        )}
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
          <span style={{ ...faint, flex: 1 }}>{step ? 'Confirm re-validates and re-scans the blueprint before creating the company.' : 'Step one shows the review and the plan; nothing is created.'}</span>
          <button style={btn()} onClick={onClose}>Cancel</button>
          {!step && <button style={btn(true)} disabled={!wsId || busy} onClick={() => void review()}>{busy ? 'Reviewing…' : 'Review & plan'}</button>}
          {step && <button style={btn(true)} disabled={busy || !step.plan.ok || !step.review.scanReport.ok} onClick={() => void confirmIt()}>{busy ? 'Installing…' : 'Confirm install'}</button>}
        </div>
      </div>
    </div>
  );
}
