/**
 * The plugin API (docs/plugins.md §8.2, Phase 1). Owner-only writes (the
 * service checks the owner or the CEO; the workspace guard keeps members
 * off these routes too); members may read installs, interfaces and change
 * records.
 */
import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { actorId } from '../accounts/account-context';
import { CORE_API_VERSION, MANIFEST_VERSION } from './manifest';
import { PluginsService, type InstallSource } from './plugins.service';
import { ChangesService, MANUAL_KIND, type VerifyCheck } from './changes.service';
import { PluginAuditService } from './plugin-audit';
import { parseDuration } from './template';

function sourceOf(body: Record<string, unknown> | undefined): InstallSource {
  const src = (body?.source ?? body) as Record<string, unknown> | undefined;
  if (!src || typeof src !== 'object') throw new BadRequestException('source is required');
  const reg = src.registry as Record<string, unknown> | undefined;
  return {
    ...(typeof src.firstParty === 'string' ? { firstParty: src.firstParty } : {}),
    ...(reg && typeof reg === 'object' && typeof reg.id === 'string' ? { registry: { id: reg.id, ...(typeof reg.version === 'string' ? { version: reg.version } : {}) } } : {}),
    ...(typeof src.path === 'string' ? { path: src.path } : {}),
    ...(src.manifest !== undefined ? { manifest: src.manifest } : {}),
    ...(src.files && typeof src.files === 'object' ? { files: src.files as Record<string, string> } : {}),
  };
}

@Controller()
export class PluginsController {
  constructor(
    private readonly plugins: PluginsService,
    private readonly changes: ChangesService,
    private readonly audit: PluginAuditService,
  ) {}

  @Get('plugins/api')
  api() { return { yaamCore: CORE_API_VERSION, supports: '^1', manifestVersion: MANIFEST_VERSION }; }

  @Get('workspaces/:ws/plugins/catalog')
  catalog(@Param('ws') ws: string) { return this.plugins.catalogView(ws); }

  @Get('workspaces/:ws/plugins')
  list(@Param('ws') ws: string) { return this.plugins.list(ws); }

  @Post('workspaces/:ws/plugins/review')
  review(@Param('ws') ws: string, @Body() body: Record<string, unknown>) { return this.plugins.review(ws, sourceOf(body)); }

  @Post('workspaces/:ws/plugins/install')
  install(@Param('ws') ws: string, @Body() body: Record<string, unknown>) { return this.plugins.install(ws, sourceOf(body), { confirm: body?.confirm === true, acceptCommunity: body?.acceptCommunity === true }); }

  /** Developer mode (§7.4): load a folder under YAAM_PLUGINS_DEV_DIR as name@local, through the same review. */
  @Post('workspaces/:ws/plugins/dev')
  dev(@Param('ws') ws: string, @Body() body: { path?: string; confirm?: boolean }) {
    if (typeof body?.path !== 'string' || !body.path) throw new BadRequestException('path is required');
    return this.plugins.install(ws, { path: body.path }, { confirm: body.confirm === true });
  }

  @Get('workspaces/:ws/plugin-settings')
  settings(@Param('ws') ws: string) { return this.plugins.workspaceSettings(ws); }

  @Patch('workspaces/:ws/plugin-settings')
  setSettings(@Param('ws') ws: string, @Body() body: { allowCommunityInterfaces?: boolean }) { return this.plugins.setWorkspaceSettings(ws, body ?? {}); }

  @Get('workspaces/:ws/plugins-audit')
  auditLog(@Param('ws') ws: string, @Query('refId') refId?: string) { return this.audit.list(ws, { refId, limit: 200 }); }

  @Get('workspaces/:ws/plugins/:id')
  detail(@Param('ws') ws: string, @Param('id') id: string) { return this.plugins.detail(ws, id); }

  @Post('workspaces/:ws/plugins/:id/conformance')
  conformance(@Param('ws') ws: string, @Param('id') id: string) { return this.plugins.runConformance(ws, id); }

  @Post('workspaces/:ws/plugins/:id/disable')
  disable(@Param('ws') ws: string, @Param('id') id: string) { return this.plugins.disable(ws, id); }

  @Post('workspaces/:ws/plugins/:id/enable')
  enable(@Param('ws') ws: string, @Param('id') id: string) { return this.plugins.enable(ws, id); }

  @Delete('workspaces/:ws/plugins/:id')
  uninstall(@Param('ws') ws: string, @Param('id') id: string) { return this.plugins.uninstall(ws, id); }

  @Post('workspaces/:ws/plugins/:id/update')
  update(@Param('ws') ws: string, @Param('id') id: string, @Body() body: Record<string, unknown>) { return this.plugins.update(ws, id, sourceOf(body)); }

  @Post('workspaces/:ws/plugins/:id/updates/decide')
  decideUpdate(@Param('ws') ws: string, @Param('id') id: string, @Body() body: { approve?: boolean }) { return this.plugins.decideUpdate(ws, id, body?.approve === true); }

  @Put('workspaces/:ws/plugins/:id/grants/:agentId')
  grant(@Param('ws') ws: string, @Param('id') id: string, @Param('agentId') agentId: string, @Body() body: { level?: string | null; extras?: boolean }) {
    return this.plugins.setGrant(ws, id, agentId, body ?? {});
  }

  @Get('workspaces/:ws/interfaces')
  interfaces(@Param('ws') ws: string) { return this.plugins.interfacesView(ws); }

  @Put('workspaces/:ws/interfaces/:name/bindings')
  bind(@Param('ws') ws: string, @Param('name') name: string, @Body() body: { major?: number; scopeKind?: string; scopeRef?: string; providerId?: string | null }) {
    return this.plugins.setBinding(ws, name, body ?? {});
  }

  @Get('workspaces/:ws/interfaces/:name/resolve')
  resolve(@Param('ws') ws: string, @Param('name') name: string, @Query('resource') resource?: string, @Query('agentId') agentId?: string) {
    return this.plugins.resolve(ws, name, { resource, agentId });
  }

  @Get('workspaces/:ws/interface-policies')
  policies(@Param('ws') ws: string) { return this.plugins.listPolicies(ws); }

  @Put('workspaces/:ws/interface-policies/:id')
  putPolicy(@Param('ws') ws: string, @Param('id') id: string, @Body() body: Record<string, unknown>) { return this.plugins.putPolicy(ws, id === 'new' ? '' : id, body as never); }

  @Delete('workspaces/:ws/interface-policies/:id')
  deletePolicy(@Param('ws') ws: string, @Param('id') id: string) { return this.plugins.deletePolicy(ws, id); }

  // ---- change records (§4.8) ----

  @Get('workspaces/:ws/changes')
  changeList(@Param('ws') ws: string, @Query('state') state?: string, @Query('kind') kind?: string) { return this.changes.list(ws, { state, kind }); }

  @Get('workspaces/:ws/changes/:id')
  change(@Param('ws') ws: string, @Param('id') id: string) { return this.changes.get(ws, id); }

  /** A human-attested change (`core.manual`); interface kinds are opened by their propose-role operation. */
  @Post('workspaces/:ws/changes')
  createChange(@Param('ws') ws: string, @Body() body: { kind?: string; title?: string; ref?: string; bind?: Record<string, unknown>; verify?: Array<{ within?: string }>; requirement?: string }) {
    if ((body?.kind ?? MANUAL_KIND) !== MANUAL_KIND) throw new BadRequestException('only core.manual changes are created here; interface kinds open through their propose-role operation');
    const title = String(body?.title ?? '').trim();
    if (!title) throw new BadRequestException('title is required');
    const checks: VerifyCheck[] = (body.verify ?? []).map((v) => {
      if (parseDuration(v.within) === null) throw new BadRequestException('each verify check has a window like 30m');
      return { source: 'core.manual', within: String(v.within), status: 'pending' };
    });
    const requirement = body.requirement === 'trust' || body.requirement === 'cosign' || body.requirement === 'owner_key' ? body.requirement : 'two_key';
    return this.changes.create(ws, { kind: MANUAL_KIND, title, proposer: `user:${actorId()}`, ref: body.ref ?? '', bind: body.bind ?? {}, requirement, checks });
  }

  @Post('workspaces/:ws/changes/:id/review')
  reviewChange(@Param('ws') ws: string, @Param('id') id: string, @Body() body: { approve?: boolean; note?: string }) {
    return this.changes.review(ws, id, { by: `user:${actorId()}`, approve: body?.approve !== false, note: body?.note });
  }

  @Post('workspaces/:ws/changes/:id/request-apply')
  requestApply(@Param('ws') ws: string, @Param('id') id: string) { return this.changes.requestApply(ws, id, `user:${actorId()}`); }

  @Post('workspaces/:ws/changes/:id/keys')
  key(@Param('ws') ws: string, @Param('id') id: string, @Body() body: { approve?: boolean; note?: string }) { return this.changes.key(ws, id, body?.approve === true, body?.note ?? ''); }

  @Post('workspaces/:ws/changes/:id/applied')
  applied(@Param('ws') ws: string, @Param('id') id: string, @Body() body: { note?: string }) { return this.changes.attestApplied(ws, id, body?.note ?? ''); }

  @Post('workspaces/:ws/changes/:id/verify')
  verify(@Param('ws') ws: string, @Param('id') id: string, @Body() body: { pass?: boolean; note?: string }) { return this.changes.attest(ws, id, body?.pass === true, body?.note ?? ''); }

  @Post('workspaces/:ws/changes/:id/rolled-back')
  rolledBack(@Param('ws') ws: string, @Param('id') id: string, @Body() body: { ok?: boolean; note?: string }) { return this.changes.attestRolledBack(ws, id, body?.ok !== false, body?.note ?? ''); }
}
