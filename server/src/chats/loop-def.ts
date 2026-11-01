/**
 * LoopDef — the shape of one entry in `agents.loops` (JSON), shared by the
 * agents domain (validation on save/import) and the loops domain (firing).
 * A loop runs on a cron, on an event trigger, or both (docs/triggers.md).
 */
import { createHash } from 'node:crypto';

export type MailTrigger = {
  kind: 'mail';
  /** 'gmail' = Google, 'msmail' = Microsoft Graph. */
  service: 'gmail' | 'msmail';
  /** Pin to one connection; otherwise the agent's granted connection for
   *  that provider is used. */
  connectionId?: string;
  /** Provider search syntax (Gmail `q`, Graph `$search`). */
  query: string;
  /** Poll period in minutes (default 5, min 2). */
  pollMinutes?: number;
};

export type CalendarTrigger = {
  kind: 'calendar';
  service: 'gcal' | 'mscal';
  connectionId?: string;
  /** Look-ahead window for created/changed detection. */
  withinHours: number;
  on: 'created' | 'changed' | 'starting';
  /** For `starting`: fire when the event begins within this many minutes
   *  (default 15). */
  leadMinutes?: number;
  pollMinutes?: number;
};

export type TaskTrigger = { kind: 'task' };

export type WebhookTrigger = {
  kind: 'webhook';
  /** SHA-256 hex of the shared secret; the plaintext is never stored. */
  secretHash?: string;
};

export type LoopTrigger = MailTrigger | CalendarTrigger | TaskTrigger | WebhookTrigger;

export interface LoopDef {
  name: string;
  cron?: string;
  prompt?: string;
  enabled?: boolean;
  model?: string;
  budgetTokens?: number;
  trigger?: LoopTrigger;
}

export const TRIGGER_KINDS = ['mail', 'calendar', 'task', 'webhook'] as const;

/** Webhook secrets are stored hashed; compare hashes, never plaintext. */
export function hashWebhookSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}
export const MIN_POLL_MINUTES = 2;
export const DEFAULT_POLL_MINUTES = 5;
export const DEFAULT_LEAD_MINUTES = 15;

/** Effective poll period for a polled trigger. */
export function pollMinutesOf(trigger: MailTrigger | CalendarTrigger): number {
  const raw = Number(trigger.pollMinutes);
  return Number.isFinite(raw) && raw > 0 ? Math.max(MIN_POLL_MINUTES, Math.floor(raw)) : DEFAULT_POLL_MINUTES;
}

/** Validate one raw loop (editor JSON or AGENT.json) into a bounded LoopDef.
 *  `fail` throws the caller's exception type. */
export function validateLoopDef(raw: unknown, fail: (msg: string) => never): LoopDef {
  const loop = (raw ?? {}) as Record<string, unknown>;
  if (typeof loop.name !== 'string' || loop.name.length < 1 || loop.name.length > 100) fail('every loop needs a name (≤100 chars)');
  const name = (loop.name as string).trim();
  if (!name || /[/?#]/.test(name)) fail('loop names cannot be blank or contain / ? #');
  if (loop.cron !== undefined && loop.cron !== null && typeof loop.cron !== 'string') fail('cron must be a string');
  const cron = typeof loop.cron === 'string' ? loop.cron.trim() : '';
  if (cron.length > 50) fail('cron must be ≤50 chars');
  if (loop.model !== undefined && (typeof loop.model !== 'string' || loop.model.length > 100)) fail('loop model must be a string (≤100 chars)');
  if (loop.budgetTokens !== undefined && (typeof loop.budgetTokens !== 'number' || loop.budgetTokens < 0 || loop.budgetTokens > 10_000_000)) fail('budgetTokens must be 0..10000000');
  const trigger = loop.trigger === undefined || loop.trigger === null ? undefined : validateTrigger(loop.trigger, fail);
  if (!cron && !trigger) fail(`loop "${name}" needs a cron, a trigger, or both`);
  return {
    name,
    ...(cron ? { cron } : {}),
    ...(typeof loop.prompt === 'string' && loop.prompt ? { prompt: (loop.prompt as string).slice(0, 2_000) } : {}),
    ...(loop.enabled === false ? { enabled: false } : {}),
    ...(typeof loop.model === 'string' && loop.model ? { model: loop.model } : {}),
    ...(typeof loop.budgetTokens === 'number' && loop.budgetTokens > 0 ? { budgetTokens: loop.budgetTokens } : {}),
    ...(trigger ? { trigger } : {}),
  };
}

function validateTrigger(raw: unknown, fail: (msg: string) => never): LoopTrigger {
  const t = (raw ?? {}) as Record<string, unknown>;
  const poll = (): { pollMinutes?: number } => {
    if (t.pollMinutes === undefined) return {};
    if (typeof t.pollMinutes !== 'number' || t.pollMinutes < MIN_POLL_MINUTES || t.pollMinutes > 24 * 60) fail(`pollMinutes must be ${MIN_POLL_MINUTES}..1440`);
    return { pollMinutes: Math.floor(t.pollMinutes as number) };
  };
  const connectionId = (): { connectionId?: string } => {
    if (t.connectionId === undefined || t.connectionId === '') return {};
    if (typeof t.connectionId !== 'string' || t.connectionId.length > 64) fail('connectionId must be a string');
    return { connectionId: t.connectionId as string };
  };
  switch (t.kind) {
    case 'mail': {
      if (t.service !== 'gmail' && t.service !== 'msmail') fail('mail trigger service must be gmail or msmail');
      if (typeof t.query !== 'string' || t.query.length > 500) fail('mail trigger needs a query (≤500 chars)');
      return { kind: 'mail', service: t.service as 'gmail' | 'msmail', query: (t.query as string).trim(), ...connectionId(), ...poll() };
    }
    case 'calendar': {
      if (t.service !== 'gcal' && t.service !== 'mscal') fail('calendar trigger service must be gcal or mscal');
      if (t.on !== 'created' && t.on !== 'changed' && t.on !== 'starting') fail('calendar trigger "on" must be created, changed, or starting');
      const withinHours = Number(t.withinHours);
      if (!Number.isFinite(withinHours) || withinHours < 1 || withinHours > 24 * 30) fail('withinHours must be 1..720');
      let lead: { leadMinutes?: number } = {};
      if (t.leadMinutes !== undefined) {
        if (typeof t.leadMinutes !== 'number' || t.leadMinutes < 1 || t.leadMinutes > 24 * 60) fail('leadMinutes must be 1..1440');
        lead = { leadMinutes: Math.floor(t.leadMinutes as number) };
      }
      return { kind: 'calendar', service: t.service as 'gcal' | 'mscal', on: t.on as 'created' | 'changed' | 'starting', withinHours: Math.floor(withinHours), ...lead, ...connectionId(), ...poll() };
    }
    case 'task':
      return { kind: 'task' };
    case 'webhook': {
      if (t.secretHash !== undefined && (typeof t.secretHash !== 'string' || !/^[0-9a-f]{64}$/.test(t.secretHash))) fail('webhook secretHash must be a sha256 hex');
      return { kind: 'webhook', ...(typeof t.secretHash === 'string' ? { secretHash: t.secretHash } : {}) };
    }
    default:
      return fail(`trigger kind must be one of ${TRIGGER_KINDS.join(', ')}`);
  }
}
