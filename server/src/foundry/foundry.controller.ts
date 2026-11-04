/**
 * Foundry, the marketplace (docs/foundry.md §8, §9.3): the shelf index and
 * the Kits shelf. The other shelves keep their own APIs — Blueprints is
 * `/api/market/companies`, Agents is `/api/market` (+ `/api/registry?kind=agent`
 * for community agents), Plugins is `/api/workspaces/:ws/foundry/plugins`
 * (PluginRegistryController). Members may read; installs, upgrades,
 * rollbacks and uninstalls are the owner's (KitsService checks).
 *
 *   GET  /api/foundry                                   the shelves
 *   GET  /api/foundry/kits?fn=&type=&q=&workspaceId=    shipped kits, then previews
 *   GET  /api/foundry/kits/:id?workspaceId=             one kit: what it brings, its install here
 *   GET  /api/workspaces/:ws/kits                       installs with members and health
 *   POST /api/workspaces/:ws/kits/plan                  { kit, choices } → the review (writes nothing)
 *   POST /api/workspaces/:ws/kits/install               { kit, choices, confirm }
 *   POST /api/workspaces/:ws/kits/:id/upgrade           to the catalog's version (a revision)
 *   POST /api/workspaces/:ws/kits/:id/rollback          { revisionId? }
 *   POST /api/workspaces/:ws/kits/:id/uninstall/plan    what uninstall would do
 *   DELETE /api/workspaces/:ws/kits/:id                 { keepPolicies?, removeBindings? }
 */
import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { KitsService, type KitChoices } from './kits.service';

export const SHELVES = [
  { id: 'blueprints', label: 'Blueprints', holds: 'Company types: org, roles, profile, budget', api: '/api/market/companies' },
  { id: 'kits', label: 'Kits', holds: 'Use cases: interfaces, providers, roles, playbooks and guidance', api: '/api/foundry/kits' },
  { id: 'agents', label: 'Agents', holds: 'Packs and catalog roles: the people, Personal and Business', api: '/api/market' },
  { id: 'plugins', label: 'Plugins', holds: 'Interfaces, providers and consumers; connectors; community skills and apps', api: '/api/workspaces/:ws/foundry/plugins' },
] as const;

function choicesOf(v: unknown): KitChoices {
  if (!v || typeof v !== 'object') return {};
  const c = v as Record<string, unknown>;
  const map = <T>(x: unknown, ok: (y: unknown) => y is T): Record<string, T> => (x && typeof x === 'object' ? Object.fromEntries(Object.entries(x as Record<string, unknown>).filter(([, y]) => ok(y))) as Record<string, T> : {});
  return { providers: map(c.providers, (y): y is string => typeof y === 'string'), seats: map(c.seats, (y): y is boolean => typeof y === 'boolean') };
}

@Controller()
export class FoundryController {
  constructor(private readonly kits: KitsService) {}

  @Get('foundry')
  async index() {
    const shelf = await this.kits.shelf();
    return { shelves: SHELVES, kits: { count: shelf.length, installable: shelf.filter((k) => k.installable === true).length } };
  }

  @Get('foundry/kits')
  list(@Query('fn') fn?: string, @Query('type') type?: string, @Query('q') q?: string, @Query('workspaceId') ws?: string) {
    return this.kits.shelf(ws || undefined, { fn, type, q });
  }

  @Get('foundry/kits/:id')
  detail(@Param('id') id: string, @Query('workspaceId') ws?: string) { return this.kits.detail(ws || null, id); }

  @Get('workspaces/:ws/kits')
  installs(@Param('ws') ws: string) { return this.kits.list(ws); }

  @Post('workspaces/:ws/kits/plan')
  plan(@Param('ws') ws: string, @Body() body: { kit?: string; choices?: unknown }) {
    if (!body?.kit) throw new BadRequestException('kit is required');
    return this.kits.plan(ws, body.kit, choicesOf(body.choices));
  }

  @Post('workspaces/:ws/kits/install')
  install(@Param('ws') ws: string, @Body() body: { kit?: string; choices?: unknown; confirm?: boolean }) {
    if (!body?.kit) throw new BadRequestException('kit is required');
    return this.kits.install(ws, body.kit, choicesOf(body.choices), { confirm: body.confirm === true });
  }

  @Post('workspaces/:ws/kits/:id/upgrade')
  upgrade(@Param('ws') ws: string, @Param('id') id: string) { return this.kits.upgrade(ws, id); }

  @Post('workspaces/:ws/kits/:id/rollback')
  rollback(@Param('ws') ws: string, @Param('id') id: string, @Body() body: { revisionId?: string }) { return this.kits.rollback(ws, id, body?.revisionId); }

  @Post('workspaces/:ws/kits/:id/uninstall/plan')
  uninstallPlan(@Param('ws') ws: string, @Param('id') id: string) { return this.kits.uninstallPlan(ws, id); }

  @Delete('workspaces/:ws/kits/:id')
  uninstall(@Param('ws') ws: string, @Param('id') id: string, @Body() body: { keepPolicies?: boolean; removeBindings?: boolean }) {
    return this.kits.uninstall(ws, id, { keepPolicies: body?.keepPolicies === true, removeBindings: body?.removeBindings === true });
  }
}
