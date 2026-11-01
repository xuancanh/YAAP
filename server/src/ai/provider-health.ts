/**
 * ProviderHealthService — provider degradation (docs/incidents.md §4,
 * execution-plan item 29). In memory, per workspace and provider family:
 *
 *  - every provider call that fails with a transient class of error (5xx,
 *    429, overloaded, a timeout, a dropped connection — `isTransientProviderError`)
 *    is counted in a sliding window; `failures` of them inside `windowMs`
 *    mark the provider **degraded** for that workspace;
 *  - while degraded, TurnContextService resolves the next turns to another
 *    enabled agent type of a different provider (same tools, memory and
 *    system prompt; only the model changes) and records `{ from, to }` on
 *    the turn;
 *  - after `cooldownMs` the provider is **probing**: the next turn tries it
 *    again; a success recovers it, a failure re-degrades it at once.
 *
 * The thresholds are the org's tunables (`degrade.providerFailures`,
 * `degrade.windowSeconds`, `degrade.cooldownSeconds`), supplied by the org
 * module through `setThresholds` so this module never imports it; without
 * a resolver the defaults below apply. Every transition is told to the
 * listeners (`onChange`), which write the audit row and the incident.
 * Model-free; nothing here calls a model.
 */
import { Injectable } from '@nestjs/common';

export interface DegradeThresholds { failures: number; windowMs: number; cooldownMs: number }
export const DEFAULT_DEGRADE: DegradeThresholds = { failures: 3, windowMs: 300_000, cooldownMs: 600_000 };

export type ProviderState = 'ok' | 'degraded' | 'probing';
export interface ProviderHealthChange {
  workspaceId: string;
  provider: string;
  state: 'degraded' | 'recovered';
  reason: string;
  failures: number;
  at: string;
}
export interface ProviderHealthView { workspaceId: string; provider: string; state: ProviderState; since: string; until: string | null; failures: number; lastError: string }

interface Entry { failures: number[]; state: ProviderState; since: number; until: number; lastError: string }

/** Adapters of one family share an upstream: an outage of one is an outage of both. */
export function providerFamily(provider: string): string {
  if (provider.startsWith('anthropic')) return 'anthropic';
  if (provider === 'openai' || provider === 'openai-compatible') return 'openai';
  return provider;
}

/** 5xx / 429 / overloaded / timeouts / dropped connections — not a 4xx, not a malformed tool call. */
export function isTransientProviderError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError') return true;
  const msg = err instanceof Error ? err.message : String(err);
  if (/malformed tool arguments|unterminated tool call|token ceiling|budget/i.test(msg)) return false;
  if (/\b(5\d\d|429)\b/.test(msg)) return true;
  return /overloaded|timed? ?out|timeout|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|stream error|service unavailable|bad gateway/i.test(msg);
}

@Injectable()
export class ProviderHealthService {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners: Array<(ev: ProviderHealthChange) => void | Promise<void>> = [];
  private thresholdsFor: (workspaceId: string) => Promise<DegradeThresholds> = async () => DEFAULT_DEGRADE;
  /** Test seam: the clock. */
  now: () => number = () => Date.now();

  /** The org module supplies the per-workspace tunables. */
  setThresholds(fn: (workspaceId: string) => Promise<DegradeThresholds>): void { this.thresholdsFor = fn; }

  onChange(fn: (ev: ProviderHealthChange) => void | Promise<void>): () => void {
    this.listeners.push(fn);
    return () => { const i = this.listeners.indexOf(fn); if (i >= 0) this.listeners.splice(i, 1); };
  }

  private key(workspaceId: string, provider: string): string { return `${workspaceId}:${providerFamily(provider)}`; }

  private emit(ev: ProviderHealthChange): void {
    for (const fn of this.listeners) { try { void Promise.resolve(fn(ev)).catch(() => undefined); } catch { /* listeners isolate their own failures */ } }
  }

  /** Whether turns should avoid this provider now. A degraded provider whose
   *  cooldown has passed turns `probing`: the next turn tries it again. */
  isDegraded(workspaceId: string, provider: string): boolean {
    const e = this.entries.get(this.key(workspaceId, provider));
    if (!e || e.state !== 'degraded') return false;
    if (this.now() >= e.until) { e.state = 'probing'; return false; }
    return true;
  }

  state(workspaceId: string, provider: string): ProviderState {
    this.isDegraded(workspaceId, provider);
    return this.entries.get(this.key(workspaceId, provider))?.state ?? 'ok';
  }

  /** A provider call failed. Non-transient errors are ignored (a bad key is
   *  not an outage). Returns the new state. */
  async recordFailure(workspaceId: string, provider: string, err: unknown): Promise<ProviderState> {
    if (!isTransientProviderError(err)) return this.state(workspaceId, provider);
    const k = this.key(workspaceId, provider);
    const t = await this.thresholdsFor(workspaceId).catch(() => DEFAULT_DEGRADE);
    const now = this.now();
    const e = this.entries.get(k) ?? { failures: [], state: 'ok' as ProviderState, since: now, until: 0, lastError: '' };
    e.lastError = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    e.failures = [...e.failures.filter((at) => now - at < t.windowMs), now];
    this.entries.set(k, e);
    const wasProbing = this.isDegraded(workspaceId, provider) === false && e.state === 'probing';
    if (e.state === 'degraded') return 'degraded';
    if (wasProbing || e.failures.length >= t.failures) {
      e.state = 'degraded'; e.since = now; e.until = now + t.cooldownMs;
      this.emit({ workspaceId, provider: providerFamily(provider), state: 'degraded', reason: wasProbing ? `the recovery probe failed: ${e.lastError}` : `${e.failures.length} transient failure(s) in ${Math.round(t.windowMs / 1000)}s: ${e.lastError}`, failures: e.failures.length, at: new Date(now).toISOString() });
      return 'degraded';
    }
    return e.state;
  }

  /** A provider call succeeded: a probing provider recovers; an ok one forgets old failures. */
  recordSuccess(workspaceId: string, provider: string): void {
    const k = this.key(workspaceId, provider);
    const e = this.entries.get(k);
    if (!e) return;
    if (e.state === 'probing') {
      this.entries.delete(k);
      this.emit({ workspaceId, provider: providerFamily(provider), state: 'recovered', reason: 'the recovery probe succeeded', failures: 0, at: new Date(this.now()).toISOString() });
      return;
    }
    if (e.state === 'ok') this.entries.delete(k);
  }

  /** What is degraded (or probing), optionally for one workspace. */
  list(workspaceId?: string): ProviderHealthView[] {
    const out: ProviderHealthView[] = [];
    for (const [k, e] of this.entries) {
      const i = k.lastIndexOf(':');
      const ws = k.slice(0, i); const provider = k.slice(i + 1);
      if (workspaceId && ws !== workspaceId) continue;
      const state = this.state(ws, provider);
      if (state === 'ok') continue;
      out.push({ workspaceId: ws, provider, state, since: new Date(e.since).toISOString(), until: state === 'degraded' ? new Date(e.until).toISOString() : null, failures: e.failures.length, lastError: e.lastError });
    }
    return out;
  }

  /** Forget everything (tests). */
  reset(): void { this.entries.clear(); }
}
