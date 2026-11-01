/** Shared skill UI (execution-plan items 9.3 and 10): the SKILL.md scan
 *  flags on a draft card, outcome stats, the pending-revision diff with
 *  Accept / Reject, the "Import SKILL.md" control, and the memory-import
 *  dialog on the agent home. Used by SettingsView (Skills pane) and
 *  AgentsView (Skills & tools tab). */
import { useRef, useState } from 'react';
import { useApp } from '../store';
import { api, parseRevision, parseScanReport, type Agent, type MemoryImportFormat, type MemoryImportSummary, type Skill, type SkillScanReport } from '../lib/api';
import { lineDiff, diffStats } from '../lib/diff';
import { I, P } from '../lib/icons';

const mono: React.CSSProperties = { fontFamily: 'var(--mono)' };

function agoShort(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Last used · use count · 👍/👎 rate, in one quiet line. */
export function SkillStats({ s }: { s: Skill }) {
  const rated = (s.upCount ?? 0) + (s.downCount ?? 0);
  const rate = rated > 0 ? Math.round(((s.upCount ?? 0) / rated) * 100) : null;
  const rev = parseRevision(s);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 10.5, color: 'var(--text-faint)', ...mono, flexWrap: 'wrap' }}>
      <span title="Turns that loaded this skill">used {s.useCount ?? 0}×</span>
      <span>{s.lastUsedAt ? `last ${agoShort(s.lastUsedAt)}` : 'never used'}</span>
      <span title={`👍 ${s.upCount ?? 0} · 👎 ${s.downCount ?? 0}`} style={{ color: rate === null ? 'var(--text-faint)' : rate >= 60 ? 'var(--green)' : 'var(--amber)' }}>
        {rate === null ? 'unrated' : `${rate}% 👍 (${rated})`}
      </span>
      {rev && <span style={{ color: 'var(--amber)', fontWeight: 700 }}>revision pending</span>}
    </div>
  );
}

/** The scan report from a SKILL.md import: every flag, verbatim, before the
 *  user can enable the draft. No flags → one reassuring line. */
export function ScanFlags({ s }: { s: Skill }) {
  const report = parseScanReport(s);
  if (!report) return null;
  return <ScanReportView report={report} title="Imported SKILL.md" />;
}

/** The same card for any scan report — a SKILL.md import, a registry publish
 *  preview, or an install review (docs/registry.md). */
export function ScanReportView({ report, title }: { report: SkillScanReport; title: string }) {
  return (
    <div style={{ marginTop: 8, padding: '8px 10px', border: `1px solid ${report.flags.length ? 'var(--amber)' : 'var(--border-soft)'}`, borderRadius: 9, background: report.flags.length ? 'color-mix(in oklab,var(--amber) 10%,transparent)' : 'var(--panel-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, fontWeight: 700, color: report.flags.length ? 'var(--amber)' : 'var(--text-dim)' }}>
        {report.flags.length > 0 && <I d={P.warn} size={13} />}
        {title} · {report.bytes} bytes · {report.lines} lines · {report.urls.length} URL{report.urls.length === 1 ? '' : 's'} · {report.flags.length === 0 ? 'nothing flagged' : `${report.flags.length} flag${report.flags.length === 1 ? '' : 's'}`}
      </div>
      {report.flags.map((f, i) => (
        <div key={i} style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 4, display: 'flex', gap: 7 }}>
          <span style={{ ...mono, fontSize: 10, color: 'var(--amber)', border: '1px solid var(--amber)', borderRadius: 5, padding: '0 5px', flex: 'none', alignSelf: 'flex-start' }}>{f.kind}</span>
          <span>{f.detail}</span>
        </div>
      ))}
      {report.urls.length > 0 && (
        <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 5, ...mono, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{report.urls.slice(0, 6).join('\n')}{report.urls.length > 6 ? `\n…and ${report.urls.length - 6} more` : ''}</div>
      )}
    </div>
  );
}

/** An agent-proposed revision as a line diff; Accept replaces the
 *  instructions (previous text kept in history), Reject drops it. */
export function RevisionCard({ s, onDone }: { s: Skill; onDone: () => void }) {
  const app = useApp();
  const rev = parseRevision(s);
  const [busy, setBusy] = useState(false);
  if (!rev) return null;
  const ops = lineDiff(s.instructions, rev.instructions);
  const stats = diffStats(ops);
  const act = async (accept: boolean) => {
    setBusy(true);
    try {
      await api.resolveSkillRevision(s.id, accept);
      app.showToast(accept ? `/${s.name} updated — previous version kept in history` : 'Revision rejected');
      onDone();
    } catch (err) {
      app.showToast(err instanceof Error ? err.message.slice(0, 140) : 'failed');
    }
    setBusy(false);
  };
  return (
    <div style={{ marginTop: 8, border: '1px solid var(--amber)', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 11px', background: 'color-mix(in oklab,var(--amber) 10%,transparent)' }}>
        <I d={P.edit} size={13} stroke="var(--amber)" />
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--amber)' }}>Proposed revision</span>
        <span style={{ fontSize: 10.5, color: 'var(--text-faint)', ...mono }}>by {rev.proposedBy} · {agoShort(rev.proposedAt)} · <span style={{ color: 'var(--green)' }}>+{stats.added}</span> <span style={{ color: 'var(--red)' }}>−{stats.removed}</span></span>
        <span style={{ flex: 1 }} />
        <button disabled={busy} onClick={() => void act(true)} style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 7, padding: '4px 12px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>Accept</button>
        <button disabled={busy} onClick={() => void act(false)} style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 7, padding: '4px 12px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>Reject</button>
      </div>
      {rev.reason && <div style={{ fontSize: 12, color: 'var(--text-dim)', padding: '7px 11px 0', lineHeight: 1.5 }}><b>Why:</b> {rev.reason}</div>}
      <pre style={{ margin: 0, padding: '8px 0', background: 'var(--code)', fontSize: 11, ...mono, lineHeight: 1.55, whiteSpace: 'pre-wrap', maxHeight: 260, overflowY: 'auto' }}>
        {ops.map((op, i) => (
          <div key={i} style={{
            padding: '0 11px',
            color: op.kind === 'add' ? 'var(--green)' : op.kind === 'del' ? 'var(--red)' : 'var(--text-dim)',
            background: op.kind === 'add' ? 'color-mix(in oklab,var(--green) 12%,transparent)' : op.kind === 'del' ? 'color-mix(in oklab,var(--red) 12%,transparent)' : 'none',
            textDecoration: op.kind === 'del' ? 'line-through' : 'none',
          }}>
            {op.kind === 'add' ? '+ ' : op.kind === 'del' ? '− ' : '  '}{op.text || ' '}
          </div>
        ))}
      </pre>
    </div>
  );
}

/** "Import SKILL.md": pick a file or paste; the result is a draft with its
 *  scan report, which the caller's list then shows. */
export function ImportSkillMdButton({ scope, onDone, compact }: { scope: { workspaceId?: string; agentId?: string }; onDone: () => void; compact?: boolean }) {
  const app = useApp();
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (content: string) => {
    setBusy(true);
    try {
      const { skill, scan } = await api.importSkillMd(content, scope);
      app.showToast(`/${skill.name} imported as a draft${scan.flags.length ? ` — ${scan.flags.length} flag${scan.flags.length === 1 ? '' : 's'} to review` : ''}`);
      setOpen(false);
      setText('');
      onDone();
    } catch (err) {
      app.showToast(err instanceof Error ? err.message.slice(0, 160) : 'import failed');
    }
    setBusy(false);
  };

  return (
    <>
      <input ref={fileRef} type="file" accept=".md,text/markdown,text/plain" style={{ display: 'none' }}
        onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) await submit(await f.text()); }} />
      <button onClick={() => setOpen(true)} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: compact ? 7 : 9, padding: compact ? '4px 10px' : '7px 12px', fontSize: compact ? 11.5 : 12.5, fontWeight: 600, cursor: 'pointer' }}>
        <I d={P.download} size={13} style={{ transform: 'rotate(180deg)' }} />Import SKILL.md
      </button>
      {open && (
        <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', backdropFilter: 'blur(2px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: 560, maxWidth: '100%', background: 'var(--elev)', border: '1px solid var(--border)', borderRadius: 18, boxShadow: 'var(--shadow)', animation: 'pop .16s' }}>
            <div style={{ padding: '20px 24px 14px', borderBottom: '1px solid var(--border-soft)' }}>
              <div style={{ fontSize: 17, fontWeight: 700 }}>Import a SKILL.md</div>
              <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 2 }}>
                agentskills.io format · scanned for size, URLs and instruction smells · lands as a draft you approve
              </div>
            </div>
            <div style={{ padding: '14px 24px' }}>
              <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={'---\nname: my-skill\ndescription: What it does and when to use it.\n---\n\n1. First step…'}
                style={{ width: '100%', minHeight: 180, resize: 'vertical', background: 'var(--code)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', color: 'var(--text)', fontSize: 12, ...mono, lineHeight: 1.55, outline: 'none' }} />
              <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 6 }}>Only a single SKILL.md is read; bundled scripts/ and references/ are not imported.</div>
            </div>
            <div style={{ padding: '12px 24px 16px', borderTop: '1px solid var(--border-soft)', display: 'flex', gap: 10 }}>
              <button onClick={() => fileRef.current?.click()} style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 9, padding: '9px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Choose file…</button>
              <button onClick={() => setOpen(false)} style={{ marginLeft: 'auto', background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 9, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
              <button disabled={busy || !text.trim()} onClick={() => void submit(text)} style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 9, padding: '9px 18px', fontSize: 13, fontWeight: 700, cursor: text.trim() ? 'pointer' : 'default', opacity: text.trim() ? 1 : 0.5 }}>{busy ? 'Scanning…' : 'Scan & import as draft'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const FORMATS: Array<{ id: MemoryImportFormat; label: string; files: string; hint: string }> = [
  { id: 'claude-memory', label: 'Claude memory', files: 'pasted memory text or JSON', hint: 'Settings → Your Claude → Manage memory, or ask Claude to "write out your memories of me verbatim". Facts about you become profile proposals; the rest become quarantined lessons.' },
  { id: 'muse', label: 'Meta Muse export', files: 'Soul.md · Identity.md · Memory.md', hint: 'Soul.md is proposed as a charter addendum (shown as a diff). Identity.md and Memory.md become lessons and profile proposals.' },
  { id: 'hermes', label: 'Hermes Agent', files: 'MEMORY.md · USER.md', hint: 'MEMORY.md → quarantined lessons. USER.md → profile proposals you approve line by line.' },
  { id: 'openclaw', label: 'OpenClaw', files: 'MEMORY.md · USER.md · SOUL.md', hint: 'Same mapping as Hermes, plus SOUL.md as a charter addendum.' },
];

/** Agent home → Import: bring another assistant's memory into this agent as
 *  proposals. Nothing lands trusted; the result panel says exactly what was
 *  queued where, and the charter addendum is applied only from here. */
export function MemoryImportModal({ a, onClose }: { a: Agent; onClose: () => void }) {
  const app = useApp();
  const fileRef = useRef<HTMLInputElement>(null);
  const [format, setFormat] = useState<MemoryImportFormat>('claude-memory');
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MemoryImportSummary | null>(null);
  const [applied, setApplied] = useState(false);
  const fmt = FORMATS.find((f) => f.id === format)!;
  const fileNames = Object.keys(files);
  const canSubmit = fileNames.length > 0 || text.trim().length > 0;

  const submit = async () => {
    setBusy(true);
    try {
      const content = fileNames.length > 0 ? { ...files, ...(text.trim() ? { 'pasted.md': text } : {}) } : text;
      setResult(await api.importAgentMemory(a.id, format, content, app.workspaceId || undefined));
      setApplied(false);
      await app.refreshWorkspaces();
    } catch (err) {
      app.showToast(err instanceof Error ? err.message.slice(0, 160) : 'import failed');
    }
    setBusy(false);
  };

  const applyCharter = async () => {
    if (!result?.charterSuggestion) return;
    await api.updateAgent(a.id, { charter: result.charterSuggestion.proposed });
    await app.refreshAgents();
    setApplied(true);
    app.showToast('Charter updated');
  };

  const field: React.CSSProperties = { width: '100%', background: 'var(--code)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', color: 'var(--text)', fontSize: 12, ...mono, lineHeight: 1.55, outline: 'none' };
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', backdropFilter: 'blur(2px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 600, maxWidth: '100%', maxHeight: '90vh', display: 'flex', flexDirection: 'column', background: 'var(--elev)', border: '1px solid var(--border)', borderRadius: 18, boxShadow: 'var(--shadow)', animation: 'pop .16s' }}>
        <div style={{ padding: '20px 24px 14px', borderBottom: '1px solid var(--border-soft)', flex: 'none' }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>Import memory into {a.name}</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 2 }}>
            Everything arrives as a proposal: lessons quarantined until you promote them, profile lines you approve, a charter change you apply. Nothing imported is trusted by default.
          </div>
        </div>
        <div style={{ padding: '14px 24px', overflowY: 'auto' }}>
          {!result ? (
            <>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                {FORMATS.map((f) => (
                  <button key={f.id} onClick={() => { setFormat(f.id); setFiles({}); }} style={{
                    background: format === f.id ? 'var(--accent-dim)' : 'var(--panel-2)', border: format === f.id ? '1px solid var(--accent)' : '1px solid var(--border-soft)',
                    color: 'var(--text)', borderRadius: 8, padding: '6px 11px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  }}>{f.label}</button>
                ))}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.55, marginBottom: 10 }}>
                <b>{fmt.files}.</b> {fmt.hint}
              </div>
              <input ref={fileRef} type="file" multiple accept=".md,.txt,.json,text/markdown,text/plain,application/json" style={{ display: 'none' }}
                onChange={async (e) => {
                  const picked = Array.from(e.target.files ?? []);
                  e.target.value = '';
                  const next: Record<string, string> = { ...files };
                  for (const f of picked) next[f.name] = await f.text();
                  setFiles(next);
                }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                <button onClick={() => fileRef.current?.click()} style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 9, padding: '7px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
                  {format === 'claude-memory' ? 'Upload a file…' : 'Upload the files…'}
                </button>
                {fileNames.map((n) => (
                  <span key={n} style={{ fontSize: 11, ...mono, border: '1px solid var(--border)', borderRadius: 6, padding: '2px 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
                    {n}
                    <button onClick={() => { const next = { ...files }; delete next[n]; setFiles(next); }} style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 0, display: 'flex' }}><I d={P.x} size={10} /></button>
                  </span>
                ))}
              </div>
              <textarea value={text} onChange={(e) => setText(e.target.value)} style={{ ...field, minHeight: 150, resize: 'vertical' }}
                placeholder={format === 'claude-memory' ? '[2026-03-01] - memory content\n- another memory\nor a JSON array of { "topic", "text" }' : `…or paste ${format === 'muse' ? 'Memory.md' : 'MEMORY.md'} here`} />
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px' }}>
                  <div style={{ fontSize: 22, fontWeight: 700 }}>{result.lessons.added}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>lessons quarantined{result.lessons.skipped ? ` · ${result.lessons.skipped} already known` : ''}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 3 }}>Review on the Memory tab → Awaiting review</div>
                </div>
                <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px' }}>
                  <div style={{ fontSize: 22, fontWeight: 700 }}>{result.profileProposals.proposed}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>profile proposals{result.profileProposals.skipped ? ` · ${result.profileProposals.skipped} skipped` : ''}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 3 }}>{result.profileProposals.workspaceId ? 'Approve them under Settings → Workspace' : 'No workspace selected — profile lines skipped'}</div>
                </div>
              </div>
              {result.files.used.length > 0 && (
                <div style={{ fontSize: 11, color: 'var(--text-faint)', ...mono }}>read: {result.files.used.join(', ')}{result.files.ignored.length ? ` · ignored: ${result.files.ignored.join(', ')}` : ''}</div>
              )}
              {result.charterSuggestion && (
                <div style={{ border: '1px solid var(--amber)', borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 11px', background: 'color-mix(in oklab,var(--amber) 10%,transparent)' }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--amber)' }}>Charter addendum proposed</span>
                    <span style={{ flex: 1 }} />
                    {applied ? <span style={{ fontSize: 11.5, color: 'var(--green)', fontWeight: 600 }}>Applied</span> : (
                      <button onClick={() => void applyCharter()} style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 7, padding: '4px 12px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>Apply to charter</button>
                    )}
                  </div>
                  <pre style={{ margin: 0, padding: '8px 0', background: 'var(--code)', fontSize: 11, ...mono, lineHeight: 1.55, whiteSpace: 'pre-wrap', maxHeight: 220, overflowY: 'auto' }}>
                    {lineDiff(a.charter, result.charterSuggestion.proposed).map((op, i) => (
                      <div key={i} style={{ padding: '0 11px', color: op.kind === 'add' ? 'var(--green)' : op.kind === 'del' ? 'var(--red)' : 'var(--text-dim)', background: op.kind === 'add' ? 'color-mix(in oklab,var(--green) 12%,transparent)' : 'none' }}>
                        {op.kind === 'add' ? '+ ' : op.kind === 'del' ? '− ' : '  '}{op.text || ' '}
                      </div>
                    ))}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
        <div style={{ padding: '12px 24px 16px', borderTop: '1px solid var(--border-soft)', display: 'flex', gap: 10, flex: 'none' }}>
          {result && <button onClick={() => setResult(null)} style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 9, padding: '9px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Import more</button>}
          <button onClick={onClose} style={{ marginLeft: 'auto', background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 9, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>{result ? 'Done' : 'Cancel'}</button>
          {!result && (
            <button disabled={busy || !canSubmit} onClick={() => void submit()} style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 9, padding: '9px 18px', fontSize: 13, fontWeight: 700, cursor: canSubmit ? 'pointer' : 'default', opacity: canSubmit ? 1 : 0.5 }}>{busy ? 'Importing…' : 'Import as proposals'}</button>
          )}
        </div>
      </div>
    </div>
  );
}
