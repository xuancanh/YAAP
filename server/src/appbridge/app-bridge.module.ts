/**
 * AppBridgeModule — the server side of the mini-app capability bridge
 * (docs/miniapp-capabilities.md). Apps run in opaque-origin iframes and can
 * never reach these endpoints themselves; every call funnels through the
 * host page (AppHost), and the grant is re-verified here on each request —
 * the client-side checks are UX, this is the boundary.
 */
import { Body, Controller, Delete, Get, Module, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AppBridgeService } from './app-bridge.service';
import { AppLlmService } from './app-llm.service';
import { AppDataService, type DataQuery } from './app-data.service';
import { AppConnectionsService } from './app-connections.service';
import { AppComputeService } from './app-compute.service';
import { AgentsModule } from '../agents/agents.module';
import { ChatsModule } from '../chats/chats.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { AiModule } from '../ai/ai.module';
import { AgentTypesModule } from '../agent-types/agent-types.module';
import { SettingsModule } from '../settings/settings.module';
import { ConnectionsModule } from '../connections/connections.module';
import { RunnerModule } from '../runner/runner.module';

@Controller('agents/:id/apps/:appId')
export class AppBridgeController {
  constructor(
    private readonly bridge: AppBridgeService,
    private readonly llm: AppLlmService,
    private readonly data: AppDataService,
    private readonly conns: AppConnectionsService,
    private readonly compute: AppComputeService,
  ) {}

  @Post('approve')
  approve(@Param('id') id: string, @Param('appId') appId: string, @Body() body: { capabilities: string[] }) {
    return this.bridge.approve(id, appId, body.capabilities ?? []);
  }

  @Get('storage')
  storageGet(@Param('id') id: string, @Param('appId') appId: string) {
    return this.bridge.storageGet(id, appId);
  }

  @Put('storage')
  storagePut(@Param('id') id: string, @Param('appId') appId: string, @Body() body: { state: unknown }) {
    return this.bridge.storagePut(id, appId, body.state);
  }

  @Get('files')
  filesList(
    @Param('id') id: string, @Param('appId') appId: string,
    @Query('prefix') prefix?: string, @Query('workspaceId') workspaceId?: string,
  ) {
    return this.bridge.filesList(id, appId, prefix ?? '', workspaceId);
  }

  @Get('file')
  fileRead(
    @Param('id') id: string, @Param('appId') appId: string,
    @Query('path') path: string, @Query('workspaceId') workspaceId?: string,
    @Query('offset') offset?: string,
  ) {
    return this.bridge.fileRead(id, appId, path ?? '', workspaceId, Number(offset ?? 0) || 0);
  }

  /** Promotion out of the app's own folder — approved in the host, and
   *  refused here for anything the agent reads as instructions. */
  @Post('files/propose')
  filePropose(@Param('id') id: string, @Param('appId') appId: string, @Body() body: { path: string; content: string }) {
    return this.bridge.filePropose(id, appId, body.path ?? '', body.content ?? '');
  }

  @Get('files/watch')
  filesWatch(
    @Param('id') id: string, @Param('appId') appId: string,
    @Query('prefix') prefix?: string, @Query('since') since?: string, @Query('workspaceId') workspaceId?: string,
  ) {
    return this.bridge.filesWatch(id, appId, prefix ?? '', since, workspaceId);
  }

  @Put('files')
  fileWrite(@Param('id') id: string, @Param('appId') appId: string, @Body() body: { path: string; content: string }) {
    return this.bridge.fileWrite(id, appId, body.path ?? '', body.content ?? '');
  }

  @Get('tasks')
  tasksList(@Param('id') id: string, @Param('appId') appId: string) {
    return this.bridge.tasksList(id, appId);
  }

  @Post('tasks')
  taskAdd(@Param('id') id: string, @Param('appId') appId: string, @Body() body: { title: string; note?: string }) {
    return this.bridge.taskAdd(id, appId, body.title ?? '', body.note);
  }

  @Patch('tasks/:taskId')
  taskMove(
    @Param('id') id: string, @Param('appId') appId: string,
    @Param('taskId') taskId: string, @Body() body: { status: string },
  ) {
    return this.bridge.taskMove(id, appId, taskId, body.status ?? '');
  }

  @Post('ask')
  ask(@Param('id') id: string, @Param('appId') appId: string, @Body() body: { prompt: string; workspaceId?: string }) {
    return this.bridge.ask(id, appId, body.prompt ?? '', body.workspaceId);
  }

  @Post('data/:collection')
  dataPut(
    @Param('id') id: string, @Param('appId') appId: string,
    @Param('collection') collection: string, @Body() body: { row: unknown },
  ) {
    return this.data.put(id, appId, collection, body.row);
  }

  /** POST, not GET: a query is a body, not a URL — and it keeps filter
   *  objects out of logs and history. */
  @Post('data/:collection/query')
  dataQuery(
    @Param('id') id: string, @Param('appId') appId: string,
    @Param('collection') collection: string, @Body() body: DataQuery,
  ) {
    return this.data.query(id, appId, collection, body ?? {});
  }

  @Delete('data/:collection/:rowId')
  dataDelete(
    @Param('id') id: string, @Param('appId') appId: string,
    @Param('collection') collection: string, @Param('rowId') rowId: string,
  ) {
    return this.data.remove(id, appId, collection, rowId);
  }

  /** The SQLite engine as bytes — the CSP forbids fetching a .wasm by URL. */
  @Get('sql-engine')
  sqlEngine(@Param('id') id: string, @Param('appId') appId: string) {
    return this.data.sqlEngine(id, appId);
  }

  // connections: fixed shapes to read, proposals to write (roadmap §6)
  @Get('connections')
  connectionsList(@Param('id') id: string, @Param('appId') appId: string) {
    return this.conns.list(id, appId);
  }

  @Post('connections/read')
  connectionsRead(
    @Param('id') id: string, @Param('appId') appId: string,
    @Body() body: { provider: string; op: string; params?: Record<string, unknown> },
  ) {
    return this.conns.read(id, appId, body.provider ?? 'google', body.op ?? '', body.params ?? {});
  }

  @Post('connections/propose')
  connectionsPropose(
    @Param('id') id: string, @Param('appId') appId: string,
    @Body() body: { provider: string; op: string; payload?: Record<string, unknown> },
  ) {
    return this.conns.propose(id, appId, body.provider ?? 'google', body.op ?? '', body.payload ?? {});
  }

  @Get('compute')
  computeStatus(@Param('id') id: string, @Param('appId') appId: string) {
    return this.compute.status(id, appId);
  }

  @Post('compute')
  computeRun(
    @Param('id') id: string, @Param('appId') appId: string,
    @Body() body: { language: string; code: string; stdin?: string; timeoutSeconds?: number },
  ) {
    return this.compute.run(id, appId, body.language ?? '', body.code ?? '', body.stdin, body.timeoutSeconds);
  }

  @Post('llm')
  complete(
    @Param('id') id: string, @Param('appId') appId: string,
    @Body() body: { prompt: string; schema?: unknown; maxTokens?: number },
  ) {
    return this.llm.complete(id, appId, body.prompt ?? '', { schema: body.schema, maxTokens: body.maxTokens });
  }

  /** Streamed completion. The host page consumes this and relays chunks into
   *  the frame over postMessage — the frame itself still has no network. */
  @Post('llm/stream')
  async completeStream(
    @Param('id') id: string, @Param('appId') appId: string,
    @Body() body: { prompt: string; maxTokens?: number }, @Res() res: Response,
  ) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    res.on('error', () => {});
    try {
      for await (const ev of this.llm.stream(id, appId, body.prompt ?? '', { maxTokens: body.maxTokens })) {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
    }
    res.end();
  }
}

@Module({
  imports: [AgentsModule, ChatsModule, WorkspacesModule, AiModule, AgentTypesModule, SettingsModule, ConnectionsModule, RunnerModule],
  controllers: [AppBridgeController],
  providers: [AppBridgeService, AppLlmService, AppDataService, AppConnectionsService, AppComputeService],
})
export class AppBridgeModule {}
