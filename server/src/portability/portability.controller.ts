/**
 * Portability HTTP surface (execution-plan item 9):
 *   GET  /api/agents/:id/export?includeProfile=1&workspaceId=…  → AGENT.json v2
 *   POST /api/agents/import            { ...AGENT.json, options? }  → new agent
 *   POST /api/agents/:id/import/memory { format, content, workspaceId? }
 * SKILL.md import/export live on /api/skills (SkillsController).
 */
import { Body, Controller, Get, Header, Param, Post, Query } from '@nestjs/common';
import { PortabilityService, ImportOptions } from './portability.service';
import type { ImportContent } from './importers';

@Controller('agents')
export class PortabilityController {
  constructor(private readonly portability: PortabilityService) {}

  /** The review modal posts the AGENT.json with an `options` envelope:
   *  { trustLessons, lessons, skills, tasks, profile, workspaceId }. A bare
   *  v1 file with no envelope imports exactly as before. */
  @Post('import')
  importJson(@Body() body: Record<string, unknown>) {
    const { options, ...profile } = body;
    const opts = (options && typeof options === 'object' ? options : {}) as ImportOptions;
    return this.portability.importAgent(profile, opts);
  }

  @Get(':id/export')
  @Header('Content-Disposition', 'attachment; filename="AGENT.json"')
  exportJson(@Param('id') id: string, @Query('includeProfile') includeProfile?: string, @Query('workspaceId') workspaceId?: string) {
    return this.portability.exportAgent(id, { includeProfile: includeProfile === '1' || includeProfile === 'true', workspaceId });
  }

  @Post(':id/import/memory')
  importMemory(@Param('id') id: string, @Body() body: { format: string; content: ImportContent; workspaceId?: string }) {
    return this.portability.importMemory(id, body);
  }
}
