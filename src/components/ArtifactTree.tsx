/** The Artifacts tree (docs/filesystem.md "Layout"): either the whole
 *  workspace grouped as Shared / Agents, or one folder (an agent's home). */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { I, P } from '../lib/icons';
import type { Agent, FileEntry } from '../lib/api';
import { ancestors, buildTree, glyphFor, groupTree, type TreeNode } from '../lib/artifacts';

const groupLabel: React.CSSProperties = { fontSize: 10.5, fontWeight: 600, letterSpacing: '.5px', textTransform: 'uppercase', color: 'var(--text-faint)' };

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
  // Reveal the open file (opened from a channel, a breadcrumb, a toast…).
  useEffect(() => {
    if (!selected) return;
    setExpanded((e) => {
      const need = ancestors(selected).filter((a) => !e[a]);
      return need.length ? { ...e, ...Object.fromEntries(need.map((a) => [a, true])) } : e;
    });
  }, [selected]);
  const toggle = (k: string) => setExpanded((e) => ({ ...e, [k]: !e[k] }));

  const row = (n: TreeNode, depth: number, label?: ReactNode): ReactNode => {
    const open = !!expanded[n.path];
    const active = !n.isFolder && n.path === selected;
    return (
      <div key={n.path}>
        <div role="treeitem" aria-expanded={n.isFolder ? open : undefined} aria-selected={active} title={n.path}
          onClick={() => (n.isFolder ? toggle(n.path) : onOpen(n.path))}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', paddingLeft: indent + depth * 13, borderRadius: 7, cursor: 'pointer', background: active ? 'var(--accent-dim)' : 'none', minHeight: 26 }}>
          {n.isFolder
            ? <I d={P.chevD} size={11} stroke="var(--text-faint)" style={{ transform: open ? 'none' : 'rotate(-90deg)', flex: 'none' }} />
            : <span style={{ width: 11, flex: 'none' }} />}
          {label ?? (
            <>
              <span style={{ flex: 'none', fontSize: 11.5 }}>{glyphFor(n.name, n.isFolder)}</span>
              <span style={{ flex: 1, fontSize: 12, fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: active ? 'var(--accent-hi)' : 'var(--text-dim)' }}>{n.name}{n.isFolder ? '/' : ''}</span>
            </>
          )}
        </div>
        {n.isFolder && open && (n.children.length > 0
          ? n.children.map((c) => row(c, depth + 1))
          : <div style={{ fontSize: 11, color: 'var(--text-faint)', padding: '3px 8px', paddingLeft: indent + (depth + 1) * 13 + 17 }}>empty</div>)}
      </div>
    );
  };

  const groupHeader = (key: string, title: string, count: number) => (
    <div role="button" aria-expanded={!!expanded[key]} onClick={() => toggle(key)} data-testid={`artifact-group-${key.slice(6)}`}
      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 8px 4px', paddingLeft: indent - 2, cursor: 'pointer' }}>
      <I d={P.chevD} size={10} stroke="var(--text-faint)" style={{ transform: expanded[key] ? 'none' : 'rotate(-90deg)', flex: 'none' }} />
      <span style={{ ...groupLabel, flex: 1 }}>{title}</span>
      <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>{count}</span>
    </div>
  );

  if (nodes.length === 0) return <div style={{ padding: '4px 10px 6px', paddingLeft: indent + 2, fontSize: 11.5, color: 'var(--text-faint)' }}>{emptyText}</div>;
  if (!groups) return <div role="tree">{nodes.map((n) => row(n, 0))}</div>;
  return (
    <div role="tree">
      {groupHeader('group:shared', 'Shared', groups.shared.length)}
      {expanded['group:shared'] && (
        <div data-testid="artifact-shared">
          {groups.pinned.map((n) => (
            <div key={`pin:${n.path}`} data-testid="artifact-pinned">{row(n, 0, (
              <>
                <span style={{ flex: 'none', fontSize: 11.5 }}>📌</span>
                <span style={{ flex: 1, fontSize: 12, fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: n.path === selected ? 'var(--accent-hi)' : 'var(--text-dim)' }}>{n.path}</span>
              </>
            ))}</div>
          ))}
          {groups.shared.map((n) => row(n, 0))}
          {groups.shared.length === 0 && <div style={{ padding: '3px 8px', paddingLeft: indent + 17, fontSize: 11.5, color: 'var(--text-faint)' }}>No shared folders yet.</div>}
        </div>
      )}
      {groups.agents.length > 0 && groupHeader('group:agents', 'Agents', groups.agents.length)}
      {expanded['group:agents'] && groups.agents.length > 0 && (
        <div data-testid="artifact-agents">
          {groups.agents.map(({ node, agent, label }) => row(node, 0, (
            <>
              {agent ? <AgentAvatar agent={agent} /> : <span style={{ flex: 'none', fontSize: 11.5 }}>📁</span>}
              <span style={{ flex: 1, fontSize: 12.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)' }}>{label}</span>
              <span style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--mono)', flex: 'none' }}>~{node.name}</span>
            </>
          )))}
        </div>
      )}
    </div>
  );
}
