/** Evidence-gated claims on screen (docs/evidence.md §8): the verified /
 *  unverified badge on key-result check-ins, project updates, task updates
 *  and decisions, with an evidence popover that lists the references (a
 *  workspace file opens in the side panel), and the Claims panel on
 *  Oversight › Quality — unverified, contradicted and fabricated claims per
 *  member, the latest flagged ones, and a person's confirm. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import { api, type ClaimRefType, type ClaimsSummary, type OrgClaim, type OrgDetail } from '../lib/api';
import { CLAIM_CLASS_LABEL, CLAIM_LABEL, CLAIM_TONE, claimMembers, claimSentence, claimsLede, latestByRef, showsBadge } from '../lib/claims';
import { evidenceTarget } from '../lib/quality';
import { openFileInPanel } from '../lib/file-links';
import { ago, faint, linkBtn, useAgentNames, Avatar } from './org-ui';
import { useOrgRole } from './OrgSensingView';
import { Card, Empty, Metric, Pill } from './CompanyKit';

const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^\d{3} /, '').slice(0, 240) : 'failed');
const row: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'baseline', padding: '6px 0', borderTop: '1px solid var(--border-soft)', fontSize: 12.5, minWidth: 0, flexWrap: 'wrap' };

/** One reference: a workspace file opens in the side panel (src/lib/file-links.ts), a page in a new tab. */
function RefLink({ raw }: { raw: string }) {
  const t = evidenceTarget(raw);
  if (t.kind === 'file') return <button style={{ ...linkBtn, fontSize: 12 }} onClick={() => openFileInPanel(t.path)} title={`Open /${t.path}`}>/{t.path}</button>;
  if (t.kind === 'url') return <a href={t.href} target="_blank" rel="noreferrer noopener" style={{ fontSize: 12, color: 'var(--accent-hi)', wordBreak: 'break-all' }}>{t.href}</a>;
  return <code style={{ fontSize: 11.5 }}>{raw}</code>;
}

/** The claims stored against these records (latest per record). */
export function useClaims(wsId: string, refType: ClaimRefType, refIds: string[]): Map<string, OrgClaim> {
  const key = refIds.join(',');
  const [claims, setClaims] = useState<OrgClaim[]>([]);
  useEffect(() => {
    // Only a change re-renders: an empty answer keeps the same (empty) state.
    const put = (c: unknown) => setClaims((prev) => (Array.isArray(c) && c.length ? c as OrgClaim[] : prev.length ? [] : prev));
    if (!key || !wsId) { put([]); return; }
    let live = true;
    // A sync throw (an API without the endpoint) is a rejection too: the badges are optional.
    void Promise.resolve().then(() => api.orgClaims(wsId, { refType, refIds: key.split(',') })).then((c) => { if (live) put(c); }).catch(() => { if (live) put([]); });
    return () => { live = false; };
  }, [wsId, refType, key]);
  return useMemo(() => latestByRef(claims), [claims]);
}

/** A verified / unverified badge; click it for the evidence. */
export function ClaimBadge({ claim }: { claim: OrgClaim | undefined }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  if (!showsBadge(claim)) return null;
  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }} data-testid="claim-badge">
      <button onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`${CLAIM_LABEL[claim.status]}: show the evidence`} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit' }}>
        <Pill tone={CLAIM_TONE[claim.status]} title={claimSentence(claim)}>{CLAIM_LABEL[claim.status]}</Pill>
      </button>
      {open && <ClaimPopover claim={claim} />}
    </span>
  );
}

function ClaimPopover({ claim }: { claim: OrgClaim }) {
  return (
    <div role="dialog" aria-label="Evidence" data-testid="claim-popover"
      style={{ position: 'absolute', top: '100%', left: 0, zIndex: 30, marginTop: 4, width: 'min(340px, 80vw)', background: 'var(--bg-raised, var(--bg))', border: '1px solid var(--border)', borderRadius: 10, padding: '8px 10px', boxShadow: '0 6px 24px rgba(0,0,0,.18)', fontSize: 12.5, textAlign: 'left' }}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{CLAIM_CLASS_LABEL[claim.classKey]}: {CLAIM_LABEL[claim.status]}</div>
      <div style={{ marginBottom: 4 }}>{claimSentence(claim)}</div>
      {claim.statement && <div style={{ ...faint, marginBottom: 4 }}>“{claim.statement.slice(0, 200)}”</div>}
      {claim.refs.length > 0 && <div style={{ display: 'grid', gap: 3 }}>
        {claim.refs.map((r) => (
          <div key={r.raw} style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span style={{ color: r.ok ? 'var(--green)' : 'var(--red)' }} aria-label={r.ok ? 'checks out' : 'does not check out'}>{r.ok ? '✓' : '✗'}</span>
            <RefLink raw={r.raw} />
            <span style={faint}>{r.missing ? 'does not exist' : r.detail}</span>
          </div>
        ))}
      </div>}
      {claim.counts.map((k) => <div key={k.phrase} style={{ ...faint, color: k.mismatch ? 'var(--red)' : undefined }}>“{k.phrase}” — the record shows {k.measured}</div>)}
      {claim.status !== 'verified' && claim.detail && <div style={{ ...faint, marginTop: 4 }}>{claim.detail.slice(0, 400)}</div>}
      <div style={{ ...faint, marginTop: 4 }}>{claim.enforcement === 'mark' && claim.status !== 'verified' ? 'Does not count until verified. ' : ''}{ago(claim.createdAt)}</div>
    </div>
  );
}

/** Oversight › Quality: the Claims panel. */
export function ClaimsPanel({ org }: { org: OrgDetail }) {
  const app = useApp();
  const wsId = org.workspaceId;
  const role = useOrgRole(wsId);
  const decider = role === 'ceo' || role === 'board';
  const names = useAgentNames();
  const [s, setS] = useState<ClaimsSummary | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => { setS(await api.orgClaimsSummary(wsId).catch(() => null)); }, [wsId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const confirm = async (c: OrgClaim) => {
    setBusy(true);
    try { await api.confirmOrgClaim(wsId, c.id); app.showToast('Claim confirmed'); await refresh(); } catch (e) { app.showToast(errText(e)); } finally { setBusy(false); }
  };
  if (s === undefined) return null;
  if (s === null || !s.totals) return <Card id="quality-claims" title="Claims" span><div className="co-alert" role="alert">Claims did not load.</div></Card>;
  const members = claimMembers(s);
  return (
    <Card id="quality-claims" title="Claims" span>
      <p style={{ margin: '0 0 8px', fontSize: 12.5 }} data-testid="claims-lede">{claimsLede(s)} Values, updates and facts agents write into shared state carry evidence; unverified ones do not count until checked.</p>
      <div className="co-metrics" style={{ margin: '0 0 8px' }}>
        <Metric n={s.totals.verified} label="verified" />
        <Metric n={s.totals.unverified} label="unverified" tone={s.totals.unverified ? 'warn' : undefined} />
        <Metric n={s.totals.mismatch} label="contradicted" tone={s.totals.mismatch ? 'bad' : undefined} title="A count the record does not show" />
        <Metric n={s.totals.fabricated} label="fabricated" tone={s.totals.fabricated ? 'bad' : undefined} title="Cited evidence that does not exist" />
      </div>
      {members.length === 0 && <Empty compact title="No claims yet" />}
      {members.slice(0, 10).map((m) => (
        <div key={m.agentId} style={row} data-testid="claims-member">
          <Avatar a={names.get(m.agentId)} size={16} />
          <span style={{ flex: 1, minWidth: 100 }}>{names.get(m.agentId)?.name ?? m.agentId.slice(0, 8)}</span>
          <span style={faint}>{m.verified}/{m.total} verified</span>
          {m.unverified > 0 && <Pill tone="warn">{m.unverified} unverified</Pill>}
          {m.mismatch > 0 && <Pill tone="bad">{m.mismatch} contradicted</Pill>}
          {m.fabricated > 0 && <Pill tone="bad">{m.fabricated} fabricated</Pill>}
        </div>
      ))}
      {s.recent.length > 0 && <div style={{ fontWeight: 600, fontSize: 12.5, margin: '10px 0 2px' }}>Latest flagged</div>}
      {s.recent.slice(0, 8).map((c) => (
        <div key={c.id} style={row} data-testid="claims-recent">
          <ClaimBadge claim={{ ...c, enforcement: c.enforcement === 'log' ? 'mark' : c.enforcement }} />
          <span style={faint}>{CLAIM_CLASS_LABEL[c.classKey]}{c.refType === 'refused' ? ' (refused)' : ''}</span>
          <span style={{ flex: 1, minWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.statement}>{names.get(c.agentId)?.name ?? 'A member'}: {c.statement}</span>
          {c.context.taskId && <button className="co-btn ghost small" onClick={() => app.openOrgTask(c.context.taskId!)}>task</button>}
          {decider && c.refType !== 'refused' && c.status === 'unverified' && <button className="co-btn ghost small" disabled={busy} onClick={() => void confirm(c)} title="You checked it: it counts from now">Confirm</button>}
          <span style={faint}>{ago(c.createdAt)}</span>
        </div>
      ))}
    </Card>
  );
}
