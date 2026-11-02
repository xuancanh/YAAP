/** The New workspace wizard (execution plan item 25; docs/group-chat.md §5
 *  "Onboarding", docs/company-vision.md §1b): name and colour, then "run this
 *  workspace as a company?" with the three modes and their consequences,
 *  then — for a company — the chief of staff, the mission and vision, the
 *  values and culture, the budget with its fence, the ritual rhythm, the
 *  first hires (only when the role catalog answers) and a review of what
 *  will be created. One `POST …/org/bootstrap` does the setup; the same
 *  wizard opens from Settings → Workspace → Organization ("Enable company…")
 *  for a workspace that exists, starting at the mode step. Nothing the chief
 *  will read is a hidden default: every value is on screen in the review. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import { api, type Agent, type OrgCaps, type OrgRole } from '../lib/api';
import { I, P } from '../lib/icons';
import { safeJsonParse } from '../lib/util';
import { btn, faint, input, label, pill } from './org-ui';
import {
  buildBootstrapBody, buildSummary, CADENCE_CARDS, hiresEstimate, HORIZONS, initialWizardState, MAX_AGENT_CAP, MODE_CARDS, rankRoles, RITUAL_LINES, roleCostLabel, STEP_TITLES, successToast, validateAll, validateStep, wizardSteps,
  WORKSPACE_COLORS, type WizardState, type WizardStep,
} from '../lib/onboarding';

const textarea: React.CSSProperties = { ...input, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5, minHeight: 72 };
const field: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, color: 'var(--text-dim)' };
const err: React.CSSProperties = { fontSize: 11.5, color: 'var(--red)' };
const cardBtn = (on: boolean): React.CSSProperties => ({
  textAlign: 'left', flex: 1, minWidth: 0, padding: '11px 13px', borderRadius: 11, cursor: 'pointer', color: 'var(--text)', font: 'inherit',
  border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, background: on ? 'var(--accent-dim)' : 'var(--panel-2)',
});

export interface WizardProps {
  onClose: () => void;
  /** Set when opened from Settings for a workspace that exists: skips name and colour and only bootstraps. */
  existing?: { id: string; name: string };
}

const ROLES_SHOWN = 12;

export function NewWorkspaceWizard({ onClose, existing }: WizardProps) {
  const app = useApp();
  const [state, setState] = useState<WizardState>(() => initialWizardState(existing ? { name: existing.name } : {}));
  const [stepIx, setStepIx] = useState(0);
  const [touched, setTouched] = useState(false);
  const [roles, setRoles] = useState<OrgRole[] | null>(null);
  const [caps, setCaps] = useState<OrgCaps | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  const firstTextRef = useRef<HTMLTextAreaElement>(null);
  const isExisting = Boolean(existing);
  // The role catalog (item 24) and the caps are account-wide; the current
  // workspace's routes answer for a workspace that does not exist yet. 404 → hidden.
  const probeId = existing?.id ?? app.workspaceId;
  useEffect(() => {
    if (!probeId || !app.companiesEnabled) { setRoles(null); setCaps(null); return; }
    void api.orgRoles(probeId).then((r) => setRoles(r && r.length ? r : null)).catch(() => setRoles(null));
    void api.orgCaps(probeId).then(setCaps).catch(() => setCaps(null));
  }, [probeId, app.companiesEnabled]);
  // Entering the hires step re-ranks the catalog server-side against the
  // profile written so far (item 24: `GET …/org/roles?profile=`); the client
  // ranking below covers the gap and any failure.
  const profileText = `${state.vision.title} ${state.vision.description} ${state.profile.values} ${state.profile.culture}`;
  const [serverRanked, setServerRanked] = useState<OrgRole[] | null>(null);
  useEffect(() => {
    if (!probeId || !roles) { setServerRanked(null); return; }
    let live = true;
    void api.orgRoles(probeId, profileText.trim() || undefined).then((r) => { if (live) setServerRanked(r && r.length ? r : null); }).catch(() => { if (live) setServerRanked(null); });
    return () => { live = false; };
  }, [probeId, roles, profileText]);
  const opts = useMemo(() => ({ existing: isExisting, rolesAvailable: roles !== null }), [isExisting, roles]);
  const steps = useMemo(() => wizardSteps(state, opts), [state, opts]);
  const step: WizardStep = steps[Math.min(stepIx, steps.length - 1)];
  const errors = useMemo(() => validateStep(step, state, opts), [step, state, opts]);
  const allErrors = useMemo(() => validateAll(state, opts), [state, opts]);
  const canBack = stepIx > 0 && !busy;
  const isLast = step === 'review';
  useEffect(() => { setTouched(false); (firstRef.current ?? firstTextRef.current)?.focus(); }, [step]);
  // Only the agents of this workspace may be its chief; a brand-new workspace has none yet.
  // app.agents is the selected workspace's list; filtering by the wizard's
  // own target keeps the picker right even if the two ever differ.
  const ownAgents: Agent[] = isExisting ? app.agents.filter((a) => !a.workspaceId || a.workspaceId === existing?.id) : [];
  useEffect(() => {
    if (!isExisting && state.chief.kind === 'existing') setState((s) => ({ ...s, chief: { kind: 'create', name: 'Chief of staff', provider: '', model: '' } }));
  }, [isExisting, state.chief.kind]);
  const enabledTypes = app.agentTypes.filter((t) => t.enabled);
  const providers = Array.from(new Set(enabledTypes.map((t) => t.provider)));
  const modelsFor = (provider: string): string[] => Array.from(new Set(enabledTypes.filter((t) => t.provider === provider).flatMap((t) => [t.model, ...safeJsonParse<string[]>(t.models, [])]).filter(Boolean)));

  const next = () => {
    setTouched(true);
    if (Object.keys(errors).length > 0) return;
    setStepIx((i) => Math.min(i + 1, steps.length - 1));
  };
  const back = () => setStepIx((i) => Math.max(0, i - 1));
  const jump = (to: WizardStep) => { const ix = steps.indexOf(to); if (ix >= 0) setStepIx(ix); };

  const finish = async () => {
    if (allErrors.length > 0) { jump(allErrors[0].step); setTouched(true); return; }
    setFailure(null);
    try {
      let wsId = existing?.id ?? '';
      if (!existing) {
        setBusy('Creating the workspace…');
        const ws = await api.createWorkspace(state.name.trim(), state.color);
        wsId = ws.id;
        await app.refreshWorkspaces();
      }
      if (state.mode === 'none') {
        if (!existing) { app.pickWorkspace(wsId); app.showToast(`Workspace ${state.name.trim()} created`); }
        onClose();
        return;
      }
      setBusy(state.chief.kind === 'create' ? `Creating ${state.chief.name.trim() || 'the chief of staff'} and the company…` : 'Setting up the company…');
      const r = await api.bootstrapOrg(wsId, buildBootstrapBody(state));
      setBusy('Opening the vision…');
      if (!existing || wsId !== app.workspaceId) app.pickWorkspace(wsId);
      await Promise.all([app.refreshWorkspaces(), app.refreshAgents().catch(() => undefined)]);
      await app.refreshWsOrg();
      app.go('workspace');
      app.setOrgPane('vision');
      app.showToast(successToast(r));
      onClose();
    } catch (e) {
      setFailure(e instanceof Error ? e.message.replace(/^\d{3}\s*/, '').slice(0, 300) : 'failed');
      setBusy(null);
    }
  };

  const set = <K extends keyof WizardState>(k: K, v: WizardState[K]) => setState((s) => ({ ...s, [k]: v }));
  const rankedRoles = useMemo(() => (serverRanked ? serverRanked.filter((r) => r.id !== 'chief-of-staff') : roles ? rankRoles(roles, profileText) : []), [roles, serverRanked, profileText]);
  // The catalog grew a business set (a head and specialists per function):
  // show the best-ranked dozen plus anything picked, the rest on request.
  const [allRoles, setAllRoles] = useState(false);
  const shownRoles = allRoles ? rankedRoles : rankedRoles.filter((r, i) => i < ROLES_SHOWN || state.roles.includes(r.id));
  const roleName = (id: string) => roles?.find((r) => r.id === id.replace(/^role:/, ''))?.title;
  const agentName = (id: string) => ownAgents.find((a) => a.id === id)?.name;
  const show = (k: string) => (touched ? errors[k] : undefined);

  return (
    <div onClick={() => { if (!busy) onClose(); }} onKeyDown={(e) => { if (e.key === 'Escape' && !busy) onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', backdropFilter: 'blur(2px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }}>
      <div role="dialog" aria-modal="true" aria-labelledby="nww-title" onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(640px, 100%)', maxHeight: '92vh', display: 'flex', flexDirection: 'column', background: 'var(--elev)', border: '1px solid var(--border)', borderRadius: 18, boxShadow: 'var(--shadow)', animation: 'pop .16s', overflow: 'hidden' }}>
        <div style={{ padding: '18px 20px 14px', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.5px', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{existing ? `Enable company · ${existing.name}` : 'New workspace'} · step {stepIx + 1} of {steps.length}</div>
            <h2 id="nww-title" style={{ fontSize: 17, fontWeight: 700, margin: '3px 0 0' }}>{STEP_TITLES[step]}</h2>
          </div>
          <button type="button" aria-label="Close" disabled={Boolean(busy)} onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 4, display: 'flex' }}><I d={P.x} size={18} /></button>
        </div>
        <div aria-hidden style={{ display: 'flex', gap: 3, padding: '8px 20px 0' }}>
          {steps.map((s, i) => <span key={s} style={{ flex: 1, height: 3, borderRadius: 2, background: i <= stepIx ? 'var(--accent)' : 'var(--border)' }} />)}
        </div>
        <div style={{ padding: '16px 20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 }}>
          {step === 'name' && (
            <>
              <label style={field} htmlFor="nww-name">Workspace name
                <input id="nww-name" ref={firstRef} value={state.name} onChange={(e) => set('name', e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) next(); }} placeholder="Climate letters" style={input} aria-invalid={Boolean(show('name'))} />
                {show('name') && <span style={err}>{show('name')}</span>}
              </label>
              <div style={field}>
                <span id="nww-colour">Colour</span>
                <div role="radiogroup" aria-labelledby="nww-colour" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {WORKSPACE_COLORS.map((c) => (
                    <button key={c} type="button" role="radio" aria-checked={state.color === c} aria-label={`Colour ${c}`} onClick={() => set('color', c)}
                      style={{ width: 28, height: 28, borderRadius: 8, background: c, cursor: 'pointer', border: `2px solid ${state.color === c ? 'var(--text)' : 'transparent'}`, outlineOffset: 2 }} />
                  ))}
                </div>
              </div>
              <div style={faint}>Workspaces scope chats, channels, agents and files. The next step asks whether this one is a company too.</div>
            </>
          )}

          {step === 'mode' && (
            <div role="radiogroup" aria-label="How to run this workspace" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {MODE_CARDS.map((c) => (
                <button key={c.mode} type="button" role="radio" aria-checked={state.mode === c.mode} onClick={() => set('mode', c.mode)} style={cardBtn(state.mode === c.mode)}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{c.title}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2, lineHeight: 1.45 }}>{c.blurb}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 4, lineHeight: 1.45 }}>{c.consequence}</div>
                  {c.mode === 'autonomous' && state.mode === 'autonomous' && caps && (
                    <ul style={{ margin: '8px 0 0', paddingLeft: 16, fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                      {caps.rules.map((r) => <li key={r}>{r}</li>)}
                      <li>a plan the chief prepares waits {caps.vetoWindowMinutes ?? 30} minutes for your veto before its structural actions apply (a tunable, 0–1440)</li>
                    </ul>
                  )}
                </button>
              ))}
              {!app.companiesEnabled && <div style={{ ...faint, color: 'var(--amber)' }}>Companies are disabled on this server (COMPANIES_ENABLED=false); only a plain workspace can be created.</div>}
            </div>
          )}

          {step === 'chief' && (
            <>
              <div style={faint}>The chief of staff reads your vision, values and culture before planning anything, decomposes goals into briefed tasks, and reports in a daily brief. {isExisting ? 'Pick one of this workspace’s agents or create one.' : 'A new workspace has no agents yet, so the chief is created with it.'}</div>
              {isExisting && ownAgents.length > 0 && (
                <div role="radiogroup" aria-label="Chief of staff" style={{ display: 'flex', gap: 8 }}>
                  <button type="button" role="radio" aria-checked={state.chief.kind === 'create'} onClick={() => set('chief', { kind: 'create', name: 'Chief of staff', provider: '', model: '' })} style={cardBtn(state.chief.kind === 'create')}>
                    <div style={{ fontWeight: 600, fontSize: 12.5 }}>Create a chief</div><div style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>A fresh agent with the chief charter.</div>
                  </button>
                  <button type="button" role="radio" aria-checked={state.chief.kind === 'existing'} onClick={() => set('chief', { kind: 'existing', agentId: ownAgents[0]?.id ?? '' })} style={cardBtn(state.chief.kind === 'existing')}>
                    <div style={{ fontWeight: 600, fontSize: 12.5 }}>Pick an existing agent</div><div style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>It keeps its charter and becomes the root.</div>
                  </button>
                </div>
              )}
              {state.chief.kind === 'existing' ? (
                <label style={field} htmlFor="nww-chief-agent">Agent
                  <select id="nww-chief-agent" value={state.chief.agentId} onChange={(e) => set('chief', { kind: 'existing', agentId: e.target.value })} style={input} aria-invalid={Boolean(show('chiefAgent'))}>
                    <option value="">Pick an agent…</option>
                    {ownAgents.map((a) => <option key={a.id} value={a.id}>{a.emoji} {a.name}{a.role ? ` · ${a.role}` : ''}</option>)}
                  </select>
                  {show('chiefAgent') && <span style={err}>{show('chiefAgent')}</span>}
                </label>
              ) : (
                <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
                  <label style={{ ...field, gridColumn: '1 / -1' }} htmlFor="nww-chief-name">Name
                    <input id="nww-chief-name" ref={firstRef} value={state.chief.name} onChange={(e) => set('chief', { ...(state.chief as { kind: 'create'; name: string; provider: string; model: string }), name: e.target.value })} placeholder="Chief of staff" style={input} aria-invalid={Boolean(show('chiefName'))} />
                    {show('chiefName') && <span style={err}>{show('chiefName')}</span>}
                  </label>
                  <label style={field} htmlFor="nww-chief-provider">Provider (optional)
                    <select id="nww-chief-provider" value={state.chief.provider} onChange={(e) => set('chief', { kind: 'create', name: (state.chief as { name: string }).name, provider: e.target.value, model: '' })} style={input}>
                      <option value="">Default</option>
                      {providers.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </label>
                  <label style={field} htmlFor="nww-chief-model">Model (optional)
                    <input id="nww-chief-model" list="nww-models" value={state.chief.model} disabled={!state.chief.provider} onChange={(e) => set('chief', { ...(state.chief as { kind: 'create'; name: string; provider: string; model: string }), model: e.target.value })} placeholder={state.chief.provider ? 'Provider default' : 'Pick a provider first'} style={input} />
                    <datalist id="nww-models">{state.chief.provider && modelsFor(state.chief.provider).map((m) => <option key={m} value={m} />)}</datalist>
                  </label>
                </div>
              )}
            </>
          )}

          {step === 'vision' && (
            <>
              <label style={field} htmlFor="nww-vision-title">Vision — one line
                <input id="nww-vision-title" ref={firstRef} value={state.vision.title} onChange={(e) => set('vision', { ...state.vision, title: e.target.value })} placeholder="Be the newsletter people forward" style={input} maxLength={200} aria-invalid={Boolean(show('title'))} />
                {show('title') && <span style={err}>{show('title')}</span>}
              </label>
              <label style={field} htmlFor="nww-vision-desc">Mission — one paragraph
                <textarea id="nww-vision-desc" value={state.vision.description} onChange={(e) => set('vision', { ...state.vision, description: e.target.value })} placeholder="What this company does, for whom, and what done looks like. The chief turns this into objectives and key results in its first planning session." style={textarea} />
              </label>
              <div style={field}>
                <span id="nww-horizon">Horizon</span>
                <div role="radiogroup" aria-labelledby="nww-horizon" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  {HORIZONS.map((h) => (
                    <button key={String(h.value)} type="button" role="radio" aria-checked={state.vision.horizon === h.value} onClick={() => set('vision', { ...state.vision, horizon: h.value })}
                      style={{ ...pill(state.vision.horizon === h.value ? 'var(--accent-dim)' : 'var(--panel-2)', state.vision.horizon === h.value ? 'var(--text)' : 'var(--text-dim)'), fontSize: 12, padding: '5px 10px', cursor: 'pointer', borderColor: state.vision.horizon === h.value ? 'var(--accent)' : 'var(--border-soft)' }}>{h.label}</button>
                  ))}
                  {state.vision.horizon === 'date' && <input type="date" aria-label="Horizon date" value={state.vision.date} onChange={(e) => set('vision', { ...state.vision, date: e.target.value })} style={{ ...input, width: 'auto' }} aria-invalid={Boolean(show('date'))} />}
                </div>
                {show('date') && <span style={err}>{show('date')}</span>}
              </div>
              <label style={field} htmlFor="nww-rules">Standing rules (optional)
                <textarea id="nww-rules" value={state.vision.rules} onChange={(e) => set('vision', { ...state.vision, rules: e.target.value })} placeholder="No paid promotion. Every number in the letter has a source. Nothing goes out on a Friday." style={textarea} />
                <span style={faint}>Rules the chief and every member read before acting; they stay until you revise them on the Vision page.</span>
              </label>
            </>
          )}

          {step === 'profile' && (
            <>
              <div style={faint}>The company adapts to its operating profile: rituals, thresholds, review strictness and the brief all take their shape from these two paragraphs. Write them as you would tell a new hire.</div>
              <label style={field} htmlFor="nww-values">Values — what it optimises for and what it refuses
                <textarea id="nww-values" ref={firstTextRef} value={state.profile.values} onChange={(e) => set('profile', { ...state.profile, values: e.target.value })} placeholder="Accuracy over speed; cite every number; refuse work that needs a lawyer; spend on research before spend on polish." style={textarea} />
              </label>
              <label style={field} htmlFor="nww-culture">Culture — how it communicates and works
                <textarea id="nww-culture" value={state.profile.culture} onChange={(e) => set('profile', { ...state.profile, culture: e.target.value })} placeholder="terse, async, ship weekly; never contact customers without approval; one reviewer per piece; meetings end with decisions." style={textarea} />
              </label>
            </>
          )}

          {step === 'budget' && (
            <>
              <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
                <label style={field} htmlFor="nww-usd">Company envelope (USD / month)
                  <input id="nww-usd" ref={firstRef} inputMode="decimal" value={state.budget.monthlyUsd} onChange={(e) => set('budget', { ...state.budget, monthlyUsd: e.target.value.replace(/[^\d.]/g, '') })} style={{ ...input, fontFamily: 'var(--mono)' }} aria-invalid={Boolean(show('monthlyUsd'))} />
                  {show('monthlyUsd') && <span style={err}>{show('monthlyUsd')}</span>}
                </label>
                <label style={field} htmlFor="nww-cap">Agent cap (members, chief included)
                  <input id="nww-cap" inputMode="numeric" value={state.budget.agentCap} onChange={(e) => set('budget', { ...state.budget, agentCap: e.target.value.replace(/[^\d]/g, '') })} style={{ ...input, fontFamily: 'var(--mono)' }} aria-invalid={Boolean(show('agentCap'))} />
                  {show('agentCap') && <span style={err}>{show('agentCap')}</span>}
                </label>
              </div>
              <div style={{ ...faint, lineHeight: 1.5 }}>
                <div>100% of the envelope is a hard stop: runs are refused, nothing is queued. Agent and project envelopes the chief allocates sum to at most this amount. {Number(state.budget.monthlyUsd) <= 0 && <span style={{ color: 'var(--amber)' }}>With no envelope the chief cannot allocate any budget: hires come without one and allocations are refused until you set it.</span>}</div>
                <div style={{ marginTop: 4 }}>The fence: 1–{MAX_AGENT_CAP} members{caps ? `, depth ≤ ${caps.maxDepth}, ≤ ${caps.maxDirectReports} direct reports each` : ''}. These bounds stay in code; the company chooses within them.</div>
              </div>
            </>
          )}

          {step === 'rhythm' && (
            <>
              <div role="radiogroup" aria-label="Ritual rhythm" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {CADENCE_CARDS.map((c) => (
                  <button key={c.mode} type="button" role="radio" aria-checked={state.cadences === c.mode} onClick={() => set('cadences', c.mode)} style={{ ...cardBtn(state.cadences === c.mode), minWidth: 160 }}>
                    <div style={{ fontWeight: 600, fontSize: 12.5 }}>{c.title}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 2, lineHeight: 1.45 }}>{c.blurb}</div>
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={label}>What each ritual is</span>
                {RITUAL_LINES.map((r) => {
                  const off = state.cadences === 'none' || (state.cadences === 'light' && (r.kind === 'standup' || r.kind === 'retro'));
                  return (
                    <div key={r.kind} style={{ display: 'flex', gap: 8, fontSize: 12, color: off ? 'var(--text-faint)' : 'var(--text-dim)', textDecoration: off ? 'line-through' : 'none' }}>
                      <span style={{ fontWeight: 600, minWidth: 96, color: off ? 'var(--text-faint)' : 'var(--text)' }}>{r.title}</span><span>{r.line}</span>
                    </div>
                  );
                })}
                <span style={faint}>Cadences are tunables: the chief proposes changes with a reason, within bounds (never more than a few meetings a day, never in quiet hours).</span>
              </div>
            </>
          )}

          {step === 'hires' && roles && (
            <>
              <div style={faint}>Roles from the catalog, ranked against your vision and profile (the matched tags are shown). {state.mode === 'supervised' ? 'Each becomes an approval card; nothing exists until you approve it.' : 'Each is seated under the chief at once, within the agent cap.'} A role starts with its catalog scopes met with the chief's own holdings, a charter written for this company, and the model tier shown. Up to five; the chief can hire more later.</div>
              <div role="group" aria-label="First hires" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {shownRoles.map((r) => {
                  const on = state.roles.includes(r.id);
                  const full = !on && state.roles.length >= 5;
                  return (
                    <button key={r.id} type="button" aria-pressed={on} disabled={full} title={r.charter}
                      onClick={() => set('roles', on ? state.roles.filter((x) => x !== r.id) : [...state.roles, r.id])}
                      style={{ ...cardBtn(on), padding: '8px 12px', opacity: full ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span aria-hidden style={{ width: 16, height: 16, borderRadius: 5, border: `1.5px solid ${on ? 'var(--accent)' : 'var(--border)'}`, background: on ? 'var(--accent)' : 'transparent', flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{on && <I d={P.check} size={11} stroke="#fff" sw={3} />}</span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: 600, fontSize: 12.5 }}>{r.title}</span>
                          <span style={{ ...faint, fontSize: 11 }}>{roleCostLabel(r)}</span>
                          {(r.matched ?? []).length > 0 && <span style={{ ...faint, fontSize: 11, color: 'var(--accent-hi)' }}>fits: {(r.matched ?? []).join(', ')}</span>}
                        </span>
                        <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-dim)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{(r.competencies ?? []).join(' · ')}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
              {!allRoles && rankedRoles.length > shownRoles.length && (
                <button type="button" onClick={() => setAllRoles(true)} style={{ ...btn(), alignSelf: 'flex-start' }}>Show all {rankedRoles.length} roles</button>
              )}
              {state.roles.length > 0 && <div style={faint}>Estimated: ~${hiresEstimate(roles, state.roles).toFixed(0)}/month at list prices for part-time seats, inside the ${Math.max(0, Number(state.budget.monthlyUsd) || 0).toFixed(0)} envelope{hiresEstimate(roles, state.roles) > (Number(state.budget.monthlyUsd) || 0) ? ' — more than the envelope; the chief will have to trade seats or tiers' : ''}.</div>}
            </>
          )}

          {step === 'review' && (
            <>
              {allErrors.length > 0 && (
                <div style={{ border: '1px solid var(--red)', borderRadius: 10, padding: '8px 12px', fontSize: 12 }}>
                  <div style={{ fontWeight: 600, color: 'var(--red)' }}>Fix this first</div>
                  {allErrors.map((e, i) => <div key={i}><button type="button" onClick={() => jump(e.step)} style={{ background: 'none', border: 'none', color: 'var(--accent-hi)', cursor: 'pointer', padding: 0, font: 'inherit', fontWeight: 600 }}>{STEP_TITLES[e.step]}</button>: {e.message}</div>)}
                </div>
              )}
              <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'minmax(90px, auto) 1fr', gap: '7px 12px', fontSize: 12.5 }}>
                {buildSummary(state, { existing: isExisting, agentName, caps, roleName }).map((l, i) => (
                  <div key={i} style={{ display: 'contents' }}>
                    <dt style={{ ...label, alignSelf: 'start', paddingTop: 2 }}><button type="button" onClick={() => jump(l.step)} style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer', textTransform: 'inherit', letterSpacing: 'inherit' }}>{l.label}</button></dt>
                    <dd style={{ margin: 0, minWidth: 0, overflowWrap: 'anywhere' }}>{l.value}</dd>
                  </div>
                ))}
              </dl>
              {state.mode !== 'none' && (
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, cursor: 'pointer' }}>
                  <input type="checkbox" checked={state.planNow} onChange={(e) => set('planNow', e.target.checked)} disabled={!state.vision.title.trim()} />
                  Run the chief's first planning session right away{!state.vision.title.trim() ? ' (needs a vision)' : ''}
                </label>
              )}
              {state.mode !== 'none' && <div style={faint}>Everything above is written to the company's audit log as one <code>org_bootstrap</code> row, and each step as its own decision row, so the company can always see how it was set up and why.</div>}
              {failure && <div role="alert" style={{ border: '1px solid var(--red)', borderRadius: 10, padding: '8px 12px', fontSize: 12, color: 'var(--red)' }}>{failure}</div>}
            </>
          )}
        </div>
        <div style={{ padding: '12px 20px 16px', borderTop: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {busy ? <span style={{ ...faint, flex: 1 }} aria-live="polite">{busy}</span> : <span style={{ flex: 1 }} />}
          {canBack && <button type="button" onClick={back} style={btn()}>Back</button>}
          {isLast ? (
            <button type="button" disabled={Boolean(busy) || (state.mode !== 'none' && !app.companiesEnabled)} onClick={() => void finish()} style={{ ...btn(true), opacity: busy ? 0.6 : 1 }}>
              {state.mode === 'none' ? (existing ? 'Done' : 'Create workspace') : existing ? 'Enable company' : 'Create company'}
            </button>
          ) : (
            <button type="button" onClick={next} style={btn(true)}>Next</button>
          )}
        </div>
      </div>
    </div>
  );
}
