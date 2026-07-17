/**
 * McpModule — MCP server configuration (FR-10.3, configuration slice).
 * Stores server entries + enabled flags; the actual MCP client that
 * discovers tools and offers them to the turn loop is follow-up work.
 */
import { Module } from '@nestjs/common';
import { Body, Controller, Delete, Get, Inject, Injectable, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { mcpServers } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';

@Injectable()
export class McpService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  list() {
    return this.db.select().from(mcpServers);
  }

  async create(input: { name: string; url: string; tools?: string[] }) {
    const row = {
      id: newId(), name: input.name, url: input.url, enabled: 1,
      tools: JSON.stringify(input.tools ?? []), createdAt: nowIso(),
    };
    await this.db.insert(mcpServers).values(row);
    return row;
  }

  async update(id: string, patch: Partial<{ name: string; url: string; enabled: boolean; tools: string[] }>) {
    const rows = await this.db.select().from(mcpServers).where(eq(mcpServers.id, id)).limit(1);
    if (!rows[0]) throw new NotFoundException(`mcp server ${id}`);
    const set: Record<string, unknown> = { ...patch };
    if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0;
    if (patch.tools !== undefined) set.tools = JSON.stringify(patch.tools);
    await this.db.update(mcpServers).set(set).where(eq(mcpServers.id, id));
    return { ...rows[0], ...set };
  }

  async remove(id: string) {
    await this.db.delete(mcpServers).where(eq(mcpServers.id, id));
    return { ok: true };
  }
}

class CreateMcpDto {
  @IsString() name!: string;
  @IsString() url!: string;
}

class UpdateMcpDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() url?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

@Controller('mcp')
export class McpController {
  constructor(private readonly mcp: McpService) {}

  @Get() list() { return this.mcp.list(); }
  @Post() create(@Body() dto: CreateMcpDto) { return this.mcp.create(dto); }
  @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdateMcpDto) { return this.mcp.update(id, dto); }
  @Delete(':id') remove(@Param('id') id: string) { return this.mcp.remove(id); }
}

@Module({
  controllers: [McpController],
  providers: [McpService],
  exports: [McpService],
})
export class McpModule {}
