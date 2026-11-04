/**
 * Contributions beyond tools (docs/plugins.md §3.8): the pure half — the
 * rows a manifest's guidance and declarative UI become, who a note or a
 * skill reaches, the bounded and attributed guidance block, and the safe
 * rendering of a UI view from an operation's output (selection only: paths
 * into data, never code).
 */
import { getPath } from './template';
import type { Audience, GuidanceDef, Manifest, UiContributions, UiView } from './manifest';

/** The guidance block's hard ceiling per agent and turn, in characters. */
export const GUIDANCE_BUDGET = 1_200;
/** UI contribution kinds, in the order the registrar writes them. */
export const UI_KINDS = ['card', 'panel', 'page', 'action', 'badge'] as const;
export type UiKind = typeof UI_KINDS[number];

export interface ContributionSpec { kind: 'guidance' | UiKind; key: string; spec: unknown }

/** The registrar rows of a manifest's (or kit's) guidance and UI. */
export function contributionSpecs(src: { guidance?: GuidanceDef[]; ui?: UiContributions }): ContributionSpec[] {
  const out: ContributionSpec[] = [];
  for (const g of src.guidance ?? []) out.push({ kind: 'guidance', key: g.id, spec: g });
  const ui = src.ui ?? {};
  for (const c of ui.cards ?? []) out.push({ kind: 'card', key: c.id, spec: c });
  for (const p of ui.panels ?? []) out.push({ kind: 'panel', key: p.id, spec: p });
  for (const p of ui.pages ?? []) out.push({ kind: 'page', key: p.id, spec: p });
  for (const a of ui.actions ?? []) out.push({ kind: 'action', key: a.id, spec: a });
  for (const b of ui.badges ?? []) out.push({ kind: 'badge', key: b.id, spec: b });
  return out;
}

/** The interfaces a manifest's UI reads or acts on (a contribution shows only while each has a healthy binding). */
export function uiInterfaces(spec: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    const o = v as Record<string, unknown>;
    if (typeof o.operation === 'string' && o.operation.includes('.')) out.add(o.operation.split('.')[0]);
    for (const x of Object.values(o)) walk(x);
  };
  walk(spec);
  return [...out];
}

/** Who is asking, for audience matching. */
export interface Viewer { member: boolean; chief: boolean; head: boolean; functions: string[] }

/** Whether an audience list reaches a viewer. `all` reaches everyone, even outside a company. */
export function audienceReaches(audience: Audience[], v: Viewer): boolean {
  if (audience.length === 0) return true;
  return audience.some((a) => a === 'all'
    || (a === 'members' && v.member)
    || (a === 'chief' && v.chief)
    || (a === 'heads' && (v.head || v.chief))
    || (a.startsWith('function:') && v.functions.includes(a.slice('function:'.length))));
}

export interface GuidanceNote { ownerKind: 'plugin' | 'kit'; ownerId: string; version: string; id: string; title: string; text: string; audience: Audience[] }

/**
 * The guidance block for one agent: each note attributed to the plugin or
 * kit that sent it, whole notes only, within `budget` characters. Notes
 * that do not fit are named, not clipped, so an agent can read them with
 * the foundry tools instead.
 */
export function renderGuidance(notes: GuidanceNote[], budget = GUIDANCE_BUDGET): { text: string; included: GuidanceNote[]; omitted: GuidanceNote[] } {
  if (notes.length === 0) return { text: '', included: [], omitted: [] };
  const head = '# Plugin guidance (from installed plugins and kits; how to use their capabilities)';
  const lines = [head];
  let size = head.length;
  const included: GuidanceNote[] = [];
  const omitted: GuidanceNote[] = [];
  const sorted = [...notes].sort((a, b) => (a.ownerKind === b.ownerKind ? a.ownerId.localeCompare(b.ownerId) || a.id.localeCompare(b.id) : a.ownerKind === 'kit' ? -1 : 1));
  for (const n of sorted) {
    const line = `- ${n.title} [${n.ownerId} ${n.version}]: ${n.text.replace(/\s+/g, ' ').trim()}`;
    if (size + line.length + 1 > budget - 80) { omitted.push(n); continue; }
    lines.push(line);
    size += line.length + 1;
    included.push(n);
  }
  if (omitted.length) lines.push(`(${omitted.length} more note(s) not shown for space: ${omitted.map((n) => `${n.ownerId}#${n.id}`).join(', ').slice(0, 70)})`);
  const text = lines.join('\n');
  return { text: text.length > budget ? `${text.slice(0, budget - 1)}…` : text, included, omitted };
}

/** A skill's workspace name: `<plugin short name>-<skill name>`, unless it already starts with it. */
export function contributedSkillName(ownerId: string, skillName: string): string {
  const short = ownerId.split('@')[0];
  const name = skillName.startsWith(`${short}-`) ? skillName : `${short}-${skillName}`;
  return name.slice(0, 64).replace(/-+$/, '');
}

// ---- rendering a view from data (selection only) ----

export type Tone = 'neutral' | 'good' | 'warn' | 'bad';
export type RenderedView =
  | { kind: 'stats'; items: Array<{ label: string; value: string; unit?: string; tone: Tone }> }
  | { kind: 'table'; columns: string[]; rows: string[][]; more: number }
  | { kind: 'list'; items: Array<{ title: string; subtitle?: string; badge?: string; link?: string }>; more: number }
  | { kind: 'checklist'; items: string[] }
  | { kind: 'text'; value: string };

const MAX_CELL = 200;
function str(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === 'string') return v.slice(0, MAX_CELL);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return JSON.stringify(v).slice(0, MAX_CELL);
}
/** Only http(s) links leave a view; anything else is dropped. */
function safeLink(v: unknown): string | undefined {
  return typeof v === 'string' && /^https?:\/\/[^\s"'<>]+$/.test(v) ? v.slice(0, 500) : undefined;
}

/** Turn an operation's output into the view's rendered form. Text only; the SPA renders it with its own components. */
export function renderView(view: UiView, data: unknown): RenderedView {
  switch (view.kind) {
    case 'stats':
      return {
        kind: 'stats',
        items: view.items.map((it) => {
          let tone: Tone = it.tone ?? 'neutral';
          if (it.toneWhen) {
            const x = getPath(data, it.toneWhen.path);
            if (typeof x === 'number' && ((it.toneWhen.gt !== undefined && x > it.toneWhen.gt) || (it.toneWhen.lt !== undefined && x < it.toneWhen.lt))) tone = it.toneWhen.tone;
          }
          return { label: it.label, value: str(getPath(data, it.value)), ...(it.unit ? { unit: it.unit } : {}), tone };
        }),
      };
    case 'table': {
      const rows = getPath(data, view.rows);
      const list = Array.isArray(rows) ? rows : [];
      const max = view.max ?? 10;
      return { kind: 'table', columns: view.columns.map((c) => c.label), rows: list.slice(0, max).map((r) => view.columns.map((c) => str(getPath(r, c.value)))), more: Math.max(0, list.length - max) };
    }
    case 'list': {
      const items = getPath(data, view.items);
      const list = Array.isArray(items) ? items : [];
      const max = view.max ?? 8;
      return {
        kind: 'list',
        items: list.slice(0, max).map((r) => ({
          title: str(getPath(r, view.title)),
          ...(view.subtitle ? { subtitle: str(getPath(r, view.subtitle)) } : {}),
          ...(view.badge ? { badge: str(getPath(r, view.badge)) } : {}),
          ...(view.link && safeLink(getPath(r, view.link)) ? { link: safeLink(getPath(r, view.link)) } : {}),
        })),
        more: Math.max(0, list.length - max),
      };
    }
    case 'checklist':
      return { kind: 'checklist', items: [...view.items] };
    case 'text':
      return { kind: 'text', value: str(getPath(data, view.value)).slice(0, MAX_CELL) };
  }
}

/** Fill a UI input from the placement context, the action's fields and the install's settings. */
export function fillUiInput(input: Record<string, unknown> | undefined, ctx: { context?: Record<string, unknown>; field?: Record<string, unknown>; settings?: Record<string, unknown> }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    const m = typeof v === 'string' ? /^\{\{\s*(context|field|settings)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/.exec(v) : null;
    if (!m) { out[k] = v; continue; }
    const x = (ctx[m[1] as 'context' | 'field' | 'settings'] ?? {})[m[2]];
    if (x !== undefined && x !== '') out[k] = x;
  }
  return out;
}

/** The defaults a settings schema declares (`properties.<k>.default`). */
export function settingsDefaults(m: Pick<Manifest, 'settings'>): Record<string, unknown> {
  const props = (m.settings as { properties?: Record<string, { default?: unknown }> } | undefined)?.properties ?? {};
  return Object.fromEntries(Object.entries(props).filter(([, p]) => p && p.default !== undefined).map(([k, p]) => [k, p.default]));
}
