/**
 * Foundry, the marketplace (docs/foundry.md §8, §9.3): the shelf index and
 * the Kits shelf. The other shelves keep their own APIs — Blueprints is
 * `/api/market/companies`, Agents is `/api/market` (+ `/api/registry?kind=agent`
 * for community agents), Plugins is `/api/workspaces/:ws/foundry/plugins`
 * (PluginRegistryController). Members may read everything here.
 *
 *   GET /api/foundry               the shelves, with what each holds and its API
 *   GET /api/foundry/kits?fn=&type=&q=   kit previews (not installable yet)
 */
import { Controller, Get, Query } from '@nestjs/common';
import { KIT_PREVIEWS } from './kits.catalog';

export const SHELVES = [
  { id: 'blueprints', label: 'Blueprints', holds: 'Company types: org, roles, profile, budget', api: '/api/market/companies' },
  { id: 'kits', label: 'Kits', holds: 'Use cases: interfaces, providers, roles, rhythm and measures', api: '/api/foundry/kits', comingSoon: true },
  { id: 'agents', label: 'Agents', holds: 'Packs and catalog roles: the people, Personal and Business', api: '/api/market' },
  { id: 'plugins', label: 'Plugins', holds: 'Interfaces, providers and consumers; connectors; community skills and apps', api: '/api/workspaces/:ws/foundry/plugins' },
] as const;

@Controller('foundry')
export class FoundryController {
  @Get() index() { return { shelves: SHELVES, kits: { count: KIT_PREVIEWS.length, installable: 0 } }; }

  @Get('kits')
  kits(@Query('fn') fn?: string, @Query('type') type?: string, @Query('q') q?: string) {
    const needle = (q ?? '').trim().toLowerCase();
    return KIT_PREVIEWS.filter((k) => (!fn || k.functions.includes(fn)) && (!type || k.companyTypes.includes(type))
      && (!needle || `${k.name} ${k.blurb} ${k.interfaces.map((i) => i.name).join(' ')} ${k.providers.join(' ')}`.toLowerCase().includes(needle)));
  }
}
