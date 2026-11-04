/**
 * Declarative UI from plugins (docs/plugins.md §3.8): the extension points
 * the SPA renders with its own components — section dashboard cards,
 * task / project / agent panels, plugin pages listed on a section
 * dashboard, badges, and actions (buttons) — from data a `read` operation
 * returns. No plugin code runs in the app: a view is a selection of paths
 * into an operation's output, and a button invokes an interface operation
 * through the dispatcher's policy stage (`uiCall`).
 *
 * A contribution shows only while every interface it reads or acts on has
 * a healthy bound provider; otherwise it is listed as waiting, with what it
 * waits on.
 */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { actorId } from '../accounts/account-context';
import { PluginsService, type ContributionRow } from './plugins.service';
import { InterfaceDispatcher, UiRefused } from './dispatcher';
import { fillUiInput, renderView, settingsDefaults, type RenderedView } from './contributions';
import type { UiAction, UiBadge, UiCard, UiPage, UiPanel, UiQuery, UiView } from './manifest';

export interface UiItem {
  id: string; kind: string; key: string; pluginId: string; version: string;
  ready: boolean; waitingOn: string[]; spec: Record<string, unknown>;
}

@Injectable()
export class PluginUiService {
  constructor(private readonly plugins: PluginsService, private readonly dispatcher: InterfaceDispatcher) {}

  /** Every UI contribution for a placement (a section, or task/project/agent), with the actions they name. */
  async list(workspaceId: string, placement?: string): Promise<{ items: UiItem[]; actions: UiItem[] }> {
    const rows = await this.plugins.contributionRows(workspaceId, ['card', 'panel', 'page', 'action', 'badge']);
    const reg = await this.plugins.registry(workspaceId);
    const view = (r: ContributionRow): UiItem => {
      const spec = JSON.parse(r.spec) as Record<string, unknown>;
      const ready = this.plugins.contributionReady(reg, spec);
      return { id: r.id, kind: r.kind, key: r.key, pluginId: r.ownerId, version: r.version, ready: ready.ready, waitingOn: ready.missing, spec };
    };
    const items = rows.filter((r) => r.kind !== 'action').map(view).filter((i) => !placement || i.spec.placement === placement);
    const named = new Set(items.flatMap((i) => (Array.isArray(i.spec.actions) ? i.spec.actions as string[] : []).map((a) => `${i.pluginId}#${a}`)));
    const actions = rows.filter((r) => r.kind === 'action' && named.has(`${r.ownerId}#${r.key}`)).map(view);
    return { items, actions };
  }

  private async row(workspaceId: string, id: string): Promise<ContributionRow> {
    const r = (await this.plugins.contributionRows(workspaceId)).find((x) => x.id === id);
    if (!r) throw new NotFoundException('no such plugin contribution in this workspace');
    return r;
  }

  private async settings(workspaceId: string, pluginId: string): Promise<Record<string, unknown>> {
    const li = await this.plugins.installOf(workspaceId, pluginId);
    if (!li) return {};
    let own: Record<string, unknown> = {};
    try { own = JSON.parse(li.install.settings || '{}') as Record<string, unknown>; } catch { /* defaults */ }
    return { ...settingsDefaults(li.manifest), ...own };
  }

  /** Run a view's query and render it. `section` picks a page's section. */
  async data(workspaceId: string, id: string, body: { section?: number; context?: Record<string, unknown> }): Promise<{ view: RenderedView; title?: string }> {
    const r = await this.row(workspaceId, id);
    const spec = JSON.parse(r.spec) as UiCard | UiPanel | UiPage | UiBadge;
    let query: UiQuery | undefined;
    let view: UiView;
    let title: string | undefined;
    if (r.kind === 'page') {
      const sec = (spec as UiPage).sections[Number(body.section ?? 0)];
      if (!sec) throw new BadRequestException('no such section');
      query = sec.query; view = sec.view; title = sec.title;
    } else if (r.kind === 'badge') {
      const b = spec as UiBadge;
      query = b.query; view = { kind: 'text', value: b.label };
    } else if (r.kind === 'card' || r.kind === 'panel') {
      query = (spec as UiCard).query; view = (spec as UiCard).view;
    } else throw new BadRequestException(`a ${r.kind} has no data`);
    if (!query) return { view: renderView(view, null), title };
    const input = fillUiInput(query.input, { context: clean(body.context), settings: await this.settings(workspaceId, r.ownerId) });
    try {
      const res = await this.dispatcher.uiCall(workspaceId, query.operation, input, { actor: actorId(), owner: false, confirmed: false, mode: 'query', source: `${r.ownerId}#${r.key}` });
      if (res.status !== 'ok') throw new BadRequestException('a view may only read');
      return { view: renderView(view, res.output), title };
    } catch (err) {
      if (err instanceof UiRefused) throw new BadRequestException(err.message);
      throw err;
    }
  }

  /** Invoke an action: through the policy stage; a non-read action needs the owner and a confirmation. */
  async invoke(workspaceId: string, id: string, body: { fields?: Record<string, unknown>; context?: Record<string, unknown>; confirm?: boolean }): Promise<Record<string, unknown>> {
    const r = await this.row(workspaceId, id);
    if (r.kind !== 'action') throw new BadRequestException('not an action');
    const a = JSON.parse(r.spec) as UiAction;
    const fields = clean(body.fields);
    for (const f of a.fields ?? []) {
      const v = fields[f.key];
      if (f.required && (v === undefined || v === '')) throw new BadRequestException(`${f.label} is required`);
      if (f.type === 'number' && v !== undefined && v !== '') { const n = Number(v); if (!Number.isFinite(n)) throw new BadRequestException(`${f.label} must be a number`); fields[f.key] = n; }
      if (f.type === 'select' && v !== undefined && v !== '' && !(f.options ?? []).includes(String(v))) throw new BadRequestException(`${f.label} must be one of ${(f.options ?? []).join(', ')}`);
    }
    const input = fillUiInput(a.input, { context: clean(body.context), field: fields, settings: await this.settings(workspaceId, r.ownerId) });
    const owner = await this.plugins.callerIsOwner(workspaceId);
    try {
      const res = await this.dispatcher.uiCall(workspaceId, a.operation, input, { actor: actorId(), owner, confirmed: body.confirm === true, mode: 'action', source: `${r.ownerId}#${r.key}` });
      if (res.status === 'confirm') return { status: 'confirm', class: res.cls, requirement: res.requirement, reasons: res.reasons, prompt: a.confirm ?? `Run ${a.title}?` };
      return { status: 'done', class: res.cls, output: res.output };
    } catch (err) {
      if (err instanceof UiRefused) throw new BadRequestException(err.message);
      throw err;
    }
  }
}

/** Plain string and number values only, bounded. */
function clean(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 20)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(k)) continue;
    if (typeof x === 'string') out[k] = x.slice(0, 2_000);
    else if (typeof x === 'number' && Number.isFinite(x)) out[k] = x;
    else if (typeof x === 'boolean') out[k] = x;
  }
  return out;
}
