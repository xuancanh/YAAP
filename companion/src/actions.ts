/**
 * Execute one action the server queued — after this machine's own scope
 * check. Shell runs through the user's shell with a timeout and 64 KB of
 * output; file operations stay inside the granted roots with realpath checks.
 */
import { spawn } from 'node:child_process';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ActionResult, WorkItem } from './client.js';
import { fileRoots, resolveInRoots, scopeDenial } from './scopes.js';
import * as platform from './platform.js';

const OUTPUT_CAP = 64 * 1024;
const SHELL_MAX_S = 300;

export async function performAction(item: WorkItem, scopes: string[]): Promise<ActionResult> {
  const denial = scopeDenial(scopes, item.tool);
  if (denial) return { ok: false, output: `refused by the companion: ${denial}` };
  const input = item.input ?? {};
  try {
    switch (item.tool) {
      case 'computer_screenshot': {
        const shot = await platform.screenshot();
        return { ok: true, output: `scale ${platform.currentScale().toFixed(2)} px per pointer unit`, pngBase64: shot.pngBase64, width: shot.width, height: shot.height };
      }
      case 'computer_click':
        return { ok: true, output: await platform.click(num(input.x), num(input.y), (['left', 'right', 'middle'] as const).find((b) => b === input.button) ?? 'left', Boolean(input.double)) };
      case 'computer_move':
        return { ok: true, output: await platform.move(num(input.x), num(input.y)) };
      case 'computer_scroll':
        return { ok: true, output: await platform.scroll(num(input.x), num(input.y), num(input.dx), num(input.dy)) };
      case 'computer_type':
        return { ok: true, output: await platform.type(str(input.text)) };
      case 'computer_key':
        return { ok: true, output: await platform.key(str(input.combo)) };
      case 'computer_shell':
        return runShell(str(input.command), typeof input.cwd === 'string' ? input.cwd : '', Number(input.timeoutSec) || 60);
      case 'computer_read_file': {
        const real = await resolveInRoots(str(input.path), fileRoots(scopes), { mustExist: true });
        const st = await stat(real);
        if (!st.isFile()) return { ok: false, output: `${real} is not a regular file` };
        const buf = await readFile(real);
        if (buf.includes(0)) return { ok: true, output: `(binary file, ${buf.length} bytes — not shown)` };
        const text = buf.toString('utf8');
        return { ok: true, output: text.length > OUTPUT_CAP ? `${text.slice(0, OUTPUT_CAP)}\n…(truncated, ${text.length} chars total)` : text };
      }
      case 'computer_write_file': {
        const real = await resolveInRoots(str(input.path), fileRoots(scopes), { mustExist: false });
        const existing = await stat(real).catch(() => null);
        if (existing && !existing.isFile()) return { ok: false, output: `${real} exists and is not a regular file` };
        await writeFile(real, str(input.content), 'utf8');
        return { ok: true, output: `wrote ${Buffer.byteLength(str(input.content), 'utf8')} bytes to ${real}` };
      }
      case 'computer_list_dir': {
        const real = await resolveInRoots(str(input.path), fileRoots(scopes), { mustExist: true });
        const entries = await readdir(real, { withFileTypes: true });
        const lines = await Promise.all(entries.slice(0, 500).sort((a, b) => a.name.localeCompare(b.name)).map(async (e) => {
          const kind = e.isDirectory() ? 'dir ' : e.isSymbolicLink() ? 'link' : 'file';
          const size = e.isFile() ? await stat(path.join(real, e.name)).then((s) => s.size).catch(() => 0) : 0;
          return `${kind}  ${e.name}${e.isFile() ? `  (${size} B)` : ''}`;
        }));
        return { ok: true, output: `${real}\n${lines.join('\n')}${entries.length > 500 ? `\n…(${entries.length - 500} more)` : ''}` };
      }
      default:
        return { ok: false, output: `unknown tool: ${item.tool}` };
    }
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
}

function num(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error('coordinates must be numbers');
  return n;
}
function str(v: unknown): string {
  if (typeof v !== 'string') throw new Error('expected a string argument');
  return v;
}

/** The user's own shell, their permissions, a hard wall clock, bounded output. */
export function runShell(command: string, cwd: string, timeoutSec: number): Promise<ActionResult> {
  const t = Math.min(Math.max(Math.floor(timeoutSec), 1), SHELL_MAX_S);
  const win = process.platform === 'win32';
  const shell = win ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/sh');
  const args = win ? ['/d', '/s', '/c', command] : ['-c', command];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(shell, args, { cwd: cwd || homedir(), stdio: ['ignore', 'pipe', 'pipe'], detached: !win, windowsHide: true });
    } catch (err) {
      resolve({ ok: false, output: `cannot start shell: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    let out = ''; let err = ''; let truncated = false; let timedOut = false;
    const cap = (cur: string, d: Buffer) => {
      if (cur.length >= OUTPUT_CAP) { truncated = true; return cur; }
      const next = cur + d.toString('utf8');
      if (next.length > OUTPUT_CAP) { truncated = true; return next.slice(0, OUTPUT_CAP); }
      return next;
    };
    child.stdout?.on('data', (d: Buffer) => { out = cap(out, d); });
    child.stderr?.on('data', (d: Buffer) => { err = cap(err, d); });
    const killAll = (sig: NodeJS.Signals) => {
      try { if (!win && child.pid) process.kill(-child.pid, sig); else child.kill(sig); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => { timedOut = true; killAll('SIGTERM'); setTimeout(() => killAll('SIGKILL'), 2_000).unref(); }, t * 1000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, output: `shell error: ${e.message}` }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const parts = [timedOut ? `killed: exceeded the ${t}s time limit` : `exit code ${code ?? signal ?? 'unknown'}`, `stdout:\n${out || '(empty)'}`];
      if (err.trim()) parts.push(`stderr:\n${err}`);
      if (truncated) parts.push('…(output truncated at 64 KB)');
      resolve({ ok: !timedOut && code === 0, output: parts.join('\n') });
    });
  });
}
