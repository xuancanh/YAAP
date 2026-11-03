/**
 * The JSON-Schema subset the plugin mechanism speaks (docs/plugins.md §3.3):
 * interface inputs and outputs, change-kind `bind` fields and `settings`.
 * Data only — no `$ref` to anything outside the interface, no formats that
 * run code, bounded depth. Two `$ref` forms are understood:
 *
 *   `#resource`      the interface's resource schema (a resource URI)
 *   `#/defs/<name>`  a named schema in the interface's `defs`
 *
 * `checkSchema` validates a schema's own shape (at install); `validate`
 * checks a value against one (at run time and in conformance). Pure.
 */

export type JsonSchema = Record<string, unknown>;

export interface SchemaRefs {
  resource?: JsonSchema;
  defs?: Record<string, JsonSchema>;
}

const SCHEMA_KEYS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'pattern',
  'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'description', 'title',
  'default', '$ref', 'oneOf', 'anyOf', 'examples', 'format',
]);
const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const MAX_DEPTH = 12;

/** Problems with a schema's own shape; [] when it is usable. */
export function checkSchema(schema: unknown, path = '', depth = 0, defs?: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (depth > MAX_DEPTH) return [`${path || '(schema)'}: nested deeper than ${MAX_DEPTH}`];
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [`${path || '(schema)'}: a schema must be an object`];
  const s = schema as JsonSchema;
  for (const k of Object.keys(s)) if (!SCHEMA_KEYS.has(k)) out.push(`${path}/${k}: unknown schema keyword`);
  if (s.type !== undefined) {
    const ts = Array.isArray(s.type) ? s.type : [s.type];
    if (ts.length === 0 || !ts.every((t) => typeof t === 'string' && TYPES.has(t))) out.push(`${path}/type: must be one of ${[...TYPES].join(', ')}`);
  }
  if (s.$ref !== undefined) {
    if (typeof s.$ref !== 'string') out.push(`${path}/$ref: must be a string`);
    else if (s.$ref !== '#resource' && !/^#\/defs\/[A-Za-z][A-Za-z0-9_]{0,40}$/.test(s.$ref)) out.push(`${path}/$ref: only #resource and #/defs/<name> are allowed`);
    else if (s.$ref.startsWith('#/defs/') && defs && !(s.$ref.slice(7) in defs)) out.push(`${path}/$ref: no def named ${s.$ref.slice(7)}`);
  }
  if (s.pattern !== undefined) {
    if (typeof s.pattern !== 'string' || s.pattern.length > 500) out.push(`${path}/pattern: must be a string of at most 500 characters`);
    else { try { new RegExp(s.pattern); } catch { out.push(`${path}/pattern: not a valid regular expression`); } }
  }
  if (s.required !== undefined && (!Array.isArray(s.required) || !s.required.every((x) => typeof x === 'string'))) out.push(`${path}/required: must be a list of names`);
  if (s.enum !== undefined && (!Array.isArray(s.enum) || s.enum.length === 0 || s.enum.length > 200)) out.push(`${path}/enum: must be a non-empty list of at most 200 values`);
  for (const k of ['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems']) {
    if (s[k] !== undefined && (typeof s[k] !== 'number' || !Number.isFinite(s[k]))) out.push(`${path}/${k}: must be a number`);
  }
  if (s.properties !== undefined) {
    if (!s.properties || typeof s.properties !== 'object' || Array.isArray(s.properties)) out.push(`${path}/properties: must be an object`);
    else for (const [k, v] of Object.entries(s.properties as Record<string, unknown>)) out.push(...checkSchema(v, `${path}/properties/${k}`, depth + 1, defs));
  }
  if (s.additionalProperties !== undefined && typeof s.additionalProperties !== 'boolean') out.push(...checkSchema(s.additionalProperties, `${path}/additionalProperties`, depth + 1, defs));
  if (s.items !== undefined) out.push(...checkSchema(s.items, `${path}/items`, depth + 1, defs));
  for (const k of ['oneOf', 'anyOf']) {
    if (s[k] === undefined) continue;
    if (!Array.isArray(s[k]) || (s[k] as unknown[]).length === 0) out.push(`${path}/${k}: must be a non-empty list`);
    else (s[k] as unknown[]).forEach((x, i) => out.push(...checkSchema(x, `${path}/${k}/${i}`, depth + 1, defs)));
  }
  return out;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(t: string, actual: string): boolean {
  return t === actual || (t === 'number' && actual === 'integer');
}

/** Errors for `value` against `schema`; [] when it conforms. */
export function validate(value: unknown, schema: JsonSchema | undefined, refs: SchemaRefs = {}, path = '$', depth = 0): string[] {
  if (!schema) return [];
  if (depth > MAX_DEPTH * 2) return [`${path}: nested too deep`];
  if (typeof schema.$ref === 'string') {
    const target = schema.$ref === '#resource' ? refs.resource : refs.defs?.[schema.$ref.slice(7)];
    if (!target) return [`${path}: unresolved ${schema.$ref}`];
    return validate(value, target, refs, path, depth + 1);
  }
  const out: string[] = [];
  const actual = typeOf(value);
  if (schema.type !== undefined) {
    const ts = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[];
    if (!ts.some((t) => typeMatches(t, actual))) return [`${path}: expected ${ts.join(' or ')}, got ${actual}`];
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) out.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) out.push(`${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) out.push(`${path}: shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) out.push(`${path}: longer than ${schema.maxLength}`);
    if (typeof schema.pattern === 'string') {
      let ok: boolean;
      try { ok = new RegExp(schema.pattern).test(value); } catch { ok = false; }
      if (!ok) out.push(`${path}: does not match ${schema.pattern}`);
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) out.push(`${path}: below ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) out.push(`${path}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) out.push(`${path}: fewer than ${schema.minItems} items`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) out.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items && typeof schema.items === 'object') value.forEach((x, i) => out.push(...validate(x, schema.items as JsonSchema, refs, `${path}[${i}]`, depth + 1)));
  }
  if (actual === 'object') {
    const o = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const r of (Array.isArray(schema.required) ? schema.required : []) as string[]) if (o[r] === undefined) out.push(`${path}.${r}: required`);
    for (const [k, v] of Object.entries(o)) {
      if (v === undefined) continue;
      if (props[k]) out.push(...validate(v, props[k], refs, `${path}.${k}`, depth + 1));
      else if (schema.additionalProperties === false) out.push(`${path}.${k}: not allowed`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') out.push(...validate(v, schema.additionalProperties as JsonSchema, refs, `${path}.${k}`, depth + 1));
    }
  }
  for (const k of ['oneOf', 'anyOf'] as const) {
    const alts = schema[k];
    if (!Array.isArray(alts)) continue;
    const passing = alts.filter((a) => validate(value, a as JsonSchema, refs, path, depth + 1).length === 0).length;
    if (k === 'anyOf' ? passing === 0 : passing !== 1) out.push(`${path}: must match ${k === 'anyOf' ? 'at least one' : 'exactly one'} alternative`);
  }
  return out;
}

/** The names of input properties whose schema is the interface's resource. */
export function resourceFields(schema: JsonSchema | undefined): string[] {
  const props = (schema?.properties ?? {}) as Record<string, JsonSchema>;
  return Object.entries(props).filter(([, s]) => s && s.$ref === '#resource').map(([k]) => k);
}
