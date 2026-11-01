/**
 * ComputerService — desktop computer control through one paired companion
 * (docs/computer-control.md). This is the deliberate, controlled hole in the
 * "agents have no host" isolation story (docs/security.md §c), and every
 * line here exists to keep the hole the shape the user chose:
 *
 *  - The server never reaches into the user's machine. The companion
 *    (companion/) connects OUTBOUND and long-polls `GET /api/computer/work`;
 *    nothing listens on the user's side. Pairing is a 10-minute code minted
 *    in Settings → Computer; it binds exactly one companion, which receives a
 *    long random bearer token we store only as a sha256.
 *  - Scopes (screen / input / shell / files:<dir>) are chosen on the
 *    companion at pair time and can only be narrowed here. Every action is
 *    scope-checked server-side before it is queued AND again on the
 *    companion. Two gates, neither trusting the other.
 *  - Every computer tool is Ask-gated — never auto-run, even in Auto mode;
 *    never from a loop or channel turn (turn-loop.service.ts denies and
 *    writes an inbox event); the acting tools (click/type/key/shell/write)
 *    can never be remembered as "always allow".
 *  - Every action — executed, failed, timed out, or refused — writes a
 *    `computer_actions` audit row. The table is the record; Settings lists
 *    the last 50.
 *  - Kill switches: Pause (pairing kept, actions refused), Disconnect (token
 *    revoked at once, in-flight actions refused) and the server env
 *    COMPUTER_CONTROL_ENABLED=false (tools vanish, companion traffic 403s).
 *
 * The work queue is in-process (like the approval registry): a queued action
 * waits for the companion's next poll, the result settles the awaiting tool
 * call, and a deadline (60 s; shell up to 300 s) turns silence into an error.
 */
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { computerActions, computerRunners } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { unscoped } from '../accounts/scoped-db';
import { StorageService } from '../storage/storage.service';
import { workspaceFileKey } from '../storage/storage.keys';
import { AiToolSpec } from '../ai/ai-provider.interface';
import {
  COMPUTER_TOOLS, ComputerTool, TOOL_SCOPE, fileRoots, isComputerTool, isNarrowing, parseScopes, scopeDenial, summarizeInput,
} from './computer-scopes';

const PAIR_TTL_MS = 10 * 60_000;
/** Wrong guesses that burn a pairing code (8 hex chars = 32 bits; this makes
 *  brute force need a fresh code every five tries). */
const PAIR_MAX_FAILURES = 5;
/** A companion that has not polled for this long is "offline": actions fail
 *  fast instead of waiting out the full deadline. */
const ONLINE_WINDOW_MS = 90_000;
const DEFAULT_DEADLINE_MS = 60_000;
const SHELL_DEFAULT_TIMEOUT_S = 60;
const SHELL_MAX_TIMEOUT_S = 300;
/** Grace on top of the shell timeout so the companion's own kill wins. */
const SHELL_GRACE_MS = 15_000;
const OUTPUT_CAP = 64_000;
const MAX_PNG_BYTES = 8_000_000;
const MAX_TYPE_CHARS = 10_000;
const MAX_WRITE_CHARS = 1_000_000;
const AUDIT_SUMMARY_CAP = 300;

export interface ComputerRunnerView {
  id: string;
  name: string;
  platform: string;
  scopes: string[];
  paused: boolean;
  pairedAt: string;
  lastSeenAt: string | null;
  online: boolean;
}

export interface ComputerStatus {
  enabled: boolean;
  runner: ComputerRunnerView | null;
  /** Actions waiting for the companion's next poll. */
  queued: number;
  /** A pairing code is currently valid. */
  pairCodeActive: boolean;
}

/** What the companion receives from GET /work. */
export interface ComputerWorkItem {
  id: string;
  tool: ComputerTool;
  input: Record<string, unknown>;
  /** Milliseconds the companion has before the server gives up. */
  deadlineMs: number;
}

/** What the companion posts to POST /result/:id. */
export interface ComputerResultBody {
  ok: boolean;
  output?: string;
  pngBase64?: string;
  width?: number;
  height?: number;
}

/** One settled action, for the live "Computer" tab (the `computer` TurnEvent). */
export interface ComputerStep {
  callId: string;
  tool: string;
  summary: string;
  status: 'ok' | 'error';
  screenshotPath?: string;
  width?: number;
  height?: number;
  at: string;
  /** Carried to the model as a vision part on the tool result; never serialised to the client. */
  imageBase64?: string;
}

interface Queued {
  item: ComputerWorkItem;
  sessionId: string;
  workspaceId: string;
  runnerId: string;
  resolve: (r: ComputerResultBody) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type RunnerRow = typeof computerRunners.$inferSelect;

const TOOL_SPECS: Record<ComputerTool, Omit<AiToolSpec, 'name'>> = {
  computer_screenshot: {
    description: 'Take a screenshot of the user\'s own computer screen through the paired companion. The image comes back to you and is saved to the workspace files (computer/<chat>/<n>.png). Approval-gated: the user sees and approves every call.',
    inputSchema: { type: 'object', properties: {} },
  },
  computer_click: {
    description: 'Click at screen coordinates (pixels from the top-left of the main display, as shown in the latest screenshot) on the user\'s computer. Approval-gated on every call.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' }, y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default left' },
        double: { type: 'boolean', description: 'Double-click' },
      },
      required: ['x', 'y'],
    },
  },
  computer_type: {
    description: 'Type literal text on the user\'s computer at the current focus. Approval-gated on every call; the user sees the text before it is typed.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: MAX_TYPE_CHARS } }, required: ['text'] },
  },
  computer_key: {
    description: 'Press a key or key combination on the user\'s computer, e.g. "enter", "escape", "cmd+s", "ctrl+shift+t", "alt+tab". Approval-gated on every call.',
    inputSchema: { type: 'object', properties: { combo: { type: 'string', maxLength: 64 } }, required: ['combo'] },
  },
  computer_move: {
    description: 'Move the mouse pointer to screen coordinates on the user\'s computer without clicking.',
    inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
  },
  computer_scroll: {
    description: 'Scroll at screen coordinates on the user\'s computer. dy > 0 scrolls down, dx > 0 scrolls right; units are scroll steps.',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, dx: { type: 'number' }, dy: { type: 'number' } },
      required: ['x', 'y', 'dx', 'dy'],
    },
  },
  computer_shell: {
    description: `Run a shell command on the user's computer through the paired companion, in the user's own shell with their permissions, and return the output (bounded to 64 KB). Approval-gated on every call — the user reads the exact command before it runs and it can never be auto-approved. Default timeout ${SHELL_DEFAULT_TIMEOUT_S}s, max ${SHELL_MAX_TIMEOUT_S}s.`,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line, exactly as it will be run' },
        cwd: { type: 'string', description: 'Absolute working directory (default: the user\'s home)' },
        timeoutSec: { type: 'number', description: `1-${SHELL_MAX_TIMEOUT_S}` },
      },
      required: ['command'],
    },
  },
  computer_read_file: {
    description: 'Read a text file on the user\'s computer by absolute path. Only paths inside the folders the user granted at pairing (files:<dir> scopes) are allowed; symlinks that lead outside are refused. Output is bounded to 64 KB.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  computer_write_file: {
    description: 'Write (create or replace) a text file on the user\'s computer by absolute path, inside a granted folder only. Approval-gated on every call and never auto-approved; the user sees the full content first.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string', maxLength: MAX_WRITE_CHARS } }, required: ['path', 'content'] },
  },
  computer_list_dir: {
    description: 'List a directory on the user\'s computer by absolute path, inside a granted folder only.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
};

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

@Injectable()
export class ComputerService {
  private pairCode: { code: string; expires: number; failures: number } | null = null;
  private readonly queue: Queued[] = [];
  private readonly inflight = new Map<string, Queued>();
  private readonly waiters: Array<() => void> = [];
  private readonly lastStep = new Map<string, ComputerStep>();
  private readonly shotCounter = new Map<string, number>();
  /** Test seam: `now` for the pair-code and online clocks. */
  now: () => number = () => Date.now();
  /** Test seam: action deadlines (ms). */
  deadlines = { default: DEFAULT_DEADLINE_MS, shellGrace: SHELL_GRACE_MS };

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly config: ConfigService,
    private readonly storage: StorageService,
  ) {}

  /** The server-side kill switch. */
  enabled(): boolean {
    const v = this.config.get<boolean | string>('computerControlEnabled');
    return v === undefined ? true : v === true || v === 'true';
  }

  // ---- pairing (Settings → Computer) ------------------------------------

  mintPairCode(): { code: string; expiresInSeconds: number } {
    this.assertEnabled();
    const code = randomBytes(4).toString('hex');
    this.pairCode = { code, expires: this.now() + PAIR_TTL_MS, failures: 0 };
    return { code, expiresInSeconds: PAIR_TTL_MS / 1000 };
  }

  /** The companion redeems the code. Pairing replaces any existing runner —
   *  the user minted the code in the app, which is the explicit act — and
   *  the old token stops working at once. */
  async pair(input: { code: string; name: string; platform: string; scopes: unknown }): Promise<{ runnerId: string; token: string; scopes: string[] }> {
    this.assertEnabled();
    const pc = this.pairCode;
    const presented = String(input.code ?? '').trim().toLowerCase();
    if (!pc || this.now() >= pc.expires) {
      this.pairCode = null;
      throw new UnauthorizedException('no active pairing code — mint one in Settings → Computer');
    }
    if (presented.length !== pc.code.length || !timingSafeEqual(Buffer.from(presented), Buffer.from(pc.code))) {
      pc.failures += 1;
      if (pc.failures >= PAIR_MAX_FAILURES) this.pairCode = null;
      throw new UnauthorizedException('invalid pairing code');
    }
    const scopes = parseScopes(input.scopes); // plain Error → the controller answers 400
    this.pairCode = null;
    const token = `ycr_${randomBytes(32).toString('hex')}`;
    const id = newId();
    const name = String(input.name ?? '').trim().slice(0, 80) || 'companion';
    const platform = String(input.platform ?? '').trim().slice(0, 20);
    await this.revokeAll('pairing replaced the companion');
    await this.db.insert(computerRunners).values({
      id, name, platform, scopes: JSON.stringify(scopes), tokenHash: sha256Hex(token), paused: 0, pairedAt: nowIso(), lastSeenAt: nowIso(),
    });
    return { runnerId: id, token, scopes };
  }

  /** The companion's bearer → its runner row, or 401. Constant-time on the
   *  hash; the only thing stored is the sha256. */
  async authenticateCompanion(authorization: string | undefined): Promise<RunnerRow> {
    if (!this.enabled()) throw new UnauthorizedException('computer control is disabled on this server');
    const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
    if (!m) throw new UnauthorizedException('missing companion token');
    const presented = sha256Hex(m[1]);
    // Unscoped on purpose: no account is bound on the companion routes; the
    // runner row found by its token hash says which account the companion
    // belongs to, and CompanionGuard binds it (docs/accounts.md §3).
    const row = (await unscoped(this.db).select().from(computerRunners).where(eq(computerRunners.tokenHash, presented)).limit(1)).at(0);
    if (!row || row.tokenHash.length !== presented.length || !timingSafeEqual(Buffer.from(row.tokenHash), Buffer.from(presented))) {
      throw new UnauthorizedException('unknown companion token');
    }
    return row;
  }

  async status(): Promise<ComputerStatus> {
    const row = await this.runner();
    return {
      enabled: this.enabled(),
      runner: row ? this.view(row) : null,
      queued: this.queue.length,
      pairCodeActive: Boolean(this.pairCode && this.now() < this.pairCode.expires),
    };
  }

  async pause(): Promise<ComputerStatus> {
    const row = await this.runner();
    if (row) await this.db.update(computerRunners).set({ paused: 1 }).where(eq(computerRunners.id, row.id));
    return this.status();
  }

  async resume(): Promise<ComputerStatus> {
    const row = await this.runner();
    if (row) await this.db.update(computerRunners).set({ paused: 0 }).where(eq(computerRunners.id, row.id));
    return this.status();
  }

  /** Revoke the token now: the row goes, queued and in-flight actions are
   *  refused, the companion's next poll gets 401. */
  async disconnect(): Promise<ComputerStatus> {
    await this.revokeAll('the companion was disconnected');
    this.pairCode = null;
    return this.status();
  }

  /** Narrow the scope set. Widening is refused: scopes are the owner's
   *  decision made at the keyboard, and the server has no business adding. */
  async narrowScopes(next: unknown): Promise<ComputerStatus> {
    const row = await this.runner();
    if (!row) throw new Error('no companion is paired');
    const parsed = parseScopes(next);
    const current = scopesOf(row);
    if (!isNarrowing(current, parsed)) throw new Error('scopes can only be narrowed from the server — re-pair the companion to widen them');
    await this.db.update(computerRunners).set({ scopes: JSON.stringify(parsed) }).where(eq(computerRunners.id, row.id));
    return this.status();
  }

  async actions(limit = 50) {
    return this.db.select().from(computerActions).orderBy(desc(computerActions.createdAt)).limit(Math.min(Math.max(limit, 1), 200));
  }

  // ---- the tool surface (turn loop) ---------------------------------------

  owns(name: string): boolean {
    return isComputerTool(name);
  }

  /** Every computer tool acts on, or reads from, the user's machine: never
   *  read-only for the policy, so Ask mode always pauses. */
  isReadOnly(name: string): boolean | undefined {
    return this.owns(name) ? false : undefined;
  }

  /** Tools exist only when the switch is on, a companion is paired and not
   *  paused, and the scope covers them — the model is never offered a tool
   *  that cannot run. */
  async specs(): Promise<AiToolSpec[]> {
    if (!this.enabled()) return [];
    const row = await this.runner();
    if (!row || row.paused) return [];
    const scopes = scopesOf(row);
    const roots = fileRoots(scopes);
    return COMPUTER_TOOLS.filter((t) => {
      const kind = TOOL_SCOPE[t];
      return kind === 'files' ? roots.length > 0 : scopes.includes(kind);
    }).map((name) => {
      const spec = TOOL_SPECS[name];
      const description = TOOL_SCOPE[name] === 'files'
        ? `${spec.description} Granted folders: ${roots.join(', ')}.`
        : spec.description;
      return { name, description, inputSchema: spec.inputSchema };
    });
  }

  /** Queue one action for the companion and wait for its result. Called by
   *  the turn loop only after the Ask gate said yes. */
  async execute(session: { id: string; workspaceId: string }, name: string, input: Record<string, unknown>): Promise<string> {
    if (!isComputerTool(name)) throw new Error(`unknown tool: ${name}`);
    const summary = summarizeInput(name, input);
    const row = await this.runner();
    const refuse = async (reason: string): Promise<never> => {
      await this.audit({ runnerId: row?.id ?? '', sessionId: session.id, tool: name, inputSummary: summary, status: 'refused', resultSummary: reason });
      this.lastStep.set(session.id, { callId: '', tool: name, summary, status: 'error', at: nowIso() });
      throw new Error(reason);
    };
    if (!this.enabled()) return refuse('computer control is disabled on this server (COMPUTER_CONTROL_ENABLED=false)');
    if (!row) return refuse('no companion is paired — the user pairs one in Settings → Computer');
    if (row.paused) return refuse('computer control is paused by the user (Settings → Computer)');
    const denial = scopeDenial(scopesOf(row), name, input);
    if (denial) return refuse(`out of scope: ${denial}`);
    const clean = this.validateInput(name, input);
    if (!this.isOnline(row)) return refuse(`the companion "${row.name}" is not connected (last seen ${row.lastSeenAt ?? 'never'}) — start it with: yaam-companion run`);

    const deadlineMs = name === 'computer_shell'
      ? (Number(clean.timeoutSec) * 1000) + this.deadlines.shellGrace
      : this.deadlines.default;
    const id = newId();
    await this.audit({ id, runnerId: row.id, sessionId: session.id, tool: name, inputSummary: summary, status: 'queued' });

    let result: ComputerResultBody;
    try {
      result = await new Promise<ComputerResultBody>((resolve, reject) => {
        const q: Queued = {
          item: { id, tool: name, input: clean, deadlineMs },
          sessionId: session.id, workspaceId: session.workspaceId, runnerId: row.id,
          resolve, reject,
          timer: setTimeout(() => {
            this.drop(id);
            void this.settle(id, 'timeout', `no result within ${Math.round(deadlineMs / 1000)}s`);
            reject(new Error(`the companion did not answer within ${Math.round(deadlineMs / 1000)}s`));
          }, deadlineMs),
        };
        q.timer.unref?.();
        this.queue.push(q);
        this.wake();
      });
    } catch (err) {
      this.lastStep.set(session.id, { callId: '', tool: name, summary, status: 'error', at: nowIso() });
      throw err;
    }

    const output = String(result.output ?? '').slice(0, OUTPUT_CAP);
    const step: ComputerStep = { callId: '', tool: name, summary, status: result.ok ? 'ok' : 'error', at: nowIso() };
    let text = output;
    if (result.ok && name === 'computer_screenshot' && result.pngBase64) {
      const png = Buffer.from(result.pngBase64, 'base64');
      if (png.length > MAX_PNG_BYTES) {
        await this.settle(id, 'error', 'screenshot too large');
        throw new Error('screenshot too large (over 8 MB)');
      }
      const n = (this.shotCounter.get(session.id) ?? await this.countShots(session)) + 1;
      this.shotCounter.set(session.id, n);
      const path = `computer/${session.id}/${n}.png`;
      await this.storage.put(workspaceFileKey(session.workspaceId, path), png, 'image/png');
      step.screenshotPath = path;
      step.width = result.width; step.height = result.height;
      step.imageBase64 = result.pngBase64;
      text = `Screenshot taken${result.width && result.height ? ` (${result.width}×${result.height})` : ''}; the image is attached to this result and saved to ${path} in the workspace files.${output ? `\n${output}` : ''}`;
    }
    this.lastStep.set(session.id, step);
    await this.settle(id, result.ok ? 'ok' : 'error', text, step.screenshotPath);
    if (!result.ok) throw new Error(output || 'the companion reported a failure');
    return text || '(no output)';
  }

  /** The turn loop takes the step after execute() to emit the `computer`
   *  TurnEvent and attach the screenshot to the model's tool result. */
  takeStep(sessionId: string, callId: string): ComputerStep | undefined {
    const s = this.lastStep.get(sessionId);
    this.lastStep.delete(sessionId);
    return s ? { ...s, callId } : undefined;
  }

  // ---- the companion channel ------------------------------------------------

  /** Long poll: the next queued action, or null after `waitMs` of quiet. Also
   *  the heartbeat: every poll stamps lastSeenAt. */
  async nextWork(runner: RunnerRow, waitMs: number): Promise<ComputerWorkItem | null> {
    await this.touch(runner.id);
    const take = () => {
      const idx = this.queue.findIndex((q) => q.runnerId === runner.id);
      if (idx < 0) return null;
      const [q] = this.queue.splice(idx, 1);
      this.inflight.set(q.item.id, q);
      return q.item;
    };
    const immediate = take();
    if (immediate) return immediate;
    await new Promise<void>((resolve) => {
      let done = false;
      const fire = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const i = this.waiters.indexOf(fire);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve();
      };
      const timer = setTimeout(fire, Math.max(0, waitMs));
      timer.unref?.();
      this.waiters.push(fire);
    });
    return take();
  }

  /** The companion posts a result; the awaiting tool call settles. Unknown
   *  or already-settled ids (timeout, disconnect) are reported, not
   *  honoured. */
  submitResult(runner: RunnerRow, actionId: string, body: ComputerResultBody): { accepted: boolean } {
    const q = this.inflight.get(actionId);
    if (!q || q.runnerId !== runner.id) return { accepted: false };
    clearTimeout(q.timer);
    this.inflight.delete(actionId);
    q.resolve({
      ok: Boolean(body.ok),
      output: typeof body.output === 'string' ? body.output.slice(0, OUTPUT_CAP) : '',
      pngBase64: typeof body.pngBase64 === 'string' ? body.pngBase64 : undefined,
      width: typeof body.width === 'number' ? body.width : undefined,
      height: typeof body.height === 'number' ? body.height : undefined,
    });
    return { accepted: true };
  }

  async heartbeat(runner: RunnerRow): Promise<{ ok: true; paused: boolean; scopes: string[] }> {
    await this.touch(runner.id);
    const fresh = await this.runner();
    return { ok: true, paused: Boolean(fresh?.paused), scopes: fresh ? scopesOf(fresh) : [] };
  }

  // ---- internals -------------------------------------------------------------

  private assertEnabled(): void {
    if (!this.enabled()) throw new Error('computer control is disabled on this server (COMPUTER_CONTROL_ENABLED=false)');
  }

  private async runner(): Promise<RunnerRow | null> {
    const rows = await this.db.select().from(computerRunners).limit(1);
    return rows[0] ?? null;
  }

  private view(row: RunnerRow): ComputerRunnerView {
    return {
      id: row.id, name: row.name, platform: row.platform, scopes: scopesOf(row), paused: Boolean(row.paused),
      pairedAt: row.pairedAt, lastSeenAt: row.lastSeenAt, online: this.isOnline(row),
    };
  }

  private isOnline(row: RunnerRow): boolean {
    return Boolean(row.lastSeenAt) && this.now() - Date.parse(row.lastSeenAt!) < ONLINE_WINDOW_MS;
  }

  private async touch(runnerId: string): Promise<void> {
    await this.db.update(computerRunners).set({ lastSeenAt: nowIso() }).where(eq(computerRunners.id, runnerId));
  }

  /** Delete every runner row and refuse everything queued or in flight. */
  private async revokeAll(reason: string): Promise<void> {
    await this.db.delete(computerRunners);
    const all = [...this.queue, ...this.inflight.values()];
    this.queue.length = 0;
    this.inflight.clear();
    for (const q of all) {
      clearTimeout(q.timer);
      await this.settle(q.item.id, 'refused', reason);
      q.reject(new Error(`refused: ${reason}`));
    }
  }

  private drop(id: string): void {
    const idx = this.queue.findIndex((q) => q.item.id === id);
    if (idx >= 0) this.queue.splice(idx, 1);
    this.inflight.delete(id);
  }

  /** A new action arrived: release every long-poller to re-check the queue. */
  private wake(): void {
    for (const fn of this.waiters.splice(0)) fn();
  }

  private async countShots(session: { id: string; workspaceId: string }): Promise<number> {
    const prefix = workspaceFileKey(session.workspaceId, `computer/${session.id}/x`).slice(0, -1);
    const existing = await this.storage.list(prefix).catch(() => []);
    return existing.length;
  }

  private async audit(row: { id?: string; runnerId: string; sessionId: string; tool: string; inputSummary: string; status: string; resultSummary?: string }): Promise<void> {
    await this.db.insert(computerActions).values({
      id: row.id ?? newId(),
      runnerId: row.runnerId, sessionId: row.sessionId, tool: row.tool, inputSummary: row.inputSummary.slice(0, AUDIT_SUMMARY_CAP),
      status: row.status, resultSummary: (row.resultSummary ?? '').slice(0, AUDIT_SUMMARY_CAP),
      createdAt: nowIso(), ...(row.status === 'queued' ? {} : { completedAt: nowIso() }),
    }).catch(() => undefined);
  }

  private async settle(id: string, status: 'ok' | 'error' | 'timeout' | 'refused', summary: string, screenshotPath = ''): Promise<void> {
    await this.db.update(computerActions)
      .set({ status, resultSummary: summary.replace(/\s+/g, ' ').slice(0, AUDIT_SUMMARY_CAP), screenshotPath, completedAt: nowIso() })
      .where(eq(computerActions.id, id)).catch(() => undefined);
  }

  /** Shape and bound the model's input before it leaves the server. */
  private validateInput(name: ComputerTool, input: Record<string, unknown>): Record<string, unknown> {
    const num = (k: string) => {
      const v = Number(input[k]);
      if (!Number.isFinite(v)) throw new Error(`invalid arguments: "${k}" must be a number`);
      return Math.round(v);
    };
    const str = (k: string, max: number, required = true) => {
      const v = input[k];
      if (v === undefined || v === null) {
        if (required) throw new Error(`invalid arguments: "${k}" is required`);
        return undefined;
      }
      if (typeof v !== 'string') throw new Error(`invalid arguments: "${k}" must be a string`);
      if (v.length > max) throw new Error(`invalid arguments: "${k}" is longer than ${max} characters`);
      return v;
    };
    switch (name) {
      case 'computer_screenshot': return {};
      case 'computer_click': {
        const button = typeof input.button === 'string' && ['left', 'right', 'middle'].includes(input.button) ? input.button : 'left';
        return { x: num('x'), y: num('y'), button, double: Boolean(input.double) };
      }
      case 'computer_move': return { x: num('x'), y: num('y') };
      case 'computer_scroll': return { x: num('x'), y: num('y'), dx: num('dx'), dy: num('dy') };
      case 'computer_type': {
        const text = str('text', MAX_TYPE_CHARS)!;
        if (!text) throw new Error('invalid arguments: "text" must be non-empty');
        return { text };
      }
      case 'computer_key': {
        const combo = str('combo', 64)!.trim();
        if (!/^[A-Za-z0-9+\- _.,;:/\\[\]'"`~!@#$%^&*()=?<>|{}]+$/.test(combo)) throw new Error('invalid arguments: "combo" has unsupported characters');
        return { combo };
      }
      case 'computer_shell': {
        const command = str('command', 10_000)!;
        if (!command.trim()) throw new Error('invalid arguments: "command" must be non-empty');
        const t = Number(input.timeoutSec);
        const timeoutSec = Math.min(Math.max(Number.isFinite(t) && t > 0 ? Math.floor(t) : SHELL_DEFAULT_TIMEOUT_S, 1), SHELL_MAX_TIMEOUT_S);
        return { command, cwd: str('cwd', 1_000, false) ?? '', timeoutSec };
      }
      case 'computer_read_file':
      case 'computer_list_dir':
        return { path: str('path', 2_000)! };
      case 'computer_write_file':
        return { path: str('path', 2_000)!, content: str('content', MAX_WRITE_CHARS)! };
    }
  }
}

function scopesOf(row: RunnerRow): string[] {
  try {
    const parsed = JSON.parse(row.scopes || '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}
