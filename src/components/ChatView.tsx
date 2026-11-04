/** The chat main pane: header (pin, token meter, model/effort popover,
 *  Ask/Auto), transcript (user/assistant/system rows, each turn's thinking and tool calls folded behind "worked on it · N steps", inline
 *  approvals, artifact chips), queue, and the composer with slash/@ menus. */
import { roleBeside } from '../lib/agent-role';
import { memo, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { I, P } from '../lib/icons';
import { useApp, grad, type LiveItem, type LiveTool } from '../store';
import { api, PROVIDER_COLORS, isComputerTool, REMEMBERABLE_COMPUTER_TOOLS, type Agent, type ApprovalDecision, type ChatMessage, type ChatTurn, type ToolReview } from '../lib/api';
import { safeJsonParse, workspaceSpend } from '../lib/util';
import { fmtUsd, usdFor } from '../lib/pricing';
import { MAX_AUDIO_BYTES, fmtDuration, isAudioFile, recorderAvailable, useVoiceRecorder, AUDIO_EXT_RE } from '../lib/voice';
import { VoiceChip } from './VoiceChip';
import { AutoArchiveMenu } from './ChatAutoArchive';
import { Markdown, plainText, type RefResolver } from '../lib/md';
import { useTaskRefs } from '../lib/useTaskRefs';
import { CLASS_COLOR, CLASS_LABEL, CLASS_SHORT, degradedChatNote } from '../lib/org3';
import { interruptedLabel, retryable } from '../lib/interrupted';

/** The owner's key inline on a held tool card (item 28, SPA item 32). */
const HeldInline = lazy(() => import('./OrgTrustView').then((m) => ({ default: m.HeldInline })));

const ghostBtn: React.CSSProperties = { background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 5, borderRadius: 6, display: 'flex' };
const mono: React.CSSProperties = { fontFamily: 'var(--mono)' };

/** FR-5.3: parse the QUICK_REPLIES protocol line out of a reply. */
function parseQuickReplies(content: string): { text: string; replies: string[] } {
  const m = /\n?QUICK_REPLIES:\s*(\[[\s\S]*?\])\s*$/.exec(content);
  if (!m) return { text: content, replies: [] };
  try {
    const parsed = JSON.parse(m[1]) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((x) => typeof x === 'string')) {
      return { text: content.slice(0, m.index).trimEnd(), replies: (parsed as string[]).slice(0, 4) };
    }
  } catch { /* malformed: show raw */ }
  return { text: content, replies: [] };
}

/** Substantial HTML/SVG in a reply surfaces an artifact chip (FR-5.2). */
function detectArtifact(content: string): { title: string; src: string } | null {
  const fence = /```(?:html|svg)\n([\s\S]{200,}?)```/.exec(content);
  if (fence) return { title: 'Generated artifact', src: fence[1] };
  const inlineSvg = /(<svg[\s\S]{200,}<\/svg>)/.exec(content);
  if (inlineSvg) return { title: 'SVG artifact', src: inlineSvg[1] };
  return null;
}

/** A tool call: its state, input, result, review and — while it waits —
 *  the approval buttons. `onDecide` answers for a session other than the
 *  open chat (the Work log's inline approvals); `readOnly` hides the buttons
 *  (a viewer). */
export function ToolCard({ t, onDecide, readOnly = false, agentId }: { t: LiveTool & { persisted?: boolean }; onDecide?: (d: ApprovalDecision) => void; readOnly?: boolean; agentId?: string }) {
  const app = useApp();
  const [deciding, setDeciding] = useState(false);
  const decide = (d: ApprovalDecision) => { if (deciding) return; setDeciding(true); if (onDecide) onDecide(d); else app.approve(t.id, d); };
  const border = t.status === 'pending' ? 'var(--amber)' : t.status === 'denied' ? 'var(--red)' : 'var(--border)';
  const map: Record<string, [string, string]> = {
    pending: ['var(--amber)', 'Needs approval'], running: ['var(--green)', 'Running'],
    done: ['var(--green)', 'Done'], denied: ['var(--red)', 'Denied'], error: ['var(--red)', 'Error'],
  };
  const [color, label] = map[t.status] ?? map.done;
  const computer = isComputerTool(t.name);
  const arg = computer ? computerSummary(t.name, t.input)
    : t.name === 'code_agent' ? `${String(t.input?.harness ?? '')}${typeof t.input?.folder === 'string' ? ` · ${t.input.folder}` : ''} — ${String(t.input?.task ?? '').slice(0, 120)}`
    : typeof t.input?.path === 'string' ? t.input.path : typeof t.input?.url === 'string' ? t.input.url : typeof t.input?.query === 'string' ? t.input.query : '';
  const canRemember = !computer || REMEMBERABLE_COMPUTER_TOOLS.has(t.name);
  // The action contract (docs/actions-and-trust.md): the class and action_log
  // row the server put on the result, and whether it waits for the owner's key.
  const held = t.held ?? null;
  const cls = t.actionClass ?? null;
  const [keyOpen, setKeyOpen] = useState(false);
  // Folded to its one-line header by default, like thinking; a call that
  // waits on someone (approval, a key) or is still running stays open.
  const [open, setOpen] = useState(false);
  const expandable = t.result !== undefined && t.status !== 'pending' && t.status !== 'running';
  const wsId = app.current?.workspaceId ?? app.workspaceId;
  return (
    <div data-testid="tool-card" style={{ margin: '8px 0', border: `1px solid ${border}`, borderRadius: 10, overflow: 'hidden', background: 'var(--panel)' }}>
      <div role={expandable ? 'button' : undefined} tabIndex={expandable ? 0 : undefined} aria-expanded={expandable ? open : undefined}
        onClick={expandable ? () => setOpen(!open) : undefined}
        onKeyDown={expandable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open); } } : undefined}
        style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 12px', background: 'var(--panel-2)', cursor: expandable ? 'pointer' : undefined }}>
        <span style={{ width: 9, height: 9, borderRadius: '50%', flex: 'none', background: color, animation: t.status === 'running' ? 'pulse 1s infinite' : undefined }} />
        <span style={{ ...mono, fontSize: 12.5, fontWeight: 600 }}>{t.name}</span>
        <span style={{ ...mono, fontSize: 12, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{arg}</span>
        {t.name.startsWith('browser_') && app.browserSteps.length > 0 && !app.browserOpen && (
          <button onClick={(e) => { e.stopPropagation(); app.openBrowserPanel(); }} title="Show the screenshots in the Browser panel"
            style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-dim)', fontSize: 10.5, padding: '2px 7px', cursor: 'pointer' }}>
            Browser
          </button>
        )}
        {cls && cls !== 'read' && <span title={`${CLASS_LABEL[cls] ?? cls} action`} style={{ fontSize: 10, color: CLASS_COLOR[cls] ?? 'var(--text-dim)', border: `1px solid ${CLASS_COLOR[cls] ?? 'var(--border)'}`, borderRadius: 5, padding: '0 5px', whiteSpace: 'nowrap', flex: 'none' }}>{CLASS_SHORT[cls] ?? cls}</span>}
        <span style={{ fontSize: 11, color: held ? 'var(--amber)' : color, fontWeight: 600 }}>{held ? (held === 'staged' ? 'Staged' : 'Held') : label}</span>
        {expandable && <I d={P.chevD} size={12} stroke="var(--text-faint)" style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform .12s', flex: 'none' }} />}
      </div>
      {held && (
        <div style={{ padding: '9px 13px', borderTop: '1px solid var(--amber)', background: 'color-mix(in srgb, var(--amber) 10%, transparent)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--amber)', fontWeight: 600, flexWrap: 'wrap' }}>
            <I d={P.shield} size={13} stroke="var(--amber)" />
            <span style={{ flex: 1, minWidth: 160 }}>{held === 'staged' ? 'Staged as a draft — waiting for your key to send' : 'Held — waiting for your key'}</span>
            {t.actionId && wsId && <button onClick={() => setKeyOpen(!keyOpen)} aria-expanded={keyOpen} style={{ background: 'none', border: '1px solid var(--amber)', borderRadius: 7, color: 'var(--amber)', fontSize: 11.5, fontWeight: 600, padding: '3px 9px', cursor: 'pointer' }}>{keyOpen ? 'Close' : 'Review and decide'}</button>}
          </div>
          {keyOpen && t.actionId && wsId && <div style={{ marginTop: 8 }}><Suspense fallback={null}><HeldInline wsId={wsId} actionId={t.actionId} /></Suspense></div>}
        </div>
      )}
      {computer && t.status === 'pending' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 13px', background: 'color-mix(in srgb, var(--red) 14%, transparent)', borderTop: '1px solid var(--red)', color: 'var(--red)', fontSize: 12, fontWeight: 600 }}>
          <I d={P.window} size={14} stroke="var(--red)" />
          This acts on your computer{t.name === 'computer_shell' || t.name === 'computer_write_file' ? ' — it can never be auto-approved' : ''}.
        </div>
      )}
      {computer && t.status === 'pending' && (t.name === 'computer_type' || t.name === 'computer_shell' || t.name === 'computer_write_file') && (
        <pre style={{ margin: 0, padding: '10px 13px', borderTop: '1px solid var(--border-soft)', background: 'var(--code)', ...mono, fontSize: 12, lineHeight: 1.55, color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 220, overflowY: 'auto' }}>
          {t.name === 'computer_shell' ? `$ ${String(t.input.command ?? '')}` : t.name === 'computer_type' ? String(t.input.text ?? '') : `${String(t.input.path ?? '')}\n\n${String(t.input.content ?? '')}`}
        </pre>
      )}
      {t.status === 'running' && (
        <div style={{ padding: '8px 13px', fontSize: 12, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 8, borderTop: '1px solid var(--border-soft)' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)', animation: 'pulse 1s infinite' }} />
          Running {t.name}…
        </div>
      )}
      {t.status === 'running' && t.progress && t.progress.length > 0 && (
        <pre data-testid="tool-progress" style={{ margin: 0, padding: '8px 13px', borderTop: '1px solid var(--border-soft)', background: 'var(--code)', ...mono, fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-dim)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 160, overflowY: 'auto' }}>
          {t.progress.slice(-8).join('\n')}
        </pre>
      )}
      {t.status === 'pending' && t.routedTo && (
        <div style={{ padding: '11px 13px', borderTop: '1px solid var(--border-soft)', fontSize: 12, color: 'var(--amber)', display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--amber)', animation: 'pulse 1s infinite' }} />
          Waiting for {t.routedTo.name}'s approval — {t.name} would use their connection, so only they can allow it (from their inbox or their phone). Nobody else sees the request.
        </div>
      )}
      {t.status === 'pending' && !t.routedTo && readOnly && (
        <div style={{ padding: '11px 13px', borderTop: '1px solid var(--border-soft)', fontSize: 12, color: 'var(--amber)' }}>Waiting for an approval — viewers can see it but not answer it.</div>
      )}
      {t.status === 'pending' && !t.routedTo && !readOnly && (
        <div style={{ padding: '11px 13px', borderTop: '1px solid var(--border-soft)' }}>
          <div style={{ fontSize: 12, color: 'var(--amber)', display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10, fontWeight: 500 }}>
            <I d={P.warn} size={14} />{t.review ? `The reviewer asked for your decision — ${t.review.reason}` : computer ? `Approve to ${arg} on your computer` : `This tool needs approval — approve to run ${t.name}`}
          </div>
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', opacity: deciding ? 0.55 : 1 }}>
            <button disabled={deciding} onClick={() => decide('allow-once')} style={{ background: 'var(--green)', color: '#04140d', border: 'none', borderRadius: 8, padding: '6px 13px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Allow once</button>
            {canRemember && <button disabled={deciding} onClick={() => decide('allow-always')} style={{ background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 13px', fontSize: 12, fontWeight: 500, cursor: 'pointer' }}>Allow always</button>}
            {canRemember && <button disabled={deciding} onClick={() => decide('allow-tool')} style={{ background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 13px', fontSize: 12, fontWeight: 500, cursor: 'pointer' }}>Always allow {t.name}</button>}
            <button disabled={deciding} onClick={() => decide('deny')} style={{ background: 'none', color: 'var(--red)', border: '1px solid var(--red)', borderRadius: 8, padding: '6px 13px', fontSize: 12, fontWeight: 600, cursor: 'pointer', marginLeft: 'auto' }}>Deny</button>
          </div>
        </div>
      )}
      {expandable && open && (
        <pre style={{ margin: 0, padding: '12px 14px', borderTop: '1px solid var(--border-soft)', background: 'var(--code)', ...mono, fontSize: 12, lineHeight: 1.6, color: 'var(--text-dim)', overflowX: 'auto', whiteSpace: 'pre', maxHeight: 260, overflowY: 'auto' }}>{t.result}</pre>
      )}
      {(open || !expandable) && <ReviewLine review={t.review} />}
      <NeedsGrantHint result={t.result} agentId={agentId} />
    </div>
  );
}

/** One line describing a computer_* call for the card header and the
 *  approval prompt — the target, never the typed text or file content (those
 *  are shown in full in the card body while pending). Mirrors the server's
 *  audit summary. */
function computerSummary(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown) => String(v ?? '');
  switch (name) {
    case 'computer_screenshot': return 'take a screenshot';
    case 'computer_click': return `click ${s(input.button ?? 'left')}${input.double ? ' ×2' : ''} at (${s(input.x)}, ${s(input.y)})`;
    case 'computer_move': return `move the pointer to (${s(input.x)}, ${s(input.y)})`;
    case 'computer_scroll': return `scroll (${s(input.dx)}, ${s(input.dy)}) at (${s(input.x)}, ${s(input.y)})`;
    case 'computer_type': return `type ${s(input.text).length} characters`;
    case 'computer_key': return `press ${s(input.combo)}`;
    case 'computer_shell': return `run: ${s(input.command).slice(0, 120)}`;
    case 'computer_read_file': return `read ${s(input.path)}`;
    case 'computer_write_file': return `write ${s(input.path)} (${s(input.content).length} chars)`;
    case 'computer_list_dir': return `list ${s(input.path)}`;
    default: return name.replace(/^computer_/, '');
  }
}

/** The independent reviewer's one-line verdict (docs/permissions.md §6):
 *  shown only on calls it actually looked at. */
function ReviewLine({ review }: { review?: ToolReview }) {
  if (!review) return null;
  const color = review.verdict === 'allow' ? 'var(--text-faint)' : review.verdict === 'ask' ? 'var(--amber)' : 'var(--red)';
  const label = review.verdict === 'allow' ? 'allowed' : review.verdict === 'ask' ? 'held for you' : 'denied';
  return (
    <div title={`${review.reason}${review.sensitive.length ? ` · found: ${review.sensitive.join(', ')}` : ''} · ${review.model}`}
      style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 13px', borderTop: '1px solid var(--border-soft)', fontSize: 11.5, color }}>
      <I d={P.shield} size={12} stroke={color} />
      <span style={{ fontWeight: 600 }}>Reviewed · {label}</span>
      <span style={{ color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
        {review.verdict === 'allow' ? review.reason : review.sensitive.length ? `found ${review.sensitive.join(', ')}` : review.reason}
      </span>
    </div>
  );
}

/** Connect at the moment of need (docs/integrations.md §4, entry point 2):
 *  a connection tool refused for lack of a grant gets an inline path to the
 *  agent's Skills & tools tab, where grants live. */
function NeedsGrantHint({ result, agentId: forAgent }: { result?: string; agentId?: string }) {
  const app = useApp();
  const agentId = forAgent ?? app.sessions.find((s) => s.id === app.currentId)?.agentId;
  if (!agentId || typeof result !== 'string' || !/no (connection|write) grant/.test(result)) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 13px', borderTop: '1px solid var(--border-soft)' }}>
      <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>This agent needs a connection grant from you.</span>
      <button onClick={() => app.openAgent(agentId, 'Skills & tools')}
        style={{ marginLeft: 'auto', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 13px', fontSize: 12, fontWeight: 600, cursor: 'pointer', flex: 'none' }}>
        Open Skills &amp; tools
      </button>
    </div>
  );
}

/** A thinking block: one quiet line, folded by default; expand to read it. */
export function Thinking({ text, streaming }: { text: string; streaming: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div style={{ margin: '10px 0' }} data-testid="thinking">
      <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer', color: 'var(--text-dim)', fontSize: 12, fontWeight: 600, background: 'none', border: 'none', padding: 0, font: 'inherit' }}>
        <I d={P.brain} size={13} stroke="var(--accent)" />Thinking
        <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>{streaming ? ' · thinking…' : ''}</span>
        <I d={P.chevD} size={12} style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform .12s' }} />
      </button>
      {expanded && (
        <div style={{ marginTop: 8, padding: '11px 14px', borderLeft: '2px solid var(--accent-dim)', color: 'var(--text-dim)', fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap', fontStyle: 'italic' }}>
          {text}{streaming && <span style={{ animation: 'blink 1s infinite' }}>▋</span>}
        </div>
      )}
    </div>
  );
}

/** How a turn's internal work reads in a conversation (docs/work-log.md):
 *  its thinking and tool calls folded behind one compact line — "worked on
 *  it · N steps" — so the answer stays prominent. The owner can expand it;
 *  the full record of the agent's own runs lives in its Work log. */
export function WorkedOn({ steps, live = false, children }: { steps: number; live?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  if (steps === 0) return null;
  return (
    <div style={{ margin: '8px 0' }} data-testid="worked-on">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: '2px 0', cursor: 'pointer', color: 'var(--text-faint)', fontSize: 11.5, fontWeight: 600 }}>
        <I d={P.brain} size={12} stroke="var(--text-faint)" />
        {live ? 'working' : 'worked on it'} · {steps} step{steps === 1 ? '' : 's'}{live ? '…' : ''}
        <I d={P.chevD} size={11} style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform .12s' }} />
      </button>
      {open && <div style={{ paddingLeft: 10, borderLeft: '1px solid var(--border-soft)', marginTop: 4 }}>{children}</div>}
    </div>
  );
}

function AssistantFooter({ turn }: { turn?: ChatTurn }) {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  if (!turn) return null;
  const run = (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    void fn().finally(() => setBusy(false));
  };
  const usage = turn.tokensIn + turn.tokensOut > 0
    ? `${turn.tokensIn >= 1000 ? `${(turn.tokensIn / 1000).toFixed(1)}k` : turn.tokensIn} in · ${turn.tokensOut >= 1000 ? `${(turn.tokensOut / 1000).toFixed(1)}k` : turn.tokensOut} out`
    : '';
  const handoff = safeJsonParse<{ task: string } | null>(turn.taskHandoff, null);
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginTop: 12, color: 'var(--text-faint)' }}>
        <button disabled={busy} onClick={() => run(() => app.retry())} title="Retry" style={{ ...ghostBtn, opacity: busy ? 0.5 : 1 }}><I d={P.retry} size={14} /></button>
        <button disabled={busy} onClick={() => run(() => app.fork(turn.id))} title="Fork" style={{ ...ghostBtn, opacity: busy ? 0.5 : 1 }}><I d={P.forkIcon} size={14} /></button>
        {app.current?.agentId && (
          <button disabled={busy} onClick={() => run(() => app.promote(turn.id))} title="Promote to this agent's task board" style={{ ...ghostBtn, opacity: busy ? 0.5 : 1 }}><I d={P.board} size={14} /></button>
        )}
        <div style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 5px' }} />
        <button disabled={busy} onClick={() => run(() => app.rate(turn.id, 'up'))} title="Good reply" style={{ ...ghostBtn, opacity: busy ? 0.5 : 1, color: turn.rating === 'up' ? 'var(--green)' : undefined }}>
          <I d={P.thumbUp} size={14} sw={1.8} fill={turn.rating === 'up' ? 'var(--green)' : 'none'} />
        </button>
        <button disabled={busy} onClick={() => run(() => app.rate(turn.id, 'down'))} title="Bad reply" style={{ ...ghostBtn, opacity: busy ? 0.5 : 1, color: turn.rating === 'down' ? 'var(--red)' : undefined }}>
          <I d={P.thumbDown} size={14} sw={1.8} fill={turn.rating === 'down' ? 'var(--red)' : 'none'} />
        </button>
        {usage && <span style={{ marginLeft: 'auto', fontSize: 11, ...mono, color: 'var(--text-faint)' }}>{usage}</span>}
      </div>
      {handoff && (
        <div style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--green)', background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: '5px 11px' }}>
          <I d={P.check} size={13} sw={2.2} />Handed off to board task {handoff.task}
        </div>
      )}
    </>
  );
}

/** The last turn was cut short by a server restart (docs/architecture.md
 *  "Restarts and recovery"): not an error — a quiet line saying so, and a
 *  Retry in a person's chat (a work session's own bar offers Rerun). */
export function InterruptedNote({ turn, onRetry }: { turn: ChatTurn; onRetry?: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const canRetry = Boolean(onRetry) && retryable(turn.recovery);
  return (
    <div data-testid="interrupted-note" role="status" style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '12px 0 16px 40px', fontSize: 12, color: 'var(--text-dim)' }}>
      <I d={P.retry} size={13} stroke="var(--text-faint)" />
      <span>{canRetry ? 'Interrupted by a restart' : interruptedLabel(turn.recovery)}</span>
      {canRetry && (
        <button disabled={busy} onClick={() => { setBusy(true); void onRetry!().finally(() => setBusy(false)); }}
          style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text)', fontSize: 11.5, fontWeight: 600, padding: '2px 10px', cursor: 'pointer', opacity: busy ? 0.55 : 1 }}>
          {busy ? 'Retrying…' : 'Retry'}
        </button>
      )}
    </div>
  );
}

function SystemDivider({ text }: { text: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '20px 0' }}>
      <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, color: 'var(--text-dim)', background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 20, padding: '4px 12px' }}>
        <I d={P.sysLines} size={13} />{text}
      </div>
      <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
    </div>
  );
}

/** Transcript rows are memoized so a streaming frame doesn't re-render and
 *  re-parse every earlier message; props stay referentially stable. */
const UserRow = memo(function UserRow({ m, turn, onEditResend, onFork, author }: {
  m: ChatMessage; turn?: ChatTurn;
  onEditResend: (turnId: string) => void; onFork: (turnId: string) => void;
  /** Shared workspaces: who wrote it, and whether that is the viewer. */
  author?: { name: string; mine: boolean };
}) {
  const atts = safeJsonParse<Array<{ path?: string; name?: string; kind?: string; transcript?: string | null; durationSeconds?: number | null }>>(turn?.attachments, []);
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '16px 0', animation: 'msgIn .2s ease' }}>
      <div style={{ maxWidth: '80%' }}>
        {author && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
            <span title={author.mine ? 'You wrote this' : `${author.name} wrote this`} style={{ fontSize: 10.5, fontWeight: 600, color: author.mine ? 'var(--accent)' : 'var(--text-dim)', background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 6, padding: '1px 7px' }}>{author.mine ? `${author.name} (you)` : author.name}</span>
          </div>
        )}
        {atts.length > 0 && (
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginBottom: 6, flexWrap: 'wrap' }}>
            {atts.map((a, i) => {
              const p = a.path ?? a.name ?? '';
              if (a.kind === 'audio' || AUDIO_EXT_RE.test(p)) {
                return <VoiceChip key={i} durationSeconds={a.durationSeconds} transcript={a.transcript} align="right" />;
              }
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '5px 9px', fontSize: 11.5, color: 'var(--text-dim)', ...mono }}>▤ {p.split('/').pop()}</div>
              );
            })}
          </div>
        )}
        <div style={{ background: 'var(--user)', border: '1px solid var(--border-soft)', borderRadius: '14px 14px 4px 14px', padding: '9px 15px', lineHeight: 1.55 }}><Markdown text={m.content} compact /></div>
        <div style={{ display: 'flex', gap: 2, justifyContent: 'flex-end', marginTop: 5 }}>
          <button onClick={() => onEditResend(m.turnId)} title="Edit & resend" style={ghostBtn}><I d={P.edit} size={13} /></button>
          <button onClick={() => onFork(m.turnId)} title="Fork" style={ghostBtn}><I d={P.forkIcon} size={13} /></button>
        </div>
      </div>
    </div>
  );
});

/** Reply TTS (docs/voice.md): fetch → blob → Audio; one playing at a time. */
function SpeakButton({ text, voice }: { text: string; voice?: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'playing'>('idle');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const release = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setState('idle');
  };
  useEffect(() => () => { audioRef.current?.pause(); if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);
  const toggle = async () => {
    if (state !== 'idle') { release(); return; }
    setState('loading');
    try {
      const blob = await api.tts(text, voice);
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      urlRef.current = url;
      audioRef.current = audio;
      audio.onended = release;
      audio.onerror = release;
      await audio.play();
      setState('playing');
    } catch {
      release();
    }
  };
  const title = state === 'playing' ? 'Stop' : state === 'loading' ? 'Loading audio…' : 'Read aloud';
  return (
    <button onClick={() => void toggle()} title={title} aria-label={title} style={{ ...ghostBtn, color: state === 'idle' ? 'var(--text-faint)' : 'var(--accent-hi)', minWidth: 28, minHeight: 28, alignItems: 'center', justifyContent: 'center' }}>
      {state === 'playing' ? <I d={P.stopSquare} size={13} fill="currentColor" /> : <I d={P.speaker} size={14} style={state === 'loading' ? { animation: 'pulse 1s infinite' } : undefined} />}
    </button>
  );
}

const AssistantRow = memo(function AssistantRow({ m, turn, agent, isNewest, isLast, streaming, tts, ttsVoice, onOpenArtifact, onQuickReply, refs }: {
  m: ChatMessage; turn?: ChatTurn; agent?: Agent;
  isNewest: boolean; isLast: boolean; streaming: boolean;
  /** Settings → ttsEnabled: show the speaker button (docs/voice.md). */
  tts: boolean; ttsVoice?: string;
  onOpenArtifact: (title: string, src: string) => void; onQuickReply: (text: string) => void;
  /** Task key chips (docs/tasks-keys.md). */
  refs?: RefResolver;
}) {
  const { text: bodyText, replies } = parseQuickReplies(m.content);
  const art = detectArtifact(bodyText);
  return (
    <div style={{ display: 'flex', gap: 12, margin: '16px 0', animation: 'msgIn .2s ease' }}>
      <div style={{ width: 28, height: 28, borderRadius: 8, background: agent ? grad(agent.colors) : 'linear-gradient(135deg,var(--accent),var(--blue))', flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 2, fontSize: 14 }}>{agent?.emoji ?? '💬'}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* An agent-initiated message (message_owner, docs/agent-messages.md): the agent's, not a reply to you. */}
        {m.toolName === 'message_owner' && <div data-testid="agent-message-label" style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-faint)', marginBottom: 2 }}>{agent?.name ?? 'The agent'} wrote to you · reply here</div>}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
          <div style={{ flex: 1, minWidth: 0, lineHeight: 1.65 }}><Markdown text={bodyText} refs={refs} /></div>
          {tts && bodyText.trim() && !(streaming && isNewest) && <SpeakButton text={plainText(bodyText)} voice={ttsVoice} />}
        </div>
        {art && (
          <div onClick={() => onOpenArtifact(art.title, art.src)} style={{ marginTop: 12, display: 'inline-flex', alignItems: 'center', gap: 11, border: '1px solid var(--border)', borderRadius: 11, padding: '11px 14px', cursor: 'pointer', background: 'var(--panel)', maxWidth: '100%' }}>
            <div style={{ width: 34, height: 34, borderRadius: 8, background: 'var(--accent-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
              <I d={P.panel} size={17} stroke="var(--accent-hi)" />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{art.title}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>HTML · sandboxed · network-denied</div>
            </div>
            <I d={P.external} size={16} stroke="var(--text-faint)" style={{ flex: 'none', marginLeft: 8 }} />
          </div>
        )}
        {isNewest && replies.length > 0 && !streaming && (
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            {replies.map((q) => (
              <button key={q} onClick={() => onQuickReply(q)} style={{ background: 'var(--panel)', border: '1px solid var(--accent-dim)', color: 'var(--accent-hi)', borderRadius: 20, padding: '6px 14px', fontSize: 12.5, cursor: 'pointer', fontWeight: 500 }}>{q}</button>
            ))}
          </div>
        )}
        {isLast && <AssistantFooter turn={turn} />}
      </div>
    </div>
  );
});

/** The header strip of an agent's work session opened in the chat view
 *  (docs/work-log.md): a chip with what started it (heartbeat, a loop, the
 *  task key, a channel), "Open in Work log" for its timeline, and Rerun
 *  when its last run failed or was stopped (the Work log's rerun: the run
 *  again by its trigger, in this session). */
function WorkSessionBar({ agentId, sessionId, label, agentName }: { agentId: string; sessionId: string; label: string; agentName: string }) {
  const app = useApp();
  const [rerunning, setRerunning] = useState(false);
  const last = app.transcript.turns.reduce<ChatTurn | null>((a, t) => (t.sessionId === sessionId && (!a || t.seq > a.seq) ? t : a), null);
  const failed = !!last && !app.streaming && (last.status === 'error' || last.status === 'stopped' || (last.status === 'interrupted' && last.recovery !== 'resumed'));
  const rerun = () => {
    if (!last || rerunning) return;
    setRerunning(true);
    void api.rerunWorkRun(agentId, last.id).then((res) => {
      app.showToast(res.started ? `Rerunning ${label}` : `The rerun did not start: ${res.error || res.status.replace(/^skipped:/, '').replace(/_/g, ' ')}`);
      void app.refreshTranscript();
    }).catch((e: unknown) => app.showToast(e instanceof Error ? e.message.replace(/^\d+\s*/, '').slice(0, 200) : 'Could not rerun it'))
      .finally(() => setRerunning(false));
  };
  const btn: React.CSSProperties = { background: 'none', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text)', fontSize: 11.5, fontWeight: 600, padding: '3px 10px', cursor: 'pointer', flex: 'none' };
  return (
    <div data-testid="work-session-banner" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10, padding: '7px 16px', borderBottom: '1px solid var(--border)', background: 'var(--panel-2)', fontSize: 12, color: 'var(--text-dim)' }}>
      <span data-testid="work-trigger-chip" title={`${agentName}'s work session`} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '1px 8px', flex: 'none', maxWidth: '50%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <I d={P.clock} size={11} />{label}
      </span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agentName}'s work</span>
      {failed && <button onClick={rerun} disabled={rerunning} style={btn}>{rerunning ? 'Rerunning…' : 'Rerun'}</button>}
      <button onClick={() => app.openWorkLog(agentId, { sessionId })} style={btn}>Open in Work log</button>
    </div>
  );
}

export function ChatView() {
  const app = useApp();
  const taskRefs = useTaskRefs();
  const [modelPop, setModelPop] = useState(false);
  const [menu, setMenu] = useState<null | { kind: 'slash' | 'mention'; filter: string }>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true); // autoscroll only while the user is near the bottom
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  /** Uploads composer files; audio (recorded or dropped) takes the voice-note
   *  path: 25MB bound, server-side transcription, chip with the transcript. */
  const uploadFiles = async (files: FileList | File[], durations: Map<File, number> = new Map()) => {
    for (const file of Array.from(files).slice(0, 8)) {
      const audio = isAudioFile(file);
      const limit = audio ? MAX_AUDIO_BYTES : 5_000_000;
      if (file.size > limit) { app.showToast(`${file.name} is too large (${audio ? '25' : '5'}MB max)`); continue; }
      const b64 = btoa(new Uint8Array(await file.arrayBuffer()).reduce((acc, b) => acc + String.fromCharCode(b), ''));
      const path = `uploads/${file.name.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
      const duration = durations.get(file);
      try {
        const res = app.current?.agentId
          ? await api.putAgentFile(app.current.agentId, path, b64, file.type || undefined, duration)
          : await api.wsPutFile(app.workspaceId, path, b64, file.type || undefined, duration);
        if (audio) {
          app.addAttachment(path, 'audio', { transcript: res.transcript ?? null, durationSeconds: res.durationHint ?? duration ?? null });
          if (res.transcript === null || res.transcript === undefined) app.showToast('Voice note attached — transcription unavailable (see docs/voice.md)');
        } else {
          app.addAttachment(path, file.type.startsWith('image/') ? 'image' : 'text');
        }
        await app.refreshFiles();
      } catch {
        app.showToast(`upload of ${file.name} failed`);
      }
    }
  };
  // Voice notes (docs/voice.md): MediaRecorder → upload on stop. The button is
  // hidden where MediaRecorder/getUserMedia are missing.
  const canRecord = useMemo(() => recorderAvailable(), []);
  const recorder = useVoiceRecorder(app.showToast);
  const stopRecording = async () => {
    const rec = await recorder.stop();
    if (rec) await uploadFiles([rec.file], new Map([[rec.file, rec.durationSeconds]]));
  };
  const s = app.current;
  const agent = app.agents.find((a) => a.id === s?.agentId);

  useEffect(() => {
    if (!stickRef.current) return;
    requestAnimationFrame(() => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; });
  }, [app.transcript, app.live]);

  const draft = (s && app.drafts[s.id]) ?? '';

  const turnById = useMemo(() => new Map(app.transcript.turns.map((t) => [t.id, t])), [app.transcript.turns]);
  const lastMsgOfTurn = useMemo(() => {
    const last = new Map<string, string>();
    for (const m of app.transcript.messages) if (m.role === 'assistant') last.set(m.turnId, m.id);
    return last;
  }, [app.transcript.messages]);
  const newestAssistantId = useMemo(
    () => app.transcript.messages.filter((x) => x.role === 'assistant').at(-1)?.id,
    [app.transcript.messages],
  );

  const cutoffSeq = s?.compactCutoff ? Number(s.compactCutoff) : null;

  if (!s) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-faint)', fontSize: 14 }}>
        Create a chat to get started.
      </div>
    );
  }

  // the meter and the ceiling measure the context the last call carried;
  // auto-compaction keeps it under the ceiling
  const tokens = Math.max(0, s.contextTokens ?? 0);
  const pct = s.tokenCeiling ? Math.min(100, (tokens / s.tokenCeiling) * 100) : 0;
  const tokenBarColor = pct > 85 ? 'var(--red)' : pct > 60 ? 'var(--amber)' : 'var(--accent)';
  const autoCompactOn = app.settings.autoCompact !== 'off';
  const capped = s.tokenCeiling > 0 && tokens >= s.tokenCeiling && !autoCompactOn;
  // Workspace-level monthly stop (phase 2.5): loops are paused server-side;
  // the person can still type, so this warns instead of blocking.
  const spend = workspaceSpend(app.workspaces.find((w) => w.id === s.workspaceId));
  const ask = s.permissionMode === 'ask';
  const type = app.agentTypes.find((t) => t.id === s.agentTypeId);
  // Estimated spend for this chat at the model's list price (Settings → Usage
  // overrides); null when the model is unknown to the table.
  const chatUsd = usdFor(s.model || type?.model || agent?.model, s.tokensIn, s.tokensOut, app.pricing);
  // Degradation (docs/incidents.md §4): the last turn ran on a fallback, or the agent's provider is degraded now.
  const degradedNote = degradedChatNote(app.transcript.turns.at(-1)?.degraded, s.workspaceId === app.workspaceId ? app.orgHealth : null, type?.provider ?? agent?.provider);

  const filesForMention = app.fileList;

  const detectMenu = (v: string) => {
    const t = v.trimStart();
    if (t.startsWith('/') && !t.includes('\n')) { setMenu({ kind: 'slash', filter: t.slice(1).toLowerCase() }); return; }
    const m = /@([\w./-]*)$/.exec(v);
    if (m) { setMenu({ kind: 'mention', filter: m[1].toLowerCase() }); return; }
    setMenu(null);
  };

  const suggestions = (() => {
    if (!menu) return [];
    if (menu.kind === 'slash') {
      const builtins = [
        { key: '/clear', desc: 'Clear transcript and context', skill: false },
        { key: '/compact', desc: 'Distill context, keep transcript', skill: false },
        { key: '/export', desc: 'Export conversation as markdown', skill: false },
      ];
      const skillCmds = app.skills.filter((k) => k.enabled === 1).map((k) => ({ key: `/${k.name}`, desc: `Skill · ${k.description || k.name}`, skill: true }));
      return [...builtins, ...skillCmds].filter((c) => c.key.slice(1).toLowerCase().startsWith(menu.filter));
    }
    const f = menu.filter;
    const rank = (p: string) => {
      const bn = p.split('/').pop()!.toLowerCase();
      if (bn.startsWith(f)) return 0;
      if (bn.includes(f)) return 1;
      if (p.toLowerCase().includes(f)) return 2;
      return 9;
    };
    return filesForMention.map((x) => ({ key: x.path, desc: '', skill: false, r: rank(x.path) }))
      .filter((x) => x.r < 9).sort((a, b) => a.r - b.r).slice(0, 8);
  })();

  const pickSuggestion = (key: string, isSkill: boolean) => {
    if (menu?.kind === 'slash') {
      if (!isSkill && ['/clear', '/compact', '/export'].includes(key)) { void app.send(key); setMenu(null); return; }
      app.setDraft(`${key} `);
    } else {
      app.setDraft(draft.replace(/@([\w./-]*)$/, ''));
      app.addAttachment(key, key.match(/\.(png|jpg|jpeg|gif|webp|svg)$/) ? 'image' : AUDIO_EXT_RE.test(key) ? 'audio' : 'text');
      setMenu(null);
    }
    inputRef.current?.focus();
  };

  // A voice note can go without typed text: the transcript is the message.
  const canSend = !!draft.trim() || app.attachments.length > 0;
  const doSend = () => {
    if (!canSend) return;
    setMenu(null);
    void app.send(draft.trim() || (app.attachments.some((a) => a.kind === 'audio') ? 'Voice note.' : 'See the attached file.'));
    if (inputRef.current) inputRef.current.style.height = 'auto';
  };

  // transcript rows with the compaction divider (FR-7.4: transcript unchanged)
  const rows: React.ReactNode[] = [];
  let dividerPlaced = cutoffSeq === null;
  const toolSeq = new Map<string, number>();
  // A conversation keeps the answer prominent: each turn's thinking and tool
  // calls fold into one "worked on it · N steps" line at the first of them
  // (docs/work-log.md). An agent's run (kind 'work') shows everything.
  const foldWork = s.kind !== 'work';
  const workOf = new Map<string, { at: number; nodes: React.ReactNode[] }>();
  const pushWork = (turnId: string, node: React.ReactNode) => {
    if (!foldWork) { rows.push(node); return; }
    let w = workOf.get(turnId);
    if (!w) { w = { at: rows.length, nodes: [] }; workOf.set(turnId, w); rows.push(null); }
    w.nodes.push(node);
  };
  const pushDivider = () => {
    rows.push(<SystemDivider key="compact-divider" text="Context compacted — older turns distilled to a summary (visible transcript unchanged)" />);
    dividerPlaced = true;
  };
  const renderMsg = (m: ChatMessage) => {
    if (!dividerPlaced && cutoffSeq !== null && m.seq > cutoffSeq) pushDivider();
    if (m.role === 'user') {
      const author = app.me?.hasMembers ? { name: app.nameOf(m.authorAccountId), mine: (m.authorAccountId || app.me.ownerAccountId) === app.me.actorId } : undefined;
      rows.push(<UserRow key={m.id} m={m} turn={turnById.get(m.turnId)} onEditResend={app.editResend} onFork={app.fork} author={author} />);
    } else if (m.role === 'thinking') {
      pushWork(m.turnId, <Thinking key={m.id} text={m.content} streaming={false} />);
    } else if (m.role === 'tool') {
      // Persisted tool rows carry only the result; the reviewer's verdict
      // lives on the turn's tool records, matched by position.
      const idx = toolSeq.get(m.turnId) ?? 0;
      toolSeq.set(m.turnId, idx + 1);
      const record = safeJsonParse<Array<{ review?: ToolReview; actionClass?: string; actionId?: string; held?: 'held' | 'staged' }>>(turnById.get(m.turnId)?.toolCalls ?? '', [])[idx];
      pushWork(m.turnId, <ToolCard key={m.id} t={{ kind: 'tool', id: m.id, name: m.toolName ?? 'tool', input: {}, status: m.content.startsWith('Denied') ? 'denied' : 'done', result: m.content, review: record?.review, actionClass: record?.actionClass, actionId: record?.actionId, held: record?.held }} />);
    } else {
      rows.push(
        <AssistantRow key={m.id} m={m} turn={turnById.get(m.turnId)} agent={agent} refs={taskRefs}
          isNewest={m.id === newestAssistantId} isLast={lastMsgOfTurn.get(m.turnId) === m.id}
          streaming={app.streaming} tts={app.settings.ttsEnabled === 'on'} ttsVoice={app.settings.ttsVoice || undefined}
          onOpenArtifact={app.openArtifact} onQuickReply={app.send} />,
      );
    }
  };
  app.transcript.messages.forEach(renderMsg);
  for (const [turnId, w] of workOf) rows[w.at] = <WorkedOn key={`work-${turnId}`} steps={w.nodes.length}>{w.nodes}</WorkedOn>;
  if (!dividerPlaced && cutoffSeq !== null && app.transcript.messages.length > 0) pushDivider();

  // Live: the turn in flight folds the same way, except a call waiting on
  // the owner's approval, which stays in view.
  const liveWork: React.ReactNode[] = [];
  let liveWorkAt = -1;
  const liveRowsRaw = app.live.map((item: LiveItem, i: number) => {
    if (foldWork && (item.kind === 'thinking' || (item.kind === 'tool' && item.status !== 'pending'))) {
      liveWork.push(item.kind === 'thinking' ? <Thinking key={`lt${i}`} text={item.text} streaming={item.streaming} /> : <ToolCard key={item.id} t={item} />);
      if (liveWorkAt < 0) liveWorkAt = i;
      return null;
    }
    if (item.kind === 'user') {
      return (
        <div key={`lu${i}`} style={{ display: 'flex', justifyContent: 'flex-end', margin: '16px 0', animation: 'msgIn .2s ease' }}>
          <div style={{ maxWidth: '80%', background: 'var(--user)', border: '1px solid var(--border-soft)', borderRadius: '14px 14px 4px 14px', padding: '9px 15px', lineHeight: 1.55 }}>
            <Markdown text={item.text} compact />
          </div>
        </div>
      );
    }
    if (item.kind === 'thinking') return <Thinking key={`lt${i}`} text={item.text} streaming={item.streaming} />;
    if (item.kind === 'answer') {
      return (
        <div key={`la${i}`} style={{ display: 'flex', gap: 12, margin: '16px 0' }}>
          <div style={{ width: 28, height: 28, borderRadius: 8, background: agent ? grad(agent.colors) : 'linear-gradient(135deg,var(--accent),var(--blue))', flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 2, fontSize: 14 }}>{agent?.emoji ?? '💬'}</div>
          <div style={{ flex: 1, minWidth: 0, lineHeight: 1.65 }}>
            <Markdown text={item.text} streaming={item.streaming} refs={taskRefs} />
          </div>
        </div>
      );
    }
    return <ToolCard key={item.id} t={item} />;
  });
  const liveRows = liveWorkAt < 0 ? liveRowsRaw : liveRowsRaw.map((r, i) => (i === liveWorkAt ? <WorkedOn key="live-work" live={app.streaming} steps={liveWork.length}>{liveWork}</WorkedOn> : r));

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <header style={{ flex: 'none', borderBottom: '1px solid var(--border)', padding: '11px 16px', display: 'flex', alignItems: 'center', gap: 11, background: 'var(--panel)' }}>
        {app.stacked && (
          <button onClick={() => app.setMobileChatOpen(false)} style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', padding: 4, display: 'flex', flex: 'none' }}>
            <I d={P.chevL} size={20} />
          </button>
        )}
        <div style={{ width: 30, height: 30, borderRadius: 9, background: agent ? grad(agent.colors) : 'linear-gradient(135deg,var(--accent),var(--blue))', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', fontSize: 15 }}>{agent?.emoji ?? '💬'}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontWeight: 600, fontSize: 15, letterSpacing: '-.2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name || s.autoTitle || 'New chat'}</div>
            <button onClick={() => void app.patchSession(s.id, { pinned: s.pinned !== 1 })} title="Pin" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'flex', color: s.pinned === 1 ? 'var(--amber)' : 'var(--text-faint)', flex: 'none' }}>
              <I d={P.pin} size={14} fill="currentColor" />
            </button>
            <button onClick={() => void app.archiveChat(s.id)} title="Archive (retained; restore from the sidebar)" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'flex', color: 'var(--text-faint)', flex: 'none' }}>
              <I d={P.board} size={13} />
            </button>
            <AutoArchiveMenu s={s} />
            {app.me?.hasMembers && (
              <button onClick={() => void app.patchSession(s.id, { shared: s.shared !== 1 })}
                title={s.shared === 1 ? 'Shared with every member of this workspace — click to make it private to you and the owner' : 'Private to you and the owner — click to share it with every member'}
                disabled={app.me.role !== 'owner' && (s.initiatedBy || app.me.ownerAccountId) !== app.me.actorId}
                style={{ background: s.shared === 1 ? 'var(--accent-dim)' : 'none', border: `1px solid ${s.shared === 1 ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 5, padding: '1px 7px', fontSize: 10, fontWeight: 600, color: s.shared === 1 ? 'var(--accent)' : 'var(--text-faint)', cursor: 'pointer', flex: 'none' }}>
                {s.shared === 1 ? 'shared' : 'private'}
              </button>
            )}
            {spend.over && (
              <span title={`${spend.spentTokens.toLocaleString()} of ${spend.budgetTokens.toLocaleString()} tokens used this month. Scheduled loops are paused; raise the budget in Settings → Workspace.`}
                style={{ fontSize: 10, fontWeight: 600, color: 'var(--red)', border: '1px solid var(--red)', borderRadius: 5, padding: '1px 7px', whiteSpace: 'nowrap', flex: 'none' }}>
                Workspace budget reached
              </span>
            )}
            {degradedNote && (
              <span role="status" title="The provider failed repeatedly; turns run on another enabled agent type of a different family until it recovers (docs/incidents.md §4)"
                style={{ fontSize: 10, fontWeight: 600, color: 'var(--amber)', border: '1px solid var(--amber)', borderRadius: 5, padding: '1px 7px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, flex: '0 1 auto' }}>
                {degradedNote}
              </span>
            )}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 2 }}>
            <span style={{ color: 'var(--text-dim)' }}>{agent?.name ?? 'Direct chat'}</span>{roleBeside(agent) && <span data-testid="chat-role"> · {roleBeside(agent)}</span>} · <span style={mono}>{s.cwd ?? 'workspace files'}</span>
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 9 }}>
          {app.width >= 1000 && (
            <div title="Context usage" style={{ cursor: 'default', textAlign: 'right' }}>
              <div title="Context the last model call carried, against this chat's ceiling. Auto-compact keeps it under; the cost is the chat's total." style={{ fontSize: 10.5, color: 'var(--text-faint)', ...mono }}>{Math.round(tokens / 1000)}k / {s.tokenCeiling ? `${s.tokenCeiling / 1000}k` : '∞'}{chatUsd !== null && s.tokensIn + s.tokensOut > 0 ? ` · ${fmtUsd(chatUsd)}` : ''}</div>
              <div style={{ width: 88, height: 5, background: 'var(--panel-2)', borderRadius: 3, marginTop: 3, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: tokenBarColor, borderRadius: 3, transition: 'width .5s' }} />
              </div>
            </div>
          )}
          <div style={{ position: 'relative' }}>
            <button onClick={() => setModelPop(!modelPop)} style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 9, padding: '6px 10px', color: 'var(--text)', cursor: 'pointer', fontSize: 12.5 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: type ? (PROVIDER_COLORS[type.provider] ?? '#94a3b8') : '#94a3b8' }} />
              {app.width >= 900 && <span style={{ fontWeight: 500 }}>{s.model || type?.model || 'echo (dev)'}</span>}
              <I d={P.chevD} size={12} />
            </button>
            {modelPop && (
              <div style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, width: 300, background: 'var(--elev)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: 'var(--shadow)', zIndex: 40, padding: 8, animation: 'msgIn .12s' }}>
                <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.5px', textTransform: 'uppercase', color: 'var(--text-faint)', padding: '6px 8px 4px' }}>Agent type · Provider</div>
                {app.agentTypes.length === 0 && <div style={{ padding: '6px 8px', fontSize: 12, color: 'var(--text-faint)' }}>No agent types yet — add one in Settings → Providers. Chats fall back to the Echo dev provider.</div>}
                {app.agentTypes.map((t) => (
                  <div key={t.id} onClick={() => { void app.patchSession(s.id, { agentTypeId: t.id, model: t.model }); setModelPop(false); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 9, padding: 8, borderRadius: 8, cursor: 'pointer', fontSize: 12.5, background: t.id === s.agentTypeId ? 'var(--panel-2)' : 'none' }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: PROVIDER_COLORS[t.provider] ?? '#94a3b8' }} />
                    <span style={{ flex: 1 }}>{t.name}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-faint)', ...mono }}>{t.model}</span>
                    {t.id === s.agentTypeId && <I d={P.check} size={14} stroke="var(--accent)" sw={2.5} />}
                  </div>
                ))}
                <div style={{ borderTop: '1px solid var(--border-soft)', margin: '8px 4px', paddingTop: 10 }}>
                  <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.5px', textTransform: 'uppercase', color: 'var(--text-faint)', padding: '0 4px 7px' }}>Extended thinking</div>
                  <div style={{ display: 'flex', gap: 4, padding: '0 2px' }}>
                    {['off', 'low', 'medium', 'high'].map((e) => (
                      <div key={e} onClick={() => void app.patchSession(s.id, { thinkingEffort: e })}
                        style={{ flex: 1, textAlign: 'center', padding: 6, borderRadius: 7, fontSize: 11.5, cursor: 'pointer', fontWeight: 600, background: e === s.thinkingEffort ? 'var(--accent)' : 'var(--panel-2)', color: e === s.thinkingEffort ? '#fff' : 'var(--text-dim)' }}>
                        {e[0].toUpperCase() + e.slice(1)}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
          {s.agentId && (
            <button
              title="Distill this conversation into the agent's brain"
              onClick={async () => {
                app.showToast('Distilling…');
                const res = await api.distill(s.id).catch(() => ({ ok: false as const }));
                app.showToast(res.ok ? 'Distilled to the agent\u2019s journal' : 'Nothing to distill yet');
              }}
              style={{ display: 'flex', alignItems: 'center', gap: 7, border: '1px solid var(--border)', borderRadius: 9, padding: '6px 10px', background: 'var(--panel-2)', color: 'var(--text)', cursor: 'pointer', fontSize: 12.5, fontWeight: 600 }}>
              <I d={P.brain} size={14} stroke="var(--accent)" />Distill
            </button>
          )}
          <button onClick={() => void app.patchSession(s.id, { permissionMode: ask ? 'auto' : 'ask' })} title="Permission mode"
            style={{ display: 'flex', alignItems: 'center', gap: 7, border: `1px solid ${ask ? 'var(--border)' : 'var(--green)'}`, borderRadius: 9, padding: '6px 10px', background: ask ? 'var(--panel-2)' : 'color-mix(in oklab,var(--green) 14%,transparent)', color: ask ? 'var(--text)' : 'var(--green)', cursor: 'pointer', fontSize: 12.5, fontWeight: 600 }}>
            <I d={ask ? P.warn : P.bolt} size={14} />{ask ? 'Ask' : 'Auto'}
          </button>
        </div>
      </header>
      {s.kind === 'work' && s.agentId && <WorkSessionBar agentId={s.agentId} sessionId={s.id} label={s.triggerLabel || s.name} agentName={agent?.name ?? 'The agent'} />}

      <div ref={scrollRef} onScroll={(e) => { const el = e.currentTarget; stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} style={{ flex: 1, overflowY: 'auto', padding: '22px 0 8px' }}>
        <div style={{ maxWidth: 760, margin: '0 auto', padding: '0 20px' }}>
          {rows}
          {!app.streaming && app.transcript.turns.at(-1)?.status === 'interrupted' && (
            <InterruptedNote turn={app.transcript.turns.at(-1)!} onRetry={s.kind === 'work' ? undefined : () => app.retry()} />
          )}
          {liveRows}
          {app.streaming && !app.live.some((i) => i.kind !== 'user') && (
            // nothing streamed yet (the model is reading context or a
            // non-streaming provider is answering): say it is working
            <div style={{ display: 'flex', gap: 12, margin: '16px 0', alignItems: 'center', animation: 'msgIn .2s ease' }}>
              <div style={{ width: 28, height: 28, borderRadius: 8, background: agent ? grad(agent.colors) : 'linear-gradient(135deg,var(--accent),var(--blue))', flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>{agent?.emoji ?? '💬'}</div>
              <span style={{ fontSize: 13, color: 'var(--text-faint)', animation: 'pulse 1.4s ease-in-out infinite' }}>{agent?.name ?? 'YAAP'} is working…</span>
            </div>
          )}
        </div>
      </div>

      <div style={{ flex: 'none', padding: '0 20px 18px' }}>
        <div style={{ maxWidth: 760, margin: '0 auto' }}>
          {spend.over && (
            <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--amber)', padding: '6px 10px', border: '1px solid color-mix(in oklab,var(--amber) 45%,var(--border))', borderRadius: 9, background: 'var(--panel-2)' }}>
              <I d={P.warn} size={13} stroke="var(--amber)" />
              <span style={{ flex: 1 }}>This workspace has reached its monthly token budget. You can still chat; scheduled loops stay paused until the month turns or the budget is raised.</span>
              <button onClick={() => app.go('settings')} style={{ background: 'none', border: 'none', color: 'var(--accent-hi)', fontSize: 12, cursor: 'pointer', padding: 0, fontWeight: 600 }}>Settings</button>
            </div>
          )}
          {app.queue.length > 0 && (
            <div style={{ marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {app.queue.map((qq) => (
                <div key={qq.id} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--panel-2)', border: '1px dashed var(--border)', borderRadius: 9, padding: '7px 12px', fontSize: 12.5, color: 'var(--text-dim)' }}>
                  <I d={P.clock} size={13} stroke="var(--text-faint)" />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Queued · {qq.text}</span>
                  <button onClick={() => app.removeQueued(qq.id)} style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 0, display: 'flex' }}><I d={P.x} size={13} /></button>
                </div>
              ))}
            </div>
          )}
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); void uploadFiles(e.dataTransfer.files); }}
            style={{ position: 'relative', border: `1px solid ${dragOver ? 'var(--green)' : menu ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 14, background: 'var(--panel)', boxShadow: 'var(--shadow)' }}>
            <input ref={fileRef} type="file" multiple style={{ display: 'none' }}
              onChange={(e) => { if (e.target.files) void uploadFiles(e.target.files); e.target.value = ''; }} />
            {menu && suggestions.length > 0 && (
              <div style={{ position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, width: 340, maxWidth: '100%', background: 'var(--elev)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: 'var(--shadow)', overflow: 'hidden', zIndex: 30, animation: 'msgIn .12s' }}>
                <div style={{ padding: '7px 12px', fontSize: 10.5, fontWeight: 600, letterSpacing: '.5px', textTransform: 'uppercase', color: 'var(--text-faint)', borderBottom: '1px solid var(--border-soft)' }}>
                  {menu.kind === 'slash' ? 'Slash commands' : 'Files in workspace'}
                </div>
                <div style={{ maxHeight: 260, overflowY: 'auto', padding: 5 }}>
                  {suggestions.map((sug) => (
                    <div key={sug.key} onClick={() => pickSuggestion(sug.key, 'skill' in sug ? Boolean(sug.skill) : false)} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '8px 10px', borderRadius: 8, cursor: 'pointer' }}>
                      <span style={{ ...mono, fontSize: 13, color: menu.kind === 'mention' ? 'var(--blue)' : ('skill' in sug && sug.skill) ? 'var(--accent-hi)' : 'var(--green)', fontWeight: 500 }}>{sug.key}</span>
                      <span style={{ flex: 1, fontSize: 12, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sug.desc}</span>
                      {'skill' in sug && sug.skill ? <span style={{ fontSize: 10, color: 'var(--accent-hi)', border: '1px solid var(--accent-dim)', borderRadius: 5, padding: '1px 6px' }}>skill</span> : null}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {app.attachments.length > 0 && (
              <div style={{ display: 'flex', gap: 7, padding: '11px 13px 0', flexWrap: 'wrap' }}>
                {app.attachments.map((a) => (
                  a.kind === 'audio' ? (
                    <VoiceChip key={a.id} durationSeconds={a.durationSeconds} transcript={a.transcript} onRemove={() => app.removeAttachment(a.id)} />
                  ) : (
                    <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '5px 9px', fontSize: 11.5, color: 'var(--text-dim)', ...mono }}>
                      {a.kind === 'image' ? '▣' : '▤'} {a.path.split('/').pop()}
                      <button onClick={() => app.removeAttachment(a.id)} style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 0, display: 'flex' }}><I d={P.x} size={12} /></button>
                    </div>
                  )
                ))}
              </div>
            )}
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(e) => {
                const el = e.target;
                el.style.height = 'auto';
                el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
                app.setDraft(el.value);
                detectMenu(el.value);
              }}
              onKeyDown={(e) => {
                if (menu && e.key === 'Escape') { e.preventDefault(); setMenu(null); return; }
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); doSend(); }
              }}
              placeholder={app.streaming ? 'Queue a follow-up while streaming…' : `Message ${agent?.name ?? 'YAAP'}  ·  / for commands  ·  @ to attach`}
              rows={1}
              style={{ width: '100%', resize: 'none', border: 'none', outline: 'none', background: 'none', color: 'var(--text)', fontSize: 14, lineHeight: 1.5, padding: '14px 15px 8px', maxHeight: 200 }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 11px 10px' }}>
              <button onClick={() => fileRef.current?.click()} title="Attach a file (or drop it here)" style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 6, borderRadius: 7, display: 'flex' }}><I d={P.attach} size={17} /></button>
              <button onClick={() => { app.setDraft('/'); detectMenu('/'); inputRef.current?.focus(); }} title="Slash command" style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 6, borderRadius: 7, display: 'flex' }}><I d={P.slash} size={16} /></button>
              <button onClick={() => { app.setDraft(`${draft}@`); detectMenu(`${draft}@`); inputRef.current?.focus(); }} title="Mention file" style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 6, borderRadius: 7, display: 'flex' }}><I d={P.at} size={16} /></button>
              {canRecord && !recorder.recording && (
                <button onClick={() => void recorder.start()} title="Record a voice note" aria-label="Record a voice note" style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 6, borderRadius: 7, display: 'flex', minWidth: 32, minHeight: 32, alignItems: 'center', justifyContent: 'center' }}><I d={P.mic} size={16} /></button>
              )}
              {recorder.recording && (
                <div role="status" aria-live="polite" style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--panel-2)', border: '1px solid var(--red)', borderRadius: 9, padding: '3px 4px 3px 10px' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--red)', animation: 'pulse 1s infinite', flex: 'none' }} />
                  <span style={{ ...mono, fontSize: 12.5, color: 'var(--text)', minWidth: 36 }}>{fmtDuration(recorder.elapsed)}</span>
                  <button onClick={recorder.cancel} title="Discard recording" aria-label="Discard recording" style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 6, display: 'flex', minWidth: 32, minHeight: 32, alignItems: 'center', justifyContent: 'center' }}><I d={P.x} size={14} /></button>
                  <button onClick={() => void stopRecording()} title="Stop and attach" aria-label="Stop and attach voice note" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: 'var(--red)', color: '#fff', border: 'none', borderRadius: 7, padding: '0 12px', minWidth: 40, minHeight: 32, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
                    <I d={P.stopSquare} size={12} fill="currentColor" />Stop
                  </button>
                </div>
              )}
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 9 }}>
                <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{app.streaming ? 'Enter to queue' : 'Enter to send'}</span>
                {app.streaming ? (
                  <button onClick={app.stopTurn} style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'var(--red)', color: '#fff', border: 'none', borderRadius: 9, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>Stop
                  </button>
                ) : (
                  <button onClick={doSend} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 38, height: 38, background: canSend ? 'var(--accent)' : 'var(--accent-dim)', color: '#fff', border: 'none', borderRadius: 10, cursor: canSend ? 'pointer' : 'default' }}>
                    <I d={P.sendArrow} size={17} sw={2.2} />
                  </button>
                )}
              </div>
            </div>
          </div>
          {capped && (
            <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--red)', display: 'flex', alignItems: 'center', gap: 7 }}>
              <I d={P.warn} size={13} />Context ceiling reached — run /compact, turn auto-compact on (Settings → Context &amp; budget), or raise the ceiling.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
