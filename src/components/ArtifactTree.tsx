/** The Artifacts tree (docs/filesystem.md "Layout"): either the whole
 *  workspace grouped as Shared / Agents, or one folder (an agent's home).
 *  An icon per kind, indent guides, a clear selection, arrow-key navigation. */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { I, P } from '../lib/icons';
import type { Agent, FileEntry } from '../lib/api';
import { ancestors, buildTree, groupTree, type TreeNode } from '../lib/artifacts';
import { FileIcon } from './FileIcon';

/** Same gradient as the store's `grad`, kept local so the tree stays
 *  importable without the app store (tests). */
const avatarBg = (colorsJson: string): string => {
  try { const [a, b] = JSON.parse(colorsJson) as [string, string]; return `linear-gradient(140deg,${a},${b})`; } catch { return 'linear-gradient(135deg,var(--accent),var(--blue))'; }
};

export function AgentAvatar({ agent, size = 18 }: { agent: Agent; size?: number }) {
  return (
    <span aria-hidden style={{ width: size, height: size, borderRadius: Math.round(size / 3.4), background: avatarBg(agent.colors), display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none', fontSize: Math.round(size * 0.55) }}>{agent.emoji}</span>
  );
}

const STEP = 14;

export function ArtifactTree({ entries, agents, root, grouped, selected, onOpen, indent = 8, emptyText = 'No files yet.' }: {
  entries: FileEntry[];
  agents: Agent[];
  /** Show only this folder (e.g. an agent's home); paths stay full. */
  root?: string;
  /** Split the top level into Shared and Agents. */
  grouped?: boolean;
  selected: string | null;
  onOpen: (path: string) => void;
  indent?: number;
  emptyText?: string;
}) {
  const nodes = useMemo(() => buildTree(entries, root), [entries, root]);
  const groups = useMemo(() => (grouped ? groupTree(nodes, agents) : null), [grouped, nodes, agents]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ 'group:shared': true, 'group:agents': true });
  const treeRef = useRef<HTMLDivElement>(null);
  // Reveal the open file (opened from a channel, a breadcrumb, a toast…).
  useEffect(() => {
    if (!selected) return;
    setExpanded((e) => {
      const need = ancestors(selected).filter((a) => !e[a]);
      return need.length ? { ...e, ...Object.fromEntries(need.map((a) => [a, true])) } : e;
    });
  }, [selected]);
  const toggle = (k: string) => setExpanded((e) => ({ ...e, [k]: !e[k] }));

  /** Up/Down move between visible rows; Right/Left open/close folders. */
  const onKey = (e: KeyboardEvent<HTMLDivElement>, n: TreeNode) => {
    const rows = [...(treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])];
    const i = rows.indexOf(e.currentTarget);
    if (e.key === 'ArrowDown') { e.preventDefault(); rows[i + 1]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); rows[i - 1]?.focus(); }
    else if (e.key === 'ArrowRight' && n.isFolder && !expanded[n.path]) { e.preventDefault(); toggle(n.path); }
    else if (e.key === 'ArrowLeft' && n.isFolder && expanded[n.path]) { e.preventDefault(); toggle(n.path); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (n.isFolder) toggle(n.path); else onOpen(n.path); }
  };

  const row = (n: TreeNode, depth: number, label?: ReactNode): ReactNode => {
    const open = !!expanded[n.path];
    const active = !n.isFolder && n.path === selected;
    const pad = indent + depth * STEP;
    return (
      <div key={n.path}>
        <div role="treeitem" aria-expanded={n.isFolder ? open : undefined} aria-selected={active} title={n.path} tabIndex={active ? 0 : -1}
          className={`ftree-row${active ? ' on' : ''}`} style={{ paddingLeft: pad }}
          onClick={() => (n.isFolder ? toggle(n.path) : onOpen(n.path))} onKeyDown={(e) => onKey(e, n)}>
          {n.isFolder
            ? <span className={`chev${open ? '' : ' closed'}`}><I d={P.chevD} size={11} /></span>
            : <span className="chev" />}
          {label ?? (
            <>
              <span className="ico"><FileIcon name={n.name} folder={n.isFolder} open={open} /></span>
              <span className="name">{n.name}</span>
            </>
          )}
        </div>
        {n.isFolder && open && (
          <div className="ftree-kids" role="group" style={{ ['--guide' as string]: `${pad + 13}px` }}>
            {n.children.length > 0
              ? n.children.map((c) => row(c, depth + 1))
              : <div className="ftree-empty" style={{ paddingLeft: pad + STEP + 34 }}>empty</div>}
          </div>
        )}
      </div>
    );
  };

  const groupHeader = (key: string, title: string, count: number) => (
    <div role="button" tabIndex={0} aria-expanded={!!expanded[key]} onClick={() => toggle(key)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(key); } }}
      data-testid={`artifact-group-${key.slice(6)}`} className="ftree-group">
      <I d={P.chevD} size={10} style={{ transform: expanded[key] ? 'none' : 'rotate(-90deg)', flex: 'none', transition: 'transform .12s' }} />
      <span>{title}</span>
      <span className="count">{count}</span>
    </div>
  );

  if (nodes.length === 0) return <div style={{ padding: '4px 10px 6px', paddingLeft: indent + 6, fontSize: 12, color: 'var(--text-faint)' }}>{emptyText}</div>;
  // the first row is focusable when nothing is selected
  const ensureFocusable = (el: HTMLDivElement | null) => {
    treeRef.current = el;
    if (el && !el.querySelector('[role="treeitem"][tabindex="0"]')) el.querySelector<HTMLElement>('[role="treeitem"]')?.setAttribute('tabindex', '0');
  };
  if (!groups) return <div role="tree" className="ftree" ref={ensureFocusable}>{nodes.map((n) => row(n, 0))}</div>;
  return (
    <div role="tree" className="ftree" ref={ensureFocusable}>
      {groupHeader('group:shared', 'Shared', groups.shared.length)}
      {expanded['group:shared'] && (
        <div data-testid="artifact-shared">
          {groups.pinned.map((n) => (
            <div key={`pin:${n.path}`} data-testid="artifact-pinned">{row(n, 0, (
              <>
                <span className="ico" style={{ color: 'var(--accent-hi)' }}><I d={P.pin} size={13} /></span>
                <span className="name">{n.name}</span>
                <span className="aside">{n.path.split('/')[0]}/</span>
              </>
            ))}</div>
          ))}
          {groups.shared.map((n) => row(n, 0))}
          {groups.shared.length === 0 && <div className="ftree-empty" style={{ paddingLeft: indent + 20 }}>No shared folders yet.</div>}
        </div>
      )}
      {groups.agents.length > 0 && groupHeader('group:agents', 'Agents', groups.agents.length)}
      {expanded['group:agents'] && groups.agents.length > 0 && (
        <div data-testid="artifact-agents">
          {groups.agents.map(({ node, agent, label }) => row(node, 0, (
            <>
              {agent ? <AgentAvatar agent={agent} /> : <span className="ico"><FileIcon name={node.name} folder /></span>}
              <span className="name" style={{ color: 'var(--text)', fontWeight: 550 }}>{label}</span>
              <span className="aside">~{node.name}</span>
            </>
          )))}
        </div>
      )}
    </div>
  );
}
