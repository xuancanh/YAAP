/**
 * The conformance runner (docs/plugins.md §4.4), `mock` mode. A provider
 * runs the interface's suite before it can be bound: every required
 * operation must be implemented, and every case's steps must pass through
 * the same `callProvider` path production calls take (input schema,
 * implementation, output schema), against the provider's own fixtures —
 * never the workspace's real resources.
 *
 * Steps: `op` with an input template (`{{fixtures.repo}}`, `{{run}}`, saved
 * names), `expect` (`schema`, `match` paths, an `error` code), `save` paths;
 * `expectEvent` steps are skipped in mock mode (events arrive with webhook
 * ingress). `test_org` mode needs a test connection and is refused here.
 */
import type { InterfaceDef, Suite } from './manifest';
import { callProvider, ProviderError, type ProviderPackage } from './runtime';
import { getPath, render } from './template';

export interface CaseResult { id: string; ok: boolean; skipped?: boolean; detail?: string }
export interface SuiteResult { result: 'pass' | 'fail' | 'error'; cases: CaseResult[] }

export async function runSuite(p: { iface: InterfaceDef; suite: Suite | undefined; pkg: ProviderPackage; runId: string }): Promise<SuiteResult> {
  const mode = p.pkg.provides.conformance.mode;
  if (mode !== 'mock') return { result: 'error', cases: [{ id: 'mode', ok: false, detail: 'test_org conformance needs a conformance connection (plugins Phase 2); only mock runs in Phase 1' }] };
  if (!p.suite) return { result: 'error', cases: [{ id: 'suite', ok: false, detail: `${p.iface.name}@${p.iface.version} ships no conformance suite` }] };
  const cases: CaseResult[] = [];
  const missing = Object.entries(p.iface.operations).filter(([op, def]) => def.required && !p.pkg.provides.operations[op]).map(([op]) => op);
  cases.push(missing.length > 0
    ? { id: 'required-operations', ok: false, detail: `missing: ${missing.join(', ')}` }
    : { id: 'required-operations', ok: true });
  const params = p.pkg.provides.conformance.params ?? {};
  const fixtures = Object.fromEntries(Object.entries(p.suite.fixtures ?? {}).map(([k, v]) => [k, v.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_m, name: string) => params[name] ?? `{${name}}`)]));
  for (const c of p.suite.cases) {
    const saved: Record<string, unknown> = {};
    let ok = true;
    let detail = '';
    let ran = 0;
    for (const [i, step] of c.steps.entries()) {
      if (step.skipIn?.includes('mock') || step.expectEvent) continue;
      if (!step.op) continue;
      ran += 1;
      const input = render(step.input ?? {}, { fixtures, run: p.runId, ...saved }) as Record<string, unknown>;
      try {
        if (!p.pkg.provides.operations[step.op] && !p.iface.operations[step.op]?.required) continue;
        const out = await callProvider({ iface: p.iface, op: step.op, input, pkg: p.pkg });
        if (step.expect?.error) { ok = false; detail = `step ${i + 1} (${step.op}): expected error ${step.expect.error}, got a result`; break; }
        for (const [path, want] of Object.entries(step.expect?.match ?? {})) {
          const got = getPath(out, path);
          if (JSON.stringify(got) !== JSON.stringify(want)) { ok = false; detail = `step ${i + 1} (${step.op}): ${path} is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`; break; }
        }
        if (!ok) break;
        for (const [name, path] of Object.entries(step.save ?? {})) saved[name] = getPath(out, path);
      } catch (err) {
        const code = err instanceof ProviderError ? err.code : 'error';
        if (step.expect?.error && step.expect.error === code) continue;
        ok = false;
        detail = `step ${i + 1} (${step.op}): ${code}: ${err instanceof Error ? err.message : String(err)}`;
        break;
      }
    }
    cases.push(ran === 0 ? { id: c.id, ok: true, skipped: true, detail: 'every step is skipped in mock mode' } : { id: c.id, ok, ...(detail ? { detail } : {}) });
  }
  return { result: cases.every((x) => x.ok) ? 'pass' : 'fail', cases };
}
