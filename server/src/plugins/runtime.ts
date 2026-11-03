/**
 * The provider execution seam (docs/plugins.md §4.1): one function the
 * dispatcher and the conformance runner both call, so conformance runs
 * "through the same dispatcher and executor that production calls use".
 *
 * Phase 1 executes one implementation kind, the core's **fixture stub**
 * (`{ fixture: "<file>" }`): deterministic request/response data, matched
 * by declarative `when` paths and rendered from the input. No code runs
 * and nothing leaves the process. The other kinds are recognised and
 * refused with the phase that brings them: HTTP templates need the egress
 * proxy, MCP-backed operations the pinned re-listing, out-of-process code
 * an execution environment, delegation the adapter path.
 *
 * Inputs are validated against the interface's input schema before the
 * provider sees them, and outputs against its output schema after (a
 * non-conforming output is an error, T10). Provider code receives the
 * operation's input and nothing else (§5.7 rule 2).
 */
import type { Fixtures, InterfaceDef, OperationImpl, ProvidesDef } from './manifest';
import { validate, type SchemaRefs } from './json-schema';
import { matchWhen, render } from './template';

export class ProviderError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface ProviderPackage {
  provides: ProvidesDef;
  fixtures: Record<string, Fixtures>;
}

export function refsOf(iface: InterfaceDef): SchemaRefs {
  return { resource: iface.resources.schema, defs: iface.defs };
}

/** Run one implementation. Throws ProviderError on a provider-side error. */
export async function runImpl(impl: OperationImpl, op: string, input: Record<string, unknown>, pkg: ProviderPackage, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) throw new ProviderError('cancelled', 'the call was stopped');
  if ('fixture' in impl) {
    const file = pkg.fixtures[impl.fixture];
    const cases = file?.operations[op];
    if (!cases) throw new ProviderError('not_implemented', `the fixture file ${impl.fixture} has no cases for ${op}`);
    const hit = cases.find((c) => matchWhen(c.when, input));
    if (!hit) throw new ProviderError('no_fixture', `no fixture case of ${op} matches this input`);
    if (hit.error) throw new ProviderError(hit.error.code, hit.error.message);
    return render(hit.output, { input });
  }
  if ('http' in impl) throw new ProviderError('unsupported', 'HTTP templates execute through the egress proxy, which ships with the first vendor provider (plugins Phase 3)');
  if ('mcp' in impl) throw new ProviderError('unsupported', 'MCP-backed operations need pinned re-listing (plugins Phase 2)');
  if ('runtime' in impl) throw new ProviderError('unsupported', 'out-of-process provider code needs an execution environment (plugins Phase 3)');
  throw new ProviderError('unsupported', 'adapter delegation arrives with interface majors side by side (later phase)');
}

/**
 * Call a provider's implementation of one interface operation: input
 * schema, implementation, output schema. The only path to a provider.
 */
export async function callProvider(p: { iface: InterfaceDef; op: string; input: Record<string, unknown>; pkg: ProviderPackage; signal?: AbortSignal }): Promise<unknown> {
  const def = p.iface.operations[p.op];
  if (!def) throw new ProviderError('unknown_operation', `${p.iface.name} has no operation ${p.op}`);
  const impl = p.pkg.provides.operations[p.op];
  if (!impl) throw new ProviderError('not_implemented', `the provider does not implement ${p.iface.name}.${p.op}`);
  const refs = refsOf(p.iface);
  const inErr = validate(p.input, def.input, refs);
  if (inErr.length > 0) throw new ProviderError('invalid_input', `the input does not match ${p.iface.name}.${p.op}: ${inErr.slice(0, 5).join('; ')}`);
  const out = await runImpl(impl, p.op, p.input, p.pkg, p.signal);
  const outErr = validate(out, def.output, refs);
  if (outErr.length > 0) throw new ProviderError('invalid_output', `the provider's output does not match ${p.iface.name}.${p.op}: ${outErr.slice(0, 5).join('; ')}`);
  return out;
}
