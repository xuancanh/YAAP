/** One small icon per file kind (the Artifacts tree, the folder view): a
 *  page outline with a mark for what is inside, tinted by family. */
import { extOf } from '../lib/artifacts';

export type FileFamily = 'doc' | 'table' | 'json' | 'code' | 'image' | 'audio' | 'pdf' | 'html' | 'text' | 'folder' | 'folderOpen';

const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif'];
const AUDIO = ['mp3', 'm4a', 'wav', 'webm', 'ogg', 'aac', 'opus'];
const CODE = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'sql', 'css', 'scss', 'less', 'xml', 'yaml', 'yml', 'toml', 'ini', 'env', 'lua', 'r', 'dart', 'vue', 'svelte', 'graphql', 'proto', 'dockerfile', 'makefile', 'jsonl', 'ndjson'];

export function familyOfFile(name: string): FileFamily {
  const ext = extOf(name);
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'doc';
  if (ext === 'csv' || ext === 'tsv') return 'table';
  if (ext === 'json') return 'json';
  if (IMAGE.includes(ext)) return 'image';
  if (AUDIO.includes(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (CODE.includes(ext)) return 'code';
  return 'text';
}

const TINT: Record<FileFamily, string> = {
  doc: 'var(--text-dim)', text: 'var(--text-faint)', table: 'var(--green)', json: 'var(--amber)', code: 'var(--blue)',
  image: 'var(--accent-hi)', audio: 'var(--accent-hi)', pdf: 'var(--red)', html: 'var(--blue)', folder: 'var(--text-faint)', folderOpen: 'var(--text-faint)',
};

const PAGE = 'M6 2.75h5.6L15.25 6.4v9.85a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3.75a1 1 0 0 1 1-1z M11.5 2.9V6.5h3.6';
const MARK: Partial<Record<FileFamily, string>> = {
  doc: 'M7.6 9.6h5 M7.6 12h5 M7.6 14.4h3',
  text: 'M7.6 9.6h5 M7.6 12h5',
  table: 'M7.4 9.4h5.4v5.2H7.4z M7.4 12h5.4 M10.1 9.4v5.2',
  json: 'M9 9.3c-.9 0-1 .5-1 1.1v.6c0 .5-.3.9-.8 1 .5.1.8.5.8 1v.6c0 .6.1 1.1 1 1.1 M11.2 9.3c.9 0 1 .5 1 1.1v.6c0 .5.3.9.8 1-.5.1-.8.5-.8 1v.6c0 .6-.1 1.1-1 1.1',
  code: 'M8.6 10l-1.6 2 1.6 2 M11.6 10l1.6 2-1.6 2',
  html: 'M8.6 10l-1.6 2 1.6 2 M11.6 10l1.6 2-1.6 2',
  image: 'M7.2 14.6l2-2.4 1.5 1.6 1-1 1.3 1.8z M12 9.6a.7.7 0 1 0 0 .01',
  audio: 'M8 11v2 M9.6 9.8v4.4 M11.2 10.6v2.8 M12.8 11.4v1.2',
  pdf: 'M7.6 14.4h5 M7.6 12h5 M7.6 9.6h2.2',
};

export function FileIcon({ name, folder, open, size = 16 }: { name: string; folder?: boolean; open?: boolean; size?: number }) {
  const fam: FileFamily = folder ? (open ? 'folderOpen' : 'folder') : familyOfFile(name);
  const c = TINT[fam];
  if (fam === 'folder' || fam === 'folderOpen') {
    return (
      <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke={c} strokeWidth={1.4} strokeLinejoin="round" aria-hidden data-icon={fam}>
        {fam === 'folder'
          ? <path d="M2.75 5.5a1 1 0 0 1 1-1h3.6l1.6 1.7h7.3a1 1 0 0 1 1 1v7.55a1 1 0 0 1-1 1H3.75a1 1 0 0 1-1-1z" />
          : <path d="M2.75 14.75V5.5a1 1 0 0 1 1-1h3.6l1.6 1.7h6.3a1 1 0 0 1 1 1V8.5 M2.75 14.75l2-5.25a1 1 0 0 1 .94-.65h11.1a.6.6 0 0 1 .56.8l-1.8 4.75a1 1 0 0 1-.94.6z" />}
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke={c} strokeWidth={1.35} strokeLinecap="round" strokeLinejoin="round" aria-hidden data-icon={fam}>
      <path d={PAGE} />
      {MARK[fam] && <path d={MARK[fam]} />}
    </svg>
  );
}
