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
import { ago, useAgentNames } from './org-ui';
import { useOrgRole } from './OrgSensingView';
import { Avatar, Bar, Card, Metric, Pill } from './CompanyKit';
import '../styles/quality-services.css';

const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^\d{3} /, '').slice(0, 240) : 'failed');

/** One reference: a workspace file opens in the side panel (src/lib/file-links.ts), a page in a new tab. */
function RefLink({ raw }: { raw: string }) {
  const t = evidenceTarget(raw);
  if (t.kind === 'file') return <button className="co-link" style={{ fontSize: 12, fontWeight: 500, overflowWrap: 'anywhere' }} onClick={() => openFileInPanel(t.path)} title={`Open /${t.path}`}>/{t.path}</button>;
  if (t.kind === 'url') return <a href={t.href} target="_blank" rel="noreferrer noopener" style={{ fontSize: 12, color: 'var(--accent-hi)', wordBreak: 'break-all' }}>{t.href}</a>;
  return <code style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{raw}</code>;
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

/** A verified / unverified badge; click it for the evidence (Escape or a click outside closes it). */
export function ClaimBadge({ claim }: { claim: OrgClaim | undefined }) {
  const [open, setOpen] = useState(false);
  const [right, setRight] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); ref.current?.querySelector('button')?.focus(); } };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key); };
  }, [open]);
  if (!showsBadge(claim)) return null;
  const toggle = () => {
    // Near the right edge (a drawer, a narrow screen) the popover opens leftwards.
    const r = ref.current?.getBoundingClientRect();
    setRight(Boolean(r && typeof window !== 'undefined' && r.left + 360 > window.innerWidth));
    setOpen(!open);
  };
  return (
    <span ref={ref} className="qx-claim" data-testid="claim-badge">
      <button onClick={toggle} aria-expanded={open} aria-haspopup="dialog" aria-label={`${CLAIM_LABEL[claim.status]}: show the evidence`}>
        <Pill tone={CLAIM_TONE[claim.status]} title={claimSentence(claim)}>{CLAIM_LABEL[claim.status]}</Pill>
      </button>
      {open && <ClaimPopover claim={claim} right={right} />}
    </span>
  );
}

function ClaimPopover({ claim, right }: { claim: OrgClaim; right?: boolean }) {
  return (
    <div role="dialog" aria-label="Evidence" data-testid="claim-popover" className={`qx-pop${right ? ' right' : ''}`}>
      <div className="qx-pop-title">{CLAIM_CLASS_LABEL[claim.classKey]}: {CLAIM_LABEL[claim.status]}</div>
      {!(claim.status === 'mismatch' && claim.counts.some((k) => k.mismatch)) && <div>{claimSentence(claim)}</div>}
      {claim.statement && <div className="qx-pop-quote">{claim.statement.slice(0, 220)}</div>}
      {claim.refs.length > 0 && (
        <div className="qx-refs">
          {claim.refs.map((r) => (
            <div key={r.raw} className="qx-ref">
              <span className={r.ok ? 'ok' : 'bad'} aria-label={r.ok ? 'checks out' : 'does not check out'}>{r.ok ? '✓' : '✗'}</span>
              <span><RefLink raw={r.raw} />{(r.missing || r.detail) && <span className="co-faint"> — {r.missing ? 'does not exist' : r.detail}</span>}</span>
            </div>
          ))}
        </div>
      )}
      {claim.counts.length > 0 && (
        <div className="qx-refs">
          {claim.counts.map((k) => (
            <div key={k.phrase} className="qx-ref">
              <span className={k.mismatch ? 'bad' : 'ok'} aria-hidden>{k.mismatch ? '✗' : '✓'}</span>
              <span>“{k.phrase}” — the record shows <b>{k.measured}</b></span>
            </div>
          ))}
        </div>
      )}
      {claim.status !== 'verified' && claim.detail && <div className="co-faint" style={{ marginTop: 6 }}>{claim.detail.slice(0, 400)}</div>}
      <div className="qx-pop-foot">{claim.enforcement === 'mark' && claim.status !== 'verified' ? 'Does not count until verified · ' : ''}{ago(claim.createdAt)}</div>
    </div>
  );
}

/** Oversight › Quality: the Claims card. */
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
    if (!window.confirm(`Confirm "${c.statement.slice(0, 120)}"? You checked it yourself: it counts from now.`)) return;
    setBusy(true);
    try { await api.confirmOrgClaim(wsId, c.id); app.showToast('Claim confirmed'); await refresh(); } catch (e) { app.showToast(errText(e)); } finally { setBusy(false); }
  };
  if (s === undefined) return <Card id="quality-claims" title="Claims"><SkeletonLine /></Card>;
  if (s === null || !s.totals) return <Card id="quality-claims" title="Claims"><div className="co-alert" role="alert">Claims did not load. <button className="co-link" onClick={() => void refresh()}>Try again</button></div></Card>;
  const members = claimMembers(s);
  const t = s.totals;
  return (
    <Card id="quality-claims" title="Claims" aside={`last ${s.days} days`} flush>
      <div style={{ padding: '0 10px' }}>
        <p className="qx-desc" style={{ margin: '0 0 10px' }} data-testid="claims-lede">{t.total ? '' : `${claimsLede(s)} `}Values, updates and facts agents write into shared state carry evidence; unverified ones do not count until checked.</p>
        {t.total > 0 && (
          <div className="co-metrics" style={{ margin: '0 0 8px' }}>
            <Metric n={t.verified} label="verified" />
            <Metric n={t.unverified} label="unverified" tone={t.unverified ? 'warn' : undefined} />
            <Metric n={t.mismatch} label="contradicted" tone={t.mismatch ? 'bad' : undefined} title="A count the record does not show" />
            <Metric n={t.fabricated} label="fabricated" tone={t.fabricated ? 'bad' : undefined} title="Cited evidence that does not exist" />
          </div>
        )}
      </div>
      {members.length > 0 && <div className="co-sub" style={{ margin: '8px 10px 2px' }}>By member, worst first</div>}
      {members.slice(0, 8).map((m) => (
        <div key={m.agentId} className="qx-member" data-testid="claims-member">
          <span className="qx-member-name"><Avatar a={names.get(m.agentId)} size={18} /><span>{names.get(m.agentId)?.name ?? 'A former member'}</span></span>
          <Bar value={m.total ? m.verified / m.total : null} tone={m.fabricated || m.mismatch ? 'bad' : m.unverified ? 'warn' : 'ok'} label={`${names.get(m.agentId)?.name ?? 'member'}: verified share`} />
          <span className="qx-member-end">
            <span><b style={{ color: 'var(--text)', fontWeight: 650 }}>{m.verified}</b>/{m.total} verified</span>
            <WorstPill m={m} />
          </span>
        </div>
      ))}
      {s.recent.length > 0 && <div className="co-sub" style={{ margin: '12px 10px 2px' }}>Latest flagged</div>}
      {s.recent.slice(0, 8).map((c) => (
        <div key={c.id} className="qx-item" data-testid="claims-recent">
          <div className="qx-head">
            <div className="qx-main">
              <div className="qx-title" style={{ fontWeight: 500 }} title={c.statement}>{c.statement}</div>
              <div className="qx-meta qx-dots">
                <span>{CLAIM_CLASS_LABEL[c.classKey]}{c.refType === 'refused' ? ' (refused)' : ''}</span>
                <span>{names.get(c.agentId)?.name ?? 'A member'}</span>
                <span>{ago(c.createdAt)}</span>
              </div>
            </div>
            <div className="qx-end">
              <ClaimBadge claim={{ ...c, enforcement: c.enforcement === 'log' ? 'mark' : c.enforcement }} />
              {c.context.taskId && <button className="co-btn small ghost" onClick={() => app.openOrgTask(c.context.taskId!)}>Task</button>}
              {decider && c.refType !== 'refused' && c.status === 'unverified' && <button className="co-btn small" disabled={busy} onClick={() => void confirm(c)} title="You checked it: it counts from now">Confirm</button>}
            </div>
          </div>
        </div>
      ))}
    </Card>
  );
}

/** A member's worst kind of flagged claim, with the full tally on hover. */
function WorstPill({ m }: { m: { fabricated: number; mismatch: number; unverified: number } }) {
  const all = [m.fabricated ? `${m.fabricated} fabricated` : '', m.mismatch ? `${m.mismatch} contradicted` : '', m.unverified ? `${m.unverified} unverified` : ''].filter(Boolean);
  if (!all.length) return null;
  return <Pill tone={m.fabricated || m.mismatch ? 'bad' : 'warn'} title={all.join(', ')}>{all[0]}{all.length > 1 ? ` +${all.length - 1}` : ''}</Pill>;
}

function SkeletonLine() {
  return <div role="status" aria-label="Loading claims" style={{ display: 'grid', gap: 8 }}><span className="co-skel" style={{ height: 12, width: '70%' }} /><span className="co-skel" style={{ height: 10, width: '45%' }} /></div>;
}
