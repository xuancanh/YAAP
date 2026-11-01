/**
 * Platform back-ends for screen and input, using only tools that ship with
 * the OS or are one `brew`/`apt` away — no native Node modules, so the
 * companion installs with `npx` anywhere.
 *
 *  macOS    screenshot: screencapture -x (built in), downscaled with sips
 *           click/move: cliclick when installed (brew install cliclick),
 *                       else osascript System Events (left click only)
 *           type/key:   osascript System Events (keystroke / key code)
 *           scroll:     best effort — pointer move, then arrow keys
 *  Linux    screenshot: grim (Wayland) | scrot | ImageMagick import (X11)
 *           input:      xdotool (X11; on Wayland install xdotool's
 *                       alternatives or run under XWayland)
 *  Windows  screenshot: PowerShell + System.Drawing CopyFromScreen
 *           input:      PowerShell + user32 (SetCursorPos/mouse_event) and
 *                       System.Windows.Forms.SendKeys — best effort
 *
 * Coordinates: everything the agent sends is in PIXELS OF THE LAST
 * SCREENSHOT. The screenshot path records the scale between those pixels
 * and the OS's pointer coordinate space (Retina 2×, downscaling) and every
 * pointer action divides by it.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface Screenshot { pngBase64: string; width: number; height: number }

/** pixels-in-screenshot per OS pointer unit; updated by every screenshot. */
let scale = 1;
export const currentScale = (): number => scale;
export const setScaleForTests = (s: number): void => { scale = s; };

const MAX_SHOT_WIDTH = 1600;

export function run(cmd: string, args: string[], opts: { timeoutMs?: number; input?: string } = {}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 30_000);
    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout: out, stderr: err, code }); });
    if (opts.input) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

async function ok(cmd: string, args: string[], what: string, timeoutMs = 30_000): Promise<string> {
  const r = await run(cmd, args, { timeoutMs }).catch((e: Error) => { throw new Error(`${what}: cannot run ${cmd} (${e.message})`); });
  if (r.code !== 0) throw new Error(`${what} failed (${cmd} exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`.slice(0, 500));
  return r.stdout;
}

function which(bin: string): boolean {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).concat(['/opt/homebrew/bin', '/usr/local/bin']);
  return dirs.some((d) => d && existsSync(path.join(d, process.platform === 'win32' ? `${bin}.exe` : bin)));
}

/** Width/height from the PNG IHDR chunk. */
export function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.toString('ascii', 1, 4) !== 'PNG') throw new Error('not a PNG');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

// ---- screenshots ----------------------------------------------------------------

export async function screenshot(): Promise<Screenshot> {
  const dir = await mkdtemp(path.join(tmpdir(), 'yaam-shot-'));
  const file = path.join(dir, 'shot.png');
  try {
    let pointerW: number | null = null;
    if (process.platform === 'darwin') {
      await ok('/usr/sbin/screencapture', ['-x', '-t', 'png', file], 'screenshot').catch((e: Error) => {
        throw new Error(`${e.message} — on macOS grant Screen Recording permission to the terminal running yaam-companion (System Settings → Privacy & Security → Screen Recording) and restart it`);
      });
      // points of the main display, for the pixel→point scale
      const bounds = await run('/usr/bin/osascript', ['-e', 'tell application "Finder" to get bounds of window of desktop']).catch(() => null);
      const m = bounds && /(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)/.exec(bounds.stdout);
      if (m) pointerW = Number(m[3]) - Number(m[1]);
      const { width } = pngSize(await readFile(file));
      if (width > MAX_SHOT_WIDTH && which('sips')) await run('/usr/bin/sips', ['--resampleWidth', String(MAX_SHOT_WIDTH), file]).catch(() => null);
    } else if (process.platform === 'linux') {
      if (which('grim')) await ok('grim', [file], 'screenshot');
      else if (which('scrot')) await ok('scrot', ['-o', file], 'screenshot');
      else if (which('import')) await ok('import', ['-window', 'root', file], 'screenshot');
      else throw new Error('screenshot: install grim (Wayland), scrot or ImageMagick (X11)');
      if (which('xdotool')) {
        const g = await run('xdotool', ['getdisplaygeometry']).catch(() => null);
        const m = g && /(\d+)\s+(\d+)/.exec(g.stdout);
        if (m) pointerW = Number(m[1]);
      }
    } else if (process.platform === 'win32') {
      const ps = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$bmp.Save(${psQuote(file)}, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "$($b.Width) $($b.Height)"`;
      const out = await powershell(ps, 'screenshot');
      const m = /(\d+)\s+(\d+)/.exec(out);
      if (m) pointerW = Number(m[1]);
    } else {
      throw new Error(`screenshot: unsupported platform ${process.platform}`);
    }
    const png = await readFile(file);
    const { width, height } = pngSize(png);
    scale = pointerW && pointerW > 0 ? width / pointerW : 1;
    return { pngBase64: png.toString('base64'), width, height };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---- pointer ----------------------------------------------------------------------

const toPointer = (v: number): number => Math.round(v / scale);

export async function click(x: number, y: number, button: 'left' | 'right' | 'middle', double: boolean): Promise<string> {
  const px = toPointer(x); const py = toPointer(y);
  if (process.platform === 'darwin') {
    if (which('cliclick')) {
      const op = double ? 'dc' : button === 'right' ? 'rc' : button === 'middle' ? 'mc' : 'c';
      if (op === 'mc') throw new Error('middle click is not supported by cliclick');
      await ok(cliclickBin(), [`${op}:${px},${py}`], 'click');
    } else {
      if (button !== 'left' || double) throw new Error('right/double click needs cliclick (brew install cliclick); only a plain left click works through System Events');
      await ok('/usr/bin/osascript', ['-e', `tell application "System Events" to click at {${px}, ${py}}`], 'click');
    }
  } else if (process.platform === 'linux') {
    const btn = button === 'right' ? '3' : button === 'middle' ? '2' : '1';
    await ok('xdotool', ['mousemove', String(px), String(py), 'click', ...(double ? ['--repeat', '2', '--delay', '80'] : []), btn], 'click');
  } else if (process.platform === 'win32') {
    const [down, up] = button === 'right' ? ['0x0008', '0x0010'] : button === 'middle' ? ['0x0020', '0x0040'] : ['0x0002', '0x0004'];
    const once = `[U]::mouse_event(${down},0,0,0,0); [U]::mouse_event(${up},0,0,0,0)`;
    await powershell(`${USER32}\n[U]::SetCursorPos(${px}, ${py}) | Out-Null\n${once}${double ? `\nStart-Sleep -Milliseconds 80\n${once}` : ''}`, 'click');
  } else {
    throw new Error(`click: unsupported platform ${process.platform}`);
  }
  return `clicked ${button}${double ? ' twice' : ''} at (${x}, ${y})`;
}

export async function move(x: number, y: number): Promise<string> {
  const px = toPointer(x); const py = toPointer(y);
  if (process.platform === 'darwin') {
    if (!which('cliclick')) throw new Error('moving the pointer needs cliclick (brew install cliclick)');
    await ok(cliclickBin(), [`m:${px},${py}`], 'move');
  } else if (process.platform === 'linux') {
    await ok('xdotool', ['mousemove', String(px), String(py)], 'move');
  } else if (process.platform === 'win32') {
    await powershell(`${USER32}\n[U]::SetCursorPos(${px}, ${py}) | Out-Null`, 'move');
  } else {
    throw new Error(`move: unsupported platform ${process.platform}`);
  }
  return `pointer at (${x}, ${y})`;
}

export async function scroll(x: number, y: number, dx: number, dy: number): Promise<string> {
  const px = toPointer(x); const py = toPointer(y);
  const steps = (n: number) => Math.min(Math.abs(Math.round(n)), 50);
  if (process.platform === 'darwin') {
    // cliclick has no wheel command and System Events cannot scroll: move the
    // pointer (when cliclick is there), then use arrow keys. Best effort.
    if (which('cliclick')) await run(cliclickBin(), [`m:${px},${py}`]).catch(() => null);
    const keys: string[] = [];
    for (let i = 0; i < steps(dy); i++) keys.push(dy > 0 ? '125' : '126');
    for (let i = 0; i < steps(dx); i++) keys.push(dx > 0 ? '124' : '123');
    if (keys.length) await ok('/usr/bin/osascript', ['-e', `tell application "System Events" to ${keys.map((k) => `key code ${k}`).join('\n')}`], 'scroll');
    return `scrolled (${dx}, ${dy}) via arrow keys at (${x}, ${y})`;
  }
  if (process.platform === 'linux') {
    await ok('xdotool', ['mousemove', String(px), String(py)], 'scroll');
    if (steps(dy)) await ok('xdotool', ['click', '--repeat', String(steps(dy)), '--delay', '30', dy > 0 ? '5' : '4'], 'scroll');
    if (steps(dx)) await ok('xdotool', ['click', '--repeat', String(steps(dx)), '--delay', '30', dx > 0 ? '7' : '6'], 'scroll');
    return `scrolled (${dx}, ${dy}) at (${x}, ${y})`;
  }
  if (process.platform === 'win32') {
    const lines = [`${USER32}`, `[U]::SetCursorPos(${px}, ${py}) | Out-Null`];
    if (steps(dy)) lines.push(`[U]::mouse_event(0x0800,0,0,${-Math.round(dy) * 120},0)`);
    if (steps(dx)) lines.push(`[U]::mouse_event(0x1000,0,0,${Math.round(dx) * 120},0)`);
    await powershell(lines.join('\n'), 'scroll');
    return `scrolled (${dx}, ${dy}) at (${x}, ${y})`;
  }
  throw new Error(`scroll: unsupported platform ${process.platform}`);
}

// ---- keyboard ---------------------------------------------------------------------

export async function type(text: string): Promise<string> {
  if (process.platform === 'darwin') {
    // keystroke handles printable text; newlines become return key presses
    const lines = text.split(/\r?\n/);
    const script = lines.map((line, i) => [
      ...(line ? [`keystroke ${appleString(line)}`] : []),
      ...(i < lines.length - 1 ? ['key code 36'] : []),
    ].join('\n')).filter(Boolean).join('\n');
    await ok('/usr/bin/osascript', ['-e', `tell application "System Events"\n${script}\nend tell`], 'type', 120_000);
  } else if (process.platform === 'linux') {
    await ok('xdotool', ['type', '--delay', '12', '--', text], 'type', 120_000);
  } else if (process.platform === 'win32') {
    await powershell(`Add-Type -AssemblyName System.Windows.Forms\n[System.Windows.Forms.SendKeys]::SendWait(${psQuote(sendKeysEscape(text))})`, 'type', 120_000);
  } else {
    throw new Error(`type: unsupported platform ${process.platform}`);
  }
  return `typed ${text.length} characters`;
}

export async function key(combo: string): Promise<string> {
  const parsed = parseCombo(combo);
  if (process.platform === 'darwin') {
    await ok('/usr/bin/osascript', ['-e', `tell application "System Events" to ${appleScriptForKey(parsed)}`], 'key');
  } else if (process.platform === 'linux') {
    await ok('xdotool', ['key', '--clearmodifiers', xdoKey(parsed)], 'key');
  } else if (process.platform === 'win32') {
    await powershell(`Add-Type -AssemblyName System.Windows.Forms\n[System.Windows.Forms.SendKeys]::SendWait(${psQuote(sendKeysFor(parsed))})`, 'key');
  } else {
    throw new Error(`key: unsupported platform ${process.platform}`);
  }
  return `pressed ${combo}`;
}

export interface Combo { mods: Set<'cmd' | 'ctrl' | 'alt' | 'shift'>; key: string }

const MOD_ALIASES: Record<string, 'cmd' | 'ctrl' | 'alt' | 'shift'> = {
  cmd: 'cmd', command: 'cmd', meta: 'cmd', super: 'cmd', win: 'cmd',
  ctrl: 'ctrl', control: 'ctrl',
  alt: 'alt', option: 'alt', opt: 'alt',
  shift: 'shift',
};
const KEY_ALIASES: Record<string, string> = {
  return: 'enter', esc: 'escape', del: 'delete', backspace: 'backspace', bksp: 'backspace', spacebar: 'space', pgup: 'pageup', pgdn: 'pagedown', pgdown: 'pagedown',
  arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right',
};

export function parseCombo(combo: string): Combo {
  const parts = combo.trim().split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error('empty key combo');
  const mods = new Set<'cmd' | 'ctrl' | 'alt' | 'shift'>();
  let k = '';
  for (const p of parts) {
    const low = p.toLowerCase();
    if (MOD_ALIASES[low]) { mods.add(MOD_ALIASES[low]); continue; }
    if (k) throw new Error(`key combo has two keys: "${combo}"`);
    k = KEY_ALIASES[low] ?? (p.length === 1 ? p : low);
  }
  if (!k) throw new Error(`key combo has no key: "${combo}"`);
  return { mods, key: k };
}

/** macOS virtual key codes for the named keys. */
const MAC_KEY_CODES: Record<string, number> = {
  enter: 36, tab: 48, space: 49, delete: 117, backspace: 51, escape: 53, up: 126, down: 125, left: 123, right: 124,
  home: 115, end: 119, pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
};

export function appleScriptForKey(c: Combo): string {
  const using = [...c.mods].map((m) => ({ cmd: 'command down', ctrl: 'control down', alt: 'option down', shift: 'shift down' })[m]);
  const suffix = using.length ? ` using {${using.join(', ')}}` : '';
  if (c.key.length === 1) return `keystroke ${appleString(c.key)}${suffix}`;
  const code = MAC_KEY_CODES[c.key];
  if (code === undefined) throw new Error(`unknown key "${c.key}"`);
  return `key code ${code}${suffix}`;
}

function xdoKey(c: Combo): string {
  const map: Record<string, string> = { enter: 'Return', escape: 'Escape', tab: 'Tab', space: 'space', delete: 'Delete', backspace: 'BackSpace', up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next' };
  const k = map[c.key] ?? (/^f\d{1,2}$/.test(c.key) ? c.key.toUpperCase() : c.key);
  const mods = [...c.mods].map((m) => ({ cmd: 'super', ctrl: 'ctrl', alt: 'alt', shift: 'shift' })[m]);
  return [...mods, k].join('+');
}

function sendKeysFor(c: Combo): string {
  const map: Record<string, string> = { enter: '{ENTER}', escape: '{ESC}', tab: '{TAB}', space: ' ', delete: '{DEL}', backspace: '{BS}', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}', home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}' };
  const k = map[c.key] ?? (/^f\d{1,2}$/.test(c.key) ? `{${c.key.toUpperCase()}}` : sendKeysEscape(c.key));
  const mods = [...c.mods].map((m) => ({ cmd: '', ctrl: '^', alt: '%', shift: '+' })[m]).join('');
  if (c.mods.has('cmd')) throw new Error('the Windows key cannot be sent through SendKeys');
  return `${mods}${k}`;
}

function sendKeysEscape(s: string): string {
  return s.replace(/[+^%~(){}[\]]/g, (ch) => `{${ch}}`);
}

// ---- helpers -----------------------------------------------------------------------

function cliclickBin(): string {
  for (const p of ['/opt/homebrew/bin/cliclick', '/usr/local/bin/cliclick']) if (existsSync(p)) return p;
  return 'cliclick';
}

/** An AppleScript string literal. */
export function appleString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

const USER32 = `Add-Type -Name U -Namespace W -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, int extra);'
$null = [W.U]`.replace('[W.U]', '[W.U]') + '\nSet-Alias -Name U -Value W.U -ErrorAction SilentlyContinue';

async function powershell(script: string, what: string, timeoutMs = 30_000): Promise<string> {
  // The alias trick does not work for static calls; rewrite [U]:: to the real type.
  const body = script.replace(/\[U\]::/g, '[W.U]::');
  const encoded = Buffer.from(body, 'utf16le').toString('base64');
  return ok('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], what, timeoutMs);
}

export { execFile };
