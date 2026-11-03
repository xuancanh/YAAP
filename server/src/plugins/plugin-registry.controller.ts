/**
 * The plugin registry API (docs/plugins.md §8.2, docs/foundry.md §9.3), the
 * Plugins shelf of Foundry. Members may browse; publishing, recall, install
 * and update are owner-only (the services check).
 *
 *   GET  /api/workspaces/:ws/foundry/plugins?q=&role=&iface=&tier=   the shelf, with facets
 *   GET  /api/workspaces/:ws/foundry/plugins/:id                      detail: capabilities, versions, conformance
 *   POST /api/workspaces/:ws/foundry/plugins/publish { manifest | files, commitSha?, changelog?, dryRun? }
 *   POST /api/workspaces/:ws/foundry/plugins/:id/versions/:version/recall { reason }
 *   GET  /api/workspaces/:ws/plugins/:id/updates                      versions to move to, each with its permission diff
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { PluginRegistryService } from './plugin-registry.service';

@Controller()
export class PluginRegistryController {
  constructor(private readonly registry: PluginRegistryService) {}

  @Get('workspaces/:ws/foundry/plugins')
  list(@Param('ws') ws: string, @Query('q') q?: string, @Query('role') role?: string, @Query('iface') iface?: string, @Query('tier') tier?: string) {
    return this.registry.list(ws, { q, role, iface, tier });
  }

  @Post('workspaces/:ws/foundry/plugins/publish')
  publish(@Param('ws') ws: string, @Body() body: { manifest?: unknown; files?: Record<string, string>; commitSha?: string; changelog?: string; dryRun?: boolean }) {
    return this.registry.publish(ws, { manifest: body?.manifest, files: body?.files && typeof body.files === 'object' ? body.files : undefined, commitSha: body?.commitSha, changelog: body?.changelog, dryRun: body?.dryRun === true });
  }

  @Get('workspaces/:ws/foundry/plugins/:id')
  detail(@Param('ws') ws: string, @Param('id') id: string) { return this.registry.detail(ws, id); }

  @Post('workspaces/:ws/foundry/plugins/:id/versions/:version/recall')
  recall(@Param('ws') ws: string, @Param('id') id: string, @Param('version') version: string, @Body() body: { reason?: string }) {
    return this.registry.recall(ws, id, version, body?.reason ?? '');
  }

  @Get('workspaces/:ws/plugins/:id/updates')
  updates(@Param('ws') ws: string, @Param('id') id: string) { return this.registry.updates(ws, id); }
}
