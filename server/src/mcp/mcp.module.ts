/**
 * McpModule — MCP servers (FR-10.3): configuration plus a Streamable-HTTP
 * client. Enabled servers are discovered (tools/list cached on the row) and
 * their tools are offered to the turn loop as mcp_<server>_<tool>, gated by
 * the Ask/Auto policy like every other mutation-class tool (FR-4.2).
 */
import { Module } from '@nestjs/common';
import { Body, Controller, Delete, Get, Inject, Injectable, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { mcpServers } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { McpHttpClient, McpToolDef } from './mcp-client';
import { AiToolSpec } from '../ai/ai-provider.interface';

export const MCP_TOOL_PREFIX = 'mcp_';
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

type McpRow = typeof mcpServers.$inferSelect;

@Injectable()
export class McpService {
  /** Lazy client cache keyed by server id; dropped on config changes. */
  private readonly clients = new Map<string, McpHttpClient>();
  /** Test seam: swap the client constructor. */
  clientFactory: (url: string) => McpHttpClient = (url) => new McpHttpClient(url);

  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  list(): Promise<McpRow[]> {
    return this.db.select().from(mcpServers);
  }

  private client(server: McpRow): McpHttpClient {
    let c = this.clients.get(server.id);
    if (!c) {
      c = this.clientFactory(server.url);
      this.clients.set(server.id, c);
    }
    return c;
  }

  /** Connect and cache the server's tool list on its row (shown in Settings
   *  and offered to chats without a per-turn network call). */
  async discover(id: string): Promise<{ tools: McpToolDef[] }> {
    const rows = await this.db.select().from(mcpServers).where(eq(mcpServers.id, id)).limit(1);
    if (!rows[0]) throw new NotFoundException(`mcp server ${id}`);
    this.clients.delete(id);
    const tools = await this.client(rows[0]).listTools();
    await this.db.update(mcpServers)
      .set({ tools: JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema }))) })
      .where(eq(mcpServers.id, id));
    return { tools };
  }

  /** Tool specs for every enabled server, from the cached discovery. */
  async toolSpecs(): Promise<AiToolSpec[]> {
    const out: AiToolSpec[] = [];
    for (const server of await this.list()) {
      if (server.enabled !== 1) continue;
      let tools: McpToolDef[];
      try { tools = JSON.parse(server.tools) as McpToolDef[]; } catch { continue; }
      for (const t of tools) {
        out.push({
          name: `${MCP_TOOL_PREFIX}${slug(server.name)}_${slug(t.name)}`,
          description: `[MCP · ${server.name}] ${t.description ?? t.name}`,
          inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
        });
      }
    }
    return out;
  }

  /** Route an mcp_<server>_<tool> call to its server. */
  async execute(toolName: string, args: Record<string, unknown>): Promise<string> {
    for (const server of await this.list()) {
      if (server.enabled !== 1) continue;
      const prefix = `${MCP_TOOL_PREFIX}${slug(server.name)}_`;
      if (!toolName.startsWith(prefix)) continue;
      const wanted = toolName.slice(prefix.length);
      let tools: McpToolDef[];
      try { tools = JSON.parse(server.tools) as McpToolDef[]; } catch { continue; }
      const tool = tools.find((t) => slug(t.name) === wanted);
      if (!tool) continue;
      const text = await this.client(server).callTool(tool.name, args);
      return text.length > 20_000 ? `${text.slice(0, 20_000)}
…(truncated)` : text;
    }
    throw new Error(`unknown tool: ${toolName}`);
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
    this.clients.delete(id);
    const rows = await this.db.select().from(mcpServers).where(eq(mcpServers.id, id)).limit(1);
    if (!rows[0]) throw new NotFoundException(`mcp server ${id}`);
    const set: Record<string, unknown> = { ...patch };
    if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0;
    if (patch.tools !== undefined) set.tools = JSON.stringify(patch.tools);
    await this.db.update(mcpServers).set(set).where(eq(mcpServers.id, id));
    return { ...rows[0], ...set };
  }

  async remove(id: string) {
    this.clients.delete(id);
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
  @Post(':id/discover') discover(@Param('id') id: string) { return this.mcp.discover(id); }
  @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdateMcpDto) { return this.mcp.update(id, dto); }
  @Delete(':id') remove(@Param('id') id: string) { return this.mcp.remove(id); }
}

@Module({
  controllers: [McpController],
  providers: [McpService],
  exports: [McpService],
})
export class McpModule {}
