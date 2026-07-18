import { BadRequestException, Body, Controller, Delete, Get, Header, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';
import { AgentsService } from './agents.service';
import { StorageService } from '../storage/storage.service';
import { agentFileKey, agentPrefix, agentRelativePath } from '../storage/storage.keys';
import { contentTypeFor, previewKindFor } from '../storage/preview.util';

class CreateAgentDto {
  @IsString() name!: string;
  @IsOptional() @IsString() charter?: string;
  @IsOptional() @IsString() provider?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsString() homeDir?: string;
  @IsOptional() @IsString() emoji?: string;
  @IsOptional() @IsString() role?: string;
  @IsOptional() @IsArray() colors?: [string, string];
}

class UpdateAgentDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() charter?: string;
  @IsOptional() @IsString() provider?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsString() homeDir?: string;
  @IsOptional() @IsString() dashboard?: string;
  @IsOptional() @IsString() emoji?: string;
  @IsOptional() @IsString() role?: string;
  /** JSON [from,to] gradient pair. */
  @IsOptional() @IsString() colors?: string;
}

class FeedbackDto {
  @IsIn(['up', 'down']) rating!: 'up' | 'down';
  @IsOptional() @IsString() note?: string;
  @IsString() turnId!: string;
}

@Controller('agents')
export class AgentsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly storage: StorageService,
  ) {}

  @Get() list() { return this.agents.list(); }
  @Get(':id') get(@Param('id') id: string) { return this.agents.get(id); }
  @Post() create(@Body() dto: CreateAgentDto) { return this.agents.create(dto); }
  @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdateAgentDto) { return this.agents.update(id, dto); }
  @Delete(':id') remove(@Param('id') id: string) { return this.agents.remove(id); }
  @Post(':id/feedback') feedback(@Param('id') id: string, @Body() dto: FeedbackDto) { return this.agents.addFeedback(id, dto); }
  @Get(':id/stats') stats(@Param('id') id: string) { return this.agents.stats(id); }
  @Get(':id/apps') apps(@Param('id') id: string) { return this.agents.listApps(id); }
  @Delete(':id/apps/:appId') deleteApp(@Param('id') id: string, @Param('appId') appId: string) { return this.agents.deleteApp(id, appId); }
  @Post('import') importJson(@Body() body: Record<string, unknown>) { return this.agents.importJson(body); }

  @Get(':id/export')
  @Header('Content-Disposition', 'attachment; filename="AGENT.json"')
  exportJson(@Param('id') id: string) { return this.agents.exportJson(id); }

  // ---- file brain (FR-11.3): same S3 store, agent-scoped prefix ----

  @Get(':id/files')
  async listFiles(@Param('id') id: string) {
    await this.agents.get(id);
    const objects = await this.storage.list(agentPrefix(id));
    return objects.map((o) => ({ path: agentRelativePath(id, o.key), size: o.size, lastModified: o.lastModified }));
  }

  @Post(':id/files')
  async putFile(@Param('id') id: string, @Body() body: { path: string; contentBase64: string; contentType?: string }) {
    await this.agents.get(id);
    await this.storage.put(this.key(id, body.path), Buffer.from(body.contentBase64 ?? '', 'base64'), body.contentType);
    return { ok: true, path: body.path };
  }

  @Get(':id/preview')
  async preview(@Param('id') id: string, @Query('path') path: string) {
    await this.agents.get(id);
    const body = await this.storage.get(this.key(id, path ?? ''));
    if (body === null) throw new NotFoundException(`file ${path}`);
    const kind = previewKindFor(path ?? '');
    const base = { path, kind, size: body.length, contentType: contentTypeFor(path ?? '') };
    if (kind === 'markdown' || kind === 'html' || kind === 'text') {
      return { ...base, text: body.toString('utf8').slice(0, 200_000) };
    }
    if (body.length <= 5_000_000) return { ...base, base64: body.toString('base64') };
    return base;
  }

  @Delete(':id/file')
  async deleteFile(@Param('id') id: string, @Query('path') path: string) {
    await this.agents.get(id);
    await this.storage.delete(this.key(id, path ?? ''));
    return { ok: true };
  }

  private key(id: string, path: string): string {
    try {
      return agentFileKey(id, path);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : 'invalid path');
    }
  }
}
