/**
 * Preview classification for workspace files: which renderer the frontend
 * should use, and the correct Content-Type for downloads. HTML previews are
 * rendered client-side in a sandboxed, network-denied iframe (FR-13.1) —
 * this module only classifies, it never executes content.
 */
export type PreviewKind = 'markdown' | 'html' | 'image' | 'pdf' | 'audio' | 'text' | 'binary';

const EXT_MIME: Record<string, string> = {
  md: 'text/markdown', markdown: 'text/markdown',
  html: 'text/html', htm: 'text/html',
  txt: 'text/plain', log: 'text/plain',
  json: 'application/json', csv: 'text/csv',
  yaml: 'text/yaml', yml: 'text/yaml', xml: 'application/xml',
  js: 'text/javascript', mjs: 'text/javascript', ts: 'text/plain', tsx: 'text/plain', jsx: 'text/plain',
  css: 'text/css', py: 'text/plain', rs: 'text/plain', go: 'text/plain',
  sh: 'text/plain', sql: 'text/plain', toml: 'text/plain', ini: 'text/plain',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
  pdf: 'application/pdf',
  // voice notes (docs/voice.md): MediaRecorder output + common drag-drop audio
  webm: 'audio/webm', weba: 'audio/webm', m4a: 'audio/mp4', mp4: 'audio/mp4',
  mp3: 'audio/mpeg', mpga: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
};

const AUDIO_KINDS = new Set(['webm', 'weba', 'm4a', 'mp4', 'mp3', 'mpga', 'wav', 'ogg', 'oga']);
const TEXT_KINDS = new Set(['md', 'markdown', 'txt', 'log', 'json', 'csv', 'yaml', 'yml', 'xml', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'css', 'py', 'rs', 'go', 'sh', 'sql', 'toml', 'ini']);
const IMAGE_KINDS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico']);

const ext = (path: string): string => path.split('.').pop()?.toLowerCase() ?? '';

export function contentTypeFor(path: string): string {
  return EXT_MIME[ext(path)] ?? 'application/octet-stream';
}

export function previewKindFor(path: string): PreviewKind {
  const e = ext(path);
  if (e === 'md' || e === 'markdown') return 'markdown';
  if (e === 'html' || e === 'htm') return 'html';
  if (e === 'pdf') return 'pdf';
  if (AUDIO_KINDS.has(e)) return 'audio';
  if (IMAGE_KINDS.has(e)) return 'image';
  if (TEXT_KINDS.has(e)) return 'text';
  return 'binary';
}
